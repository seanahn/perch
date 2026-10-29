'use strict';
// Claude Code session via the Agent SDK. No VS Code dependency: the host passes
// callbacks. Streaming-input mode keeps one CLI process per session so every
// turn shares the same prompt cache and context.

const { randomUUID } = require('crypto');
const { Relay } = require('./relay');
const { gatewaySettings, offGatewaySettings, ownBackendSettings } = require('./gateway');

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
 * @param {Record<string,string>} [opts.env]           variables added to the process's environment: a gateway's ANTHROPIC_BASE_URL and token
 * @param {{target: string}} [opts.gateway]            run the process through a relay to this base URL, so each response's model is seen (events of kind `relay`)
 * @param {{bedrock: boolean}} [opts.backend]           a backend of this tab's own (API / Bedrock, or the subscription), as the process's settings, whatever the window's file says
 * @param {{command: string, args: string[], env?: object}} [opts.search]  the codebase search MCP server (src/codeIndex.js)
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
    this.waiting = [];               // the uuids of queued messages Claude Code has not yet taken up, oldest first
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

    // Claude Code's word on whether a turn is running (session_state_changed, read by _state) is only sent to a host
    // that asks for it. Without the flag the SDK has the CLI send it marked host-only, and swallows it.
    const env = Object.assign({}, process.env, this.opts.env || {}, { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' });
    if (this.opts.gateway) {
      // through the relay, which forwards to the gateway and reads which model each response came from
      try { this.relay = new Relay({ target: this.opts.gateway.target, onCall: (c) => this.emit(Object.assign({ kind: 'relay' }, c)) }); await this.relay.start(); env.ANTHROPIC_BASE_URL = this.relay.url(); }
      catch (err) { this.emit({ kind: 'error', text: 'the gateway relay could not start: ' + String(err && err.message || err) }); this.emit({ kind: 'busy', busy: false }); return; }
    }
    const options = {
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode || 'default',
      includePartialMessages: true,
      abortController: this.abort,
      env,
      // Settings are applied over ~/.claude/settings.json, so they decide the backend whatever the machine pins there.
      // Gateway: this process's own gateway variables. Otherwise (subscription / API / Bedrock): clear a pinned gateway
      // so the tab is truly on the chosen backend, not the gateway the machine sets for every Claude Code.
      ...(this.opts.gateway ? { settings: gatewaySettings(this.opts.env, env.ANTHROPIC_BASE_URL) }
        : this.opts.offGateway ? { settings: offGatewaySettings(this.opts.offGateway.bedrock) }
        : this.opts.backend ? { settings: ownBackendSettings(this.opts.backend.bedrock) } : {}),
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
    // codebase search (codeindex/server.py, docs/notes/201): a tool the agent calls, never retrieval into the prompt.
    // Always loaded, so it is in the first request's tool list and stays there: the prefix the cache keeps does not move.
    if (this.opts.search) {
      options.mcpServers = { codebase: Object.assign({ type: 'stdio' }, this.opts.search, { alwaysLoad: true }) };
      options.allowedTools = ['mcp__codebase__codebase_search', 'mcp__codebase__codebase_status'];   // read-only: no permission card per search
    }
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
      this.running = false; this.pending = 0; this._settle();
      if (this.relay) { this.relay.stop(); this.relay = null; }
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
    if (state === 'idle') { this._settle(); if (this.running || this.pending) { this.running = false; this.pending = 0; this.emit({ kind: 'busy', busy: false }); } }
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

  /**
   * Claude Code says which queued messages a turn has taken up: the client uuids it was given, on the turn's first stream
   * event and first assistant message (`user_message_uuids`, and `user_message_uuid` for the last of them). Each is no longer
   * queued from then: it can no longer be removed, and its bubble is an ordinary one.
   */
  _taken(m) {
    if (!this.waiting.length || !m) return;
    const ids = new Set([].concat(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [], typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : []));
    if (!ids.size) return;
    this.waiting = this.waiting.filter((q) => { if (!ids.has(q)) return true; this.emit({ kind: 'dequeued', qid: q }); return false; });
  }
  /** Nothing is queued any more (the session is idle, or its process ended): any bubble still marked queued is not. */
  _settle() { for (const q of this.waiting.splice(0)) this.emit({ kind: 'dequeued', qid: q }); }

  /**
   * A response of the main conversation, by the model that gave it, as the API named it (`message.model`): the turn's
   * result lists them, so a turn answered by another model than the one chosen can say so. A response comes as one frame
   * per block, all with its id. A frame can replace frames a refusal fallback took back (`supersedes`); Claude Code's own
   * messages ('<synthetic>') are no model's.
   */
  _answered(m) {
    for (const u of Array.isArray(m.supersedes) ? m.supersedes : []) this._retract(u);
    const msg = m.message || {}, model = typeof msg.model === 'string' ? msg.model : '';
    const key = msg.id || m.uuid;
    if (!model || model.startsWith('<') || !key) return;
    (this.answers = this.answers || new Map()).set(key, model);
    if (m.uuid) (this.frames = this.frames || new Map()).set(m.uuid, key);
  }
  /** A frame Claude Code took back: the response it belonged to answered nothing. */
  _retract(uuid) { const key = this.frames && this.frames.get(uuid); if (key !== undefined && this.answers) this.answers.delete(key); }

  /**
   * The model's safeguards refused a response, and Claude Code retried it on a fallback model: for the rest of the session
   * (scope 'session', or none from an older CLI), or for that one response of a sub-agent or side question ('local'). The
   * frames of the refused response, which it lists, answered nothing.
   */
  _fellBack(m) {
    for (const u of Array.isArray(m.retracted_message_uuids) ? m.retracted_message_uuids : []) this._retract(u);
    this.emit({ kind: 'fallback', from: String(m.original_model || ''), to: String(m.fallback_model || ''), scope: m.scope === 'local' ? 'local' : 'session',
      category: typeof m.api_refusal_category === 'string' ? m.api_refusal_category : '', text: String(m.content || '') });
  }

  _onMessage(m) {
    if (m.session_id && !this.sessionId) { this.sessionId = m.session_id; this.emit({ kind: 'session', id: m.session_id }); }
    this._taken(m);
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') { if (m.model) this.emit({ kind: 'model', id: m.model }); }   // the model actually in use, for the tab's tooltip
        else if (m.subtype === 'compact_boundary') this.emit({ kind: 'status', text: 'context compacted' });
        else if (m.subtype === 'session_state_changed') this._state(m.state);
        else if (m.subtype === 'model_refusal_fallback') this._fellBack(m);
        return;
      case 'stream_event': {
        const ev = m.event || {};
        // a response has begun: the request that brought it read (or wrote) the prompt cache, so the cache is warm from now.
        // Said per request, not per turn: a turn can run for many minutes, and the clock restarts with each of its requests.
        // A subagent's requests are another conversation's cache and do not count.
        if (ev.type === 'message_start' || ev.type === 'message_delta' || ev.type === 'message_stop') {
          // One response's token counts, for the host to price on a gateway. They are final only when the response ends: a
          // gateway in front of another vendor's model sends zeros at the start and the real counts in the closing delta
          // (seen through LiteLLM: 0 written at the start, 92,842 at the end), so each field is the largest seen. Kept per
          // conversation, since a subagent's responses stream alongside the main thread's.
          const key = m.parent_tool_use_id || '', open = (this.reqUsage = this.reqUsage || new Map());
          const u = ev.type === 'message_start' ? ev.message && ev.message.usage : ev.usage;
          if (ev.type === 'message_start') open.set(key, {});
          const acc = open.get(key);
          if (acc && u) {
            const top = (k, v) => { if (typeof v === 'number' && v > (acc[k] || 0)) acc[k] = v; };
            top('input', u.input_tokens); top('cache_write', u.cache_creation_input_tokens); top('cache_read', u.cache_read_input_tokens); top('output', u.output_tokens);
            top('cache_write_1h', u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens);
          }
          if (ev.type === 'message_stop' && acc) { open.delete(key); this.emit({ kind: 'usage', usage: { input: acc.input || 0, cache_write: acc.cache_write || 0, cache_read: acc.cache_read || 0, output: acc.output || 0, cache_write_1h: acc.cache_write_1h || 0 } }); }
          if (ev.type === 'message_start' && !m.parent_tool_use_id) this.emit({ kind: 'responded', at: Date.now() });
          return;
        }
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
        if (!m.parent_tool_use_id) this._answered(m);
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
        const models = this.answers ? [...new Set(this.answers.values())] : [];   // the models whose responses answered the turn
        this.answers = null; this.frames = null;
        this.emit(Object.assign({ kind: 'result', ok: m.subtype === 'success', cost, costTurn, duration_ms: m.duration_ms, turns: m.num_turns, usage: m.usage && { input: m.usage.input_tokens, cache_read: m.usage.cache_read_input_tokens, cache_write: m.usage.cache_creation_input_tokens, output: m.usage.output_tokens }, error: m.subtype !== 'success' ? (m.result || m.subtype) : undefined }, models.length ? { models } : {}));
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
    // a queued message carries a uuid of perch's: Claude Code can be asked to drop it by that uuid while it waits, and says
    // by it when a turn takes it up
    const qid = queued ? randomUUID() : undefined;
    this.pending++;
    this.running = true;
    this.emit(Object.assign({ kind: 'user', text: shown ? shown.text : text, queued }, qid ? { qid } : {}, pics.length ? { images: pics.length } : {}, shown && shown.tag ? { tag: shown.tag } : {}));
    this.emit({ kind: 'busy', busy: true });
    const content = pics.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
    if (text.trim()) content.push({ type: 'text', text });
    if (qid) this.waiting.push(qid);
    this.queue.push(Object.assign({ type: 'user', session_id: this.sessionId || '', parent_tool_use_id: null, priority: queued ? 'next' : undefined, message: { role: 'user', content } }, qid ? { uuid: qid } : {}));
  }

  /**
   * Take a queued message back before a turn takes it up: from perch's own input stream if Claude Code has not been handed
   * it yet, else from Claude Code's queue (`cancel_async_message`, which Claude Code answers with whether it was still
   * there). @returns {Promise<{ok: boolean, why?: 'taken'|'unsupported'}>} taken: a turn has taken it up already;
   *   unsupported: this Claude Code cannot be asked, and the message stays queued
   */
  async unqueue(qid) {
    if (!this.waiting.includes(qid)) return { ok: false, why: 'taken' };
    let ok = false, why = 'taken';
    const k = this.queue.items.findIndex((x) => x && x.uuid === qid);
    if (k >= 0) { this.queue.items.splice(k, 1); ok = true; }
    else if (this.query && typeof this.query.cancelAsyncMessage === 'function') { try { ok = !!(await this.query.cancelAsyncMessage(qid)); } catch (_) { why = 'unsupported'; } }
    else why = 'unsupported';
    const i = this.waiting.indexOf(qid);
    if (i >= 0 && (ok || why === 'taken')) this.waiting.splice(i, 1);   // either way it waits no longer; an unsupported cancel leaves it waiting
    if (ok) this.pending = Math.max(this.running ? 1 : 0, this.pending - 1);
    return ok ? { ok } : { ok, why };
  }

  /** Stops the current turn. Messages already queued are dropped with it, so nothing runs that the user did not see start. */
  async interrupt() { if (this.query && this.running) { try { await this.query.interrupt(); } catch (_) { /* older CLI */ } } }
  // The selectors in the panel already show mode, effort, and model, so a successful change is silent.
  async setPermissionMode(mode) { if (this.query) { try { await this.query.setPermissionMode(mode); } catch (err) { this.emit({ kind: 'error', text: 'could not set mode: ' + String(err.message || err) }); } } }
  /** Live, session-scoped: the same layer /effort uses. An empty value returns to the model's default. */
  async setEffort(level) { if (this.query) { try { await this.query.applyFlagSettings({ effortLevel: level || null }); } catch (err) { this.emit({ kind: 'error', text: 'could not set effort: ' + String(err.message || err) }); } } }
  /**
   * Live: applies from the next request, and the context figure is asked for again, which names the model now running
   * and its window. An empty value returns the session to Claude Code's own default model: its built-in one, not
   * ANTHROPIC_MODEL or the settings' model, which only decide what a session starts on.
   */
  async setModel(model) {
    if (!this.query) return;
    try { await this.query.setModel(model || undefined); } catch (err) { this.emit({ kind: 'error', text: 'could not set model: ' + String(err.message || err) }); return; }
    this._context();
  }

  dispose() { this.queue.close(); this.abort.abort(); if (this.relay) { this.relay.stop(); this.relay = null; } }
}

module.exports = { ClaudeAgent, AsyncQueue };
