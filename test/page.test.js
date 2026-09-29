'use strict';
// Runs the real webview script in a DOM and drives it the way the host does.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { getHtml } = require('../src/webview');

const html = getHtml({ nonce: 'n', cspSource: 'x' }).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const out = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))) }); w.HTMLElement.prototype.scrollIntoView = function () {}; } });
const { window } = dom; const d = window.document;
const host = (m) => window.dispatchEvent(new window.MessageEvent('message', { data: m }));
const ev = (sid, e) => host({ type: 'event', sid, ev: e });
const $ = (s) => d.querySelector(s), $$ = (s) => [...d.querySelectorAll(s)];
const visiblePane = () => $$('.pane').filter((p) => !p.hidden);
const tab = (o) => Object.assign({ busy: false, attention: false, mode: o.kind === 'claude' ? 'default' : 'workspace-write', modes: o.kind === 'claude' ? ['default', 'plan'] : ['read-only', 'workspace-write'] }, o);

assert.deepStrictEqual(out.shift(), { type: 'ready' }, 'page announces ready');

const A = tab({ id: 'a', kind: 'claude', title: 'Claude 1' }), B = tab({ id: 'b', kind: 'codex', title: 'Codex 1' });
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.strictEqual($$('.tab').length, 2, 'two tabs rendered');
assert.strictEqual($$('.tab.active .t')[0].textContent, 'Claude 1');
assert.strictEqual($$('.pane').length, 2); assert.strictEqual(visiblePane().length, 1, 'only the active pane is visible');
assert.deepStrictEqual($$('.tab .k').map((k) => k.textContent), ['C', 'X'], 'kind badges');

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

// mode selector is per tab and per kind
assert.deepStrictEqual([...paneB.querySelectorAll('select option')].map((o) => o.value), ['read-only', 'workspace-write']);
const sel = paneA.querySelector('select'); sel.value = 'plan'; sel.dispatchEvent(new window.Event('change'));
assert.deepStrictEqual(out.pop(), { type: 'setMode', sid: 'a', value: 'plan' });

// new-tab menu and close
$('#add').click();
assert.deepStrictEqual($$('#menu div').map((r) => r.textContent), ['CNew Claude tab', 'XNew Codex tab']);
$$('#menu div')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'codex' });
assert.strictEqual($('#menu'), null, 'menu closes after choosing');
$$('.tab .x')[1].click(); assert.deepStrictEqual(out.pop(), { type: 'close', sid: 'b' });
host({ type: 'tabs', tabs: [A], active: 'a' });
assert.strictEqual($$('.pane').length, 1, 'closed tab removes its pane');

// fill (handoff) targets the right draft; clear resets a pane; no tabs shows the empty state
ev('a', { kind: 'fill', text: 'handed off' }); assert.strictEqual($('#input').value, 'handed off');
ev('a', { kind: 'clear' }); assert.strictEqual(paneA.querySelectorAll('.msg').length, 0);
host({ type: 'tabs', tabs: [], active: null });
assert.strictEqual($('#empty').hidden, false); assert.strictEqual($('#input').disabled, true);

console.log('PAGE OK');
window.close();
