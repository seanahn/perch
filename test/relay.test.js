'use strict';
// The relay: every request forwarded to the gateway as it was, the response streamed back as it came, and the gateway's
// model headers read on the way. Against a stand-in gateway on the loopback interface; no model is called.
const assert = require('assert');
const http = require('http');
const { Relay, shortModel } = require('../src/relay');

// ---- names, shortened for a line of the transcript
assert.deepStrictEqual(['global.openai.gpt-6-luna', 'global.anthropic.claude-opus-5-5', 'xai/grok-4.6', 'azure/eastus/gpt-4.1-mini', 'fable', 'anthropic.claude-3-5-sonnet-20241022-v2:0', '', null].map(shortModel),
  ['gpt-6-luna', 'claude-opus-5-5', 'grok-4.6', 'gpt-4.1-mini', 'fable', 'claude-3-5-sonnet-20241022-v2:0', '', ''], 'the provider prefix goes, a version\'s dot stays');

(async () => {
  // a stand-in gateway under a path prefix, as the real one is, that streams a few SSE events and names the model in its headers
  const seen = [];
  let mode = 'stream';
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization, version: req.headers['anthropic-version'], body });
      if (mode === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error","message":"nope"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-litellm-key-spend': '0.6748937', 'x-litellm-model-name': 'global.openai.gpt-6-luna', 'x-litellm-model-group': 'nexus-auto', 'x-litellm-attempted-fallbacks': '1', 'x-litellm-response-cost': '0.000152', 'x-litellm-call-id': 'call-1', 'x-other': 'kept' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => { res.write('event: content_block_delta\ndata: {"delta":{"text":"ok"}}\n\n'); setTimeout(() => { res.end('event: message_stop\ndata: {}\n\n'); }, 20); }, 20);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}/agx/nexusroute/llm-api`;

  const calls = [];
  const relay = new Relay({ target, onCall: (c) => { calls.push(c); if (c.path === '/boom') throw new Error('a listener that throws'); } });
  const port = await relay.start();
  assert.strictEqual(relay.url(), `http://127.0.0.1:${port}`, 'what a tab gets as ANTHROPIC_BASE_URL');

  const post = (path, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, agent: false, headers: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer tok-123', 'anthropic-version': '2023-06-01', host: 'ignored.example' }, headers) }, (res) => {
      const chunks = []; const times = []; res.on('data', (d) => { chunks.push(String(d)); times.push(Date.now()); }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks.join(''), chunks, times }));
    });
    req.on('error', reject); req.end(body);
  });

  // ---- a streamed answer: the request reaches the gateway under its prefix, with its headers and body; the answer comes back as it was
  const r = await post('/v1/messages?beta=true', '{"model":"nexus-auto","messages":[]}');
  assert.deepStrictEqual(seen[0], { method: 'POST', url: '/agx/nexusroute/llm-api/v1/messages?beta=true', host: `127.0.0.1:${upstream.address().port}`, auth: 'Bearer tok-123', version: '2023-06-01', body: '{"model":"nexus-auto","messages":[]}' }, 'the path prefix is kept, the token and the body pass untouched, the host is the gateway\'s');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.headers['content-type'], r.headers['x-litellm-model-name'], r.headers['x-other']], ['text/event-stream', 'global.openai.gpt-6-luna', 'kept'], 'the gateway\'s headers reach Claude Code too');
  assert.strictEqual(r.body, 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"delta":{"text":"ok"}}\n\nevent: message_stop\ndata: {}\n\n', 'byte for byte');
  assert(r.chunks.length >= 2 && r.times[r.times.length - 1] - r.times[0] >= 15, 'streamed as it came, not held until the end');
  assert.deepStrictEqual(calls, [{ path: '/v1/messages?beta=true', status: 200, model: 'global.openai.gpt-6-luna', group: 'nexus-auto', fallbacks: 1, cost: 0.000152, callId: 'call-1', keySpend: 0.6748937 }], 'what the relay read off the headers');

  // ---- an error from the gateway is passed on as it is; a listener that throws does not break the relay
  mode = 'error';
  const e = await post('/boom', '{}');
  assert.deepStrictEqual([e.status, e.body, calls.length, calls[1].status, calls[1].model], [401, '{"type":"error","error":{"type":"authentication_error","message":"nope"}}', 2, 401, ''], 'the 401 reaches Claude Code; the call is noted with no model');
  mode = 'stream';

  // ---- the gateway down: a 502 in the API's error shape, so Claude Code shows a reason rather than hanging
  const dead = new Relay({ target: 'http://127.0.0.1:1/llm-api' });
  const dport = await dead.start();
  const d = await new Promise((resolve, reject) => { const q = http.request({ hostname: '127.0.0.1', port: dport, method: 'POST', path: '/v1/messages' }, (res) => { let b = ''; res.on('data', (x) => { b += x; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); }); q.on('error', reject); q.end('{}'); });
  assert.strictEqual(d.status, 502); assert.strictEqual(d.body.type, 'error'); assert(/perch relay: the gateway could not be reached/.test(d.body.error.message));
  dead.stop();

  // ---- stopped: the port is closed
  relay.stop();
  await assert.rejects(post('/v1/messages', '{}'), /ECONNREFUSED/, 'nothing listens once the tab\'s process is gone');
  upstream.close();
  console.log('RELAY OK');
})().catch((e) => { console.error('RELAY FAILED:', e.stack || e.message); process.exit(1); });
