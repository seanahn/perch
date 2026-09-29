'use strict';
// Runs the real webview script in a DOM and drives it the way the host does.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { getHtml } = require('../src/webview');

const ICONS = { claude: { glyph: 'vscode-resource://host/claude.svg', image: 'vscode-resource://host/claude.png' }, codex: { glyph: 'vscode-resource://host/blossom.svg', image: 'vscode-resource://host/chatgpt.png' } };
const IMAGES_ONLY = { claude: { image: ICONS.claude.image }, codex: { image: ICONS.codex.image } };
const strip = (h) => h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const html = getHtml({ nonce: 'n', cspSource: 'x', icons: ICONS }).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const out = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))) }); w.HTMLElement.prototype.scrollIntoView = function () {}; } });
const { window } = dom; const d = window.document;
const host = (m) => window.dispatchEvent(new window.MessageEvent('message', { data: m }));
const ev = (sid, e) => host({ type: 'event', sid, ev: e });
const $ = (s) => d.querySelector(s), $$ = (s) => [...d.querySelectorAll(s)];
// rendered visibility, not the attribute: an author display rule can override [hidden]
const shown = (n) => window.getComputedStyle(n).display !== 'none';
const visiblePane = () => $$('.pane').filter(shown);
const opt = (v, label) => ({ value: v, label: label || v || 'default' });
const tab = (o) => Object.assign({
  busy: false, attention: false, started: false, actualModel: '', approvals: o.kind === 'codex' ? 'on-failure' : '',
  model: '', models: o.kind === 'claude' ? [opt('', 'default · Opus 5.5'), opt('opus', 'Opus 5.5'), opt('haiku', 'Haiku 4.5')] : [opt('', 'default · GPT-5.6-Sol'), opt('gpt-5.5', 'GPT-5.5')],
  effort: '', efforts: o.kind === 'claude' ? [opt(''), opt('low'), opt('high'), opt('max')] : [opt('', 'default · ultra'), opt('high'), opt('ultra')],
  mode: o.kind === 'claude' ? 'default' : 'workspace-write', modes: o.kind === 'claude' ? ['default', 'plan'] : ['read-only', 'workspace-write'],
}, o);
const names = (pane) => [...pane.querySelectorAll('select')].map((x) => x.parentElement.textContent.split(' ')[0]);
const pick = (pane, name) => [...pane.querySelectorAll('select')].find((x) => x.parentElement.textContent.startsWith(name + ' '));
const change = (select, v) => { select.value = v; select.dispatchEvent(new window.Event('change')); };

assert.deepStrictEqual(out.shift(), { type: 'ready' }, 'page announces ready');

host({ type: 'tabs', tabs: [], active: null });
assert(shown($('#empty')), 'a fresh page shows the empty state'); assert.strictEqual($$('.tab').length, 0);

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

// events land in their own pane
ev('a', { kind: 'status', text: 'ready · a' }); ev('b', { kind: 'status', text: 'idle · sandbox workspace-write' });
ev('a', { kind: 'user', text: 'hello a' }); ev('a', { kind: 'delta', text: 'par' }); ev('a', { kind: 'delta', text: 'tial' });
assert.strictEqual(visiblePane()[0].querySelector('.live').textContent, 'partial', 'deltas stream into a live bubble');
ev('a', { kind: 'text', text: 'final answer' });
assert.strictEqual(visiblePane()[0].querySelectorAll('.live').length, 0, 'live bubble replaced by the final text');
ev('b', { kind: 'text', text: 'codex says hi' });
const paneA = $$('.pane')[0], paneB = $$('.pane')[1];
assert.deepStrictEqual([...paneA.querySelectorAll('.msg')].map((m) => m.textContent), ['hello a', 'final answer']);
assert.deepStrictEqual([...paneB.querySelectorAll('.msg')].map((m) => m.textContent), ['codex says hi'], 'background tab received its own event only');
assert.strictEqual(paneA.querySelector('.bar .grow').textContent, 'ready · a', 'status is per tab');

// drafts are per tab
$('#input').value = 'draft for a';
$$('.tab')[1].click();
assert.deepStrictEqual(out.pop(), { type: 'activate', sid: 'b' }, 'clicking a tab asks the host to activate it');
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.strictEqual($('#input').value, '', 'other tab starts with its own empty draft');
assert.strictEqual(visiblePane()[0], paneB);
assert(/Message Codex 1/.test($('#input').placeholder));
$('#input').value = 'draft for b';
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.strictEqual($('#input').value, 'draft for a', 'draft restored when returning');

// send goes to the active tab; busy turns Send into Stop
$('#input').value = 'go'; $('#send').click();
assert.deepStrictEqual(out.pop(), { type: 'send', sid: 'a', text: 'go' });
assert.strictEqual($('#input').value, '');
host({ type: 'tabs', tabs: [Object.assign({}, A, { busy: true }), B], active: 'a' });
assert.strictEqual($('#send').textContent, 'Stop'); assert($('.tab.active').classList.contains('busy'));
$('#send').click(); assert.deepStrictEqual(out.pop(), { type: 'stop', sid: 'a' });
host({ type: 'tabs', tabs: [A, Object.assign({}, B, { attention: true })], active: 'a' });
assert.strictEqual($('#send').textContent, 'Send'); assert($$('.tab')[1].classList.contains('attn'), 'attention badge on the background tab');

// permission prompt
ev('a', { kind: 'permission', id: 'p1', tool: 'Write', input: { file_path: '/x' }, hasSuggestions: false });
let btns = [...paneA.querySelectorAll('.perm button')].map((b) => b.textContent);
assert.deepStrictEqual(btns, ['Allow', 'Deny'], 'no Always without suggestions');
paneA.querySelector('.perm button').click();
assert.deepStrictEqual(out.pop(), { type: 'permission', sid: 'a', id: 'p1', decision: 'allow' });
assert.strictEqual(paneA.querySelectorAll('.perm').length, 0, 'answered prompt collapses');
ev('a', { kind: 'permission', id: 'p2', tool: 'Bash', input: { command: 'rm x' }, hasSuggestions: true });
assert.deepStrictEqual([...paneA.querySelectorAll('.perm button')].map((b) => b.textContent), ['Allow', 'Always', 'Deny']);

// tool call and result pair up; result line shows cache usage
ev('a', { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/y' } });
ev('a', { kind: 'text', text: 'between' });
ev('a', { kind: 'tool_result', id: 't1', text: 'file body' });
const kids = [...paneA.querySelectorAll('.msg')]; const ti = kids.findIndex((k) => k.classList.contains('tool'));
assert(kids[ti + 1].classList.contains('toolres'), 'result sits directly under its tool call');
ev('a', { kind: 'result', ok: true, duration_ms: 2900, usage: { input: 13822, cache_read: 7680, output: 11 } });
assert(/done · 2\.9s · in 13822 · cached 7680 · out 11/.test(paneA.querySelector('.result').textContent));

// three selectors per tab, in a fixed order; the status text carries state only
assert.deepStrictEqual(names(paneA), ['model', 'effort', 'mode']);
assert.deepStrictEqual(names(paneB), ['model', 'effort', 'sandbox']);

// mode
assert.deepStrictEqual([...pick(paneB, 'sandbox').options].map((o) => o.value), ['read-only', 'workspace-write']);
change(pick(paneA, 'mode'), 'plan');
assert.deepStrictEqual(out.pop(), { type: 'setMode', sid: 'a', value: 'plan' });
assert(/Approvals: on-failure/.test(pick(paneB, 'sandbox').title), 'codex approval policy is in the tooltip');

// model: labels come from the host, the default says what it resolves to
const modA = pick(paneA, 'model'), modB = pick(paneB, 'model');
assert.deepStrictEqual([...modA.options].map((o) => [o.value, o.textContent]), [['', 'default · Opus 5.5'], ['opus', 'Opus 5.5'], ['haiku', 'Haiku 4.5']]);
assert.deepStrictEqual([...modB.options].map((o) => o.textContent), ['default · GPT-5.6-Sol', 'GPT-5.5']);
change(modA, 'haiku');
assert.deepStrictEqual(out.pop(), { type: 'setModel', sid: 'a', value: 'haiku' });

// effort: 'default' is the empty value
const effA = pick(paneA, 'effort'), effB = pick(paneB, 'effort');
assert.deepStrictEqual([...effA.options].map((o) => [o.value, o.textContent]), [['', 'default'], ['low', 'low'], ['high', 'high'], ['max', 'max']]);
assert.deepStrictEqual([...effB.options].map((o) => [o.value, o.textContent]), [['', 'default · ultra'], ['high', 'high'], ['ultra', 'ultra']]);
change(effA, 'high');
assert.deepStrictEqual(out.pop(), { type: 'setEffort', sid: 'a', value: 'high' });
host({ type: 'tabs', tabs: [Object.assign({}, A, { effort: 'max' }), B], active: 'a' });
assert.strictEqual(effA.value, 'max', 'selector follows the host');

// the host answers a model change with a new effort list: the options are rebuilt, and a single option disables the control
host({ type: 'tabs', tabs: [Object.assign({}, A, { model: 'haiku', effort: '', efforts: [opt('')], actualModel: 'claude-haiku-4-5' }), B], active: 'a' });
assert.strictEqual(modA.value, 'haiku');
assert.deepStrictEqual([...effA.options].map((o) => o.value), [''], 'effort options follow the model');
assert.strictEqual(effA.disabled, true, 'nothing to choose');
assert(/no effort control/.test(effA.title));
assert(/Running claude-haiku-4-5/.test(modA.title), 'tooltip names the model actually running');
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.deepStrictEqual([...effA.options].map((o) => o.value), ['', 'low', 'high', 'max']); assert.strictEqual(effA.disabled, false);
assert.strictEqual(effA.value, '', 'and returns to default'); assert.strictEqual(modA.value, '');
assert.strictEqual(pick(paneA, 'effort'), effA, 'controls are updated in place, not recreated');

// a started codex thread says its choices are fixed
host({ type: 'tabs', tabs: [A, Object.assign({}, B, { started: true })], active: 'a' });
assert(/keeps the model it started with/.test(modB.title) && /keeps the effort it started with/.test(effB.title) && /keeps the sandbox it started with/.test(pick(paneB, 'sandbox').title));
host({ type: 'tabs', tabs: [A, B], active: 'a' });

// new-tab menu and close
$('#add').click();
assert.deepStrictEqual($$('#menu div').map((r) => r.textContent), ['New Claude tab', 'New Codex tab']);
assert.deepStrictEqual($$('#menu .k').map((i) => i.className), ['k glyph claude', 'k glyph codex'], 'menu rows carry the vendor glyphs');
$$('#menu div')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'codex' });
assert.strictEqual($('#menu'), null, 'menu closes after choosing');
$$('.tab .x')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'close', sid: 'b' });
host({ type: 'tabs', tabs: [A], active: 'a' });
assert.strictEqual($$('.pane').length, 1, 'closed tab removes its pane');

// fill (handoff) targets the right draft; clear resets a pane; no tabs shows the empty state
ev('a', { kind: 'fill', text: 'handed off' }); assert.strictEqual($('#input').value, 'handed off');
ev('a', { kind: 'clear' }); assert.strictEqual(paneA.querySelectorAll('.msg').length, 0);
host({ type: 'tabs', tabs: [], active: null });
assert(shown($('#empty')), 'empty state is visible with no tabs'); assert.strictEqual($('#input').disabled, true);
assert.deepStrictEqual($$('#empty button').map((x) => x.textContent), ['New Claude tab', 'New Codex tab'], 'empty state offers both kinds');
assert.deepStrictEqual($$('#empty .k').map((i) => i.className), ['k glyph claude', 'k glyph codex'], 'empty state carries the vendor glyphs');
$$('#empty button')[0].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'claude' });
host({ type: 'tabs', tabs: [A], active: 'a' });
assert(!shown($('#empty')), 'empty state hides once a tab exists');

// no glyph available: the marketplace image is used, and a failed image falls back to its letter
{
  const w3 = new JSDOM(strip(getHtml({ nonce: 'n', cspSource: 'x', icons: IMAGES_ONLY })), { runScripts: 'dangerously', beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage() {} }); w.HTMLElement.prototype.scrollIntoView = function () {}; } }).window;
  w3.dispatchEvent(new w3.MessageEvent('message', { data: { type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'Claude 1' }), tab({ id: 'b', kind: 'codex', title: 'Codex 1' })], active: 'a' } }));
  const q = (sel) => [...w3.document.querySelectorAll(sel)];
  assert.deepStrictEqual(q('.tab .k').map((k) => [k.tagName, k.getAttribute('src')]), [['IMG', IMAGES_ONLY.claude.image], ['IMG', IMAGES_ONLY.codex.image]], 'images when there are no glyphs');
  assert.deepStrictEqual(q('#empty img').map((i) => i.getAttribute('src')), [IMAGES_ONLY.claude.image, IMAGES_ONLY.codex.image]);
  q('.tab img.k')[0].dispatchEvent(new w3.Event('error'));
  assert.deepStrictEqual(q('.tab .k').map((k) => [k.tagName, k.textContent]), [['SPAN', 'C'], ['IMG', '']], 'failed image falls back to the letter');
  q('#empty img')[1].dispatchEvent(new w3.Event('error'));
  assert.strictEqual(w3.document.querySelector('#e-codex .k').textContent, 'X', 'static badges fall back too');
  w3.close();
}

// with no vendor icons the page uses letters everywhere, and an icon URI cannot break out of the script
{
  const out2 = [];
  const w2 = new JSDOM(strip(getHtml({ nonce: 'n', cspSource: 'x', icons: { codex: { image: 'x</script><script>window.pwned=1</script>', glyph: 'y"); } </style><script>window.pwned=2</script>' } } })), { runScripts: 'dangerously', beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out2.push(m) }); w.HTMLElement.prototype.scrollIntoView = function () {}; } }).window;
  assert.strictEqual(w2.pwned, undefined, 'icon URIs are escaped inside the script and the stylesheet');
  assert.strictEqual(out2.length, 1, 'page script still ran');
  w2.dispatchEvent(new w2.MessageEvent('message', { data: { type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'Claude 1' })], active: 'a' } }));
  const k = w2.document.querySelector('.tab .k');
  assert.deepStrictEqual([k.tagName, k.textContent], ['SPAN', 'C'], 'letters when the vendor icon is absent');
  assert.strictEqual(w2.document.querySelector('#e-claude .k').textContent, 'C');
  w2.close();
}

console.log('PAGE OK');
window.close();
