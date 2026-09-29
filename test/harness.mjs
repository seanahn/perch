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
  // the real catalogs, from the real agents: no message is sent for either
  const { loadClaudeModels, loadCodexModels } = require('../src/models.js');
  const t0 = Date.now(); const cl = await loadClaudeModels({ cwd: process.cwd() }); const ms = Date.now() - t0;
  const cx = loadCodexModels();
  console.log(`claude models: ${cl ? cl.models.length : 0} in ${ms}ms, default "${cl && cl.defaultModel.label}" | codex models: ${cx ? cx.models.length : 0}, default "${cx && cx.defaultModel.label}" at effort "${cx && cx.defaultModel.defaultEffort}"`);
  if (!cl || !cl.models.length || !cl.defaultModel.label) { console.log('claude catalog FAILED'); failed++; }
  if (!cx || !cx.models.length) { console.log('codex catalog FAILED'); failed++; }
}
{
  const c = collector('claude');
  const a = new ClaudeAgent({ cwd: process.cwd(), emit: c.emit, permissionMode: 'default', effort: 'low', askPermission: async () => ({ decision: 'deny' }) });
  a.send('Reply with exactly: perch claude ok');
  try { await waitFor(c, 'result', 90000); console.log('claude:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(',')); if (!/perch claude ok/i.test(c.text)) failed++; }
  catch (e) { console.log('claude FAILED:', e.message); failed++; }
  // live effort change on the running session, then one more turn to prove the session accepted it
  const errs = []; const prev = a.emit; a.emit = (ev) => { if (ev.kind === 'error') errs.push(ev.text); prev(ev); };
  await a.setEffort('medium');
  c.seen.length = 0; a.send('Reply with exactly: perch effort ok');
  try { await waitFor(c, 'result', 90000); console.log('claude after setEffort:', JSON.stringify(c.text), '| errors:', errs.length); if (errs.length || !/perch effort ok/i.test(c.text)) failed++; }
  catch (e) { console.log('claude effort FAILED:', e.message); failed++; }
  a.dispose();
}
{
  const c = collector('codex');
  const a = new CodexAgent({ cwd: process.cwd(), emit: c.emit, sandboxMode: 'read-only', approvalPolicy: 'never', reasoningEffort: 'low' });
  await a.send('Reply with exactly: perch codex ok');
  console.log('codex:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(','));
  if (!/perch codex ok/i.test(c.text)) failed++;
  a.dispose();
}
console.log(failed ? `FAILED (${failed})` : 'ALL OK');
process.exit(failed ? 1 : 0);
