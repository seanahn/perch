// Headless check: one tiny turn through each agent module, no VS Code.
// Uses your existing claude and codex logins. Exits non-zero on failure.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ClaudeAgent } = require('../src/claudeAgent.js');
const { CodexAgent } = require('../src/codexAgent.js');

function collector(label) {
  const seen = []; let text = '';
  return {
    seen, get text() { return text; },
    emit: (ev) => { seen.push(ev.kind); if (ev.kind === 'text') text = ev.text; if (ev.kind === 'error') console.log(`[${label}] error:`, ev.text); },
  };
}
function waitFor(coll, kind, ms) {
  return new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (coll.seen.includes(kind)) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${kind}; saw ${coll.seen.join(',')}`)); } }, 50); });
}

let failed = 0;
{
  const c = collector('claude');
  const a = new ClaudeAgent({ cwd: process.cwd(), emit: c.emit, permissionMode: 'default', askPermission: async () => ({ decision: 'deny' }) });
  a.send('Reply with exactly: perch claude ok');
  try { await waitFor(c, 'result', 90000); console.log('claude:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(',')); if (!/perch claude ok/i.test(c.text)) failed++; }
  catch (e) { console.log('claude FAILED:', e.message); failed++; }
  a.dispose();
}
{
  const c = collector('codex');
  const a = new CodexAgent({ cwd: process.cwd(), emit: c.emit, sandboxMode: 'read-only', approvalPolicy: 'never' });
  await a.send('Reply with exactly: perch codex ok');
  console.log('codex:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(','));
  if (!/perch codex ok/i.test(c.text)) failed++;
  a.dispose();
}
console.log(failed ? `FAILED (${failed})` : 'ALL OK');
process.exit(failed ? 1 : 0);
