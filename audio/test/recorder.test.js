'use strict';
// The recorder and the extension's commands, with a recorder library that plays back prepared frames. No microphone.
const assert = require('assert');
const Module = require('module');
const { Recorder, pickDevice, probeInputs, bluetoothHeadsets, isMonitor, FRAME } = require('../src/recorder');

// ---- choosing a device
const LINUX = ['Monitor of Built-in Audio Digital Stereo (IEC958)', 'Built-in Audio Analog Stereo', 'Monitor of GA102 High Definition Audio Controller Digital Stereo (HDMI)', 'USB Microphone'];
assert.deepStrictEqual(pickDevice(LINUX, ''), { index: 1, name: 'Built-in Audio Analog Stereo', why: 'first-input' }, 'the first device is a monitor of the speakers: it is skipped');
assert.deepStrictEqual(pickDevice(LINUX, 'usb microphone '), { index: 3, name: 'USB Microphone', why: 'chosen' }, 'a chosen device, matched loosely');
assert.deepStrictEqual(pickDevice(LINUX, LINUX[0]), { index: 0, name: LINUX[0], why: 'chosen' }, 'a monitor can still be chosen on purpose');
assert.deepStrictEqual(pickDevice(LINUX, 'Unplugged Headset'), { index: 1, name: 'Built-in Audio Analog Stereo', why: 'first-input' }, 'a chosen device that is gone falls back');
assert.deepStrictEqual(pickDevice(['MacBook Pro Microphone'], ''), { index: 0, name: 'MacBook Pro Microphone', why: 'first-input' });
assert.deepStrictEqual([pickDevice([LINUX[0]], ''), pickDevice([], ''), pickDevice(undefined, 'x')].map((p) => p.index), [-1, -1, -1], 'nothing but monitors, or nothing at all: leave it to the system');
assert.deepStrictEqual(['Monitor of X', 'monitor of y', 'Studio Monitor Mic', ''].map(isMonitor), [true, true, false, false]);

// ---- what the system knows about each input. This is the report from a desktop with empty jacks.
const port = (name, availability) => ({ name, description: name, availability });
const DESKTOP = JSON.stringify([
  { name: 'alsa_output.iec958.monitor', description: LINUX[0], ports: [port('iec958-stereo-output', 'availability unknown')] },
  { name: 'alsa_input.analog-stereo', description: 'Built-in Audio Analog Stereo', ports: [port('analog-input-front-mic', 'not available'), port('analog-input-rear-mic', 'not available'), port('analog-input-linein', 'not available')] },
  { name: 'alsa_output.hdmi.monitor', description: LINUX[2], ports: [port('hdmi-output-0', 'available')] },
]);
const run = (out) => (cmd, args) => { assert.deepStrictEqual([cmd, args], ['pactl', ['-f', 'json', 'list', 'sources']]); if (out instanceof Error) throw out; return out; };
const EMPTY = probeInputs(run(DESKTOP), 'linux');
assert.strictEqual(EMPTY['Built-in Audio Analog Stereo'], 'unplugged', 'every jack of the input is empty');
const plugged = JSON.parse(DESKTOP); plugged[1].ports[1].availability = 'available';
assert.strictEqual(probeInputs(run(JSON.stringify(plugged)), 'linux')['Built-in Audio Analog Stereo'], 'available', 'one jack in use is enough');
const usb = JSON.stringify([{ description: 'USB Microphone', ports: [port('analog-input-mic', 'availability unknown')] }, { description: 'Headset', ports: [] }, { description: 'Odd' }, { ports: [] }, null]);
assert.deepStrictEqual(probeInputs(run(usb), 'linux'), { 'USB Microphone': 'unknown', Headset: 'unknown', Odd: 'unknown' }, 'a device with no jack to sense is not called unplugged');
assert.deepStrictEqual([probeInputs(run(new Error('pactl: not found')), 'linux'), probeInputs(run('not json'), 'linux'), probeInputs(run('{}'), 'linux'), probeInputs(() => { throw new Error('must not run'); }, 'darwin')], [{}, {}, {}, {}], 'no sound server to ask, or another system: nothing is known, and nothing is ruled out');

// ---- Bluetooth headsets: found from the card list, whichever profile they are in. This is a desktop with Galaxy Buds
// in their high-fidelity profile, so the sound server lists no microphone for them.
const BUDS = { name: 'bluez_card.6C_DD_BC_07_03_10', active_profile: 'a2dp-sink', properties: { 'device.description': 'Galaxy Buds Live (0310)', 'device.alias': 'Galaxy Buds Live (0310)' },
  profiles: { off: { sources: 0, available: true }, 'headset-head-unit': { sources: 1, available: true }, 'a2dp-sink': { sources: 0, available: true }, 'headset-head-unit-cvsd': { sources: 1, available: true }, 'headset-head-unit-msbc': { sources: 1, available: true } } };
const SPEAKER = { name: 'bluez_card.AA_BB', active_profile: 'a2dp-sink', properties: { 'device.description': 'Kitchen Speaker' }, profiles: { off: { sources: 0, available: true }, 'a2dp-sink': { sources: 0, available: true } } };
const ONBOARD = { name: 'alsa_card.pci-0000_00_1f.3', active_profile: 'output:iec958-stereo+input:analog-stereo', properties: { 'device.description': 'Built-in Audio' }, profiles: { 'input:analog-stereo': { sources: 1, available: true } } };
const CARDS = JSON.stringify([ONBOARD, BUDS, SPEAKER]);
const runCards = (out) => (cmd, args) => { assert.deepStrictEqual([cmd, args], ['pactl', ['-f', 'json', 'list', 'cards']]); if (out instanceof Error) throw out; return out; };
assert.deepStrictEqual(bluetoothHeadsets(runCards(CARDS), 'linux'), [{ card: 'bluez_card.6C_DD_BC_07_03_10', name: 'Galaxy Buds Live (0310)', active: 'a2dp-sink', headset: 'headset-head-unit-msbc', inHeadsetMode: false }], 'the buds, with the 16 kHz headset profile chosen; a speaker has no microphone and is left out');
const inHfp = JSON.parse(CARDS); inHfp[1].active_profile = 'headset-head-unit';
assert.deepStrictEqual(bluetoothHeadsets(runCards(JSON.stringify(inHfp)), 'linux')[0].inHeadsetMode, true);
const noMsbc = JSON.parse(CARDS); delete noMsbc[1].profiles['headset-head-unit-msbc']; noMsbc[1].profiles['headset-head-unit'].available = false;
assert.deepStrictEqual(bluetoothHeadsets(runCards(JSON.stringify(noMsbc)), 'linux')[0].headset, 'headset-head-unit-cvsd', 'the next headset profile that is available');
assert.deepStrictEqual([bluetoothHeadsets(runCards(new Error('pactl: not found')), 'linux'), bluetoothHeadsets(runCards('nope'), 'linux'), bluetoothHeadsets(() => { throw new Error('must not run'); }, 'darwin')], [[], [], []]);

assert.deepStrictEqual(pickDevice(LINUX, '', EMPTY), { index: 3, name: 'USB Microphone', why: 'first-input' }, 'an empty jack is passed over for a device that may be real');
assert.deepStrictEqual(pickDevice(LINUX, '', { 'Built-in Audio Analog Stereo': 'unknown', 'USB Microphone': 'available' }).name, 'USB Microphone', 'an input known to be connected is preferred to one that is only listed');
assert.deepStrictEqual(pickDevice(LINUX.slice(0, 3), '', EMPTY), { index: -1, name: '', why: 'system-default' }, 'with nothing else, there is no microphone to pick');
assert.deepStrictEqual(pickDevice(LINUX, 'Built-in Audio Analog Stereo', EMPTY).why, 'chosen', 'a device chosen on purpose is used, whatever the system reports');

// ---- a recorder library that plays back frames
function fakeLibrary({ devices = LINUX, frames = [], rate = 16000, failOpen, failRead } = {}) {
  const log = [];
  class Fake {
    constructor(frameLength, index, buffered) { if (failOpen) throw new Error(failOpen); log.push(['open', frameLength, index, buffered]); this.i = 0; this.buf = new Int16Array(frameLength); this.sampleRate = rate; this.index = index; }
    static getAvailableDevices() { return devices; }
    getSelectedDevice() { return this.index >= 0 ? devices[this.index] : 'system default'; }
    start() { log.push(['start']); } stop() { log.push(['stop']); } release() { log.push(['release']); }
    async read() {
      await new Promise((r) => setImmediate(r));
      if (failRead && this.i === failRead.at) throw new Error(failRead.message);
      this.buf.fill(frames.length ? frames[this.i % frames.length] : 0); this.i++;
      return this.buf;                                        // the same buffer every time, as the real library does
    }
  }
  return { Fake, log };
}
const until = async (f, ms = 2000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setImmediate(r)); } };

(async () => {
  // ---- recording
  {
    const { Fake, log } = fakeLibrary({ frames: [1000, -2000, 3000] });
    const r = new Recorder({ PvRecorder: Fake, maxSeconds: 60 });
    assert.deepStrictEqual(r.start(), { device: 'Built-in Audio Analog Stereo', sampleRate: 16000, picked: 'first-input' });
    assert.deepStrictEqual(log[0], ['open', FRAME, 1, 100]);
    assert.throws(() => r.start(), /already recording/);
    await until(() => r.samples >= FRAME * 6);
    const l = r.level();
    assert(l.level > 0 && l.level <= 1 && l.seconds > 0 && l.ended === null && l.silent === false && l.device === 'Built-in Audio Analog Stereo');
    const out = await r.stop();
    assert.deepStrictEqual(log.slice(-2), [['stop'], ['release']], 'the device is given back');
    assert(Math.abs(out.pcm.length / 32000 - out.seconds) < 0.01, '16-bit mono: two bytes a sample, 16000 samples a second');
    assert.strictEqual(out.pcm.length % (FRAME * 2), 0);
    const s = new Int16Array(out.pcm.buffer, out.pcm.byteOffset, out.pcm.length / 2);
    assert.deepStrictEqual([s[0], s[FRAME], s[FRAME * 2], s[FRAME * 3]], [1000, -2000, 3000, 1000], 'each frame is kept as it was read, though the library reuses one buffer');
    assert.deepStrictEqual([out.peak, out.sampleRate, out.ended, out.error], [3000, 16000, null, null]);
    assert.strictEqual(r.rec, null);
  }
  {
    // silence: a muted input, or the wrong one
    const { Fake } = fakeLibrary({ frames: [0] });
    const r = new Recorder({ PvRecorder: Fake, maxSeconds: 60 }); r.start();
    await until(() => r.seconds() > 1.05);
    assert.deepStrictEqual([r.level().silent, r.level().level], [true, 0], 'over a second with nothing at all heard is reported');
    assert.strictEqual((await r.stop()).peak, 0);
  }
  {
    // it ends by itself
    const { Fake, log } = fakeLibrary({ frames: [500] });
    const r = new Recorder({ PvRecorder: Fake, maxSeconds: 1 }); r.start();
    await until(() => r.level().ended === 'max');
    const n = r.samples; await new Promise((res) => setTimeout(res, 30));
    assert.strictEqual(r.samples, n, 'nothing more is recorded after the limit');
    const out = await r.stop();
    assert(out.seconds >= 1 && out.seconds < 1.1 && out.ended === 'max'); assert.deepStrictEqual(log.slice(-2), [['stop'], ['release']]);
  }
  {
    // the device fails mid-recording: what was heard is kept
    const { Fake } = fakeLibrary({ frames: [700], failRead: { at: 5, message: 'device unplugged' } });
    const r = new Recorder({ PvRecorder: Fake, maxSeconds: 60 }); r.start();
    await until(() => r.level().ended === 'error');
    const out = await r.stop();
    assert.deepStrictEqual([out.error, out.ended, out.pcm.length], ['device unplugged', 'error', 5 * FRAME * 2]);
  }
  {
    // cancel keeps nothing
    const { Fake, log } = fakeLibrary({ frames: [900] });
    const r = new Recorder({ PvRecorder: Fake }); r.start(); await until(() => r.samples > 0);
    await r.cancel();
    assert.deepStrictEqual([r.chunks.length, r.samples, r.rec], [0, 0, null]); assert.deepStrictEqual(log.slice(-2), [['stop'], ['release']]);
    assert.strictEqual(new Recorder({ PvRecorder: Fake }).maxSeconds, 180); assert.strictEqual(new Recorder({ PvRecorder: Fake, maxSeconds: -5 }).maxSeconds, 1);
  }
  assert.throws(() => new Recorder({ PvRecorder: fakeLibrary({ failOpen: 'permission denied' }).Fake }).start(), /permission denied/);

  // ---- the commands Perch calls
  const origLoad = Module._load;
  function load({ library, config = {}, sources, cards, onProfile }) {
    const commands = {}; const ui = { errors: [], picks: [], updates: [], profiles: [] };
    const vscode = {
      workspace: { getConfiguration: () => ({ get: (k) => config[k], update: async (k, v, t) => { ui.updates.push([k, v, t]); config[k] = v; } }) },
      window: { showErrorMessage: (m) => ui.errors.push(m), showQuickPick: async (items) => { ui.items = items; return ui.picks.length ? items.find(ui.picks.shift()) : undefined; } },
      commands: { registerCommand: (id, f) => { commands[id] = f; return { dispose() {} }; } },
      ConfigurationTarget: { Global: 1 },
    };
    Module._load = function (req, parent, isMain) {
      if (req === 'vscode') return vscode;
      if (req === '@picovoice/pvrecorder-node') { if (library instanceof Error) throw library; return { PvRecorder: library }; }
      return origLoad.call(this, req, parent, isMain);
    };
    delete require.cache[require.resolve('../src/extension.js')];
    const ext = require('../src/extension.js'); ext._reset({ exec: (cmd, args) => {
      if (args[0] === 'set-card-profile') { ui.profiles.push(args.slice(1)); if (onProfile) onProfile(args[1], args[2]); return ''; }
      if (args.includes('cards')) { if (cards === undefined) throw new Error('no sound server'); return cards; }
      if (sources === undefined) throw new Error('no sound server'); return sources; } });
    const subs = []; ext.activate({ subscriptions: subs });
    return { commands, ui, ext, subs };
  }
  {
    const { Fake, log } = fakeLibrary({ frames: [1200, -1200] });
    const x = load({ library: Fake, config: { device: '', maxSeconds: 30 } });
    assert.deepStrictEqual(x.commands['_perch.audio.available'](), { ok: true, api: 2, devices: LINUX, states: {}, device: 'Built-in Audio Analog Stereo', busy: false, headsets: [] });
    const s = await x.commands['_perch.audio.start']();
    assert.deepStrictEqual([s.ok, s.device, s.sampleRate, s.maxSeconds, s.picked, typeof s.id], [true, 'Built-in Audio Analog Stereo', 16000, 30, 'first-input', 'string']);
    assert.deepStrictEqual([(await x.commands['_perch.audio.start']()).code, x.commands['_perch.audio.available']().busy], ['busy', true], 'one recording at a time');
    await until(() => x.commands['_perch.audio.level'](s.id).seconds > 0.1);
    assert.deepStrictEqual([x.commands['_perch.audio.level']('other').code, (await x.commands['_perch.audio.stop']('other')).code], ['unknown', 'unknown'], 'a recording is only answered to whoever started it');
    const out = await x.commands['_perch.audio.stop'](s.id);
    assert.deepStrictEqual([out.ok, out.sampleRate, out.silent, out.device, typeof out.pcm], [true, 16000, false, 'Built-in Audio Analog Stereo', 'string']);
    const pcm = Buffer.from(out.pcm, 'base64'); assert(Math.abs(pcm.length / 32000 - out.seconds) < 0.01 && pcm.length % (FRAME * 2) === 0);
    assert.deepStrictEqual([pcm.readInt16LE(0), pcm.readInt16LE(FRAME * 2)], [1200, -1200], 'the audio crosses as base64 and comes back exact');
    assert.strictEqual(JSON.stringify(out).length < pcm.length * 1.4 + 300, true, 'and as plain JSON, which is all a command can carry between machines');
    assert.strictEqual((await x.commands['_perch.audio.stop'](s.id)).code, 'unknown', 'a recording can be collected once');
    const s2 = await x.commands['_perch.audio.start'](); assert.strictEqual(s2.ok, true, 'and then another can start');
    assert.deepStrictEqual(await x.commands['_perch.audio.cancel'](s2.id), { ok: true }); assert.deepStrictEqual(await x.commands['_perch.audio.cancel']('whatever'), { ok: true });
    const s3 = await x.commands['_perch.audio.start'](); const opens = log.filter((e) => e[0] === 'release').length;
    for (const d of x.subs) d.dispose(); await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(log.filter((e) => e[0] === 'release').length, opens + 1, 'closing the window lets go of the microphone'); assert(s3.ok);

    // a Bluetooth headset with no microphone exposed: offered by name, switched to headset mode for the recording, and back after
    {
      const devs = ['Monitor of Built-in Audio Digital Stereo (IEC958)', 'Built-in Audio Analog Stereo', 'Monitor of Galaxy Buds Live (0310)'];   // no Snowball, an empty jack, the buds playing music
      const { Fake: BudsLib, log: blog } = fakeLibrary({ devices: devs, frames: [500] });
      const y = load({ library: BudsLib, config: { device: '', maxSeconds: 30 }, sources: DESKTOP, cards: CARDS, onProfile: (card, profile) => { if (/^headset/.test(profile) && !devs.includes('Galaxy Buds Live (0310)')) devs.push('Galaxy Buds Live (0310)'); } });
      const av = y.commands['_perch.audio.available']();
      assert.deepStrictEqual([av.ok, av.device, av.states['Galaxy Buds Live (0310)'], av.devices.includes('Galaxy Buds Live (0310)'), av.headsets.length], [true, 'Galaxy Buds Live (0310)', 'headset', true, 1], 'the buds are the microphone, though the sound server lists none for them yet');
      const st = await y.commands['_perch.audio.start']();
      assert.deepStrictEqual([st.ok, st.device, y.ui.profiles], [true, 'Galaxy Buds Live (0310)', [['bluez_card.6C_DD_BC_07_03_10', 'headset-head-unit-msbc']]], 'switched to the headset profile first, and recording from the microphone that appeared');
      assert.deepStrictEqual(blog.filter((e) => e[0] === 'open').pop()[2], 3, 'opened by the index it has once listed');
      await until(() => y.commands['_perch.audio.level'](st.id).seconds > 0.1);
      const got = await y.commands['_perch.audio.stop'](st.id);
      assert.deepStrictEqual([got.ok, got.device, y.ui.profiles.pop()], [true, 'Galaxy Buds Live (0310)', ['bluez_card.6C_DD_BC_07_03_10', 'a2dp-sink']], 'and put back to music once the recording is collected');
      const st2 = await y.commands['_perch.audio.start'](); await y.commands['_perch.audio.cancel'](st2.id);
      assert.deepStrictEqual(y.ui.profiles.slice(-2), [['bluez_card.6C_DD_BC_07_03_10', 'headset-head-unit-msbc'], ['bluez_card.6C_DD_BC_07_03_10', 'a2dp-sink']], 'a cancelled recording puts it back too');
      // a plugged-in microphone is still preferred to a headset that would have to switch; the headset can be chosen by name
      devs.length = 0; devs.push(...LINUX); const yy = load({ library: BudsLib, config: { device: '', maxSeconds: 30 }, sources: JSON.stringify(plugged), cards: CARDS });
      assert.strictEqual(yy.commands['_perch.audio.available']().device, 'Built-in Audio Analog Stereo');
      const yz = load({ library: BudsLib, config: { device: 'galaxy buds live (0310)', maxSeconds: 30 }, sources: JSON.stringify(plugged), cards: CARDS });
      assert.strictEqual(yz.commands['_perch.audio.available']().device, 'Galaxy Buds Live (0310)');
      yz.ui.picks.push((i) => i.value === 'Galaxy Buds Live (0310)'); await yz.commands['perchAudio.listDevices']();
      assert.deepStrictEqual(yz.ui.items.find((i) => i.value === 'Galaxy Buds Live (0310)').description, 'Bluetooth headset, in headset mode while recording · current');
    }

    // choosing a microphone: real inputs first, monitors last and labelled
    x.ui.picks.push((i) => i.value === 'USB Microphone'); await x.commands['perchAudio.listDevices']();
    assert.deepStrictEqual(x.ui.items.map((i) => i.label), ['First microphone found', 'Built-in Audio Analog Stereo', 'USB Microphone', LINUX[0], LINUX[2]]);
    assert.deepStrictEqual(x.ui.items.slice(1, 3).map((i) => i.description), ['', ''], 'with nothing known, nothing is claimed');
    assert(/records what the speakers play/.test(x.ui.items[3].description));
    assert.deepStrictEqual(x.ui.updates, [['device', 'USB Microphone', 1]], 'saved for this user, on this machine');
    assert.strictEqual(x.commands['_perch.audio.available']().device, 'USB Microphone');
    await x.commands['perchAudio.listDevices'](); assert.strictEqual(x.ui.updates.length, 1, 'dismissing changes nothing');
  }
  {
    // ---- a desktop with nothing plugged in: there is no microphone, and recording an empty jack is refused
    const desk = load({ library: fakeLibrary({ devices: LINUX.slice(0, 3) }).Fake, sources: DESKTOP, config: {} });
    const av = desk.commands['_perch.audio.available']();
    assert.deepStrictEqual([av.ok, av.code, av.states['Built-in Audio Analog Stereo']], [false, 'no-microphone', 'unplugged']);
    assert(/^No microphone is connected to this computer: nothing is plugged into its audio input\. Plug in a microphone or a headset, or dictate from a computer that has one, connected to this workspace over Remote-SSH/.test(av.error), av.error);
    assert.strictEqual((await desk.commands['_perch.audio.start']()).code, 'no-microphone', 'so nothing is recorded');
    desk.ui.picks.push((i) => i.value === ''); await desk.commands['perchAudio.listDevices']();
    assert.strictEqual(desk.ui.items[1].description, 'nothing plugged in', 'the chooser says why');
    // a headset is plugged in
    const lib2 = fakeLibrary({ devices: LINUX.slice(0, 3), frames: [400] });
    const live = load({ library: lib2.Fake, sources: JSON.stringify(plugged), config: {} });
    assert.deepStrictEqual([live.commands['_perch.audio.available']().ok, live.commands['_perch.audio.available']().device], [true, 'Built-in Audio Analog Stereo']);
    const ls = await live.commands['_perch.audio.start'](); assert(ls.ok); await live.commands['_perch.audio.cancel'](ls.id);
    live.ui.picks.push(() => false); await live.commands['perchAudio.listDevices'](); assert.strictEqual(live.ui.items[1].description, 'connected');
    // a USB microphone beside the empty jacks
    const mix = load({ library: fakeLibrary({ devices: LINUX, frames: [400] }).Fake, sources: DESKTOP, config: {} });
    assert.deepStrictEqual([mix.commands['_perch.audio.available']().ok, mix.commands['_perch.audio.available']().device], [true, 'USB Microphone'], 'the empty jack is passed over');
    const ms = await mix.commands['_perch.audio.start'](); assert.strictEqual(ms.device, 'USB Microphone'); await mix.commands['_perch.audio.cancel'](ms.id);
    // the user insists on the jack: it is their call
    const forced = load({ library: fakeLibrary({ devices: LINUX.slice(0, 3), frames: [400] }).Fake, sources: DESKTOP, config: { device: 'Built-in Audio Analog Stereo' } });
    assert.strictEqual(forced.commands['_perch.audio.available']().ok, true); const fs2 = await forced.commands['_perch.audio.start'](); assert.strictEqual(fs2.picked, 'chosen'); await forced.commands['_perch.audio.cancel'](fs2.id);

    const broken = load({ library: new Error('pv_recorder.node: invalid ELF header') });
    assert.deepStrictEqual([broken.commands['_perch.audio.available']().code, (await broken.commands['_perch.audio.start']()).code], ['no-library', 'no-library']);
    assert(/could not be loaded on this machine: pv_recorder.node: invalid ELF header/.test(broken.commands['_perch.audio.available']().error));
    const none = load({ library: fakeLibrary({ devices: [LINUX[0], LINUX[2]] }).Fake });
    assert.deepStrictEqual([none.commands['_perch.audio.available']().code, (await none.commands['_perch.audio.start']()).code], ['no-microphone', 'no-microphone'], 'only monitors: there is no microphone');
    const denied = load({ library: fakeLibrary({ failOpen: 'Failed to open device' }).Fake, config: {} });
    const d = await denied.commands['_perch.audio.start'](); assert.strictEqual(d.code, 'capture-failed'); assert(/Could not open the microphone: Failed to open device\. Your system may be asking for microphone permission/.test(d.error));
    assert.strictEqual(denied.commands['_perch.audio.available']().busy, false, 'a failed start leaves nothing held');
  }
  Module._load = origLoad;
  console.log('AUDIO OK');
})().catch((e) => { console.error('AUDIO FAILED:', e.stack || e.message); process.exit(1); });
