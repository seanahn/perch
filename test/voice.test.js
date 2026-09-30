'use strict';
// The speech-to-text engine, against a stand-in server. No Python, no model, no GPU.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const { VoiceEngine, DEFAULT_HOME } = require('../src/voice');

const FAKE = path.join(__dirname, 'fakeVoiceServer.js');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-voice-'));
const b64 = (n) => Buffer.alloc(n).toString('base64');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** An engine whose "python" is node running the stand-in, recording every command it is asked to run. */
function engine(o = {}) {
  const home = o.home || mk(); const calls = [];
  const req = path.join(home, 'requirements.txt'); if (!fs.existsSync(req)) fs.writeFileSync(req, o.requirements || 'faster-whisper\n');
  const e = new VoiceEngine(Object.assign({ server: FAKE, requirements: req, home, idleMs: 0, python: 'python3', spawn: (cmd, args, opts) => {
    calls.push([path.basename(cmd), ...args.map((a) => (a === FAKE ? 'server.py' : a.startsWith(home) ? a.slice(home.length + 1) : a))]);
    const env = Object.assign({}, opts.env, { FAKE_VOICE: o.mode || 'ok' });
    const fail = (msg) => cp.spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(msg + '\n')}); process.exit(1)`], opts);
    if (args[0] === '-m' && args[1] === 'venv') {
      fs.mkdirSync(path.dirname(e.venvPython), { recursive: true }); fs.writeFileSync(e.venvPython, '');       // laid out even when it fails, as Debian's does
      if (o.noEnsurepip && !args.includes('--without-pip')) return fail('Error: Command \'[...]/venv/bin/python3\', \'-m\', \'ensurepip\', \'--upgrade\', \'--default-pip\']\' returned non-zero exit status 1.');
      return cp.spawn(process.execPath, ['-e', ''], opts);
    }
    if (args[0] === '-c' && args[1] === 'import pip') return o.noPip && !e._pipBootstrapped ? fail('ModuleNotFoundError: No module named \'pip\'') : cp.spawn(process.execPath, ['-e', ''], opts);
    if (args[0] === '-m' && args[1] === 'ensurepip') return o.noEnsurepip ? fail('No module named ensurepip') : cp.spawn(process.execPath, ['-e', ''], opts);
    if (/get-pip\.py$/.test(args[0])) { e._pipBootstrapped = fs.readFileSync(args[0], 'utf8'); return cp.spawn(process.execPath, ['-e', ''], opts); }
    if (args[0] === '-m' && args[1] === 'pip') { if (o.pipFails) return cp.spawn(process.execPath, ['-e', 'process.stderr.write("ERROR: No matching distribution found for faster-whisper\\n"); process.exit(1)'], opts); return cp.spawn(process.execPath, ['-e', ''], opts); }
    if (o.noPython) return cp.spawn('/nonexistent/python3', args, opts);
    return cp.spawn(process.execPath, [FAKE, ...args.slice(1)], Object.assign({}, opts, { env }));
  } }, o.engine));
  return { e, home, calls };
}

const step = (x) => { if (process.env.TRACE) console.error('  ..', x); };
(async () => {
  assert(DEFAULT_HOME.startsWith(os.homedir()) && /perch.voice$/.test(DEFAULT_HOME), 'kept in the user\'s home, not in the system');

  step('setup');
  // ---- setup
  {
    const { e, home, calls } = engine();
    assert.deepStrictEqual([e.isInstalled(), e.status().installed, e.status().running], [false, false, false]);
    const steps = []; const ready = await e.install((m, p) => steps.push([m, p]));
    assert.deepStrictEqual(calls, [
      ['python3', '-m', 'venv', 'venv'],
      ['python', '-c', 'import pip'],
      ['python', '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'],
      ['python', '-m', 'pip', 'install', '--quiet', '-r', 'requirements.txt'],
      ['python', 'server.py', '--model', 'auto', '--device', 'auto', '--models-dir', 'models', '--download-only'],
    ], 'an environment of its own, the runtime into it, then the model, which is also loaded once to prove it runs');
    assert.deepStrictEqual(steps.map((s) => s[1]), [5, 15, 60, 100]); assert(/^Fetching the model and/.test(steps[2][0]));
    assert.deepStrictEqual([ready.device, e.isInstalled(), fs.existsSync(path.join(home, 'models'))], ['cuda', true, true]);
    const m = JSON.parse(fs.readFileSync(path.join(home, 'installed.json'), 'utf8')); assert.deepStrictEqual([m.models, m.resolved, m.device, m.requirements.length], [['auto'], 'large-v3-turbo', 'cuda', 16], 'auto is recorded as auto; what it came to is noted');

    step('again');
    // running it again is cheap and skips what is done
    calls.length = 0; await e.install();
    assert.deepStrictEqual(calls.map((c) => c.slice(0, 3).join(' ')), ['python -c import pip', 'python -m pip', 'python -m pip', 'python server.py --model'], 'the environment is not rebuilt');

    step('other model');
    // another model is a separate download; changed requirements mean a fresh install
    const small = engine({ home, engine: { model: 'small' } }).e;
    assert.strictEqual(small.isInstalled(), false, 'this model has not been fetched');
    await small.install(); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'installed.json'), 'utf8')).models, ['auto', 'small']);
    assert.deepStrictEqual([small.isInstalled(), e.isInstalled()], [true, true]);
    fs.writeFileSync(path.join(home, 'requirements.txt'), 'faster-whisper>=2\n');
    assert.strictEqual(e.isInstalled(), false, 'the runtime it was built from has changed');
    await e.install(); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'installed.json'), 'utf8')).models, ['auto'], 'models fetched for the old runtime are not vouched for');
    fs.rmSync(path.join(home, 'venv'), { recursive: true }); assert.strictEqual(e.isInstalled(), false, 'the environment is gone');
    fs.writeFileSync(path.join(home, 'installed.json'), '{ broken'); assert.strictEqual(e.isInstalled(), false);
    fs.rmSync(home, { recursive: true, force: true });
  }
  {
    step('failed installs');
    const a = engine({ pipFails: true });
    await assert.rejects(a.e.install(), /No matching distribution found for faster-whisper/); assert.strictEqual(a.e.isInstalled(), false, 'a failed install is not recorded as done');
    const b = engine({ mode: 'fail-load' });
    await assert.rejects(b.e.install(), /CUDA out of memory/); assert.strictEqual(b.e.isInstalled(), false);
    const c = new VoiceEngine({ server: FAKE, requirements: '/nonexistent', home: mk(), python: '/nonexistent/python3' });
    await assert.rejects(c.install(), /python3 was not found\. Install Python 3\.9 or newer, or set perch\.voice\.python/);
  }
  {
    step('python without ensurepip');
    // Debian's python3 without python3-venv: venv fails after laying the environment out, and there is no pip in it.
    // A venv without pip is taken as is, and pip comes from its own installer; ensurepip is tried first.
    const fetched = [];
    const d = engine({ noEnsurepip: true, noPip: true, engine: { fetch: async (u) => { fetched.push(u); return 'print("get-pip")'; } } });
    await d.e.install();
    assert.deepStrictEqual(d.calls.slice(0, 6).map((c) => c.slice(0, 3).join(' ')),
      ['python3 -m venv', 'python3 -m venv', 'python -c import pip', 'python -m ensurepip', 'python get-pip.py --quiet', 'python -m pip']);
    assert.deepStrictEqual([d.calls[1][3], fetched, d.e._pipBootstrapped, fs.existsSync(path.join(d.home, 'get-pip.py'))],
      ['--without-pip', ['https://bootstrap.pypa.io/get-pip.py'], 'print("get-pip")', false], 'the installer is fetched, run, and removed');
    assert.strictEqual(d.e.isInstalled(), true);
    // an environment that already exists without pip (a half-made one from an earlier try) is repaired the same way
    const f = engine({ home: d.home, noEnsurepip: true, noPip: true, engine: { fetch: async () => 'print("get-pip")' } });
    fs.writeFileSync(path.join(d.home, 'installed.json'), '{}');
    await f.e.install();
    assert.deepStrictEqual(f.calls.slice(0, 3).map((c) => c.slice(0, 3).join(' ')), ['python -c import pip', 'python -m ensurepip', 'python get-pip.py --quiet']);
    // ensurepip alone, when the Python has it
    const g = engine({ noPip: true, engine: { fetch: async () => { throw new Error('not needed'); } } });
    await g.e.install();
    assert.deepStrictEqual(g.calls.slice(0, 4).map((c) => c.slice(0, 3).join(' ')), ['python3 -m venv', 'python -c import pip', 'python -m ensurepip', 'python -m pip']);
    // and when nothing works, a message that says what to do
    const h = engine({ noEnsurepip: true, noPip: true, engine: { fetch: async () => { throw new Error('https://bootstrap.pypa.io/get-pip.py could not be fetched: ENOTFOUND'); } } });
    await assert.rejects(h.e.install(), /pip could not be installed into the voice environment \(https:\/\/bootstrap\.pypa\.io\/get-pip\.py could not be fetched: ENOTFOUND\)\. Install python3-venv, or set perch\.voice\.python/);
    assert.strictEqual(h.e.isInstalled(), false);
    for (const x of [d, g, h]) fs.rmSync(x.home, { recursive: true, force: true });
  }

  step('transcribing');
  // ---- transcribing
  {
    const { e, calls } = engine({ engine: { device: 'cpu', model: 'small' } });
    const info = await e.start();
    assert.deepStrictEqual([info.device, info.model, e.status().running, e.status().device], ['cpu', 'small', true, 'cpu']);
    assert.strictEqual(await e.start(), info, 'one server, however often it is asked for');
    assert.deepStrictEqual(calls, [['python', 'server.py', '--model', 'small', '--device', 'cpu', '--models-dir', 'models']]);
    const [a, b, c] = await Promise.all([e.transcribe({ pcm: b64(32000), sampleRate: 16000 }), e.transcribe({ pcm: b64(64), sampleRate: 48000, language: 'ko', prompt: 'Perch' }), e.transcribe({ pcm: '' })]);
    assert.deepStrictEqual([a.text, a.seconds, a.device], ['heard 32000 bytes at 16000', 1, 'cpu']);
    assert.strictEqual(b.text, 'heard 64 bytes at 48000 in ko expecting Perch', 'answers are matched to their requests, and survive being split across writes');
    assert.strictEqual(c.text, 'heard 0 bytes at 16000');
    await assert.rejects(e.transcribe({ pcm: b64(10), prompt: 'FAIL' }), /audio could not be read/);
    assert.strictEqual((await e.transcribe({ pcm: b64(2) })).text, 'heard 2 bytes at 16000', 'one failed request does not end the server');
    const p = e.proc; e.stop();
    assert.deepStrictEqual([e.status().running, e.proc, e.ready], [false, null, null]);
    await new Promise((r) => p.on('close', r)); assert.strictEqual(p.exitCode, 0, 'asked to quit, it quits');
    assert.strictEqual((await e.transcribe({ pcm: b64(4) })).text, 'heard 4 bytes at 16000', 'the next dictation starts it again');
    assert.strictEqual(calls.length, 2); e.stop();
  }
  {
    step('idle');
    // the model is unloaded when dictation has not been used for a while, and comes back on demand
    const { e, calls } = engine({ engine: { idleMs: 60 } });
    await e.transcribe({ pcm: b64(8) }); assert.strictEqual(e.status().running, true);
    await wait(30); await e.transcribe({ pcm: b64(8) }); await wait(40); assert.strictEqual(e.status().running, true, 'use keeps it alive');
    await wait(60); assert.strictEqual(e.status().running, false, 'idle, it is stopped, freeing its memory');
    await e.transcribe({ pcm: b64(8) }); assert.strictEqual(calls.length, 2); e.stop();
    assert.strictEqual(new VoiceEngine({ server: FAKE, requirements: FAKE }).idleMs, 600000, 'ten minutes unless told otherwise');
  }
  {
    step('failures');
    // failures
    const a = engine({ mode: 'fail-load' });
    await assert.rejects(a.e.transcribe({ pcm: b64(8) }), /could not load the model: CUDA out of memory/); assert.strictEqual(a.e.status().running, false);
    const b = engine({ mode: 'crash-on-request' }); await b.e.start();
    const both = await Promise.allSettled([b.e.transcribe({ pcm: b64(8) }), b.e.transcribe({ pcm: b64(8) })]);
    assert.deepStrictEqual(both.map((r) => r.status), ['rejected', 'rejected'], 'a server that dies takes its unanswered requests with it, rather than leaving them waiting');
    assert(/server stopped \(exit 139\): Segmentation fault/.test(both[0].reason.message), both[0].reason.message);
    assert.strictEqual(b.e.status().running, false);
    const c = engine({ mode: 'exit-after-ready' }); await c.e.start(); await wait(80);
    assert.strictEqual(c.e.status().running, false, 'a server that dies while idle is noticed');
    const d = engine({ noPython: true });
    await assert.rejects(d.e.transcribe({ pcm: b64(8) }), /voice input is not set up on this machine/);
    await assert.rejects(d.e.transcribe({ pcm: b64(8) }), /not set up/, 'and asking again tries again');
  }
  console.log('VOICE OK');
})().catch((e) => { console.error('VOICE FAILED:', e.stack || e.message); process.exit(1); });
