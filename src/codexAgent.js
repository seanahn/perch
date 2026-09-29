'use strict';
// Codex session via the Codex SDK (wraps `codex exec`). No VS Code dependency.
// The SDK is non-interactive: approvals resolve by policy and sandbox, so there
// is no permission callback here, unlike the Claude side.

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
   */
  constructor(opts) {
    this.opts = opts;
    this.emit = opts.emit;
    this.thread = null;
    this.threadId = opts.resume || null;
    this.running = false;
    this.lastAnswer = '';
    this.turnAbort = null;
    this.ready = this._init();
  }

  async _init() {
    let sdk;
    try { sdk = await import('@openai/codex-sdk'); }
    catch (err) { this.emit({ kind: 'error', text: 'Codex SDK not installed: ' + err.message + '. Run `make deps` in /git/perch.' }); return false; }
    const codex = new sdk.Codex();
    const topts = {
      workingDirectory: this.opts.cwd,
      skipGitRepoCheck: true,
      sandboxMode: this.opts.sandboxMode || 'workspace-write',
      approvalPolicy: this.opts.approvalPolicy || 'on-failure',
    };
    if (this.opts.model) topts.model = this.opts.model;
    if (this.opts.reasoningEffort) topts.modelReasoningEffort = this.opts.reasoningEffort;
    this.thread = this.threadId ? codex.resumeThread(this.threadId, topts) : codex.startThread(topts);
    this.emit({ kind: 'status', text: 'ready' });
    return true;
  }

  /**
   * @param {string} text   what the agent receives
   * @param {{text: string, tag?: string}} [shown]  what the transcript shows, when that differs (IDE context is attached to
   *   the message but not repeated in the transcript)
   */
  async send(text, shown) {
    if (!text || !text.trim()) return;
    if (!(await this.ready)) return;
    if (this.running) { this.emit({ kind: 'error', text: 'Codex is still working on the previous turn.' }); return; }
    this.running = true;
    this.turnAbort = new AbortController();
    this.emit(Object.assign({ kind: 'user', text: shown ? shown.text : text }, shown && shown.tag ? { tag: shown.tag } : {}));
    this.emit({ kind: 'busy', busy: true });
    const t0 = Date.now();
    try {
      const { events } = await this.thread.runStreamed(text, { signal: this.turnAbort.signal });
      for await (const e of events) this._onEvent(e, t0);
    } catch (err) {
      if (!(this.turnAbort && this.turnAbort.signal.aborted)) this.emit({ kind: 'error', text: String(err && err.message || err) });
      else this.emit({ kind: 'status', text: 'interrupted' });
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
            this.emit({ kind: 'error', text: it.message || 'error' });
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
        this.emit({ kind: 'result', ok: false, duration_ms: Date.now() - t0, error: e.error && e.error.message });
        return;
      case 'error':
        this.emit({ kind: 'error', text: e.message });
        return;
      default:
        return;
    }
  }

  async interrupt() { if (this.turnAbort && this.running) this.turnAbort.abort(); }
  dispose() { if (this.turnAbort) this.turnAbort.abort(); }
}

module.exports = { CodexAgent };
