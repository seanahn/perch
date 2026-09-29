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

  // vendor icons come from the installed vendor extensions: the glyph is preferred, tinted as the vendor tints it
  const html = v1.view.webview.html;
  assert(html.includes('.k.glyph.claude { -webkit-mask: url("vscode-resource://host/ext/anthropic.claude-code/resources/claude-logo.svg")'), 'claude glyph as a mask');
  assert(/\.k\.glyph\.claude \{[^}]*background-color: #D97757;/.test(html), 'claude glyph in its orange, not inverted on a tile');
  assert(/\.k\.glyph\.codex \{[^}]*blossom-white\.svg[^}]*background-color: currentColor;/.test(html), 'chatgpt glyph follows the theme text colour');
  assert(html.includes('<span class="k glyph claude"></span>') && !/<img/.test(html), 'glyphs replace the marketplace images');
  assert(/img-src x;/.test(html), 'CSP allows images from the webview origin only');
  assert.deepStrictEqual(v1.view.webview.options.localResourceRoots.map((u) => u.path), ['/ext/fennets.perch', '/ext/anthropic.claude-code', '/ext/openai.chatgpt']);
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

  // effort: claude changes live, codex is fixed at thread start, junk is rejected
  assert.deepStrictEqual(v1.lastTabs().tabs[0].efforts, ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(v1.lastTabs().tabs[1].efforts, ['', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.strictEqual(created[0].o.effort, undefined, 'no effort sent when the tab is on default');
  v1.fire({ type: 'setEffort', sid: c1, value: 'high' });
  assert.deepStrictEqual(created[0].efforts, ['high'], 'running claude tab changes effort live');
  v1.fire({ type: 'setEffort', sid: c1, value: '' });
  assert.deepStrictEqual(created[0].efforts, ['high', ''], 'default is a live change too');
  v1.fire({ type: 'setEffort', sid: c1, value: 'max' });
  v1.fire({ type: 'setEffort', sid: c1, value: 'ludicrous' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'invalid effort rejected');
  v1.fire({ type: 'setEffort', sid: c1, value: 'minimal' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'a codex-only level is rejected on a claude tab');
  v1.fire({ type: 'setEffort', sid: x1, value: 'low' });
  assert.deepStrictEqual(created[3].efforts, [], 'a started codex thread is not changed');
  assert(v1.events(x1).some((e) => e.kind === 'note' && /applies to a new Codex tab/.test(e.text)), 'and says so');
  v1.fire({ type: 'new', kind: 'codex' }); const x3 = v1.lastTabs().active;
  v1.fire({ type: 'setEffort', sid: x3, value: 'xhigh' });
  assert(v1.events(x3).some((e) => e.kind === 'status' && /idle · sandbox workspace-write · effort xhigh/.test(e.text)), 'idle status shows the chosen effort');
  v1.fire({ type: 'send', sid: x3, text: 'think hard' });
  assert.strictEqual(created[created.length - 1].o.reasoningEffort, 'xhigh', 'effort chosen before start is used');
  v1.fire({ type: 'close', sid: x3 });

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
  assert.strictEqual(rt.tabs[0].effort, 'max', 'effort restored');
  assert(v3.events(rt.tabs[0].id).some((e) => e.kind === 'note' && /resumed claude session/.test(e.text)), 'resume note shown');
  v3.fire({ type: 'send', sid: rt.tabs[0].id, text: 'continue' });
  assert.strictEqual(created[before].o.resume, 'sess-0', 'agent resumed with its saved session id');
  assert.strictEqual(created[before].o.effort, 'max', 'resumed agent starts at the saved effort');
  v3.fire({ type: 'new', kind: 'claude' });
  assert.strictEqual(v3.lastTabs().tabs.slice(-1)[0].title, 'Claude 3', 'numbering continues after reload');

  for (const x of v3.lastTabs().tabs) v3.fire({ type: 'close', sid: x.id });
  assert.deepStrictEqual(v3.lastTabs().tabs, [], 'closing every tab returns to empty');
  assert.strictEqual(v3.lastTabs().active, null);
  v3.fire({ type: 'new', kind: 'codex' });
  assert.strictEqual(v3.lastTabs().tabs[0].title, 'Codex 1', 'numbering starts over once nothing is open, without a reload');
  v3.fire({ type: 'close', sid: v3.lastTabs().tabs[0].id });
  const empty = install(again.memento._dump());
  const v4 = fakeView(); empty.registered['perch.main'].resolveWebviewView(v4.view); v4.fire({ type: 'ready' });
  assert.deepStrictEqual(v4.lastTabs().tabs, [], 'stays empty after reload; no tabs are re-created for you');
  v4.fire({ type: 'new', kind: 'claude' });
  assert.strictEqual(v4.lastTabs().tabs[0].title, 'Claude 1', 'numbering starts over after a reload too');

  // fallbacks: no glyph -> marketplace image; nothing usable or not installed -> letter
  const partial = install(undefined, { extensions: { 'anthropic.claude-code': { icon: 'resources/claude-logo.png' }, 'openai.chatgpt': {} } });
  const v5 = fakeView(); partial.registered['perch.main'].resolveWebviewView(v5.view);
  assert(v5.view.webview.html.includes('<img class="k img" data-kind="claude" alt="" src="vscode-resource://host/ext/anthropic.claude-code/resources/claude-logo.png">'), 'image when there is no glyph');
  assert(v5.view.webview.html.includes('<span class="k codex">X</span>'), 'letter when the extension ships no icon');
  assert(!/\.k\.glyph\.(claude|codex) \{/.test(v5.view.webview.html), 'no glyph rules without glyphs');
  assert.deepStrictEqual(v5.view.webview.options.localResourceRoots.map((u) => u.path), ['/ext/fennets.perch', '/ext/anthropic.claude-code']);
  const none = install(undefined, { extensions: {} });
  const v6 = fakeView(); none.registered['perch.main'].resolveWebviewView(v6.view);
  assert(!/<img/.test(v6.view.webview.html) && !/class="k glyph/.test(v6.view.webview.html), 'no vendor extensions, letters only');

  // settings give new tabs their default effort; an invalid setting is ignored
  const cfgd = install(undefined, { config: { 'claude.effort': 'high', 'codex.reasoningEffort': 'nonsense' } });
  const v7 = fakeView(); cfgd.registered['perch.main'].resolveWebviewView(v7.view); v7.fire({ type: 'ready' });
  v7.fire({ type: 'new', kind: 'claude' }); v7.fire({ type: 'new', kind: 'codex' });
  assert.deepStrictEqual(v7.lastTabs().tabs.map((x) => x.effort), ['high', ''], 'defaults from settings');
  v7.fire({ type: 'send', sid: v7.lastTabs().tabs[0].id, text: 'go' });
  assert.strictEqual(created[created.length - 1].o.effort, 'high', 'claude starts at the configured effort');

  console.log('HOST OK');
})().catch((e) => { console.error('HOST FAILED:', e.stack || e.message); process.exit(1); });
