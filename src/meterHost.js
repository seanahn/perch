'use strict';
// The editor-facing half of the meter: polling, caching, the backend switch, and login. The gauge itself is the
// footer of each tab; perch puts nothing in the status bar.
// Merged from AI Meter. The logic it drives lives in ./meter and has no VS Code dependency.
const vscode = require('vscode');
const fs = require('fs');
const { createMeter, summarize } = require('./meter');
const CodexBedrock = require('./codexBedrock');
const { readCodexUsage } = require('./codexMeter');
const { sdkClaude, onPath, terminalRun } = require('./binaries');

const CACHE_KEY = 'perch.meter.limits';
const CODEX_BACKEND_KEY = 'perch.codex.backend';    // 'chatgpt' (the login), 'api' (a key) or 'bedrock' (AWS credentials); perch's own choice, since Codex has no setting for it
const CODEX_SECRET = 'perch.codex.apiKey';
const STASH = 'perch.meter.stash.';
const POLL_RETRY_MS = 15000;          // fast retry until the first successful fetch
const MIN_BACKOFF_MS = 60000;         // after a rate limit, leave the endpoint alone for at least this long
const MAX_BACKOFF_MS = 30 * 60000;
const LOGIN_WAIT_MS = 15 * 60000;      // how long a login is waited for
// for `claude --settings`, which ranks above the user's settings files: env.CLAUDE_CODE_USE_BEDROCK=1 in ~/.claude/settings.json
// is applied over the process's environment, and a claude on Bedrock does not sign in to the subscription
const OFF_BEDROCK = JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

class MeterHost {
  /**
   * @param {(claude: object, why: 'poll'|'backend'|'config'|'codex', codex: object) => void} onChange
   * @param {{ program?: () => { path: string, from: string } }} [o]  the claude program the tabs run, as resolveProgram gives it
   */
  constructor(context, onChange, { program } = {}) {
    this.context = context;
    this.onChange = onChange || (() => {});
    this.meter = createMeter();
    this.limits = context.globalState.get(CACHE_KEY) || null;
    this.fetchedAt = context.globalState.get(CACHE_KEY + '.at') || null;
    this.cost = null;
    this.error = null;
    this.mode = 'subscription';
    this.backoffUntil = 0;             // no request to the usage endpoint before this time
    this.backoffMs = 0;
    this.pollTimer = null; this.retryTimer = null; this.credWatcher = null; this.credDebounce = null;
    this.codexKey = null;              // the API key from secret storage, read once at start and kept in memory for the agents
    this.codexKeyReady = (context.secrets && context.secrets.get ? context.secrets.get(CODEX_SECRET) : Promise.resolve(undefined)).then((k) => { this.codexKey = k || null; }, () => { this.codexKey = null; });
    this.claudeProgram = program || (() => ({ path: '', from: 'none' }));
    this.signIn = null;                // the login running in a terminal, while it is waited for
    this.loginPollMs = 2000;
    this.disposables = [];
  }

  cfg(key) { return vscode.workspace.getConfiguration('perch').get('meter.' + key); }
  num(key, fallback) { const v = Number(this.cfg(key)); return Number.isFinite(v) && v > 0 ? v : fallback; }

  resolveMode() {
    const m = this.cfg('mode') || 'auto';
    if (m === 'auto') return this.meter.bedrockConfigured() ? 'cost' : 'subscription';
    return m === 'cost' ? 'cost' : 'subscription';
  }
  backend() { return this.meter.bedrockConfigured() ? 'api' : 'subscription'; }
  /** Minutes the prompt cache stays warm, for a tab on the given backend (or the backend a new tab would get); `extra`
   * is what the tab's process is given beyond this one's environment, such as a gateway file's variables. */
  cacheMinutes(backend, extra) { try { return this.meter.promptCacheMinutes(backend || this.backend(), extra); } catch (_) { return 60; } }

  state() {
    const api = this.meter.bedrockConfigured();
    return summarize(
      { mode: this.mode, backend: api ? 'api' : 'subscription', apiCredentials: api ? this.meter.apiCredentialsPresent() : true, limits: this.limits, cost: this.cost, error: this.error, fetchedAt: this.fetchedAt, envNote: this.meter.envNote() },
      { display: this.cfg('display') || 'remaining', showModelWeekly: this.cfg('showModelWeekly') !== false, warnBelow: this.num('warnBelow', 25), errorBelow: this.num('errorBelow', 10) });
  }

  /** ChatGPT plan usage, as Codex last recorded it on this machine. A file read: no request is made. */
  codexState() {
    let u;
    try { u = readCodexUsage(); } catch (_) { u = { limits: null, error: 'codex-scan' }; }
    const s = summarize({ mode: 'subscription', backend: 'subscription', limits: u.limits, error: u.error, fetchedAt: u.at },
      { vendor: 'Codex', display: this.cfg('display') || 'remaining', warnBelow: this.num('warnBelow', 25), errorBelow: this.num('errorBelow', 10) });
    s.plan = u.plan || ''; s.reached = u.reached || null; s.credits = u.credits || null;
    s.asOf = true;                     // the reading is as old as the last Codex turn, not as the last poll
    s.backend = this.codexBackend();
    s.backendLabel = s.backend === 'api' ? 'API' : s.backend === 'bedrock' ? 'Bedrock' : 'ChatGPT';
    s.bedrock = this.codexBedrock();
    s.backendTitle = s.backend === 'api' ? 'Codex runs with your OpenAI API key, billed per token; the plan\'s limits do not apply. Click to choose a backend.'
      : s.backend === 'bedrock' ? `Codex runs on Amazon Bedrock (${s.bedrock.endpoint === 'runtime' ? 'the runtime endpoint' : 'Mantle'}, ${s.bedrock.region}${s.bedrock.profile ? ', profile ' + s.bedrock.profile : ''}) with your AWS credentials, billed to that account; the plan's limits do not apply. Click to choose a backend.`
      : 'Codex runs on your ChatGPT login and its plan. Click to choose a backend.';
    if (s.backend === 'api') { s.segments = []; s.level = 'none'; s.lines = ['Codex is on your API key: billed per token, no plan limits.']; s.action = null; s.plan = ''; }
    if (s.backend === 'bedrock') { s.segments = []; s.level = 'none'; s.lines = ['Codex is on Amazon Bedrock: billed to the AWS account, no plan limits.']; s.action = null; s.plan = ''; }
    return s;
  }
  refreshCodex() { this.emit('codex'); }

  // ---- the Codex backend: the ChatGPT login, or an OpenAI API key. Codex takes the key from its environment per process,
  // so the choice is perch's to keep, and a tab moves on its next turn with nothing restarted.
  /** The key the API backend would run with: the one stored, or OPENAI_API_KEY from the environment. */
  codexApiKey() { return this.codexKey || process.env.OPENAI_API_KEY || null; }
  codexBackend() { const v = this.context.globalState.get(CODEX_BACKEND_KEY); return v === 'api' && this.codexApiKey() ? 'api' : v === 'bedrock' ? 'bedrock' : 'chatgpt'; }
  /** How Codex reaches Bedrock: perch's settings, else the AWS region and profile of the environment and of Claude Code's settings. */
  codexBedrock() { return CodexBedrock.bedrockSettings({ cfg: (k) => vscode.workspace.getConfiguration('perch').get(k), env: process.env, claudeEnv: this.meter.settingsEnv ? this.meter.settingsEnv() : {} }); }
  /** Take down the API key prompt if one is waiting. */
  cancelKeyPrompt() { const c = this.keyPrompt; this.keyPrompt = null; if (c) { try { c.cancel(); c.dispose(); } catch (_) { /* gone already */ } } }
  /** The backend the user chose in the footer's menu. The API key is asked for first when there is none; false if that was declined. */
  async chooseCodexBackend(backend) {
    if (backend !== 'api') this.cancelKeyPrompt();   // a key prompt still waiting is overtaken by this choice
    if (backend === 'api' && !this.codexApiKey() && !(await this.setCodexApiKey())) return false;
    if (backend !== 'api' && backend !== 'bedrock') backend = 'chatgpt';
    await this.setCodexBackend(backend);
    return true;
  }
  async setCodexBackend(backend) { await this.context.globalState.update(CODEX_BACKEND_KEY, backend); this.emit('codexBackend'); }
  /** Ask for a key and keep it in secret storage. Returns true when one is stored. */
  async setCodexApiKey() {
    // one prompt at a time: a choice made while it waits (another backend from the menu, say) takes it down, and its answer
    // is then not acted on. Without that the box stayed open, and a key typed into it later would have put Codex back on the key
    this.cancelKeyPrompt();
    const cts = vscode.CancellationTokenSource ? new vscode.CancellationTokenSource() : null;
    this.keyPrompt = cts;
    let key;
    try { key = await vscode.window.showInputBox({ prompt: 'OpenAI API key for Codex', placeHolder: 'sk-…', password: true, ignoreFocusOut: true, validateInput: (v) => (v && v.trim().length > 20 ? null : 'That does not look like an API key') }, cts ? cts.token : undefined); }
    finally { if (this.keyPrompt === cts) this.keyPrompt = null; }
    if (!key || (cts && cts.token.isCancellationRequested)) return false;
    this.codexKey = key.trim();
    try { if (this.context.secrets && this.context.secrets.store) await this.context.secrets.store(CODEX_SECRET, this.codexKey); } catch (_) { /* kept for this window at least */ }
    return true;
  }
  async clearCodexApiKey() {
    this.codexKey = null;
    try { if (this.context.secrets && this.context.secrets.delete) await this.context.secrets.delete(CODEX_SECRET); } catch (_) { /* nothing stored */ }
    if (this.context.globalState.get(CODEX_BACKEND_KEY) === 'api') await this.setCodexBackend('chatgpt'); else this.emit('codexBackend');
  }
  /** Switch Codex between the ChatGPT login and an API key, for every Codex tab from its next turn. */
  async toggleCodexBackend() {
    if (this.codexBackend() === 'api') { await this.setCodexBackend('chatgpt'); return true; }
    if (!this.codexApiKey() && !(await this.setCodexApiKey())) return false;
    await this.setCodexBackend('api');
    return true;
  }

  emit(why) { const s = this.state(); try { this.onChange(s, why, this.codexState()); } catch (_) { /* a listener must not break polling */ } }

  start() {
    this.mode = this.resolveMode();
    this.emit('poll');                 // cached reading first, so the gauge is there immediately after a reload
    this.poll();
    this.schedule();
    // Re-poll as soon as the credentials file changes, so a logout/login cycle recovers at once.
    try {
      this.credWatcher = unref(fs.watch(this.meter.claudeDir, (_event, filename) => {
        if (filename && filename !== '.credentials.json') return;
        clearTimeout(this.credDebounce);
        this.credDebounce = unref(setTimeout(() => this.poll(), 1000));   // login writes the file more than once
      }));
    } catch (_) { /* ~/.claude missing, or fs.watch unsupported: polling still covers it */ }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => { if (!e.affectsConfiguration('perch.meter')) return; this.schedule(); this.poll('config'); }),
    );
  }

  schedule() { clearInterval(this.pollTimer); this.pollTimer = unref(setInterval(() => this.poll(), this.num('pollMinutes', 5) * 60000)); }

  async poll(why) {
    this.mode = this.resolveMode();
    if (this.mode === 'cost') {
      try { this.cost = this.meter.computeCostStats(); this.fetchedAt = Date.now(); this.error = null; } catch (_) { this.error = 'cost-scan'; }
      if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
      this.emit(why || 'poll');
      return;
    }
    if (Date.now() < this.backoffUntil) { this.emit(why || 'poll'); return; }     // rate limited a moment ago: asking again only prolongs it
    const { limits, error, retryAfterMs } = await this.meter.fetchUsage();
    this.error = error;
    const stopRetry = () => { if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; } };
    if (limits) {
      this.limits = limits; this.fetchedAt = Date.now();
      this.backoffMs = 0; this.backoffUntil = 0;
      this.context.globalState.update(CACHE_KEY, limits);
      this.context.globalState.update(CACHE_KEY + '.at', this.fetchedAt);
      stopRetry();
    } else if (error === 'rate-limited') {
      // Back off, doubling each time, and never fast-retry: the endpoint has said to slow down.
      this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, retryAfterMs || 0, this.backoffMs * 2));
      this.backoffUntil = Date.now() + this.backoffMs;
      stopRetry();
    } else if (!this.limits && !this.retryTimer) {
      // Nothing cached yet: retry fast until the first success. Credential errors are included; they are cheap
      // (no request is made) and this covers a login that rewrites the credentials file moments after startup.
      this.retryTimer = unref(setInterval(() => this.poll(), POLL_RETRY_MS));
    }
    this.emit(why || 'poll');
  }

  /** Switch the backend the NEXT Claude session uses, by flipping env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json.
   * A live process cannot change how it authenticated; the view ends each Claude tab's process and lets the next message resume it. */
  async toggleBackend() {
    const on = this.meter.bedrockConfigured();
    if (!on && !this.meter.apiCredentialsPresent()) {
      // About to select API/Bedrock with nothing to authenticate with: confirm in a modal so it cannot be missed.
      const pick = await vscode.window.showWarningMessage(
        'No Bedrock or API credentials found on this machine: no ~/.aws credentials, AWS_* variables, or ANTHROPIC_API_KEY. The next Claude session would fail to authenticate.',
        { modal: true, detail: 'Switch to API / Bedrock anyway? The switch stays highlighted until credentials are configured.' }, 'Switch Anyway');
      if (pick !== 'Switch Anyway') return false;
    }
    const gs = this.context.globalState;
    try { this.meter.setBedrockSetting(!on, { get: (k) => gs.get(STASH + k), set: (k, v) => gs.update(STASH + k, v) }); }
    catch (e) { vscode.window.showErrorMessage('Perch: could not update ' + this.meter.settingsPath + '. ' + e.message); return false; }
    const msg = 'Claude will use ' + (!on ? 'API / Bedrock' : 'subscription (login)') + ' from now on. Open tabs continue on it from their next message; a tab in the middle of a turn, after that turn.';
    if (on && !this.meter.readCredentials()) {
      // Switched to subscription on a machine that has never logged in: offer the login directly.
      vscode.window.showInformationMessage(msg + ' This machine has no subscription login yet.', 'Log In').then((pick) => { if (pick === 'Log In') this.login(); });
    } else vscode.window.showInformationMessage(msg);
    await this.poll('backend');        // the gauge follows when the mode is auto
    return true;
  }

  /** Whether a Claude session started now would have something to authenticate with, on the backend it would get: the window's, or the one given. */
  canRun(backend) {
    if ((backend || this.backend()) === 'api') return this.meter.apiCredentialsPresent();
    return !!(process.env.ANTHROPIC_API_KEY || this.meter.readCredentials());
  }

  /**
   * Resolves true once a subscription login is there, false when the wait runs out. Polled; the credentials file may not
   * exist yet. While a login runs in a terminal, this is that login's wait (see watchSignIn).
   */
  waitForLogin({ timeoutMs = LOGIN_WAIT_MS, intervalMs = this.loginPollMs } = {}) {
    if (this.signIn) return this.signIn.done;
    return new Promise((resolve) => {
      if (this.meter.readCredentials()) { resolve(true); return; }
      const t0 = Date.now();
      const timer = unref(setInterval(() => {
        if (this.meter.readCredentials()) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 >= timeoutMs) { clearInterval(timer); resolve(false); }
      }, intervalMs));
    });
  }

  /** The login there now, to tell a new one by. Kept in memory for the comparison, never shown. */
  loginStamp() { const c = this.meter.readCredentials(); return c ? JSON.stringify(c) : ''; }

  /**
   * Wait for the login running in `terminal`, as the one login, until a login is there that was not there when it began,
   * until the terminal is closed (on Windows it closes as the program ends), or until the wait runs out. The credentials
   * of an old login may still be there, so their being there is not enough. Resolves true when a new login is there.
   */
  watchSignIn(terminal) {
    const was = this.loginStamp(), t0 = Date.now();
    const landed = () => { const now = this.loginStamp(); return !!now && now !== was; };
    let finish, over = false;
    const s = { terminal, done: new Promise((resolve) => { finish = resolve; }) };
    s.end = (ok) => {
      if (over) return;
      over = true; clearInterval(timer); closed.dispose();
      if (this.signIn === s) this.signIn = null;
      finish(ok);
    };
    const timer = unref(setInterval(() => { if (landed()) s.end(true); else if (Date.now() - t0 >= LOGIN_WAIT_MS) s.end(false); }, this.loginPollMs));
    const closed = vscode.window.onDidCloseTerminal((t) => { if (t === terminal) s.end(landed()); });   // a last look, for a login made as it closed
    this.signIn = s;
    return s.done;
  }

  /**
   * The claude to log in with: the one the tabs run (perch.claude.executable, else the SDK's own, else the Claude Code
   * extension's), else one on PATH. '' when there is none.
   */
  loginProgram() {
    let p = null;
    try { p = this.claudeProgram(); } catch (_) { /* none to be had */ }
    p = p || { path: '', from: 'none' };
    return p.path || (p.from === 'sdk' ? sdkClaude() : '') || onPath('claude');
  }

  /**
   * Log in to the subscription, with Claude Code's own sign-in run in a terminal. One at a time: pressed again while one
   * waits, its terminal is brought back. Returns true when a sign-in was opened, false when none was.
   */
  async login() {
    if (this.signIn) {
      this.signIn.terminal.show();
      vscode.window.showInformationMessage('Perch: a Claude login is already waiting for you, in the Claude login terminal.');
      return false;
    }
    // Preferred: the CLI's own sign-in, `claude auth login`, in a terminal. The Claude Code panel is no way in: revealing
    // it shows the session already running there, which keeps the backend it started on and never offers a login page,
    // and a panel started under env.CLAUDE_CODE_USE_BEDROCK=1 in settings.json is on Bedrock and does not count as logged out.
    // That settings value is applied over the process environment, so it is overridden with --settings, and in the
    // terminal's environment for good measure.
    const program = this.loginProgram();
    if (program) {
      const run = terminalRun(program, ['--settings', OFF_BEDROCK, 'auth', 'login']);
      const terminal = vscode.window.createTerminal(Object.assign({ name: 'Claude login', env: { CLAUDE_CODE_USE_BEDROCK: '0' } }, run.options));
      terminal.show();
      if (run.text) terminal.sendText(run.text);
      this.watchSignIn(terminal);
      return true;
    }
    // No program to run: the panel is the last resort. It shows its login page only when it starts logged out on the subscription.
    if (vscode.extensions.getExtension('anthropic.claude-code')) {
      for (const cmd of ['claude-vscode.editor.openLast', 'claude-vscode.sidebar.open']) {
        try { await vscode.commands.executeCommand(cmd); return true; } catch (_) { /* try the next */ }
      }
    }
    vscode.window.showErrorMessage('Perch: found no claude program to log in with, here or on PATH. Install the Claude Code extension, or set perch.claude.executable to a claude program, then log in.');
    return false;
  }

  dispose() {
    clearInterval(this.pollTimer); clearInterval(this.retryTimer); clearTimeout(this.credDebounce);
    if (this.credWatcher) this.credWatcher.close();
    if (this.signIn) this.signIn.end(false);
    for (const d of this.disposables) d.dispose();
  }
}

module.exports = { MeterHost };
