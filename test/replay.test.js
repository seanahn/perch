'use strict';
// Verifies the host replays transcript, status, and busy state when VS Code recreates the webview.
const Module = require('module');
const origLoad = Module._load;
const registered = {};
const vscodeStub = {
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (k) => ({ 'claude.permissionMode': 'default', 'codex.sandboxMode': 'read-only', 'codex.approvalPolicy': 'never' }[k] || '') }) },
  window: { registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; }, showInformationMessage() {} },
  commands: { registerCommand: () => ({ dispose() {} }) },
};
// Stub the agents so no model is called: the test is about the host, not the SDKs.
class FakeAgent { constructor(o) { this.emit = o.emit; this.lastAnswer = ''; setImmediate(() => this.emit({ kind: 'status', text: 'ready · fake' })); } send(t) { this.emit({ kind: 'user', text: t }); this.emit({ kind: 'busy', busy: true }); this.emit({ kind: 'delta', text: 'par' }); this.emit({ kind: 'text', text: 'partial answer' }); this.emit({ kind: 'busy', busy: false }); } interrupt() {} dispose() {} setPermissionMode() {} }
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscodeStub;
  if (req === './claudeAgent') return { ClaudeAgent: FakeAgent };
  if (req === './codexAgent') return { CodexAgent: FakeAgent };
  return origLoad.call(this, req, parent, isMain);
};
const ext = require('../src/extension.js');
ext.activate({ subscriptions: [] });

function fakeView() {
  const got = []; let onMsg, onDispose;
  return { got, fire: (m) => onMsg(m), destroy: () => onDispose(),
    view: { webview: { options: {}, cspSource: 'x', html: '', postMessage: (m) => got.push(m.ev), onDidReceiveMessage: (f) => { onMsg = f; } }, onDidDispose: (f) => { onDispose = f; }, show() {} } };
}
const assert = require('assert');
(async () => {
  const p = registered['perch.codex'];
  const v1 = fakeView(); p.resolveWebviewView(v1.view); v1.fire({ type: 'ready' });
  await new Promise((r) => setImmediate(r));
  v1.fire({ type: 'send', text: 'hello' });
  assert(v1.got.some((e) => e.kind === 'status' && e.text === 'ready · fake'), 'first webview got ready status');
  v1.destroy();                                   // view moved to the other sidebar
  p.post({ kind: 'text', text: 'arrived while no webview existed' });
  const v2 = fakeView(); p.resolveWebviewView(v2.view); v2.fire({ type: 'ready' });
  const kinds = v2.got.map((e) => e.kind);
  assert.strictEqual(kinds[0], 'clear', 'replay starts from a clean page');
  assert(v2.got.some((e) => e.kind === 'user' && e.text === 'hello'), 'user message replayed');
  assert(v2.got.some((e) => e.kind === 'text' && e.text === 'partial answer'), 'answer replayed');
  assert(v2.got.some((e) => e.kind === 'text' && /no webview existed/.test(e.text)), 'event emitted while detached is replayed');
  assert(!kinds.includes('delta'), 'deltas are not replayed');
  const st = v2.got.filter((e) => e.kind === 'status').pop();
  assert(st && st.text === 'ready · fake', 'status replayed, not stuck on starting');
  assert.strictEqual(v2.got.filter((e) => e.kind === 'busy').pop().busy, false, 'busy state replayed');

  // permission: pending prompts replay as prompts, answered ones as notes
  const c = registered['perch.claude'];
  const w1 = fakeView(); c.resolveWebviewView(w1.view); w1.fire({ type: 'ready' });
  const ans = new Promise((res) => c.pending.set('p1', res)); c.post({ kind: 'permission', id: 'p1', tool: 'Write', input: {} });
  w1.destroy(); const w2 = fakeView(); c.resolveWebviewView(w2.view); w2.fire({ type: 'ready' });
  assert(w2.got.some((e) => e.kind === 'permission' && e.id === 'p1'), 'pending prompt survives re-creation');
  w2.fire({ type: 'permission', id: 'p1', decision: 'allow' });
  assert.deepStrictEqual(await ans, { decision: 'allow' });
  w2.destroy(); const w3 = fakeView(); c.resolveWebviewView(w3.view); w3.fire({ type: 'ready' });
  assert(!w3.got.some((e) => e.kind === 'permission'), 'answered prompt is not replayed as a prompt');
  assert(w3.got.some((e) => e.kind === 'note' && e.text === 'Write: allow'), 'answered prompt replayed as a note');
  console.log('REPLAY OK');
})().catch((e) => { console.error('REPLAY FAILED:', e.message); process.exit(1); });
