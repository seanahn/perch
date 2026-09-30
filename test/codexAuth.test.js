'use strict';
// Codex's login on this machine: found, awaited, and the command that makes it.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { codexHome, loggedIn, loginCommand, waitForLogin } = require('../src/codexAuth');

const alive = setInterval(() => {}, 1000);   // the wait's timer does not hold the process, as it must not in the extension host; this test does
(async () => {
  assert.strictEqual(codexHome({}), path.join(os.homedir(), '.codex'));
  assert.strictEqual(codexHome({ CODEX_HOME: '/srv/codex' }), '/srv/codex', 'Codex honours CODEX_HOME, so perch does');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-codex-'));
  assert.strictEqual(loggedIn({ env: {}, home }), false, 'no auth.json: not logged in');
  assert.strictEqual(loggedIn({ env: {}, home: path.join(home, 'missing') }), false, 'no home at all: not logged in');
  assert.strictEqual(loggedIn({ env: { OPENAI_API_KEY: 'sk-x' }, home }), true, 'an API key in the environment serves');
  fs.writeFileSync(path.join(home, 'auth.json'), '{ broken');
  assert.strictEqual(loggedIn({ env: {}, home }), false, 'a broken file is not a login');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x', refresh_token: 'y', account_id: 'z' } }));
  assert.strictEqual(loggedIn({ env: {}, home }), true, 'the ChatGPT login Codex writes');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
  assert.strictEqual(loggedIn({ env: {}, home }), true, 'an API key stored by codex login --with-api-key');

  assert.strictEqual(loginCommand('codex'), 'codex login --device-auth');
  assert.strictEqual(loginCommand('/home/me/.vscode-server/extensions/openai.chatgpt-1/bin/linux-x86_64/codex'), '"/home/me/.vscode-server/extensions/openai.chatgpt-1/bin/linux-x86_64/codex" login --device-auth', 'a path is quoted for the shell');

  // the browser sign-in: the program is run, and the page it prints is found among its colour codes; an early exit is an error
  {
    const { EventEmitter } = require('events');
    const fakeSpawn = (script) => (cmd, args, opts) => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.spawned = [cmd, args, opts.stdio]; setTimeout(() => script(c), 5); return c; };
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid';
    const { startLogin, CALLBACK_PORT } = require('../src/codexAuth');
    assert.strictEqual(CALLBACK_PORT, 1455);
    const r = await startLogin('/opt/codex', { spawn: fakeSpawn((c) => { c.stdout.emit('data', 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n\x1b[94m' + url.slice(0, 40)); c.stdout.emit('data', url.slice(40) + '\x1b[0m\n\nOn a remote or headless machine? Use `codex login --device-auth` instead.\n'); }) });
    assert.deepStrictEqual([r.url, r.child.spawned], [url, ['/opt/codex', ['login'], ['ignore', 'pipe', 'pipe']]], 'the page, whole, across two writes and without the colour codes');
    await assert.rejects(startLogin('/opt/codex', { spawn: fakeSpawn((c) => { c.stderr.emit('data', 'error: unknown option\n'); c.emit('close', 2); }) }), /codex login ended \(exit 2\): error: unknown option/);
    await assert.rejects(startLogin('/opt/codex', { spawn: fakeSpawn((c) => c.emit('error', Object.assign(new Error('spawn /opt/codex ENOENT'), { code: 'ENOENT' }))) }), /could not run \/opt\/codex: spawn/);
    await assert.rejects(startLogin('/opt/codex', { spawn: () => { throw new Error('no'); } }), /could not run \/opt\/codex: no/);
  }

  // waiting: already there, arrives later, never arrives
  assert.strictEqual(await waitForLogin({ env: {}, home, intervalMs: 10, timeoutMs: 100 }), true);
  fs.unlinkSync(path.join(home, 'auth.json'));
  const p = waitForLogin({ env: {}, home, intervalMs: 10, timeoutMs: 2000 });
  setTimeout(() => fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} })), 40);
  assert.strictEqual(await p, true, 'seen when it lands');
  fs.unlinkSync(path.join(home, 'auth.json'));
  assert.strictEqual(await waitForLogin({ env: {}, home, intervalMs: 10, timeoutMs: 50 }), false, 'gives up in time');
  fs.rmSync(home, { recursive: true, force: true });
  clearInterval(alive);
  console.log('CODEX AUTH OK');
})().catch((e) => { console.error(e); process.exit(1); });
