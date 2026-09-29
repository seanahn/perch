'use strict';
// Shared test stubs: a fake vscode module and fake agents, so host tests make no model calls.
const Module = require('module');
const origLoad = Module._load;

function makeMemento(initial) { const m = new Map(Object.entries(initial || {})); return { get: (k) => m.get(k), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); }   /* like the real one, undefined deletes */, _dump: () => Object.fromEntries(m) }; }

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
// shaped like what the real agents report
const CATALOGS = {
  claude: { defaultModel: { label: 'Opus 5.5', efforts: ALL, defaultEffort: '' }, models: [
    { value: 'opus', label: 'Opus 5.5', description: 'For complex work', efforts: ALL, defaultEffort: '' },
    { value: 'fable', label: 'Fable 5.1', description: 'For your toughest challenges', efforts: ALL, defaultEffort: '' },
    { value: 'haiku', label: 'Haiku 4.5', description: 'Fastest', efforts: [], defaultEffort: '' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', description: '', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: '' },
  ], commands: [{ name: 'compact', description: 'Summarise the conversation so far', hint: '[instructions]' }, { name: 'clear', description: 'Start over', hint: '' }] },
  codex: { defaultModel: { label: 'GPT-5.6-Sol', efforts: [...ALL, 'ultra'], defaultEffort: 'ultra' }, models: [
    { value: 'gpt-6-sol', label: 'GPT-6-Sol', description: '', efforts: [...ALL, 'ultra'], defaultEffort: 'ultra' },
    { value: 'gpt-6-luna', label: 'GPT-6-Luna', description: '', efforts: ALL, defaultEffort: 'medium' },
    { value: 'gpt-5.5', label: 'GPT-5.5', description: '', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  ] },
};
const CODEX_LIMITS = (a, b) => [{ kind: 'session', label: '5h', name: '5h session', percent: a, resetsAt: new Date(Date.now() + 2 * 3600000 + 60000).toISOString(), model: null }, { kind: 'weekly_all', label: 'wk', name: 'Weekly', percent: b, resetsAt: new Date(Date.now() + 150 * 3600000).toISOString(), model: null }];
const flush = () => new Promise((r) => setImmediate(r));   // lets the async catalog load settle
const realMeter = origLoad.call(Module, require.resolve('../src/meter.js'), module, false);
const realModels = origLoad.call(Module, require.resolve('../src/models.js'), module, false);   // the loaders are faked; the pure helpers are real
const HOUR = 3600000;
const LIMITS = () => [{ kind: 'session', percent: 9, resetsAt: new Date(Date.now() + HOUR + 60000).toISOString(), model: null }, { kind: 'weekly_all', percent: 5, resetsAt: new Date(Date.now() + 150 * HOUR).toISOString(), model: null }];

const created = [];   // every FakeAgent constructed, in order
// Answers at once, unless the message starts with "hold": then it stays busy until finish() is called, which is how
// the tests get a turn that is still running. As Claude it queues further messages itself, as the real agent does.
class FakeAgent {
  constructor(o) { this.o = o; this.emit = o.emit; this.claude = !!o.askPermission; this.lastAnswer = ''; this.sent = []; this.disposed = false; this.interrupted = 0; this.modes = []; this.efforts = []; this.models = []; this.running = false; this.held = null; this.waiting = []; created.push(this); }
  send(t, shown) {
    this.sent.push(t);
    if (shown) { this.shownAs = this.shownAs || []; this.shownAs.push(shown); t = Object.assign(new String(t), { shown }); }
    if (this.running) { this.emit({ kind: 'user', text: t, queued: true }); this.waiting.push(t); return; }   // only Claude is ever sent a message mid-turn
    this.emit(Object.assign({ kind: 'user', text: t.shown ? t.shown.text : String(t), queued: false }, t.shown && t.shown.tag ? { tag: t.shown.tag } : {}));
    this.begin(String(t));
  }
  begin(t) {
    this.running = true;
    this.emit({ kind: 'busy', busy: true });
    this.emit({ kind: 'session', id: (this.o.resume || 'sess-' + created.indexOf(this)) });
    this.emit({ kind: 'status', text: 'ready · fake' });
    if (this.claude) this.emit({ kind: 'model', id: 'claude-' + (this.o.model || 'opus') + '-resolved' });
    if (/^hold/.test(t)) { this.held = t; return; }
    this.answer(t);
  }
  answer(t) {
    this.emit({ kind: 'delta', text: 'ans' });
    this.lastAnswer = 'answer to ' + t; this.emit({ kind: 'text', text: this.lastAnswer });
    if (this.claude) { this.emit({ kind: 'responded', at: Date.now() }); this.emit({ kind: 'context', percent: 2.4, used: 20361, max: 1000000, model: 'claude-' + (this.o.model || 'opus') + '-resolved' }); }
    this.held = null;
    if (this.waiting.length) { this.begin(this.waiting.shift()); return; }
    this.running = false;
    this.emit({ kind: 'busy', busy: false });
  }
  finish() { if (this.held) this.answer(this.held); }
  interrupt() { this.interrupted++; this.waiting = []; if (this.running) { this.running = false; this.held = null; this.emit({ kind: 'busy', busy: false }); } }
  setPermissionMode(m) { this.modes.push(m); }
  setEffort(e) { this.efforts.push(e); }
  setModel(m) { this.models.push(m); }
  dispose() { this.disposed = true; }
}

function install(state, { extensions, config, catalogs, meter, globals } = {}) {
  const cfgBox = Object.assign({}, config);                 // mutable, so a test can change a setting and fire the change event
  const cats = Object.assign({}, CATALOGS, catalogs);     // pass { claude: null } to simulate an agent that cannot list models
  const loads = { claude: 0, codex: 0 };
  const installed = extensions || {
    'anthropic.claude-code': { icon: 'resources/claude-logo.png', contributes: { viewsContainers: { activitybar: [{ id: 'c', icon: 'resources/claude-logo.svg' }] } } },
    'openai.chatgpt': { icon: 'resources/blossom.dark.png', contributes: { viewsContainers: { activitybar: [{ id: 'x', icon: 'resources/blossom-white.svg' }] } } },
  };
  const registered = {}; const commands = {}; const picks = [];
  // the machine the meter looks at: which backend is configured, what credentials exist, what the usage endpoint says
  const box = Object.assign({ bedrock: false, apiCreds: true, login: true, usage: { limits: LIMITS(), error: null }, cost: null, writes: [], fetches: 0, failWrite: null,
    codex: { limits: CODEX_LIMITS(4, 1), error: null, plan: 'plus', at: Date.now() - 60000 }, codexReads: 0 }, meter);
  const fakeMeter = {
    claudeDir: '/nonexistent/perch-test/.claude', settingsPath: '/nonexistent/perch-test/.claude/settings.json',
    bedrockConfigured: () => box.bedrock, apiCredentialsPresent: () => box.apiCreds, readCredentials: () => (box.login ? { accessToken: 't' } : null), envNote: () => '',
    fetchUsage: async () => { box.fetches++; return box.usage; },
    computeCostStats: () => { if (box.cost instanceof Error) throw box.cost; return box.cost; },
    promptCacheMinutes: (backend) => (box.cacheMinutes || ((backend || (box.bedrock ? 'api' : 'subscription')) === 'api' ? 5 : 60)),
    setBedrockSetting: (on, stash) => { if (box.failWrite) throw new Error(box.failWrite); box.writes.push(on); box.bedrock = on; stash.set('model', on ? undefined : 'stashed'); },
  };
  const ui = { bars: [], warnings: [], infos: [], errors: [], terminals: [], executed: [], answers: [], dialogs: [], picked: undefined, editor: undefined, panels: [], serializers: {}, listeners: { config: [], extensions: [] } };
  // an editor tab: a page of its own, which VS Code can hide, focus, close, and bring back after a reload
  const makePanel = (viewType, title, show, options) => {
    const got = []; let onMsg = () => {}; const gone = [], changed = [];
    const col = show && typeof show === 'object' ? show.viewColumn : show;
    const panel = {
      viewType, title, iconPath: undefined, options, disposed: false, reveals: 0,
      viewColumn: col === -2 ? (ui.panels.filter((x) => !x.disposed).length ? 2 : 2) : col, visible: true, active: !(show && show.preserveFocus),
      webview: { options: {}, cspSource: 'x', html: '', asWebviewUri: (u) => ({ toString: () => 'vscode-resource://host' + u.path }), postMessage: (m) => { got.push(JSON.parse(JSON.stringify(m))); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
      onDidDispose: (f) => { gone.push(f); return { dispose() {} }; },
      onDidChangeViewState: (f) => { changed.push(f); return { dispose() {} }; },
      reveal(_c, preserveFocus) { this.reveals++; this.visible = true; if (!preserveFocus) focus(this); for (const f of changed) f({ webviewPanel: this }); },
      dispose() { if (this.disposed) return; this.disposed = true; this.visible = false; this.active = false; for (const f of gone) f(); },
      // test helpers
      got, fire: (m) => onMsg(m),
      events: (sid) => got.filter((m) => m.type === 'event' && (!sid || m.sid === sid)).map((m) => m.ev),
      lastTabs: () => got.filter((m) => m.type === 'tabs').pop(),
      lastMeter: () => (got.filter((m) => m.type === 'meter').pop() || {}).meter,
      commands: (kind) => got.filter((m) => m.type === 'commands' && m.kind === kind).map((m) => m.list),
      show(visible, active) { this.visible = visible; if (active) focus(this); else this.active = false; for (const f of changed) f({ webviewPanel: this }); },
    };
    if (panel.active) focus(panel);
    ui.panels.push(panel);
    return panel;
  };
  const focus = (p) => { for (const x of ui.panels) x.active = false; p.active = true; };
  const say = (list) => (msg, ...rest) => { list.push(msg); const a = ui.answers.shift(); return Promise.resolve(a); };
  const vscodeStub = {
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (k) => { const all = Object.assign({ 'newTabs': 'sidebar', 'claude.permissionMode': 'default', 'codex.sandboxMode': 'workspace-write', 'codex.approvalPolicy': 'never' }, cfgBox); return k in all ? all[k] : ''; } }), onDidChangeConfiguration: (f) => { ui.listeners.config.push(f); return { dispose() {} }; } },
    window: {
      registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; },
      showInformationMessage: say(ui.infos), showWarningMessage: say(ui.warnings), showErrorMessage: say(ui.errors),
      showQuickPick: async (items) => picks.length ? items.find(picks.shift()) : undefined,
      createStatusBarItem: (id, align, prio) => { const it = { id, prio, text: '', tooltip: '', shown: false, disposed: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() { this.disposed = true; this.shown = false; } }; ui.bars.push(it); return it; },
      showOpenDialog: async (o) => { ui.dialogs.push(o); return ui.picked; },
      createWebviewPanel: (viewType, title, show, options) => makePanel(viewType, title, show, options),
      registerWebviewPanelSerializer: (viewType, z) => { ui.serializers[viewType] = z; return { dispose() {} }; },
      get activeTextEditor() { return ui.editor; },
      createTerminal: (o) => { const t = { o, sent: [], show() {}, sendText(x) { this.sent.push(x); } }; ui.terminals.push(t); return t; },
    },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async (id) => { ui.executed.push(id); } },
    extensions: {
      getExtension: (id) => { const e = installed[String(id).toLowerCase()]; const root = e && e.__root ? e.__root : '/ext/' + id; return e ? { extensionUri: { path: root, fsPath: root }, extensionPath: root, packageJSON: e } : undefined; },
      onDidChange: (f) => { ui.listeners.extensions.push(f); return { dispose() {} }; },
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v || ''; } appendMarkdown(v) { this.value += v; return this; } appendCodeblock(v) { this.value += '\n```\n' + v + '\n```\n'; return this; } },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/'), fsPath: [base.path, ...parts].join('/') }) },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeStub;
    if (req === './claudeAgent') return { ClaudeAgent: FakeAgent };
    if (req === './codexAgent') return { CodexAgent: FakeAgent };
    if (req === './meter') return Object.assign({}, realMeter, { createMeter: () => fakeMeter });   // real formatting and summary, fake machine
    if (req === './codexMeter') return { readCodexUsage: () => { box.codexReads++; if (box.codex instanceof Error) throw box.codex; return box.codex; } };
    if (req === './models') return { normalizeCommands: realModels.normalizeCommands, loadCodexModels: () => { loads.codex++; if (cats.codex instanceof Error) throw cats.codex; return cats.codex; }, loadClaudeModels: async () => { loads.claude++; if (cats.claude instanceof Error) throw cats.claude; return cats.claude; } };
    return origLoad.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve('../src/extension.js')];
  delete require.cache[require.resolve('../src/meterHost.js')];
  const ext = require('../src/extension.js');
  const memento = makeMemento(state);
  const globalState = makeMemento(globals);
  const perch = ext.activate({ subscriptions: [], workspaceState: memento, globalState, extensionUri: { path: '/ext/fennets.perch' } });
  const changeConfig = (patch) => { Object.assign(cfgBox, patch); for (const f of ui.listeners.config) f({ affectsConfiguration: (sec) => Object.keys(patch).some((k) => ('perch.' + k).startsWith(sec)) }); };
  const restorePanel = (sid, title) => { const p = makePanel('perch.session', title || 'restored', { viewColumn: 2, preserveFocus: true }, {}); ui.serializers['perch.session'].deserializeWebviewPanel(p, sid === undefined ? undefined : { sid }); return p; };
  const changeExtensions = (patch) => { for (const [k, v] of Object.entries(patch)) { if (v) installed[k] = v; else delete installed[k]; } for (const f of ui.listeners.extensions) f(); };
  return { perch, registered, commands, memento, globalState, picks, cats, loads, box, ui, changeConfig, changeExtensions, restorePanel };
}

function fakeView() {
  const got = []; let onMsg, onDispose;
  return { got, fire: (m) => onMsg(m), destroy: () => onDispose(),
    events: (sid) => got.filter((m) => m.type === 'event' && m.sid === sid).map((m) => m.ev),
    lastTabs: () => got.filter((m) => m.type === 'tabs').pop(),
    lastMeter: () => (got.filter((m) => m.type === 'meter').pop() || {}).meter,
    lastCodex: () => (got.filter((m) => m.type === 'meter').pop() || {}).codex,
    commands: (kind) => got.filter((m) => m.type === 'commands' && m.kind === kind).map((m) => m.list),
    tab: (id) => (got.filter((m) => m.type === 'tabs').pop().tabs.find((x) => x.id === id)),
    view: { webview: { options: {}, cspSource: 'x', html: '', asWebviewUri: (u) => ({ toString: () => 'vscode-resource://host' + u.path }), postMessage: (m) => got.push(JSON.parse(JSON.stringify(m))), onDidReceiveMessage: (f) => { onMsg = f; } }, onDidDispose: (f) => { onDispose = f; }, show() {} } };
}

module.exports = { install, fakeView, created, FakeAgent, flush, CATALOGS, CODEX_LIMITS };
