'use strict';
// Codex plan usage, read from Codex's own session files. No VS Code dependency, no network.
//
// After every turn Codex appends a token_count event to the session's rollout file under ~/.codex/sessions/YYYY/MM/DD/.
// That event carries the plan's rate limits as the service last reported them: a primary window (five hours) and a
// secondary one (a week), each with the percent used and when it resets. The newest such event, from any Codex client
// on this machine, is the current reading.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 256 * 1024;   // the event is near the end of the file; a long final turn can push it back a little
const MAX_FILES = 40;            // newest first; stop at the first file that has a reading

/** The last `bytes` of a file as text, starting at a line boundary. */
function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

/** Rollout files, newest first. Day directories sort by name, so only the most recent days are listed. */
function newestRollouts(root, limit) {
  const ls = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch (_) { return []; } };
  const out = [];
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d), day = [];
    for (const n of ls(dir)) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      try { day.push({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }); } catch (_) { /* gone */ }
    }
    day.sort((a, b) => b.mtime - a.mtime);
    out.push(...day);
    if (out.length >= limit) return out.slice(0, limit).sort((a, b) => b.mtime - a.mtime);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** One window of the plan, in the shape the usage summary takes. A window whose reset has passed has started over. */
function windowOf(w, now) {
  if (!w || typeof w.used_percent !== 'number') return null;
  const minutes = Number(w.window_minutes) || 0;
  const resetMs = typeof w.resets_at === 'number' ? w.resets_at * 1000 : (typeof w.resets_in_seconds === 'number' ? now + w.resets_in_seconds * 1000 : NaN);
  const over = Number.isFinite(resetMs) && resetMs <= now;
  const label = minutes >= 1440 ? (minutes % 10080 === 0 && minutes / 10080 === 1 ? 'wk' : Math.round(minutes / 1440) + 'd') : minutes >= 60 ? Math.round(minutes / 60) + 'h' : minutes ? minutes + 'm' : '';
  return {
    kind: minutes > 1440 ? 'weekly_all' : 'session',
    label, name: minutes > 1440 ? (minutes === 10080 ? 'Weekly' : label + ' window') : (label ? label + ' session' : 'Session'),
    percent: over ? 0 : w.used_percent,
    resetsAt: Number.isFinite(resetMs) && !over ? new Date(resetMs).toISOString() : null,
    model: null,
  };
}

/** Pure: the newest rate-limit reading in a rollout file's text, or null. */
function parseRollout(text, now = Date.now()) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.indexOf('"rate_limits"') === -1) continue;
    let e; try { e = JSON.parse(line); } catch (_) { continue; }
    const p = e && e.payload, r = p && p.rate_limits;
    if (!r || typeof r !== 'object') continue;
    const limits = [windowOf(r.primary, now), windowOf(r.secondary, now)].filter(Boolean);
    if (!limits.length) continue;
    const at = new Date(e.timestamp).getTime();
    const info = p.info || {};
    return {
      limits, plan: typeof r.plan_type === 'string' ? r.plan_type : '', at: Number.isFinite(at) ? at : null,
      reached: r.rate_limit_reached_type || null,
      credits: r.credits && typeof r.credits === 'object' ? { has: !!r.credits.has_credits, unlimited: !!r.credits.unlimited, balance: String(r.credits.balance === undefined ? '' : r.credits.balance) } : null,
      contextWindow: Number(info.model_context_window) || 0,
    };
  }
  return null;
}

/**
 * @returns {{ limits: object[]|null, error: null|'no-codex-data'|'codex-scan', plan?: string, at?: number|null, file?: string }}
 */
function readCodexUsage({ home = path.join(os.homedir(), '.codex'), now = Date.now() } = {}) {
  const root = path.join(home, 'sessions');
  let files;
  try { if (!fs.statSync(root).isDirectory()) return { limits: null, error: 'no-codex-data' }; files = newestRollouts(root, MAX_FILES); }
  catch (e) { return { limits: null, error: e.code === 'ENOENT' ? 'no-codex-data' : 'codex-scan' }; }
  let failed = 0;
  for (const f of files) {
    let got;
    try { got = parseRollout(tail(f.file, TAIL_BYTES), now); } catch (_) { failed++; continue; }
    if (got) return Object.assign({ error: null, file: f.file }, got);
  }
  return { limits: null, error: files.length && failed === files.length ? 'codex-scan' : 'no-codex-data' };
}

module.exports = { readCodexUsage, parseRollout, newestRollouts, windowOf };
