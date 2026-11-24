'use strict';
// The page of Perch: Set Up a Gateway…, run in a DOM and driven as the host drives it.
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const { getGatewayFormHtml } = require('../src/gatewayForm');

const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', (e) => { console.error('PAGE SCRIPT ERROR:', (e.detail && e.detail.message) || e.message); process.exitCode = 1; });
const html = getGatewayFormHtml({ nonce: 'n', cspSource: 'x' }).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
const out = [];
const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole, beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => out.push(JSON.parse(JSON.stringify(m))) }); } });
const w = dom.window, d = w.document, $ = (id) => d.getElementById(id);
const host = (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m }));
const submit = () => $('form').dispatchEvent(new w.Event('submit', { cancelable: true }));
const models = (o) => Object.assign({ ANTHROPIC_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '' }, o);

assert.deepStrictEqual(out, [{ type: 'ready' }], 'the page asks for the file');
assert.strictEqual($('models').open, false, 'the model names start collapsed');

// no file: a token box to fill in
host({ type: 'state', state: { file: '/home/u/.config/gateway-claude/env', exists: false, ok: false, baseUrl: '', tokenSet: false, models: models() } });
assert.deepStrictEqual([$('file').textContent, $('tokenSet').hidden, $('token').hidden, $('saved').hidden], ['/home/u/.config/gateway-claude/env', true, false, true]);
$('baseUrl').value = ' https://gw.example.com '; $('token').value = 'sk-1'; $('ANTHROPIC_MODEL').value = 'router[1m]';
submit();
assert.deepStrictEqual(out.pop(), { type: 'save', baseUrl: 'https://gw.example.com', token: 'sk-1', models: models({ ANTHROPIC_MODEL: 'router[1m]' }) });
host({ type: 'error', text: 'A token is needed.' });
assert.deepStrictEqual([$('error').textContent, $('saved').hidden], ['A token is needed.', true], 'what is wrong, on the page');

// saved: the box with its button; the token box empties, and shows the token as set
host({ type: 'saved', state: { file: '/f', exists: true, ok: true, baseUrl: 'https://gw.example.com', tokenSet: true, models: models({ ANTHROPIC_MODEL: 'router[1m]' }) } });
assert.deepStrictEqual([$('error').textContent, $('saved').hidden, $('tokenSet').hidden, $('token').hidden, $('token').value, $('ANTHROPIC_MODEL').value], ['', false, false, true, '', 'router[1m]']);
$('newTab').click(); assert.deepStrictEqual(out.pop(), { type: 'newTab' });
$('openFile').click(); assert.deepStrictEqual(out.pop(), { type: 'openFile' });

// a token set: saving sends none, unless Replace was pressed
submit();
assert.strictEqual(out.pop().token, '', 'the token kept');
$('replace').click();
assert.deepStrictEqual([$('tokenSet').hidden, $('token').hidden], [true, false], 'Replace shows the box');
$('token').value = 'sk-2'; submit();
assert.strictEqual(out.pop().token, 'sk-2');
// a change hides Saved
host({ type: 'saved', state: { file: '/f', exists: true, ok: true, baseUrl: 'https://gw.example.com', tokenSet: true, models: models() } });
$('baseUrl').dispatchEvent(new w.Event('input', { bubbles: true }));
assert.strictEqual($('saved').hidden, true);

console.log('gatewayForm tests passed');
