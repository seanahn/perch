'use strict';
// Host behaviour: tabs, isolation between sessions, replay after the page is recreated,
// permission prompts, and persistence across a window reload.
const assert = require('assert');
const { install, fakeView, created, flush } = require('./stubs');
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

  // ======================================================================== Claude usage and backend (merged from AI Meter)
  {
    const m = install();                                                      // subscription, logged in, AI Meter not installed
    await flush();
    assert.deepStrictEqual(m.ui.bars.map((x) => [x.id, x.shown]), [['perch.meter.usage', true], ['perch.meter.backend', true]], 'perch owns the status bar when the standalone extension is absent');
    assert(/^\$\(dashboard\) 1\.0h 91% 6\.\dd 95%$/.test(m.ui.bars[0].text), m.ui.bars[0].text);
    assert.strictEqual(m.ui.bars[1].text, '$(account) sub');
    assert(/5h session/.test(m.ui.bars[0].tooltip.value) && /Weekly/.test(m.ui.bars[0].tooltip.value));
    assert.strictEqual(m.globalState._dump()['perch.meter.limits'].length, 2, 'the reading is cached for the next reload');
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    let st = v.lastMeter();
    assert.deepStrictEqual([st.backend, st.backendLabel, st.mode, st.level, st.action, st.segments.length], ['subscription', 'sub', 'subscription', 'ok', 'refresh', 2], 'the page is given the gauge as soon as it is ready');

    // refresh from the page and from the command
    const f0 = m.box.fetches;
    m.box.usage = { limits: [{ kind: 'session', percent: 93, resetsAt: new Date(Date.now() + 3660000).toISOString(), model: null }], error: null };
    v.fire({ type: 'meterRefresh' }); await flush();
    assert.strictEqual(m.box.fetches, f0 + 1);
    st = v.lastMeter(); assert.deepStrictEqual([st.text, st.level], ['1.0h 7%', 'error'], 'a limit running low turns red');
    assert.strictEqual(m.ui.bars[0].backgroundColor.id, 'statusBarItem.errorBackground');
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
    assert.deepStrictEqual([m.ui.bars[1].text, m.ui.bars[0].text], ['$(cloud) API', '$(dashboard) opus-5 5.2M $18.9']);
    assert(/new tabs and new sessions\. Running ones keep/.test(m.ui.infos.pop()));
    assert.strictEqual(m.loads.claude, loads0 + 1, 'the model list is re-read, because models differ by backend');
    assert(v.events(run).some((e) => e.kind === 'note' && /backend is now API \/ Bedrock\. This tab keeps subscription/.test(e.text)), 'a running tab is told it keeps its backend');
    assert(!v.events(idle).some((e) => e.kind === 'note' && /backend/.test(e.text)), 'a tab that has not started is not');
    assert(!v.events(cx).some((e) => e.kind === 'note' && /backend/.test(e.text)), 'nor is a codex tab');
    v.fire({ type: 'send', sid: idle, text: 'go' });
    assert.strictEqual(v.lastTabs().tabs.find((x) => x.id === idle).backend, 'api', 'the tab started after the switch is on the new backend');

    // and back, on a machine with no subscription login: the login is offered
    m.box.login = false; m.ui.answers.push('Log In');
    await m.commands['perch.meter.toggleBackend'](); await flush(); await flush();
    assert.deepStrictEqual(m.box.writes, [true, false]);
    assert(/has no subscription login yet/.test(m.ui.infos.pop()));
    assert.deepStrictEqual(m.ui.executed, ['claude-vscode.editor.openLast'], 'login opens the Claude Code panel when that extension is installed');
    assert.strictEqual(v.lastMeter().backend, 'subscription');
    assert.strictEqual(v.events(idle).filter((e) => e.kind === 'note' && /backend is now subscription/.test(e.text)).length, 1);
    assert.strictEqual(v.events(run).filter((e) => e.kind === 'note' && /backend is now/.test(e.text)).length, 1, 'a tab already on that backend is not told again');

    // no API credentials: a modal first, and cancelling writes nothing
    m.box.apiCreds = false; m.box.login = true;
    v.fire({ type: 'meterToggle' }); await flush();
    assert(/No Bedrock or API credentials found/.test(m.ui.warnings.pop())); assert.deepStrictEqual(m.box.writes, [true, false], 'cancelled: nothing written');
    m.ui.answers.push('Switch Anyway'); v.fire({ type: 'meterToggle' }); await flush(); await flush();
    assert.deepStrictEqual(m.box.writes, [true, false, true]);
    assert.deepStrictEqual([v.lastMeter().backendWarn, m.ui.bars[1].text, m.ui.bars[1].backgroundColor.id], [true, '$(cloud) API $(warning)', 'statusBarItem.warningBackground'], 'the switch stays highlighted until credentials exist');

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

    // status bar placement
    m.changeConfig({ 'meter.statusBar': 'off' }); await flush();
    assert.deepStrictEqual(m.ui.bars.map((x) => x.disposed), [true, true], 'off removes the items');
    assert.strictEqual(v.lastMeter().text, '1.0h 30%', 'the panel footer still works');
    m.changeConfig({ 'meter.statusBar': 'auto' }); await flush();
    assert.deepStrictEqual(m.ui.bars.slice(2).map((x) => [x.id, x.shown]), [['perch.meter.usage', true], ['perch.meter.backend', true]]);
    m.changeExtensions({ 'seanahn.ai-meter': { icon: 'x.png' } });
    assert.deepStrictEqual(m.ui.bars.slice(2).map((x) => x.disposed), [true, true], 'installing the standalone extension makes perch stand down');
    m.changeExtensions({ 'seanahn.ai-meter': null });
    assert.strictEqual(m.ui.bars.length, 6, 'and removing it brings perch back');
    m.perch.dispose(); assert.deepStrictEqual(m.ui.bars.slice(4).map((x) => x.disposed), [true, true]);
  }
  {
    // the standalone extension is installed: no duplicate gauge in the status bar, but the panel has it
    const m = install(undefined, { extensions: { 'seanahn.ai-meter': { icon: 'x.png' } } }); await flush();
    assert.deepStrictEqual(m.ui.bars, [], 'perch stands down');
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.strictEqual(v.lastMeter().segments.length, 2);
    m.changeConfig({ 'meter.statusBar': 'on' }); await flush();
    assert.strictEqual(m.ui.bars.length, 2, 'unless asked');
  }
  {
    // never logged in
    const m = install(undefined, { meter: { usage: { limits: null, error: 'no-credentials' } }, extensions: {} }); await flush();
    const v = fakeView(); m.registered['perch.main'].resolveWebviewView(v.view); v.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual([v.lastMeter().text, v.lastMeter().action, v.lastMeter().level], ['—', 'login', 'none']);
    assert(/command:perch\.meter\.login/.test(m.ui.bars[0].tooltip.value));
    v.fire({ type: 'meterLogin' }); await flush();
    assert.strictEqual(m.ui.terminals.length <= 1, true);                     // a terminal only if a claude CLI exists on this machine
    m.changeConfig({ 'meter.hideWhenUnavailable': true }); await flush();
    assert.deepStrictEqual(m.ui.bars.map((x) => x.shown), [false, false], 'hidden on request when there is nothing to show');
  }
  {
    // the cached reading is shown before the first poll returns
    const cached = LIM(40);
    const m = install(undefined, { globals: { 'perch.meter.limits': cached, 'perch.meter.limits.at': 123 }, meter: { usage: { limits: null, error: 'network' } } });
    assert(/1\.0h 60%/.test(m.ui.bars[0].text), 'shown at once, from the cache');
    await flush(); assert(/1\.0h 60%/.test(m.ui.bars[0].text), 'and kept when the poll fails');
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

    // ---- IDE context: a Codex tab can attach the active file and selection to each message
    const sel = (a, ac, b, bc) => ({ isEmpty: a === b && ac === bc, start: { line: a, character: ac }, end: { line: b, character: bc }, active: { line: b, character: bc } });
    const editor = (file, lang, text, s) => ({ selection: s, document: { uri: { scheme: 'file', fsPath: file }, languageId: lang, getText: () => text } });
    assert.deepStrictEqual([v2.tab(x).ide, v2.tab(c).ide], [false, null], 'off by default; not a Claude feature');
    m.ui.editor = editor(path.join(process.cwd(), 'src', 'a.js'), 'javascript', 'const a = 1;\nconst b = 2;\n', sel(2, 0, 4, 0));
    v2.fire({ type: 'send', sid: x, text: 'plain' }); await flush();
    assert.strictEqual(cx.sent.pop(), 'plain', 'nothing is attached while it is off');
    v2.fire({ type: 'setIde', sid: x, value: true }); assert.strictEqual(v2.tab(x).ide, true);
    v2.fire({ type: 'setIde', sid: c, value: true }); assert.strictEqual(v2.tab(c).ide, null, 'ignored on a Claude tab');
    v2.fire({ type: 'send', sid: x, text: 'why is b 2?' }); await flush();
    const F = path.join('src', 'a.js');
    assert.strictEqual(cx.sent.pop(), 'why is b 2?\n\n<ide_context>\nActive file: ' + F + ' (javascript)\nSelection: lines 3-4\n```javascript\nconst a = 1;\nconst b = 2;\n```\n</ide_context>', 'the agent gets the file, the lines, and the text');
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'why is b 2?', queued: false, tag: 'IDE context · ' + F + ':3-4' }, 'the transcript shows the message, and what was attached');
    assert.strictEqual(v2.tab(x).title.includes('ide_context'), false);

    m.ui.editor = editor(path.join(process.cwd(), 'src', 'a.js'), 'javascript', '', sel(7, 4, 7, 4));
    v2.fire({ type: 'send', sid: x, text: 'here' }); await flush();
    assert(/\nActive file: .*a\.js \(javascript\)\nCursor: line 8\n<\/ide_context>$/.test(cx.sent.pop()), 'with no selection: the file and the cursor');
    assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user').pop().tag, 'IDE context · ' + F);
    m.ui.editor = editor('/elsewhere/x.py', 'python', 'a ``` b ```` c', sel(0, 0, 0, 14));
    v2.fire({ type: 'send', sid: x, text: 'fences' }); await flush();
    assert(/Active file: \/elsewhere\/x\.py \(python\)\nSelection: lines 1-1\n`````python\na ``` b ```` c\n`````\n/.test(cx.sent.pop()), 'a file outside the workspace keeps its path; the fence is longer than any inside the selection');
    m.ui.editor = editor('/big.txt', 'plaintext', 'x'.repeat(20000), sel(0, 0, 0, 20000));
    v2.fire({ type: 'send', sid: x, text: 'big' }); await flush();
    const big = cx.sent.pop(); assert(/Selection: lines 1-1 \(first 12000 characters\)/.test(big) && big.length < 12300, 'a long selection is cut, and says so');
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
    assert.deepStrictEqual(v2.events(x).filter((e) => e.kind === 'user').pop(), { kind: 'user', text: 'queued about one', queued: true, tag: 'IDE context · one.js:1' });
    cx.finish(); await flush(); await flush();
    assert(/queued about one\n\n<ide_context>\nActive file: one\.js/.test(cx.sent.pop()) , 'the queued message carries the file that was open when it was written');
    assert.strictEqual(v2.events(x).filter((e) => e.kind === 'user' && e.text === 'queued about one').length, 1);

    // the choice is saved with the tab
    const saved2 = install(m.memento._dump()); const v3 = fakeView(); saved2.registered['perch.main'].resolveWebviewView(v3.view); v3.fire({ type: 'ready' }); await flush();
    assert.deepStrictEqual(v3.lastTabs().tabs.map((t) => t.ide), [null, null, true], 'IDE context survives a reload');
    m.ui.editor = undefined;

    // closing a tab with a queue disposes it cleanly
    v2.fire({ type: 'send', sid: x, text: 'hold' }); v2.fire({ type: 'send', sid: x, text: 'q' });
    v2.fire({ type: 'close', sid: x }); cx.finish(); await flush();
    assert.deepStrictEqual([cx.disposed, cx.sent.includes('q')], [true, false]);
  }

  console.log('HOST OK');
})().catch((e) => { console.error('HOST FAILED:', e.stack || e.message); process.exit(1); });
