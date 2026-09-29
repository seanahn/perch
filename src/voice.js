'use strict';
// The speech-to-text engine: a private Python environment, a model, and a long-lived server process (voice/server.py).
// No VS Code dependency. Everything is kept under one directory in the user's home, never in the system Python.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const DEFAULT_HOME = path.join(os.homedir(), '.local', 'share', 'perch', 'voice');
const START_TIMEOUT_MS = 10 * 60000;     // the first start may download the model
const REQUEST_TIMEOUT_MS = 5 * 60000;

class VoiceEngine {
  /**
   * @param {object} o
   * @param {string} o.server         path to voice/server.py
   * @param {string} o.requirements   path to voice/requirements.txt
   * @param {string} [o.home]         where the environment and models live
   * @param {string} [o.model]        a faster-whisper model name
   * @param {'auto'|'cuda'|'cpu'} [o.device]
   * @param {number} [o.idleMs]       stop the server, freeing its memory, after this long unused; 0 keeps it
   * @param {string} [o.python]       the interpreter used to create the environment
   * @param {Function} [o.spawn]      child_process.spawn, replaced in tests
   */
  constructor(o) {
    this.server = o.server; this.requirements = o.requirements;
    this.home = o.home || DEFAULT_HOME;
    this.model = o.model || 'large-v3-turbo';
    this.device = o.device || 'auto';
    this.idleMs = o.idleMs === undefined ? 10 * 60000 : Math.max(0, Number(o.idleMs) || 0);
    this.python = o.python || (process.platform === 'win32' ? 'python' : 'python3');
    this.spawn = o.spawn || cp.spawn;
    this.proc = null; this.ready = null; this.info = null;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.stderr = ''; this.idleTimer = null;
  }

  get venv() { return path.join(this.home, 'venv'); }
  get venvPython() { return process.platform === 'win32' ? path.join(this.venv, 'Scripts', 'python.exe') : path.join(this.venv, 'bin', 'python'); }
  get modelsDir() { return path.join(this.home, 'models'); }
  get markerPath() { return path.join(this.home, 'installed.json'); }

  requirementsHash() { try { return crypto.createHash('sha256').update(fs.readFileSync(this.requirements)).digest('hex').slice(0, 16); } catch (_) { return ''; } }
  marker() { try { return JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) || {}; } catch (_) { return {}; } }

  /** Installed means: the environment exists, it was built from the current requirements, and this model has been fetched. */
  isInstalled() {
    const m = this.marker();
    return fs.existsSync(this.venvPython) && !!m.requirements && m.requirements === this.requirementsHash() && Array.isArray(m.models) && m.models.includes(this.model);
  }
  status() { return { installed: this.isInstalled(), running: !!this.proc, model: this.model, device: this.info ? this.info.device : null, home: this.home }; }

  run(cmd, args, onLine) {
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      let p;
      try { p = this.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' }) }); }
      catch (e) { reject(new Error(`could not run ${cmd}: ${e.message}`)); return; }
      p.stdout.on('data', (d) => { out += d; if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim()); });
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${cmd} was not found. Install Python 3.9 or newer, or set perch.voice.python.` : `could not run ${cmd}: ${e.message}`)));
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`).slice(0, 600)))));
    });
  }

  /** One-time setup. Safe to run again: each step is skipped or is quick when its work is already done. */
  async install(onStep = () => {}) {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    if (!fs.existsSync(this.venvPython)) { onStep('Creating a private Python environment', 5); await this.run(this.python, ['-m', 'venv', this.venv]); }
    onStep('Installing the speech-to-text runtime', 15);
    await this.run(this.venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
    await this.run(this.venvPython, ['-m', 'pip', 'install', '--quiet', '-r', this.requirements]);
    onStep(`Fetching the ${this.model} model and checking it runs`, 60);
    let ready = null;
    await this.run(this.venvPython, [this.server, '--model', this.model, '--device', this.device, '--models-dir', this.modelsDir, '--download-only'], (line) => { try { const j = JSON.parse(line); if ('ready' in j) ready = j; } catch (_) { /* a log line */ } });
    if (!ready || !ready.ready) throw new Error('the model could not be loaded: ' + ((ready && ready.error) || 'no answer from the server'));
    const m = this.marker();
    const models = Array.isArray(m.models) && m.requirements === this.requirementsHash() ? m.models : [];
    fs.writeFileSync(this.markerPath, JSON.stringify({ requirements: this.requirementsHash(), models: [...new Set([...models, this.model])], device: ready.device, at: new Date().toISOString() }, null, 2) + '\n');
    onStep('Ready', 100);
    return ready;
  }

  /** Start the server if it is not running. Resolves with what it reports: the device it runs on, and the model. */
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } this._gone(e); };
      let p;
      try { p = this.spawn(this.venvPython, [this.server, '--model', this.model, '--device', this.device, '--models-dir', this.modelsDir], { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }) }); }
      catch (e) { fail(new Error('could not start the speech-to-text server: ' + e.message)); return; }
      this.proc = p; this.buffer = ''; this.stderr = '';
      const timer = setTimeout(() => fail(new Error('the speech-to-text server did not start in time')), START_TIMEOUT_MS); if (timer.unref) timer.unref();
      p.stdout.on('data', (d) => {
        this.buffer += d;
        let i;
        while ((i = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch (_) { continue; }
          if ('ready' in j) { clearTimeout(timer); if (j.ready) { this.info = j; settled = true; this._touch(); resolve(j); } else fail(new Error('the speech-to-text server could not load the model: ' + j.error)); continue; }
          const w = this.pending.get(j.id);
          if (w) { this.pending.delete(j.id); clearTimeout(w.timer); if (j.ok) w.resolve(j); else w.reject(new Error(j.error || 'transcription failed')); }
        }
      });
      p.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
      p.on('error', (e) => { clearTimeout(timer); if (this.proc !== p && this.proc !== null) return; fail(new Error(e.code === 'ENOENT' ? 'voice input is not set up on this machine' : e.message)); });
      p.on('close', (code) => { clearTimeout(timer); if (this.proc !== p) return; fail(new Error('the speech-to-text server stopped' + (code ? ` (exit ${code})` : '') + (this.stderr.trim() ? ': ' + this.stderr.trim().split('\n').pop().slice(0, 300) : ''))); });
    });
    this.ready.catch(() => {});      // a failed start is reported to whoever asked; it must not also be an unhandled rejection
    return this.ready;
  }

  /** Forget the server and fail whatever was waiting on it. It is killed too, unless it has been asked to leave by itself. */
  _gone(err, leaving) {
    if (this.proc && !leaving) { try { this.proc.kill(); } catch (_) { /* already gone */ } }
    this.proc = null; this.ready = null; this.info = null;
    clearTimeout(this.idleTimer);
    for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(err); }
    this.pending.clear();
  }
  _touch() {
    clearTimeout(this.idleTimer);
    if (!this.idleMs) return;
    this.idleTimer = setTimeout(() => { if (!this.pending.size) this.stop(); else this._touch(); }, this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  /**
   * @param {object} a  { pcm: base64 of 16-bit mono PCM, sampleRate, language?, prompt? }
   * @returns {Promise<{text: string, language: string, seconds: number, took_ms: number}>}
   */
  async transcribe(a) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('transcription took too long')); }, REQUEST_TIMEOUT_MS); if (timer.unref) timer.unref();
      this.pending.set(id, { resolve: (j) => { this._touch(); resolve({ text: j.text || '', language: j.language || '', seconds: j.seconds || 0, took_ms: j.took_ms || 0, device: this.info ? this.info.device : '' }); }, reject, timer });
      try { this.proc.stdin.write(JSON.stringify({ id, op: 'transcribe', pcm: a.pcm, sample_rate: a.sampleRate || 16000, language: a.language || null, prompt: a.prompt || null }) + '\n'); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(new Error('the speech-to-text server is not accepting audio: ' + e.message)); }
    });
  }

  /** Stop the server and free its memory. The next dictation starts it again. */
  stop() {
    const p = this.proc; if (!p) return;
    try { p.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); p.stdin.end(); } catch (_) { /* pipe closed */ }
    // asked first, so it can finish cleanly; forced only if it has not gone after a few seconds
    const t = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 3000); if (t.unref) t.unref();
    p.once('close', () => clearTimeout(t));
    this._gone(new Error('the speech-to-text server was stopped'), true);
  }
}

module.exports = { VoiceEngine, DEFAULT_HOME };
