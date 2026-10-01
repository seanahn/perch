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
// The page script lives inside a template literal, so an escape written one level short becomes a raw line break inside
// a string and the whole script fails to parse. Check that first, and say so plainly.
{
  const h = getHtml({ nonce: 'n', cspSource: 'x', icons: ICONS });
  const js = h.slice(h.indexOf('<script nonce'), h.lastIndexOf('</script>')).replace(/^<script[^>]*>/, '');
  try { new Function(js); } catch (e) { console.error('PAGE SCRIPT DOES NOT PARSE: ' + e.message + '. Look for an escape such as \\n written with one backslash too few in src/webview.js.'); process.exit(1); }
}

function page(icons) {
  const out = [], states = [];
  const dom = new JSDOM(strip(getHtml({ nonce: 'n', cspSource: 'x', icons })), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))), setState: (x) => states.push(JSON.parse(JSON.stringify(x))), getState: () => states[states.length - 1] }); w.HTMLElement.prototype.scrollIntoView = function () {}; } });
  const w = dom.window, d = w.document;
  return { w, d, out, states, host: (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m })), $: (s) => d.querySelector(s), $$: (s) => [...d.querySelectorAll(s)], shown: (n) => !!n && w.getComputedStyle(n).display !== 'none' && (!n.parentElement || n.parentElement === d.body || w.getComputedStyle(n.parentElement).display !== 'none') };
}
const P = page(ICONS);
const { w: window, d, out, host, $, $$, shown } = P;
const ev = (sid, e) => host({ type: 'event', sid, ev: e });
const visiblePane = () => $$('.pane').filter(shown);
const opt = (v, label, title) => Object.assign({ value: v, label: label || v || 'default' }, title ? { title } : {});
const tab = (o) => Object.assign({
  busy: false, attention: false, started: false, actualModel: '', backend: '', queued: 0, ide: false, approvals: o.kind === 'codex' ? 'on-failure' : '',
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
assert.deepStrictEqual([$('#input').disabled, $('#send').disabled, $('#t-model').disabled, $('#t-mode').disabled, $('#t-add').disabled, $('#t-mic').disabled], [true, true, true, true, true, true], 'the composer is inert with no tab');
assert.strictEqual($('#composer').className, 'off');
assert(!shown($('#t-slash')) && !shown($('#t-ctx')) && !shown($('#t-cache')));
$('#send').click(); $('#t-model').click(); $('#t-mode').click(); $('#t-mic').click(); key($('#input'), 'Enter'); key($('#input'), 'Escape');
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
assert.deepStrictEqual([paneA.querySelector('.state'), paneA.querySelector('.bar'), paneB.querySelector('.dot')], [null, null, null], 'an idle tab says nothing about itself: the foot of the transcript speaks while it works');
assert.strictEqual(paneA.querySelectorAll('select').length, 0, 'no selector row: the composer carries the choices');
ev('a', { kind: 'user', text: 'later', queued: true });
const q = [...paneA.querySelectorAll('.user')].pop();
assert.deepStrictEqual([q.classList.contains('queued'), q.querySelector('.tag').textContent, q.textContent], [true, 'queued', 'queuedlater'], 'a queued message is marked');

// ---- composer, Claude tab
assert.strictEqual($('#composer').className, 'claude');
assert.strictEqual($('#input').placeholder, 'Message Claude…');
assert(shown($('#t-ide')) && !shown($('#tools .sep')) && !shown($('#t-model .chev')), 'IDE context on both; the rule and the chevron belong to Codex');
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
{
  // the arrow keys walk the tab's earlier messages
  host({ type: 'event', sid: 'a', ev: { kind: 'user', text: 'first question', queued: false } });
  host({ type: 'event', sid: 'a', ev: { kind: 'user', text: 'second one', queued: false } });
  host({ type: 'event', sid: 'a', ev: { kind: 'user', text: '', queued: false, images: 1 } });   // an image alone is not a message to walk to
  $('#input').value = 'a draft'; $('#input').setSelectionRange(7, 7);
  key($('#input'), 'ArrowUp'); assert.strictEqual($('#input').value, 'second one', 'up: the last message');
  key($('#input'), 'ArrowUp'); assert.strictEqual($('#input').value, 'first question');
  for (let i = 0; i < 30; i++) key($('#input'), 'ArrowUp'); const oldest = $('#input').value;   // this tab had messages before these two
  key($('#input'), 'ArrowUp'); assert.strictEqual($('#input').value, oldest, 'and no further than the oldest');
  let steps = 0; while ($('#input').value !== 'second one' && steps++ < 30) key($('#input'), 'ArrowDown');
  assert.strictEqual($('#input').value, 'second one', 'down comes forward');
  key($('#input'), 'ArrowDown'); assert.strictEqual($('#input').value, 'a draft', 'past the newest, the draft returns');
  key($('#input'), 'ArrowDown'); assert.strictEqual($('#input').value, 'a draft', 'down with nothing newer does nothing');
  $('#input').value = 'two\nlines'; $('#input').setSelectionRange(9, 9);
  key($('#input'), 'ArrowUp'); assert.strictEqual($('#input').value, 'two\nlines', 'up from the second line moves in the text, not in the history');
  $('#input').setSelectionRange(1, 1); key($('#input'), 'ArrowDown'); assert.strictEqual($('#input').value, 'two\nlines', 'down from the first line likewise');
  $('#input').setSelectionRange(0, 0); key($('#input'), 'ArrowUp'); assert.strictEqual($('#input').value, 'second one', 'from the first line, back it goes');
  $('#input').value = 'line one'; $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));   // back to the text the next test sends
  assert.strictEqual(out.length, 0);
}
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
assert.deepStrictEqual(['#t-add', '#t-mode', '#t-model', '#tools .sep', '#t-ide', '#tools .sp', '#t-mic', '#send'].map((q) => order($(q))), [1, 2, 3, 4, 5, 6, 7, 8], 'tools are laid out in Codex order');
assert(/M8 1\.8l5 1\.8/.test($('#t-mode').innerHTML), 'a shield, not a bolt');
assert(shown($('#t-model .chev')) && shown($('#t-ide')) && shown($('#tools .sep')));
assert.strictEqual(window.getComputedStyle($('#send')).borderRadius, '50%');
assert(/#composer\.codex #send \{[^}]*background: rgba\(128,128,128,\.4\); background: color-mix\(in srgb, var\(--vscode-foreground\) 26%, transparent\)/.test(css), 'the disc is mixed from the text colour, with a plain fallback, so it shows on any theme');
assert(/#composer\.codex #tools \{ border-top: none;/.test(css), 'no rule between the message and the tools');   // the test DOM does not resolve border shorthands, so the stylesheet is checked
assert.deepStrictEqual([$('#t-ide').textContent, $('#t-ide').getAttribute('aria-pressed'), $('#t-ide').classList.contains('on')], ['IDE context', 'false', false], 'off: grey');
assert(/^IDE context is off\./.test($('#t-ide').title));
$('#t-ide').click(); assert.deepStrictEqual(out.pop(), { type: 'setIde', sid: 'b', value: true });
host({ type: 'tabs', tabs: [A, with_(B, { ide: true, mode: 'danger-full-access' })], active: 'b' });
assert.deepStrictEqual([$('#t-ide').getAttribute('aria-pressed'), $('#t-ide').classList.contains('on'), $('#t-ide').textContent], ['true', true, 'IDE context'], 'on: green'); assert(/^IDE context is on: the active file and selection are attached/.test($('#t-ide').title));
$('#t-ide').click(); assert.deepStrictEqual(out.pop(), { type: 'setIde', sid: 'b', value: false });
assert.deepStrictEqual([$('#t-mode').textContent, $('#t-mode').classList.contains('risk')], ['Full access', true], 'full access is flagged in amber');
host({ type: 'tabs', tabs: [A, with_(B, { busy: true })], active: 'b' });
assert.deepStrictEqual([$('#input').placeholder, $('#send').className], ['Queue another message…', 'stop']);
assert(!shown($('#meter')), 'no footer until the host sends a reading');
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: '', level: 'ok', action: 'refresh', lines: [], segments: [] } });
assert(!shown($('#meter')), 'Claude\'s reading is not shown under a Codex tab');
const CODEX = { vendor: 'Codex', plan: 'plus', asOf: true, level: 'ok', action: 'refresh', fetchedAt: 1790708709271, lines: ['Codex usage, percent remaining', 'row'], text: '2.3h 96% 6.9d 99%', segments: [{ text: '2.3h 96%', level: 'ok', title: '5h session: 96% remaining' }, { text: '6.9d 99%', level: 'ok', title: 'Weekly: 99% remaining' }] };
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: 'Claude backend', level: 'ok', action: 'refresh', lines: ['c'], segments: [{ text: '26m 85%', level: 'ok', title: 'claude 5h' }] }, codex: CODEX });
assert(shown($('#meter')) && shown($('#m-where')), 'beneath a Codex tab: where the work runs, and the ChatGPT plan\'s usage');
assert.strictEqual($('#m-where').textContent, 'Work locally'); assert(/runs Codex on this machine/.test($('#m-where').title));
assert.deepStrictEqual([...$('#m-usage').children].map((n) => n.textContent), ['2.3h 96%', '6.9d 99%'], 'Codex figures, not Claude\'s');
assert(shown($('#m-codex')) && !shown($('#m-claude')), 'the ChatGPT glyph; no Claude glyph, and the backend switch shows Codex\'s backend');
assert.strictEqual($('#m-codex .k').className, 'k glyph codex');
assert.deepStrictEqual([shown($('#m-plan')), $('#m-plan').textContent, $('#m-plan').title], [true, 'plus', 'ChatGPT plan: plus. Click to open your usage page.']);
$('#m-plan').click(); assert.deepStrictEqual(out.pop(), { type: 'openExternal', url: 'https://chatgpt.com/codex/settings/usage' }, 'the plan badge opens the usage page');
$('#m-codex').click(); assert.deepStrictEqual([out.pop(), $('#m-codex').title], [{ type: 'openExternal', url: 'https://chatgpt.com/' }, 'Open chatgpt.com'], 'the vendor mark opens the vendor site');
// under a Codex tab the backend button shows the Codex backend, and a click asks the host to switch it
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: '', level: 'ok', action: 'refresh', lines: [], segments: [] }, codex: Object.assign({}, CODEX, { backend: 'chatgpt', backendLabel: 'ChatGPT', backendTitle: 'Codex runs on your ChatGPT login and its plan. Click to use an OpenAI API key instead.' }) });
assert.deepStrictEqual([shown($('#m-backend')), $('#m-backend').textContent, $('#m-backend').title], [true, 'ChatGPT', 'Codex runs on your ChatGPT login and its plan. Click to use an OpenAI API key instead.']);
$('#m-backend').click(); assert.deepStrictEqual(out.pop(), { type: 'meterToggle', vendor: 'codex' });
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: '', level: 'ok', action: 'refresh', lines: [], segments: [] }, codex: Object.assign({}, CODEX, { backend: 'api', backendLabel: 'API', backendTitle: 'on the key', plan: '', segments: [], level: 'none', lines: ['Codex is on your API key: billed per token, no plan limits.'] }) });
assert.deepStrictEqual([$('#m-backend').textContent, shown($('#m-plan')), [...$('#m-usage').children].map((n) => n.textContent)], ['API', false, ['\u2014']], 'on the key: no plan badge, no limits');
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: '', level: 'ok', action: 'refresh', lines: [], segments: [] }, codex: CODEX });
$('#m-claude').click(); assert.deepStrictEqual([out.pop(), $('#m-claude').title], [{ type: 'openExternal', url: 'https://claude.ai/' }, 'Open claude.ai']);
assert(/^5h session: 96% remaining\nAs of the last Codex turn on this machine, .*\. Click to refresh\.$/.test($('#m-usage').children[0].title), 'the reading says how old it is');
$('#m-usage').click(); assert.deepStrictEqual(out.pop(), { type: 'meterRefresh', vendor: 'codex' });
host({ type: 'meter', meter: null, codex: Object.assign({}, CODEX, { plan: '', level: 'none', text: '\u2014', segments: [], fetchedAt: null, lines: ['Codex usage unavailable: no Codex session on this machine has reported usage yet.'] }) });
assert.deepStrictEqual([[...$('#m-usage').children].map((n) => n.textContent), shown($('#m-plan'))], [['\u2014'], false]);
assert.strictEqual($('#m-usage').title, 'Codex usage unavailable: no Codex session on this machine has reported usage yet.\nClick to refresh.');
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: 'Claude backend', level: 'ok', action: 'refresh', lines: ['c'], segments: [{ text: '26m 85%', level: 'ok', title: 'claude 5h' }] }, codex: CODEX });
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.deepStrictEqual([[...$('#m-usage').children].map((n) => n.textContent), shown($('#m-backend')), shown($('#m-claude')), shown($('#m-codex')), shown($('#m-plan')), shown($('#m-where'))], [['26m 85%'], true, true, false, false, false], 'switching to a Claude tab switches the footer');
host({ type: 'meter', meter: { vendor: 'Claude', backendLabel: 'sub', backendTitle: 'Claude backend', level: 'ok', action: 'refresh', lines: ['c'], segments: [{ text: '25m 84%', level: 'ok', title: 'claude 5h' }] } });
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.deepStrictEqual([...$('#m-usage').children].map((n) => n.textContent), ['2.3h 96%', '6.9d 99%'], 'a Claude update that does not mention Codex leaves the Codex reading in place');
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

// a started Codex thread changes model, effort, and sandbox as a Claude session does: from the next message
host({ type: 'tabs', tabs: [A, with_(B, { started: true, model: 'gpt-5.5', effort: 'high' })], active: 'b' });
assert.deepStrictEqual([$('#t-model .m').textContent, $('#t-model .e').textContent], ['GPT-5.5', 'High']);
assert(/Changes apply from the next message\.$/.test($('#t-model').title));
$('#t-model').click();
assert(menuItems().every((x) => !x.dis), 'every choice can be made');
assert.deepStrictEqual(menuItems().filter((x) => x.on).map((x) => x.label), ['GPT-5.5', 'High']);
menuItems()[0].n.click(); assert.deepStrictEqual(out.pop(), { type: 'setModel', sid: 'b', value: '' });
$('#t-model').click(); pickItem('Ultra'); assert.deepStrictEqual(out.pop(), { type: 'setEffort', sid: 'b', value: 'ultra' });
$('#t-mode').click();
assert(menuItems().every((x) => !x.dis)); pickItem('Read only'); assert.deepStrictEqual(out.pop(), { type: 'setMode', sid: 'b', value: 'read-only' });
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

// ---- dictation
const mic = $('#t-mic');
assert.deepStrictEqual([mic.disabled, mic.className, mic.getAttribute('aria-pressed'), mic.title, mic.querySelector('.tm').textContent], [false, 'tb', 'false', 'Dictate', '']);
assert(/<rect/.test(mic.querySelector('.ic').innerHTML), 'a microphone');
mic.click(); assert.deepStrictEqual(out.pop(), { type: 'voiceStart', sid: 'a' });
ev('a', { kind: 'voice', phase: 'starting' });
assert.deepStrictEqual([mic.className, mic.title], ['tb busy', 'Opening the microphone…']);
mic.click(); assert.strictEqual(out.length, 0, 'while it is opening, another press does nothing');
ev('a', { kind: 'voice', phase: 'recording', level: 0, seconds: 0, device: 'Headset Microphone', maxSeconds: 180 });
assert.deepStrictEqual([mic.className, mic.getAttribute('aria-pressed'), mic.querySelector('.tm').textContent, $('#composer').classList.contains('listening')], ['tb rec', 'true', '0:00', true]);
assert.strictEqual($('#input').placeholder, 'Listening… click the microphone to finish, Escape to discard');
assert.strictEqual(mic.title, 'Listening on Headset Microphone. Click to finish, Escape to discard. Stops at 3:00.');
ev('a', { kind: 'voice', phase: 'recording', level: 0.5, seconds: 67.4, device: 'Headset Microphone', maxSeconds: 180 });
assert.deepStrictEqual([mic.querySelector('.tm').textContent, mic.querySelector('.ring').style.transform], ['1:07', 'scale(1.60)'], 'the time runs, and the ring swells with the voice');
ev('a', { kind: 'voice', phase: 'recording', level: 9, seconds: 68 }); assert.strictEqual(mic.querySelector('.ring').style.transform, 'scale(2.20)', 'within bounds');
ev('a', { kind: 'voice', phase: 'recording', level: 0, seconds: 3, device: 'Headset Microphone', silent: true });
assert.deepStrictEqual([mic.className, /^Nothing is being heard from Headset Microphone\./.test(mic.title)], ['tb rec silent', true], 'a microphone that hears nothing is flagged while there is time to notice');
assert.strictEqual(paneA.querySelectorAll('.msg').length, [...paneA.querySelectorAll('.msg')].length); const before = paneA.querySelectorAll('.msg').length;
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.deepStrictEqual([mic.className, $('#composer').classList.contains('listening'), $('#input').placeholder], ['tb', false, 'Do anything'], 'it is the other tab that is dictating');
host({ type: 'tabs', tabs: [A, B], active: 'a' });
assert.deepStrictEqual([mic.className, mic.querySelector('.tm').textContent], ['tb rec silent', '0:03'], 'and it still is, on returning');
key($('#input'), 'Escape'); assert.deepStrictEqual(out.pop(), { type: 'voiceCancel' }, 'escape discards');
$('#t-model').click(); key($('#input'), 'Escape'); assert.deepStrictEqual([$('#menu'), out.length], [null, 0], 'with a menu open, escape closes the menu first');
key(d.body, 'Escape'); assert.deepStrictEqual(out.pop(), { type: 'voiceCancel' }, 'wherever the focus is');
mic.click(); assert.deepStrictEqual(out.pop(), { type: 'voiceStop', sid: 'a' }, 'pressing it again finishes');
ev('a', { kind: 'voice', phase: 'transcribing', device: 'Headset Microphone' });
assert.deepStrictEqual([mic.className, mic.querySelector('.tm').textContent, mic.title, $('#input').placeholder, $('#composer').classList.contains('listening')], ['tb busy', '…', 'Turning speech into text…', 'Turning speech into text…', false]);
mic.click(); key($('#input'), 'Escape'); assert.strictEqual(out.length, 0, 'there is nothing to stop or discard while it is being transcribed');
type('so far '); ev('a', { kind: 'voice', phase: 'idle' }); ev('a', { kind: 'insert', text: 'hello world ' });
assert.deepStrictEqual([mic.className, mic.title, $('#input').value, $('#input').placeholder], ['tb', 'Dictate', 'so far hello world ', 'Message Claude…'], 'the words join what was already written');
assert.strictEqual(paneA.querySelectorAll('.msg').length, before, 'dictation leaves no trace in the transcript');
key($('#input'), 'Escape'); assert.strictEqual(out.length, 0);
type('');
host({ type: 'tabs', tabs: [A, B], active: 'b' });
assert.strictEqual(order($('#t-mic')) < order($('#send')) && order($('#t-mic')) > order($('#t-ide')), true, 'in a Codex tab the microphone sits where Codex puts it, before the send button');
mic.click(); assert.deepStrictEqual(out.pop(), { type: 'voiceStart', sid: 'b' });
host({ type: 'tabs', tabs: [A, B], active: 'a' });

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

// ---- a question from the agent: choices as buttons, a line of your own, one answer for all
{
  const Q = [
    { question: 'Which store?', header: 'Store', options: [{ label: 'Redis', description: 'Fast' }, { label: 'S3', description: 'Cheap' }], multiSelect: false },
    { question: 'Which features?', header: 'Features', options: [{ label: 'Rename' }, { label: 'Resume' }, { label: 'Images' }], multiSelect: true },
  ];
  ev('a', { kind: 'question', id: 'q1', questions: Q });
  const card = paneA.querySelector('.ask'); const secs = [...card.querySelectorAll('.q')];
  assert.deepStrictEqual(secs.map((s) => [s.querySelector('.chip').textContent, s.querySelector('.t').textContent, [...s.querySelectorAll('.opt .l')].map((n) => n.textContent)]), [['Store', 'Which store?', ['Redis', 'S3']], ['Features', 'Which features?', ['Rename', 'Resume', 'Images']]]);
  assert.strictEqual(secs[0].querySelector('.opt .d').textContent, 'Fast');
  const send = card.querySelector('.btns .primary'), opts = (i) => [...secs[i].querySelectorAll('.opt')];
  assert.deepStrictEqual([send.textContent, send.disabled, card.querySelector('.btns button:not(.primary)').textContent], ['Answer all', true, 'Skip'], 'nothing can be sent until every question has an answer');
  opts(0)[0].click(); opts(0)[1].click();
  assert.deepStrictEqual(opts(0).map((b) => b.classList.contains('on')), [false, true], 'one choice at a time');
  assert.strictEqual(send.disabled, true, 'the second question is still open');
  opts(1)[0].click(); opts(1)[2].click(); opts(1)[0].click(); opts(1)[1].click();
  assert.deepStrictEqual(opts(1).map((b) => b.classList.contains('on')), [false, true, true], 'several at once');
  assert.strictEqual(send.disabled, false);
  const own = secs[0].querySelector('.other'); own.value = 'Postgres'; own.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepStrictEqual(opts(0).map((b) => b.classList.contains('on')), [false, false], 'an answer of your own replaces the choice');
  assert.strictEqual(key(own, 'Enter'), false, 'Enter in the line sends the answers, not the message');
  assert.deepStrictEqual(out.pop(), { type: 'permission', sid: 'a', id: 'q1', decision: 'answer', answers: { 'Which store?': 'Postgres', 'Which features?': 'Resume, Images' } });
  assert.strictEqual(paneA.querySelectorAll('.ask button').length, 0, 'answered, the card is settled');
  assert.deepStrictEqual([...paneA.querySelectorAll('.ask.done .q')].map((q) => q.querySelector('.t').textContent + ' ' + q.querySelector('.a').textContent), ['Which store? Postgres', 'Which features? Resume, Images']);

  // skipped
  ev('a', { kind: 'question', id: 'q2', questions: Q.slice(0, 1) });
  const c2 = [...paneA.querySelectorAll('.ask')].pop(); assert.strictEqual(c2.querySelector('.btns .primary').textContent, 'Answer');
  c2.querySelector('.btns button:not(.primary)').click();
  assert.deepStrictEqual(out.pop(), { type: 'permission', sid: 'a', id: 'q2', decision: 'deny' });
  assert.strictEqual(c2.className, 'msg status');

  // an answered question comes back from the host settled, and a past one shows what was asked
  ev('a', { kind: 'answered', questions: Q.slice(0, 1), answers: { 'Which store?': 'S3' } });
  ev('a', { kind: 'answered', questions: Q.slice(0, 1), answers: {} });
  ev('a', { kind: 'tool_use', id: 't9', name: 'AskUserQuestion', input: { questions: Q.slice(0, 1) } });
  const done = [...paneA.querySelectorAll('.ask.done')].slice(-3);
  assert.deepStrictEqual(done.map((d) => d.querySelector('.a').textContent), ['S3', 'not answered', '']);
  assert.strictEqual(paneA.querySelectorAll('.tool').length, 0, 'a question is not shown as a tool call as well');
}

// ---- tool call and result pair up; result line shows cache usage
ev('a', { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/y' } });
ev('a', { kind: 'text', text: 'between' });
ev('a', { kind: 'tool_result', id: 't1', text: 'file body' });
const kids = [...paneA.querySelectorAll('.msg')]; const ti = kids.findIndex((k) => k.classList.contains('tool'));
assert(kids[ti + 1].classList.contains('toolres'), 'result sits directly under its tool call');
{
  // a short result is a plain block; a long one is clipped, takes no wheel, and opens to scroll on its own when clicked
  const short = kids[ti + 1]; short.click();
  assert.deepStrictEqual([short.classList.contains('more'), short.classList.contains('open')], [false, false], 'nothing to open');
  ev('a', { kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } });
  ev('a', { kind: 'tool_result', id: 't2', text: Array.from({ length: 12 }, (_, i) => 'line ' + i).join('\n') });
  const long = [...paneA.querySelectorAll('.toolres')].pop();
  assert(long.classList.contains('more') && !long.classList.contains('open'), 'clipped, not scrollable');
  long.click(); assert(long.classList.contains('open'), 'a click opens it'); long.click(); assert(!long.classList.contains('open'), 'and closes it');
}
{
  // a code block in an answer, and a tool call's command, each carry a copy button; the host does the copying
  ev('a', { kind: 'text', text: 'Run this in your terminal:\n\n```bash\ngit -C /home/jovyan status --short --branch\n```\n\nand `git log` after.' });
  const msg = [...paneA.querySelectorAll('.assistant.md')].pop();
  const boxes = msg.querySelectorAll('.code');
  assert.deepStrictEqual([boxes.length, boxes[0].querySelector('pre code').textContent, msg.querySelectorAll('.cp').length], [1, 'git -C /home/jovyan status --short --branch', 1], 'the fenced block, not the inline code');
  const n0 = out.length; boxes[0].querySelector('.cp').click();
  assert.deepStrictEqual(out.slice(n0), [{ type: 'copy', text: 'git -C /home/jovyan status --short --branch' }]);
  assert.strictEqual(boxes[0].querySelector('.cp').textContent, 'copied');
  ev('a', { kind: 'tool_use', id: 't3', name: 'shell', input: { command: '/bin/bash -lc \'git status --short --branch\'' } });
  const tool = [...paneA.querySelectorAll('.tool')].pop(); tool.querySelector('.cp').click();
  assert.deepStrictEqual([tool.querySelector('.name').textContent, tool.querySelector('.in').textContent, tool.querySelector('.in').classList.contains('mono')], ['shell', '/bin/bash -lc \'git status --short --branch\'', true], 'a command is shown as itself');
  assert.deepStrictEqual(out[out.length - 1], { type: 'copy', text: '/bin/bash -lc \'git status --short --branch\'' }, 'the command itself, not the JSON around it');
  ev('a', { kind: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/x' } });
  [...paneA.querySelectorAll('.tool')].pop().querySelector('.cp').click();
  assert.deepStrictEqual([[...paneA.querySelectorAll('.tool')].pop().querySelector('.name').textContent, [...paneA.querySelectorAll('.tool')].pop().querySelector('.in').textContent], ['Read', '/x'], 'a file tool shows the path');
  // how tool calls read: a Bash with a description, a Read with lines, a search, an agent, and something unknown
  const view = (name, input) => { ev('a', { kind: 'tool_use', id: 'v' + Math.random(), name, input }); const t = [...paneA.querySelectorAll('.tool')].pop(); return [t.querySelector('.name').textContent, t.querySelector('.in').textContent]; };
  assert.deepStrictEqual(view('Bash', { command: 'make test', description: 'Run the tests' }), ['Bash · Run the tests', 'make test']);
  assert.deepStrictEqual(view('Read', { file_path: '/git/perch/src/voice.js', offset: 40, limit: 20 }), ['Read', '/git/perch/src/voice.js:40-60']);
  assert.deepStrictEqual(view('Grep', { pattern: 'busySince', path: '/git/perch/src', glob: '*.js' }), ['Grep · busySince', '/git/perch/src']);
  assert.deepStrictEqual(view('Agent', { description: 'Find the callers', prompt: 'Search the tree for callers of restart()', subagent_type: 'Explore' }), ['Agent · Find the callers', 'Search the tree for callers of restart()']);
  assert.deepStrictEqual(view('WebFetch', { url: 'https://example.com/a', prompt: 'x' }), ['WebFetch', 'https://example.com/a']);
  assert.deepStrictEqual(view('Odd', { a: 1 }), ['Odd', '{\n "a": 1\n}'], 'anything else: the input as before');
  assert.deepStrictEqual(out[out.length - 1], { type: 'copy', text: '{\n "file_path": "/x"\n}' }, 'no command: the input as shown');
  // while an answer streams, the block already has its button, and only one
  ev('a', { kind: 'delta', text: 'Try\n\n```\nls' }); ev('a', { kind: 'delta', text: ' -la\n```\n' });
  const live = paneA.querySelector('.live'); assert.deepStrictEqual([live.querySelectorAll('.cp').length, live.querySelector('pre').textContent], [1, 'ls -la']);
  out.splice(n0);   // the copies this block asked for
}
ev('a', { kind: 'result', ok: true, duration_ms: 2900, usage: { input: 13822, cache_read: 7680, output: 11 } });
{
  // the cost figure is Claude Code's running estimate for the whole session at API rates, and says so; on a subscription it is not a bill
  host({ type: 'tabs', tabs: [with_(A, { backend: 'subscription' }), B], active: 'a' });
  ev('a', { kind: 'result', ok: true, duration_ms: 1000, usage: { input: 1, cache_read: 2, output: 3 }, cost: 43.567 });
  const r = [...paneA.querySelectorAll('.result')].pop();
  assert(/ · out 3$/.test(r.textContent), 'a first turn shows no figure: ' + r.textContent);
  assert(/so far ≈\$43\.57 .*from the next turn on/.test(r.title) && /nothing is billed per token/.test(r.title), 'the total is in the tooltip');
  // once the agent can tell, each turn's own cost is shown, which is what matters in a session that runs for months
  ev('a', { kind: 'result', ok: true, duration_ms: 1000, usage: { input: 1, cache_read: 2, output: 3 }, cost: 43.591, costTurn: 0.0241 });
  const rt = [...paneA.querySelectorAll('.result')].pop();
  assert(/ · ≈\$0\.024 this turn at API rates$/.test(rt.textContent), rt.textContent);
  assert(/This turn's cost .* the session so far ≈\$43\.59\./.test(rt.title) && /nothing is billed/.test(rt.title));
  host({ type: 'tabs', tabs: [with_(A, { backend: 'api' }), B], active: 'a' });
  ev('a', { kind: 'result', ok: true, duration_ms: 1000, usage: { input: 1, cache_read: 2, output: 3 }, cost: 0.5 });
  const r2 = [...paneA.querySelectorAll('.result')].pop();
  assert(/ · out 3$/.test(r2.textContent), r2.textContent); assert(/so far ≈\$0\.500/.test(r2.title) && !/billed/.test(r2.title));
  host({ type: 'tabs', tabs: [A, B], active: 'a' });
}
assert(/done · 2\.9s · in 13822 · cached 7680 · out 11/.test(paneA.querySelector('.result').textContent));

// ---- footer: Claude backend and usage
const $m = $('#meter'), $mb = $('#m-backend'), $mu = $('#m-usage');
host({ type: 'meter', meter: null, codex: null });
assert(!shown($m), 'hidden while the host has no reading');
const seg = (text, level, title) => ({ text, level, title });
const METER = { mode: 'subscription', backend: 'subscription', backendLabel: 'sub', backendName: 'subscription (login)', backendWarn: false, backendTitle: 'Claude backend: subscription (login). Click to switch.', level: 'warn', action: 'refresh', fetchedAt: 1790708709271, lines: ['Claude usage, percent remaining', 'row'], text: '1.0h 91% 6.5d 20%', segments: [seg('1.0h 91%', 'ok', '5h session: 91% remaining'), seg('6.5d 20%', 'warn', 'Weekly: 20% remaining')] };
host({ type: 'meter', meter: METER });
assert(shown($m)); assert(!shown($('#m-where')), 'no "Work locally" under a Claude tab');
assert.deepStrictEqual([$mb.textContent, $mb.title, $mb.classList.contains('warn')], ['sub', METER.backendTitle, false]);
assert.deepStrictEqual([...$mu.children].map((n) => [n.textContent, n.className]), [['1.0h 91%', 'seg ok'], ['6.5d 20%', 'seg warn']], 'each limit keeps its own colour');
assert(/^5h session: 91% remaining\nUpdated .*\. Click to refresh\.$/.test($mu.children[0].title));
assert.strictEqual($('#m-claude .k').className, 'k glyph claude', 'marked as Claude'); assert(shown($('#m-claude')) && !shown($('#m-codex')) && !shown($('#m-plan')));
$mb.click(); assert.deepStrictEqual(out.pop(), { type: 'meterToggle', vendor: 'claude' });
$mu.click(); assert.deepStrictEqual(out.pop(), { type: 'meterRefresh', vendor: 'claude' });
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
assert(!shown($('#meter')), 'with no tab there is no agent to report on');
assert.deepStrictEqual([$('#composer').className, $('#t-model .m').textContent, $('#t-mode').textContent], ['off', '', '']);
assert.deepStrictEqual($$('#empty button').map((x) => x.textContent), ['New Claude tab', 'New Codex tab'], 'empty state offers both kinds');
assert.deepStrictEqual($$('#empty .k').map((i) => i.className), ['k glyph claude', 'k glyph codex'], 'empty state carries the vendor glyphs');
$$('#empty button')[0].click(); assert.deepStrictEqual(out.pop(), { type: 'new', kind: 'claude' });
host({ type: 'tabs', tabs: [A], active: 'a' });
assert(!shown($('#empty')), 'empty state hides once a tab exists');
assert.strictEqual(out.length, 0, 'nothing was sent that the tests did not ask for');
assert.deepStrictEqual([d.body.classList.contains('single'), P.states], [false, []], 'the sidebar page keeps its tab bar and stores nothing');
window.close();

// ---- an editor tab: one session, no tab bar of its own, and the page remembers which session it shows
{
  const e = page(ICONS);
  e.host({ type: 'tabs', tabs: [tab({ id: 'solo', kind: 'claude', title: 'Claude 1' })], active: 'solo', single: true });
  assert(e.d.body.classList.contains('single'));
  assert(!e.shown(e.$('#tabs')), 'VS Code\'s own tab is the tab');
  assert(!e.shown(e.$('#empty')) && e.shown(e.$('.pane')) && e.shown(e.$('#composer')));
  assert.deepStrictEqual(e.states, [{ sid: 'solo' }], 'so VS Code can hand the right session back after a reload');
  assert.strictEqual(e.$('#input').placeholder, 'Message Claude…'); assert.strictEqual(e.$('#input').disabled, false);
  e.$('#input').value = 'hi'; e.$('#send').click();
  assert.deepStrictEqual(e.out.pop(), { type: 'send', sid: 'solo', text: 'hi' });
  e.host({ type: 'tabs', tabs: [tab({ id: 'solo', kind: 'claude', title: 'Claude 1', busy: true })], active: 'solo', single: true });
  assert.strictEqual(e.states.length, 2);
  e.host({ type: 'tabs', tabs: [], active: null, single: true });
  assert(!e.shown(e.$('#empty')), 'an editor tab never offers to open tabs inside itself');
  assert.strictEqual(e.states.length, 2, 'and does not forget its session when it is momentarily without one');
  e.w.close();
}
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

// ---- a double-click on a tab's name asks the host to rename it; it does not switch tabs or close anything
{
  const p3 = page(ICONS); p3.out.length = 0;
  p3.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'First' }), tab({ id: 'b', kind: 'codex', title: 'Second' })], active: 'a' });
  const names = p3.$$('.tab .t');
  assert.deepStrictEqual(p3.$$('.tab').map((n) => n.title), ['First · claude · double-click to rename', 'Second · codex · double-click to rename']);
  names[1].dispatchEvent(new p3.w.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  assert.deepStrictEqual(p3.out, [{ type: 'rename', sid: 'b' }]);
  p3.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'First' }), tab({ id: 'b', kind: 'codex', title: 'Renamed' })], active: 'a' });
  assert.deepStrictEqual(p3.$$('.tab .t').map((n) => n.textContent), ['First', 'Renamed'], 'the new name arrives from the host like any other change');
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

// ---- an answer is Markdown, drawn; and the transcript keeps to its end
{
  const p5 = page(ICONS); p5.out.length = 0;
  p5.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'a' });
  const e5 = (e, sid) => p5.host({ type: 'event', sid: sid || 'a', ev: e });
  const log = p5.$$('.pane')[0].querySelector('.log');
  let height = 1000; Object.defineProperty(log, 'scrollHeight', { get: () => height }); Object.defineProperty(log, 'clientHeight', { get: () => 200 });
  const userScrolls = (to) => { log.scrollTop = to; log.dispatchEvent(new p5.w.Event('scroll')); };

  e5({ kind: 'user', text: '**not** drawn: what the user wrote is shown as written' });
  assert.strictEqual(log.querySelector('.user').innerHTML, '**not** drawn: what the user wrote is shown as written');
  e5({ kind: 'delta', text: '## Wh' }); e5({ kind: 'delta', text: 'at\n\n- **one**\n- tw' });
  assert.strictEqual(log.querySelector('.live').innerHTML, '<h2>What</h2><ul><li><strong>one</strong></li><li>tw</li></ul>', 'drawn as it arrives');
  e5({ kind: 'text', text: '## What\n\n- **one**\n- two, in [a.js:3](src/a.js#L3)\n\n`code`' });
  assert.strictEqual(log.querySelectorAll('.live').length, 0);
  const ans = log.querySelector('.assistant');
  assert.strictEqual(ans.className, 'msg assistant md');
  assert.strictEqual(ans.innerHTML, '<h2>What</h2><ul><li><strong>one</strong></li><li>two, in <a title="src/a.js#L3" href="#" data-open="src/a.js#L3">a.js:3</a></li></ul><p><code>code</code></p>');
  ans.querySelector('a').click();
  assert.deepStrictEqual(p5.out.pop(), { type: 'open', target: 'src/a.js#L3' }, 'a link to a file asks the host to open it');
  e5({ kind: 'delta', text: 'next ' }); e5({ kind: 'text', text: 'next answer' });
  assert.strictEqual(log.querySelectorAll('.assistant')[1].textContent, 'next answer', 'one answer\'s arriving text does not run into the next');

  // at the end, it stays at the end as more arrives
  assert.strictEqual(log.scrollTop, 1000);
  height = 1500; e5({ kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } });
  assert.strictEqual(log.scrollTop, 1500);
  // scrolled away to read, it is left where it is
  userScrolls(300); height = 2000; e5({ kind: 'text', text: 'more' }); e5({ kind: 'delta', text: 'and more' });
  assert.strictEqual(log.scrollTop, 300);
  // scrolled back to the end, it keeps to it again
  userScrolls(1790); height = 2500; e5({ kind: 'text', text: 'again' });
  assert.strictEqual(log.scrollTop, 2500);
  // a transcript given again is shown from its end, wherever the last one was left
  userScrolls(100); e5({ kind: 'clear' }); height = 4000;
  for (let i = 0; i < 30; i++) e5({ kind: 'text', text: 'past ' + i });
  e5({ kind: 'busy', busy: false }); e5({ kind: 'status', text: 'idle' });
  assert.strictEqual(log.scrollTop, 4000, 'a resumed session opens on the last thing said');
  // a prompt that needs an answer is brought into view
  userScrolls(100); height = 4200; e5({ kind: 'permission', id: 'p', tool: 'Bash', input: {} });
  assert.strictEqual(log.scrollTop, 4200);
  // coming back to a tab shows its end
  userScrolls(50);
  p5.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'b' });
  p5.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'a' });
  assert.strictEqual(log.scrollTop, 4200);
  p5.w.close();
}

// ---- while a session works, the foot of its transcript says so
{
  const p6 = page(ICONS); p6.out.length = 0;
  const tabs6 = (a, b) => p6.host({ type: 'tabs', tabs: [tab(Object.assign({ id: 'a', kind: 'claude', title: 'A' }, a)), tab(Object.assign({ id: 'b', kind: 'codex', title: 'B' }, b))], active: 'a' });
  const e6 = (e, sid) => p6.host({ type: 'event', sid: sid || 'a', ev: e });
  const foot = (i) => { const n = p6.$$('.pane')[i || 0].querySelector('.work'); return n.hidden ? null : [n.className, n.querySelector('.what').textContent, n.querySelector('.for').textContent]; };
  tabs6();
  assert.deepStrictEqual([foot(0), foot(1)], [null, null], 'nothing is said while nothing is done');
  const kids = [...p6.$$('.pane')[0].children].map((n) => n.className);
  assert.deepStrictEqual(kids, ['log', 'work'], 'under the transcript, above the message; nothing over it');

  tabs6({ busy: true, busySince: Date.now() - 75000 });
  assert.deepStrictEqual([foot(0), foot(1)], [['work', 'Working…', '1m 15s'], null], 'each tab for itself');
  e6({ kind: 'thinking', text: 'hm' }); assert.strictEqual(foot()[1], 'Thinking…');
  e6({ kind: 'tool_start', name: 'Bash' }); assert.strictEqual(foot()[1], 'Running Bash…');
  e6({ kind: 'tool_use', id: 't', name: 'Bash', input: {} }); e6({ kind: 'tool_result', id: 't', text: 'ok' }); assert.strictEqual(foot()[1], 'Working…');
  e6({ kind: 'delta', text: 'The ' }); assert.strictEqual(foot()[1], 'Writing…');
  tabs6({ busy: true, busySince: Date.now() - 4000, queued: 2 }); assert.deepStrictEqual(foot(), ['work', 'Writing…', '4s · 2 queued']);

  // a prompt that waits on the user is not work
  e6({ kind: 'permission', id: 'p1', tool: 'Bash', input: {} });
  assert.deepStrictEqual(foot().slice(0, 2), ['work ask', 'Waiting for your answer']);
  p6.$$('.pane')[0].querySelector('.perm button').click();
  assert.deepStrictEqual(foot().slice(0, 2), ['work', 'Working…'].map((x, i) => (i ? foot()[1] : x)));
  assert.notStrictEqual(foot()[1], 'Waiting for your answer');

  // done, it is gone, and the next turn starts from nothing
  tabs6({ busy: false }); assert.strictEqual(foot(), null);
  tabs6({ busy: true, busySince: Date.now() }); assert.deepStrictEqual(foot(), ['work', 'Working…', '0s']);
  tabs6({}, { busy: true, busySince: 0 }); assert.deepStrictEqual([foot(0), foot(1)], [null, ['work', 'Working…', '']]);
  p6.w.close();
}

// ---- pasted images
(async () => {
  const p4 = page(ICONS); p4.out.length = 0;
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };
  const file = (name, type, bytes) => new p4.w.File([new Uint8Array(bytes)], name, { type });
  const paste = (items, text) => { const e = new p4.w.Event('paste', { bubbles: true, cancelable: true }); e.clipboardData = { items, getData: () => text || '' }; p4.$('#input').dispatchEvent(e); return e; };
  const img = (f) => ({ kind: 'file', type: f.type, getAsFile: () => f });
  const thumbs = () => p4.$$('#shots .shot img').map((n) => n.getAttribute('src'));

  // with no tab there is nowhere to put one
  p4.host({ type: 'tabs', tabs: [], active: null });
  assert.strictEqual(paste([img(file('a.png', 'image/png', [1, 2, 3]))]).defaultPrevented, false);
  p4.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'a' });
  assert.strictEqual(p4.shown(p4.$('#shots')), false, 'nothing attached, nothing shown');

  // text pastes as it always did
  assert.strictEqual(paste([{ kind: 'string', type: 'text/plain', getAsFile: () => null }], 'words').defaultPrevented, false);
  assert.strictEqual(paste([img(file('a.svg', 'image/svg+xml', [60]))]).defaultPrevented, false, 'a kind of image the agents do not take is left to the browser');
  await settle(); assert.deepStrictEqual(thumbs(), []);

  // an image is attached, shown, and sent with the message
  assert.strictEqual(paste([{ kind: 'string', type: 'text/html', getAsFile: () => null }, img(file('shot.png', 'image/png', [137, 80, 78, 71]))]).defaultPrevented, true);
  await settle();
  assert.deepStrictEqual(thumbs(), ['data:image/png;base64,iVBORw==']);
  assert(p4.shown(p4.$('#shots')));
  paste([img(file('two.jpg', 'image/jpeg', [255, 216, 255])), img(file('three.webp', 'image/webp', [82, 73]))]); await settle();
  assert.deepStrictEqual(thumbs().length, 3);
  p4.$$('#shots .shot .x')[1].click();
  assert.deepStrictEqual(thumbs(), ['data:image/png;base64,iVBORw==', 'data:image/webp;base64,Ukk='], 'one can be taken off again');

  // they belong to the tab they were pasted in
  p4.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'b' });
  assert.deepStrictEqual([thumbs(), p4.shown(p4.$('#shots'))], [[], false]);
  p4.$('#input').value = 'only words'; key(p4.$('#input'), 'Enter');
  assert.deepStrictEqual(p4.out.pop(), { type: 'send', sid: 'b', text: 'only words' }, 'a message without images is sent as before');
  p4.host({ type: 'tabs', tabs: [tab({ id: 'a', kind: 'claude', title: 'A' }), tab({ id: 'b', kind: 'codex', title: 'B' })], active: 'a' });
  assert.strictEqual(thumbs().length, 2);

  p4.$('#input').value = 'what is this'; key(p4.$('#input'), 'Enter');
  assert.deepStrictEqual(p4.out.pop(), { type: 'send', sid: 'a', text: 'what is this', images: [{ mime: 'image/png', data: 'iVBORw==' }, { mime: 'image/webp', data: 'Ukk=' }] });
  assert.deepStrictEqual([thumbs(), p4.$('#input').value, p4.shown(p4.$('#shots'))], [[], '', false], 'sent, they are gone from the box');

  // an image alone can be sent
  paste([img(file('alone.png', 'image/png', [1]))]); await settle();
  p4.$('#send').click();
  assert.deepStrictEqual(p4.out.pop(), { type: 'send', sid: 'a', text: '', images: [{ mime: 'image/png', data: 'AQ==' }] });
  p4.$('#send').click(); assert.strictEqual(p4.out.length, 0, 'nothing at all is still not sent');

  // no more than a message takes
  paste(Array.from({ length: 10 }, (_, i) => img(file(i + '.png', 'image/png', [i])))); await settle();
  assert.strictEqual(thumbs().length, 8);
  assert.strictEqual(p4.$$('.pane')[0].querySelector('.log .status:last-child').textContent, 'A message takes 8 images; 2 left out');

  // the transcript says a message carried images
  p4.host({ type: 'event', sid: 'a', ev: { kind: 'user', text: 'what is this', queued: false, images: 2 } });
  p4.host({ type: 'event', sid: 'a', ev: { kind: 'user', text: '', queued: true, images: 1 } });
  assert.deepStrictEqual(p4.$$('.pane')[0].querySelectorAll('.user .tag').length && [...p4.$$('.pane')[0].querySelectorAll('.user .tag')].map((n) => n.textContent), ['2 images', 'queued · 1 image']);
  // with thumbnails, the message shows the images themselves; only those without one are counted
  const T = 'data:image/jpeg;base64,/9j/4AAQ';
  p4.host({ type: 'event', sid: 'a', ev: { kind: 'user', text: 'see these', queued: false, images: 3, thumbs: [T, '', 'javascript:alert(1)'] } });
  const last = [...p4.$$('.pane')[0].querySelectorAll('.user')].pop();
  assert.deepStrictEqual([[...last.querySelectorAll('.pics img')].map((i) => i.getAttribute('src')), last.querySelector('.tag').textContent, last.textContent.endsWith('see these')], [[T], '2 images', true]);
  // a web address in an error or a note is a link
  p4.host({ type: 'event', sid: 'a', ev: { kind: 'error', text: 'You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:16 PM.' } });
  const err = [...p4.$$('.pane')[0].querySelectorAll('.error')].pop();
  assert.deepStrictEqual([...err.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]), [['https://chatgpt.com/explore/pro', 'https://chatgpt.com/explore/pro'], ['https://chatgpt.com/codex/settings/usage', 'https://chatgpt.com/codex/settings/usage']], 'the addresses, without the punctuation around them');
  assert(err.textContent.startsWith('You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit'), 'the text is whole');
  p4.host({ type: 'event', sid: 'a', ev: { kind: 'note', text: 'see https://claude.ai/settings/usage.' } });
  assert.deepStrictEqual([...[...p4.$$('.pane')[0].querySelectorAll('.status')].pop().querySelectorAll('a')].map((a) => a.textContent), ['https://claude.ai/settings/usage']);
  // a thumbnail is small; a click shows it at the size it was kept, another puts it back
  const pic = last.querySelector('.pics img');
  assert.deepStrictEqual([pic.classList.contains('big'), pic.title], [false, 'Click to see it larger']);
  pic.click(); assert.deepStrictEqual([pic.classList.contains('big'), pic.title], [true, 'Click to shrink it']);
  pic.click(); assert.strictEqual(pic.classList.contains('big'), false);
  p4.w.close();
  console.log('PAGE OK');
})().catch((e) => { console.error('PAGE FAILED:', e.stack || e.message); process.exit(1); });
