'use strict';
// The editor-facing half of the meter: polling, caching, the backend switch, and login. The gauge itself is the
// footer of each tab; perch puts nothing in the status bar.
// Merged from AI Meter. The logic it drives lives in ./meter and has no VS Code dependency.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMeter, summarize } = require('./meter');
const { readCodexUsage } = require('./codexMeter');

const CACHE_KEY = 'perch.meter.limits';
const CODEX_BACKEND_KEY = 'perch.codex.backend';    // 'chatgpt' (the login) or 'api' (a key); perch's own choice, since Codex has no setting for it
const CODEX_SECRET = 'perch.codex.apiKey';
const STASH = 'perch.meter.stash.';
const POLL_RETRY_MS = 15000;          // fast retry until the first successful fetch
const MIN_BACKOFF_MS = 60000;         // after a rate limit, leave the endpoint alone for at least this long
const MAX_BACKOFF_MS = 30 * 60000;
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

class MeterHost {
  /** @param {(claude: object, why: 'poll'|'backend'|'config'|'codex', codex: object) => void} onChange */
  constructor(context, onChange) {
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
    s.backendLabel = s.backend === 'api' ? 'API' : 'ChatGPT';
    s.backendTitle = s.backend === 'api' ? 'Codex runs with your OpenAI API key, billed per token; the plan\'s limits do not apply. Click to use the ChatGPT login instead.' : 'Codex runs on your ChatGPT login and its plan. Click to use an OpenAI API key instead.';
    if (s.backend === 'api') { s.segments = []; s.level = 'none'; s.lines = ['Codex is on your API key: billed per token, no plan limits.']; s.action = null; s.plan = ''; }
    return s;
  }
  refreshCodex() { this.emit('codex'); }

  // ---- the Codex backend: the ChatGPT login, or an OpenAI API key. Codex takes the key from its environment per process,
  // so the choice is perch's to keep, and a tab moves on its next turn with nothing restarted.
  /** The key the API backend would run with: the one stored, or OPENAI_API_KEY from the environment. */
  codexApiKey() { return this.codexKey || process.env.OPENAI_API_KEY || null; }
  codexBackend() { return this.context.globalState.get(CODEX_BACKEND_KEY) === 'api' && this.codexApiKey() ? 'api' : 'chatgpt'; }
  async setCodexBackend(backend) { await this.context.globalState.update(CODEX_BACKEND_KEY, backend); this.emit('codexBackend'); }
  /** Ask for a key and keep it in secret storage. Returns true when one is stored. */
  async setCodexApiKey() {
    const key = await vscode.window.showInputBox({ prompt: 'OpenAI API key for Codex', placeHolder: 'sk-…', password: true, ignoreFocusOut: true, validateInput: (v) => (v && v.trim().length > 20 ? null : 'That does not look like an API key') });
    if (!key) return false;
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

  /** Whether a Claude session started now would have something to authenticate with, on the backend it would get. */
  canRun() {
    if (this.meter.bedrockConfigured()) return this.meter.apiCredentialsPresent();
    return !!(process.env.ANTHROPIC_API_KEY || this.meter.readCredentials());
  }

  /** Resolves true once a subscription login is there, false when the wait runs out. Polled; the credentials file may not exist yet. */
  waitForLogin({ timeoutMs = 15 * 60000, intervalMs = 2000 } = {}) {
    return new Promise((resolve) => {
      if (this.meter.readCredentials()) { resolve(true); return; }
      const t0 = Date.now();
      const timer = unref(setInterval(() => {
        if (this.meter.readCredentials()) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 >= timeoutMs) { clearInterval(timer); resolve(false); }
      }, intervalMs));
    });
  }

  /** Locate the claude CLI: PATH first, then the binary bundled inside the Claude Code extension. */
  findClaudeBinary() {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { timeout: 3000 }); return 'claude'; } catch (_) { /* not on PATH */ }
    const ext = vscode.extensions.getExtension('anthropic.claude-code');
    if (ext) {
      const bin = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (_) { /* no bundled binary */ }
    }
    return null;
  }

  async login() {
    // Preferred: the Claude Code panel. When logged out it shows its graphical login page, with no CLI onboarding in the way.
    if (vscode.extensions.getExtension('anthropic.claude-code')) {
      for (const cmd of ['claude-vscode.editor.openLast', 'claude-vscode.sidebar.open']) {
        try { await vscode.commands.executeCommand(cmd); return; } catch (_) { /* try the next, then the terminal */ }
      }
    }
    const bin = this.findClaudeBinary();
    if (!bin) { vscode.window.showErrorMessage('Perch: the claude CLI was not found on PATH and the Claude Code extension is not installed here. Install Claude Code, then log in.'); return; }
    // The CLI's first run opens theme-picker onboarding before login. Mark onboarding done, keeping any existing theme,
    // so /login starts at the login step. The CLI's folder-trust prompt is a real safety question and is left alone.
    try {
      const cfgPath = path.join(os.homedir(), '.claude.json');
      let j = {};
      try { j = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch (_) { j = {}; }
      if (!j.hasCompletedOnboarding) { j.hasCompletedOnboarding = true; if (!j.theme) j.theme = 'dark'; fs.writeFileSync(cfgPath, JSON.stringify(j, null, 2) + '\n'); }
    } catch (_) { /* non-fatal: worst case the CLI shows its onboarding */ }
    // Bedrock is forced off for this terminal so an exported CLAUDE_CODE_USE_BEDROCK=1 cannot keep the CLI in Bedrock mode.
    const term = vscode.window.createTerminal({ name: 'Claude login', env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
    term.show();
    term.sendText((bin === 'claude' ? 'claude' : JSON.stringify(bin)) + ' /login');
  }

  dispose() {
    clearInterval(this.pollTimer); clearInterval(this.retryTimer); clearTimeout(this.credDebounce);
    if (this.credWatcher) this.credWatcher.close();
    for (const d of this.disposables) d.dispose();
  }
}

module.exports = { MeterHost };
