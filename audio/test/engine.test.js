'use strict';
// The extension's speech-to-text commands, with a stand-in engine and a stand-in recorder library. No Python, no microphone.
const assert = require('assert');
const Module = require('module');

const FRAME = 512;
const ui = { progress: [] };
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (k) => (k in cfgBox ? cfgBox[k] : k === 'maxSeconds' ? 180 : ''), update: async () => {} }) },
  window: { withProgress: async (o, task) => { ui.progress.push(o.title); return task({ report: (r) => ui.progress.push(r.message) }); }, showErrorMessage: () => {}, showQuickPick: async () => undefined },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
};
const commands = {}; const cfgBox = {};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? fakeVscode : load.call(this, request, ...rest); };
const ext = require('../src/extension');
Module._load = load;

// a recorder library that plays back a second of tone, so a recording has something in it
let frames = 0;
class FakeRecorder {
  constructor() { this.sampleRate = 16000; this.frameLength = FRAME; }
  static getAvailableDevices() { return ['USB Microphone']; }
  start() {} stop() {} release() {}
  async read() { frames++; const f = new Int16Array(FRAME); for (let i = 0; i < FRAME; i++) f[i] = Math.round(8000 * Math.sin(i / 5)); await new Promise((r) => setTimeout(r, 2)); return f; }
}
FakeRecorder.getAvailableDevices = () => ['USB Microphone'];

// a stand-in engine, recording what it is asked
const box = { installed: false, made: [], installs: 0, starts: 0, stops: 0, requests: [], failInstall: null };
class FakeEngine {
  constructor(o) { this.o = o; this.home = '/home/me/.local/share/perch/voice'; this.model = o.model; box.made.push(o); }
  isInstalled() { return box.installed; }
  async install(onStep) { box.installs++; onStep('Creating a private Python environment', 5); if (box.failInstall) throw new Error(box.failInstall); onStep('Ready', 100); box.installed = true; return { ready: true, device: 'cuda', model: 'large-v3-turbo' }; }
  start() { box.starts++; return Promise.resolve({ device: 'cuda' }); }
  async transcribe(a) { box.requests.push(a); return { text: 'hello from the laptop', language: a.language || 'en', seconds: 1, took_ms: 40 }; }
  stop() { box.stops++; }
}

(async () => {
  const gpuExec = (cmd, args) => { if (cmd === 'nvidia-smi') { assert.deepStrictEqual(args, ['-L']); return 'GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-1)\n'; } if (cmd === 'pactl') return '[]'; throw new Error('no ' + cmd); };
  ext._reset({ exec: gpuExec, engine: FakeEngine });
  require.cache[require.resolve('@picovoice/pvrecorder-node')] = { id: 'x', filename: 'x', loaded: true, exports: { PvRecorder: FakeRecorder } };
  ext.activate({ subscriptions: [] });
  const run = (op, ...a) => commands['_perch.audio.' + op](...a);

  // ---- status: the API says it can transcribe; the engine reports whether it is set up and whether there is a GPU
  const av = run('available');
  assert.deepStrictEqual([av.ok, av.api], [true, 2]);
  const st = run('engine', { model: 'auto', device: 'auto', idleMs: 600000 });
  assert.deepStrictEqual([st.ok, st.installed, st.gpu, st.home, typeof st.host], [true, false, true, '/home/me/.local/share/perch/voice', 'string']);
  const Path = require('path');
  assert.deepStrictEqual(box.made, [{ model: 'auto', device: 'auto', python: undefined, idleMs: 600000, server: Path.join(__dirname, '..', 'voice', 'server.py'), requirements: Path.join(__dirname, '..', 'voice', 'requirements.txt') }], 'the engine is made with the settings Perch sent, and this extension\'s copy of the server');
  assert.strictEqual(run('engine', { model: 'auto', device: 'auto', idleMs: 600000 }).ok, true); assert.strictEqual(box.made.length, 1, 'the same settings reuse the engine');
  run('engine', { model: 'small' }); assert.deepStrictEqual([box.made.length, box.stops, box.made[1].model, box.made[1].idleMs], [2, 1, 'small', 600000], 'other settings replace it, stopping the old one');

  // ---- setup: runs the install with progress shown here, once
  box.failInstall = 'no Python';
  assert.deepStrictEqual(await run('setup', { model: 'small' }), { ok: false, error: 'no Python', code: 'setup-failed' });
  box.failInstall = null;
  assert.deepStrictEqual([await run('setup', { model: 'small' }), box.installs, ui.progress], [{ ok: true }, 2, ['Perch voice input', 'Creating a private Python environment', 'Perch voice input', 'Creating a private Python environment', 'Ready']]);
  assert.deepStrictEqual([await run('setup', { model: 'small' }), box.installs], [{ ok: true }, 2], 'already set up: nothing runs');

  // ---- warm, record, transcribe: the text comes back, the audio does not
  assert.deepStrictEqual([run('warm', { model: 'small' }), box.starts], [{ ok: true }, 1]);
  const s = await run('start'); assert.strictEqual(s.ok, true);
  await new Promise((r) => setTimeout(r, 120));
  const t = await run('transcribe', s.id, { engine: { model: 'small' }, language: 'ko', prompt: 'Perch' });
  assert.deepStrictEqual([t.ok, t.text, t.language, t.silent, 'pcm' in t, t.seconds > 0], [true, 'hello from the laptop', 'ko', false, false, true]);
  assert.deepStrictEqual([box.requests.length, box.requests[0].language, box.requests[0].prompt, box.requests[0].sampleRate, box.requests[0].pcm.length > 0], [1, 'ko', 'Perch', 16000, true]);
  assert.deepStrictEqual(await run('transcribe', 'nope', {}), { ok: false, error: 'No such recording.', code: 'unknown' });
  assert.deepStrictEqual(run('unload'), { ok: true }); assert.strictEqual(box.stops, 2);

  // ---- the diagnostic: with a directory named, each recording is saved as a WAV there, and what was heard is logged
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'perch-rec-')); cfgBox.saveRecordings = dir;
  const s2 = await run('start'); await new Promise((r) => setTimeout(r, 60)); const t2 = await run('transcribe', s2.id, { engine: { model: 'small' } });
  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual([files.length, /^perch-\d{4}-\d{2}-\d{2}T.*-USB_Microphone\.wav$/.test(files[0]), files[1]], [2, true, 'transcripts.log'], 'named by time and device');
  const wav = fs.readFileSync(Path.join(dir, files[0]));
  assert.deepStrictEqual([wav.slice(0, 4).toString(), wav.slice(8, 12).toString(), wav.readUInt32LE(24), wav.readUInt16LE(22), wav.readUInt32LE(40) + 44], ['RIFF', 'WAVE', 16000, 1, wav.length], '16 kHz mono 16-bit, the whole recording');
  assert(wav.readUInt32LE(40) >= 2 * FRAME * 2, 'more than a frame of audio');
  assert(new RegExp(' USB Microphone ' + t2.seconds + 's -> "hello from the laptop"\n$').test(fs.readFileSync(Path.join(dir, 'transcripts.log'), 'utf8')));
  delete cfgBox.saveRecordings; fs.rmSync(dir, { recursive: true, force: true });
  const s3 = await run('start'); await new Promise((r) => setTimeout(r, 20)); await run('transcribe', s3.id, { engine: { model: 'small' } });
  assert.strictEqual(fs.existsSync(dir), false, 'nothing is written once it is off');

  // ---- no GPU, no engine
  ext._reset({ exec: (cmd) => { if (cmd === 'pactl') return '[]'; throw new Error('no ' + cmd); }, engine: FakeEngine });
  assert.strictEqual(run('engine', {}).gpu, false, 'nvidia-smi missing means no GPU');
  ext._reset({ exec: gpuExec });
  // with the engine copy missing (an old or broken build), the commands say so rather than fail oddly
  const orig = Module._load;
  Module._load = function (request, ...rest) { if (request === './engine' && rest[0] && rest[0].filename === Path.join(__dirname, '..', 'src', 'extension.js')) throw new Error("Cannot find module './engine'"); return orig.call(this, request, ...rest); };
  try {
    const e = run('engine', {}); assert.deepStrictEqual([e.ok, e.code, /set perch\.voice\.runOn to remote/.test(e.error)], [false, 'no-engine', true]);
    assert.strictEqual((await run('setup', {})).code, 'no-engine');
    assert.deepStrictEqual(run('warm', {}), { ok: false });
  } finally { Module._load = orig; }
  ext._reset({});
  console.log('AUDIO ENGINE OK');
})().catch((e) => { console.error(e); process.exit(1); });
