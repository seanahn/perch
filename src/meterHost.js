'use strict';
// The editor-facing half of the meter: polling, caching, the backend switch, login, and the status bar items.
// Merged from AI Meter. The logic it drives lives in ./meter and has no VS Code dependency.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMeter, summarize, fmtTok, fmtUsd, shortModel, tankBar } = require('./meter');

const CACHE_KEY = 'perch.meter.limits';
const STASH = 'perch.meter.stash.';
const POLL_RETRY_MS = 15000;          // fast retry until the first successful fetch
const MIN_BACKOFF_MS = 60000;         // after a rate limit, leave the endpoint alone for at least this long
const MAX_BACKOFF_MS = 30 * 60000;
const LEGACY = 'seanahn.ai-meter';     // the standalone extension this was merged from
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

class MeterHost {
  /** @param {(state: object, why: 'poll'|'backend'|'config') => void} onChange */
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
    this.items = null;                 // { usage, backend } status bar items, when perch owns the status bar
    this.pollTimer = null; this.retryTimer = null; this.credWatcher = null; this.credDebounce = null;
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
  /** Minutes the prompt cache stays warm, for a tab on the given backend (or the backend a new tab would get). */
  cacheMinutes(backend) { try { return this.meter.promptCacheMinutes(backend || this.backend()); } catch (_) { return 60; } }

  state() {
    const api = this.meter.bedrockConfigured();
    return summarize(
      { mode: this.mode, backend: api ? 'api' : 'subscription', apiCredentials: api ? this.meter.apiCredentialsPresent() : true, limits: this.limits, cost: this.cost, error: this.error, fetchedAt: this.fetchedAt, envNote: this.meter.envNote() },
      { display: this.cfg('display') || 'remaining', showModelWeekly: this.cfg('showModelWeekly') !== false, warnBelow: this.num('warnBelow', 25), errorBelow: this.num('errorBelow', 10) });
  }

  emit(why) { const s = this.state(); this.renderStatusBar(s); try { this.onChange(s, why); } catch (_) { /* a listener must not break polling */ } }

  start() {
    this.mode = this.resolveMode();
    this.syncStatusBar();
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
      vscode.workspace.onDidChangeConfiguration((e) => { if (!e.affectsConfiguration('perch.meter')) return; this.schedule(); this.syncStatusBar(); this.poll('config'); }),
      vscode.extensions.onDidChange(() => this.syncStatusBar()),          // the standalone extension was installed or removed
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

  // ---- status bar. perch stands down while the standalone AI Meter is installed, so the gauge is never shown twice.
  wantStatusBar() {
    const v = this.cfg('statusBar') || 'auto';
    if (v === 'on') return true;
    if (v === 'off') return false;
    return !vscode.extensions.getExtension(LEGACY);
  }
  syncStatusBar() {
    const want = this.wantStatusBar();
    if (want && !this.items) {
      // Explicit id and name keep each entry's identity stable across restarts and name it in the context menu.
      // The 0.001 gap between the priorities keeps other extensions' items from slotting in between.
      const usage = vscode.window.createStatusBarItem('perch.meter.usage', vscode.StatusBarAlignment.Right, 100.01);
      usage.name = 'Perch: Claude Usage'; usage.command = 'perch.meter.refresh';
      const backend = vscode.window.createStatusBarItem('perch.meter.backend', vscode.StatusBarAlignment.Right, 100.011);
      backend.name = 'Perch: Claude Backend'; backend.command = 'perch.meter.toggleBackend';
      this.items = { usage, backend };
      this.renderStatusBar(this.state());
    } else if (!want && this.items) {
      this.items.usage.dispose(); this.items.backend.dispose(); this.items = null;
    }
  }
  renderStatusBar(s) {
    if (!this.items) return;
    const { usage, backend } = this.items;
    if (s.mode !== 'cost' && !s.limits && s.error === 'no-credentials' && this.cfg('hideWhenUnavailable')) { usage.hide(); backend.hide(); return; }
    const warn = new vscode.ThemeColor('statusBarItem.warningBackground'), err = new vscode.ThemeColor('statusBarItem.errorBackground');
    backend.text = s.backend === 'api' ? '$(cloud) API' + (s.backendWarn ? ' $(warning)' : '') : '$(account) sub';
    backend.backgroundColor = s.backendWarn ? warn : undefined;
    backend.tooltip = s.backendTitle;
    usage.text = '$(dashboard) ' + s.text;
    usage.backgroundColor = s.level === 'error' ? err : s.level === 'warn' ? warn : undefined;
    const md = new vscode.MarkdownString();
    if (s.mode === 'cost' && s.cost) {
      const c = s.cost;
      md.appendMarkdown('**Claude cost**, estimated from local transcripts  \n');
      md.appendMarkdown('**Session (5h)** ' + fmtTok(c.session.tokens) + ' tokens · ≈' + fmtUsd(c.session.cost) + '  \n');
      md.appendMarkdown('**Today** ' + fmtTok(c.today.tokens) + ' tokens · ≈' + fmtUsd(c.today.cost) + (c.latestModel ? ' · current model `' + shortModel(c.latestModel) + '`' : '') + '  \n');
      md.appendMarkdown('\n**Last 7 days**\n');
      const max = Math.max(0.000001, ...c.days.map((d) => d.cost));
      md.appendCodeblock(c.days.map((d) => d.label + ' ' + '▇'.repeat(Math.round(d.cost / max * 20)).padEnd(20, '·') + ' ' + fmtTok(d.tokens).padStart(6) + ' ' + fmtUsd(d.cost).padStart(6)).join('\n'), 'text');
      md.appendMarkdown('\n');
      for (const m of c.models) md.appendMarkdown('`' + m.model + '` in ' + fmtTok(m.input) + ' · out ' + fmtTok(m.output) + ' · cache r ' + fmtTok(m.cacheRead) + ' w ' + fmtTok(m.cacheWrite) + ' · ' + (m.unpriced ? 'no price data' : '≈' + fmtUsd(m.cost)) + '  \n');
      if (!c.models.length) md.appendMarkdown('No Claude Code activity today (`~/.claude/projects`).  \n');
      md.appendMarkdown('\n_Priced at Anthropic list rates; Bedrock or partner billing may differ. ');
    } else if (s.limits) {
      md.appendMarkdown('**Claude usage**, ' + (this.cfg('display') === 'used' ? 'percent used' : 'percent remaining') + '  \n');
      md.appendMarkdown(s.limits.map((l) => (l.level === 'error' ? '🔴' : l.level === 'warn' ? '🟡' : '🟢') + ' `' + tankBar(l.remaining) + '` **' + l.name + '** ' + l.remaining + '% · resets ' + l.reset + (l.eta ? ' (' + l.eta + ')' : '')).join('  \n'));
      md.appendMarkdown('  \n_');
    } else {
      md.appendMarkdown(s.lines.join('  \n') + (s.action === 'login' ? '\n\n[**Log in to Claude**](command:perch.meter.login)' : '') + '\n\n_');
      md.isTrusted = true;
    }
    if (s.fetchedAt) md.appendMarkdown('Updated ' + new Date(s.fetchedAt).toLocaleTimeString() + ' · ');
    md.appendMarkdown('click to refresh_');
    usage.tooltip = md;
    usage.show(); backend.show();
  }

  /** Switch the backend the NEXT Claude session uses, by flipping env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json.
   * Running sessions keep their auth: a live process cannot change how it authenticated. */
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
    const msg = 'Claude will use ' + (!on ? 'API / Bedrock' : 'subscription (login)') + ' for new tabs and new sessions. Running ones keep their current backend.';
    if (on && !this.meter.readCredentials()) {
      // Switched to subscription on a machine that has never logged in: offer the login directly.
      vscode.window.showInformationMessage(msg + ' This machine has no subscription login yet.', 'Log In').then((pick) => { if (pick === 'Log In') this.login(); });
    } else vscode.window.showInformationMessage(msg);
    await this.poll('backend');        // the gauge follows when the mode is auto
    return true;
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
    if (this.items) { this.items.usage.dispose(); this.items.backend.dispose(); this.items = null; }
    for (const d of this.disposables) d.dispose();
  }
}

module.exports = { MeterHost, LEGACY };
