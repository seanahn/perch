'use strict';
const vscode = require('vscode');
const { randomBytes, randomUUID } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');

const MODES = {
  claude: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  codex: ['read-only', 'workspace-write', 'danger-full-access'],
};
// '' means "leave it to the agent's default"
const EFFORTS = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};
const STATE_KEY = 'perch.sessions.v1';
// Icons are read at runtime from the vendors' own installed extensions. perch ships no logos.
const VENDOR_EXTENSIONS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

/**
 * Each vendor extension ships a glyph (its activity-bar icon, a single-colour shape) and a
 * marketplace image (the glyph inverted on a filled tile). The glyph is what the vendor shows
 * on its own tabs, so it is preferred; the image is the fallback.
 * @returns {{ icons: Record<string,{glyph?:string,image?:string}>, roots: any[] }}
 */
function vendorIcons(webview) {
  const icons = {}; const roots = [];
  for (const [kind, id] of Object.entries(VENDOR_EXTENSIONS)) {
    try {
      const ext = vscode.extensions.getExtension(id);
      if (!ext || !ext.packageJSON) continue;               // not installed: the page falls back to a letter
      const pj = ext.packageJSON;
      const containers = (pj.contributes && pj.contributes.viewsContainers) || {};
      const bar = [...(containers.activitybar || []), ...(containers.secondarySidebar || []), ...(containers.panel || [])]
        .map((c) => c && c.icon).find((i) => typeof i === 'string' && /\.svg$/i.test(i));
      const uri = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(ext.extensionUri, rel)).toString();
      const entry = {};
      if (bar) entry.glyph = uri(bar);
      if (typeof pj.icon === 'string' && pj.icon) entry.image = uri(pj.icon);
      if (!entry.glyph && !entry.image) continue;
      icons[kind] = entry;
      roots.push(ext.extensionUri);
    } catch (_) { /* fall back to the letter badge */ }
  }
  return { icons, roots };
}
const MAX_HISTORY = 2000;

function cwd() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : require('os').homedir();
}
function cfg(key) { return vscode.workspace.getConfiguration('perch').get(key); }
function defaultEffort(kind) { const v = (kind === 'claude' ? cfg('claude.effort') : cfg('codex.reasoningEffort')) || ''; return EFFORTS[kind].includes(v) ? v : ''; }
function defaultMode(kind) { return kind === 'claude' ? (cfg('claude.permissionMode') || 'default') : (cfg('codex.sandboxMode') || 'workspace-write'); }

/** One tab: one agent process, one context. The host owns the transcript so the page can be rebuilt at any time. */
class Session {
  constructor(view, { id, kind, title, titled, mode, effort, resume }) {
    this.view = view;
    this.id = id || randomUUID();
    this.kind = kind;
    this.title = title;
    this.titled = !!titled;          // true once the title came from the first message
    this.mode = mode || defaultMode(kind);
    this.effort = EFFORTS[kind].includes(effort) ? effort : defaultEffort(kind);
    this.agentSessionId = resume || null;
    this.agent = null;               // started lazily on first message
    this.history = [];
    this.pending = new Map();        // permission id -> resolve
    this.busy = false;
    this.attention = false;          // a prompt is waiting while the tab is not active
    this.lastStatus = this.idleStatus();
    if (resume) this.history.push({ kind: 'note', text: `resumed ${kind} session ${String(resume).slice(0, 8)} · earlier transcript is not shown, the agent still has it` });
  }

  idleStatus() { return (this.kind === 'claude' ? `idle · mode ${this.mode}` : `idle · sandbox ${this.mode}`) + (this.effort ? ` · effort ${this.effort}` : ''); }

  post(ev) {
    switch (ev.kind) {
      case 'status': this.lastStatus = ev.text; break;
      case 'busy': this.busy = !!ev.busy; this.view.sendTabs(); break;
      case 'session': this.agentSessionId = ev.id; this.view.persist(); break;
      case 'clear': this.history = []; break;
      case 'delta': case 'tool_start': case 'stderr': case 'mode': case 'fill': break;
      case 'user':
        if (!this.titled) { this.title = ev.text.replace(/\s+/g, ' ').trim().slice(0, 28) || this.title; this.titled = true; this.view.sendTabs(); this.view.persist(); }
        this.history.push(ev); break;
      case 'permission':
        if (this.view.activeId !== this.id) { this.attention = true; this.view.sendTabs(); }
        this.history.push(ev); break;
      default: this.history.push(ev);
    }
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.view.sendEvent(this.id, ev);
  }

  ensureAgent() {
    if (this.agent) return this.agent;
    const emit = (ev) => this.post(ev);
    const resume = this.agentSessionId || undefined;
    if (this.kind === 'claude') {
      this.agent = new ClaudeAgent({
        cwd: cwd(), emit, resume,
        permissionMode: this.mode,
        model: cfg('claude.model') || undefined,
        effort: this.effort || undefined,
        executable: cfg('claude.executable') || undefined,
        askPermission: (req) => new Promise((resolve) => this.pending.set(req.id, resolve)),
      });
    } else {
      this.agent = new CodexAgent({
        cwd: cwd(), emit, resume,
        sandboxMode: this.mode,
        approvalPolicy: cfg('codex.approvalPolicy'),
        model: cfg('codex.model') || undefined,
        reasoningEffort: this.effort || undefined,
      });
    }
    return this.agent;
  }

  send(text) { this.ensureAgent().send(text); }

  answerPermission(id, decision) {
    const r = this.pending.get(id);
    if (r) { this.pending.delete(id); r({ decision }); }
    const i = this.history.findIndex((h) => h.kind === 'permission' && h.id === id);
    if (i >= 0) this.history[i] = { kind: 'note', text: `${this.history[i].tool}: ${decision}` };
    if (!this.pending.size && this.attention) { this.attention = false; this.view.sendTabs(); }
  }

  setMode(value) {
    if (!MODES[this.kind].includes(value)) return;
    this.mode = value;
    this.view.persist();
    if (!this.agent) { this.post({ kind: 'status', text: this.idleStatus() }); return; }
    if (this.kind === 'claude') this.agent.setPermissionMode(value);
    else this.post({ kind: 'note', text: `sandbox ${value} applies to a new Codex tab; this thread keeps the sandbox it started with` });
  }

  setEffort(value) {
    if (!EFFORTS[this.kind].includes(value)) return;
    this.effort = value;
    this.view.persist();
    if (!this.agent) { this.post({ kind: 'status', text: this.idleStatus() }); return; }
    if (this.kind === 'claude') this.agent.setEffort(value);          // live: applies from the next request
    else this.post({ kind: 'note', text: `effort ${value || 'default'} applies to a new Codex tab; this thread keeps the effort it started with` });
  }

  interrupt() { if (this.agent) this.agent.interrupt(); }
  lastAnswer() { return this.agent ? this.agent.lastAnswer : ''; }

  dispose() {
    if (this.agent) { this.agent.dispose(); this.agent = null; }
    for (const r of this.pending.values()) r({ decision: 'deny', message: 'session closed' });
    this.pending.clear();
  }

  toTab() { return { id: this.id, kind: this.kind, title: this.title, busy: this.busy, attention: this.attention, mode: this.mode, modes: MODES[this.kind], effort: this.effort, efforts: EFFORTS[this.kind] }; }
  toState() { return { id: this.id, kind: this.kind, title: this.title, titled: this.titled, mode: this.mode, effort: this.effort, resume: this.agentSessionId }; }
}

/** The single Perch view: a tab bar over any number of sessions. */
class PerchView {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.ready = false;
    this.sessions = [];
    this.activeId = null;
    this.counters = { claude: 0, codex: 0 };
    this.restore();
  }

  // ---- persistence: tabs survive a window reload by resuming the agent's own saved session
  restore() {
    const saved = this.context.workspaceState.get(STATE_KEY);
    if (!saved || !Array.isArray(saved.sessions) || !saved.sessions.length) return;
    for (const s of saved.sessions) {
      if (s.kind !== 'claude' && s.kind !== 'codex') continue;
      this.counters[s.kind]++;
      this.sessions.push(new Session(this, s));
    }
    // counters are saved so a new tab never reuses the name of one that is still open
    for (const k of Object.keys(this.counters)) this.counters[k] = Math.max(this.counters[k], Number(saved.counters && saved.counters[k]) || 0);
    this.activeId = this.sessions.some((s) => s.id === saved.active) ? saved.active : (this.sessions[0] && this.sessions[0].id);
  }
  persist() { this.context.workspaceState.update(STATE_KEY, { active: this.activeId, counters: this.counters, sessions: this.sessions.map((s) => s.toState()) }); }

  // ---- webview plumbing
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const w = webviewView.webview;
    const { icons, roots } = vendorIcons(w);
    w.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, ...roots].filter(Boolean) };
    w.html = getHtml({ nonce: randomBytes(16).toString('hex'), cspSource: w.cspSource, icons });
    w.onDidReceiveMessage((msg) => this.onMessage(msg));
    webviewView.onDidDispose(() => { this.ready = false; this.view = null; });
  }
  raw(msg) { if (this.ready && this.view) this.view.webview.postMessage(msg); }
  sendEvent(sid, ev) { this.raw({ type: 'event', sid, ev }); }
  sendTabs() { this.raw({ type: 'tabs', tabs: this.sessions.map((s) => s.toTab()), active: this.activeId }); }
  replay(s) {
    this.sendEvent(s.id, { kind: 'clear' });
    for (const ev of s.history) this.sendEvent(s.id, ev);
    this.sendEvent(s.id, { kind: 'busy', busy: s.busy });
    this.sendEvent(s.id, { kind: 'status', text: s.lastStatus });
  }
  get(id) { return this.sessions.find((s) => s.id === id); }
  active() { return this.get(this.activeId); }

  onMessage(msg) {
    const s = msg.sid ? this.get(msg.sid) : null;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.sendTabs();                 // no tabs are created for you: a fresh workspace starts empty
        for (const x of this.sessions) this.replay(x);
        return;
      case 'send': if (s) s.send(msg.text); return;
      case 'stop': if (s) s.interrupt(); return;
      case 'permission': if (s) s.answerPermission(msg.id, msg.decision); return;
      case 'setMode': if (s) { s.setMode(msg.value); this.sendTabs(); } return;
      case 'setEffort': if (s) { s.setEffort(msg.value); this.sendTabs(); } return;
      case 'activate': this.activate(msg.sid); return;
      case 'new': this.addSession(msg.kind); return;
      case 'close': this.closeSession(msg.sid); return;
      default: return;
    }
  }

  // ---- session management
  addSession(kind, { fill } = {}) {
    if (kind !== 'claude' && kind !== 'codex') return null;
    const n = ++this.counters[kind];
    const s = new Session(this, { kind, title: `${kind === 'claude' ? 'Claude' : 'Codex'} ${n}` });
    this.sessions.push(s);
    this.activeId = s.id;
    this.persist();
    this.sendTabs();
    this.replay(s);
    if (fill) this.sendEvent(s.id, { kind: 'fill', text: fill });
    return s;
  }

  closeSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.sessions[i].dispose();
    this.sessions.splice(i, 1);
    if (this.activeId === id) { const next = this.sessions[Math.min(i, this.sessions.length - 1)]; this.activeId = next ? next.id : null; }
    if (!this.sessions.length) this.counters = { claude: 0, codex: 0 };   // nothing open, nothing to collide with: numbering starts over
    this.persist();
    this.sendTabs();
  }

  activate(id) {
    const s = this.get(id);
    if (!s) return;
    this.activeId = id;
    if (s.attention && !s.pending.size) s.attention = false;
    this.persist();
    this.sendTabs();
  }

  async handoff() {
    const from = this.active();
    const text = from ? from.lastAnswer() : '';
    if (!text) { vscode.window.showInformationMessage('The active Perch tab has no answer to hand off yet.'); return; }
    const items = [
      ...this.sessions.filter((s) => s.id !== from.id).map((s) => ({ label: s.title, description: s.kind, sid: s.id })),
      { label: 'New Claude tab', description: 'claude', kind: 'claude' },
      { label: 'New Codex tab', description: 'codex', kind: 'codex' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Send the last answer from "${from.title}" to…` });
    if (!pick) return;
    if (pick.sid) { this.activate(pick.sid); this.sendEvent(pick.sid, { kind: 'fill', text }); }
    else this.addSession(pick.kind, { fill: text });
    if (this.view) this.view.show(true);
  }

  dispose() { for (const s of this.sessions) s.dispose(); }
}

function activate(context) {
  const perch = new PerchView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.main', perch, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('perch.newClaude', () => perch.addSession('claude')),
    vscode.commands.registerCommand('perch.newCodex', () => perch.addSession('codex')),
    vscode.commands.registerCommand('perch.stop', () => { const s = perch.active(); if (s) s.interrupt(); }),
    vscode.commands.registerCommand('perch.closeTab', () => { if (perch.activeId) perch.closeSession(perch.activeId); }),
    vscode.commands.registerCommand('perch.handoff', () => perch.handoff()),
    { dispose: () => perch.dispose() },
  );
  return perch;   // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
