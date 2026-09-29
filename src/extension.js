'use strict';
const vscode = require('vscode');
const { randomBytes } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');

const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

function cwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : require('os').homedir();
}

/** One sidebar panel bound to one agent kind. Owns the agent lifecycle and the webview. */
class AgentView {
  constructor(kind, context) {
    this.kind = kind;              // 'claude' | 'codex'
    this.context = context;
    this.view = null;
    this.agent = null;
    this.pending = new Map();      // permission id -> resolve
    this.history = [];             // transcript events, replayed when the webview is (re)created
    this.lastStatus = null;        // status bar text survives webview re-creation
    this.busy = false;
    this.ready = false;
    this.mode = this.kind === 'claude' ? this.cfg('claude.permissionMode') : this.cfg('codex.sandboxMode');
  }

  cfg(key) { return vscode.workspace.getConfiguration('perch').get(key); }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const w = webviewView.webview;
    w.options = { enableScripts: true };
    w.html = getHtml({
      agent: this.kind === 'claude' ? 'Claude' : 'Codex',
      nonce: randomBytes(16).toString('hex'),
      cspSource: w.cspSource,
      modes: this.kind === 'claude' ? CLAUDE_MODES : CODEX_SANDBOXES,
      modeLabel: this.kind === 'claude' ? 'mode' : 'sandbox',
      initialMode: this.mode,
    });
    w.onDidReceiveMessage((msg) => this.onMessage(msg));
    webviewView.onDidDispose(() => { this.ready = false; this.view = null; });
  }

  // VS Code destroys and recreates the webview when a view is moved between sidebars or
  // the window reloads. The host is the source of truth: it records every event and
  // replays the transcript, status, and busy state when the page says it is ready.
  post(ev) {
    switch (ev.kind) {
      case 'status': this.lastStatus = ev.text; break;
      case 'busy': this.busy = !!ev.busy; break;
      case 'clear': this.history = []; break;
      case 'delta': case 'tool_start': case 'stderr': case 'session': case 'mode': case 'fill': break;
      default: this.history.push(ev); if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    }
    this.send(ev);
  }

  send(ev) { if (this.ready && this.view) this.view.webview.postMessage({ type: 'event', ev }); }

  replay() {
    this.send({ kind: 'clear' });
    for (const ev of this.history) this.send(ev);
    this.send({ kind: 'mode', value: this.mode });
    this.send({ kind: 'busy', busy: this.busy });
    if (this.lastStatus) this.send({ kind: 'status', text: this.lastStatus });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.replay();
        if (!this.agent) this.start();
        return;
      case 'send':
        if (!this.agent) this.start();
        this.agent.send(msg.text);
        return;
      case 'permission': {
        const r = this.pending.get(msg.id);
        if (r) { this.pending.delete(msg.id); r({ decision: msg.decision }); }
        // an answered prompt must not come back as a live prompt on replay
        const i = this.history.findIndex((h) => h.kind === 'permission' && h.id === msg.id);
        if (i >= 0) this.history[i] = { kind: 'note', text: `${this.history[i].tool}: ${msg.decision}` };
        return;
      }
      case 'setMode':
        this.mode = msg.value;
        if (this.kind === 'claude' && this.agent) this.agent.setPermissionMode(msg.value);
        if (this.kind === 'codex') { this.post({ kind: 'status', text: 'sandbox applies to the next new session' }); }
        return;
      default:
        return;
    }
  }

  start(resume) {
    this.stop();
    const emit = (ev) => this.post(ev);
    if (this.kind === 'claude') {
      this.agent = new ClaudeAgent({
        cwd: cwd(), emit, resume,
        permissionMode: this.mode,
        model: this.cfg('claude.model') || undefined,
        executable: this.cfg('claude.executable') || undefined,
        askPermission: (req) => new Promise((resolve) => this.pending.set(req.id, resolve)),
      });
    } else {
      this.agent = new CodexAgent({
        cwd: cwd(), emit, resume,
        sandboxMode: this.mode,
        approvalPolicy: this.cfg('codex.approvalPolicy'),
        model: this.cfg('codex.model') || undefined,
        reasoningEffort: this.cfg('codex.reasoningEffort') || undefined,
      });
    }
  }

  stop() {
    if (this.agent) { this.agent.dispose(); this.agent = null; }
    for (const r of this.pending.values()) r({ decision: 'deny', message: 'session closed' });
    this.pending.clear();
    this.history = this.history.map((h) => (h.kind === 'permission' ? { kind: 'note', text: `${h.tool}: session closed` } : h));
    this.busy = false;
  }

  newSession() { this.post({ kind: 'clear' }); this.start(); this.post({ kind: 'status', text: 'new session' }); }
  interrupt() { if (this.agent) this.agent.interrupt(); }
  lastAnswer() { return this.agent ? this.agent.lastAnswer : ''; }
  fill(text) { this.post({ kind: 'fill', text }); if (this.view) this.view.show(true); }
  dispose() { this.stop(); }
}

function activate(context) {
  const claude = new AgentView('claude', context);
  const codex = new AgentView('codex', context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.claude', claude, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('perch.codex', codex, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('perch.claude.newSession', () => claude.newSession()),
    vscode.commands.registerCommand('perch.claude.stop', () => claude.interrupt()),
    vscode.commands.registerCommand('perch.codex.newSession', () => codex.newSession()),
    vscode.commands.registerCommand('perch.codex.stop', () => codex.interrupt()),
    vscode.commands.registerCommand('perch.handoff.toCodex', () => { const t = claude.lastAnswer(); if (t) codex.fill(t); else vscode.window.showInformationMessage('Claude has no answer to hand off yet.'); }),
    vscode.commands.registerCommand('perch.handoff.toClaude', () => { const t = codex.lastAnswer(); if (t) claude.fill(t); else vscode.window.showInformationMessage('Codex has no answer to hand off yet.'); }),
    { dispose: () => { claude.dispose(); codex.dispose(); } },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
