'use strict';
// Claude Code session via the Agent SDK. No VS Code dependency: the host passes
// callbacks. Streaming-input mode keeps one CLI process per session so every
// turn shares the same prompt cache and context.

const { randomUUID } = require('crypto');

class AsyncQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) { if (this.closed) return; const w = this.waiters.shift(); if (w) w({ value: item, done: false }); else this.items.push(item); }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {(ev: object) => void} opts.emit            normalized events for the UI
 * @param {(req: object) => Promise<object>} opts.askPermission  resolves to {decision:'allow'|'always'|'deny', message?}
 * @param {string} [opts.permissionMode]
 * @param {string} [opts.model]
 * @param {string} [opts.effort]                      low | medium | high | xhigh | max; empty uses the model default
 * @param {string} [opts.resume]                      session id to resume
 * @param {string} [opts.executable]                  path to claude CLI
 * @param {number} [opts.costBefore]                   the session's cost so far, as last reported, so the first turn's own cost is known
 */
class ClaudeAgent {
  constructor(opts) {
    this.opts = opts;
    this.emit = opts.emit;
    this.queue = new AsyncQueue();
    this.query = null;
    this.sessionId = opts.resume || null;
    this.running = false;
    this.pending = 0;                // messages sent and not yet answered
    this.lastAnswer = '';
    this.lastCost = typeof opts.costBefore === 'number' ? opts.costBefore : null;   // Claude Code reports the session's whole cost; a turn's is the difference
    this.live = '';          // streamed text for the in-flight assistant message
    this.abort = new AbortController();
    this.done = this._run();
  }

  async _run() {
    let sdk;
    try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
    catch (err) { this.emit({ kind: 'error', text: 'Claude Agent SDK not installed: ' + err.message + '. Run `make deps` in /git/perch.' }); return; }

    const options = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode || 'default',
      includePartialMessages: true,
      abortController: this.abort,
      // Claude Code's word on whether a turn is running (session_state_changed, read by _state) is only sent to a host
      // that asks for it. Without the flag the SDK has the CLI send it marked host-only, and swallows it.
      env: Object.assign({}, process.env, { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }),
      stderr: (d) => this.emit({ kind: 'stderr', text: String(d) }),
      canUseTool: async (toolName, input, { suggestions }) => {
        const id = randomUUID();
        // A question for the user is a tool call: the answers go back as part of its input
        if (toolName === 'AskUserQuestion' && input && Array.isArray(input.questions)) {
          this.emit({ kind: 'question', id, questions: input.questions });
          const ans = await this.opts.askPermission({ id, tool: toolName, input });
          if (ans.decision === 'answer' && ans.answers) return { behavior: 'allow', updatedInput: Object.assign({}, input, { answers: ans.answers }) };
          return { behavior: 'deny', message: ans.message || 'The user did not answer.' };
        }
        this.emit({ kind: 'permission', id, tool: toolName, input, hasSuggestions: !!(suggestions && suggestions.length) });
        const ans = await this.opts.askPermission({ id, tool: toolName, input });
        if (ans.decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (ans.decision === 'always') return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions || [] };
        return { behavior: 'deny', message: ans.message || 'Denied by user in perch' };
      },
    };
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.effort) options.effort = this.opts.effort;
    if (this.opts.resume) options.resume = this.opts.resume;
    if (this.opts.executable) options.pathToClaudeCodeExecutable = this.opts.executable;
    if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

    this.emit({ kind: 'status', text: 'ready' });
    try {
      this.query = sdk.query({ prompt: this.queue, options });
      this._commands(); this._context();
      for await (const m of this.query) this._onMessage(m);
      this.emit({ kind: 'status', text: 'session ended' });
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit({ kind: 'error', text: String(err && err.message || err) });
    } finally {
      this.running = false; this.pending = 0;
      this.emit({ kind: 'busy', busy: false });
    }
  }

  /**
   * Claude Code's own word on whether a turn is running. It is authoritative: the count of results below is not, because
   * two messages sent during a turn can be taken up together and answered with one result, which would leave a tab
   * shown as working for good.
   */
  _state(state) {
    this.stated = (this.stated || 0) + 1;    // how many times the CLI has said; the live test checks the signal arrives at all
    if (state === 'idle') { if (this.running || this.pending) { this.running = false; this.pending = 0; this.emit({ kind: 'busy', busy: false }); } }
    else if (state === 'running' && !this.running) { this.running = true; this.pending = Math.max(1, this.pending); this.emit({ kind: 'busy', busy: true }); }
  }

  /** How full the context window is. Asked after every turn; a failure just leaves the last figure in place. */
  async _context() {
    if (!this.query || typeof this.query.getContextUsage !== 'function') return;
    try { const u = await this.query.getContextUsage(); if (u && typeof u.percentage === 'number') this.emit({ kind: 'context', percent: u.percentage, used: u.totalTokens, max: u.maxTokens, model: u.model }); } catch (_) { /* older CLI */ }
  }
  async _commands() {
    if (!this.query || typeof this.query.supportedCommands !== 'function') return;
    try { this.emit({ kind: 'commands', list: await this.query.supportedCommands() }); } catch (_) { /* older CLI */ }
  }

  _onMessage(m) {
    if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.emit({ kind: 'session', id: m.session_id }); }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') { if (m.model) this.emit({ kind: 'model', id: m.model }); }   // the model actually in use, for the tab's tooltip
        else if (m.subtype === 'compact_boundary') this.emit({ kind: 'status', text: 'context compacted' });
        else if (m.subtype === 'session_state_changed') this._state(m.state);
        return;
      case 'stream_event': {
        const ev = m.event || {};
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { this.live += ev.delta.text; this.emit({ kind: 'delta', text: ev.delta.text }); }
        else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') this.emit({ kind: 'tool_start', name: ev.content_block.name });
        return;
      }
      case 'assistant': {
        const blocks = (m.message && m.message.content) || [];
        const texts = [];
        for (const b of blocks) {
          if (b.type === 'text') texts.push(b.text);
          else if (b.type === 'tool_use') this.emit({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
          else if (b.type === 'thinking') this.emit({ kind: 'thinking', text: b.thinking || '' });
        }
        if (texts.length) { this.lastAnswer = texts.join('\n'); this.emit({ kind: 'text', text: this.lastAnswer }); }
        this.live = '';
        return;
      }
      case 'user': {
        const blocks = (m.message && Array.isArray(m.message.content)) ? m.message.content : [];
        for (const b of blocks) if (b.type === 'tool_result') {
          const c = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content || '');
          this.emit({ kind: 'tool_result', id: b.tool_use_id, text: c.slice(0, 4000), truncated: c.length > 4000, isError: !!b.is_error });
        }
        return;
      }
      case 'result':
        this.running = this.pending > 1;                 // queued messages run next, without going idle
        this.pending = Math.max(0, this.pending - 1);
        this.emit({ kind: 'responded', at: Date.now() });   // the prompt cache is warm from now
        this._context();
        const cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined;
        const costTurn = cost !== undefined && this.lastCost !== null ? Math.max(0, cost - this.lastCost) : undefined;
        if (cost !== undefined) this.lastCost = cost;
        this.emit({ kind: 'result', ok: m.subtype === 'success', cost, costTurn, duration_ms: m.duration_ms, turns: m.num_turns, usage: m.usage && { input: m.usage.input_tokens, cache_read: m.usage.cache_read_input_tokens, cache_write: m.usage.cache_creation_input_tokens, output: m.usage.output_tokens }, error: m.subtype !== 'success' ? (m.result || m.subtype) : undefined });
        if (!this.running) this.emit({ kind: 'busy', busy: false });
        return;
      case 'system_commands': return;
      case 'rate_limit_event':
        if (m.rate_limit_info && m.rate_limit_info.status && m.rate_limit_info.status !== 'allowed') this.emit({ kind: 'status', text: 'rate limit: ' + m.rate_limit_info.status });
        return;
      default:
        return;
    }
  }

  /**
   * While a turn is running, a message is queued: Claude Code takes it up as soon as the current turn ends.
   * @param {string} text
   * @param {{mime: string, data: string}[]} [images]  base64, placed before the text, where the model reads them best
   * @param {{text: string, tag?: string}} [shown]  what the transcript shows, when that differs (IDE context is attached to
   *   the message but not repeated in the transcript)
   */
  send(text, images, shown) {
    text = String(text || '');
    const pics = Array.isArray(images) ? images : [];
    if (!text.trim() && !pics.length) return;
    const queued = this.running;
    this.pending++;
    this.running = true;
    this.emit(Object.assign({ kind: 'user', text: shown ? shown.text : text, queued }, pics.length ? { images: pics.length } : {}, shown && shown.tag ? { tag: shown.tag } : {}));
    this.emit({ kind: 'busy', busy: true });
    const content = pics.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
    if (text.trim()) content.push({ type: 'text', text });
    this.queue.push({ type: 'user', session_id: this.sessionId || '', parent_tool_use_id: null, priority: queued ? 'next' : undefined, message: { role: 'user', content } });
  }

  /** Stops the current turn. Messages already queued are dropped with it, so nothing runs that the user did not see start. */
  async interrupt() { if (this.query && this.running) { try { await this.query.interrupt(); } catch (_) { /* older CLI */ } } }
  // The selectors in the panel already show mode, effort, and model, so a successful change is silent.
  async setPermissionMode(mode) { if (this.query) { try { await this.query.setPermissionMode(mode); } catch (err) { this.emit({ kind: 'error', text: 'could not set mode: ' + String(err.message || err) }); } } }
  /** Live, session-scoped: the same layer /effort uses. An empty value returns to the model's default. */
  async setEffort(level) { if (this.query) { try { await this.query.applyFlagSettings({ effortLevel: level || null }); } catch (err) { this.emit({ kind: 'error', text: 'could not set effort: ' + String(err.message || err) }); } } }
  /** Live: applies from the next request. An empty value returns to Claude Code's default model. */
  async setModel(model) { if (this.query) { try { await this.query.setModel(model || undefined); } catch (err) { this.emit({ kind: 'error', text: 'could not set model: ' + String(err.message || err) }); } } }

  dispose() { this.queue.close(); this.abort.abort(); }
}

module.exports = { ClaudeAgent, AsyncQueue };
