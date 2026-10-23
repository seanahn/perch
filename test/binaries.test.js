'use strict';
// Where the agents' programs are found, against throwaway directories.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const B = require('../src/binaries');

const made = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-bin-')); made.push(d); return d; };
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
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

// a login runs the program itself: the SDK's own is found where its platform package keeps it, this machine's first
{
  const m = mk();
  assert.strictEqual(B.sdkCodex(m), '', 'none installed');
  put(m, '@openai/codex-sdk/dist/index.js'); put(m, '@openai/codex/bin/codex.js');
  assert.strictEqual(B.sdkCodex(m), '', 'the SDK and the npm launcher are not the program');
  const other = put(m, '@openai/codex-zz-other/vendor/zz-target/bin/codex' + exe);
  const mine = put(m, `@openai/codex-${process.platform}-${process.arch}/vendor/some-target/bin/codex` + exe);
  assert.deepStrictEqual([B.sdkCodex(m), B.sdkCodex(mk())], [mine, ''], 'this machine\'s package before another\'s');
  fs.rmSync(mine);
  assert.strictEqual(B.sdkCodex(m), other, 'another\'s, if it is all there is');
  const older = mk(); const o = put(older, '@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex' + exe);
  assert.strictEqual(B.sdkCodex(older), o, 'the layout of older packages too');
  assert.strictEqual(B.sdkCodex(), require('path').resolve(__dirname, '..', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor', require('fs').readdirSync(require('path').resolve(__dirname, '..', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`, 'vendor'))[0], 'bin', 'codex' + exe), 'this checkout\'s own, as perch on the desktop runs it');
}

// the user's own choice comes first, and is not second-guessed
assert.deepStrictEqual(B.resolveProgram('claude', { configured: '/opt/claude', modules: dev, vendorRoot: claudeExt }), { path: '/opt/claude', from: 'setting' });
assert.deepStrictEqual(B.resolveProgram('codex', { configured: '/opt/codex', modules: packaged }), { path: '/opt/codex', from: 'setting' });

// this checkout, which is installed from npm
assert.strictEqual(B.resolveProgram('claude', {}).from, 'sdk'); assert.strictEqual(B.resolveProgram('codex', {}).from, 'sdk');

// the SDK's own claude, for a login that runs it directly: in its platform package, on Linux either build, this machine's first
{
  const m = mk();
  const at = (n, e = '') => path.join(m, '@anthropic-ai', 'claude-agent-sdk-' + n, 'claude' + e);
  const glibc = { platform: 'linux', arch: 'x64', musl: false }, musl = { platform: 'linux', arch: 'x64', musl: true };
  assert.strictEqual(B.sdkClaude(m, glibc), '', 'none installed');
  put(m, '@anthropic-ai/claude-agent-sdk/sdk.mjs'); put(m, '@anthropic-ai/sdk/index.js');
  assert.strictEqual(B.sdkClaude(m, glibc), '', 'the SDK is not the program');
  put(m, '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude');
  assert.deepStrictEqual([B.sdkClaude(m, glibc), B.sdkClaude(m, musl)], [at('linux-x64-musl'), at('linux-x64-musl')], 'the musl build, when it is the one there');
  put(m, '@anthropic-ai/claude-agent-sdk-linux-x64/claude');
  assert.deepStrictEqual([B.sdkClaude(m, glibc), B.sdkClaude(m, musl)], [at('linux-x64'), at('linux-x64-musl')], 'with both, the one of this machine\'s C library');
  assert.strictEqual(B.sdkClaude(m, { platform: 'linux', arch: 'arm64', musl: false }), '', 'not another machine\'s');
  fs.mkdirSync(at('linux-arm64'), { recursive: true });
  assert.strictEqual(B.sdkClaude(m, { platform: 'linux', arch: 'arm64', musl: false }), '', 'a directory of that name is not the program');
  put(m, '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'); put(m, '@anthropic-ai/claude-agent-sdk-win32-arm64/claude');
  put(m, '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'); put(m, '@anthropic-ai/claude-agent-sdk-linux-arm64-android/claude');
  assert.deepStrictEqual([B.sdkClaude(m, { platform: 'win32', arch: 'x64' }), B.sdkClaude(m, { platform: 'win32', arch: 'arm64' }), B.sdkClaude(m, { platform: 'darwin', arch: 'arm64' }), B.sdkClaude(m, { platform: 'darwin', arch: 'x64' }), B.sdkClaude(m, { platform: 'android', arch: 'arm64' })],
    [at('win32-x64', '.exe'), '', at('darwin-arm64'), '', at('linux-arm64-android')], 'claude.exe on Windows; Android has a build of its own');
  const own = B.sdkClaude();
  assert(own.startsWith(path.resolve(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-' + process.platform + '-' + process.arch)) && path.basename(own) === 'claude' + exe && fs.statSync(own).isFile(), 'this checkout\'s own: ' + own);
}

// a program on PATH, found as a shell finds it
{
  const [a, b, c, d] = [mk(), mk(), mk(), mk()];
  if (process.platform !== 'win32') {
    put(a, 'claude');                                                      // there, but not to be run
    fs.mkdirSync(path.join(b, 'claude'));                                  // not a file
    const x = put(c, 'claude'), y = put(d, 'claude'); fs.chmodSync(x, 0o755); fs.chmodSync(y, 0o755);
    const env = { PATH: ['', a, b, '', c, d].join(':') };
    assert.strictEqual(B.onPath('claude', { env, platform: 'linux' }), x, 'the first that may be run; an empty entry is skipped');
    assert.deepStrictEqual([B.onPath('codex', { env, platform: 'linux' }), B.onPath('claude', { env: {}, platform: 'linux' }), B.onPath('claude', { env: { PATH: a }, platform: 'linux' })], ['', '', ''], 'none of that name; no PATH; none to be run');
  }
  // Windows: each directory in turn, and in it the endings PATHEXT lists, in its order. Simulated here, with names as given
  put(a, 'claude.CMD'); const e = put(b, 'claude.EXE'); put(b, 'claude.CMD'); put(c, 'claude.ps1');
  const win = (env) => B.onPath('claude', { env, platform: 'win32' });
  assert.deepStrictEqual([win({ PATH: [a, b].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }), win({ PATH: [b, a].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' })], [path.join(a, 'claude.CMD'), e], 'the first directory that has one; there, PATHEXT\'s order');
  assert.deepStrictEqual([win({ Path: `"${b}"` }), win({ Path: c + ';' + d }), win({ Path: b, PATHEXT: '.CMD' })], [e, '', path.join(b, 'claude.CMD')], 'Path as Windows spells it, quoted entries, the default PATHEXT, and only the endings it lists');
}

// a command line for a terminal: typed into the user's shell, quoted for it; on Windows the program run by the terminal itself
{
  assert.deepStrictEqual(['claude', '/opt/claude', '--settings', 'a b', "it's", '{"env":1}', '', '$HOME', '*', '~', 'A=b'].map(B.shellQuote),
    ['claude', '/opt/claude', '--settings', "'a b'", "'it'\\''s'", `'{"env":1}'`, "''", "'$HOME'", "'*'", "'~'", "'A=b'"]);
  const args = ['--settings', '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0"}}', 'auth', 'login'];
  assert.deepStrictEqual(B.terminalRun('/opt/claude', args, 'linux'), { options: {}, text: `/opt/claude --settings '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0"}}' auth login` });
  assert.strictEqual(B.terminalRun('/Users/me/Library/Application Support/claude', ['auth', 'login'], 'darwin').text, "'/Users/me/Library/Application Support/claude' auth login", 'a path with a space in it');
  const exePath = 'C:\\Users\\Jo Ann\\.vscode\\extensions\\anthropic.claude-code-2.1.0-win32-x64\\resources\\native-binary\\claude.exe';
  const w = B.terminalRun(exePath, args, 'win32');
  assert.deepStrictEqual(w, { options: { shellPath: exePath, shellArgs: args }, text: '' }, 'on Windows: the program with its arguments as they are, read by no shell');
  assert.notStrictEqual(w.options.shellArgs, args, 'a copy of them');
  if (process.platform !== 'win32') {
    // what a shell makes of it: the words as given
    const words = ['/opt/my claude/claude', '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0"}}', "it's", '$HOME `id` $(id) \\n', '*', '', '~', 'a;b|c&d', '#x', '!x', '-n', 'A=b'];
    const out = require('child_process').execFileSync('sh', ['-c', B.terminalRun('printf', ['%s|', ...words], 'linux').text], { encoding: 'utf8' });
    assert.strictEqual(out, words.map((x) => x + '|').join(''), 'read back by sh as given');
  }
}
console.log('BINARIES OK');
