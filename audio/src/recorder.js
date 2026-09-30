'use strict';
// Microphone capture. No VS Code dependency: the recorder library is passed in, so this can be tested without a microphone.

const FRAME = 512;              // samples per read: 32 ms at 16 kHz
const BUFFERED_FRAMES = 100;    // about three seconds of slack before the library would drop audio

/**
 * What the operating system knows about each input: whether anything is plugged into it. An analog input jack exists as
 * a device whether or not a microphone is connected, and recording from an empty one yields only electrical noise.
 * Linux sound servers report this per port; elsewhere, and for USB and Bluetooth inputs, it is not known, and a device
 * that is listed is taken to be real.
 * @param {(cmd: string, args: string[]) => string} exec  runs a command and returns its output; throws if it cannot
 * @returns {Record<string, 'available'|'unplugged'|'unknown'>}  by device name, as the recorder library names them
 */
function probeInputs(exec, platform = process.platform) {
  const out = {};
  if (platform !== 'linux') return out;
  let sources;
  try { sources = JSON.parse(exec('pactl', ['-f', 'json', 'list', 'sources'])); } catch (_) { return out; }
  if (!Array.isArray(sources)) return out;
  for (const s of sources) {
    if (!s || typeof s.description !== 'string') continue;
    const ports = Array.isArray(s.ports) ? s.ports : [];
    const states = ports.map((p) => String((p && p.availability) || '').toLowerCase());
    out[s.description] = !states.length ? 'unknown' : states.some((a) => a === 'available') ? 'available' : states.every((a) => a === 'not available') ? 'unplugged' : 'unknown';
  }
  return out;
}

/**
 * Bluetooth headsets the sound server knows, whether or not their microphone is exposed at the moment. On Linux a headset
 * in its high-fidelity profile (A2DP) has no source at all; the microphone appears only in the headset profile (HSP/HFP),
 * which the sound server does not switch to by itself for a recorder that opens a device by name. So they are found
 * from the card list, and the recorder switches the profile around a recording.
 * @returns {{card: string, name: string, active: string, headset: string, inHeadsetMode: boolean}[]}
 */
function bluetoothHeadsets(exec, platform = process.platform) {
  if (platform !== 'linux') return [];
  let cards;
  try { cards = JSON.parse(exec('pactl', ['-f', 'json', 'list', 'cards'])); } catch (_) { return []; }
  const out = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || typeof c.name !== 'string' || !/^bluez_card\./.test(c.name)) continue;
    const profiles = c.profiles && typeof c.profiles === 'object' ? c.profiles : {};
    const withMic = (p) => profiles[p] && profiles[p].available !== false && Number(profiles[p].sources) > 0;
    // the headset profile with a microphone: mSBC (16 kHz, clearer) over the plain one over CVSD (8 kHz)
    const headset = ['headset-head-unit-msbc', 'headset-head-unit', 'headset-head-unit-cvsd'].find(withMic) || Object.keys(profiles).find((p) => /^headset/.test(p) && withMic(p));
    if (!headset) continue;
    const props = c.properties && typeof c.properties === 'object' ? c.properties : {};
    const name = String(props['device.description'] || props['device.alias'] || c.name);
    const active = String(c.active_profile || '');
    out.push({ card: c.name, name, active, headset, inHeadsetMode: /^headset/.test(active) });
  }
  return out;
}

/**
 * Which device to record from. The system "default" is not trusted: on Linux the first device is often a monitor
 * source, which records what the speakers play and hears nothing of the room.
 * @returns {{ index: number, name: string, why: 'chosen'|'first-input'|'system-default' }}
 */
function pickDevice(devices, wanted, states = {}) {
  const list = Array.isArray(devices) ? devices : [];
  const usable = (d) => !isMonitor(d) && states[d] !== 'unplugged';
  const norm = (s) => String(s || '').trim().toLowerCase();
  if (norm(wanted)) { const i = list.findIndex((d) => norm(d) === norm(wanted)); if (i >= 0) return { index: i, name: list[i], why: 'chosen' }; }
  // an input with something plugged in, before one the system cannot vouch for
  let i = list.findIndex((d) => usable(d) && states[d] === 'available');
  if (i < 0) i = list.findIndex(usable);
  if (i >= 0) return { index: i, name: list[i], why: 'first-input' };
  return { index: -1, name: '', why: 'system-default' };
}
function isMonitor(name) { return /^monitor of /i.test(String(name || '')); }

class Recorder {
  /**
   * @param {object} o
   * @param {Function} o.PvRecorder   the recorder class from @picovoice/pvrecorder-node
   * @param {string} [o.device]       device name; empty picks the first real input
   * @param {number} [o.maxSeconds]   recording ends by itself after this long
   * @param {object} [o.states]       what is known of each input, from probeInputs
   */
  constructor({ PvRecorder, device, maxSeconds, states }) {
    this.states = states || {};
    this.PvRecorder = PvRecorder;
    this.wanted = device || '';
    this.maxSeconds = Math.max(1, Number(maxSeconds) || 180);
    this.rec = null; this.on = false; this.loop = null;
    this.chunks = []; this.samples = 0; this.sampleRate = 16000;
    this.rms = 0; this.peak = 0; this.ended = null; this.error = null; this.device = '';
  }

  start() {
    if (this.rec) throw new Error('already recording');
    const pick = pickDevice(this.PvRecorder.getAvailableDevices(), this.wanted, this.states);
    this.rec = new this.PvRecorder(FRAME, pick.index, BUFFERED_FRAMES);
    this.sampleRate = this.rec.sampleRate || 16000;
    try { this.device = this.rec.getSelectedDevice() || pick.name; } catch (_) { this.device = pick.name; }
    this.rec.start();
    this.on = true;
    this.loop = this._loop();
    return { device: this.device, sampleRate: this.sampleRate, picked: pick.why };
  }

  async _loop() {
    try {
      while (this.on) {
        const frame = await this.rec.read();
        if (!this.on) break;
        this.chunks.push(Int16Array.from(frame));          // the library reuses its buffer: keep a copy
        this.samples += frame.length;
        let sum = 0, peak = 0;
        for (let i = 0; i < frame.length; i++) { const v = frame[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
        const rms = Math.sqrt(sum / (frame.length || 1)) / 32768;
        this.rms = this.rms * 0.6 + rms * 0.4;             // smoothed, so the meter does not flicker
        if (peak > this.peak) this.peak = peak;
        if (this.samples / this.sampleRate >= this.maxSeconds) { this.ended = 'max'; this.on = false; }
      }
    } catch (e) { this.error = String((e && e.message) || e); this.ended = 'error'; this.on = false; }
  }

  seconds() { return this.samples / this.sampleRate; }

  /** For the meter. `silent` means nothing at all has been heard for over a second: a muted or wrong input. */
  level() {
    return { level: Math.min(1, this.rms * 6), seconds: Math.round(this.seconds() * 10) / 10, ended: this.ended, error: this.error, silent: this.peak === 0 && this.seconds() > 1, device: this.device };
  }

  async _close() {
    this.on = false;
    try { await this.loop; } catch (_) { /* already recorded in this.error */ }
    if (this.rec) { try { this.rec.stop(); } catch (_) { /* not started */ } try { this.rec.release(); } catch (_) { /* already released */ } this.rec = null; }
  }

  /** @returns {Promise<{pcm: Buffer, sampleRate: number, seconds: number, peak: number, device: string, ended: string|null}>} 16-bit little-endian mono */
  async stop() {
    await this._close();
    const out = new Int16Array(this.samples);
    let at = 0; for (const c of this.chunks) { out.set(c, at); at += c.length; }
    this.chunks = [];
    return { pcm: Buffer.from(out.buffer, out.byteOffset, out.byteLength), sampleRate: this.sampleRate, seconds: Math.round(this.seconds() * 100) / 100, peak: this.peak, device: this.device, ended: this.ended, error: this.error };
  }

  async cancel() { await this._close(); this.chunks = []; this.samples = 0; }
}

module.exports = { Recorder, pickDevice, probeInputs, bluetoothHeadsets, isMonitor, FRAME };
