'use strict';
// Stands in for voice/server.py in the engine's tests: the same JSON lines, no Python and no model.
// How it behaves is set by FAKE_VOICE: ok | fail-load | crash-on-request | silent-start | exit-after-ready
const mode = process.env.FAKE_VOICE || 'ok';
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (mode === 'silent-start') { setInterval(() => {}, 1000); return; }
if (mode === 'fail-load') { process.stderr.write('Traceback\nRuntimeError: CUDA out of memory\n'); say({ ready: false, error: 'CUDA out of memory' }); process.exit(1); }
process.stdout.write('a log line that is not JSON\n');
const device = arg('--device') === 'cpu' ? 'cpu' : 'cuda';
say({ ready: true, device, compute: 'float16', model: arg('--model') === 'auto' ? (device === 'cuda' ? 'large-v3-turbo' : 'small') : arg('--model'), load_ms: 5, models_dir: arg('--models-dir') });
if (args.includes('--download-only')) process.exit(0);
if (mode === 'exit-after-ready') { process.stderr.write('killed by the system\n'); setTimeout(() => process.exit(137), 20); }
let buf = '', chain = Promise.resolve();
// one answer at a time, as the real server gives them; each split across two writes, as a pipe may deliver it
const answer = (out) => { chain = chain.then(() => new Promise((done) => { process.stdout.write(out.slice(0, 20)); setTimeout(() => { process.stdout.write(out.slice(20)); done(); }, 5); })); };
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.op === 'quit') { chain.then(() => process.exit(0)); continue; }
    if (mode === 'crash-on-request') { process.stderr.write('Segmentation fault\n'); process.exit(139); }
    const bytes = Buffer.from(r.pcm || '', 'base64').length;
    if (r.prompt === 'FAIL') { answer(JSON.stringify({ id: r.id, ok: false, error: 'audio could not be read' }) + '\n'); continue; }
    const out = JSON.stringify({ id: r.id, ok: true, text: `heard ${bytes} bytes at ${r.sample_rate}` + (r.language ? ` in ${r.language}` : '') + (r.prompt ? ` expecting ${r.prompt}` : ''), language: r.language || 'en', seconds: bytes / 32000, took_ms: 3 }) + '\n';
    answer(out);
  }
});
process.stdin.on('end', () => process.exit(0));
