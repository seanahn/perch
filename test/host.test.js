'use strict';
// Host behaviour: tabs, isolation between sessions, replay after the page is recreated,
// permission prompts, and persistence across a window reload.
const assert = require('assert');
const { install, fakeView, created } = require('./stubs');

(async () => {
  const { perch, registered, commands, memento, picks } = install();
  const p = registered['perch.main'];
  assert(p, 'single view registered');

  // first open in a fresh workspace: no tabs, no agents, nothing saved
  const v1 = fakeView(); p.resolveWebviewView(v1.view); v1.fire({ type: 'ready' });
  let t = v1.lastTabs();
  assert.deepStrictEqual(t.tabs, [], 'starts with no tabs');
  assert.strictEqual(t.active, null, 'nothing active');
  assert.strictEqual(memento._dump()['perch.sessions.v1'], undefined, 'nothing persisted until the user opens a tab');
  commands['perch.stop'](); commands['perch.closeTab'](); await commands['perch.handoff']();   // all safe with no tabs
  v1.fire({ type: 'send', sid: 'nope', text: 'x' });                                          // unknown tab is ignored

  // the user opens one of each
  v1.fire({ type: 'new', kind: 'claude' });
  v1.fire({ type: 'new', kind: 'codex' });
  v1.fire({ type: 'new', kind: 'gemini' });                                                   // unknown kind is ignored
  t = v1.lastTabs();
  assert.deepStrictEqual(t.tabs.map((x) => x.title), ['Claude 1', 'Codex 1'], 'tabs opened on request');
  v1.fire({ type: 'activate', sid: t.tabs[0].id }); t = v1.lastTabs();
  assert.strictEqual(t.active, t.tabs[0].id, 'first tab active');
  assert.strictEqual(created.length, 0, 'agents start lazily, not on open');
  const [c1, x1] = t.tabs.map((x) => x.id);
  assert(v1.events(c1).some((e) => e.kind === 'status' && /idle · mode default/.test(e.text)), 'idle status shown, never "starting"');

  // a message goes to its own tab only, and titles the tab
  v1.fire({ type: 'send', sid: c1, text: 'explain the  flush   bug in detail please' });
  assert.strictEqual(created.length, 1, 'one agent for one used tab');
  assert(v1.events(c1).some((e) => e.kind === 'text'), 'answer on the claude tab');
  assert(!v1.events(x1).some((e) => e.kind === 'text' || e.kind === 'user'), 'nothing leaked to the codex tab');
  t = v1.lastTabs();
  assert.strictEqual(t.tabs[0].title, 'explain the flush bug in det', 'tab titled from first message');
  assert.strictEqual(t.tabs[0].busy, false, 'busy cleared');

  // multiple sessions of the same kind
  v1.fire({ type: 'new', kind: 'claude' });
  v1.fire({ type: 'new', kind: 'codex' });
  t = v1.lastTabs();
  assert.deepStrictEqual(t.tabs.map((x) => x.kind), ['claude', 'codex', 'claude', 'codex'], 'four tabs');
  assert.strictEqual(t.tabs[2].title, 'Claude 2'); assert.strictEqual(t.tabs[3].title, 'Codex 2');
  const [, , c2, x2] = t.tabs.map((x) => x.id);
  assert.strictEqual(t.active, x2, 'new tab becomes active');
  v1.fire({ type: 'send', sid: c2, text: 'second claude' });
  v1.fire({ type: 'send', sid: x2, text: 'second codex' });
  assert.strictEqual(created.length, 3, 'each used tab has its own agent');
  assert.deepStrictEqual(created[1].sent, ['second claude']); assert.deepStrictEqual(created[0].sent.length, 1, 'first agent untouched');
  assert.strictEqual(created[2].o.sandboxMode, 'workspace-write', 'codex tab got its sandbox');

  // mode: claude switches live, codex applies before start and notes after
  v1.fire({ type: 'setMode', sid: c1, value: 'plan' });
  assert.deepStrictEqual(created[0].modes, ['plan']);
  v1.fire({ type: 'setMode', sid: x1, value: 'read-only' });                 // x1 not started yet
  v1.fire({ type: 'send', sid: x1, text: 'hi' });
  assert.strictEqual(created[3].o.sandboxMode, 'read-only', 'mode chosen before start is used');
  v1.fire({ type: 'setMode', sid: x1, value: 'bogus' });
  assert.strictEqual(v1.lastTabs().tabs[1].mode, 'read-only', 'invalid mode rejected');

  // permission on a background tab raises attention; answering clears it
  v1.fire({ type: 'activate', sid: x1 });
  const s1 = perch.get(c1);
  const ans = new Promise((res) => s1.pending.set('p1', res)); s1.post({ kind: 'permission', id: 'p1', tool: 'Write', input: {} });
  assert.strictEqual(v1.lastTabs().tabs[0].attention, true, 'background prompt flags its tab');

  // page destroyed (view moved) and recreated: everything comes back
  v1.destroy();
  s1.post({ kind: 'text', text: 'arrived while detached' });
  const v2 = fakeView(); p.resolveWebviewView(v2.view); v2.fire({ type: 'ready' });
  assert.strictEqual(v2.lastTabs().tabs.length, 4, 'tabs replayed');
  assert.strictEqual(v2.lastTabs().active, x1, 'active tab kept');
  const r = v2.events(c1);
  assert.strictEqual(r[0].kind, 'clear');
  assert(r.some((e) => e.kind === 'text' && /detached/.test(e.text)), 'detached event replayed');
  assert(r.some((e) => e.kind === 'permission' && e.id === 'p1'), 'pending prompt replayed');
  assert(!r.some((e) => e.kind === 'delta'), 'deltas not replayed');
  assert.strictEqual(r.filter((e) => e.kind === 'status').pop().text, 'ready · fake', 'status replayed');
  v2.fire({ type: 'permission', sid: c1, id: 'p1', decision: 'allow' });
  assert.deepStrictEqual(await ans, { decision: 'allow' });
  assert.strictEqual(v2.lastTabs().tabs[0].attention, false, 'attention cleared');

  // stop and handoff act on the active tab
  commands['perch.stop'](); assert.strictEqual(created[3].interrupted, 1, 'stop hits the active tab agent');
  picks.push((i) => i.sid === c2); await commands['perch.handoff']();
  assert(v2.events(c2).some((e) => e.kind === 'fill' && e.text === 'answer to hi'), 'handoff fills the chosen tab');
  assert.strictEqual(v2.lastTabs().active, c2, 'handoff activates the target');
  picks.push((i) => i.kind === 'codex'); await commands['perch.handoff']();
  assert.strictEqual(v2.lastTabs().tabs.length, 5, 'handoff can open a new tab');

  // close: agent disposed, neighbour activated
  v2.fire({ type: 'close', sid: c2 });
  assert.strictEqual(created[1].disposed, true, 'closed tab disposes its agent');
  assert(!v2.lastTabs().tabs.some((x) => x.id === c2));

  // window reload: tabs restored, agents resume their own saved sessions
  const saved = memento._dump();
  const before = created.length;
  const again = install(saved);
  const q = again.registered['perch.main'];
  const v3 = fakeView(); q.resolveWebviewView(v3.view); v3.fire({ type: 'ready' });
  const rt = v3.lastTabs();
  assert.strictEqual(rt.tabs.length, 4, 'tabs restored after reload');
  assert.strictEqual(rt.tabs[0].title, 'explain the flush bug in det', 'titles restored');
  assert.strictEqual(rt.tabs[0].mode, 'plan', 'modes restored');
  assert(v3.events(rt.tabs[0].id).some((e) => e.kind === 'note' && /resumed claude session/.test(e.text)), 'resume note shown');
  v3.fire({ type: 'send', sid: rt.tabs[0].id, text: 'continue' });
  assert.strictEqual(created[before].o.resume, 'sess-0', 'agent resumed with its saved session id');
  v3.fire({ type: 'new', kind: 'claude' });
  assert.strictEqual(v3.lastTabs().tabs.slice(-1)[0].title, 'Claude 3', 'numbering continues after reload');

  for (const x of v3.lastTabs().tabs) v3.fire({ type: 'close', sid: x.id });
  assert.deepStrictEqual(v3.lastTabs().tabs, [], 'closing every tab returns to empty');
  assert.strictEqual(v3.lastTabs().active, null);
  const empty = install(again.memento._dump());
  const v4 = fakeView(); empty.registered['perch.main'].resolveWebviewView(v4.view); v4.fire({ type: 'ready' });
  assert.deepStrictEqual(v4.lastTabs().tabs, [], 'stays empty after reload; no tabs are re-created for you');
  v4.fire({ type: 'new', kind: 'claude' });
  assert.strictEqual(v4.lastTabs().tabs[0].title, 'Claude 4', 'numbering still continues');

  console.log('HOST OK');
})().catch((e) => { console.error('HOST FAILED:', e.stack || e.message); process.exit(1); });
