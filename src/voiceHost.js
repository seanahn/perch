'use strict';
// Dictation. Recording happens on the machine the user is sitting at, in the Perch Audio extension. Speech-to-text
// happens either here, with the workspace, or there, in Perch Audio, which carries the same engine: under Remote-SSH
// those are two machines, and what crosses between them, over VS Code's own connection, is the audio in the first
// case and only the text in the second. perch.voice.runOn chooses; auto means "where the GPU is".
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { VoiceEngine } = require('./voice');

const TICK_MS = 120;
const AUDIO_API = 2;             // what this perch was written against; 1 still records, but cannot transcribe there
const NO_COMPANION = 'Perch Audio is not installed on this computer. It records from your microphone, so it has to be installed where you are sitting, even when the workspace is remote. It comes with Perch from the marketplace; if it was removed, install Perch Audio (seanahn.perch-audio) from the Extensions view on this computer. From a checkout of perch: make install-audio, then reload the window.';

class VoiceHost {
  /**
   * @param {object} o
   * @param {string} o.root                                   the extension's directory
   * @param {(sid: string, ev: object) => void} o.send        an event for the page showing that session
   * @param {(sid: string, text: string) => void} o.deliver   text for that session's message box
   */
  constructor(o) {
    this.root = o.root; this.send = o.send; this.deliver = o.deliver;
    this.engine = null; this.engineKey = '';
    this.now = null;           // { sid, id, phase, timer, device, maxSeconds }
    this.busy = false;         // a start or stop is in flight
  }

  cfg(k) { return vscode.workspace.getConfiguration('perch').get('voice.' + k); }

  /** The engine's settings: for the engine here, and sent along to the one in Perch Audio. */
  engineOpts() { return { model: this.cfg('model') || 'auto', device: this.cfg('device') || 'auto', python: this.cfg('python') || undefined, idleMs: Math.max(0, Number(this.cfg('idleMinutes') === undefined || this.cfg('idleMinutes') === '' ? 10 : this.cfg('idleMinutes')) || 0) * 60000 }; }

  /** One engine per combination of settings; changing the model or device replaces it. */
  getEngine() {
    const o = this.engineOpts();
    const key = JSON.stringify(o);
    if (!this.engine || this.engineKey !== key) {
      if (this.engine) this.engine.stop();
      this.engine = new VoiceEngine(Object.assign({ server: path.join(this.root, 'voice', 'server.py'), requirements: path.join(this.root, 'voice', 'requirements.txt') }, o));
      this.engineKey = key;
    }
    return this.engine;
  }

  async audio(cmd, ...args) {
    try { return await vscode.commands.executeCommand('_perch.audio.' + cmd, ...args); }
    catch (e) { return { ok: false, code: /not found/i.test(String(e && e.message)) ? 'no-companion' : 'failed', error: /not found/i.test(String(e && e.message)) ? NO_COMPANION : String((e && e.message) || e) }; }
  }

  phase(sid, phase, extra) { this.send(sid, Object.assign({ kind: 'voice', phase }, extra)); }
  fail(sid, text) { this.phase(sid, 'idle'); this.send(sid, { kind: 'error', text: 'Voice input: ' + text }); }
  /** What a page should show for this session right now; sent again when a page is rebuilt. */
  resend(sid) { if (this.now && this.now.sid === sid) this.phase(sid, this.now.phase, { device: this.now.device, maxSeconds: this.now.maxSeconds }); }

  /**
   * Where the words are worked out for a recording: 'local', in Perch Audio on the computer the user sits at, or
   * 'remote', here. With no remote the two are one machine and the engine here is used. auto takes the local machine
   * when it has an NVIDIA GPU, so a laptop with one keeps its own audio and a CPU-only remote is spared the work.
   * @param {object} a  what _perch.audio.available answered
   * @returns {Promise<{where: 'local'|'remote', status?: object, error?: string}>}
   */
  async where(a) {
    const want = this.cfg('runOn') || 'auto';
    if (!vscode.env.remoteName || want === 'remote') return { where: 'remote' };
    const tooOld = 'Perch Audio on this computer is too old to transcribe there. Update it, or set perch.voice.runOn to remote.';
    if (!(a.api >= 2)) return want === 'local' ? { where: 'local', error: tooOld } : { where: 'remote' };
    const st = await this.audio('engine', this.engineOpts());
    if (!st || !st.ok) return want === 'local' ? { where: 'local', error: (st && st.error) || tooOld } : { where: 'remote' };
    return want === 'local' || st.gpu ? { where: 'local', status: st } : { where: 'remote' };
  }

  /** The one-time setup, with the user's agreement. It says which machine it installs on, which matters when remote. */
  async setup(ask = true) {
    const e = this.getEngine();
    if (e.isInstalled()) return true;
    const where = vscode.env.remoteName ? `${os.hostname()}, the remote machine` : 'this machine';
    if (ask) {
      const pick = await vscode.window.showInformationMessage(`Set up voice input on ${where}?`, { modal: true, detail: `This installs Whisper into a private Python environment and fetches ${e.model === 'auto' ? 'a model sized for the machine (large-v3-turbo with a GPU, small without)' : `the ${e.model} model`}, up to 4 GB in all, under ${e.home}. Nothing is installed system-wide, and nothing you say leaves ${vscode.env.remoteName ? 'your machines' : 'this machine'}.` }, 'Set Up');
      if (pick !== 'Set Up') return false;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Perch voice input', cancellable: false }, async (progress) => {
        let last = 0;
        await e.install((message, pct) => { progress.report({ message, increment: Math.max(0, pct - last) }); last = pct; });
      });
      return true;
    } catch (err) { vscode.window.showErrorMessage('Perch: voice input could not be set up. ' + err.message); return false; }
  }

  /** The same, on the computer the user sits at, done by Perch Audio. The question is asked here; the progress shows there. */
  async setupLocal(st, ask = true) {
    if (st.installed) return true;
    const e = this.engineOpts();
    if (ask) {
      const pick = await vscode.window.showInformationMessage(`Set up voice input on this computer, ${st.host}?`, { modal: true, detail: `This installs Whisper into a private Python environment on the computer you sit at, not on the remote, and fetches ${e.model === 'auto' ? 'a model sized for it (large-v3-turbo with a GPU, small without)' : `the ${e.model} model`}, up to 4 GB in all, under ${st.home}. Nothing is installed system-wide, and nothing you say leaves your machines.` }, 'Set Up');
      if (pick !== 'Set Up') return false;
    }
    const r = await this.audio('setup', e);
    if (r && r.ok) return true;
    vscode.window.showErrorMessage('Perch: voice input could not be set up on this computer. ' + ((r && r.error) || 'Perch Audio gave no answer.'));
    return false;
  }

  /** Set up wherever dictation would run, for the command. 'already' when nothing needed doing, 'ready' when set up now, false otherwise. */
  async prepare(ask = true) {
    const a = await this.audio('available');
    if (!a || !a.ok) { vscode.window.showErrorMessage('Perch: ' + ((a && a.error) || 'the microphone is not available.')); return false; }
    const w = await this.where(a);
    if (w.error) { vscode.window.showErrorMessage('Perch: ' + w.error); return false; }
    if (w.where === 'local' ? w.status.installed : this.getEngine().isInstalled()) return 'already';
    return (w.where === 'local' ? await this.setupLocal(w.status, ask) : await this.setup(ask)) ? 'ready' : false;
  }

  /** Free the model's memory, wherever it is loaded. */
  unload() { if (this.engine) this.engine.stop(); return this.audio('unload'); }

  async start(sid) {
    if (this.busy) return;
    if (this.now) { if (this.now.sid === sid && this.now.phase === 'recording') return this.stop(sid); this.send(sid, { kind: 'error', text: 'Voice input: another tab is dictating.' }); return; }
    this.busy = true;
    try {
      this.phase(sid, 'starting');
      const a = await this.audio('available');
      if (!a || !a.ok) { this.fail(sid, (a && a.error) || 'the microphone is not available.'); return; }
      if (!(a.api >= 1 && a.api <= AUDIO_API)) { this.fail(sid, 'Perch Audio is a newer version than Perch. Update Perch.'); return; }
      const w = await this.where(a);
      if (w.error) { this.fail(sid, w.error); return; }
      if (!(w.where === 'local' ? await this.setupLocal(w.status) : await this.setup())) { this.phase(sid, 'idle'); return; }
      const s = await this.audio('start');
      if (!s || !s.ok) { this.fail(sid, (s && s.error) || 'recording could not start.'); return; }
      // load the model while the user is speaking
      if (w.where === 'local') this.audio('warm', this.engineOpts()); else this.getEngine().start().catch(() => {});
      this.now = { sid, id: s.id, phase: 'recording', where: w.where, device: s.device, maxSeconds: s.maxSeconds, warned: false };
      this.phase(sid, 'recording', { level: 0, seconds: 0, device: s.device, maxSeconds: s.maxSeconds });
      this.now.timer = setInterval(() => this.tick(), TICK_MS); if (this.now.timer.unref) this.now.timer.unref();
    } finally { this.busy = false; }
  }

  async tick() {
    const n = this.now; if (!n || n.phase !== 'recording' || n.ticking) return;
    n.ticking = true;
    try {
      const l = await this.audio('level', n.id);
      if (this.now !== n || n.phase !== 'recording') return;
      if (!l || !l.ok) { await this.cancel('the recording was lost: ' + ((l && l.error) || 'no answer from Perch Audio')); return; }
      if (l.ended) { await this.stop(n.sid); return; }
      this.phase(n.sid, 'recording', { level: l.level, seconds: l.seconds, device: n.device, maxSeconds: n.maxSeconds, silent: !!l.silent });
    } finally { n.ticking = false; }
  }

  async stop(sid) {
    const n = this.now; if (!n || n.sid !== sid || n.phase !== 'recording' || this.busy) return;
    this.busy = true;
    try {
      clearInterval(n.timer); n.phase = 'transcribing';
      this.phase(sid, 'transcribing', { device: n.device, where: n.where });
      const words = { language: this.cfg('language') || null, prompt: this.cfg('vocabulary') || null };
      // local: Perch Audio stops the recording and answers with the text. remote: it answers with the audio, transcribed here.
      const r = n.where === 'local' ? await this.audio('transcribe', n.id, Object.assign({ engine: this.engineOpts() }, words)) : await this.audio('stop', n.id);
      if (!r || !r.ok) { this.fail(sid, (r && r.error) || 'the recording could not be collected.'); return; }
      if (r.silent) { this.fail(sid, `nothing was heard from "${r.device}". It may be muted, or the wrong input. Choose another with Perch Audio: Choose Microphone.`); return; }
      if (r.seconds < 0.3) { this.phase(sid, 'idle'); return; }
      let out = r;
      if (n.where !== 'local') {
        try { out = await this.getEngine().transcribe(Object.assign({ pcm: r.pcm, sampleRate: r.sampleRate }, words)); }
        catch (e) { this.fail(sid, e.message); return; }
      }
      this.phase(sid, 'idle');
      const text = String(out.text || '').trim();
      if (!text) { this.send(sid, { kind: 'note', text: 'Voice input heard no words.' }); return; }
      this.deliver(sid, text + ' ');
      if (r.ended === 'max') this.send(sid, { kind: 'note', text: `Dictation stopped at the ${n.maxSeconds} second limit. Set perchAudio.maxSeconds to change it.` });
    } finally { if (this.now === n) this.now = null; this.busy = false; }
  }

  /** Drop the recording. Nothing is transcribed. */
  async cancel(why) {
    const n = this.now; if (!n) return;
    this.now = null; clearInterval(n.timer);
    if (n.phase === 'recording') await this.audio('cancel', n.id);
    if (why) this.fail(n.sid, why); else this.phase(n.sid, 'idle');
  }
  /** A tab that is closing takes its dictation with it. */
  closed(sid) { if (this.now && this.now.sid === sid) return this.cancel(); return undefined; }

  dispose() { if (this.now) { clearInterval(this.now.timer); this.audio('cancel', this.now.id); this.now = null; } if (this.engine) this.engine.stop(); }
}

module.exports = { VoiceHost, NO_COMPANION };
