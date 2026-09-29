'use strict';
const vscode = require('vscode');
const { randomBytes, randomUUID } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');
const { loadClaudeModels, loadCodexModels, normalizeCommands } = require('./models');
const { MeterHost } = require('./meterHost');

const MODES = {
  claude: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
  codex: ['read-only', 'workspace-write', 'danger-full-access'],
};
// '' means "leave it to the agent's default". These lists are only the fallback used until the
// agent's own model catalog has loaded; after that, each model supplies its own effort levels.
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
const IDE_MAX_CHARS = 12000;          // a selection longer than this is cut, and says so

/**
 * What the editor is looking at, for a Codex message: the active file and, if there is one, the selection.
 * @returns {{ block: string, tag: string } | null}  the text appended to the message, and a short label for the transcript
 */
function ideContext() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !ed.document || ed.document.uri.scheme !== 'file') return null;
  const path = require('path');
  const abs = ed.document.uri.fsPath, r = path.relative(cwd(), abs);
  const file = r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs;
  const sel = ed.selection, lang = ed.document.languageId || '';
  const lines = ['', '', '<ide_context>', `Active file: ${file}` + (lang ? ` (${lang})` : '')];
  let tag = file;
  if (sel && !sel.isEmpty) {
    let text = ed.document.getText(sel); const a = sel.start.line + 1, b = sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
    const cut = text.length > IDE_MAX_CHARS; if (cut) text = text.slice(0, IDE_MAX_CHARS);
    const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((x) => x.length + 1)));   // longer than any run inside
    lines.push(`Selection: lines ${a}-${b}` + (cut ? ` (first ${IDE_MAX_CHARS} characters)` : ''), fence + lang, text.replace(/\n$/, ''), fence);
    tag = `${file}:${a}` + (b > a ? `-${b}` : '');
  } else if (sel) lines.push(`Cursor: line ${sel.active.line + 1}`);
  lines.push('</ide_context>');
  return { block: lines.join('\n'), tag };
}

function cfg(key) { return vscode.workspace.getConfiguration('perch').get(key); }
function defaultEffort(kind) { return String((kind === 'claude' ? cfg('claude.effort') : cfg('codex.reasoningEffort')) || ''); }
function defaultModel(kind) { return String((kind === 'claude' ? cfg('claude.model') : cfg('codex.model')) || ''); }
function defaultMode(kind) { return kind === 'claude' ? (cfg('claude.permissionMode') || 'default') : (cfg('codex.sandboxMode') || 'workspace-write'); }

/** One tab: one agent process, one context. The host owns the transcript so the page can be rebuilt at any time. */
class Session {
  constructor(view, { id, kind, title, titled, mode, effort, model, ide, resume }) {
    this.view = view;
    this.id = id || randomUUID();
    this.kind = kind;
    this.title = title;
    this.titled = !!titled;          // true once the title came from the first message
    this.mode = mode || defaultMode(kind);
    this.model = typeof model === 'string' ? model : defaultModel(kind);     // '' = the agent's default model
    this.effort = typeof effort === 'string' ? effort : defaultEffort(kind);  // '' = the model's default effort
    this.actualModel = '';           // what the agent reported it is really running
    this.backend = '';               // claude only: the backend this tab's agent started on
    this.context = null;             // claude only: { percent, used, max } of the context window
    this.respondedAt = 0;            // when the agent last answered: the prompt cache is warm from then
    this.queue = [];                 // codex only: messages waiting for the current turn to end
    this.ide = kind === 'codex' && !!ide;   // codex only: attach the active file and selection to each message
    this.reconcile();
    this.agentSessionId = resume || null;
    this.agent = null;               // started lazily on first message
    this.history = [];
    this.pending = new Map();        // permission id -> resolve
    this.busy = false;
    this.attention = false;          // a prompt is waiting while the tab is not active
    this.lastStatus = this.idleStatus();
    if (resume) this.history.push({ kind: 'note', text: `resumed ${kind} session ${String(resume).slice(0, 8)} · earlier transcript is not shown, the agent still has it` });
  }

  idleStatus() { return 'idle'; }     // state only: mode, effort, and model have their own selectors

  // ---- what this tab may choose, given the agent's catalog and the selected model
  catalog() { return this.view.catalog[this.kind] || null; }
  selectedModel() {
    const cat = this.catalog(); if (!cat) return null;
    return this.model ? (cat.models.find((m) => m.value === this.model) || null) : cat.defaultModel;
  }
  allowedEfforts() {
    const m = this.selectedModel();
    if (m) return ['', ...m.efforts];
    return this.catalog() ? ['', ...new Set(this.catalog().models.flatMap((x) => x.efforts))] : EFFORTS[this.kind];   // unknown model, or no catalog yet
  }
  allowedModels() {
    const cat = this.catalog();
    const vals = cat ? cat.models.map((m) => m.value) : [];
    return ['', ...vals, ...(this.model && !vals.includes(this.model) ? [this.model] : [])];   // keep a saved or configured model the catalog does not list
  }
  /** Keep effort valid for the selected model. Returns true if it had to change. */
  reconcile() {
    if (this.allowedEfforts().includes(this.effort)) return false;
    this.effort = ''; return true;
  }
  modelOptions() {
    const cat = this.catalog(); const d = cat && cat.defaultModel;
    const opts = [{ value: '', label: 'default' + (d && d.label ? ' · ' + d.label : ''), title: 'The model the agent picks by default' }];
    for (const v of this.allowedModels().slice(1)) { const m = cat && cat.models.find((x) => x.value === v); opts.push({ value: v, label: m ? m.label : v, title: m ? m.description : 'not in the agent\'s model list' }); }
    return opts;
  }
  effortOptions() {
    const m = this.selectedModel(); const d = m && m.defaultEffort;
    return this.allowedEfforts().map((v) => (v ? { value: v, label: v } : { value: '', label: 'default' + (d ? ' · ' + d : '') }));
  }

  post(ev) {
    switch (ev.kind) {
      case 'status': this.lastStatus = ev.text; break;
      case 'busy':
        if (!ev.busy && this.queue.length && this.agent && !this.stopping) { const next = this.queue.shift(); this.view.sendTabs(); setImmediate(() => { if (this.agent) this.agent.send(next.text, next.shown); }); return; }   // stay busy: the next queued message starts now
        this.stopping = false;
        if (!ev.busy && this.kind === 'codex' && this.busy) { const t = setTimeout(() => this.view.meter.refreshCodex(), 400); if (t.unref) t.unref(); }   // Codex has just recorded its limits
        this.busy = !!ev.busy; this.view.sendTabs(); this.view.sendEvent(this.id, ev); this.post({ kind: 'status', text: this.busy ? 'working' : 'ready' }); return;
      case 'model': this.actualModel = ev.id; this.view.sendTabs(); return;
      case 'context': this.context = { percent: Math.max(0, Math.min(100, Math.round(ev.percent))), used: ev.used, max: ev.max }; if (ev.model) this.actualModel = ev.model; this.view.sendTabs(); return;
      case 'responded': this.respondedAt = ev.at; this.view.sendTabs(); return;
      case 'commands': this.view.setCommands(this.kind, ev.list); return;
      case 'session': this.agentSessionId = ev.id; this.view.persist(); break;
      case 'clear': this.history = []; break;
      case 'delta': case 'tool_start': case 'stderr': case 'mode': case 'fill': break;
      case 'user':
        // A queued Codex message is shown when it is queued. When its turn starts, the agent reports it again: that echo is dropped.
        if (this.kind === 'codex' && !ev.queued && this.shown && this.shown[0] === ev.text) { this.shown.shift(); return; }
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
      this.backend = this.view.meter ? this.view.meter.backend() : '';     // fixed for the life of the agent process
      this.agent = new ClaudeAgent({
        cwd: cwd(), emit, resume,
        permissionMode: this.mode,
        model: this.model || undefined,
        effort: this.effort || undefined,
        executable: cfg('claude.executable') || undefined,
        askPermission: (req) => new Promise((resolve) => this.pending.set(req.id, resolve)),
      });
    } else {
      this.agent = new CodexAgent({
        cwd: cwd(), emit, resume,
        sandboxMode: this.mode,
        approvalPolicy: cfg('codex.approvalPolicy'),
        model: this.model || undefined,
        reasoningEffort: this.effort || undefined,
      });
    }
    return this.agent;
  }

  /** A message sent while the agent is working is queued. Claude Code queues it itself; for Codex, whose SDK takes one
   * turn at a time, the queue is kept here and drained as each turn ends. */
  send(text) {
    if (!text || !text.trim()) return;
    const agent = this.ensureAgent();
    if (this.kind !== 'codex') { agent.send(text); return; }
    // IDE context is read now, when the message is written, not later when a queued message starts
    const ctx = this.ide ? ideContext() : null;
    const full = ctx ? text + ctx.block : text, shown = { text, tag: ctx ? 'IDE context · ' + ctx.tag : undefined };
    if (this.busy) {
      this.queue.push({ text: full, shown }); (this.shown = this.shown || []).push(text);
      this.post(Object.assign({ kind: 'user', text, queued: true }, shown.tag ? { tag: shown.tag } : {}));
      this.view.sendTabs();          // the queue count is part of the tab
      return;
    }
    agent.send(full, shown);
  }

  setIde(on) { if (this.kind !== 'codex') return; this.ide = !!on; this.view.persist(); }

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
    if (!this.agent) return;
    if (this.kind === 'claude') this.agent.setPermissionMode(value);
    else this.post({ kind: 'note', text: `sandbox ${value} applies to a new Codex tab; this thread keeps the sandbox it started with` });
  }

  setEffort(value) {
    if (!this.allowedEfforts().includes(value)) return;
    this.effort = value;
    this.view.persist();
    if (!this.agent) return;
    if (this.kind === 'claude') this.agent.setEffort(value);          // live: applies from the next request
    else this.post({ kind: 'note', text: `effort ${value || 'default'} applies to a new Codex tab; this thread keeps the effort it started with` });
  }

  setModel(value) {
    if (!this.allowedModels().includes(value)) return;
    this.model = value;
    const effortReset = this.reconcile();                              // the new model may not accept the current effort
    this.view.persist();
    if (!this.agent) return;
    if (this.kind === 'claude') { this.agent.setModel(value); if (effortReset) this.agent.setEffort(''); }
    else this.post({ kind: 'note', text: `model ${value || 'default'} applies to a new Codex tab; this thread keeps the model it started with` });
  }

  /** Stops the current turn and drops anything queued behind it. */
  interrupt() { if (!this.agent) return; if (this.queue.length) { this.post({ kind: 'note', text: `${this.queue.length} queued message${this.queue.length > 1 ? 's' : ''} dropped` }); this.queue = []; this.shown = []; this.view.sendTabs(); } this.stopping = true; this.agent.interrupt(); }
  lastAnswer() { return this.agent ? this.agent.lastAnswer : ''; }

  dispose() {
    if (this.agent) { this.agent.dispose(); this.agent = null; }
    for (const r of this.pending.values()) r({ decision: 'deny', message: 'session closed' });
    this.pending.clear();
  }

  toTab() {
    return {
      id: this.id, kind: this.kind, title: this.title, busy: this.busy, attention: this.attention, started: !!this.agent,
      mode: this.mode, modes: MODES[this.kind],
      model: this.model, models: this.modelOptions(), actualModel: this.actualModel,
      effort: this.effort, efforts: this.effortOptions(),
      approvals: this.kind === 'codex' ? String(cfg('codex.approvalPolicy') || '') : '',
      backend: this.agent ? this.backend : '',
      queued: this.queue.length,
      ide: this.kind === 'codex' ? this.ide : null,
      context: this.kind === 'claude' ? this.context : null,
      // the prompt cache: how long it stays warm, and since when. Claude only; Codex does not expose its cache lifetime.
      cache: this.kind === 'claude' ? { minutes: this.view.meter.cacheMinutes(this.agent ? this.backend : ''), since: this.respondedAt } : null,
    };
  }
  toState() { return { id: this.id, kind: this.kind, title: this.title, titled: this.titled, mode: this.mode, effort: this.effort, model: this.model, ide: this.ide, resume: this.agentSessionId }; }
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
    this.catalog = { claude: null, codex: null };   // filled from the agents; tabs fall back to static lists until then
    this.loading = null;
    this.commands = { claude: [], codex: [] };                 // slash commands, from the agent
    this.meter = new MeterHost(context, (state, why, codex) => this.onMeter(state, why, codex));
    this.restore();
  }

  // ---- Claude usage and backend
  onMeter(state, why, codex) {
    this.raw({ type: 'meter', meter: state, codex });
    if (why !== 'backend') return;
    // models differ by backend, and a running agent cannot change how it authenticated
    this.loadCatalogs(true);
    for (const s of this.sessions) if (s.kind === 'claude' && s.agent && s.backend && s.backend !== state.backend) {
      s.post({ kind: 'note', text: `Claude backend is now ${state.backendName}. This tab keeps ${s.backend === 'api' ? 'API / Bedrock' : 'subscription'} until it is closed; open a new tab to use the new backend.` });
    }
  }
  setCommands(kind, list) {
    const next = normalizeCommands(list);
    if (JSON.stringify(next) === JSON.stringify(this.commands[kind])) return;
    this.commands[kind] = next;
    this.raw({ type: 'commands', kind, list: next });
  }

  /** The + button: pick files, and mention them in the message by workspace-relative path. */
  async attach(sid) {
    const s = this.get(sid); if (!s) return;
    const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: 'Mention', defaultUri: root && root.uri, title: `Mention files in ${s.title}` });
    if (!picked || !picked.length) return;
    const rel = (u) => { const p = u.fsPath, base = cwd(); const r = require('path').relative(base, p); return r && !r.startsWith('..') && !require('path').isAbsolute(r) ? r : p; };
    this.sendEvent(sid, { kind: 'insert', text: picked.map((u) => '@' + rel(u)).join(' ') + ' ' });
  }

  /** Read both agents' model lists. Codex is a file read; Claude starts its CLI without sending a message. */
  loadCatalogs(force) {
    if (this.loading && !force) return this.loading;
    const apply = (kind, cat) => {
      if (!cat) return;
      this.catalog[kind] = cat;
      if (Array.isArray(cat.commands)) this.setCommands(kind, cat.commands);
      let changed = false; for (const s of this.sessions) if (s.kind === kind && s.reconcile()) changed = true;
      if (changed) this.persist();
      this.sendTabs();
    };
    try { apply('codex', loadCodexModels()); } catch (_) { /* keep the fallback lists */ }
    this.loading = Promise.resolve()
      .then(() => loadClaudeModels({ cwd: cwd(), executable: cfg('claude.executable') || undefined }))
      .then((cat) => apply('claude', cat))
      .catch(() => { /* keep the fallback lists */ });
    return this.loading;
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
        this.raw({ type: 'meter', meter: this.meter.state(), codex: this.meter.codexState() });
        for (const k of Object.keys(this.commands)) if (this.commands[k].length) this.raw({ type: 'commands', kind: k, list: this.commands[k] });
        this.loadCatalogs();
        for (const x of this.sessions) this.replay(x);
        return;
      case 'send': if (s) s.send(msg.text); return;
      case 'stop': if (s) s.interrupt(); return;
      case 'permission': if (s) s.answerPermission(msg.id, msg.decision); return;
      case 'setMode': if (s) { s.setMode(msg.value); this.sendTabs(); } return;
      case 'setEffort': if (s) { s.setEffort(msg.value); this.sendTabs(); } return;
      case 'setModel': if (s) { s.setModel(msg.value); this.sendTabs(); } return;
      case 'attach': this.attach(msg.sid); return;
      case 'setIde': if (s) { s.setIde(msg.value); this.sendTabs(); } return;
      case 'meterRefresh': if (msg.vendor === 'codex') this.meter.refreshCodex(); else this.meter.poll(); return;
      case 'meterToggle': this.meter.toggleBackend(); return;
      case 'meterLogin': this.meter.login(); return;
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

  dispose() { for (const s of this.sessions) s.dispose(); this.meter.dispose(); }
}

function activate(context) {
  const perch = new PerchView(context);
  perch.meter.start();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.main', perch, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('perch.newClaude', () => perch.addSession('claude')),
    vscode.commands.registerCommand('perch.newCodex', () => perch.addSession('codex')),
    vscode.commands.registerCommand('perch.stop', () => { const s = perch.active(); if (s) s.interrupt(); }),
    vscode.commands.registerCommand('perch.closeTab', () => { if (perch.activeId) perch.closeSession(perch.activeId); }),
    vscode.commands.registerCommand('perch.handoff', () => perch.handoff()),
    vscode.commands.registerCommand('perch.refreshModels', () => perch.loadCatalogs(true)),
    vscode.commands.registerCommand('perch.meter.refresh', () => perch.meter.poll()),
    vscode.commands.registerCommand('perch.meter.toggleBackend', () => perch.meter.toggleBackend()),
    vscode.commands.registerCommand('perch.meter.login', () => perch.meter.login()),
    { dispose: () => perch.dispose() },
  );
  return perch;   // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
