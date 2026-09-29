'use strict';
// Runs the real page script in a DOM and drives it the way the host does.
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const { getHtml } = require('../src/webview');

// a page script that fails to parse or throws is reported as such, not as a missing 'ready' message
const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', (e) => { console.error('PAGE SCRIPT ERROR:', (e.detail && e.detail.message) || e.message); process.exitCode = 1; });
const ICONS = { claude: { glyph: 'vscode-resource://host/claude.svg', image: 'vscode-resource://host/claude.png' }, codex: { glyph: 'vscode-resource://host/blossom.svg', image: 'vscode-resource://host/chatgpt.png' } };
const IMAGES_ONLY = { claude: { image: ICONS.claude.image }, codex: { image: ICONS.codex.image } };
const strip = (h) => h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
function page(icons) {
  const out = [];
  const dom = new JSDOM(strip(getHtml({ nonce: 'n', cspSource: 'x', icons })), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))) }); w.HTMLElement.prototype.scrollIntoView = function () {}; } });
  const w = dom.window, d = w.document;
  return { w, d, out, host: (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m })), $: (s) => d.querySelector(s), $$: (s) => [...d.querySelectorAll(s)], shown: (n) => !!n && w.getComputedStyle(n).display !== 'none' && (!n.parentElement || n.parentElement === d.body || w.getComputedStyle(n.parentElement).display !== 'none') };
}
const P = page(ICONS);
const { w: window, d, out, host, $, $$, shown } = P;
const ev = (sid, e) => host({ type: 'event', sid, ev: e });
const visiblePane = () => $$('.pane').filter(shown);
const opt = (v, label, title) => Object.assign({ value: v, label: label || v || 'default' }, title ? { title } : {});
const tab = (o) => Object.assign({
  busy: false, attention: false, started: false, actualModel: '', backend: '', queued: 0, ide: o.kind === 'codex' ? false : null, approvals: o.kind === 'codex' ? 'on-failure' : '',
  model: '', models: o.kind === 'claude' ? [opt('', 'default · Opus 5.5', 'The model the agent picks by default'), opt('fable', 'Fable 5.1', 'For your toughest challenges'), opt('haiku', 'Haiku 4.5', 'Fastest')] : [opt('', 'default · GPT-5.6-Sol'), opt('gpt-5.5', 'GPT-5.5')],
  effort: '', efforts: o.kind === 'claude' ? [opt(''), opt('low'), opt('high'), opt('max')] : [opt('', 'default · ultra'), opt('high'), opt('ultra')],
  mode: o.kind === 'claude' ? 'default' : 'workspace-write', modes: o.kind === 'claude' ? ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] : ['read-only', 'workspace-write', 'danger-full-access'],
  context: null, cache: o.kind === 'claude' ? { minutes: 60, since: 0 } : null,
}, o);
const with_ = (t, o) => Object.assign({}, t, o);
const key = (el, k, o) => el.dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
const type = (text) => { $('#input').value = text; $('#input').dispatchEvent(new window.Event('input', { bubbles: true })); };
const menuItems = () => $$('#menu .it').map((n) => ({ label: n.querySelector('.l').textContent, on: n.classList.contains('on'), dis: n.classList.contains('dis'), hint: n.querySelector('.hint').textContent, desc: (n.querySelector('.d') || {}).textContent || '', n }));
const pickItem = (label) => { const it = menuItems().find((x) => x.label === label); assert(it, 'menu item ' + label); it.n.click(); };

assert.deepStrictEqual(out.shift(), { type: 'ready' }, 'page announces ready');

// ---- nothing open
host({ type: 'tabs', tabs: [], active: null });
assert(shown($('#empty')), 'a fresh page shows the empty state'); assert.strictEqual($$('.tab').length, 0);
assert.deepStrictEqual([$('#input').disabled, $('#send').disabled, $('#t-model').disabled, $('#t-mode').disabled, $('#t-add').disabled], [true, true, true, true, true], 'the composer is inert with no tab');
assert.strictEqual($('#composer').className, 'off');
assert(!shown($('#t-slash')) && !shown($('#t-ctx')) && !shown($('#t-cache')));
$('#send').click(); $('#t-model').click(); $('#t-mode').click(); key($('#input'), 'Enter');
assert.deepStrictEqual([out.length, $('#menu')], [0, null], 'and does nothing');

// ---- tabs and panes
const A = tab({ id: 'a', kind: 'claude', title: 'Claude 1' }), B = tab({ id: 'b', kind: 'codex', title: 'Codex 1' });
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.strictEqual($$('.tab').length, 2, 'two tabs rendered');
assert.strictEqual($$('.tab.active .t')[0].textContent, 'Claude 1');
assert.strictEqual($$('.pane').length, 2); assert.strictEqual(visiblePane().length, 1, 'only the active pane is visible');
assert.deepStrictEqual($$('.tab .k').map((k) => [k.tagName, k.className]), [['SPAN', 'k glyph claude'], ['SPAN', 'k glyph codex']], 'tabs carry the vendor glyphs');
const css = [...d.querySelectorAll('style')].map((x) => x.textContent).join('\n');
assert(/\.k\.glyph\.claude \{[^}]*claude\.svg[^}]*background-color: #D97757/.test(css), 'claude glyph is orange on transparent');
assert(/\.k\.glyph\.codex \{[^}]*blossom\.svg[^}]*background-color: currentColor/.test(css), 'chatgpt glyph follows the text colour');
assert.strictEqual($$('img').length, 0, 'no marketplace images when glyphs exist');

ev('a', { kind: 'status', text: 'ready' }); ev('b', { kind: 'status', text: 'idle' });
ev('a', { kind: 'user', text: 'hello a' }); ev('a', { kind: 'delta', text: 'par' }); ev('a', { kind: 'delta', text: 'tial' });
assert.strictEqual(visiblePane()[0].querySelector('.live').textContent, 'partial', 'deltas stream into a live bubble');
ev('a', { kind: 'text', text: 'final answer' });
assert.strictEqual(visiblePane()[0].querySelectorAll('.live').length, 0, 'live bubble replaced by the final text');
ev('b', { kind: 'text', text: 'codex says hi' });
const paneA = $$('.pane')[0], paneB = $$('.pane')[1];
assert.deepStrictEqual([...paneA.querySelectorAll('.msg')].map((m) => m.textContent), ['hello a', 'final answer']);
assert.deepStrictEqual([...paneB.querySelectorAll('.msg')].map((m) => m.textContent), ['codex says hi'], 'background tab received its own event only');
assert.deepStrictEqual([paneA.querySelector('.state').textContent, paneB.querySelector('.state').textContent], ['ready', 'idle'], 'status is per tab, and state only');
assert.strictEqual(paneA.querySelectorAll('select').length, 0, 'no selector row: the composer carries the choices');
ev('a', { kind: 'user', text: 'later', queued: true });
const q = [...paneA.querySelectorAll('.user')].pop();
assert.deepStrictEqual([q.classList.contains('queued'), q.querySelector('.tag').textContent, q.textContent], [true, 'queued', 'queuedlater'], 'a queued message is marked');

// ---- composer, Claude tab
assert.strictEqual($('#composer').className, 'claude');
assert.strictEqual($('#input').placeholder, 'Message Claude…');
assert(!shown($('#t-ide')) && !shown($('#tools .sep')) && !shown($('#t-model .chev')), 'IDE context and the chevron belong to Codex');
assert(/M9 1\.5L3\.5 9/.test($('#t-mode').innerHTML), 'a bolt');
assert.strictEqual(window.getComputedStyle($('#send')).borderRadius, '7px', 'a rounded square');
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent], ['Opus 5.5', ''], 'the pill names what the default resolves to; an unknown default effort is left out');
assert.strictEqual($('#t-mode').textContent, 'Ask');
assert(shown($('#t-ctx')) && shown($('#t-cache')), 'context ring and cache timer belong to Claude');
assert(!shown($('#t-slash')), 'no slash button until the commands are known');
assert.strictEqual($('#t-cache').textContent, '60m'); assert(/stays warm for 60 minutes after each answer/.test($('#t-cache').title));
assert(/appears once the session starts/.test($('#t-ctx').title));
assert.strictEqual($('#t-ctx .fill').getAttribute('stroke-dasharray').split(' ')[0], '0.00', 'an empty ring');
assert.deepStrictEqual([$('#send').className, $('#send').title, $('#send').disabled], ['', 'Send', false]);

host({ type: 'tabs', tabs: [with_(A, { model: 'fable', effort: 'high', mode: 'auto', actualModel: 'claude-fable-5-1', backend: 'subscription', started: true, context: { percent: 42, used: 420000, max: 1000000 }, cache: { minutes: 60, since: Date.now() - 10 * 60000 - 5000 } }), B], active: 'a' });
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent, $('#t-mode').textContent], ['Fable 5.1', 'High', 'Auto'], 'like the original: model, effort, mode');
assert(/^Running claude-fable-5-1\. Backend: subscription\. Model and effort\. Changes apply from the next message\.$/.test($('#t-model').title));
assert.strictEqual($('#t-ctx').title, 'Context 42% used · 420k of 1M tokens');
assert.strictEqual($('#t-ctx .fill').getAttribute('stroke-dasharray'), (0.42 * 2 * Math.PI * 6).toFixed(2) + ' ' + (2 * Math.PI * 6).toFixed(2));
assert.strictEqual($('#t-cache').textContent, '50m', 'counts down from the last answer'); assert(/50 more minutes/.test($('#t-cache').title));
for (const [pct, cls] of [[79, 'tb'], [80, 'tb warn'], [95, 'tb error']]) { host({ type: 'tabs', tabs: [with_(A, { context: { percent: pct, used: 1, max: 2 } }), B], active: 'a' }); assert.strictEqual($('#t-ctx').className, cls, pct + '%'); }
host({ type: 'tabs', tabs: [with_(A, { context: { percent: 1, used: 1, max: 2 } }), B], active: 'a' });
assert(parseFloat($('#t-ctx .fill').getAttribute('stroke-dasharray')) > 1, 'a sliver is still visible at 1%');
host({ type: 'tabs', tabs: [with_(A, { cache: { minutes: 5, since: Date.now() - 6 * 60000 } }), B], active: 'a' });
assert.deepStrictEqual([$('#t-cache').textContent, $('#t-cache').classList.contains('cold')], ['cold', true]); assert(/has expired\. The next message re-caches/.test($('#t-cache').title));
host({ type: 'tabs', tabs: [with_(A, { cache: { minutes: 5, since: Date.now() - 4.5 * 60000 } }), B], active: 'a' });
assert.strictEqual($('#t-cache').textContent, '1m', 'never shows zero while still warm');
host({ type: 'tabs', tabs: [A, B], active: 'a' });

// ---- sending, queueing, stopping
type('  '); key($('#input'), 'Enter'); assert.strictEqual(out.length, 0, 'a blank message is not sent');
type('line one'); key($('#input'), 'Enter', { shiftKey: true }); assert.strictEqual(out.length, 0, 'shift+enter is a newline');
key($('#input'), 'Enter', { isComposing: true }); assert.strictEqual(out.length, 0, 'enter while composing text belongs to the input method');
key($('#input'), 'Enter');
assert.deepStrictEqual(out.pop(), { type: 'send', sid: 'a', text: 'line one' }); assert.strictEqual($('#input').value, '');
type('via button'); $('#send').click(); assert.deepStrictEqual(out.pop(), { type: 'send', sid: 'a', text: 'via button' });

host({ type: 'tabs', tabs: [with_(A, { busy: true, queued: 0 }), B], active: 'a' });
assert.deepStrictEqual([$('#input').placeholder, $('#send').className, $('#send').title], ['Queue another message…', 'stop', 'Stop'], 'while working: the box queues, the button stops');
assert($('.tab.active').classList.contains('busy'));
assert(/<rect/.test($('#send').innerHTML), 'a stop square');
type('queue me'); key($('#input'), 'Enter');
assert.deepStrictEqual(out.pop(), { type: 'send', sid: 'a', text: 'queue me' }, 'enter queues behind the running turn');
type('not sent by the button'); $('#send').click();
assert.deepStrictEqual(out.pop(), { type: 'stop', sid: 'a' }, 'the button stops, whatever is typed');
assert.strictEqual($('#input').value, 'not sent by the button', 'and keeps the draft');
host({ type: 'tabs', tabs: [with_(A, { busy: true, queued: 2 }), B], active: 'a' });
assert.strictEqual($('#send').title, 'Stop and drop 2 queued');
host({ type: 'tabs', tabs: [A, with_(B, { attention: true })], active: 'a' });
assert.deepStrictEqual([$('#send').className, /<path/.test($('#send').innerHTML)], ['', true]); assert($$('.tab')[1].classList.contains('attn'), 'attention badge on the background tab');
type('');

// ---- drafts are per tab
type('draft for a');
$$('.tab')[1].click();
assert.deepStrictEqual(out.pop(), { type: 'activate', sid: 'b' }, 'clicking a tab asks the host to activate it');
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.strictEqual($('#input').value, '', 'other tab starts with its own empty draft');
assert.strictEqual(visiblePane()[0], paneB);

// ---- composer, Codex tab
assert.strictEqual($('#composer').className, 'codex');
assert.strictEqual($('#input').placeholder, 'Do anything', 'Codex greets the way Codex does');
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent, $('#t-mode').textContent], ['GPT-5.6-Sol', 'Ultra', 'Workspace'], 'the default effort is named when the agent knows it');
assert(!shown($('#t-slash')) && !shown($('#t-ctx')) && !shown($('#t-cache')), 'codex has no slash commands, context ring, or cache timer');
assert(/^Sandbox: Edit files in the workspace\. Approvals: on-failure$/.test($('#t-mode').title));

// the Codex look: the sandbox beside the +, behind a shield; the model with a chevron; IDE context; a round button
const order = (n) => Number(window.getComputedStyle(n).order) || 0;
assert.deepStrictEqual(['#t-add', '#t-mode', '#t-model', '#tools .sep', '#t-ide', '#tools .sp', '#send'].map((q) => order($(q))), [1, 2, 3, 4, 5, 6, 7], 'tools are laid out in Codex order');
assert(/M8 1\.8l5 1\.8/.test($('#t-mode').innerHTML), 'a shield, not a bolt');
assert(shown($('#t-model .chev')) && shown($('#t-ide')) && shown($('#tools .sep')));
assert.strictEqual(window.getComputedStyle($('#send')).borderRadius, '50%');
assert(/#composer\.codex #tools \{ border-top: none;/.test(css), 'no rule between the message and the tools');   // the test DOM does not resolve border shorthands, so the stylesheet is checked
assert.deepStrictEqual([$('#t-ide').textContent, $('#t-ide').getAttribute('aria-pressed'), $('#t-ide').classList.contains('on')], ['IDE context', 'false', false]);
assert(/^IDE context is off\./.test($('#t-ide').title));
$('#t-ide').click(); assert.deepStrictEqual(out.pop(), { type: 'setIde', sid: 'b', value: true });
host({ type: 'tabs', tabs: [A, with_(B, { ide: true, mode: 'danger-full-access' })], active: 'b' });
assert.deepStrictEqual([$('#t-ide').getAttribute('aria-pressed'), $('#t-ide').classList.contains('on')], ['true', true]); assert(/^IDE context is on: the active file and selection are attached/.test($('#t-ide').title));
$('#t-ide').click(); assert.deepStrictEqual(out.pop(), { type: 'setIde', sid: 'b', value: false });
assert.deepStrictEqual([$('#t-mode').textContent, $('#t-mode').classList.contains('risk')], ['Full access', true], 'full access is flagged in amber');
host({ type: 'tabs', tabs: [A, with_(B, { busy: true })], active: 'b' });
assert.deepStrictEqual([$('#input').placeholder, $('#send').className], ['Queue another message…', 'stop']);
host({ type: 'meter', meter: { backendLabel: 'sub', backendTitle: '', level: 'ok', action: 'refresh', lines: [], segments: [] } });
assert(shown($('#m-where')), 'beneath a Codex tab: where the work runs');
assert.strictEqual($('#m-where').textContent, 'Work locally'); assert(/runs Codex on this machine/.test($('#m-where').title));
ev('b', { kind: 'user', text: 'fix this', tag: 'IDE context · src/a.js:3-9' });
ev('b', { kind: 'user', text: 'and this', queued: true, tag: 'IDE context · src/a.js' });
assert.deepStrictEqual([...paneB.querySelectorAll('.user .tag')].map((n) => n.textContent), ['IDE context · src/a.js:3-9', 'queued · IDE context · src/a.js'], 'a message says what was attached to it');
host({ type: 'tabs', tabs: [A, B], active: 'b' });
type('draft for b');
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.strictEqual($('#input').value, 'draft for a', 'draft restored when returning');
type('');

// ---- model and effort menu
$('#t-model').click();
assert($('#menu'), 'the pill opens a menu');
assert.deepStrictEqual($$('#menu .h').map((n) => n.textContent), ['Model', 'Effort']);
assert.deepStrictEqual(menuItems().map((x) => [x.label, x.on]), [['default · Opus 5.5', true], ['Fable 5.1', false], ['Haiku 4.5', false], ['default', true], ['Low', false], ['High', false], ['Max', false]]);
assert.deepStrictEqual(menuItems().slice(0, 3).map((x) => x.desc), ['', 'For your toughest challenges', 'Fastest'], 'models carry their description');
assert.strictEqual($('#menu .it.on').getAttribute('aria-checked'), 'true');
pickItem('Fable 5.1');
assert.deepStrictEqual(out.pop(), { type: 'setModel', sid: 'a', value: 'fable' }); assert.strictEqual($('#menu'), null, 'picking closes the menu');
$('#t-model').click(); pickItem('High'); assert.deepStrictEqual(out.pop(), { type: 'setEffort', sid: 'a', value: 'high' });
$('#t-model').click(); pickItem('default'); assert.deepStrictEqual(out.pop(), { type: 'setEffort', sid: 'a', value: '' });
$('#t-model').click(); assert($('#menu')); $('#t-model').click(); assert.strictEqual($('#menu'), null, 'the pill toggles its menu');
$('#t-model').click(); d.body.click(); assert.strictEqual($('#menu'), null, 'a click elsewhere closes it');
$('#t-model').click(); key(d, 'Escape'); assert.strictEqual($('#menu'), null, 'so does escape');

host({ type: 'tabs', tabs: [with_(A, { model: 'haiku', effort: '', efforts: [opt('')] }), B], active: 'a' });
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent], ['Haiku 4.5', '']);
$('#t-model').click();
assert.deepStrictEqual([$$('#menu .h').map((n) => n.textContent), $$('#menu .note').map((n) => n.textContent)], [['Model'], ['This model has no effort control.']]);
d.body.click();

// a started Codex thread cannot change model, effort, or sandbox: the menus say so and the items are inert
host({ type: 'tabs', tabs: [A, with_(B, { started: true, model: 'gpt-5.5', effort: 'high' })], active: 'b' });
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent], ['GPT-5.5', 'High']);
assert(/A Codex thread keeps the model and effort it started with\.$/.test($('#t-model').title));
$('#t-model').click();
assert(/keeps the model and effort it started with/.test($('#menu .note').textContent));
assert(menuItems().every((x) => x.dis), 'every choice is disabled');
assert.deepStrictEqual(menuItems().filter((x) => x.on).map((x) => x.label), ['GPT-5.5', 'High'], 'but the current ones are still marked');
menuItems()[0].n.click(); assert.strictEqual(out.length, 0, 'and clicking one sends nothing');
d.body.click();
$('#t-mode').click();
assert(/keeps the sandbox it started with/.test($('#menu .note').textContent)); assert(menuItems().every((x) => x.dis));
d.body.click();

// ---- mode menu
host({ type: 'tabs', tabs: [A, B], active: 'b' });
$('#t-mode').click();
assert.deepStrictEqual($$('#menu .h').map((n) => n.textContent), ['Sandbox']);
assert.deepStrictEqual(menuItems().map((x) => [x.label, x.on, x.desc]), [['Read only', false, 'Read files; change nothing'], ['Workspace', true, 'Edit files in the workspace'], ['Full access', false, 'No sandbox']]);
assert(/^Approvals: on-failure\./.test($$('#menu .note').pop().textContent));
pickItem('Read only'); assert.deepStrictEqual(out.pop(), { type: 'setMode', sid: 'b', value: 'read-only' });
host({ type: 'tabs', tabs: [A, B], active: 'a' });
$('#t-mode').click();
assert.deepStrictEqual($$('#menu .h').map((n) => n.textContent), ['Permission mode']);
assert.deepStrictEqual(menuItems().map((x) => [x.label, x.on]), [['Ask', true], ['Edits', false], ['Plan', false], ['Auto', false], ['Bypass', false]]);
assert.strictEqual($$('#menu .note').length, 0);
pickItem('Plan'); assert.deepStrictEqual(out.pop(), { type: 'setMode', sid: 'a', value: 'plan' });
$('#t-mode').click(); $('#t-model').click(); assert.deepStrictEqual($$('#menu .h').map((n) => n.textContent), ['Model', 'Effort'], 'opening one menu replaces another');
d.body.click();
host({ type: 'tabs', tabs: [with_(A, { mode: 'bypassPermissions' }), B], active: 'a' });
assert.deepStrictEqual([$('#t-mode').textContent, $('#t-mode').classList.contains('risk')], ['Bypass', true], 'so is never asking');
host({ type: 'tabs', tabs: [with_(A, { mode: 'something-new', modes: ['something-new'] }), B], active: 'a' });
assert.strictEqual($('#t-mode').textContent, 'something-new', 'a mode this page has no name for is shown as it is');
host({ type: 'tabs', tabs: [A, B], active: 'a' });

// ---- slash commands
const CMDS = [{ name: 'clear', description: 'Start over', hint: '' }, { name: 'compact', description: 'Summarise the conversation so far', hint: '[instructions]' }, { name: 'code-review', description: 'Review the current diff', hint: '' }, { name: 'model', description: 'Change model', hint: '' }];
host({ type: 'commands', kind: 'claude', list: CMDS });
assert(shown($('#t-slash')), 'the slash button appears once commands are known');
$('#t-slash').click();
assert.deepStrictEqual(menuItems().map((x) => [x.label, x.hint, x.desc]), [['/clear', '', 'Start over'], ['/compact', '[instructions]', 'Summarise the conversation so far'], ['/code-review', '', 'Review the current diff'], ['/model', '', 'Change model']]);
const filter = $('#menu .filter'); assert(shown(filter));
filter.value = 'co'; filter.dispatchEvent(new window.Event('input'));
assert.deepStrictEqual(menuItems().map((x) => x.label), ['/compact', '/code-review'], 'filtered by name');
filter.value = 'diff'; filter.dispatchEvent(new window.Event('input'));
assert.deepStrictEqual(menuItems().map((x) => x.label), ['/code-review'], 'or by description');
filter.value = 'zzz'; filter.dispatchEvent(new window.Event('input'));
assert.deepStrictEqual([menuItems().length, $('#menu .note').textContent], [0, 'No command matches.']);
filter.value = 'mod'; filter.dispatchEvent(new window.Event('input')); key(filter, 'Enter');
assert.deepStrictEqual([$('#input').value, $('#menu')], ['/model ', null], 'enter in the filter picks the first match');

type('/');
assert.deepStrictEqual([!!$('#menu'), shown($('#menu .filter')), menuItems().length], [true, false, 4], 'typing a slash opens the list, filtered by what follows');
type('/com'); assert.deepStrictEqual(menuItems().map((x) => x.label), ['/compact']);
type('/c'); assert.deepStrictEqual(menuItems().map((x) => x.label), ['/clear', '/compact', '/code-review'], 'names that start with the text come first');
key($('#input'), 'Enter');
assert.deepStrictEqual([$('#input').value, $('#menu'), out.length], ['/clear ', null, 0], 'enter completes the command instead of sending');
type('/compact keep the api notes'); assert.strictEqual($('#menu'), null, 'once arguments follow, the list is gone');
key($('#input'), 'Enter'); assert.deepStrictEqual(out.pop(), { type: 'send', sid: 'a', text: '/compact keep the api notes' }, 'and the command is sent like any message');
type('/co'); assert($('#menu')); type('hello'); assert.strictEqual($('#menu'), null, 'typing something else closes the list');
type('/co'); key($('#input'), 'Escape'); assert.strictEqual($('#menu'), null); assert.strictEqual($('#input').value, '/co');
type('');
host({ type: 'tabs', tabs: [A, B], active: 'b' });
type('/'); assert.strictEqual($('#menu'), null, 'a slash in a codex tab is just a character');
type(''); host({ type: 'tabs', tabs: [A, B], active: 'a' });

// ---- mentioning files
$('#t-add').click(); assert.deepStrictEqual(out.pop(), { type: 'attach', sid: 'a' });
type('look at'); ev('a', { kind: 'insert', text: '@src/a.js @docs/b.md ' });
assert.strictEqual($('#input').value, 'look at @src/a.js @docs/b.md ', 'inserted at the cursor, with a space before');
ev('a', { kind: 'insert', text: '@c.js ' }); assert.strictEqual($('#input').value, 'look at @src/a.js @docs/b.md @c.js ', 'no doubled space');
ev('b', { kind: 'insert', text: '@x.js ' }); ev('b', { kind: 'insert', text: '@y.js ' });
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.strictEqual($('#input').value, '@x.js @y.js ', 'a mention for a background tab waits in its draft');
type(''); host({ type: 'tabs', tabs: [A, B], active: 'a' }); type('');

// ---- permission prompt
ev('a', { kind: 'permission', id: 'p1', tool: 'Write', input: { file_path: '/x' }, hasSuggestions: false });
assert.deepStrictEqual([...paneA.querySelectorAll('.perm button')].map((b) => b.textContent), ['Allow', 'Deny'], 'no Always without suggestions');
paneA.querySelector('.perm button').click();
assert.deepStrictEqual(out.pop(), { type: 'permission', sid: 'a', id: 'p1', decision: 'allow' });
assert.strictEqual(paneA.querySelectorAll('.perm').length, 0, 'answered prompt collapses');
ev('a', { kind: 'permission', id: 'p2', tool: 'Bash', input: { command: 'rm x' }, hasSuggestions: true });
assert.deepStrictEqual([...paneA.querySelectorAll('.perm button')].map((b) => b.textContent), ['Allow', 'Always', 'Deny']);

// ---- tool call and result pair up; result line shows cache usage
ev('a', { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/y' } });
ev('a', { kind: 'text', text: 'between' });
ev('a', { kind: 'tool_result', id: 't1', text: 'file body' });
const kids = [...paneA.querySelectorAll('.msg')]; const ti = kids.findIndex((k) => k.classList.contains('tool'));
assert(kids[ti + 1].classList.contains('toolres'), 'result sits directly under its tool call');
ev('a', { kind: 'result', ok: true, duration_ms: 2900, usage: { input: 13822, cache_read: 7680, output: 11 } });
assert(/done · 2\.9s · in 13822 · cached 7680 · out 11/.test(paneA.querySelector('.result').textContent));

// ---- footer: Claude backend and usage
const $m = $('#meter'), $mb = $('#m-backend'), $mu = $('#m-usage');
host({ type: 'meter', meter: null });
assert(!shown($m), 'hidden while the host has no reading');
const seg = (text, level, title) => ({ text, level, title });
const METER = { mode: 'subscription', backend: 'subscription', backendLabel: 'sub', backendName: 'subscription (login)', backendWarn: false, backendTitle: 'Claude backend: subscription (login). Click to switch.', level: 'warn', action: 'refresh', fetchedAt: 1790708709271, lines: ['Claude usage, percent remaining', 'row'], text: '1.0h 91% 6.5d 20%', segments: [seg('1.0h 91%', 'ok', '5h session: 91% remaining'), seg('6.5d 20%', 'warn', 'Weekly: 20% remaining')] };
host({ type: 'meter', meter: METER });
assert(shown($m)); assert(!shown($('#m-where')), 'no "Work locally" under a Claude tab');
assert.deepStrictEqual([$mb.textContent, $mb.title, $mb.classList.contains('warn')], ['sub', METER.backendTitle, false]);
assert.deepStrictEqual([...$mu.children].map((n) => [n.textContent, n.className]), [['1.0h 91%', 'seg ok'], ['6.5d 20%', 'seg warn']], 'each limit keeps its own colour');
assert(/^5h session: 91% remaining\nUpdated .*\. Click to refresh\.$/.test($mu.children[0].title));
assert.strictEqual($m.querySelector('.k').className, 'k glyph claude', 'marked as Claude, since Codex has no such gauge');
$mb.click(); assert.deepStrictEqual(out.pop(), { type: 'meterToggle' });
$mu.click(); assert.deepStrictEqual(out.pop(), { type: 'meterRefresh' });
host({ type: 'meter', meter: Object.assign({}, METER, { stale: true, lines: METER.lines.concat('Showing the last reading: the usage endpoint is rate limiting requests.') }) });
assert($mu.classList.contains('stale')); assert(/^5h session: 91% remaining\nShowing the last reading: .*rate limiting requests\.\nUpdated /.test($mu.children[0].title), 'a kept reading says it is old, and why');
host({ type: 'meter', meter: Object.assign({}, METER, { backend: 'api', backendLabel: 'API', backendWarn: true, mode: 'cost', level: 'ok', text: 'opus-5 5.2M $18.9', segments: [seg('opus-5', 'ok'), seg('5.2M', 'ok'), seg('$18.9', 'ok')], lines: ['Claude cost', 'Today 5.2M'] }) });
assert.deepStrictEqual([$mb.textContent, $mb.classList.contains('warn')], ['API ⚠', true], 'a backend with no credentials is flagged');
assert.deepStrictEqual([...$mu.children].map((n) => n.textContent), ['opus-5', '5.2M', '$18.9']);
assert(/^Claude cost\nToday 5\.2M\nUpdated /.test($mu.title), 'segments without their own tooltip share the detail');
host({ type: 'meter', meter: Object.assign({}, METER, { level: 'none', action: 'login', text: '—', segments: [], fetchedAt: null, lines: ['Claude usage unavailable: not logged in.'] }) });
assert.deepStrictEqual([...$mu.children].map((n) => n.textContent), ['log in']);
assert.strictEqual($mu.title, 'Claude usage unavailable: not logged in.\nClick to log in.');
$mu.click(); assert.deepStrictEqual(out.pop(), { type: 'meterLogin' }, 'with no login, the gauge logs in instead of refreshing');
host({ type: 'meter', meter: null }); assert(!shown($m));
host({ type: 'meter', meter: METER });

// ---- new-tab menu and close
$('#add').click();
assert.deepStrictEqual($$('#menu .row').map((r) => r.textContent), ['New Claude tab', 'New Codex tab']);
assert.deepStrictEqual($$('#menu .k').map((i) => i.className), ['k glyph claude', 'k glyph codex'], 'menu rows carry the vendor glyphs');
$$('#menu .row')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'codex' });
assert.strictEqual($('#menu'), null, 'menu closes after choosing');
$$('.tab .x')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'close', sid: 'b' });
$('#t-model').click();
host({ type: 'tabs', tabs: [A], active: 'a' });
assert.strictEqual($$('.pane').length, 1, 'closed tab removes its pane');
assert($('#menu'), 'a tabs update for the same active tab leaves an open menu alone');
d.body.click();

// ---- fill (handoff), clear, and back to nothing
ev('a', { kind: 'fill', text: 'handed off' }); assert.strictEqual($('#input').value, 'handed off');
ev('a', { kind: 'clear' }); assert.strictEqual(paneA.querySelectorAll('.msg').length, 0);
$('#t-mode').click();
host({ type: 'tabs', tabs: [], active: null });
assert.strictEqual($('#menu'), null, 'a menu does not outlive its tab');
assert(shown($('#empty')), 'empty state is visible with no tabs'); assert.strictEqual($('#input').disabled, true);
assert.deepStrictEqual([$('#composer').className, $('#t-model .m').textContent, $('#t-mode').textContent], ['off', '', '']);
assert.deepStrictEqual($$('#empty button').map((x) => x.textContent), ['New Claude tab', 'New Codex tab'], 'empty state offers both kinds');
assert.deepStrictEqual($$('#empty .k').map((i) => i.className), ['k glyph claude', 'k glyph codex'], 'empty state carries the vendor glyphs');
$$('#empty button')[0].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'claude' });
host({ type: 'tabs', tabs: [A], active: 'a' });
assert(!shown($('#empty')), 'empty state hides once a tab exists');
assert.strictEqual(out.length, 0, 'nothing was sent that the tests did not ask for');
window.close();

// ---- no glyph available: the marketplace image is used, and a failed image falls back to its letter
{
  const p3 = page(IMAGES_ONLY);
  p3.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'Claude 1' }), tab({ id: 'b', kind: 'codex', title: 'Codex 1' })], active: 'a' });
  assert.deepStrictEqual(p3.$$('.tab .k').map((k) => [k.tagName, k.getAttribute('src')]), [['IMG', IMAGES_ONLY.claude.image], ['IMG', IMAGES_ONLY.codex.image]], 'images when there are no glyphs');
  assert.deepStrictEqual(p3.$$('#empty img').map((i) => i.getAttribute('src')), [IMAGES_ONLY.claude.image, IMAGES_ONLY.codex.image]);
  p3.$$('.tab img.k')[0].dispatchEvent(new p3.w.Event('error'));
  assert.deepStrictEqual(p3.$$('.tab .k').map((k) => [k.tagName, k.textContent]), [['SPAN', 'C'], ['IMG', '']], 'failed image falls back to the letter');
  p3.$$('#empty img')[1].dispatchEvent(new p3.w.Event('error'));
  assert.strictEqual(p3.d.querySelector('#e-codex .k').textContent, 'X', 'static badges fall back too');
  p3.w.close();
}

// ---- no vendor icons: letters everywhere. Nothing the host supplies can break out of the script, the stylesheet, or the markup.
{
  const p2 = page({ codex: { image: 'x</script><script>window.pwned=1</script>', glyph: 'y"); } </style><script>window.pwned=2</script>' } });
  assert.strictEqual(p2.w.pwned, undefined, 'icon URIs are escaped inside the script and the stylesheet');
  assert.deepStrictEqual(p2.out, [{ type: 'ready' }], 'page script still ran');
  const evil = '<img src=x onerror="window.pwned=3"><script>window.pwned=4</script>';
  p2.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: evil, model: 'm', models: [opt('m', evil, evil)], efforts: [opt(''), opt('e', evil)], effort: 'e', mode: evil, modes: [evil], actualModel: evil })], active: 'a' });
  p2.host({ type: 'commands', kind: 'claude', list: [{ name: evil, description: evil, hint: evil }] });
  p2.host({ type: 'event', sid: 'a', ev: { kind: 'user', text: evil, queued: true } });
  p2.host({ type: 'event', sid: 'a', ev: { kind: 'tool_use', id: 't', name: evil, input: evil } });
  p2.host({ type: 'event', sid: 'a', ev: { kind: 'permission', id: 'p', tool: evil, input: { x: evil } } });
  p2.host({ type: 'meter', meter: { backendLabel: evil, backendTitle: evil, level: 'ok', action: 'refresh', lines: [evil], segments: [{ text: evil, level: 'ok', title: evil }] } });
  p2.$('#t-model').click(); p2.d.body.click(); p2.$('#t-mode').click(); p2.d.body.click(); p2.$('#t-slash').click();
  assert.strictEqual(p2.w.pwned, undefined, 'text from the host is never parsed as markup');
  assert.strictEqual(p2.$$('img').length, 0); assert.strictEqual(p2.$$('script').length, 1, 'only the page script itself');
  assert.strictEqual(p2.$('.tab .t').textContent, evil, 'it is shown as the text it is');
  const k = p2.d.querySelector('.tab .k');
  assert.deepStrictEqual([k.tagName, k.textContent], ['SPAN', 'C'], 'letters when the vendor icon is absent');
  assert.strictEqual(p2.d.querySelector('#e-claude .k').textContent, 'C');
  p2.w.close();
}

console.log('PAGE OK');
