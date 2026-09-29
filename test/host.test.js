'use strict';
// Host behaviour: tabs, isolation between sessions, replay after the page is recreated,
// permission prompts, and persistence across a window reload.
const assert = require('assert');
const { install, fakeView, created, flush } = require('./stubs');
const vals = (list) => list.map((o) => o.value);

(async () => {
  const { perch, registered, commands, memento, picks, cats, loads } = install();
  const p = registered['perch.main'];
  assert(p, 'single view registered');

  // first open in a fresh workspace: no tabs, no agents, nothing saved
  const v1 = fakeView(); p.resolveWebviewView(v1.view); v1.fire({ type: 'ready' });
  await flush();                                       // model catalogs load once the page is ready
  assert.deepStrictEqual(loads, { claude: 1, codex: 1 }, 'each agent is asked for its models once');

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
  assert.deepStrictEqual(v1.events(c1).filter((e) => e.kind === 'status').map((e) => e.text), ['idle'], 'status is state only: no mode, effort, or model repeated in it');
  assert.strictEqual(t.tabs[0].started, false);

  // model and effort choices come from the agents, and the default options say what they resolve to
  assert.deepStrictEqual(t.tabs[0].models.map((o) => [o.value, o.label]), [['', 'default · Opus 5.5'], ['opus', 'Opus 5.5'], ['fable', 'Fable 5.1'], ['haiku', 'Haiku 4.5'], ['claude-opus-4-6', 'Opus 4.6']]);
  assert.deepStrictEqual(t.tabs[1].models.map((o) => [o.value, o.label]), [['', 'default · GPT-5.6-Sol'], ['gpt-6-sol', 'GPT-6-Sol'], ['gpt-6-luna', 'GPT-6-Luna'], ['gpt-5.5', 'GPT-5.5']]);
  assert.deepStrictEqual(t.tabs[0].efforts.map((o) => [o.value, o.label])[0], ['', 'default']);
  assert.deepStrictEqual(t.tabs[1].efforts.map((o) => [o.value, o.label])[0], ['', 'default · ultra'], 'codex default effort comes from the user config');
  assert.strictEqual(t.tabs[1].approvals, 'never', 'codex approval policy is exposed for the tooltip');
  assert.strictEqual(t.tabs[0].approvals, '');

  // a message goes to its own tab only, and titles the tab
  v1.fire({ type: 'send', sid: c1, text: 'explain the  flush   bug in detail please' });
  assert.strictEqual(created.length, 1, 'one agent for one used tab');
  assert(v1.events(c1).some((e) => e.kind === 'text'), 'answer on the claude tab');
  assert(!v1.events(x1).some((e) => e.kind === 'text' || e.kind === 'user'), 'nothing leaked to the codex tab');
  t = v1.lastTabs();
  assert.strictEqual(t.tabs[0].title, 'explain the flush bug in det', 'tab titled from first message');
  assert.strictEqual(t.tabs[0].busy, false, 'busy cleared');
  assert.strictEqual(t.tabs[0].started, true);
  assert.strictEqual(t.tabs[0].actualModel, 'claude-opus-resolved', 'the model the agent reports is kept for the tooltip');
  assert.deepStrictEqual(v1.events(c1).filter((e) => e.kind === 'status').map((e) => e.text), ['idle', 'working', 'ready · fake', 'ready'], 'working while busy, ready after');
  assert.strictEqual(created[0].o.model, undefined, 'no model sent when the tab is on default');

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
  assert.deepStrictEqual(vals(v1.lastTabs().tabs[0].efforts), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepStrictEqual(vals(v1.lastTabs().tabs[1].efforts), ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'codex efforts come from its model, including ultra');
  assert.strictEqual(created[0].o.effort, undefined, 'no effort sent when the tab is on default');
  v1.fire({ type: 'setEffort', sid: c1, value: 'high' });
  assert.deepStrictEqual(created[0].efforts, ['high'], 'running claude tab changes effort live');
  v1.fire({ type: 'setEffort', sid: c1, value: '' });
  assert.deepStrictEqual(created[0].efforts, ['high', ''], 'default is a live change too');
  v1.fire({ type: 'setEffort', sid: c1, value: 'max' });
  v1.fire({ type: 'setEffort', sid: c1, value: 'ludicrous' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'invalid effort rejected');
  v1.fire({ type: 'setEffort', sid: c1, value: 'ultra' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'a codex-only level is rejected on a claude tab');
  assert(!v1.events(c1).some((e) => e.kind === 'status' && /effort|mode/.test(e.text)), 'a successful change is silent: the selector already shows it');
  v1.fire({ type: 'setEffort', sid: x1, value: 'low' });
  assert.deepStrictEqual(created[3].efforts, [], 'a started codex thread is not changed');
  assert(v1.events(x1).some((e) => e.kind === 'note' && /effort low applies to a new Codex tab/.test(e.text)), 'and says so');

  // model on claude: live, and the effort list follows the model
  v1.fire({ type: 'setModel', sid: c1, value: 'claude-opus-4-6' });
  assert.deepStrictEqual(created[0].models, ['claude-opus-4-6'], 'running claude tab changes model live');
  assert.deepStrictEqual(vals(v1.lastTabs().tabs[0].efforts), ['', 'low', 'medium', 'high', 'max'], 'this model has no xhigh');
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'effort kept when the new model accepts it');
  v1.fire({ type: 'setEffort', sid: c1, value: 'xhigh' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, 'max', 'an effort the selected model lacks is rejected');
  const nEff = created[0].efforts.length;
  v1.fire({ type: 'setModel', sid: c1, value: 'haiku' });
  assert.strictEqual(v1.lastTabs().tabs[0].effort, '', 'effort resets when the new model does not accept it');
  assert.deepStrictEqual(vals(v1.lastTabs().tabs[0].efforts), [''], 'a model without effort control offers only default');
  assert.deepStrictEqual(created[0].efforts.slice(nEff), [''], 'and the running session is told');
  v1.fire({ type: 'setModel', sid: c1, value: 'gpt-6-sol' });
  v1.fire({ type: 'setModel', sid: c1, value: 'made-up' });
  assert.strictEqual(v1.lastTabs().tabs[0].model, 'haiku', 'a model the agent does not list is rejected');
  v1.fire({ type: 'setModel', sid: c1, value: 'opus' }); v1.fire({ type: 'setEffort', sid: c1, value: 'max' });
  assert.deepStrictEqual(created[0].models, ['claude-opus-4-6', 'haiku', 'opus']);

  // model on codex: chosen before the first message, fixed after
  v1.fire({ type: 'new', kind: 'codex' }); const x3 = v1.lastTabs().active;
  v1.fire({ type: 'setEffort', sid: x3, value: 'ultra' });
  v1.fire({ type: 'setModel', sid: x3, value: 'gpt-5.5' });
  let tx = v1.lastTabs().tabs.find((x) => x.id === x3);
  assert.strictEqual(tx.effort, '', 'ultra is dropped because GPT-5.5 does not accept it');
  assert.deepStrictEqual(tx.efforts.map((o) => [o.value, o.label]), [['', 'default · medium'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh']], 'efforts and their default follow the model');
  v1.fire({ type: 'setEffort', sid: x3, value: 'xhigh' });
  assert.deepStrictEqual(v1.events(x3).filter((e) => e.kind === 'status').map((e) => e.text), ['idle'], 'choosing before start changes nothing in the status');
  v1.fire({ type: 'send', sid: x3, text: 'think hard' });
  assert.strictEqual(created[created.length - 1].o.model, 'gpt-5.5', 'model chosen before start is used');
  assert.strictEqual(created[created.length - 1].o.reasoningEffort, 'xhigh', 'effort chosen before start is used');
  v1.fire({ type: 'setModel', sid: x3, value: 'gpt-6-sol' });
  assert.deepStrictEqual(created[created.length - 1].models, [], 'a started codex thread keeps its model');
  assert(v1.events(x3).some((e) => e.kind === 'note' && /model gpt-6-sol applies to a new Codex tab/.test(e.text)), 'and says so');
  assert.strictEqual(v1.lastTabs().tabs.find((x) => x.id === x3).started, true, 'the page is told the thread has started');
  v1.fire({ type: 'close', sid: x3 });

  // refresh: the lists are re-read from the agents
  cats.codex = { defaultModel: { label: 'GPT-7', efforts: ['low'], defaultEffort: 'low' }, models: [{ value: 'gpt-7', label: 'GPT-7', description: '', efforts: ['low'], defaultEffort: 'low' }] };
  await commands['perch.refreshModels']();
  assert.deepStrictEqual(loads, { claude: 2, codex: 2 });
  assert.deepStrictEqual(v1.lastTabs().tabs[1].models.map((o) => o.label), ['default · GPT-7', 'GPT-7'], 'open tabs pick up the new list');
  cats.codex = new Error('cache unreadable'); cats.claude = new Error('cli missing');
  await commands['perch.refreshModels']();
  assert.deepStrictEqual(v1.lastTabs().tabs[1].models.map((o) => o.label), ['default · GPT-7', 'GPT-7'], 'a failed refresh keeps the last good list');

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
  assert.strictEqual(r.filter((e) => e.kind === 'status').pop().text, 'ready', 'status replayed');
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
  assert.strictEqual(rt.tabs[0].model, 'opus', 'model restored');
  assert.strictEqual(rt.tabs[0].started, false, 'a restored tab has no agent until it is used');
  assert(v3.events(rt.tabs[0].id).some((e) => e.kind === 'note' && /resumed claude session/.test(e.text)), 'resume note shown');
  v3.fire({ type: 'send', sid: rt.tabs[0].id, text: 'continue' });
  assert.strictEqual(created[before].o.resume, 'sess-0', 'agent resumed with its saved session id');
  assert.strictEqual(created[before].o.effort, 'max', 'resumed agent starts at the saved effort');
  assert.strictEqual(created[before].o.model, 'opus', 'and the saved model');
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

  // settings give new tabs their defaults; an effort the model lacks is dropped; an unlisted model is kept and labelled as itself
  const cfgd = install(undefined, { config: { 'claude.effort': 'high', 'claude.model': 'fable', 'codex.reasoningEffort': 'nonsense', 'codex.model': 'gpt-internal-9' } });
  const v7 = fakeView(); cfgd.registered['perch.main'].resolveWebviewView(v7.view); v7.fire({ type: 'ready' }); await flush();
  v7.fire({ type: 'new', kind: 'claude' }); v7.fire({ type: 'new', kind: 'codex' });
  assert.deepStrictEqual(v7.lastTabs().tabs.map((x) => [x.model, x.effort]), [['fable', 'high'], ['gpt-internal-9', '']], 'defaults from settings');
  assert.deepStrictEqual(v7.lastTabs().tabs[1].models.slice(-1)[0], { value: 'gpt-internal-9', label: 'gpt-internal-9', title: 'not in the agent\'s model list' });
  v7.fire({ type: 'send', sid: v7.lastTabs().tabs[0].id, text: 'go' });
  assert.deepStrictEqual([created[created.length - 1].o.model, created[created.length - 1].o.effort], ['fable', 'high'], 'claude starts with the configured model and effort');

  // an agent that cannot list its models: the tab still works, with the static effort list and only the default model
  const bare = install(undefined, { catalogs: { claude: new Error('no cli'), codex: null } });
  const v8 = fakeView(); bare.registered['perch.main'].resolveWebviewView(v8.view); v8.fire({ type: 'ready' }); await flush();
  v8.fire({ type: 'new', kind: 'claude' }); v8.fire({ type: 'new', kind: 'codex' });
  assert.deepStrictEqual(v8.lastTabs().tabs.map((x) => x.models), [[{ value: '', label: 'default', title: 'The model the agent picks by default' }], [{ value: '', label: 'default', title: 'The model the agent picks by default' }]]);
  assert.deepStrictEqual(vals(v8.lastTabs().tabs[0].efforts), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
  v8.fire({ type: 'setEffort', sid: v8.lastTabs().tabs[0].id, value: 'high' }); v8.fire({ type: 'send', sid: v8.lastTabs().tabs[0].id, text: 'go' });
  assert.strictEqual(created[created.length - 1].o.effort, 'high', 'effort still works without a catalog');

  // a catalog that arrives after a tab exists corrects that tab
  const late = install(undefined, { config: { 'claude.model': 'haiku', 'claude.effort': 'max' } });
  const v9 = fakeView(); late.registered['perch.main'].resolveWebviewView(v9.view); v9.fire({ type: 'ready' });
  v9.fire({ type: 'new', kind: 'claude' });                                   // the claude catalog has not loaded yet
  assert.strictEqual(v9.lastTabs().tabs[0].effort, 'max', 'accepted against the static list');
  await flush();
  assert.strictEqual(v9.lastTabs().tabs[0].effort, '', 'dropped once the catalog shows this model has no effort control');
  assert.strictEqual(late.memento._dump()['perch.sessions.v1'].sessions[0].effort, '', 'and the correction is saved');

  console.log('HOST OK');
})().catch((e) => { console.error('HOST FAILED:', e.stack || e.message); process.exit(1); });
