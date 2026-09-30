'use strict';
// Where the agents' programs are found, against throwaway directories.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../src/binaries');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-bin-'));
const put = (root, rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; };
const exe = process.platform === 'win32' ? '.exe' : '';

// the vendors' extensions
const claudeExt = mk(), codexExt = mk(), bare = mk();
const claude = put(claudeExt, 'resources/native-binary/claude' + exe);
put(codexExt, 'bin/linux-x86_64/codex-code-mode-host'); const codex = put(codexExt, 'bin/linux-x86_64/codex' + exe);
assert.deepStrictEqual([B.vendorClaude(claudeExt), B.vendorCodex(codexExt)], [claude, codex]);
assert.deepStrictEqual([B.vendorClaude(bare), B.vendorCodex(bare), B.vendorClaude(''), B.vendorCodex(undefined), B.vendorClaude(codexExt)], ['', '', '', '', '']);
const mac = mk(); const macCodex = put(mac, 'bin/macos-aarch64/codex' + exe);
assert.strictEqual(B.vendorCodex(mac), macCodex, 'whatever the vendor calls the platform\'s directory');
fs.mkdirSync(path.join(bare, 'resources/native-binary/claude' + exe), { recursive: true });
assert.strictEqual(B.vendorClaude(bare), '', 'a directory of that name is not the program');

// as packaged: the SDKs are there, their programs are not
const packaged = mk();
put(packaged, '@anthropic-ai/claude-agent-sdk/sdk.mjs'); put(packaged, '@anthropic-ai/sdk/index.js'); put(packaged, '@openai/codex-sdk/dist/index.js'); put(packaged, '@openai/codex/bin/codex.js');
fs.mkdirSync(path.join(packaged, '@openai/codex-linux-x64'), { recursive: true });            // a directory left empty by the packaging
assert.deepStrictEqual(B.resolveProgram('claude', { modules: packaged, vendorRoot: claudeExt }), { path: claude, from: 'extension' });
assert.deepStrictEqual(B.resolveProgram('codex', { modules: packaged, vendorRoot: codexExt }), { path: codex, from: 'extension' });
assert.deepStrictEqual(B.resolveProgram('claude', { modules: packaged }), { path: '', from: 'none' }, 'the vendor\'s extension is not installed');
assert.deepStrictEqual(B.resolveProgram('codex', { modules: packaged, vendorRoot: mk() }), { path: '', from: 'none' });

// as installed from npm: the SDK has its own program, and is left to find it
const dev = mk();
put(dev, '@anthropic-ai/claude-agent-sdk/sdk.mjs'); put(dev, '@anthropic-ai/claude-agent-sdk-linux-x64/claude'); put(dev, '@openai/codex-sdk/dist/index.js'); put(dev, '@openai/codex-darwin-arm64/vendor/codex');
assert.deepStrictEqual(B.resolveProgram('claude', { modules: dev, vendorRoot: claudeExt }), { path: '', from: 'sdk' });
assert.deepStrictEqual(B.resolveProgram('codex', { modules: dev, vendorRoot: codexExt }), { path: '', from: 'sdk' });

// the user's own choice comes first, and is not second-guessed
assert.deepStrictEqual(B.resolveProgram('claude', { configured: '/opt/claude', modules: dev, vendorRoot: claudeExt }), { path: '/opt/claude', from: 'setting' });
assert.deepStrictEqual(B.resolveProgram('codex', { configured: '/opt/codex', modules: packaged }), { path: '/opt/codex', from: 'setting' });

// this checkout, which is installed from npm
assert.strictEqual(B.resolveProgram('claude', {}).from, 'sdk'); assert.strictEqual(B.resolveProgram('codex', {}).from, 'sdk');
console.log('BINARIES OK');
