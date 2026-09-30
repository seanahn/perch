'use strict';
// Dictation. Recording happens on the machine the user is sitting at, in the Perch Audio extension; speech-to-text
// happens here, with the workspace. Under Remote-SSH those are two machines, and audio crosses between them as a
// command's return value, over VS Code's own connection.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { VoiceEngine } = require('./voice');

const TICK_MS = 120;
const AUDIO_API = 1;
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

  /** One engine per combination of settings; changing the model or device replaces it. */
  getEngine() {
    const o = { model: this.cfg('model') || 'large-v3-turbo', device: this.cfg('device') || 'auto', python: this.cfg('python') || undefined, idleMs: Math.max(0, Number(this.cfg('idleMinutes') === undefined || this.cfg('idleMinutes') === '' ? 10 : this.cfg('idleMinutes')) || 0) * 60000 };
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

  /** The one-time setup, with the user's agreement. It says which machine it installs on, which matters when remote. */
  async setup(ask = true) {
    const e = this.getEngine();
    if (e.isInstalled()) return true;
    const where = vscode.env.remoteName ? `${os.hostname()}, the remote machine` : 'this machine';
    if (ask) {
      const pick = await vscode.window.showInformationMessage(`Set up voice input on ${where}?`, { modal: true, detail: `This installs Whisper into a private Python environment and fetches the ${e.model} model, about 4 GB in all, under ${e.home}. Nothing is installed system-wide, and nothing you say leaves ${vscode.env.remoteName ? 'your machines' : 'this machine'}.` }, 'Set Up');
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

  async start(sid) {
    if (this.busy) return;
    if (this.now) { if (this.now.sid === sid && this.now.phase === 'recording') return this.stop(sid); this.send(sid, { kind: 'error', text: 'Voice input: another tab is dictating.' }); return; }
    this.busy = true;
    try {
      this.phase(sid, 'starting');
      const a = await this.audio('available');
      if (!a || !a.ok) { this.fail(sid, (a && a.error) || 'the microphone is not available.'); return; }
      if (a.api !== AUDIO_API) { this.fail(sid, 'Perch Audio is a different version from Perch. Update both.'); return; }
      if (!(await this.setup())) { this.phase(sid, 'idle'); return; }
      const s = await this.audio('start');
      if (!s || !s.ok) { this.fail(sid, (s && s.error) || 'recording could not start.'); return; }
      this.getEngine().start().catch(() => {});          // load the model while the user is speaking
      this.now = { sid, id: s.id, phase: 'recording', device: s.device, maxSeconds: s.maxSeconds, warned: false };
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
      this.phase(sid, 'transcribing', { device: n.device });
      const r = await this.audio('stop', n.id);
      if (!r || !r.ok) { this.fail(sid, (r && r.error) || 'the recording could not be collected.'); return; }
      if (r.silent) { this.fail(sid, `nothing was heard from "${r.device}". It may be muted, or the wrong input. Choose another with Perch Audio: Choose Microphone.`); return; }
      if (r.seconds < 0.3) { this.phase(sid, 'idle'); return; }
      let out;
      try { out = await this.getEngine().transcribe({ pcm: r.pcm, sampleRate: r.sampleRate, language: this.cfg('language') || null, prompt: this.cfg('vocabulary') || null }); }
      catch (e) { this.fail(sid, e.message); return; }
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
