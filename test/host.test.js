'use strict';
process.env.PERCH_RESTORE_GRACE_MS = '60';   // the wait for VS Code to bring back editor tabs, shortened
// Host behaviour: tabs, isolation between sessions, replay after the page is recreated,
// permission prompts, and persistence across a window reload.
const assert = require('assert');
const { install, fakeView, created, engines, flush, CODEX_LIMITS, knobs } = require('./stubs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vals = (list) => list.map((o) => o.value);
const LIM = (pct) => [{ kind: 'session', percent: pct, resetsAt: new Date(Date.now() + 3660000).toISOString(), model: null }];

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
  assert(/img-src x data:;/.test(html), 'CSP allows images from the webview origin, and those the user pastes, which the page holds as data');
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
  assert.deepStrictEqual(created[3].efforts, ['low'], 'a started codex thread changes too, from its next turn');
  assert(!v1.events(x1).some((e) => e.kind === 'note' && /applies to a new Codex tab/.test(e.text)), 'and nothing need be said');

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
  assert.deepStrictEqual(created[created.length - 1].models, ['gpt-6-sol'], 'a started codex thread takes a new model');
  v1.fire({ type: 'setMode', sid: x3, value: 'read-only' }); v1.fire({ type: 'setMode', sid: x3, value: 'default' });
  assert.deepStrictEqual(created[created.length - 1].modes, ['read-only'], 'and a new sandbox; a Claude mode is not one');
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
  assert(!/<img/.test(v6.view.webview.html) && !/class="k glyph (claude|codex)/.test(v6.view.webview.html), 'no vendor extensions, letters only; the LLM gateway glyph is its own');

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

  // ======================================================================== Claude usage and backend (merged from AI Meter)
  {
    const m = install();                                                      // subscription, logged in, AI Meter not installed
    await flush();
    assert.deepStrictEqual(m.ui.bars, [], 'perch puts nothing in the status bar: the gauge is the footer of each tab');
    assert.strictEqual(m.globalState._dump()['perch.meter.limits'].length, 2, 'the reading is cached for the next reload');
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    let st = v.lastMeter();
    assert.deepStrictEqual([st.backend, st.backendLabel, st.mode, st.level, st.action, st.segments.length], ['subscription', 'sub', 'subscription', 'ok', 'refresh', 2], 'the page is given the gauge as soon as it is ready');
    assert(/^1\.0h 91% 6\.\dd 95%$/.test(st.text), st.text);

    // refresh from the page and from the command
    const f0 = m.box.fetches;
    m.box.usage = { limits: [{ kind: 'session', percent: 93, resetsAt: new Date(Date.now() + 3660000).toISOString(), model: null }], error: null };
    v.fire({ type: 'meterRefresh' }); await flush();
    assert.strictEqual(m.box.fetches, f0 + 1);
    st = v.lastMeter(); assert.deepStrictEqual([st.text, st.level], ['1.0h 7%', 'error'], 'a limit running low turns red');
    await m.commands['perch.meter.refresh'](); assert.strictEqual(m.box.fetches, f0 + 2);
    m.box.usage = { limits: null, error: 'network' }; v.fire({ type: 'meterRefresh' }); await flush();
    assert.deepStrictEqual([v.lastMeter().text, v.lastMeter().error], ['1.0h 7%', 'network'], 'a failed poll keeps the last good reading');

    // switching backend: two claude tabs, one running and one not; a codex tab is unaffected
    v.fire({ type: 'new', kind: 'claude' }); const run = v.lastTabs().active; v.fire({ type: 'send', sid: run, text: 'hi' });
    v.fire({ type: 'new', kind: 'claude' }); const idle = v.lastTabs().active;
    v.fire({ type: 'new', kind: 'codex' }); const cx = v.lastTabs().active; v.fire({ type: 'send', sid: cx, text: 'hi' });
    assert.strictEqual(v.lastTabs().tabs.find((x) => x.id === run).backend, 'subscription', 'a running tab knows the backend it started on');
    assert.strictEqual(v.lastTabs().tabs.find((x) => x.id === idle).backend, '', 'a tab that has not started has none yet');
    const loads0 = m.loads.claude; m.box.cost = { session: { tokens: 1200, cost: 0.5 }, today: { tokens: 5.2e6, cost: 18.94 }, latestModel: 'us.anthropic.claude-opus-5', days: [{ label: 'Mon', tokens: 1, cost: 1 }], models: new Map() };
    v.fire({ type: 'meterToggle' }); await flush(); await flush();
    assert.deepStrictEqual(m.box.writes, [true], 'the settings file is written once');
    assert.strictEqual(m.globalState._dump()['perch.meter.stash.model'], undefined, 'model pins go through the stash');
    st = v.lastMeter();
    assert.deepStrictEqual([st.backend, st.backendLabel, st.mode, st.text], ['api', 'API', 'cost', 'opus-5 5.2M $18.9'], 'auto mode follows the backend into cost mode');
    assert(/from now on\. Open tabs continue on it from their next message; a tab in the middle of a turn, after that turn\./.test(m.ui.infos.pop()));
    assert.strictEqual(m.loads.claude, loads0 + 1, 'the model list is re-read, because models differ by backend');
    // the tab that had run is moved: its process ends, the session stays, and the next message resumes it on the new backend
    const runAgent = created.filter((a) => a.claude).pop(), runSession = 'sess-' + created.indexOf(runAgent);
    assert(v.events(run).some((e) => e.kind === 'note' && /^Claude backend is now API \/ Bedrock\. This tab continues on it from the next message; the prompt cache starts over\.$/.test(e.text)), 'an idle tab is moved at once, and told');
    assert.deepStrictEqual([runAgent.disposed, v.lastTabs().tabs.find((x) => x.id === run).backend, v.lastTabs().tabs.find((x) => x.id === run).started], [true, '', false], 'its process is ended; the tab stays');
    assert(!v.events(idle).some((e) => e.kind === 'note' && /backend/.test(e.text)), 'a tab that has not started is not');
    assert(!v.events(cx).some((e) => e.kind === 'note' && /backend/.test(e.text)), 'nor is a codex tab');
    v.fire({ type: 'send', sid: run, text: 'more' });
    const resumed = created.filter((a) => a.claude).pop();
    assert.deepStrictEqual([resumed !== runAgent, resumed.o.resume, v.lastTabs().tabs.find((x) => x.id === run).backend], [true, runSession, 'api'], 'the same session, resumed on the new backend');
    v.fire({ type: 'send', sid: idle, text: 'go' });
    assert.strictEqual(v.lastTabs().tabs.find((x) => x.id === idle).backend, 'api', 'the tab started after the switch is on the new backend');

    // and back, on a machine with no subscription login: the login is offered; both tabs, now on API, are moved again
    m.box.login = false; m.ui.answers.push('Log In');
    await m.commands['perch.meter.toggleBackend'](); await flush(); await flush();
    assert.deepStrictEqual(m.box.writes, [true, false]);
    assert(/has no subscription login yet/.test(m.ui.infos.pop()));
    assert.deepStrictEqual(m.ui.executed, ['claude-vscode.editor.openLast'], 'login opens the Claude Code panel when that extension is installed');
    assert.strictEqual(v.lastMeter().backend, 'subscription');
    assert.strictEqual(v.events(idle).filter((e) => e.kind === 'note' && /backend is now subscription/.test(e.text)).length, 1);
    assert.strictEqual(v.events(run).filter((e) => e.kind === 'note' && /backend is now/.test(e.text)).length, 2, 'moved each time the backend changes');
    assert.deepStrictEqual([resumed.disposed, v.lastTabs().tabs.find((x) => x.id === run).started], [true, false]);

    // no API credentials: a modal first, and cancelling writes nothing
    m.box.apiCreds = false; m.box.login = true;
    v.fire({ type: 'meterToggle' }); await flush();
    assert(/No Bedrock or API credentials found/.test(m.ui.warnings.pop())); assert.deepStrictEqual(m.box.writes, [true, false], 'cancelled: nothing written');
    m.ui.answers.push('Switch Anyway'); v.fire({ type: 'meterToggle' }); await flush(); await flush();
    assert.deepStrictEqual(m.box.writes, [true, false, true]);
    assert.strictEqual(v.lastMeter().backendWarn, true, 'the switch stays highlighted until credentials exist');

    // a settings file that cannot be written: say so, change nothing
    m.box.failWrite = 'EACCES'; m.box.apiCreds = true;
    v.fire({ type: 'meterToggle' }); await flush();
    assert(/could not update .*settings\.json\. EACCES/.test(m.ui.errors.pop())); assert.strictEqual(v.lastMeter().backend, 'api');
    m.box.failWrite = null;

    // settings: mode pinned, display, thresholds
    m.changeConfig({ 'meter.mode': 'subscription', 'meter.display': 'used' }); await flush();
    m.box.usage = { limits: LIM(30), error: null }; v.fire({ type: 'meterRefresh' }); await flush();
    assert.deepStrictEqual([v.lastMeter().mode, v.lastMeter().text, v.lastMeter().backend], ['subscription', '1.0h 30%', 'api'], 'a pinned mode does not follow the backend');
    m.changeConfig({ 'meter.warnBelow': 80 }); await flush();
    assert.strictEqual(v.lastMeter().level, 'warn');

    m.perch.dispose();
  }
  {
    // the standalone AI Meter extension may be installed as well: perch's gauge is in its tabs, and the status bar is AI Meter's alone
    const m = install(undefined, { extensions: { 'seanahn.ai-meter': { icon: 'x.png' } } }); await flush();
    assert.deepStrictEqual(m.ui.bars, []);
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.strictEqual(v.lastMeter().segments.length, 2);
  }
  {
    // never logged in
    const m = install(undefined, { meter: { usage: { limits: null, error: 'no-credentials' } }, extensions: {} }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([v.lastMeter().text, v.lastMeter().action, v.lastMeter().level], ['—', 'login', 'none']);
    v.fire({ type: 'meterLogin' }); await flush();
    assert.strictEqual(m.ui.terminals.length <= 1, true);                     // a terminal only if a claude CLI exists on this machine
  }
  {
    // the cached reading is shown before the first poll returns
    const cached = LIM(40);
    const m = install(undefined, { globals: { 'perch.meter.limits': cached, 'perch.meter.limits.at': 123 }, meter: { usage: { limits: null, error: 'network' } } });
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' });
    assert(/1\.0h 60%/.test(v.lastMeter().text), 'shown at once, from the cache');
    await flush(); assert(/1\.0h 60%/.test(v.lastMeter().text), 'and kept when the poll fails');
  }

  {
    // rate limited: keep the reading, stop asking for a while, and never fast-retry
    const m = install(undefined, { meter: { usage: { limits: null, error: 'rate-limited', retryAfterMs: 0 } }, extensions: {} }); await flush();
    const h = m.perch.meter;
    assert.strictEqual(h.retryTimer, null, 'no 15-second retry against an endpoint that said to slow down');
    assert(h.backoffUntil - Date.now() > 55000 && h.backoffMs === 60000, 'at least a minute of quiet');
    assert.strictEqual(m.box.fetches, 1);
    await h.poll(); await h.poll();
    assert.strictEqual(m.box.fetches, 1, 'polls inside the quiet period make no request');
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'meterRefresh' }); await flush();
    assert.strictEqual(m.box.fetches, 1, 'not even when clicked');
    assert.deepStrictEqual([v.lastMeter().error, v.lastMeter().text], ['rate-limited', '—']);
    h.backoffUntil = 0; m.box.usage = { limits: null, error: 'rate-limited', retryAfterMs: 300000 }; await h.poll();
    assert.deepStrictEqual([m.box.fetches, h.backoffMs], [2, 300000], 'Retry-After is honoured when it asks for longer');
    h.backoffUntil = 0; m.box.usage = { limits: null, error: 'rate-limited', retryAfterMs: 0 }; await h.poll();
    assert.strictEqual(h.backoffMs, 600000, 'and the quiet period doubles on a repeat');
    for (let i = 0; i < 5; i++) { h.backoffUntil = 0; await h.poll(); }
    assert.strictEqual(h.backoffMs, 30 * 60000, 'up to half an hour');
    h.backoffUntil = 0; m.box.usage = { limits: LIM(10), error: null }; await h.poll();
    assert.deepStrictEqual([h.backoffMs, h.backoffUntil, v.lastMeter().text, v.lastMeter().stale], [0, 0, '1.0h 90%', undefined], 'a success clears it');
    m.box.usage = { limits: null, error: 'rate-limited' }; await h.poll();
    assert.deepStrictEqual([v.lastMeter().text, v.lastMeter().stale, h.retryTimer], ['1.0h 90%', true, null], 'a later rate limit keeps the reading and marks it stale');
    m.perch.dispose();
  }
  {
    // any other failure with nothing cached: the fast retry still applies
    const m = install(undefined, { meter: { usage: { limits: null, error: 'network' } }, extensions: {} }); await flush();
    assert.notStrictEqual(m.perch.meter.retryTimer, null);
    m.box.usage = { limits: LIM(10), error: null }; await m.perch.meter.poll();
    assert.strictEqual(m.perch.meter.retryTimer, null, 'and stops at the first success');
    m.perch.dispose();
  }

  // ======================================================================== Codex plan usage, for the footer of a Codex tab
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    let cx = v.lastCodex();
    assert.deepStrictEqual([cx.vendor, cx.plan, cx.asOf, cx.level, cx.action], ['Codex', 'plus', true, 'ok', 'refresh'], 'the page gets both readings when it is ready');
    assert(/^2\.0h 96% 6\.\dd 99%$/.test(cx.text), cx.text);
    assert.strictEqual(cx.lines[0], 'Codex usage, percent remaining');
    assert.strictEqual(v.lastMeter().vendor, 'Claude');

    // refreshing Codex usage reads a file; it never touches Claude's rate-limited endpoint
    const f0 = m.box.fetches, r0 = m.box.codexReads;
    m.box.codex = { limits: CODEX_LIMITS(80, 93), error: null, plan: 'pro', at: Date.now() };
    v.fire({ type: 'meterRefresh', vendor: 'codex' }); await flush();
    assert.deepStrictEqual([m.box.fetches, m.box.codexReads > r0], [f0, true]);
    cx = v.lastCodex();
    assert.deepStrictEqual([cx.segments.map((x) => x.level), cx.level, cx.plan], [['warn', 'error'], 'error', 'pro'], 'the same thresholds as Claude');
    v.fire({ type: 'meterRefresh', vendor: 'claude' }); await flush(); assert.strictEqual(m.box.fetches, f0 + 1);
    v.fire({ type: 'meterRefresh' }); await flush(); assert.strictEqual(m.box.fetches, f0 + 2, 'with no vendor named, Claude, as before');

    // a Codex turn that finishes has just recorded fresh limits; a Claude turn has not
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    m.box.codex = { limits: CODEX_LIMITS(81, 93), error: null, plan: 'pro', at: Date.now() };
    const r1 = m.box.codexReads; v.fire({ type: 'send', sid: c, text: 'hi claude' }); await wait(500);
    const afterClaude = m.box.codexReads;
    v.fire({ type: 'send', sid: x, text: 'hi codex' }); await wait(500);
    assert(m.box.codexReads > afterClaude, 'read again after the Codex turn');
    assert(/^2\.0h 19% /.test(v.lastCodex().text), 'and the page has the new figure');

    // never used, and unreadable
    m.box.codex = { limits: null, error: 'no-codex-data' }; v.fire({ type: 'meterRefresh', vendor: 'codex' }); await flush();
    assert.deepStrictEqual([v.lastCodex().text, v.lastCodex().action, v.lastCodex().plan], ['—', 'refresh', '']); assert(/no Codex session on this machine/.test(v.lastCodex().lines[0]));
    m.box.codex = new Error('EACCES'); v.fire({ type: 'meterRefresh', vendor: 'codex' }); await flush();
    assert.strictEqual(v.lastCodex().error, 'codex-scan', 'a reader that throws is an error in the footer, not a crash');
    assert.strictEqual(v.lastMeter().vendor, 'Claude', 'and Claude\'s reading is unaffected');
    m.perch.dispose();
  }

  // ======================================================================== the composer's data
  {
    const m = install(); const pv = m.registered['perch.main'];
    const v = fakeView(); pv.resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.strictEqual(v.lastTabs().ui, undefined, 'there is no selector row to open or close any more');
    assert.strictEqual(m.commands['perch.toggleSettings'], undefined);

    // slash commands arrive with the model list, before any tab has started
    assert.deepStrictEqual(v.commands('claude'), [[{ name: 'clear', description: 'Start over', hint: '' }, { name: 'compact', description: 'Summarise the conversation so far', hint: '[instructions]' }]], 'sorted, hints kept');
    assert.deepStrictEqual(v.commands('codex'), [], 'codex has none');

    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    assert.deepStrictEqual([v.tab(c).context, v.tab(c).cache, v.tab(c).queued], [null, { minutes: 60, since: 0 }, 0], 'before the first message: no context figure, and the cache lifetime a new session would get');
    const t0 = Date.now(); v.fire({ type: 'send', sid: c, text: 'hello' });
    assert.deepStrictEqual(v.tab(c).context, { percent: 2, used: 20361, max: 1000000 }, 'context usage, rounded');
    created[created.length - 1].emit({ kind: 'context', percent: 2.4, used: 20361, max: 1000000, model: 'claude-fable-5-1' });
    assert.strictEqual(v.tab(c).actualModel, 'claude-fable-5-1', 'the context report names the model really running');
    assert(v.tab(c).cache.since >= t0 && v.tab(c).cache.minutes === 60, 'the cache is warm from the last answer');
    const agent = created[created.length - 1];
    agent.emit({ kind: 'commands', list: [{ name: 'compact', description: 'Summarise   the\nconversation so far', argumentHint: '[instructions]' }, { name: 'clear', description: 'Start over' }, { name: '__internal', description: 'x' }, { name: 'clear', description: 'dup' }] });
    assert.strictEqual(v.commands('claude').length, 1, 'the same list from a running session is not sent again');
    agent.emit({ kind: 'commands', list: [{ name: 'review', description: 'Review', argumentHint: '' }] });
    assert.deepStrictEqual(v.commands('claude').pop(), [{ name: 'review', description: 'Review', hint: '' }], 'a changed list is');
    agent.emit({ kind: 'context', percent: 140, used: 1, max: 1 }); assert.strictEqual(v.tab(c).context.percent, 100, 'clamped');

    // on API or Bedrock the cache lasts five minutes; a running tab keeps the lifetime of the backend it started on
    m.box.bedrock = true;
    v.fire({ type: 'new', kind: 'claude' }); const c2 = v.lastTabs().active;
    assert.deepStrictEqual([v.tab(c2).cache.minutes, v.tab(c).cache.minutes], [5, 60]);
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    assert.deepStrictEqual([v.tab(x).context, v.tab(x).cache], [null, null], 'codex reports neither');
    m.box.bedrock = false;

    // a page that reconnects gets the current command list again
    const v2 = fakeView(); pv.resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v2.commands('claude').pop().map((k) => k.name), ['review']);

    // + mentions files by workspace-relative path; a file outside the workspace keeps its full path
    const path = require('path');
    m.ui.picked = [{ fsPath: path.join(process.cwd(), 'src', 'a.js') }, { fsPath: '/elsewhere/b c.txt' }];
    v2.fire({ type: 'attach', sid: c }); await flush();
    assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'insert').pop(), { kind: 'insert', text: '@' + path.join('src', 'a.js') + ' @/elsewhere/b c.txt ' });
    assert.deepStrictEqual([m.ui.dialogs[0].canSelectMany, m.ui.dialogs[0].canSelectFolders], [true, false]);
    m.ui.picked = undefined; const n = v2.events(c).length;
    v2.fire({ type: 'attach', sid: c }); await flush(); assert.strictEqual(v2.events(c).length, n, 'cancelling the dialog inserts nothing');
    v2.fire({ type: 'attach', sid: 'nope' }); await flush();

    // ---- queueing. Claude queues a message sent mid-turn itself.
    v2.fire({ type: 'send', sid: c, text: 'hold on' });
    v2.fire({ type: 'send', sid: c, text: 'and then this' });
    assert.deepStrictEqual(agent.sent.slice(-2), ['hold on', 'and then this'], 'passed straight to the agent');
    assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'user').slice(-2).map((e) => [e.text, e.queued]), [['hold on', false], ['and then this', true]]);
    assert.strictEqual(v2.tab(c).busy, true);
    agent.finish(); await flush();
    assert.deepStrictEqual([v2.tab(c).busy, agent.lastAnswer], [false, 'answer to and then this'], 'the queued message ran as soon as the turn ended');

    // Codex takes one turn at a time, so the queue is kept by perch
    const before = v2.events(x).length;                                       // the replay already told the page this tab is idle
    v2.fire({ type: 'send', sid: x, text: 'hold 1' }); const cx = created[created.length - 1];
    v2.fire({ type: 'send', sid: x, text: 'second' }); v2.fire({ type: 'send', sid: x, text: 'hold 3' }); v2.fire({ type: 'send', sid: x, text: '   ' });
    assert.deepStrictEqual(cx.sent, ['hold 1'], 'nothing reaches a busy codex agent');
    assert.deepStrictEqual([v2.tab(x).queued, v2.tab(x).busy], [2, true], 'blank messages are not queued');
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'user').map((e) => [e.text, !!e.queued]), [['hold 1', false], ['second', true], ['hold 3', true]], 'queued messages are shown at once');
    cx.finish(); await flush(); await flush();
    assert.deepStrictEqual(cx.sent, ['hold 1', 'second', 'hold 3'], 'they run in order as each turn ends');
    assert.deepStrictEqual([v2.tab(x).queued, v2.tab(x).busy], [0, true], 'and the tab stays busy between them');
    assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user').length, 3, 'a queued message is not shown a second time when it starts');
    assert.strictEqual(v2.events(x).slice(before).filter((e) => e.kind === 'busy' && !e.busy).length, 0, 'no flicker to idle between queued turns');

    // stop ends the turn and drops what is queued behind it
    v2.fire({ type: 'send', sid: x, text: 'never runs' }); v2.fire({ type: 'send', sid: x, text: 'nor this' });
    assert.strictEqual(v2.tab(x).queued, 2);
    v2.fire({ type: 'stop', sid: x }); await flush(); await flush();
    assert.deepStrictEqual([cx.interrupted, cx.sent.length, v2.tab(x).queued, v2.tab(x).busy], [1, 3, 0, false]);
    assert(v2.events(x).some((e) => e.kind === 'note' && e.text === '2 queued messages dropped'));
    v2.fire({ type: 'send', sid: x, text: 'fresh' }); await flush();
    assert.deepStrictEqual([cx.sent.pop(), v2.tab(x).busy], ['fresh', false], 'the tab works normally afterwards');

    // ---- IDE context: a tab can attach the active file and selection to each message
    const sel = (a, ac, b, bc) => ({ isEmpty: a === b && ac === bc, start: { line: a, character: ac }, end: { line: b, character: bc }, active: { line: b, character: bc } });
    const editor = (file, lang, text, s) => ({ selection: s, document: { uri: { scheme: 'file', fsPath: file }, languageId: lang, getText: () => text } });
    assert.deepStrictEqual([v2.tab(x).ide, v2.tab(c).ide], [false, false], 'off in the tests\' configuration; on by default');
    m.ui.editor = editor(path.join(process.cwd(), 'src', 'a.js'), 'javascript', 'const a = 1;\nconst b = 2;\n', sel(2, 0, 4, 0));
    v2.fire({ type: 'send', sid: x, text: 'plain' }); await flush();
    assert.strictEqual(cx.sent.pop(), 'plain', 'nothing is attached while it is off');
    v2.fire({ type: 'setIde', sid: x, value: true }); assert.strictEqual(v2.tab(x).ide, true);
    v2.fire({ type: 'setIde', sid: c, value: true }); assert.strictEqual(v2.tab(c).ide, true, 'on a Claude tab too');
    v2.fire({ type: 'send', sid: x, text: 'why is b 2?' }); await flush();
    const F = path.join('src', 'a.js');
    assert.strictEqual(cx.sent.pop(), 'why is b 2?\n\n<ide_context>\nActive file: ' + F + ' (javascript)\nSelection: lines 3-4\n```javascript\nconst a = 1;\nconst b = 2;\n```\n</ide_context>', 'the agent gets the file, the lines, and the text');
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'why is b 2?', queued: false, tag: 'a.js:3-4' }, 'the transcript shows the message, and the file attached by name');
    assert.strictEqual(v2.tab(x).title.includes('ide_context'), false);

    m.ui.editor = editor(path.join(process.cwd(), 'src', 'a.js'), 'javascript', '', sel(7, 4, 7, 4));
    v2.fire({ type: 'send', sid: x, text: 'here' }); await flush();
    assert(/\nActive file: .*a\.js \(javascript\)\nCursor: line 8\n<\/ide_context>$/.test(cx.sent.pop()), 'with no selection: the file and the cursor');
    assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user').pop().tag, 'a.js');
    m.ui.editor = editor('/elsewhere/x.py', 'python', 'a ``` b ```` c', sel(0, 0, 0, 14));
    v2.fire({ type: 'send', sid: x, text: 'fences' }); await flush();
    assert(/Active file: \/elsewhere\/x\.py \(python\)\nSelection: lines 1-1\n`````python\na ``` b ```` c\n`````\n/.test(cx.sent.pop()), 'a file outside the workspace keeps its path; the fence is longer than any inside the selection');
    m.ui.editor = editor('/big.txt', 'plaintext', 'x'.repeat(20000), sel(0, 0, 0, 20000));
    v2.fire({ type: 'send', sid: x, text: 'big' }); await flush();
    const big = cx.sent.pop(); assert(/Selection: lines 1-1 \(first 12000 characters\)/.test(big) && big.length < 12300, 'a long selection is cut, and says so');
    // a Perch tab in the editor area has the focus while the message is written, so there is no active editor: the file
    // last focused is used, read from the editor still showing it; once it is off the screen, nothing is attached
    m.ui.editor = editor(path.join(process.cwd(), 'src', 'b.js'), 'javascript', '', sel(1, 0, 1, 0)); for (const f of m.ui.listeners.editor) f(m.ui.editor);
    const keep = m.ui.editor; m.ui.editor = undefined; for (const f of m.ui.listeners.editor) f(undefined); m.ui.visible = [keep];
    v2.fire({ type: 'send', sid: x, text: 'focus' }); await flush();
    assert(/\nActive file: src\/b\.js \(javascript\)\nCursor: line 2\n<\/ide_context>$/.test(cx.sent.pop()), 'the last file focused, while it is on screen');
    m.ui.visible = []; v2.fire({ type: 'send', sid: x, text: 'gone' }); await flush();
    assert.strictEqual(cx.sent.pop(), 'gone', 'a file no longer on screen is not attached');
    m.ui.visible = undefined;
    for (const ed of [undefined, { selection: sel(0, 0, 0, 0), document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' }, languageId: 'plaintext', getText: () => '' } }]) {
      m.ui.editor = ed; v2.fire({ type: 'send', sid: x, text: 'nothing open' }); await flush();
      assert.strictEqual(cx.sent.pop(), 'nothing open', 'no editor, or an unsaved one: the message goes as written');
      assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user').pop().tag, undefined);
    }

    // the context is read when the message is written, not when a queued message finally starts
    m.ui.editor = editor(path.join(process.cwd(), 'one.js'), 'javascript', 'ONE', sel(0, 0, 0, 3));
    v2.fire({ type: 'send', sid: x, text: 'hold it' });
    v2.fire({ type: 'send', sid: x, text: 'queued about one' });
    m.ui.editor = editor(path.join(process.cwd(), 'two.js'), 'javascript', 'TWO', sel(0, 0, 0, 3));
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'queued about one', queued: true, tag: 'one.js:1' });
    cx.finish(); await flush(); await flush();
    assert(/queued about one\n\n<ide_context>\nActive file: one\.js/.test(cx.sent.pop()) , 'the queued message carries the file that was open when it was written');
    assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user' && e.text === 'queued about one').length, 1);

    // the choice is saved with the tab
    const saved2 = install(m.memento._dump()); const v3 = fakeView(); saved2.registered['perch.main'].resolveWebviewView(v3.view); v3.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v3.lastTabs().tabs.map((t) => t.ide), [true, false, true], 'IDE context survives a reload');
    // a Claude tab attaches the same, and its transcript shows the message and the tag
    m.ui.editor = editor(path.join(process.cwd(), 'src', 'a.js'), 'javascript', 'const a = 1;\n', sel(0, 0, 1, 0));
    v2.fire({ type: 'send', sid: c, text: 'what is a?' }); await flush();
    const cl = created.filter((a) => a.claude).pop();
    assert(/^what is a\?\n\n<ide_context>\nActive file: src\/a\.js \(javascript\)\nSelection: lines 1-1\n/.test(cl.sent.pop()), 'Claude gets the file and the selection');
    assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'what is a?', queued: false, tag: 'a.js:1' });
    // new tabs follow the setting
    const on = install(undefined, { config: { ideContext: true } }); await flush();
    const von = fakeView(); on.registered['perch.main'].resolveWebviewView(von.view); von.fire({ type: 'ready' }); await flush();
    von.fire({ type: 'new', kind: 'claude' }); von.fire({ type: 'new', kind: 'codex' });
    assert.deepStrictEqual(von.lastTabs().tabs.map((t) => t.ide), [true, true], 'on by default, for both');
    on.perch.dispose();
    m.ui.editor = undefined;

    // closing a tab with a queue disposes it cleanly
    v2.fire({ type: 'send', sid: x, text: 'hold' }); v2.fire({ type: 'send', sid: x, text: 'q' });
    v2.fire({ type: 'close', sid: x }); cx.finish(); await flush();
    assert.deepStrictEqual([cx.disposed, cx.sent.includes('q')], [true, false]);
  }

  // ======================================================================== sessions as editor tabs
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const gpt = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-ext-')); fs.mkdirSync(path.join(gpt, 'resources'));
    for (const f of ['blossom-white.svg', 'blossom-black.svg']) fs.writeFileSync(path.join(gpt, 'resources', f), '<svg/>');
    const extensions = {
      'anthropic.claude-code': { icon: 'resources/claude-logo.png', contributes: { viewsContainers: { activitybar: [{ id: 'c', icon: 'resources/claude-logo.svg' }] } } },
      'openai.chatgpt': { __root: gpt, icon: 'resources/blossom.dark.png', contributes: { viewsContainers: { activitybar: [{ id: 'x', icon: 'resources/blossom-white.svg' }] } } },
    };
    const m = install(undefined, { config: { newTabs: 'editor' }, extensions }); await flush();
    const side = fakeView(); m.registered['perch.main'].resolveWebviewView(side.view); side.fire({ type: 'ready' }); await flush();
    assert(m.ui.serializers['perch.session'], 'VS Code is told how to bring editor tabs back');
    assert.strictEqual(m.ui.panels.length, 0, 'nothing opens by itself');

    // a new tab is a native editor tab, beside the editor, with the vendor's icon
    await m.commands['perch.newClaude']();
    const p1 = m.ui.panels[0], c = m.perch.sessions[0].id;
    assert.deepStrictEqual([p1.viewType, p1.title, p1.viewColumn, p1.active, p1.options.retainContextWhenHidden, p1.options.enableScripts], ['perch.session', 'Claude 1', 2, true, true, true]);
    assert.strictEqual(p1.iconPath.path, '/ext/anthropic.claude-code/resources/claude-logo.svg', 'Claude\'s glyph carries its own colour');
    assert.deepStrictEqual(p1.webview.options.localResourceRoots.map((u) => u.path), ['/ext/fennets.perch', '/ext/anthropic.claude-code', gpt]);
    assert.deepStrictEqual(side.lastTabs().tabs, [], 'it is not a tab of the sidebar view');
    assert.deepStrictEqual(m.memento._dump()['perch.sessions.v1'].sessions.map((x) => [x.location, x.paneled]), [['editor', true]]);

    // its page shows that one session, with no tab bar of its own
    assert.strictEqual(p1.got.length, 0, 'nothing is sent to a page that has not said it is ready');
    p1.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([p1.lastTabs().single, p1.lastTabs().active, p1.lastTabs().tabs.map((t) => t.id)], [true, c, [c]]);
    assert.strictEqual(p1.lastMeter().vendor, 'Claude'); assert.strictEqual(p1.commands('claude').length, 1, 'meter and slash commands reach every page');
    assert.deepStrictEqual(p1.events(c).map((e) => e.kind), ['clear', 'busy', 'status']);

    // messages go to the page that shows the session, and nowhere else
    const n0 = side.got.filter((x) => x.type === 'event').length;
    p1.fire({ type: 'send', sid: c, text: 'hold the line please' });
    assert(p1.events(c).some((e) => e.kind === 'user' && e.text === 'hold the line please'));
    assert.strictEqual(side.got.filter((x) => x.type === 'event').length, n0, 'the sidebar page hears nothing of it');
    assert.strictEqual(p1.title, 'hold the line please …', 'the native tab is titled from the first message, and shows that the agent is working');
    const a1 = created[created.length - 1]; a1.finish(); await flush();
    assert.strictEqual(p1.title, 'hold the line please');

    // a second tab opens beside the first; ChatGPT's icon has a light and a dark version
    await m.commands['perch.newCodex']();
    const p2 = m.ui.panels[1], x = m.perch.sessions[1].id;
    assert.deepStrictEqual([p2.title, p2.viewColumn], ['Codex 1', 2], 'in the column the Perch tabs already use');
    assert.deepStrictEqual([p2.iconPath.light.path, p2.iconPath.dark.path], [gpt + '/resources/blossom-black.svg', gpt + '/resources/blossom-white.svg']);
    p2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(p2.lastTabs().tabs.map((t) => t.id), [x]); assert.deepStrictEqual(p1.lastTabs().tabs.map((t) => t.id), [c], 'each page has its own session only');
    p2.fire({ type: 'send', sid: x, text: 'hi codex' }); await flush();
    assert(!p1.events().some((e) => e.text === 'hi codex'));

    // the + in the editor title asks which kind
    m.picks.push((i) => i.kind === 'codex'); await m.commands['perch.new']();
    assert.deepStrictEqual([m.ui.panels.length, m.ui.panels[2].title], [3, 'Codex 2']);
    await m.commands['perch.new'](); assert.strictEqual(m.ui.panels.length, 3, 'dismissing the question opens nothing');
    const p3 = m.ui.panels[2], x2 = m.perch.sessions[2].id; p3.fire({ type: 'ready' });

    // commands act on the editor tab that has the focus
    p1.show(true, true);
    p1.fire({ type: 'send', sid: c, text: 'hold again' });
    m.commands['perch.stop'](); assert.strictEqual(a1.interrupted, 1, 'stop reaches the focused tab');
    await flush();
    p2.show(true, true); m.picks.push((i) => i.sid === c); await m.commands['perch.handoff']();
    assert.deepStrictEqual(p1.events(c).filter((e) => e.kind === 'fill').pop(), { kind: 'fill', text: 'answer to hi codex' }, 'handoff from the focused tab into the chosen one');
    assert.strictEqual(p1.reveals, 1, 'which is brought to the front');
    p2.show(true, true); m.picks.push((i) => i.kind === 'claude'); await m.commands['perch.handoff']();
    const p4 = m.ui.panels[3], c2 = m.perch.sessions[3].id;
    assert.strictEqual(p4.events().length, 0); p4.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(p4.events(c2).filter((e) => e.kind === 'fill'), [{ kind: 'fill', text: 'answer to hi codex' }], 'a handoff into a new tab waits for its page');
    p4.fire({ type: 'ready' }); await flush();
    assert.strictEqual(p4.events(c2).filter((e) => e.kind === 'fill').length, 1, 'and is not repeated if the page reloads');

    // a prompt in a tab that is not showing marks the native tab
    p1.show(false, false);
    const s1 = m.perch.get(c); const ans = new Promise((res) => s1.pending.set('p1', res)); s1.post({ kind: 'permission', id: 'p1', tool: 'Write', input: {} });
    assert.strictEqual(p1.title, '● hold the line please', 'marked while hidden');
    p1.show(true, true);
    assert.strictEqual(p1.title, '● hold the line please', 'still marked while the prompt is unanswered');
    p1.fire({ type: 'permission', sid: c, id: 'p1', decision: 'deny' }); assert.deepStrictEqual(await ans, { decision: 'deny' });
    assert.strictEqual(p1.title, 'hold the line please');
    const ans2 = new Promise((res) => s1.pending.set('p2', res)); s1.post({ kind: 'permission', id: 'p2', tool: 'Write', input: {} });
    assert.strictEqual(p1.title, 'hold the line please', 'a prompt in a tab that is showing needs no mark');
    p1.fire({ type: 'permission', sid: c, id: 'p2', decision: 'allow' }); await ans2;

    // closing the editor tab closes the session
    const ax2 = created.find((a) => a.o.emit && a.sent.includes('hi codex'));
    p2.dispose(); await flush();
    assert.deepStrictEqual([!!m.perch.get(x), ax2.disposed, m.memento._dump()['perch.sessions.v1'].sessions.map((t) => t.id).includes(x)], [false, true, false], 'the agent is stopped and the tab forgotten');
    // and closing the session closes the editor tab
    p3.show(true, true); m.commands['perch.closeTab']();
    assert.deepStrictEqual([p3.disposed, !!m.perch.get(x2)], [true, false]);

    // ---- moving between the editor area and the sidebar keeps the session, its agent, and its transcript
    p1.show(true, true); m.commands['perch.moveToSidebar']();
    assert.deepStrictEqual([p1.disposed, !!m.perch.get(c), a1.disposed], [true, true, false], 'the editor tab goes, the session stays');
    assert.deepStrictEqual([side.lastTabs().tabs.map((t) => t.id), side.lastTabs().active], [[c], c]);
    assert(side.events(c).some((e) => e.kind === 'user' && e.text === 'hold the line please'), 'the transcript is replayed in the sidebar');
    side.fire({ type: 'send', sid: c, text: 'still here' }); assert.strictEqual(a1.sent.pop(), 'still here', 'the same agent');
    m.perch.activeId = c; p4.show(true, false); m.commands['perch.moveToEditor']();
    const p5 = m.ui.panels[m.ui.panels.length - 1];
    assert.deepStrictEqual([side.lastTabs().tabs, p5.title, m.perch.get(c).location], [[], 'hold the line please', 'editor']);
    p5.fire({ type: 'ready' }); await flush();
    assert(p5.events(c).some((e) => e.kind === 'user' && e.text === 'still here'));
    m.commands['perch.moveAllToSidebar'](); assert.deepStrictEqual([side.lastTabs().tabs.length, m.ui.panels.filter((p) => !p.disposed).length, m.perch.sessions.length], [2, 0, 2]);
    m.commands['perch.moveAllToEditor'](); assert.deepStrictEqual([side.lastTabs().tabs.length, m.ui.panels.filter((p) => !p.disposed).length], [0, 2]);
    for (const p of m.ui.panels.filter((q) => !q.disposed)) p.fire({ type: 'ready' });

    // the setting decides where new tabs go; the sidebar's own buttons follow it
    side.fire({ type: 'new', kind: 'claude' }); assert.strictEqual(m.ui.panels.filter((p) => !p.disposed).length, 3, 'with newTabs editor, the sidebar\'s button opens an editor tab');
    m.changeConfig({ newTabs: 'sidebar' }); side.fire({ type: 'new', kind: 'codex' });
    assert.deepStrictEqual([m.ui.panels.filter((p) => !p.disposed).length, side.lastTabs().tabs.map((t) => t.kind)], [3, ['codex']]);

    // ---- window reload: VS Code brings the editor tabs back, and each page says which session it showed
    const saved = m.memento._dump(); const ids = saved['perch.sessions.v1'].sessions.filter((t) => t.location === 'editor').map((t) => t.id);
    m.perch.dispose();
    assert(m.perch.sessions.length > 0 && m.memento._dump()['perch.sessions.v1'].sessions.length === 4, 'shutting down does not close the sessions');
    const r = install(saved, { config: { newTabs: 'editor' }, extensions });
    assert.strictEqual(r.ui.panels.length, 0, 'tabs that VS Code will restore are not opened a second time');
    const q1 = r.restorePanel(ids[0]);
    assert.deepStrictEqual([q1.disposed, q1.title, !!q1.iconPath], [false, 'hold the line please', true], 'a restored tab gets its title and icon back');
    q1.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([q1.lastTabs().tabs[0].id, q1.lastTabs().single], [ids[0], true]);
    assert(q1.events(ids[0]).some((e) => e.kind === 'note' && /resumed claude session/.test(e.text)));
    assert.deepStrictEqual([r.restorePanel(ids[0]).disposed, r.restorePanel('gone').disposed, r.restorePanel(undefined).disposed, r.restorePanel(saved['perch.sessions.v1'].sessions.find((t) => t.location === 'sidebar').id).disposed], [true, true, true, true], 'a second tab for the same session, a tab for a session that no longer exists, a tab with no memory, and a tab for a session that lives in the sidebar are all closed');
    assert.strictEqual(r.perch.sessions.length, 4, 'closing those stray tabs closes no session');
    const before = r.ui.panels.filter((p) => !p.disposed).length;
    await wait(120);
    const late = r.ui.panels.filter((p) => !p.disposed);
    assert.deepStrictEqual([late.length - before, late.slice(before).map((p) => p.active)], [2, [false, false]], 'tabs VS Code did not bring back are opened after a short wait, without taking the focus');
    r.perch.dispose();

    // ---- tabs saved before editor tabs existed follow the setting
    const legacy = { 'perch.sessions.v1': { active: 'L1', counters: { claude: 1, codex: 1 }, sessions: [{ id: 'L1', kind: 'claude', title: 'hello', titled: true, mode: 'default', effort: '', model: '', resume: 'aa0af10b' }, { id: 'L2', kind: 'codex', title: 'hello', titled: true, mode: 'workspace-write', effort: '', model: '', ide: false, resume: '01a0ee91' }] } };
    const g = install(legacy, { config: { newTabs: 'editor' }, extensions });
    assert.deepStrictEqual(g.ui.panels.map((p) => [p.title, p.active]), [['hello', false], ['hello', false]], 'with newTabs editor they become editor tabs at once');
    g.ui.panels[1].fire({ type: 'ready' }); await flush();
    g.ui.panels[1].fire({ type: 'send', sid: 'L2', text: 'continue' }); await flush();
    assert.strictEqual(created[created.length - 1].o.resume, '01a0ee91', 'still the same conversation');
    await wait(120); assert.strictEqual(g.ui.panels.length, 2, 'and are not opened twice');
    g.perch.dispose();
    const k = install(legacy); const sk = fakeView(); k.registered['perch.main'].resolveWebviewView(sk.view); sk.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([k.ui.panels.length, sk.lastTabs().tabs.map((t) => t.id), sk.lastTabs().active], [0, ['L1', 'L2'], 'L1'], 'with newTabs sidebar they stay where they were');
    k.perch.dispose();
    fs.rmSync(gpt, { recursive: true, force: true });
  }

  // ======================================================================== dictation
  {
    const voiceOf = (v, sid) => v.events(sid).filter((e) => e.kind === 'voice');
    const last = (list) => list[list.length - 1];
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;

    // speak, stop, and the words arrive in the message box
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    assert.deepStrictEqual(voiceOf(v, c).map((e) => e.phase), ['starting', 'recording']);
    assert.deepStrictEqual([last(voiceOf(v, c)).device, last(voiceOf(v, c)).maxSeconds], ['Headset Microphone', 180]);
    assert.deepStrictEqual(m.abox.calls.map((k) => k[0]), ['available', 'start'], 'the recorder on the user\'s machine is asked, and started');
    assert.deepStrictEqual([m.vbox.starts, m.ui.warnings.length, m.ui.infos.length], [1, 0, 0], 'the model loads while the user is speaking; nothing is asked when it is already set up');
    await wait(300);
    const ticks = voiceOf(v, c).filter((e) => e.phase === 'recording' && e.seconds === 1.2);
    assert(ticks.length >= 1 && ticks[0].level === 0.4 && ticks[0].silent === false, 'the level reaches the page while recording');
    assert.strictEqual(voiceOf(v, x).length, 0, 'only on the tab that is dictating');
    v.fire({ type: 'voiceStop', sid: c }); await flush(); await flush();
    assert.deepStrictEqual(voiceOf(v, c).slice(-2).map((e) => e.phase), ['transcribing', 'idle']);
    assert.deepStrictEqual(last(m.abox.calls), ['stop', 'rec-1']);
    assert.deepStrictEqual([m.vbox.requests.length, m.vbox.requests[0].sampleRate, m.vbox.requests[0].pcm.length, m.vbox.requests[0].language, m.vbox.requests[0].prompt], [1, 16000, m.abox.stop.pcm.length, null, null]);
    assert.deepStrictEqual(last(v.events(c).filter((e) => e.kind === 'insert')), { kind: 'insert', text: 'hello world ' }, 'at the cursor, with a space after, ready for more');
    const n = m.abox.calls.length; await wait(200); assert.strictEqual(m.abox.calls.length, n, 'nothing is asked of the recorder once it has stopped');

    // settings reach the engine
    m.changeConfig({ 'voice.language': 'ko', 'voice.vocabulary': 'Perch, Whisper' });
    m.vbox.text = '  안녕하세요  '; v.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); v.fire({ type: 'voiceStop', sid: x }); await flush(); await flush();
    assert.deepStrictEqual([last(m.vbox.requests).language, last(m.vbox.requests).prompt, last(v.events(x).filter((e) => e.kind === 'insert')).text], ['ko', 'Perch, Whisper', '안녕하세요 ']);
    const e0 = engines.length; m.changeConfig({ 'voice.model': 'small', 'voice.device': 'cpu', 'voice.idleMinutes': 0 });
    v.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); v.fire({ type: 'voiceStop', sid: x }); await flush(); await flush();
    assert.deepStrictEqual([engines.length, last(engines).o.model, last(engines).o.device, last(engines).o.idleMs, m.vbox.stops], [e0 + 1, 'small', 'cpu', 0, 1], 'a change of model replaces the engine, and the old one is stopped');
    m.vbox.text = 'hello world';

    // pressing the microphone again finishes; escape discards
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    assert.deepStrictEqual([last(voiceOf(v, c)).phase, last(m.abox.calls)[0]], ['idle', 'stop'], 'the button that starts it also finishes it');
    const r0 = m.vbox.requests.length;
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush(); v.fire({ type: 'voiceCancel' }); await flush();
    assert.deepStrictEqual([last(voiceOf(v, c)).phase, last(m.abox.calls), m.vbox.requests.length], ['idle', ['cancel', 'rec-1'], r0], 'discarded: the recorder lets go, and nothing is transcribed');
    v.fire({ type: 'voiceCancel' }); v.fire({ type: 'voiceStop', sid: c }); await flush(); assert.strictEqual(m.vbox.requests.length, r0, 'with nothing recording, these do nothing');

    // one dictation at a time; a tab that closes takes its dictation with it
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    v.fire({ type: 'voiceStart', sid: x }); await flush();
    assert.strictEqual(last(v.events(x).filter((e) => e.kind === 'error')).text, 'Voice input: another tab is dictating.');
    v.fire({ type: 'voiceStop', sid: x }); await flush(); assert.strictEqual(last(voiceOf(v, c)).phase, 'recording', 'another tab cannot finish it');
    // a page rebuilt mid-dictation is told at once
    const v2 = fakeView(); m.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(voiceOf(v2, c).slice(0, 1).map((e) => [e.phase, e.device]), [['recording', 'Headset Microphone']]);
    v2.fire({ type: 'close', sid: c }); await flush();
    assert.deepStrictEqual([last(m.abox.calls), m.vbox.requests.length], [['cancel', 'rec-1'], r0]);
    v2.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); assert.strictEqual(last(voiceOf(v2, x)).phase, 'recording', 'and the microphone is free for another tab');

    // the recording ends by itself at the limit, and is transcribed
    m.abox.levels.push({ ok: true, level: 0.2, seconds: 180, ended: 'max', silent: false }); m.abox.stop = Object.assign({}, m.abox.stop, { ended: 'max' });
    await wait(300); await flush();
    assert.strictEqual(last(voiceOf(v2, x)).phase, 'idle'); assert.strictEqual(last(v2.events(x).filter((e) => e.kind === 'insert')).text, 'hello world ');
    assert.strictEqual(last(v2.events(x).filter((e) => e.kind === 'note')).text, 'Dictation stopped at the 180 second limit. Set perchAudio.maxSeconds to change it.');
    m.abox.stop = Object.assign({}, m.abox.stop, { ended: null });

    // nothing heard, nothing said, too short
    const errs = () => v2.events(x).filter((e) => e.kind === 'error').map((e) => e.text);
    const once = async (patch, vpatch) => { const keep = m.abox.stop, keepText = m.vbox.text, keepFail = m.vbox.failTranscribe; m.abox.stop = Object.assign({}, keep, patch); Object.assign(m.vbox, vpatch); const i0 = v2.events(x).filter((e) => e.kind === 'insert').length; v2.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); v2.fire({ type: 'voiceStop', sid: x }); await flush(); await flush(); m.abox.stop = keep; m.vbox.text = keepText; m.vbox.failTranscribe = keepFail; return v2.events(x).filter((e) => e.kind === 'insert').length - i0; };
    assert.strictEqual(await once({ silent: true }), 0);
    assert.strictEqual(last(errs()), 'Voice input: nothing was heard from "Headset Microphone". It may be muted, or the wrong input. Choose another with Perch Audio: Choose Microphone.');
    const r1 = m.vbox.requests.length; assert.strictEqual(await once({ seconds: 0.1 }), 0); assert.strictEqual(m.vbox.requests.length, r1, 'a slip of the finger is not sent to the model');
    assert.strictEqual(await once({}, { text: '   ' }), 0); assert.strictEqual(last(v2.events(x).filter((e) => e.kind === 'note')).text, 'Voice input heard no words.');
    assert.strictEqual(await once({}, { failTranscribe: 'CUDA out of memory' }), 0); assert.strictEqual(last(errs()), 'Voice input: CUDA out of memory');
    assert.strictEqual(await once({ ok: false, error: 'No such recording.', code: 'unknown' }), 0); assert.strictEqual(last(errs()), 'Voice input: No such recording.');
    assert.strictEqual(last(voiceOf(v2, x)).phase, 'idle', 'every failure leaves the microphone ready to try again');
    assert.strictEqual(await once({}), 1);

    // the recorder is lost mid-recording
    v2.fire({ type: 'voiceStart', sid: x }); await flush(); await flush();
    m.abox.levels.push({ ok: false, error: 'No such recording.', code: 'unknown' }); await wait(300);
    assert.deepStrictEqual([last(voiceOf(v2, x)).phase, last(errs())], ['idle', 'Voice input: the recording was lost: No such recording.']);

    // words for a page that is not there wait for it
    m.perch.deliver(x, 'first'); assert.strictEqual(last(v2.events(x).filter((e) => e.kind === 'insert')).text, 'first');
    v2.destroy(); m.perch.deliver(x, 'while away'); m.perch.deliver(x, 'and more');
    const v3 = fakeView(); m.registered['perch.main'].resolveWebviewView(v3.view); v3.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v3.events(x).filter((e) => e.kind === 'fill').map((e) => e.text), ['while away and more']);
    m.perch.dispose();
  }
  {
    // no microphone where the user sits, and no companion at all
    const NOMIC = 'No microphone is connected to this computer: nothing is plugged into its audio input. Plug in a microphone or a headset, or dictate from a computer that has one, connected to this workspace over Remote-SSH with Perch Audio installed there.';
    const m = install(undefined, { audio: { available: { ok: false, code: 'no-microphone', error: NOMIC, api: 1 } } }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    assert.deepStrictEqual(v.events(c).filter((e) => e.kind === 'voice').map((e) => e.phase), ['starting', 'idle']);
    assert.strictEqual(v.events(c).filter((e) => e.kind === 'error').pop().text, 'Voice input: ' + NOMIC, 'the reason is passed on as the recorder gave it');
    assert.deepStrictEqual([m.abox.calls.map((k) => k[0]), m.vbox.starts, m.vbox.installs], [['available'], 0, []], 'and nothing is started or installed');
    m.abox.available = { ok: true, api: 3, devices: ['Mic'], device: 'Mic' }; v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    assert.strictEqual(v.events(c).filter((e) => e.kind === 'error').pop().text, 'Voice input: Perch Audio is a newer version than Perch. Update Perch.');
    m.abox.available = { ok: true, api: 1, devices: ['Mic'], device: 'Mic' }; m.abox.start = { ok: false, code: 'capture-failed', error: 'Could not open the microphone: Failed to open device.' };
    v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    assert.strictEqual(v.events(c).filter((e) => e.kind === 'error').pop().text, 'Voice input: Could not open the microphone: Failed to open device.');
    m.abox.missing = true; v.fire({ type: 'voiceStart', sid: c }); await flush(); await flush();
    const e = v.events(c).filter((x) => x.kind === 'error').pop().text;
    assert(/^Voice input: Perch Audio is not installed on this computer\. It records from your microphone, so it has to be installed where you are sitting, even when the workspace is remote\./.test(e), e);
    assert(/make install-audio/.test(e) && /seanahn\.perch-audio/.test(e), 'and says how to get it');
    assert.strictEqual(v.events(c).filter((x) => x.kind === 'voice').pop().phase, 'idle');
    m.perch.dispose();
  }
  {
    // first use: the one-time setup is asked for, says where it installs, and can be declined
    const m = install(undefined, { voice: { installed: false } }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    v.fire({ type: 'voiceStart', sid: x }); await flush(); await flush();
    assert.strictEqual(m.ui.infos.pop(), 'Set up voice input on this machine?');
    assert(/private Python environment and fetches a model sized for the machine \(large-v3-turbo with a GPU, small without\), up to 4 GB in all, under .*perch.voice\. Nothing is installed system-wide, and nothing you say leaves this machine\./.test(m.ui.details.pop()));
    assert.deepStrictEqual([m.vbox.installs, m.abox.calls.map((k) => k[0]), v.events(x).filter((e) => e.kind === 'voice').pop().phase, v.events(x).filter((e) => e.kind === 'error').length], [[], ['available'], 'idle', 0], 'declined: nothing is installed, nothing is recorded, and it is not an error');
    m.ui.answers.push('Set Up'); v.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([m.vbox.installs, m.ui.progress], [['auto'], ['Perch voice input', 'Creating a private Python environment', 'Installing the speech-to-text runtime', 'Ready']]);
    assert.strictEqual(v.events(x).filter((e) => e.kind === 'voice').pop().phase, 'recording', 'and dictation begins once it is ready');
    v.fire({ type: 'voiceCancel' }); await flush();
    const asked = m.ui.infos.length; v.fire({ type: 'voiceStart', sid: x }); await flush(); await flush(); assert.strictEqual(m.ui.infos.length, asked, 'it is asked once'); v.fire({ type: 'voiceCancel' }); await flush();
    await m.commands['perch.voice.setup'](); assert.strictEqual(m.ui.infos.pop(), 'Perch: voice input is already set up here.');
    m.commands['perch.voice.unload'](); assert.strictEqual(m.vbox.stops, 1, 'the model can be unloaded by hand, to free its memory');
    m.perch.dispose();

    const f = install(undefined, { voice: { installed: false, failInstall: 'No matching distribution found for faster-whisper' } }); await flush();
    const fv = fakeView(); f.registered['perch.main'].resolveWebviewView(fv.view); fv.fire({ type: 'ready' }); await flush();
    fv.fire({ type: 'new', kind: 'claude' }); const c = fv.lastTabs().active;
    f.ui.answers.push('Set Up'); fv.fire({ type: 'voiceStart', sid: c }); await flush(); await flush(); await flush();
    assert.strictEqual(f.ui.errors.pop(), 'Perch: voice input could not be set up. No matching distribution found for faster-whisper');
    assert.deepStrictEqual([fv.events(c).filter((e) => e.kind === 'voice').pop().phase, f.abox.calls.map((k) => k[0])], ['idle', ['available']]);
    f.perch.dispose();

    // over Remote-SSH the question names the machine it will install on
    const r = install(undefined, { voice: { installed: false }, remote: 'ssh-remote' }); await flush();
    const rv = fakeView(); r.registered['perch.main'].resolveWebviewView(rv.view); rv.fire({ type: 'ready' }); await flush();
    rv.fire({ type: 'new', kind: 'claude' }); rv.fire({ type: 'voiceStart', sid: rv.lastTabs().active }); await flush(); await flush();
    assert.strictEqual(r.ui.infos.pop(), `Set up voice input on ${require('os').hostname()}, the remote machine?`);
    assert(/nothing you say leaves your machines\./.test(r.ui.details.pop()), 'audio crosses from the laptop to the workspace machine, and no further');
    r.perch.dispose();

    // ---- the laptop has a GPU: the words are worked out there, in Perch Audio, and only the text crosses
    const A2 = { ok: true, api: 2, devices: ['Headset Microphone'], device: 'Headset Microphone', busy: false };
    const OPTS = { model: 'auto', device: 'auto', python: undefined, idleMs: 0 };
    const last = (a) => a[a.length - 1];
    const L = install(undefined, { voice: { installed: false }, audio: { available: A2 }, remote: 'ssh-remote' }); await flush();
    const lv = fakeView(); L.registered['perch.main'].resolveWebviewView(lv.view); lv.fire({ type: 'ready' }); await flush();
    lv.fire({ type: 'new', kind: 'claude' }); const lx = lv.lastTabs().active;
    L.changeConfig({ 'voice.language': 'ko', 'voice.vocabulary': 'Perch', 'voice.idleMinutes': 0 });
    const ops = () => L.abox.calls.map((k) => k[0]).filter((k) => k !== 'level');
    const dictate = async () => { lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush(); lv.fire({ type: 'voiceStop', sid: lx }); await flush(); await flush(); };
    lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush();
    assert.deepStrictEqual(ops(), ['available', 'engine', 'start', 'warm'], 'Perch Audio is asked what it can do, then to record, and to load its model meanwhile');
    assert.deepStrictEqual([L.abox.calls[1][1], L.abox.calls[3][1]], [OPTS, OPTS], 'with the engine settings from here');
    assert.deepStrictEqual([L.ui.infos.length, L.vbox.installs, L.vbox.starts], [0, [], 0], 'nothing is asked, and the engine here is left alone');
    lv.fire({ type: 'voiceStop', sid: lx }); await flush(); await flush();
    assert.deepStrictEqual(last(L.abox.calls), ['transcribe', 'rec-1', { engine: OPTS, language: 'ko', prompt: 'Perch' }], 'the recording is stopped and transcribed there, with the words settings');
    assert.deepStrictEqual([last(lv.events(lx).filter((e) => e.kind === 'insert')).text, L.vbox.requests.length, lv.events(lx).filter((e) => e.kind === 'voice' && e.phase === 'transcribing').pop().where], ['local words ', 0, 'local']);

    // not yet set up there: the question names the laptop, and the set-up runs there
    L.abox.engine = Object.assign({}, L.abox.engine, { installed: false });
    lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush();
    assert.strictEqual(L.ui.infos.pop(), 'Set up voice input on this computer, laptop?');
    assert(/on the computer you sit at, not on the remote/.test(L.ui.details.pop()));
    assert.deepStrictEqual([last(L.abox.calls)[0], last(lv.events(lx).filter((e) => e.kind === 'voice')).phase], ['engine', 'idle'], 'declined: nothing more is asked of it');
    L.ui.answers.push('Set Up'); lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([ops().slice(-3), last(L.abox.calls.filter((k) => k[0] === 'setup'))[1], L.vbox.installs, L.ui.progress.length], [['setup', 'start', 'warm'], OPTS, [], 0], 'set up there, with the progress shown there');
    lv.fire({ type: 'voiceCancel' }); await flush();
    L.abox.setup = { ok: false, error: 'no Python', code: 'setup-failed' }; L.ui.answers.push('Set Up'); lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([L.ui.errors.pop(), last(lv.events(lx).filter((e) => e.kind === 'voice')).phase], ['Perch: voice input could not be set up on this computer. no Python', 'idle']);
    L.abox.setup = { ok: true }; L.abox.engine = Object.assign({}, L.abox.engine, { installed: true });
    // the setup command and unloading follow the same choice
    await L.commands['perch.voice.setup'](); assert.strictEqual(L.ui.infos.pop(), 'Perch: voice input is already set up here.');
    await L.commands['perch.voice.unload'](); assert.deepStrictEqual([last(L.abox.calls)[0], L.vbox.stops], ['unload', 0]);

    // no GPU on the laptop: the audio comes here, as before
    L.abox.engine = Object.assign({}, L.abox.engine, { gpu: false }); L.vbox.installed = true; L.abox.calls.length = 0;
    await dictate();
    assert.deepStrictEqual([ops(), L.vbox.requests.length, last(lv.events(lx).filter((e) => e.kind === 'insert')).text], [['available', 'engine', 'start', 'stop'], 1, 'hello world ']);
    // asked for outright, the laptop is used without a GPU; asked for the remote, the laptop is not consulted
    L.changeConfig({ 'voice.runOn': 'local' }); L.abox.calls.length = 0; await dictate();
    assert.deepStrictEqual([ops(), L.vbox.requests.length], [['available', 'engine', 'start', 'warm', 'transcribe'], 1]);
    L.changeConfig({ 'voice.runOn': 'remote' }); L.abox.engine = Object.assign({}, L.abox.engine, { gpu: true }); L.abox.calls.length = 0; await dictate();
    assert.deepStrictEqual([ops(), L.vbox.requests.length], [['available', 'start', 'stop'], 2]);
    // an older Perch Audio records but cannot transcribe: local is refused outright, auto goes back to here
    L.changeConfig({ 'voice.runOn': 'local' }); L.abox.available = Object.assign({}, A2, { api: 1 }); L.abox.calls.length = 0;
    lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush();
    assert.deepStrictEqual([last(lv.events(lx).filter((e) => e.kind === 'error')).text, ops()], ['Voice input: Perch Audio on this computer is too old to transcribe there. Update it, or set perch.voice.runOn to remote.', ['available']]);
    L.changeConfig({ 'voice.runOn': 'auto' }); L.abox.calls.length = 0; await dictate();
    assert.deepStrictEqual([ops(), L.vbox.requests.length], [['available', 'start', 'stop'], 3]);
    // and one newer than this perch
    L.abox.available = Object.assign({}, A2, { api: 3 }); lv.fire({ type: 'voiceStart', sid: lx }); await flush(); await flush();
    assert.strictEqual(last(lv.events(lx).filter((e) => e.kind === 'error')).text, 'Voice input: Perch Audio is a newer version than Perch. Update Perch.');
    L.perch.dispose();
  }

  // ---- a backend switch during a turn: the tab moves once the turn is over, and nothing is cut off
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const x = v.lastTabs().active;
    v.fire({ type: 'send', sid: x, text: 'hold this thought' }); await flush();
    const holding = created.filter((a) => a.claude).pop();
    assert.strictEqual(v.lastTabs().tabs.find((t) => t.id === x).busy, true);
    v.fire({ type: 'meterToggle' }); await flush(); await flush();
    assert(v.events(x).some((e) => e.kind === 'note' && /^Claude backend is now API \/ Bedrock\. This tab moves to it after the current turn; the conversation continues, the prompt cache starts over\.$/.test(e.text)));
    assert.deepStrictEqual([holding.disposed, holding.interrupted, v.lastTabs().tabs.find((t) => t.id === x).busy], [false, 0, true], 'the turn runs on');
    holding.finish(); await flush(); await flush();
    assert.deepStrictEqual([holding.disposed, v.lastTabs().tabs.find((t) => t.id === x).started, v.lastTabs().tabs.find((t) => t.id === x).busy], [true, false, false], 'moved once the turn is over');
    assert(v.events(x).some((e) => e.kind === 'note' && /^Moved to the new Claude backend; the conversation continues from the next message\.$/.test(e.text)));
    v.fire({ type: 'send', sid: x, text: 'on we go' }); await flush();
    const again = created.filter((a) => a.claude).pop();
    assert.deepStrictEqual([again !== holding, again.o.resume, v.lastTabs().tabs.find((t) => t.id === x).backend], [true, 'sess-' + created.indexOf(holding), 'api']);
    m.perch.dispose();
  }

  // ---- Claude with nothing to authenticate with: the first message is held back, the way in offered, the text put back
  {
    const m = install(undefined, { meter: { login: false }, remote: 'ssh-remote' }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const x = v.lastTabs().active; const made = created.length;
    v.fire({ type: 'send', sid: x, text: 'hello' }); await flush(); await flush();
    assert.strictEqual(created.length, made, 'no process is started: it would only be refused');
    assert(/^Claude is not logged in on .+\. Log in, then send the message again\.$/.test(v.events(x).filter((e) => e.kind === 'note').pop().text));
    assert.strictEqual(v.events(x).filter((e) => e.kind === 'insert').pop().text, 'hello', 'the message goes back into the box');
    assert(/^Claude is not logged in on .+\. Perch runs Claude Code with its login, kept in \/nonexistent\/perch-test\/\.claude\. Log In opens Claude Code's sign-in; or use API \/ Bedrock credentials instead\.$/.test(m.ui.warnings.pop()));
    assert.deepStrictEqual(m.ui.executed, [], 'declined: nothing opens');
    // Log In: Claude Code's own sign-in, watched until the login lands
    m.ui.answers.push('Log In'); v.fire({ type: 'send', sid: x, text: 'hello' }); m.box.login = true; await flush(); await flush(); await flush();
    assert.deepStrictEqual([m.ui.executed, m.ui.infos.pop()], [['claude-vscode.editor.openLast'], 'Perch: Claude is logged in. Send your message again.']);
    v.fire({ type: 'send', sid: x, text: 'hello' }); await flush();
    assert.strictEqual(created.length, made + 1, 'logged in: the message goes to a Claude of its own');
    // the other way: switch to API / Bedrock, which has credentials here
    m.box.login = false; m.box.apiCreds = true; m.ui.answers.push('Use API / Bedrock');
    v.fire({ type: 'new', kind: 'claude' }); const y = v.lastTabs().active;
    v.fire({ type: 'send', sid: y, text: 'hi' }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([m.box.writes, v.lastMeter().backend], [[true], 'api'], 'switched');
    v.fire({ type: 'send', sid: y, text: 'hi' }); await flush();
    assert.strictEqual(created.length, made + 2, 'and on API / Bedrock the message goes through');
    // API / Bedrock with nothing to authenticate with: the settings file, or back to the subscription
    m.box.apiCreds = false; v.fire({ type: 'new', kind: 'claude' }); const z = v.lastTabs().active;
    v.fire({ type: 'send', sid: z, text: 'hey' }); await flush(); await flush();
    assert(/^Claude is set to API \/ Bedrock on .+, and no credentials for it were found there\. Set them up, or use your subscription, then send the message again\.$/.test(v.events(z).filter((e) => e.kind === 'note').pop().text));
    assert(/no ~\/\.aws credentials or profile, no AWS_\* variables, no ANTHROPIC_API_KEY\. Put AWS credentials on .+, and the region and model in the env block of \/nonexistent\/perch-test\/\.claude\/settings\.json \(AWS_REGION, ANTHROPIC_MODEL\), or use your subscription\.$/.test(m.ui.warnings.pop()));
    m.ui.answers.push('Open settings.json'); v.fire({ type: 'send', sid: z, text: 'hey' }); await flush(); await flush(); await flush();
    assert(/^Perch: could not create \/nonexistent\/perch-test\/\.claude\/settings\.json\. /.test(m.ui.errors.pop()), 'a file is made to fill in; here the place for it cannot exist');
    m.ui.answers.push('Use Subscription'); m.ui.answers.push('Log In'); v.fire({ type: 'send', sid: z, text: 'hey' }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([m.box.writes, v.lastMeter().backend, /has no subscription login yet/.test(m.ui.infos.pop())], [[true, false], 'subscription', true], 'back to the subscription, whose login is offered by the switch');
    m.perch.dispose();
  }

  // ---- Perch: Open, the way back in: the tab last used, or the sessions list with a new tab at the top
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.strictEqual(v.lastTabs().tabs.length, 0);
    const list = await m.commands['perch.open']();
    assert.deepStrictEqual([list.shown, list.rows().slice(0, 2).map((r) => r[0])], [true, ['$(add) New Claude tab', '$(add) New Codex tab']], 'nothing open: the sessions list, which starts a tab too');
    list.choose((i) => i.fresh === 'codex'); await flush();
    assert.deepStrictEqual([v.lastTabs().tabs.length, v.lastTabs().tabs[0].kind], [1, 'codex']);
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    const back = m.commands['perch.open']();
    assert.deepStrictEqual([back && back.id, v.lastTabs().active, m.ui.lists.length], [c, c, 1], 'a tab open: it comes to the front, and no list opens');
    m.perch.dispose();
  }

  // ---- the backend chosen for a tab sticks: the next new Claude tab starts there
  {
    const m = install(undefined, {}); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const a = v.lastTabs().active;
    assert.strictEqual(v.tab(a).gateway, false, 'at first, the window\'s backend');
    v.fire({ type: 'setBackend', sid: a, value: 'gateway' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const b = v.lastTabs().active;
    assert.deepStrictEqual([v.tab(b).gateway, m.globalState._dump()['perch.claude.newTabsOnGateway']], [true, true], 'the gateway chosen once, a new tab starts on it');
    v.fire({ type: 'new', kind: 'codex' }); assert.strictEqual(v.lastTabs().tabs.find((t) => t.id === v.lastTabs().active).gateway, false, 'Codex tabs are untouched');
    v.fire({ type: 'setBackend', sid: b, value: 'subscription' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    assert.deepStrictEqual([v.tab(b).gateway, v.tab(c).gateway, m.globalState._dump()['perch.claude.newTabsOnGateway']], [false, false, false], 'the subscription chosen, new tabs are off the gateway again');
    m.perch.dispose();
    // and it holds in a new window
    const r = install(undefined, { globals: { 'perch.claude.newTabsOnGateway': true } }); await flush();
    const rv = fakeView(); r.registered['perch.main'].resolveWebviewView(rv.view); rv.fire({ type: 'ready' }); await flush();
    rv.fire({ type: 'new', kind: 'claude' }); assert.strictEqual(rv.tab(rv.lastTabs().active).gateway, true);
    r.perch.dispose();
  }

  // ---- the model pill on the gateway: the gateway's names, from the file; a model of Claude's catalog is let go when a tab moves there
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-gw-')); const file = path.join(dir, 'env');
    fs.writeFileSync(file, 'export ANTHROPIC_BASE_URL=https://gw.example/llm-api\nexport ANTHROPIC_AUTH_TOKEN=t\nexport ANTHROPIC_MODEL=nexus-auto-bargain[1m]\nexport ANTHROPIC_DEFAULT_OPUS_MODEL=nexus-auto-quality[1m]\nexport ANTHROPIC_DEFAULT_SONNET_MODEL=nexus-auto-unlimited[1m]\n');
    const m = install(undefined, { config: { 'claude.gatewayEnv': file } }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const x = v.lastTabs().active;
    v.fire({ type: 'setModel', sid: x, value: 'fable' }); await flush();
    assert.strictEqual(v.tab(x).model, 'fable');
    v.fire({ type: 'setBackend', sid: x, value: 'gateway' }); await flush();
    const t = v.tab(x);
    assert.deepStrictEqual([t.gateway, t.model, t.effort], [true, '', ''], 'Fable means nothing to the gateway: back to the file\'s default');
    assert.deepStrictEqual(t.models.map((o) => [o.value, o.label]), [['', 'default · nexus-auto-bargain[1m]'], ['opus', 'nexus-auto-quality[1m]'], ['sonnet', 'nexus-auto-unlimited[1m]']], 'the menu is the file\'s names, carried by the aliases Claude Code maps to them');
    assert.strictEqual(t.models[0].title, 'ANTHROPIC_MODEL in the gateway file');
    v.fire({ type: 'setModel', sid: x, value: 'opus' }); await flush();
    assert.deepStrictEqual([v.tab(x).model, v.tab(x).efforts.map((e) => e.value)], ['opus', ['', 'low', 'medium', 'high']]);
    v.fire({ type: 'setBackend', sid: x, value: 'subscription' }); await flush();
    assert.deepStrictEqual([v.tab(x).gateway, v.tab(x).model], [false, 'opus'], 'off the gateway an alias still means something, so it stays');
    m.perch.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- the Codex backend: the ChatGPT login, or an OpenAI API key kept in secret storage, for every Codex tab from its next turn
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([v.lastCodexMeter().backend, v.lastCodexMeter().backendLabel], ['chatgpt', 'ChatGPT']);
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    v.fire({ type: 'send', sid: x, text: 'hi' }); await flush();
    const a = created[created.length - 1];
    assert.deepStrictEqual([a.o.apiKey, v.lastTabs().tabs[0].backend], [undefined, 'chatgpt'], 'on the login: no key is given');
    // the switch asks for a key the first time, keeps it in secret storage, and moves the open tab
    v.fire({ type: 'meterToggle', vendor: 'codex' }); await flush(); await flush();
    assert.deepStrictEqual([m.ui.asked.pop().prompt, v.lastCodexMeter().backend], ['OpenAI API key for Codex', 'chatgpt'], 'no key given: nothing changes');
    m.ui.inputs.push('sk-test-0123456789abcdefghijklmnop'); v.fire({ type: 'meterToggle', vendor: 'codex' }); await flush(); await flush(); await flush();
    assert.deepStrictEqual([v.lastCodexMeter().backend, v.lastCodexMeter().backendLabel, v.lastCodexMeter().plan, v.lastCodexMeter().segments, m.globalState._dump()['perch.codex.backend'], await m.secrets.get('perch.codex.apiKey')],
      ['api', 'API', '', [], 'api', 'sk-test-0123456789abcdefghijklmnop'], 'on the key: no plan, no limits shown; the key is in secret storage, not in state');
    assert(!JSON.stringify(m.globalState._dump()).includes('sk-test'), 'and nowhere else');
    assert.deepStrictEqual([a.apiKeys, v.lastTabs().tabs[0].backend], [['sk-test-0123456789abcdefghijklmnop'], 'api'], 'the open tab takes the key for its next turn');
    assert(/Codex backend is now your OpenAI API key, from the next message/.test(v.events(x).filter((e) => e.kind === 'note').pop().text));
    v.fire({ type: 'new', kind: 'codex' }); const y = v.lastTabs().active; v.fire({ type: 'send', sid: y, text: 'hi' }); await flush();
    assert.strictEqual(created[created.length - 1].o.apiKey, 'sk-test-0123456789abcdefghijklmnop', 'a new tab starts with it');
    // and back, with the key kept for next time
    v.fire({ type: 'meterToggle', vendor: 'codex' }); await flush(); await flush();
    assert.deepStrictEqual([v.lastCodexMeter().backend, a.apiKeys.pop(), await m.secrets.get('perch.codex.apiKey')], ['chatgpt', null, 'sk-test-0123456789abcdefghijklmnop']);
    v.fire({ type: 'meterToggle', vendor: 'codex' }); await flush(); await flush();
    assert.deepStrictEqual([v.lastCodexMeter().backend, m.ui.asked.length], ['api', 1], 'the second switch to the key asks nothing');
    // forgetting the key puts Codex back on the login
    await m.commands['perch.codex.clearApiKey'](); await flush();
    assert.deepStrictEqual([v.lastCodexMeter().backend, await m.secrets.get('perch.codex.apiKey'), m.ui.infos.pop()], ['chatgpt', undefined, 'Perch: the Codex API key is gone; Codex uses your ChatGPT login.']);
    // with no login on the machine, the key is a way in: the first message is not held back
    m.box.codexLoggedIn = false; m.ui.inputs.push('sk-other-0123456789abcdefghijklmnop'); await m.commands['perch.codex.setApiKey'](); await flush();
    assert.strictEqual(m.ui.infos.pop(), 'Perch: Codex will use your API key from the next message.');
    v.fire({ type: 'new', kind: 'codex' }); const z = v.lastTabs().active; const made = created.length; v.fire({ type: 'send', sid: z, text: 'go' }); await flush();
    assert.deepStrictEqual([created.length, created[created.length - 1].o.apiKey, m.ui.warnings.length], [made + 1, 'sk-other-0123456789abcdefghijklmnop', 0]);
    m.box.codexLoggedIn = true;
    m.perch.dispose();
    // the key comes back from secret storage in a new window
    const r = install(undefined, { meter: { secrets: { 'perch.codex.apiKey': 'sk-kept-0123456789abcdefghijklmnop' } } }); await flush();
    const rv = fakeView(); r.registered['perch.main'].resolveWebviewView(rv.view); rv.fire({ type: 'ready' }); await flush();
    r.globalState.update('perch.codex.backend', 'api'); r.perch.meter.refreshCodex(); await flush();
    assert.strictEqual(rv.lastCodexMeter().backend, 'api');
    r.perch.dispose();
  }

  // ---- the page's copy button: the host puts the text on the clipboard
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'copy', text: 'git status --short' }); v.fire({ type: 'copy' }); await flush();
    assert.deepStrictEqual(m.ui.copied, ['git status --short', '']);
    // the page may open the vendors' own pages in the browser, and nothing else
    v.fire({ type: 'openExternal', url: 'https://chatgpt.com/codex/settings/usage' }); v.fire({ type: 'openExternal', url: 'https://claude.ai/settings/usage' });
    v.fire({ type: 'openExternal', url: 'https://evil.example/chatgpt.com/' }); v.fire({ type: 'openExternal', url: 'http://chatgpt.com/x' }); v.fire({ type: 'openExternal' }); await flush();
    assert.deepStrictEqual(m.ui.external, ['https://chatgpt.com/codex/settings/usage', 'https://claude.ai/settings/usage']);
    m.perch.dispose();
  }

  // ---- Codex's sandbox cannot start on the machine: the choice to run without one, for the tab or for the machine
  {
    const HOST = require('os').hostname(), BWRAP = 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. On e.g. debian this can be enabled with \'sysctl kernel.unprivileged_userns_clone=1\'.';
    const m = install(undefined, { remote: 'ssh-remote' }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    v.fire({ type: 'send', sid: x, text: 'what branch am i on?' }); await flush();
    const a = created[created.length - 1];
    a.emit({ kind: 'tool_use', id: 'c1', name: 'shell', input: { command: 'git status' } }); a.emit({ kind: 'tool_result', id: 'c1', text: BWRAP, isError: true }); await flush(); await flush();
    assert.strictEqual(m.ui.warnings.pop(), `Codex's sandbox cannot start on ${HOST}: the kernel forbids the user namespaces it needs, and Codex has no other sandbox on Linux. Codex can run here without one, as you, with approvals as perch.codex.approvalPolicy says.`);
    assert.deepStrictEqual([v.lastTabs().tabs.find((t) => t.id === x).mode, a.modes], ['workspace-write', []], 'declined: nothing changes');
    a.emit({ kind: 'tool_result', id: 'c2', text: BWRAP, isError: true }); await flush();
    assert.strictEqual(m.ui.warnings.length, 0, 'asked once per tab');
    // for this tab only
    v.fire({ type: 'new', kind: 'codex' }); const y = v.lastTabs().active; v.fire({ type: 'send', sid: y, text: 'ls' }); await flush();
    const b = created[created.length - 1]; m.ui.answers.push('Full Access, This Tab');
    b.emit({ kind: 'tool_result', id: 'c3', text: BWRAP, isError: true }); await flush(); await flush();
    assert.deepStrictEqual([v.lastTabs().tabs.find((t) => t.id === y).mode, b.modes, m.globalState._dump()['perch.codex.unsandboxed']], ['danger-full-access', ['danger-full-access'], undefined]);
    assert.strictEqual(v.events(y).filter((e) => e.kind === 'note').pop().text, 'Codex runs without a sandbox in this tab. Send the message again.');
    v.fire({ type: 'new', kind: 'codex' }); assert.strictEqual(v.lastTabs().tabs.find((t) => t.id === v.lastTabs().active).mode, 'workspace-write', 'other tabs are as before');
    // for the machine: remembered, and new Codex tabs here start without a sandbox and say so
    v.fire({ type: 'new', kind: 'codex' }); const z = v.lastTabs().active; v.fire({ type: 'send', sid: z, text: 'ls' }); await flush();
    const c = created[created.length - 1]; m.ui.answers.push(`Full Access on ${HOST}`);
    c.emit({ kind: 'tool_result', id: 'c4', text: BWRAP, isError: true }); await flush(); await flush();
    assert.deepStrictEqual([v.lastTabs().tabs.find((t) => t.id === z).mode, m.globalState._dump()['perch.codex.unsandboxed']], ['danger-full-access', { [HOST]: true }]);
    assert.strictEqual(v.events(z).filter((e) => e.kind === 'note').pop().text, `Codex runs without a sandbox in this tab, and in new tabs on ${HOST}. Send the message again.`);
    v.fire({ type: 'new', kind: 'codex' }); const w = v.lastTabs().active; await flush();
    assert.strictEqual(v.lastTabs().tabs.find((t) => t.id === w).mode, 'danger-full-access');
    assert.strictEqual(v.events(w).filter((e) => e.kind === 'note').pop().text, `Codex runs without a sandbox on ${HOST}: the kernel forbids the user namespaces its sandbox needs.`);
    v.fire({ type: 'new', kind: 'claude' }); assert.strictEqual(v.lastTabs().tabs.find((t) => t.id === v.lastTabs().active).mode, 'default', 'Claude tabs are untouched');
    m.perch.dispose();
  }

  // ---- Codex with no login on the machine: the first message is held back, the login offered, the text put back
  {
    const m = install(undefined, { meter: { codexLoggedIn: false }, remote: 'ssh-remote' }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active; const made = created.length;
    v.fire({ type: 'send', sid: x, text: 'hello' }); await flush(); await flush();
    assert.strictEqual(created.length, made, 'no agent is started: it would only be refused');
    assert(/^Codex is not logged in on .+\. Log in, then send the message again\.$/.test(v.events(x).filter((e) => e.kind === 'note').pop().text));
    assert.strictEqual(v.events(x).filter((e) => e.kind === 'insert').pop().text, 'hello', 'the message goes back into the box');
    assert(/^Codex is not logged in on .+\. Perch runs it with your ChatGPT login, kept in \/home\/me\/\.codex\. Log In opens ChatGPT's sign-in page in your browser\. Device Code prints a link and a one-time code in a terminal instead, which ChatGPT must allow first \(Settings, Security and login, App security\)\.$/.test(m.ui.warnings.pop()), 'and the offer says where the login lives, and the two ways');
    assert.deepStrictEqual([m.ui.terminals.length, m.box.codexWaits || 0, m.box.codexLogins], [0, 0, undefined], 'declined: nothing runs');
    // taken up: the browser sign-in runs here, its page opens on the user's machine, the return port is forwarded, and the login is watched for
    m.ui.answers.push('Log In'); v.fire({ type: 'send', sid: x, text: 'hello again' }); await flush(); await flush(); await flush(); await flush();
    assert.deepStrictEqual([m.box.codexLogins.length, /codex$/.test(m.box.codexLogins[0]), m.ui.forwarded, m.ui.external.pop(), m.ui.terminals.length, m.box.codexWaits, m.box.codexKilled, m.ui.infos.pop()],
      [1, true, ['http://localhost:1455'], 'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback', 0, 1, 1, 'Perch: Codex is logged in. Send your message again.'],
      'the program here, the page there, the port between, and the server let go once the login is in');
    v.fire({ type: 'send', sid: x, text: 'hello again' }); await flush(); await flush();
    assert.strictEqual(created.length, made + 1, 'logged in: the message goes to a Codex of its own');
    // the other way: the device code, in a terminal
    m.box.codexLoggedIn = false; m.ui.answers.push('Device Code'); v.fire({ type: 'new', kind: 'codex' }); const y = v.lastTabs().active;
    v.fire({ type: 'send', sid: y, text: 'hi' }); await flush(); await flush(); await flush();
    const t = m.ui.terminals.pop();
    assert.deepStrictEqual([t.o.name, t.sent.length, /login --device-auth$/.test(t.sent[0]), m.box.codexWaits, m.box.codexLogins.length], ['Codex login', 1, true, 2, 1]);
    // and the browser sign-in that cannot start says so
    m.box.codexLoggedIn = false; m.box.codexLoginFails = 'spawn ENOENT'; m.ui.answers.push('Log In'); v.fire({ type: 'send', sid: y, text: 'hi' }); await flush(); await flush(); await flush();
    assert.strictEqual(m.ui.errors.pop(), 'Perch: the Codex login could not start. spawn ENOENT');
    m.box.codexLoginFails = null; m.box.codexLoggedIn = true;
    // a login that expires later shows as 401 from the API; the same offer follows the error
    created[created.length - 1].emit({ kind: 'error', text: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' }); await flush();
    assert(/^Codex was refused: the login on .+ has expired or is missing\. Perch runs it/.test(m.ui.warnings.pop()));
    const w = m.ui.warnings.length; created[created.length - 1].emit({ kind: 'error', text: 'something else' }); await flush();
    assert.strictEqual(m.ui.warnings.length, w, 'other errors are not a login matter');
    m.perch.dispose();
  }

  // ---- names, and the sessions of the past
  {
    const NOW = Date.now(), MIN = 60000;
    const past = { sessions: [
      { kind: 'claude', id: 'c-old', title: 'Perch session name and loading', named: true, updatedAt: NOW - 2 * MIN },
      { kind: 'codex', id: 'x-old', title: 'hello', named: false, updatedAt: NOW - 26 * MIN },
      { kind: 'claude', id: 'c-older', title: 'supertrend', named: true, updatedAt: NOW - 40 * 24 * 60 * MIN },
    ] };
    const m = install(undefined, { past }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    const state = () => m.memento._dump()['perch.sessions.v1'];
    const made = created.length;

    // nothing open: renaming the active tab has nothing to act on
    await m.commands['perch.renameTab'](); v.fire({ type: 'rename', sid: 'nope' }); await flush();
    assert.deepStrictEqual([m.ui.asked.length, m.store.renamed], [0, []]);

    // the list: both agents' sessions of this folder, newest first, each with a button to rename it
    let list = await m.commands['perch.sessions']();
    assert.deepStrictEqual(m.store.lists.pop(), { dir: process.cwd(), limit: 200 }, 'the sessions of the workspace folder');
    assert.deepStrictEqual([list.shown, list.busy, list.placeholder, list.title], [true, false, 'Search sessions…', 'Perch sessions']);
    assert.deepStrictEqual(list.rows(), [['$(add) New Claude tab', undefined], ['$(add) New Codex tab', undefined], ['Perch session name and loading', 'Claude · 2m'], ['hello', 'Codex · 26m'], ['supertrend', 'Claude · 1mo']], 'a new tab of each kind first, then the past');
    assert.deepStrictEqual(list.items.filter((i) => i.past).map((i) => i.buttons.map((b) => [b.iconPath.id, b.tooltip])), Array(3).fill([['edit', 'Rename session']]));
    assert.deepStrictEqual(list.items.filter((i) => i.past).map((i) => i.iconPath.path || i.iconPath.dark.path), ['/ext/anthropic.claude-code/resources/claude-logo.svg', '/ext/openai.chatgpt/resources/blossom.dark.png', '/ext/anthropic.claude-code/resources/claude-logo.svg'], 'each under its vendor\'s icon, the one its editor tab carries');

    // renaming one that is not open writes to the agent's record, and the list comes back with the new name
    m.ui.inputs.push('  Codex   greeting ');
    await list.press((i) => i.past && i.past.id === 'x-old');
    assert.deepStrictEqual([m.ui.asked.pop().value, list.shown, list.disposed], ['hello', false, true], 'the box opens on the present name, in the list\'s place');
    assert.deepStrictEqual(m.store.renamed, [['codex', 'x-old', 'Codex greeting', { dir: process.cwd() }]]);
    assert.strictEqual(m.ui.lists.length, 2); list = m.ui.lists[1];
    assert.deepStrictEqual([list.shown, list.rows()[3]], [true, ['Codex greeting', 'Codex · 26m']]);
    assert.strictEqual(v.lastTabs().tabs.length, 0, 'renaming opens nothing');

    // dismissed, or left empty: nothing is written
    m.ui.inputs.push(undefined); await list.press((i) => i.past && i.past.id === 'c-old'); list = m.ui.lists[2];
    m.ui.inputs.push('   '); await list.press((i) => i.past && i.past.id === 'c-old'); list = m.ui.lists[3];
    assert.deepStrictEqual([m.store.renamed.length, m.ui.errors.length], [1, 0]);
    assert.deepStrictEqual([m.ui.asked[0].validateInput(' \n'), m.ui.asked[0].validateInput(' a ')], ['A name cannot be empty.', null]);

    // a record that cannot be written is said so
    m.store.failRename = 'EACCES: permission denied'; m.ui.inputs.push('nope'); await list.press((i) => i.past && i.past.id === 'c-old'); list = m.ui.lists[4];
    assert.strictEqual(m.ui.errors.pop(), 'Perch: the session could not be renamed. EACCES: permission denied');
    assert.strictEqual(list.rows()[2][0], 'Perch session name and loading'); m.store.failRename = null;

    // choosing one opens a tab on it, under its name; the agent starts on the first message, resuming that session
    list.choose((i) => i.past && i.past.id === 'c-old');
    assert.deepStrictEqual([list.shown, list.disposed], [false, true]);
    let t = v.lastTabs();
    assert.deepStrictEqual(t.tabs.map((x) => [x.kind, x.title, x.started]), [['claude', 'Perch session name and loading', false]]);
    const c = t.active;
    assert.deepStrictEqual(v.events(c).filter((e) => e.kind === 'note').map((e) => e.text), ['resumed claude session c-old · earlier transcript is not shown, the agent still has it']);
    assert.deepStrictEqual([state().sessions[0].resume, state().sessions[0].titled, state().counters], ['c-old', true, { claude: 0, codex: 0 }], 'saved like any tab; a resumed tab takes no number');
    assert.strictEqual(created.length, made, 'and costs nothing until it is used');
    v.fire({ type: 'send', sid: c, text: 'where were we' }); await flush();
    assert.deepStrictEqual([created.length - made, created[made].o.resume, v.tab(c).title], [1, 'c-old', 'Perch session name and loading'], 'the first message does not rename it');
    assert.deepStrictEqual(m.store.renamed.length, 1, 'a name that came from the record is not written back to it');

    // the list marks what is open, and choosing it goes to its tab instead of opening a second one
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    list = await m.commands['perch.sessions']();
    assert.deepStrictEqual(list.rows().slice(2).map((r) => r[1]), ['Claude · 2m · open', 'Codex · 26m', 'Claude · 1mo']);
    list.choose((i) => i.past && i.past.id === 'c-old');
    assert.deepStrictEqual([v.lastTabs().tabs.length, v.lastTabs().active], [2, c]);

    // renaming an open session from the list renames its tab too
    list = await m.commands['perch.sessions'](); m.ui.inputs.push('Naming and loading');
    await list.press((i) => i.past && i.past.id === 'c-old');
    assert.deepStrictEqual([v.tab(c).title, m.store.renamed.pop(), state().sessions[0].title, state().sessions[0].unsaved], ['Naming and loading', ['claude', 'c-old', 'Naming and loading', { dir: process.cwd() }], 'Naming and loading', false]);
    assert.strictEqual(m.ui.lists.pop().rows()[2][0], 'Naming and loading');

    // the active tab by command, and any sidebar tab by a double-click on it
    m.ui.inputs.push('Again'); await m.commands['perch.renameTab']();
    assert.deepStrictEqual([m.ui.asked.pop().value, v.tab(c).title, m.store.renamed.pop().slice(0, 3)], ['Naming and loading', 'Again', ['claude', 'c-old', 'Again']]);

    // a tab named before its first message: the agent has no record yet, so the name waits for the end of the first turn
    m.ui.inputs.push('Codex scratch'); v.fire({ type: 'rename', sid: x }); await flush();
    assert.deepStrictEqual([v.tab(x).title, m.store.renamed.length, state().sessions[1].unsaved], ['Codex scratch', 1, true]);
    v.fire({ type: 'send', sid: x, text: 'hold on' }); await flush();
    assert.deepStrictEqual([v.tab(x).title, m.store.renamed.length], ['Codex scratch', 1], 'the first message does not take the name back, and nothing is written mid-turn');
    list = await m.commands['perch.sessions'](); list.hide();
    const xAgent = created[created.length - 1]; xAgent.finish(); await flush();
    const xid = state().sessions[1].resume;
    assert.deepStrictEqual([m.store.renamed.pop(), state().sessions[1].unsaved], [['codex', xid, 'Codex scratch', { dir: process.cwd() }], false]);
    v.fire({ type: 'send', sid: x, text: 'more' }); await flush();
    assert.strictEqual(m.store.renamed.length, 1, 'written once');

    // a name that cannot reach the record stays on the tab, and is not tried again after every turn
    m.store.failRename = 'Session not found'; m.ui.inputs.push('Kept here'); v.fire({ type: 'rename', sid: x }); await flush();
    assert.deepStrictEqual([v.tab(x).title, m.ui.warnings.pop()], ['Kept here', 'Perch: this tab keeps its name, but Codex\'s record of the session could not be given it. Session not found']);
    v.fire({ type: 'send', sid: x, text: 'and more' }); await flush();
    assert.deepStrictEqual([m.ui.warnings.length, state().sessions[1].title], [0, 'Kept here']); m.store.failRename = null;

    // names survive a reload, waiting ones included
    v.fire({ type: 'new', kind: 'claude' }); const w = v.lastTabs().active;
    m.ui.inputs.push('Not started'); v.fire({ type: 'rename', sid: w }); await flush();
    m.perch.dispose();
    const m2 = install(m.memento._dump(), { past }); await flush();
    const v2 = fakeView(); m2.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v2.lastTabs().tabs.map((q) => q.title), ['Again', 'Kept here', 'Not started']);
    const before = created.length;
    v2.fire({ type: 'send', sid: w, text: 'first words' }); await flush();
    assert.deepStrictEqual([v2.tab(w).title, m2.store.renamed], ['Not started', [['claude', 'sess-' + before, 'Not started', { dir: process.cwd() }]]], 'written once the session exists');
    m2.perch.dispose();

    // an editor tab: the name is the tab's title
    const e = install(undefined, { past, config: { newTabs: 'editor' } }); await flush();
    list = await e.commands['perch.sessions'](); list.choose((i) => i.past && i.past.id === 'x-old');
    const panel = e.ui.panels[0];
    assert.deepStrictEqual([e.ui.panels.length, panel.title], [1, 'hello']);
    panel.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(panel.lastTabs().tabs.map((q) => [q.kind, q.title]), [['codex', 'hello']]);
    e.ui.inputs.push('Greeting'); await e.commands['perch.renameTab']();
    assert.deepStrictEqual([panel.title, panel.lastTabs().tabs[0].title, e.store.renamed], ['Greeting', 'Greeting', [['codex', 'x-old', 'Greeting', { dir: process.cwd() }]]]);
    list = await e.commands['perch.sessions'](); list.choose((i) => i.past && i.past.id === 'x-old');
    assert.deepStrictEqual([e.ui.panels.length, panel.reveals], [1, 1], 'the open tab is brought forward');
    e.perch.dispose();

    // nothing to list, and records that cannot be read
    const n = install(undefined, { past: { sessions: [] } }); await flush();
    assert.strictEqual((await n.commands['perch.sessions']()).placeholder, 'No past sessions in this folder');
    n.store.failed = ['claude', 'codex'];
    assert.strictEqual((await n.commands['perch.sessions']()).placeholder, 'The sessions of Claude Code and Codex could not be read');
    n.store.failed = ['codex']; n.store.sessions = past.sessions.slice(0, 1);
    list = await n.commands['perch.sessions']();
    assert.deepStrictEqual([list.title, list.items.filter((i) => i.past).length], ['Perch sessions · those of Codex could not be read', 1]);
    n.perch.dispose();
  }

  // ---- a resumed session shows what was said in it before
  {
    const said = [{ kind: 'user', text: 'how do i rename', queued: false }, { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { kind: 'tool_result', id: 't1', isError: false, text: 'src', truncated: false }, { kind: 'text', text: 'Like this.' }];
    const past = { sessions: [{ kind: 'claude', id: 'c-old', title: 'Renaming', named: true, updatedAt: Date.now() }, { kind: 'codex', id: 'x-old', title: 'hello', named: false, updatedAt: Date.now() - 1 }, { kind: 'codex', id: 'x-bad', title: 'broken', named: false, updatedAt: Date.now() - 2 }],
      transcripts: { 'c-old': { events: said, earlier: 0 }, 'x-old': { events: said.slice(3), earlier: 412 }, 'x-bad': new Error('unreadable') } };
    const m = install(undefined, { past }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    const shown = (sid) => { const e = v.events(sid); return e.slice(e.map((x) => x.kind).lastIndexOf('clear') + 1).filter((x) => x.kind !== 'busy' && x.kind !== 'status'); };

    (await m.commands['perch.sessions']()).choose((i) => i.past && i.past.id === 'c-old'); const c = v.lastTabs().active;
    assert.deepStrictEqual(shown(c), [{ kind: 'note', text: 'resumed claude session c-old · earlier transcript is not shown, the agent still has it' }], 'until it has been read');
    await flush();
    assert.deepStrictEqual(m.store.loads, [['claude', 'c-old', { dir: process.cwd() }]]);
    assert.deepStrictEqual(shown(c), said, 'the transcript, and nothing about it');

    // what is said now follows it, and a page made again is given all of it
    v.fire({ type: 'send', sid: c, text: 'and again' }); await flush();
    const v2 = fakeView(); m.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v2.events(c).filter((x) => ['user', 'text', 'note', 'tool_use', 'tool_result'].includes(x.kind)).map((x) => x.text || x.name), ['how do i rename', 'Bash', 'src', 'Like this.', 'and again', 'answer to and again']);

    // a long one shows its end, and says so; one that cannot be read leaves the note as it was
    (await m.commands['perch.sessions']()).choose((i) => i.past && i.past.id === 'x-old'); const x = v2.lastTabs().active; await flush();
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'text' || e.kind === 'note').slice(-2), [{ kind: 'note', text: '412 earlier entries are not shown, the agent still has them' }, { kind: 'text', text: 'Like this.' }], 'said before them, where they would have been');
    (await m.commands['perch.sessions']()).choose((i) => i.past && i.past.id === 'x-bad'); const b = v2.lastTabs().active; await flush();
    assert.deepStrictEqual(v2.events(b).filter((e) => e.kind === 'note'), [{ kind: 'note', text: 'resumed codex session x-bad · earlier transcript is not shown, the agent still has it' }]);

    // a message sent before the transcript has been read stays after it
    const m3 = install(undefined, { past }); await flush();
    const v3 = fakeView(); m3.registered['perch.main'].resolveWebviewView(v3.view); v3.fire({ type: 'ready' }); await flush();
    (await m3.commands['perch.sessions']()).choose((i) => i.past && i.past.id === 'c-old'); const c3 = v3.lastTabs().active;
    v3.fire({ type: 'send', sid: c3, text: 'too quick' }); await flush(); await flush();
    assert.deepStrictEqual(shown.call(null, c3).length >= 0 && v3.events(c3).slice(v3.events(c3).map((e) => e.kind).lastIndexOf('clear') + 1).filter((e) => ['user', 'text', 'note'].includes(e.kind)).map((e) => e.text), ['how do i rename', 'Like this.', 'too quick', 'answer to too quick']);

    // after a window reload the tabs come back with their transcripts, from the record
    m.perch.dispose(); m3.perch.dispose();
    const r = install(m.memento._dump(), { past }); await flush();
    const vr = fakeView(); r.registered['perch.main'].resolveWebviewView(vr.view); vr.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(r.store.loads.map((l) => l.slice(0, 2)), [['claude', 'c-old'], ['codex', 'x-old'], ['codex', 'x-bad']]);
    assert.deepStrictEqual(vr.events(c).filter((e) => e.kind === 'text' || e.kind === 'note').map((e) => e.text).slice(-1), ['Like this.']);
    r.perch.dispose();
  }

  // ---- after a reload, a tab behind another has no page until it is shown: its session is not given a second tab
  {
    const saved = { 'perch.sessions.v1': { active: null, counters: { claude: 2, codex: 1 }, sessions: [
      { id: 's1', kind: 'claude', title: 'Naming', titled: true, resume: 'c-1', location: 'editor', paneled: true },
      { id: 's2', kind: 'codex', title: 'Review', titled: true, resume: 'x-1', location: 'editor', paneled: true },
      { id: 's3', kind: 'claude', title: 'Naming', titled: true, resume: 'c-2', location: 'editor', paneled: true },
      { id: 's4', kind: 'claude', title: 'Lost', titled: true, resume: 'c-3', location: 'editor', paneled: true }] } };
    const m = install(saved, { config: { newTabs: 'editor' } });
    // VS Code kept four tabs. One is shown, and is given its page; of the rest, one was left working when the window closed
    m.waitingTab('Naming'); m.waitingTab('Review \u2026'); m.waitingTab('\u25cf Naming');
    const shown = m.ui.waiting.pop(); const p3 = m.restorePanel('s3', shown.label);
    await wait(120);
    assert.deepStrictEqual(m.ui.panels.filter((p) => !p.disposed).map((p) => p.title), ['Naming', 'Lost'], 'only the session with no tab at all is given one');
    assert.deepStrictEqual(m.ui.closedTabs, []);

    // clicked, a waiting tab is given its page, and is the session's one tab
    const w1 = m.ui.waiting.shift(); const p1 = m.restorePanel('s1', w1.label);
    assert.deepStrictEqual([p1.disposed, m.perch.panels.get('s1').panel === p1, m.ui.panels.filter((p) => !p.disposed).length], [false, true, 3]);

    // gone to from elsewhere while its tab still waits: the new tab takes the place of the waiting one
    m.perch.activate('s2'); await flush();
    assert.deepStrictEqual([m.ui.closedTabs, m.ui.waiting.length, m.ui.panels.filter((p) => !p.disposed).map((p) => p.title)], [['Review \u2026'], 0, ['Naming', 'Lost', 'Naming', 'Review']]);
    m.perch.activate('s2'); m.perch.activate('s1'); await flush();
    assert.deepStrictEqual([m.ui.closedTabs.length, m.ui.panels.filter((p) => !p.disposed).length], [1, 4], 'a tab with a page is only brought forward');
    assert(p3 && !p3.disposed);
    m.perch.dispose();
  }

  // ---- what an agent reports beyond working and ready is part of the transcript
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    v.fire({ type: 'send', sid: c, text: 'hold' }); await flush();
    const a = created[created.length - 1], since = v.tab(c).busySince;
    assert(v.tab(c).busy && since > Date.now() - 5000 && since <= Date.now(), 'a working tab says since when');
    for (const text of ['context compacted', 'rate limit: rejected', 'ready', 'working', 'ready · fake', 'idle']) a.emit({ kind: 'status', text });
    assert.deepStrictEqual(v.events(c).filter((e) => e.kind === 'note').map((e) => e.text), ['context compacted', 'rate limit: rejected']);
    a.finish(); await flush();
    assert.deepStrictEqual([v.tab(c).busy, v.tab(c).busySince], [false, 0]);
    const v2 = fakeView(); m.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'note').map((e) => e.text), ['context compacted', 'rate limit: rejected'], 'and is there when the page is made again');
    m.perch.dispose();
  }

  // ---- a group of sessions only is locked, so a file opened from the Explorer goes to the group beside it
  {
    const perchTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-perch.session' } }), file = { label: 'a.js', input: { uri: {} } };
    const locks = (m) => m.ui.executed.filter((c) => c === 'workbench.action.lockEditorGroup').length;
    const m = install(undefined, { config: { newTabs: 'editor' } }); await flush();
    m.ui.group = () => ({ viewColumn: 2, tabs: [perchTab('Claude 1')] });
    await m.commands['perch.newClaude'](); await flush();
    assert.strictEqual(locks(m), 1, 'locked when its first session opens');
    m.ui.group = () => ({ viewColumn: 2, tabs: [perchTab('Claude 1'), file] });
    m.ui.panels[0].show(true, true); await flush();
    assert.strictEqual(locks(m), 1, 'a group the user keeps files in as well is left as it is');
    m.ui.group = () => ({ viewColumn: 2, tabs: [perchTab('Claude 1'), perchTab('Codex 1')] });
    m.ui.panels[0].show(true, false); await flush(); assert.strictEqual(locks(m), 1, 'shown but not focused: the active group is another');
    m.ui.panels[0].show(true, true); await flush(); assert.strictEqual(locks(m), 2, 'and a group brought back after a reload is locked when it is next used');
    m.changeConfig({ lockGroup: false }); m.ui.panels[0].show(true, true); await flush();
    assert.strictEqual(locks(m), 2, 'not if the user would rather not');

    // a file opened from an answer goes beside the sessions too
    m.ui.group = null; m.perch.openTarget('src/extension.js'); await flush(); await flush();
    assert.deepStrictEqual(m.ui.columns, [-2], 'with no other group, a new one beside');
    m.perch.dispose();
  }

  // ---- the program an agent runs: the user's choice, else the SDK's own, which this checkout has
  {
    const m = install(undefined, { config: { 'codex.executable': '/opt/codex' } }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    const from = created.length;
    v.fire({ type: 'new', kind: 'codex' }); v.fire({ type: 'send', sid: v.lastTabs().active, text: 'hi' });
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active; v.fire({ type: 'send', sid: c, text: 'hi' }); await flush();
    assert.deepStrictEqual([created[from].o.executable, created[from + 1].o.executable], ['/opt/codex', undefined]);
    assert(!v.events(c).some((e) => e.kind === 'error'));
    m.perch.dispose();
  }

  // ---- a question from Claude: the answers go back to the agent, and the transcript keeps what was answered
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active; const s = m.perch.get(c);
    const Q = [{ question: 'Which store?', header: 'Store', options: [{ label: 'Redis', description: '' }, { label: 'S3', description: '' }] }];
    v.fire({ type: 'new', kind: 'claude' });   // another tab is active: the question raises attention
    const asked = new Promise((res) => s.pending.set('q1', res)); s.post({ kind: 'question', id: 'q1', questions: Q });
    assert.strictEqual(v.tab(c).attention, true);
    v.fire({ type: 'permission', sid: c, id: 'q1', decision: 'answer', answers: { 'Which store?': ' S3 ', extra: 42, '': 'x', blank: '  ' } });
    assert.deepStrictEqual(await asked, { decision: 'answer', answers: { 'Which store?': 'S3' } }, 'answers are text, by question, and nothing else');
    assert.strictEqual(v.tab(c).attention, false);
    const v2 = fakeView(); m.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'answered' || e.kind === 'question'), [{ kind: 'answered', questions: Q, answers: { 'Which store?': 'S3' } }], 'a page made again sees the question settled');
    // no answers at all is a refusal, and a skipped question is one too
    const q2 = new Promise((res) => s.pending.set('q2', res)); s.post({ kind: 'question', id: 'q2', questions: Q });
    v.fire({ type: 'permission', sid: c, id: 'q2', decision: 'answer', answers: { 'Which store?': '' } });
    assert.deepStrictEqual(await q2, { decision: 'deny', answers: {} });
    const q3 = new Promise((res) => s.pending.set('q3', res)); s.post({ kind: 'question', id: 'q3', questions: Q });
    v.fire({ type: 'permission', sid: c, id: 'q3', decision: 'deny' });
    assert.deepStrictEqual(await q3, { decision: 'deny' });
    assert.deepStrictEqual(s.history.filter((h) => h.kind === 'answered').map((h) => h.answers), [{ 'Which store?': 'S3' }, {}, {}]);
    m.perch.dispose();
  }

  // ---- a link in an answer that names a file opens it
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    const here = require('path').join(process.cwd(), 'src/extension.js');
    for (const target of ['src/extension.js', 'src/extension.js#L42', 'src/extension.js#L42-L51', 'src/extension.js:7', 'src/extension.js:7:3', here + '#L2', 'file://' + here, 'src/extension%2Ejs']) { v.fire({ type: 'open', target }); await flush(); }
    assert.deepStrictEqual(m.ui.opened, [[here, null], [here, [41, 41]], [here, [41, 50]], [here, [6, 6]], [here, [6, 6]], [here, [1, 1]], [here, null], [here, null]]);
    for (const target of ['src/nowhere.js', 'src', 'javascript:alert(1)', '../../../../../../nonexistent/x', '', undefined]) { v.fire({ type: 'open', target }); await flush(); }
    assert.strictEqual(m.ui.opened.length, 8, 'only a file that is there is opened');
    assert.deepStrictEqual(m.ui.warnings.slice(0, 2), ['Perch: src/nowhere.js is not a file in this workspace.', 'Perch: src is not a file in this workspace.']);
    m.perch.dispose();
  }

  // ---- past 20 images a Claude conversation is held to a size limit: the tab says so at the twentieth, once
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    const P = { mime: 'image/png', data: 'iVBORw0KGgo=' }, notes = () => v.events(c).filter((e) => e.kind === 'note').map((e) => e.text);
    for (let i = 0; i < 6; i++) v.fire({ type: 'send', sid: c, text: 'shot ' + i, images: [P, P, P] });   // 18
    await flush(); assert.deepStrictEqual(notes(), []);
    v.fire({ type: 'send', sid: c, text: 'two more', images: [P, P] }); await flush();                    // 20
    assert.deepStrictEqual(notes(), ['This conversation now carries 20 images. Past 20, the API refuses a conversation holding any image 2000 px or wider, which images from earlier versions of perch or from Claude Code\'s own reading may be. If a turn then fails with "an image could not be processed", /compact lets the earlier images go.']);
    v.fire({ type: 'send', sid: c, text: 'words only' }); await flush(); assert.strictEqual(notes().length, 1, 'a message without an image says nothing');
    v.fire({ type: 'send', sid: c, text: 'one over', images: [P] }); await flush();
    assert.strictEqual(notes().length, 1, 'said once: images pasted here are within the limit');
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    for (let i = 0; i < 8; i++) v.fire({ type: 'send', sid: x, text: 'x' + i, images: [P, P, P] }); await flush();
    assert.deepStrictEqual(v.events(x).filter((e) => e.kind === 'note'), [], 'Codex is not held to it');
    m.perch.dispose();
  }

  // ---- the session's cost so far is kept with the tab, so after a reload the agent can still tell each turn's own cost
  {
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active; const s = m.perch.get(c);
    v.fire({ type: 'send', sid: c, text: 'hi' }); await flush();
    assert.strictEqual(created[created.length - 1].o.costBefore, undefined, 'a new session has no cost yet');
    s.post({ kind: 'result', ok: true, cost: 1.25, costTurn: 1.25 }); s.post({ kind: 'result', ok: true, cost: 1.5, costTurn: 0.25 }); s.post({ kind: 'result', ok: true });
    assert.strictEqual(m.memento._dump()['perch.sessions.v1'].sessions[0].costSoFar, 1.5, 'the last figure reported is saved; a result without one changes nothing');
    m.perch.dispose();
    const r = install(m.memento._dump()); await flush();
    const vr = fakeView(); r.registered['perch.main'].resolveWebviewView(vr.view); vr.fire({ type: 'ready' }); await flush();
    vr.fire({ type: 'send', sid: c, text: 'again' }); await flush();
    assert.strictEqual(created[created.length - 1].o.costBefore, 1.5, 'and handed to the agent when the tab resumes');
    r.perch.dispose();
  }

  // ---- the prompt cache is warm from each response of a turn, not only from the turn's end: a long turn must not read "cold" throughout
  {
    const { ClaudeAgent } = require('module').prototype.require.call(module, '../src/claudeAgent.js');
    const out = [], a = { live: '', emit: (e) => out.push(e) };
    ClaudeAgent.prototype._onMessage.call(a, { type: 'stream_event', event: { type: 'message_start' } });
    assert.deepStrictEqual([out.length, out[0].kind, typeof out[0].at], [1, 'responded', 'number'], 'a response has begun: the request that brought it touched the cache');
    ClaudeAgent.prototype._onMessage.call(a, { type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: 'toolu_1' });
    assert.strictEqual(out.length, 1, 'a subagent\'s request is another conversation\'s cache');
    ClaudeAgent.prototype._onMessage.call(a, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
    assert.deepStrictEqual(out.slice(1), [{ kind: 'delta', text: 'x' }], 'the text of a response does not restart the clock again');
  }

  // ---- the real Claude agent takes Claude Code's word on whether a turn runs: a lost result must not leave a tab working
  {
    const { ClaudeAgent } = require('module').prototype.require.call(module, '../src/claudeAgent.js');
    const out = [], a = { running: true, pending: 2, emit: (e) => out.push(e), _context() {}, _state: ClaudeAgent.prototype._state };
    ClaudeAgent.prototype._onMessage.call(a, { type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
    assert.deepStrictEqual([a.running, a.pending, out], [true, 2, []], 'waiting on the user is still a running turn');
    ClaudeAgent.prototype._onMessage.call(a, { type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.deepStrictEqual([a.running, a.pending, out], [false, 0, [{ kind: 'busy', busy: false }]], 'idle ends the turn whatever the count says');
    ClaudeAgent.prototype._onMessage.call(a, { type: 'system', subtype: 'session_state_changed', state: 'idle' });
    assert.strictEqual(out.length, 1, 'said once');
    ClaudeAgent.prototype._onMessage.call(a, { type: 'system', subtype: 'session_state_changed', state: 'running' });
    assert.deepStrictEqual([a.running, a.pending, out[1]], [true, 1, { kind: 'busy', busy: true }], 'a turn Claude Code starts on its own is shown too');
  }

  // ---- pasted images go with the message, to either agent
  {
    const PNG = { mime: 'image/png', data: 'iVBORw0KGgo=' }, JPG = { mime: 'image/jpeg', data: '/9j/4AAQ' };
    const m = install(); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    const from = created.length;
    v.fire({ type: 'new', kind: 'claude' }); const c = v.lastTabs().active;
    v.fire({ type: 'send', sid: c, text: 'what is wrong here', images: [PNG, JPG] }); await flush();
    const ca = created[from];
    assert.deepStrictEqual([ca.sent, ca.images], [['what is wrong here'], [[PNG, JPG]]]);
    assert.deepStrictEqual(v.events(c).filter((e) => e.kind === 'user'), [{ kind: 'user', text: 'what is wrong here', queued: false, images: 2 }], 'the transcript says how many, and does not hold them');
    // a thumbnail the page made travels with the message into the transcript; a bad one is dropped, the image itself never kept
    const T = 'data:image/jpeg;base64,/9j/4AAQ';
    v.fire({ type: 'send', sid: c, text: 'thumbs', images: [Object.assign({ thumb: T }, PNG), Object.assign({ thumb: 'javascript:x' }, JPG), Object.assign({ thumb: 'data:image/jpeg;base64,' + 'A'.repeat(90000) }, PNG)] }); await flush();
    const ut = v.events(c).filter((e) => e.kind === 'user').pop();
    assert.deepStrictEqual([ut.images, ut.thumbs, ca.images[1]], [3, [T, '', ''], [PNG, JPG, PNG]]);
    assert.deepStrictEqual(m.perch.get(c).history.filter((h) => h.kind === 'user').pop().thumbs, [T, '', ''], 'kept for a page made again');
    assert(!JSON.stringify(m.memento._dump()).includes(PNG.data), 'nor does what is saved');
    // the thumbnails are saved with the tab, and after a reload rejoin the messages the record says had images
    const st = m.memento._dump()['perch.sessions.v1'].sessions.find((s) => s.id === c);
    assert.deepStrictEqual(st.kept, [['', ''], [T, '', '']], 'one entry per message sent with images, oldest first');
    {
      const events = [{ kind: 'user', text: 'what is wrong here', queued: false, images: 2 }, { kind: 'text', text: 'nothing' }, { kind: 'user', text: 'thumbs', queued: false, images: 3 }, { kind: 'text', text: 'three' }];
      const r = install(m.memento._dump(), { past: { transcripts: { [st.resume]: { events, earlier: 0 } } } }); await flush();
      const vr = fakeView(); r.registered['perch.main'].resolveWebviewView(vr.view); vr.fire({ type: 'ready' }); await flush(); await flush();
      assert.deepStrictEqual(vr.events(c).filter((e) => e.kind === 'user').map((e) => e.thumbs), [undefined, [T, '', '']], 'the last message with images has its thumbnails back; one whose thumbnails were all dropped has none');
      // when the record holds more image messages than were saved with the tab, the saved ones go to the latest
      const r2 = install(m.memento._dump(), { past: { transcripts: { [st.resume]: { events: [{ kind: 'user', text: 'older', queued: false, images: 1 }, ...events], earlier: 0 } } } }); await flush();
      const v2 = fakeView(); r2.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush(); await flush();
      assert.deepStrictEqual(v2.events(c).filter((e) => e.kind === 'user').map((e) => e.thumbs), [undefined, undefined, [T, '', '']]);
      // what is saved is bounded: the oldest thumbnails go once they weigh too much
      const s2 = r2.perch.get(c); for (let i = 0; i < 3; i++) s2.keep(['data:image/jpeg;base64,' + 'A'.repeat(700000)]);
      assert.deepStrictEqual([s2.kept.length, s2.kept[0][0].length > 100000], [2, true], 'about 1.5 MB in all');
      r.perch.dispose(); r2.perch.dispose();
    }

    // an image with no words is a message; it does not name the tab
    v.fire({ type: 'new', kind: 'claude' }); const c2 = v.lastTabs().active;
    v.fire({ type: 'send', sid: c2, text: '', images: [PNG] }); await flush();
    assert.deepStrictEqual([created[from + 1].sent, created[from + 1].images, v.tab(c2).title], [[''], [[PNG]], 'Claude 2']);
    v.fire({ type: 'send', sid: c2, text: 'and now in words' }); await flush();
    assert.deepStrictEqual([v.tab(c2).title, created[from + 1].images[1]], ['and now in words', []], 'the first words do');
    v.fire({ type: 'send', sid: c2, text: '  ', images: [] }); v.fire({ type: 'send', sid: c2, text: '' }); await flush();
    assert.strictEqual(created[from + 1].sent.length, 2, 'nothing at all is still not a message');

    // what cannot be sent is left out, and said
    const big = { mime: 'image/png', data: 'A'.repeat(5000001) };
    v.fire({ type: 'send', sid: c, text: 'mixed', images: [PNG, { mime: 'image/svg+xml', data: 'PHN2Zz4=' }, big, { mime: 'image/png', data: 'not base64!' }, { mime: 'image/png' }, null, 'x', JPG] }); await flush();
    assert.deepStrictEqual(ca.images[2], [PNG, JPG]);
    assert.strictEqual(v.events(c).filter((e) => e.kind === 'note').pop().text, '6 images left out: a message takes 8 images, each a PNG, JPEG, GIF, or WebP of up to 5 MB');
    v.fire({ type: 'send', sid: c, text: 'many', images: Array(10).fill(PNG) }); await flush();
    assert.deepStrictEqual([ca.images[3].length, v.events(c).filter((e) => e.kind === 'note').pop().text.slice(0, 18)], [8, '2 images left out:']);
    v.fire({ type: 'send', sid: c, text: '', images: [big] }); await flush();
    assert.strictEqual(ca.sent.length, 4, 'a message whose only image cannot be sent is not sent empty');
    v.fire({ type: 'send', sid: c, text: 'odd', images: 'nonsense' }); await flush();
    assert.deepStrictEqual(ca.images[4], []);

    // Codex: with the IDE context, and through the queue
    v.fire({ type: 'new', kind: 'codex' }); const x = v.lastTabs().active;
    v.fire({ type: 'send', sid: x, text: 'hold this', images: [PNG] }); await flush();
    const xa = created[created.length - 1];
    assert.deepStrictEqual([xa.sent, xa.images, xa.shownAs], [['hold this'], [[PNG]], [{ text: 'hold this', tag: undefined }]]);
    v.fire({ type: 'send', sid: x, text: 'next', images: [JPG, PNG] }); await flush();
    assert.deepStrictEqual(v.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'next', queued: true, images: 2 });
    v.fire({ type: 'send', sid: x, text: 'with thumb', images: [Object.assign({ thumb: T }, PNG)] }); await flush();
    assert.deepStrictEqual(v.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'with thumb', queued: true, images: 1, thumbs: [T] }, 'a queued Codex message shows its thumbnail at once');
    assert.strictEqual(xa.sent.length, 1, 'waiting behind the turn');
    xa.finish(); await flush(); await flush();
    assert.deepStrictEqual([xa.sent, xa.images[1]], [['hold this', 'next', 'with thumb'], [JPG, PNG]], 'a queued message keeps its images');
    m.perch.dispose();

    // the real Codex agent hands images over as files, and takes them away with it
    const fs = require('fs'), { CodexAgent } = require('module').prototype.require.call(module, '../src/codexAgent.js');
    const a = { imageDir: null, imageCount: 0, turnAbort: null };
    const input = CodexAgent.prototype._input.call(a, 'look', [PNG, JPG]);
    assert.deepStrictEqual(input.map((i) => [i.type, i.text || require('path').basename(i.path)]), [['text', 'look'], ['local_image', '1.png'], ['local_image', '2.jpg']]);
    assert.deepStrictEqual(fs.readFileSync(input[1].path), Buffer.from(PNG.data, 'base64'));
    assert.deepStrictEqual(CodexAgent.prototype._input.call(a, '  ', [PNG]).map((i) => [i.type, require('path').basename(i.path)]), [['local_image', '3.png']], 'no words, no text part; files are never reused');
    const dir = a.imageDir; CodexAgent.prototype.dispose.call(a);
    assert.deepStrictEqual([fs.existsSync(dir), a.imageDir], [false, null]);
  }

  // ======================================================================== a Claude tab on the gateway
  // The gateway is a tab's own backend: its process gets the variables of the user's env file, and the window's switch does
  // not touch it. The file here is a throwaway; the stub points every other test at a path that does not exist, so the
  // developer's own gateway file is never read.
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-host-gw-')), file = path.join(tmp, 'env');
    try {
      const m = install(undefined, { config: { 'claude.gatewayEnv': file } }); await flush();
      const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
      // no file yet: nothing offers a tab on the gateway, but the command and the footer's menu still lead to one
      assert.deepStrictEqual(v.lastTabs().gateway, { file, exists: false, ok: false }, 'every tabs message says where the file is and whether there is one');
      assert.deepStrictEqual(m.ui.contexts, [['perch.gateway', false]], 'the title menus are told to hide their gateway entry');
      m.picks.push((i) => i.gateway); assert.strictEqual(await m.commands['perch.new'](), null, 'the quick pick has no gateway entry');
      await m.commands['perch.newClaudeGateway']();
      let t = v.lastTabs(); const g = t.tabs[0].id;
      assert.deepStrictEqual([t.tabs[0].title, t.tabs[0].gateway, t.tabs[0].gatewayWarn, t.tabs[0].backend, t.tabs[0].cache.minutes], ['Claude 1', true, true, '', 5], 'a tab on the gateway, flagged while there is no file; its cache lifetime is the API\'s five minutes');
      // the first message is held, and Open the File makes the file from the template
      const n0 = created.length;
      m.ui.answers.push('Open the File');
      v.fire({ type: 'send', sid: g, text: 'hello gateway' }); await flush(); await flush();
      assert.strictEqual(created.length, n0, 'no process is started');
      assert(v.events(g).some((e) => e.kind === 'note' && e.text === `This tab is on the gateway, but ${file} does not exist. Fill it in, or take this tab off the gateway, then send the message again.`), 'the tab says why');
      assert(v.events(g).some((e) => e.kind === 'insert' && e.text === 'hello gateway'), 'the message is put back in the box');
      assert.deepStrictEqual(v.events(g).filter((e) => e.kind === 'note').pop().actions, [{ id: 'gatewayFile', label: 'Open the File' }, { id: 'gatewayLeave', label: 'Leave the Gateway' }], 'and the ways on are buttons under the note, which stay when the notification has gone');
      assert(/^This tab is on the LLM gateway, but .* does not exist\. Perch gives a tab on the gateway the variables in that file/.test(m.ui.warnings.pop()));
      assert.deepStrictEqual(m.ui.opened.pop(), [file, null], 'the file is opened in the editor');
      assert.strictEqual(fs.readFileSync(file, 'utf8').split('\n')[2], 'export ANTHROPIC_BASE_URL=', 'made from the template');
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'for its owner only');
      // with a file, the gateway is on offer; the tab stays flagged until the file is filled in
      v.fire({ type: 'activate', sid: g }); t = v.lastTabs();
      assert.deepStrictEqual([t.gateway.exists, t.gateway.ok, t.tabs[0].gatewayWarn], [true, false, true]);
      assert.deepStrictEqual(m.ui.contexts.pop(), ['perch.gateway', true], 'and the title menus show their entry');
      m.picks.push((i) => i.kind === 'claude'); const s1 = await m.commands['perch.new'](); assert.deepStrictEqual([s1.kind, s1.gateway, s1.title], ['claude', false, 'Claude 2'], 'the quick pick offers Claude; the gateway is a choice in the tab\'s backend menu');
      m.perch.closeSession(s1.id); const s2 = m.perch.addSession('claude', { gateway: true }); assert.deepStrictEqual([s2.kind, s2.gateway, s2.title], ['claude', true, 'Claude 3']);
      m.perch.closeSession(s2.id);
      // the note's own buttons: the file again (it exists now, and is opened as it is), and this tab off the gateway and back
      v.fire({ type: 'noteAction', sid: g, action: 'gatewayFile' }); await flush();
      assert.deepStrictEqual(m.ui.opened.pop(), [file, null], 'the note\'s button opens the file');
      v.fire({ type: 'noteAction', sid: g, action: 'gatewayLeave' }); assert.strictEqual(v.lastTabs().tabs[0].gateway, false, 'and its other button takes the tab off the gateway');
      v.fire({ type: 'noteAction', sid: g, action: 'gatewayLeave' }); v.fire({ type: 'noteAction', sid: g, action: 'bogus' }); assert.strictEqual(v.lastTabs().tabs[0].gateway, false, 'pressed again, or junk: nothing');
      v.fire({ type: 'setBackend', sid: g, value: 'gateway' }); assert.strictEqual(v.lastTabs().tabs[0].gateway, true);
      m.ui.answers.push('Leave the Gateway');
      v.fire({ type: 'send', sid: g, text: 'again' }); await flush(); await flush();
      assert(/sets no ANTHROPIC_BASE_URL\. Perch gives/.test(m.ui.warnings.pop()), 'an empty file is named for what it lacks');
      assert.deepStrictEqual([created.length, v.lastTabs().tabs[0].gateway], [n0, false], 'no process; the tab is taken off the gateway at the user\'s word');
      // back on, from the footer's menu, with a usable file: the process gets the file's variables, with Bedrock off
      v.fire({ type: 'setBackend', sid: g, value: 'gateway' });
      assert.strictEqual(v.lastTabs().tabs[0].gateway, true);
      fs.writeFileSync(file, 'export ANTHROPIC_BASE_URL=https://gw.example.com/llm-api\nexport ANTHROPIC_AUTH_TOKEN="tok"   # mine\nexport ANTHROPIC_MODEL=nexus-auto[1m]\n');
      v.fire({ type: 'send', sid: g, text: 'hello gateway' });
      assert.strictEqual(created.length, n0 + 1, 'a process starts');
      const agent = created[n0];
      assert.deepStrictEqual(agent.o.env, { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'https://gw.example.com/llm-api', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'nexus-auto[1m]' }, 'the file\'s variables, and Bedrock off');
      assert.strictEqual(agent.o.model, undefined, 'the tab on default sends no model: the file\'s ANTHROPIC_MODEL decides');
      assert.deepStrictEqual(agent.o.gateway, { target: 'https://gw.example.com/llm-api' }, 'the process runs through the relay to the file\'s base URL');
      t = v.lastTabs();
      assert.deepStrictEqual([t.tabs[0].backend, t.tabs[0].gatewayWarn, t.tabs[0].started, t.gateway.ok, t.tabs[0].cache.minutes], ['gateway', false, true, true, 5]);
      // what answered: the relay's word on each response, counted for the turn and put on the result; the last one on the tab
      assert.deepStrictEqual(t.tabs[0].models[0], { value: '', label: 'default · nexus-auto[1m]', title: 'ANTHROPIC_MODEL in the gateway file' }, 'the default is the file\'s model, not the window\'s');
      assert.strictEqual(t.tabs[0].via, 'global.openai.gpt-6-luna', 'the model that answered last');
      const res = v.events(g).filter((e) => e.kind === 'result').pop();
      assert.deepStrictEqual(res.via, [{ model: 'global.openai.gpt-6-luna', short: 'gpt-6-luna', n: 2 }, { model: 'xai/grok-4.6', short: 'grok-4.6', n: 1 }], 'three requests, two models, on the result line');
      assert(!v.events(g).some((e) => e.kind === 'relay'), 'the relay\'s own events stay in the host');
      const near = (a, b) => Math.abs(a - b) < 1e-9;
      assert(near(res.gatewayCost, 0.0003) && near(res.gatewayCostSoFar, 0.0003), 'the gateway\'s figures for the turn\'s three requests, summed, and the session\'s so far');
      v.fire({ type: 'send', sid: g, text: 'and again' });
      const res2 = v.events(g).filter((e) => e.kind === 'result').pop();
      assert.deepStrictEqual(res2.via.map((x) => x.n), [2, 1], 'counted per turn, not since the tab opened');
      assert(near(res2.gatewayCost, 0.0003) && near(res2.gatewayCostSoFar, 0.0006), 'the turn\'s figure starts over; the session\'s accumulates');
      assert(near(m.memento._dump()['perch.sessions.v1'].sessions[0].gatewayCost, 0.0006), 'and is saved with the tab');
      // each response's token counts, priced at the model that answered it: two on Luna, one on Grok (the fake agent's 1000 in, 100 out each)
      const lunaReq = 1000 * 1e-7 + 100 * 5e-7, grokReq = 1000 * 2e-6 + 100 * 6e-6;
      assert(near(res2.gatewayEstimate, 2 * lunaReq + grokReq) && near(res2.gatewayEstimateSoFar, 2 * (2 * lunaReq + grokReq)), 'the turn at list prices for what answered, and the session so far; beside the gateway\'s own figure, which the page prefers');
      assert.strictEqual(res2.keySpend, 0.5, 'what the gateway says the token has spent in all');
      assert(near(m.memento._dump()['perch.sessions.v1'].sessions[0].gatewayEstimate, 2 * (2 * lunaReq + grokReq)), 'saved with the tab');
      // a streamed response carries no price from the gateway: the estimate is what the turn has
      knobs.relayCost = null;
      try {
        v.fire({ type: 'send', sid: g, text: 'streamed' });
        const res3 = v.events(g).filter((e) => e.kind === 'result').pop();
        assert.deepStrictEqual([res3.gatewayCost, near(res3.gatewayEstimate, 2 * lunaReq + grokReq)], [undefined, true], 'no figure from the gateway; the estimate stands alone');
      } finally { knobs.relayCost = 0.0001; }
      assert.strictEqual(m.box.writes.length, 0, 'nothing is written to Claude Code\'s settings for any of this');
      // the window's switch restarts the other Claude tabs and leaves a tab on the gateway alone
      v.fire({ type: 'new', kind: 'claude', gateway: false }); const plain = v.lastTabs().tabs[1].id;   // asked for plainly: the gateway, once chosen, is where new tabs start
      v.fire({ type: 'send', sid: plain, text: 'hi' });
      const plainAgent = created[n0 + 1]; assert.deepStrictEqual([plainAgent.o.env, plainAgent.o.gateway, v.lastTabs().tabs[1].via, v.lastTabs().tabs[1].models[0].label], [undefined, undefined, '', 'default · Opus 5.5'], 'a tab not on the gateway gets no extra environment, no relay, and the window\'s default');
      assert(!v.events(plain).some((e) => e.kind === 'result' && e.via), 'and no result line of its says anything of a gateway');
      v.fire({ type: 'meterToggle' }); await flush(); await flush();
      assert.deepStrictEqual([m.box.bedrock, agent.disposed, plainAgent.disposed], [true, false, true], 'the switch to API / Bedrock restarts the plain tab, not the gateway one');
      assert(!v.events(g).some((e) => e.kind === 'note' && /backend is now/.test(e.text)), 'and says nothing to it');
      // the window being on API / Bedrock does not stop a gateway tab: its process is given the gateway's variables as settings of its own,
      // which Claude Code applies over ~/.claude/settings.json. Nothing is held, nothing is asked.
      v.fire({ type: 'new', kind: 'claude', gateway: true }); const g2 = v.lastTabs().tabs[2].id;
      assert.strictEqual(v.lastTabs().tabs[2].gateway, true, 'the + menu opens a tab on the gateway');
      v.fire({ type: 'new', kind: 'claude', gateway: true }); const g3 = v.lastTabs().tabs[3].id;
      v.fire({ type: 'send', sid: g3, text: 'x' }); await flush(); await flush();
      assert.deepStrictEqual([created.length, created[n0 + 2].o.gateway, created[n0 + 2].o.env.CLAUDE_CODE_USE_BEDROCK, v.events(g3).some((e) => e.kind === 'note' && /settings\.json/.test(e.text))], [n0 + 3, { target: 'https://gw.example.com/llm-api' }, '0', false], 'a process starts through the relay, though the window is on API / Bedrock');
      v.fire({ type: 'close', sid: g3 }); await flush();
      assert.strictEqual(v.lastTabs().tabs.length, 3);
      v.fire({ type: 'meterToggle' }); await flush(); await flush();
      assert.strictEqual(m.box.bedrock, false, 'back on the subscription for what follows');
      assert.strictEqual(agent.disposed, false, 'the running gateway tab was untouched by that switch too');
      // moving a running tab off the gateway: its process ends and the next message resumes the session without the gateway
      const writes = m.box.writes.length;
      v.fire({ type: 'setBackend', sid: g, value: 'subscription' }); await flush();
      assert.deepStrictEqual([agent.disposed, v.lastTabs().tabs[0].gateway, v.lastTabs().tabs[0].started, m.box.writes.length], [true, false, false, writes], 'the process ends; already on the subscription, the switch is not touched');
      assert(v.events(g).some((e) => e.kind === 'note' && e.text === 'This tab is on subscription (login) from the next message; the conversation continues, the prompt cache starts over.'));
      v.fire({ type: 'send', sid: g, text: 'resume' });
      assert.deepStrictEqual([created[created.length - 1].o.resume, created[created.length - 1].o.env, v.lastTabs().tabs[0].backend], ['sess-' + n0, undefined, 'subscription'], 'the same session, resumed on the window\'s backend');
      // the menu's API / Bedrock goes through the window's switch, for every tab
      v.fire({ type: 'setBackend', sid: g, value: 'api' }); await flush(); await flush();
      assert.deepStrictEqual([m.box.bedrock, m.box.writes.length], [true, writes + 1]);
      v.fire({ type: 'setBackend', sid: g, value: 'api' }); await flush();
      assert.strictEqual(m.box.writes.length, writes + 1, 'asking for the backend the window is on changes nothing');
      v.fire({ type: 'setBackend', sid: g, value: 'bogus' }); v.fire({ type: 'setBackend', sid: plain, value: 'gateway' }); v.fire({ type: 'setBackend', sid: 'nope', value: 'gateway' });
      assert.deepStrictEqual([v.lastTabs().tabs[0].gateway, v.lastTabs().tabs[1].gateway], [false, true], 'junk is ignored; any Claude tab can be put on the gateway');
      v.fire({ type: 'meterToggle' }); await flush(); await flush(); assert.strictEqual(m.box.bedrock, false);
      // a tab in the middle of a turn moves after it
      v.fire({ type: 'send', sid: g2, text: 'hold this' });
      const held = created[created.length - 1]; assert.deepStrictEqual([held.o.env.ANTHROPIC_BASE_URL, v.lastTabs().tabs[2].busy], ['https://gw.example.com/llm-api', true]);
      v.fire({ type: 'setBackend', sid: g2, value: 'subscription' }); await flush();
      assert.deepStrictEqual([held.disposed, v.lastTabs().tabs[2].gateway], [false, false], 'the choice is made now, the move waits for the turn');
      assert(v.events(g2).some((e) => e.kind === 'note' && e.text === 'This tab moves to subscription (login) after the current turn; the conversation continues, the prompt cache starts over.'));
      held.finish(); await flush();
      assert.deepStrictEqual([held.disposed, v.lastTabs().tabs[2].started], [true, false], 'moved once the turn ended');
      // a Codex tab has no gateway
      v.fire({ type: 'new', kind: 'codex', gateway: true }); const cx = v.lastTabs().tabs[3];
      assert.deepStrictEqual([cx.kind, cx.gateway, cx.gatewayWarn], ['codex', false, false]);
      v.fire({ type: 'setBackend', sid: cx.id, value: 'gateway' }); assert.strictEqual(v.lastTabs().tabs[3].gateway, false);
      // the choice survives a reload
      const dump = m.memento._dump();
      assert.deepStrictEqual(dump['perch.sessions.v1'].sessions.map((s) => s.gateway), [false, true, false, false], 'saved with each tab');
      const m2 = install(dump, { config: { 'claude.gatewayEnv': file } }); await flush();
      const v2 = fakeView(); m2.registered['perch.main'].resolveWebviewView(v2.view); v2.fire({ type: 'ready' }); await flush();
      assert.deepStrictEqual(v2.lastTabs().tabs.map((x) => [x.gateway, x.cache && x.cache.minutes]), [[false, 60], [true, 5], [false, 60], [false, null]], 'restored as they were');
      assert.deepStrictEqual(dump['perch.sessions.v1'].sessions.map((s) => near(s.gatewayCost, 0.0006)), [true, false, false, false], 'the first tab\'s gateway figure is kept with it, though it has left the gateway; the others have none');
      v2.fire({ type: 'send', sid: v2.lastTabs().tabs[1].id, text: 'after the reload' });
      assert(near(v2.events(v2.lastTabs().tabs[1].id).filter((e) => e.kind === 'result').pop().gatewayCostSoFar, 0.0003), 'a tab with no saved figure starts from nothing');
      v2.fire({ type: 'setBackend', sid: v2.lastTabs().tabs[0].id, value: 'gateway' }); v2.fire({ type: 'send', sid: v2.lastTabs().tabs[0].id, text: 'back on' });
      assert(near(v2.events(v2.lastTabs().tabs[0].id).filter((e) => e.kind === 'result').pop().gatewayCostSoFar, 0.0009), 'the first tab, back on the gateway, carries on from what was saved');
      assert.deepStrictEqual(v2.lastTabs().gateway, { file, exists: true, ok: true });
      // the sessions list and the handoff offer a tab on the gateway too, now that there is a file
      const qp = await m2.perch.pickSession();
      assert.deepStrictEqual(qp.rows().slice(0, 2).map((r) => r[0]), ['$(add) New Claude tab', '$(add) New Codex tab'], 'no tab kind of its own: the gateway is a backend');
      qp.choose((i) => i.fresh === 'claude');
      assert.strictEqual(v2.lastTabs().tabs.pop().gateway, true, 'a new tab starts where the last Claude tab was put: on the gateway, chosen earlier in this window');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log('HOST OK');
})().catch((e) => { console.error('HOST FAILED:', e.stack || e.message); process.exit(1); });
