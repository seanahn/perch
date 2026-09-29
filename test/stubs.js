'use strict';
// Shared test stubs: a fake vscode module and fake agents, so host tests make no model calls.
const Module = require('module');
const origLoad = Module._load;

function makeMemento(initial) { const m = new Map(Object.entries(initial || {})); return { get: (k) => m.get(k), update: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); }, _dump: () => Object.fromEntries(m) }; }

const created = [];   // every FakeAgent constructed, in order
class FakeAgent {
  constructor(o) { this.o = o; this.emit = o.emit; this.lastAnswer = ''; this.sent = []; this.disposed = false; this.interrupted = 0; this.modes = []; created.push(this); }
  send(t) {
    this.sent.push(t);
    this.emit({ kind: 'user', text: t }); this.emit({ kind: 'busy', busy: true });
    this.emit({ kind: 'session', id: (this.o.resume || 'sess-' + created.indexOf(this)) });
    this.emit({ kind: 'status', text: 'ready · fake' });
    this.emit({ kind: 'delta', text: 'ans' });
    this.lastAnswer = 'answer to ' + t; this.emit({ kind: 'text', text: this.lastAnswer });
    this.emit({ kind: 'busy', busy: false });
  }
  interrupt() { this.interrupted++; }
  setPermissionMode(m) { this.modes.push(m); }
  dispose() { this.disposed = true; }
}

function install(state) {
  const registered = {}; const commands = {}; const picks = [];
  const vscodeStub = {
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (k) => ({ 'claude.permissionMode': 'default', 'codex.sandboxMode': 'workspace-write', 'codex.approvalPolicy': 'never' }[k] || '') }) },
    window: { registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; }, showInformationMessage() {}, showQuickPick: async (items) => picks.length ? items.find(picks.shift()) : undefined },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
  };
  Module._load = function (req, parent, isMain) {
    if (req === 'vscode') return vscodeStub;
    if (req === './claudeAgent') return { ClaudeAgent: FakeAgent };
    if (req === './codexAgent') return { CodexAgent: FakeAgent };
    return origLoad.call(this, req, parent, isMain);
  };
  delete require.cache[require.resolve('../src/extension.js')];
  const ext = require('../src/extension.js');
  const memento = makeMemento(state);
  const perch = ext.activate({ subscriptions: [], workspaceState: memento });
  return { perch, registered, commands, memento, picks };
}

function fakeView() {
  const got = []; let onMsg, onDispose;
  return { got, fire: (m) => onMsg(m), destroy: () => onDispose(),
    events: (sid) => got.filter((m) => m.type === 'event' && m.sid === sid).map((m) => m.ev),
    lastTabs: () => got.filter((m) => m.type === 'tabs').pop(),
    view: { webview: { options: {}, cspSource: 'x', html: '', postMessage: (m) => got.push(JSON.parse(JSON.stringify(m))), onDidReceiveMessage: (f) => { onMsg = f; } }, onDidDispose: (f) => { onDispose = f; }, show() {} } };
}

module.exports = { install, fakeView, created, FakeAgent };
