// Headless check: one tiny turn through each agent module, no VS Code.
// Uses your existing claude and codex logins. Exits non-zero on failure.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ClaudeAgent } = require('../src/claudeAgent.js');
const { CodexAgent } = require('../src/codexAgent.js');

function collector(label) {
  const seen = []; let text = '';
  return {
    seen, all: [], texts: [], get text() { return text; },
    emit: function (ev) { this.all.push(ev); seen.push(ev.kind); if (ev.kind === 'text') { text = ev.text; this.texts.push(ev.text); } if (ev.kind === 'error') console.log(`[${label}] error:`, ev.text); },
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
  // the real meter, read-only: one request to the usage endpoint, and the backend flag as Claude Code would see it.
  // The switch itself is never exercised here: it writes ~/.claude/settings.json.
  const { createMeter, summarize } = require('../src/meter.js');
  const m = createMeter(); const before = (() => { try { return require('fs').readFileSync(m.settingsPath, 'utf8'); } catch (_) { return null; } })();
  const api = m.bedrockConfigured();
  if (api) { const c = m.computeCostStats(); const s = summarize({ mode: 'cost', backend: 'api', apiCredentials: m.apiCredentialsPresent(), cost: c }); console.log(`meter: backend API, cost mode "${s.text}"`); }
  else {
    const u = await m.fetchUsage(); const s = summarize({ mode: 'subscription', backend: 'subscription', limits: u.limits, error: u.error });
    console.log(`meter: backend sub, usage "${s.text}" level ${s.level}` + (u.error ? ` error ${u.error}` : ''));
    // The endpoint rate-limits, and a developer running the suite repeatedly will trip it. That is not a defect.
    if (u.error === 'rate-limited') console.log('meter: usage endpoint is rate limiting right now; live usage check skipped');
    else if (!u.limits) { console.log('meter FAILED'); failed++; }
  }
  // Codex plan usage: a file read, from whatever Codex last recorded here
  const cu = require('../src/codexMeter.js').readCodexUsage();
  const cs = summarize({ mode: 'subscription', backend: 'subscription', limits: cu.limits, error: cu.error, fetchedAt: cu.at }, { vendor: 'Codex' });
  console.log(`codex meter: plan "${cu.plan || ''}", usage "${cs.text}" level ${cs.level}` + (cu.error ? ` error ${cu.error}` : ` as of ${new Date(cu.at).toLocaleTimeString()}`));
  if (cu.error && cu.error !== 'no-codex-data') { console.log('codex meter FAILED'); failed++; }
  const after = (() => { try { return require('fs').readFileSync(m.settingsPath, 'utf8'); } catch (_) { return null; } })();
  if (before !== after) { console.log('meter FAILED: reading changed the settings file'); failed++; }
}
{
  const c = collector('claude');
  const a = new ClaudeAgent({ cwd: process.cwd(), emit: (ev) => c.emit(ev), permissionMode: 'default', effort: 'low', askPermission: async () => ({ decision: 'deny' }) });
  a.send('Reply with exactly: perch claude ok');
  try { await waitFor(c, 'result', 90000); console.log('claude:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(',')); if (!/perch claude ok/i.test(c.text)) failed++; }
  catch (e) { console.log('claude FAILED:', e.message); failed++; }
  // live effort change on the running session, then one more turn to prove the session accepted it
  const errs = []; const prev = a.emit; a.emit = (ev) => { if (ev.kind === 'error') errs.push(ev.text); prev(ev); };
  await a.setEffort('medium');
  c.seen.length = 0; a.send('Reply with exactly: perch effort ok');
  try { await waitFor(c, 'result', 90000); console.log('claude after setEffort:', JSON.stringify(c.text), '| errors:', errs.length); if (errs.length || !/perch effort ok/i.test(c.text)) failed++; }
  catch (e) { console.log('claude effort FAILED:', e.message); failed++; }

  // what the composer shows: context usage, slash commands, and when the cache was last warmed
  await new Promise((r) => setTimeout(r, 1500));
  const ctx = c.all.filter((e) => e.kind === 'context').pop(), cmds = c.all.filter((e) => e.kind === 'commands').pop(), resp = c.all.filter((e) => e.kind === 'responded').length;
  console.log(`claude composer data: context ${ctx ? ctx.percent + '% of ' + ctx.max : 'none'} · ${cmds ? cmds.list.length : 0} commands · ${resp} answers timed`);
  if (!ctx || !(ctx.max > 0) || !cmds || !cmds.list.length || resp < 2) { console.log('claude composer data FAILED'); failed++; }

  // a message sent while a turn is running is queued, and runs when the turn ends
  c.seen.length = 0; c.texts.length = 0; const busy = [];
  const prev2 = a.emit; a.emit = (ev) => { if (ev.kind === 'busy') busy.push(ev.busy); prev2(ev); };
  a.send('Reply with exactly: first');
  a.send('Reply with exactly: second');
  const t1 = Date.now();
  while (c.seen.filter((k) => k === 'result').length < 2 && Date.now() - t1 < 120000) await new Promise((r) => setTimeout(r, 100));
  const users = c.all.filter((e) => e.kind === 'user').slice(-2).map((e) => !!e.queued);
  await new Promise((r) => setTimeout(r, 1500));      // the CLI's idle word follows the result by a moment
  console.log('claude queue:', JSON.stringify(c.texts), '| queued flags', JSON.stringify(users), '| went idle', busy.filter((b) => !b).length, 'time(s) | running after', a.running, '| CLI state words', a.stated || 0);
  // The CLI's own idle/running word must arrive (it is what clears a tab when two messages are answered by one turn),
  // and two queued messages must still show as one stretch of work, not idle in between.
  if (!/first/i.test(c.texts[0] || '') || !/second/i.test(c.texts[1] || '') || users.join() !== 'false,true' || busy.filter((b) => !b).length !== 1 || a.running || !a.stated) { console.log('claude queue FAILED'); failed++; }
  a.dispose();
}
{
  const c = collector('codex');
  const a = new CodexAgent({ cwd: process.cwd(), emit: (ev) => c.emit(ev), sandboxMode: 'read-only', approvalPolicy: 'never', reasoningEffort: 'low' });
  await a.send('Reply with exactly: perch codex ok');
  console.log('codex:', JSON.stringify(c.text), '| events:', [...new Set(c.seen)].join(','));
  if (!/perch codex ok/i.test(c.text)) failed++;
  const fresh = require('../src/codexMeter.js').readCodexUsage();
  const age = fresh.at ? Math.round((Date.now() - fresh.at) / 1000) : -1;
  console.log(`codex meter after that turn: ${fresh.limits ? fresh.limits.map((l) => l.label + ' ' + l.percent + '% used').join(', ') : fresh.error}, ${age}s old`);
  if (!fresh.limits || age < 0 || age > 120) { console.log('codex meter FAILED: the turn did not leave a fresh reading'); failed++; }
  a.dispose();
}
console.log(failed ? `FAILED (${failed})` : 'ALL OK');
process.exit(failed ? 1 : 0);
