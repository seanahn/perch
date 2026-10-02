'use strict';
// A relay between a tab's Claude Code and the gateway, so the tab can see which model answered. An LLM gateway resolves
// a routed name such as `nexus-auto` to a deployment per request and says which in a response header
// (`x-litellm-model-name`), which the body does not carry and the Agent SDK does not surface. The relay listens on the
// loopback interface, forwards every request to the gateway unchanged (method, path, headers, body, the token among
// them), streams the response back byte for byte, and reads those headers as they pass. It changes nothing a model
// sees. One relay per tab, for the life of the tab's process. No VS Code dependency.

const http = require('http');
const https = require('https');

/** The gateway's headers worth keeping, as LiteLLM names them. Other gateways set none; the relay then reports nothing. */
const HEADERS = { model: 'x-litellm-model-name', group: 'x-litellm-model-group', fallbacks: 'x-litellm-attempted-fallbacks', cost: 'x-litellm-response-cost', callId: 'x-litellm-call-id', keySpend: 'x-litellm-key-spend' };
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * A deployment name as the gateway gives it, shortened for a line of the transcript: the provider's prefix dropped.
 * `global.openai.gpt-6-luna` → `gpt-6-luna`; `xai/grok-4.6` → `grok-4.6`; `gpt-4.1-mini` stays. A prefix is a slash
 * segment, or a leading dot-word with no digit in it; a version's dot follows a digit and is kept.
 */
function shortModel(name) {
  const tail = String(name || '').split('/').pop();
  const parts = tail.split('.');
  let i = 0;
  while (i < parts.length - 1 && !/\d/.test(parts[i])) i++;
  return parts.slice(i).join('.');
}

class Relay {
  /**
   * @param {object} o
   * @param {string} o.target               the gateway's base URL, as ANTHROPIC_BASE_URL would be; a path prefix is kept
   * @param {(call: object) => void} [o.onCall]  each response, once its headers are in: { path, status, model, group, fallbacks, cost, callId }
   */
  constructor({ target, onCall }) {
    this.target = new URL(target);
    this.onCall = onCall || (() => {});
    this.server = null;
    this.port = 0;
    this.calls = 0;
    const base = this.target.protocol === 'https:' ? https : http;
    this.agent = new base.Agent({ keepAlive: true });
    this.lib = base;
  }

  /** The URL a tab's Claude Code is given as ANTHROPIC_BASE_URL. */
  url() { return `http://127.0.0.1:${this.port}`; }

  /** Listen on a free loopback port. */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.forward(req, res));
      this.server.timeout = 0; this.server.keepAliveTimeout = 65000; this.server.headersTimeout = 70000;   // a long answer streams for minutes; no idle cut-off
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  forward(req, res) {
    const path = (this.target.pathname.replace(/\/$/, '') + req.url);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'host') headers[k] = v;
    headers.host = this.target.host;
    const up = this.lib.request({ protocol: this.target.protocol, hostname: this.target.hostname, port: this.target.port || undefined, method: req.method, path, headers, agent: this.agent }, (ur) => {
      const h = ur.headers, call = { path: req.url, status: ur.statusCode, model: h[HEADERS.model] || '', group: h[HEADERS.group] || '', fallbacks: Number(h[HEADERS.fallbacks]) || 0, cost: h[HEADERS.cost] !== undefined ? Number(h[HEADERS.cost]) : undefined, callId: h[HEADERS.callId] || '', ...(h[HEADERS.keySpend] !== undefined && Number.isFinite(Number(h[HEADERS.keySpend])) ? { keySpend: Number(h[HEADERS.keySpend]) } : {}) };
      this.calls++;
      try { this.onCall(call); } catch (_) { /* a listener must not break the relay */ }
      const out = {};
      for (const [k, v] of Object.entries(h)) if (!HOP.has(k)) out[k] = v;
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    });
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'perch relay: the gateway could not be reached: ' + e.message } })); } else res.destroy(); });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  }

  stop() {
    if (this.server) { if (this.server.closeAllConnections) this.server.closeAllConnections(); this.server.close(); this.server = null; }   // connections first, then the port
    this.agent.destroy();
  }
}

module.exports = { Relay, shortModel, HEADERS };
