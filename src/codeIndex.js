'use strict';
// Codebase search for Perch's tabs (docs/notes/201-codebase-indexing.md): the MCP server in codeindex/, the Python it
// runs on, and the private environment that adds search by meaning. No VS Code dependency.
//
// Keyword search needs only Python's standard library, so the server runs on the machine's own python3 from the start.
// Search by meaning needs fastembed and a model, installed once into a private environment the way dictation's is
// (src/voice.js); from then on the server runs on that environment's Python. Everything stays under one directory in
// the user's home, never in the system Python, and the index itself under ~/.cache/codebase-index/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { fetchText } = require('./voice');

const DEFAULT_HOME = path.join(os.homedir(), '.local', 'share', 'perch', 'codeindex');
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
// what the server needs of the Python it runs on: 3.8 or newer, and SQLite built with FTS5
const PROBE = "import sys, sqlite3; assert sys.version_info >= (3, 8); sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(x)')";

class CodeIndex {
  /**
   * @param {object} o
   * @param {string} o.root          the extension's directory, which holds codeindex/
   * @param {string} [o.home]        where the private environment and the model live
   * @param {string} [o.python]      the interpreter to run the server on, and to make the environment with
   * @param {Function} [o.spawn]     child_process.spawn, replaced in tests
   * @param {Function} [o.fetch]     a text download, replaced in tests
   */
  constructor(o) {
    this.root = o.root;
    this.home = o.home || DEFAULT_HOME;
    this.python = o.python || (process.platform === 'win32' ? 'python' : 'python3');
    this.spawn = o.spawn || cp.spawn;
    this.fetch = o.fetch || fetchText;
    this.usable = null;              // whether this.python can run the server: asked once (probe)
    this.installing = null;
  }

  get server() { return path.join(this.root, 'codeindex', 'server.py'); }
  get requirements() { return path.join(this.root, 'codeindex', 'requirements.txt'); }
  get venv() { return path.join(this.home, 'venv'); }
  get venvPython() { return process.platform === 'win32' ? path.join(this.venv, 'Scripts', 'python.exe') : path.join(this.venv, 'bin', 'python'); }
  get modelsDir() { return path.join(this.home, 'models'); }
  get markerPath() { return path.join(this.home, 'installed.json'); }

  requirementsHash() { try { return crypto.createHash('sha256').update(fs.readFileSync(this.requirements)).digest('hex').slice(0, 16); } catch (_) { return ''; } }
  marker() { try { return JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) || {}; } catch (_) { return {}; } }
  /** Search by meaning is installed: the environment exists, from the current requirements, and its model loaded. */
  isInstalled() { const m = this.marker(); return fs.existsSync(this.venvPython) && !!m.ready && m.requirements === this.requirementsHash(); }

  run(cmd, args, onLine, env) {
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      let p;
      try { p = this.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' }, env || {}) }); }
      catch (e) { reject(new Error(`could not run ${cmd}: ${e.message}`)); return; }
      p.stdout.on('data', (d) => { out += d; if (onLine) for (const l of String(d).split('\n')) if (l.trim()) onLine(l.trim()); });
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${cmd} was not found` : `could not run ${cmd}: ${e.message}`)));
      // what failed, in the command's last words: on stderr, or on stdout when stderr stayed empty (Ubuntu's venv tells of
      // the missing ensurepip there); the whole of both on the error, for a caller that looks for a particular word
      p.on('close', (code) => {
        if (code === 0) { resolve(out); return; }
        const last = (s) => s.split('\n').filter((l) => l.trim()).slice(-3).join(' ').trim();
        const e = new Error((last(err) || last(out) || `${cmd} exited with ${code}`).slice(0, 600));
        e.output = (err + '\n' + out).slice(-4000);
        reject(e);
      });
    });
  }

  /** Whether the machine's Python can run the server (3.8 or newer, SQLite with FTS5). Asked once; false means no tool. */
  async probe() {
    if (this.usable === null) this.usable = this.run(this.python, ['-c', PROBE]).then(() => true, () => false);
    return this.usable;
  }

  /**
   * The MCP server for a tab's process, as both SDKs take one: the program and its arguments. On the private
   * environment's Python once search by meaning is installed, else on the machine's, for keyword search.
   * @param {string|string[]} roots  the workspace's folders: the trees the server searches, an index each
   */
  mcpServer(roots) {
    const list = Array.isArray(roots) ? roots : [roots];
    const installed = this.isInstalled();
    // where the private environment is: a server started before it was installed moves onto it by itself (server.py, upgrade)
    const env = { CODEINDEX_MODELS: this.modelsDir, CODEINDEX_PYTHON: this.venvPython, CODEINDEX_MARKER: this.markerPath };
    return { command: installed ? this.venvPython : this.python, args: [this.server, ...list], env };
  }

  /**
   * What the indexes of these folders hold, from their files, for the panel the footer opens: the server's --status, on
   * the Python the server runs on, so whether search by meaning is there is told right. No build is started.
   * @returns {Promise<{ meaning: boolean, folders: object[] }>}
   */
  async status(roots) {
    const list = Array.isArray(roots) ? roots : [roots];
    const out = await this.run(this.isInstalled() ? this.venvPython : this.python, [this.server, '--status', ...list], null, { CODEINDEX_MODELS: this.modelsDir });
    return JSON.parse(String(out).trim().split('\n').pop());
  }

  hasPip() { return this.run(this.venvPython, ['-c', 'import pip']).then(() => true, () => false); }

  /** An environment made without pip: ensurepip first, then pip's own installer from PyPI's bootstrap site. */
  async bootstrapPip() {
    try { await this.run(this.venvPython, ['-m', 'ensurepip', '--upgrade']); return; } catch (_) { /* no ensurepip on this Python */ }
    const script = path.join(this.home, 'get-pip.py');
    try {
      fs.writeFileSync(script, await this.fetch(GET_PIP_URL));
      await this.run(this.venvPython, [script, '--quiet']);
    } catch (e) {
      throw new Error(`pip could not be installed into the codebase search environment (${e.message}). Install python3-venv, or set perch.codebaseIndex.python to a Python that has pip.`);
    } finally { try { fs.unlinkSync(script); } catch (_) { /* never written */ } }
  }

  /** Install search by meaning, once: the environment, fastembed, the model. Safe to run again; one run at a time. */
  install(onStep = () => {}) {
    if (!this.installing) this.installing = this._install(onStep).finally(() => { this.installing = null; });
    return this.installing;
  }
  async _install(onStep) {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    if (!fs.existsSync(this.venvPython)) {
      onStep('Creating a private Python environment', 5);
      // Debian and Ubuntu ship python3 without ensurepip until python3-venv is installed: venv then lays the
      // environment out and exits 1, saying so on stdout (Ubuntu) or stderr (Debian). Take it without pip; pip is brought in below.
      try { await this.run(this.python, ['-m', 'venv', this.venv]); }
      catch (e) { if (!/ensurepip|python3[.0-9]*-venv/.test(e.output || e.message)) throw e; await this.run(this.python, ['-m', 'venv', '--without-pip', this.venv]); }
    }
    onStep('Installing the embedding runtime', 15);
    if (!(await this.hasPip())) await this.bootstrapPip();
    await this.run(this.venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
    await this.run(this.venvPython, ['-m', 'pip', 'install', '--quiet', '-r', this.requirements]);
    onStep('Fetching the model and checking it runs', 70);
    let ready = null;
    try {
      await this.run(this.venvPython, [this.server, '--download-only'], (line) => { try { const j = JSON.parse(line); if ('ready' in j) ready = j; } catch (_) { /* a log line */ } }, { CODEINDEX_MODELS: this.modelsDir });
    } catch (e) { if (!ready) throw e; }
    if (!ready || !ready.ready) throw new Error('the model could not be loaded: ' + ((ready && ready.error) || 'no answer'));
    fs.writeFileSync(this.markerPath, JSON.stringify({ requirements: this.requirementsHash(), ready: true, model: ready.model, at: new Date().toISOString() }, null, 2) + '\n');
    onStep('Ready', 100);
    return ready;
  }
}

module.exports = { CodeIndex, DEFAULT_HOME, PROBE };
