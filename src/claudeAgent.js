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
 * @param {string} [opts.resume]                      session id to resume
 * @param {string} [opts.executable]                  path to claude CLI
 */
class ClaudeAgent {
  constructor(opts) {
    this.opts = opts;
    this.emit = opts.emit;
    this.queue = new AsyncQueue();
    this.query = null;
    this.sessionId = opts.resume || null;
    this.running = false;
    this.lastAnswer = '';
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
      stderr: (d) => this.emit({ kind: 'stderr', text: String(d) }),
      canUseTool: async (toolName, input, { suggestions }) => {
        const id = randomUUID();
        this.emit({ kind: 'permission', id, tool: toolName, input, hasSuggestions: !!(suggestions && suggestions.length) });
        const ans = await this.opts.askPermission({ id, tool: toolName, input });
        if (ans.decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (ans.decision === 'always') return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions || [] };
        return { behavior: 'deny', message: ans.message || 'Denied by user in perch' };
      },
    };
    if (this.opts.model) options.model = this.opts.model;
    if (this.opts.resume) options.resume = this.opts.resume;
    if (this.opts.executable) options.pathToClaudeCodeExecutable = this.opts.executable;
    if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;

    try {
      this.query = sdk.query({ prompt: this.queue, options });
      for await (const m of this.query) this._onMessage(m);
      this.emit({ kind: 'status', text: 'session ended' });
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit({ kind: 'error', text: String(err && err.message || err) });
    } finally {
      this.running = false;
      this.emit({ kind: 'busy', busy: false });
    }
  }

  _onMessage(m) {
    if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.emit({ kind: 'session', id: m.session_id }); }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.emit({ kind: 'status', text: `ready · ${m.model || ''} · ${m.permissionMode || ''}`.replace(/ · $/, '') });
        else if (m.subtype === 'compact_boundary') this.emit({ kind: 'status', text: 'context compacted' });
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
        this.running = false;
        this.emit({ kind: 'result', ok: m.subtype === 'success', cost: m.total_cost_usd, duration_ms: m.duration_ms, turns: m.num_turns, usage: m.usage && { input: m.usage.input_tokens, cache_read: m.usage.cache_read_input_tokens, cache_write: m.usage.cache_creation_input_tokens, output: m.usage.output_tokens }, error: m.subtype !== 'success' ? (m.result || m.subtype) : undefined });
        this.emit({ kind: 'busy', busy: false });
        return;
      case 'rate_limit_event':
        if (m.rate_limit_info && m.rate_limit_info.status && m.rate_limit_info.status !== 'allowed') this.emit({ kind: 'status', text: 'rate limit: ' + m.rate_limit_info.status });
        return;
      default:
        return;
    }
  }

  send(text) {
    if (!text || !text.trim()) return;
    this.running = true;
    this.emit({ kind: 'user', text });
    this.emit({ kind: 'busy', busy: true });
    this.queue.push({ type: 'user', session_id: this.sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  async interrupt() { if (this.query && this.running) { try { await this.query.interrupt(); } catch (_) { /* older CLI */ } } }
  async setPermissionMode(mode) { if (this.query) { try { await this.query.setPermissionMode(mode); this.emit({ kind: 'status', text: 'mode: ' + mode }); } catch (err) { this.emit({ kind: 'error', text: String(err.message || err) }); } } }
  async setModel(model) { if (this.query) { try { await this.query.setModel(model || undefined); this.emit({ kind: 'status', text: 'model: ' + (model || 'default') }); } catch (err) { this.emit({ kind: 'error', text: String(err.message || err) }); } } }

  dispose() { this.queue.close(); this.abort.abort(); }
}

module.exports = { ClaudeAgent, AsyncQueue };
