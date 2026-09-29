'use strict';
const vscode = require('vscode');
const { randomBytes, randomUUID } = require('crypto');
const { ClaudeAgent } = require('./claudeAgent');
const { CodexAgent } = require('./codexAgent');
const { getHtml } = require('./webview');
const { loadClaudeModels, loadCodexModels, normalizeCommands } = require('./models');
const { MeterHost } = require('./meterHost');
const { VoiceHost } = require('./voiceHost');

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
const PANEL_TYPE = 'perch.session';   // the webview panel type of an editor tab
// how long to wait for VS Code to bring back editor tabs before opening them ourselves (shortened by the tests)
const RESTORE_GRACE_MS = Number(process.env.PERCH_RESTORE_GRACE_MS) > 0 ? Number(process.env.PERCH_RESTORE_GRACE_MS) : 4000;
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

/**
 * The icon of an editor tab. VS Code tints nothing here, so the file must carry its own colour: Claude's glyph is
 * already orange; ChatGPT's comes in a black and a white version, for light and dark themes.
 */
function tabIcon(kind) {
  try {
    const ext = vscode.extensions.getExtension(VENDOR_EXTENSIONS[kind]);
    if (!ext || !ext.packageJSON) return undefined;
    const pj = ext.packageJSON, containers = (pj.contributes && pj.contributes.viewsContainers) || {};
    const glyph = [...(containers.activitybar || []), ...(containers.secondarySidebar || []), ...(containers.panel || [])].map((c) => c && c.icon).find((i) => typeof i === 'string' && /\.svg$/i.test(i));
    const at = (rel) => vscode.Uri.joinPath(ext.extensionUri, rel);
    const exists = (rel) => { try { return require('fs').existsSync(require('path').join(ext.extensionUri.fsPath || ext.extensionPath || '', rel)); } catch (_) { return false; } };
    if (glyph && /white/i.test(glyph)) {            // a white glyph is for dark themes; look for its dark twin
      const black = glyph.replace(/white/i, (m) => (m === 'White' ? 'Black' : m === 'WHITE' ? 'BLACK' : 'black'));
      if (exists(black)) return { light: at(black), dark: at(glyph) };
      return typeof pj.icon === 'string' && pj.icon ? at(pj.icon) : at(glyph);
    }
    if (glyph) return at(glyph);
    return typeof pj.icon === 'string' && pj.icon ? at(pj.icon) : undefined;
  } catch (_) { return undefined; }
}

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
  constructor(view, { id, kind, title, titled, mode, effort, model, ide, resume, location, paneled }) {
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
    this.location = location === 'sidebar' || location === 'editor' ? location : view.where();   // which surface shows this tab
    this.paneled = !!paneled;        // an editor tab has been opened for it at some point, so VS Code will restore that tab
    this.prefill = '';               // text waiting for a page that is not ready yet
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
        if (!this.view.isVisible(this)) { this.attention = true; this.view.sendTabs(); }
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
  toState() { return { id: this.id, kind: this.kind, title: this.title, titled: this.titled, mode: this.mode, effort: this.effort, model: this.model, ide: this.ide, resume: this.agentSessionId, location: this.location, paneled: this.paneled }; }
}

/** The single Perch view: a tab bar over any number of sessions. */
/**
 * Perch itself. Sessions are shown on surfaces: the sidebar view, which has its own tab bar and shows every session that
 * lives there, and editor tabs, one session each, which are native VS Code tabs. Every surface is a page that can be
 * destroyed and rebuilt at any time, so all state lives here and is replayed to a page when it says it is ready.
 */
class PerchView {
  constructor(context) {
    this.context = context;
    this.sidebar = { view: null, ready: false };
    this.panels = new Map();         // session id -> { panel, ready }
    this.sessions = [];
    this.activeId = null;            // the active tab of the sidebar view
    this.counters = { claude: 0, codex: 0 };
    this.catalog = { claude: null, codex: null };   // filled from the agents; tabs fall back to static lists until then
    this.loading = null;
    this.commands = { claude: [], codex: [] };                 // slash commands, from the agent
    this.closing = false;
    this.graceTimer = null;
    this.meter = new MeterHost(context, (state, why, codex) => this.onMeter(state, why, codex));
    this.voice = new VoiceHost({
      root: (context.extensionUri && (context.extensionUri.fsPath || context.extensionUri.path)) || context.extensionPath || require('path').join(__dirname, '..'),
      send: (sid, ev) => this.sendEvent(sid, ev),
      deliver: (sid, text) => this.deliver(sid, text),
    });
    this.restore();
  }

  /** Where a new tab opens: as an editor tab, or in the sidebar view. */
  where() { return cfg('newTabs') === 'sidebar' ? 'sidebar' : 'editor'; }

  // kept for callers and tests that think of the sidebar as "the view"
  get view() { return this.sidebar.view; }
  get ready() { return this.sidebar.ready; }

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

  /** Put text into a session's message box, at the cursor. If its page is not there to take it, it waits. */
  deliver(sid, text) {
    const s = this.get(sid); if (!s || !text) return;
    const f = this.surface(s);
    if (f && f.ready) this.sendEvent(sid, { kind: 'insert', text }); else s.prefill = (s.prefill ? s.prefill.replace(/\s*$/, ' ') : '') + text;
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
      this.sessions.push(new Session(this, s));       // a tab saved before editor tabs existed has no location: it goes where new tabs go
    }
    // counters are saved so a new tab never reuses the name of one that is still open
    for (const k of Object.keys(this.counters)) this.counters[k] = Math.max(this.counters[k], Number(saved.counters && saved.counters[k]) || 0);
    const side = this.sessions.filter((s) => s.location === 'sidebar');
    this.activeId = side.some((s) => s.id === saved.active) ? saved.active : (side[0] ? side[0].id : null);
  }
  persist() { this.context.workspaceState.update(STATE_KEY, { active: this.activeId, counters: this.counters, sessions: this.sessions.map((s) => s.toState()) }); }

  /**
   * Called once the extension is active. VS Code brings back the editor tabs that were open, through the serializer.
   * A tab that has never had an editor tab (it was moved here from the sidebar by a change of setting) is opened now;
   * one that VS Code fails to bring back is opened after a short wait, so no session is left without a surface.
   */
  start() {
    for (const s of this.sessions) if (s.location === 'editor' && !s.paneled) this.openPanel(s, { preserveFocus: true });
    if (this.sessions.some((s) => s.location === 'editor' && s.paneled)) {
      this.graceTimer = setTimeout(() => { this.graceTimer = null; for (const s of this.sessions) if (s.location === 'editor' && !this.panels.has(s.id)) this.openPanel(s, { preserveFocus: true }); }, RESTORE_GRACE_MS);
      if (this.graceTimer.unref) this.graceTimer.unref();
    }
  }

  // ---- surfaces
  mount(webview) {
    const { icons, roots } = vendorIcons(webview);
    webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri, ...roots].filter(Boolean) };
    webview.html = getHtml({ nonce: randomBytes(16).toString('hex'), cspSource: webview.cspSource, icons });
  }

  resolveWebviewView(webviewView) {
    this.sidebar = { view: webviewView, ready: false };
    this.mount(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg, null));
    webviewView.onDidDispose(() => { if (this.sidebar.view === webviewView) this.sidebar = { view: null, ready: false }; });
  }

  /** The column new editor tabs open in: beside the other Perch tabs if there are any, otherwise beside the editor. */
  column() {
    for (const { panel } of this.panels.values()) if (panel.viewColumn !== undefined) return panel.viewColumn;
    return vscode.ViewColumn.Beside;
  }
  panelTitle(s) { return (s.attention ? '● ' : '') + s.title + (s.busy ? ' …' : ''); }

  openPanel(s, { preserveFocus } = {}) {
    if (this.panels.has(s.id)) { this.panels.get(s.id).panel.reveal(undefined, !!preserveFocus); return; }
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, this.panelTitle(s), { viewColumn: this.column(), preserveFocus: !!preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
    this.attachPanel(s, panel);
  }

  attachPanel(s, panel) {
    const entry = { panel, ready: false };
    this.panels.set(s.id, entry);
    s.paneled = true;
    panel.title = this.panelTitle(s);
    const icon = tabIcon(s.kind); if (icon) panel.iconPath = icon;
    this.mount(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, s.id));
    panel.onDidChangeViewState(() => { if (panel.visible && s.attention && !s.pending.size) { s.attention = false; this.sendTabs(); } });
    // closing the editor tab closes the session, unless the tab is going away for another reason (a move, or shutdown)
    panel.onDidDispose(() => { if (this.panels.get(s.id) !== entry) return; this.panels.delete(s.id); if (!this.closing && this.get(s.id) && s.location === 'editor') this.closeSession(s.id); });
    this.persist();
  }

  /** VS Code restoring an editor tab after a reload. The page remembers which session it showed. */
  deserializeWebviewPanel(panel, state) {
    const s = state && state.sid ? this.get(state.sid) : null;
    if (!s || s.location !== 'editor' || this.panels.has(s.id)) { panel.dispose(); return Promise.resolve(); }   // the session is gone, moved, or already has a tab
    this.attachPanel(s, panel);
    return Promise.resolve();
  }

  surface(s) { if (!s) return null; if (s.location === 'editor') { const e = this.panels.get(s.id); return e ? { webview: e.panel.webview, ready: e.ready } : null; } return this.sidebar.view ? { webview: this.sidebar.view.webview, ready: this.sidebar.ready } : null; }
  isVisible(s) { if (s.location === 'editor') { const e = this.panels.get(s.id); return !!(e && e.panel.visible); } return this.activeId === s.id && !!(this.sidebar.view && this.sidebar.view.visible !== false); }

  /** To every page: things that are not about one session. */
  raw(msg) {
    if (this.sidebar.ready && this.sidebar.view) this.sidebar.view.webview.postMessage(msg);
    for (const e of this.panels.values()) if (e.ready) e.panel.webview.postMessage(msg);
  }
  sendEvent(sid, ev) { const f = this.surface(this.get(sid)); if (f && f.ready) f.webview.postMessage({ type: 'event', sid, ev }); }
  sendTabs() {
    if (this.sidebar.ready && this.sidebar.view) this.sidebar.view.webview.postMessage({ type: 'tabs', tabs: this.sessions.filter((s) => s.location === 'sidebar').map((s) => s.toTab()), active: this.activeId });
    for (const [sid, e] of this.panels) {
      const s = this.get(sid); if (!s) continue;
      const title = this.panelTitle(s); if (e.panel.title !== title) e.panel.title = title;
      if (e.ready) e.panel.webview.postMessage({ type: 'tabs', tabs: [s.toTab()], active: sid, single: true });
    }
  }
  replay(s) {
    this.sendEvent(s.id, { kind: 'clear' });
    for (const ev of s.history) this.sendEvent(s.id, ev);
    this.sendEvent(s.id, { kind: 'busy', busy: s.busy });
    this.sendEvent(s.id, { kind: 'status', text: s.lastStatus });
    if (s.prefill) { this.sendEvent(s.id, { kind: 'fill', text: s.prefill }); s.prefill = ''; }
  }
  get(id) { return this.sessions.find((s) => s.id === id); }
  /** The session the user is looking at: the focused editor tab if there is one, otherwise the sidebar's active tab. */
  active() {
    for (const [sid, e] of this.panels) if (e.panel.active) return this.get(sid);
    return this.get(this.activeId) || null;
  }

  /** @param {string|null} from  the session id of the editor tab the message came from, or null for the sidebar */
  onMessage(msg, from) {
    const s = msg.sid ? this.get(msg.sid) : null;
    switch (msg.type) {
      case 'ready': {
        const mine = from ? this.sessions.filter((x) => x.id === from) : this.sessions.filter((x) => x.location === 'sidebar');
        if (from) { const e = this.panels.get(from); if (!e) return; e.ready = true; } else this.sidebar.ready = true;
        this.sendTabs();                 // no tabs are created for you: a fresh workspace starts empty
        const to = from ? this.panels.get(from).panel.webview : this.sidebar.view.webview;
        to.postMessage({ type: 'meter', meter: this.meter.state(), codex: this.meter.codexState() });
        for (const k of Object.keys(this.commands)) if (this.commands[k].length) to.postMessage({ type: 'commands', kind: k, list: this.commands[k] });
        this.loadCatalogs();
        for (const x of mine) { this.replay(x); this.voice.resend(x.id); }
        return;
      }
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
      case 'voiceStart': if (s) this.voice.start(s.id); return;
      case 'voiceStop': if (s) this.voice.stop(s.id); return;
      case 'voiceCancel': this.voice.cancel(); return;
      case 'activate': this.activate(msg.sid); return;
      case 'new': this.addSession(msg.kind); return;
      case 'close': this.closeSession(msg.sid); return;
      default: return;
    }
  }

  // ---- session management
  addSession(kind, { fill, location } = {}) {
    if (kind !== 'claude' && kind !== 'codex') return null;
    const n = ++this.counters[kind];
    const s = new Session(this, { kind, title: `${kind === 'claude' ? 'Claude' : 'Codex'} ${n}`, location: location || this.where() });
    this.sessions.push(s);
    if (fill) s.prefill = fill;
    if (s.location === 'editor') { this.openPanel(s); this.sendTabs(); return s; }     // its page asks for the replay when it is ready
    this.activeId = s.id;
    this.persist();
    this.sendTabs();
    this.replay(s);
    return s;
  }

  async pickNew() {
    const pick = await vscode.window.showQuickPick([{ label: 'Claude', description: 'New Claude Code tab', kind: 'claude' }, { label: 'Codex', description: 'New Codex tab', kind: 'codex' }], { placeHolder: 'New Perch tab' });
    return pick ? this.addSession(pick.kind) : null;
  }

  closeSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.sessions[i];
    this.voice.closed(id);
    s.dispose();
    this.sessions.splice(i, 1);
    const e = this.panels.get(id);
    if (e) { this.panels.delete(id); e.panel.dispose(); }
    if (this.activeId === id) { const side = this.sessions.filter((x) => x.location === 'sidebar'); const at = this.sessions.slice(0, i).filter((x) => x.location === 'sidebar').length; const next = side[Math.min(at, side.length - 1)]; this.activeId = next ? next.id : null; }
    if (!this.sessions.length) this.counters = { claude: 0, codex: 0 };   // nothing open, nothing to collide with: numbering starts over
    this.persist();
    this.sendTabs();
  }

  /** Bring a tab to the front, wherever it lives. */
  activate(id) {
    const s = this.get(id);
    if (!s) return;
    if (s.location === 'editor') { this.openPanel(s); if (s.attention && !s.pending.size) { s.attention = false; this.sendTabs(); } return; }
    this.activeId = id;
    if (s.attention && !s.pending.size) s.attention = false;
    this.persist();
    this.sendTabs();
  }

  /** Move a tab between the sidebar and the editor area. The session, its agent, and its transcript are untouched. */
  move(id, location) {
    const s = this.get(id);
    if (!s || s.location === location || (location !== 'editor' && location !== 'sidebar')) return;
    if (location === 'editor') {
      s.location = 'editor';
      if (this.activeId === id) { const side = this.sessions.filter((x) => x.location === 'sidebar'); this.activeId = side[0] ? side[0].id : null; }
      this.openPanel(s);
    } else {
      const e = this.panels.get(id);
      s.location = 'sidebar'; s.paneled = false;
      if (e) { this.panels.delete(id); e.panel.dispose(); }
      this.activeId = id;
    }
    this.persist();
    this.sendTabs();
    if (location === 'sidebar') { this.replay(s); if (this.sidebar.view && this.sidebar.view.show) this.sidebar.view.show(true); }
  }
  moveAll(location) { for (const s of this.sessions.slice()) this.move(s.id, location); }

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
    if (!pick.sid) { this.addSession(pick.kind, { fill: text, location: from.location }); return; }
    const to = this.get(pick.sid);
    this.activate(pick.sid);
    const f = this.surface(to);
    if (f && f.ready) this.sendEvent(pick.sid, { kind: 'fill', text }); else to.prefill = text;
    if (to.location === 'sidebar' && this.sidebar.view) this.sidebar.view.show(true);
  }

  dispose() {
    this.closing = true;             // the editor tabs are going away with the window, not being closed by the user
    clearTimeout(this.graceTimer);
    for (const s of this.sessions) s.dispose();
    this.meter.dispose();
    this.voice.dispose();
  }
}

function activate(context) {
  const perch = new PerchView(context);
  perch.meter.start();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('perch.main', perch, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, perch),
    vscode.commands.registerCommand('perch.new', () => perch.pickNew()),
    vscode.commands.registerCommand('perch.newClaude', () => perch.addSession('claude')),
    vscode.commands.registerCommand('perch.newCodex', () => perch.addSession('codex')),
    vscode.commands.registerCommand('perch.stop', () => { const s = perch.active(); if (s) s.interrupt(); }),
    vscode.commands.registerCommand('perch.closeTab', () => { const s = perch.active(); if (s) perch.closeSession(s.id); }),
    vscode.commands.registerCommand('perch.handoff', () => perch.handoff()),
    vscode.commands.registerCommand('perch.moveToEditor', () => { const s = perch.active(); if (s) perch.move(s.id, 'editor'); }),
    vscode.commands.registerCommand('perch.moveToSidebar', () => { const s = perch.active(); if (s) perch.move(s.id, 'sidebar'); }),
    vscode.commands.registerCommand('perch.moveAllToEditor', () => perch.moveAll('editor')),
    vscode.commands.registerCommand('perch.moveAllToSidebar', () => perch.moveAll('sidebar')),
    vscode.commands.registerCommand('perch.refreshModels', () => perch.loadCatalogs(true)),
    vscode.commands.registerCommand('perch.meter.refresh', () => perch.meter.poll()),
    vscode.commands.registerCommand('perch.meter.toggleBackend', () => perch.meter.toggleBackend()),
    vscode.commands.registerCommand('perch.meter.login', () => perch.meter.login()),
    vscode.commands.registerCommand('perch.voice.setup', async () => { if (perch.voice.getEngine().isInstalled()) { vscode.window.showInformationMessage('Perch: voice input is already set up here.'); return; } if (await perch.voice.setup(true)) vscode.window.showInformationMessage('Perch: voice input is ready.'); }),
    vscode.commands.registerCommand('perch.voice.toggle', () => { const s = perch.active(); if (s) perch.voice.start(s.id); }),
    vscode.commands.registerCommand('perch.voice.cancel', () => perch.voice.cancel()),
    vscode.commands.registerCommand('perch.voice.unload', () => { if (perch.voice.engine) perch.voice.engine.stop(); }),
    { dispose: () => perch.dispose() },
  );
  perch.start();
  return perch;   // exposed for tests
}

function deactivate() {}

module.exports = { activate, deactivate };
