'use strict';
// Codex session via the Codex SDK (wraps `codex exec`). No VS Code dependency.
// The SDK is non-interactive: approvals resolve by policy and sandbox, so there
// is no permission callback here, unlike the Claude side.

const fs = require('fs');
const { bedrockConfig, bedrockModel } = require('./codexBedrock');
const os = require('os');
const path = require('path');
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

class CodexAgent {
  /**
   * @param {object} opts
   * @param {string} opts.cwd
   * @param {(ev: object) => void} opts.emit
   * @param {string} [opts.approvalPolicy]
   * @param {string} [opts.sandboxMode]
   * @param {string} [opts.model]
   * @param {string} [opts.reasoningEffort]
   * @param {string} [opts.resume]   thread id to resume
   * @param {string} [opts.executable]  path to a codex program, in place of the one that comes with the SDK
   */
  constructor(opts) {
    this.opts = opts;
    this.emit = opts.emit;
    this.thread = null;
    this.codex = null;
    this.changed = false;            // the model, effort, or sandbox was changed since the thread last ran
    this.threadId = opts.resume || null;
    this.running = false;
    this.lastAnswer = '';
    this.turnAbort = null;
    this.imageDir = null;            // Codex takes an image as a file: pasted ones are written here, and removed with the agent
    this.imageCount = 0;
    this.ready = this._init();
  }

  async _init() {
    let sdk;
    try { sdk = await import('@openai/codex-sdk'); }
    catch (err) { this.emit({ kind: 'error', text: 'Codex SDK not installed: ' + err.message + '. Run `make deps` in /git/perch.' }); return false; }
    this.sdk = sdk;
    this.codex = this._client();
    this._thread();
    this.emit({ kind: 'status', text: 'ready' });
    return true;
  }

  /** The client: the program to run and, on the API backend, the key it runs with (CODEX_API_KEY in its environment); on
   * Bedrock, the provider and its region and profile as --config overrides (src/codexBedrock.js). */
  _client() {
    const o = {};
    if (this.opts.executable) o.codexPathOverride = this.opts.executable;
    if (this.opts.apiKey) o.apiKey = this.opts.apiKey;
    if (this.opts.bedrock) o.config = bedrockConfig(this.opts.bedrock);
    return new this.sdk.Codex(o);
  }
  /** Switch the key the next turn runs with: null means the ChatGPT login. The thread is taken up again by the new client. */
  setApiKey(key) { this.setBackend({ apiKey: key }); }
  /** Switch the backend the next turn runs on: an API key, Bedrock settings, or neither (the ChatGPT login). */
  setBackend({ apiKey, bedrock } = {}) {
    // A thread's reasoning is encrypted for the provider that made it (OpenAI's `encrypted_content`), and the other cannot
    // read it: a thread cannot cross between OpenAI and Bedrock. The next message starts a new one; the old stays on record.
    if (!!this.opts.bedrock !== !!bedrock && (this.threadId || this.thread)) this.fresh = true;
    this.opts.apiKey = apiKey || undefined;
    this.opts.bedrock = bedrock || undefined;
    if (!this.sdk) return;
    this.codex = this._client(); this.changed = true;
  }
  /** Leave the thread behind and start another with the next message: its record cannot be carried to this provider. */
  _startOver(why) {
    this.threadId = null; this.thread = null; this.changed = false; this.fresh = false; this.crossed = false;
    this.emit({ kind: 'note', text: why });
  }

  _options() {
    const topts = {
      workingDirectory: this.opts.cwd,
      skipGitRepoCheck: true,
      sandboxMode: this.opts.sandboxMode || 'workspace-write',
      approvalPolicy: this.opts.approvalPolicy || 'on-failure',
    };
    // on Bedrock the model goes by its Bedrock id, and Codex's own default (config.toml) is not one: the catalog's default slug stands in
    const model = this.opts.bedrock ? bedrockModel(this.opts.model || this.opts.bedrock.defaultModel, this.opts.bedrock.endpoint) : this.opts.model;
    if (model) topts.model = model;
    if (this.opts.reasoningEffort) topts.modelReasoningEffort = this.opts.reasoningEffort;
    return topts;
  }

  /**
   * The thread as its next turn will run it. Codex runs each turn as a process of its own, given the thread to carry
   * on and how to run: so a thread is carried on under a new model, effort, or sandbox by taking it up again with them.
   */
  _thread() {
    if (this.fresh) this._startOver(`This conversation's reasoning is encrypted for the provider that made it, and ${this.opts.bedrock ? 'Bedrock' : 'OpenAI'} cannot read it: a new thread starts with this message. The old one stays in the sessions list.`);
    if (this.thread && !this.changed) return this.thread;
    const id = this.threadId || (this.thread && this.thread.id) || null;
    this.thread = id ? this.codex.resumeThread(id, this._options()) : this.codex.startThread(this._options());
    this.changed = false;
    return this.thread;
  }

  // Each applies from the next turn; a turn that is running finishes as it began. An empty value is Codex's own default.
  setModel(model) { this.opts.model = model || undefined; this.changed = true; }
  setEffort(level) { this.opts.reasoningEffort = level || undefined; this.changed = true; }
  setSandboxMode(mode) { this.opts.sandboxMode = mode || undefined; this.changed = true; }

  /**
   * @param {string} text   what the agent receives
   * @param {{text: string, tag?: string}} [shown]  what the transcript shows, when that differs (IDE context is attached to
   *   the message but not repeated in the transcript)
   * @param {{mime: string, data: string}[]} [images]  base64
   */
  async send(text, shown, images) {
    text = String(text || '');
    const pics = Array.isArray(images) ? images : [];
    if (!text.trim() && !pics.length) return;
    if (!(await this.ready)) return;
    if (this.running) { this.emit({ kind: 'error', text: 'Codex is still working on the previous turn.' }); return; }
    this.running = true;
    this.turnAbort = new AbortController();
    this.emit(Object.assign({ kind: 'user', text: shown ? shown.text : text }, pics.length ? { images: pics.length } : {}, shown && shown.tag ? { tag: shown.tag } : {}));
    this.emit({ kind: 'busy', busy: true });
    const t0 = Date.now();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        this.crossed = false;
        try {
          const { events } = await this._thread().runStreamed(pics.length ? this._input(text, pics) : text, { signal: this.turnAbort.signal });
          for await (const e of events) this._onEvent(e, t0);
        } catch (err) {
          if (this.crossed && attempt === 0) { /* said below */ }
          else if (!(this.turnAbort && this.turnAbort.signal.aborted)) this.emit({ kind: 'error', text: String(err && err.message || err) });
          else this.emit({ kind: 'status', text: 'interrupted' });
        }
        // a thread resumed on the other provider (from the sessions list, say) is refused for its encrypted reasoning: once, start over and send again
        if (!(this.crossed && attempt === 0)) break;
        this._startOver(`This conversation was recorded on ${this.opts.bedrock ? 'OpenAI' : 'Bedrock'}, whose reasoning is encrypted for it, and ${this.opts.bedrock ? 'Bedrock' : 'OpenAI'} cannot read it: a new thread starts with this message. The old one stays in the sessions list.`);
      }
    } finally {
      this.running = false;
      this.emit({ kind: 'busy', busy: false });
    }
  }

  _onEvent(e, t0) {
    switch (e.type) {
      case 'thread.started':
        if (!this.threadId) { this.threadId = e.thread_id; this.emit({ kind: 'session', id: e.thread_id }); }
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = e.item || {};
        const final = e.type === 'item.completed';
        switch (it.type) {
          case 'agent_message':
            if (final) { this.lastAnswer = it.text || ''; this.emit({ kind: 'text', text: this.lastAnswer }); }
            return;
          case 'reasoning':
            if (final && it.text) this.emit({ kind: 'thinking', text: it.text });
            return;
          case 'command_execution':
            if (e.type === 'item.started') this.emit({ kind: 'tool_use', id: it.id, name: 'shell', input: { command: it.command } });
            if (final) this.emit({ kind: 'tool_result', id: it.id, text: (it.aggregated_output || '').slice(0, 4000), truncated: (it.aggregated_output || '').length > 4000, isError: it.status === 'failed' || (it.exit_code !== undefined && it.exit_code !== 0) });
            return;
          case 'file_change':
            if (final) this.emit({ kind: 'tool_use', id: it.id, name: 'edit', input: { changes: (it.changes || []).map((c) => `${c.kind} ${c.path}`) }, status: it.status });
            return;
          case 'mcp_tool_call':
            if (e.type === 'item.started') this.emit({ kind: 'tool_use', id: it.id, name: `${it.server}.${it.tool}`, input: it.arguments });
            if (final) this.emit({ kind: 'tool_result', id: it.id, text: it.error ? it.error.message : JSON.stringify(it.result && it.result.structured_content || it.result || '').slice(0, 4000), isError: !!it.error });
            return;
          case 'web_search':
            if (e.type === 'item.started') this.emit({ kind: 'tool_use', id: it.id, name: 'web_search', input: { query: it.query } });
            return;
          case 'todo_list':
            if (final) this.emit({ kind: 'status', text: 'plan: ' + (it.items || []).map((t) => (t.completed ? '[x] ' : '[ ] ') + t.text).join(' · ') });
            return;
          case 'error':
            this._said(it.message || 'error');
            return;
          default:
            return;
        }
      }
      case 'turn.completed': {
        const u = e.usage || {};
        this.emit({ kind: 'result', ok: true, duration_ms: Date.now() - t0, usage: { input: u.input_tokens, cache_read: u.cached_input_tokens, cache_write: u.cache_write_input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens } });
        return;
      }
      case 'turn.failed':
        if (/invalid_encrypted_content/.test(String(e.error && e.error.message))) { this.crossed = true; return; }
        this.emit({ kind: 'result', ok: false, duration_ms: Date.now() - t0, error: e.error && e.error.message });
        return;
      case 'error':
        this._said(e.message);
        return;
      default:
        return;
    }
  }

  /** Codex says that a thread is being carried on under another model as an error. It is the user's own choice: a note. */
  _said(text) {
    if (/invalid_encrypted_content/.test(String(text))) { this.crossed = true; return; }   // the thread cannot cross providers: handled in send
    this.emit({ kind: /^This session was recorded with model /.test(String(text)) ? 'note' : 'error', text: String(text) });
  }

  /** A message with images, in the form the SDK takes: the text, then each image as a file of its own. */
  _input(text, pics) {
    if (!this.imageDir) this.imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-images-'));
    const input = text.trim() ? [{ type: 'text', text }] : [];
    for (const p of pics) {
      const file = path.join(this.imageDir, String(++this.imageCount) + (EXT[p.mime] || '.png'));
      fs.writeFileSync(file, Buffer.from(p.data, 'base64'), { mode: 0o600 });
      input.push({ type: 'local_image', path: file });
    }
    return input;
  }

  async interrupt() { if (this.turnAbort && this.running) this.turnAbort.abort(); }
  dispose() {
    if (this.turnAbort) this.turnAbort.abort();
    if (this.imageDir) { try { fs.rmSync(this.imageDir, { recursive: true, force: true }); } catch (_) { /* the OS clears its temp directory */ } this.imageDir = null; }
  }
}

module.exports = { CodexAgent };
