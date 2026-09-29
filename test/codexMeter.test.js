'use strict';
// Codex plan usage, read from throwaway session directories. No network, no real ~/.codex.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const C = require('../src/codexMeter');
const { summarize } = require('../src/meter');

const NOW = Date.parse('2026-09-29T19:40:00Z'), S = (ms) => Math.round(ms / 1000);
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-codex-'));
const limits = (o) => Object.assign({ limit_id: 'codex', primary: { used_percent: 4.0, window_minutes: 300, resets_at: S(NOW + 2 * 3600000) }, secondary: { used_percent: 1.0, window_minutes: 10080, resets_at: S(NOW + 6 * 86400000) }, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'plus', rate_limit_reached_type: null }, o);
const tokenCount = (ts, rl, info) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ordinal: 13, type: 'event_msg', payload: { type: 'token_count', info: info || { model_context_window: 258400, last_token_usage: { total_tokens: 13636 } }, rate_limits: rl } });
const other = (ts, type) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type } });
function rollout(home, day, name, lines, mtime) {
  const dir = path.join(home, 'sessions', ...day.split('-')); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'rollout-' + name + '.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n');
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

// ---- one window
assert.deepStrictEqual(C.windowOf({ used_percent: 4, window_minutes: 300, resets_at: S(NOW + 3600000) }, NOW), { kind: 'session', label: '5h', name: '5h session', percent: 4, resetsAt: new Date(NOW + 3600000).toISOString(), model: null });
assert.deepStrictEqual(C.windowOf({ used_percent: 1, window_minutes: 10080, resets_at: S(NOW + 86400000) }, NOW), { kind: 'weekly_all', label: 'wk', name: 'Weekly', percent: 1, resetsAt: new Date(NOW + 86400000).toISOString(), model: null });
assert.deepStrictEqual([C.windowOf({ used_percent: 9, window_minutes: 180 }, NOW).label, C.windowOf({ used_percent: 9, window_minutes: 43200 }, NOW).name, C.windowOf({ used_percent: 9, window_minutes: 30 }, NOW).label], ['3h', '30d window', '30m'], 'windows other than today\'s are named by their length');
assert.deepStrictEqual(C.windowOf({ used_percent: 80, window_minutes: 300, resets_at: S(NOW - 60000) }, NOW), { kind: 'session', label: '5h', name: '5h session', percent: 0, resetsAt: null, model: null }, 'a window whose reset has passed has started over');
assert.strictEqual(C.windowOf({ used_percent: 5, window_minutes: 300, resets_in_seconds: 600 }, NOW).resetsAt, new Date(NOW + 600000).toISOString(), 'the older relative form');
for (const bad of [null, undefined, {}, { window_minutes: 300 }, { used_percent: '4' }]) assert.strictEqual(C.windowOf(bad, NOW), null);

// ---- one file
const t = NOW - 5 * 60000;
let r = C.parseRollout([other(t, 'task_started'), tokenCount(t, limits({ primary: { used_percent: 50, window_minutes: 300, resets_at: S(NOW + 1) } })), tokenCount(t + 1000, limits()), other(t + 2000, 'task_complete'), ''].join('\n'), NOW);
assert.deepStrictEqual([r.limits.map((l) => l.percent), r.plan, r.at, r.contextWindow, r.reached, r.credits], [[4, 1], 'plus', t + 1000, 258400, null, { has: false, unlimited: false, balance: '0' }], 'the last reading in the file wins');
assert.strictEqual(C.parseRollout([other(t, 'task_started'), '{"payload":{"rate_limits": broken', 'not json "rate_limits"', tokenCount(t, null), tokenCount(t, {}), tokenCount(t, { primary: null, secondary: null })].join('\n'), NOW), null, 'lines that are broken or empty are skipped');
assert.strictEqual(C.parseRollout('', NOW), null);
r = C.parseRollout(tokenCount(t, limits({ secondary: null, plan_type: undefined, rate_limit_reached_type: 'primary', credits: null })), NOW);
assert.deepStrictEqual([r.limits.length, r.plan, r.reached, r.credits], [1, '', 'primary', null], 'one window and no plan is still a reading');

// ---- the session directory
{
  const home = mk();
  assert.deepStrictEqual(C.readCodexUsage({ home, now: NOW }), { limits: null, error: 'no-codex-data' }, 'Codex never used on this machine');
  fs.mkdirSync(path.join(home, 'sessions'));
  assert.deepStrictEqual(C.readCodexUsage({ home, now: NOW }), { limits: null, error: 'no-codex-data' });
  rollout(home, '2026-09-27', 'old', [tokenCount(NOW - 2 * 86400000, limits({ primary: { used_percent: 70, window_minutes: 300, resets_at: S(NOW - 86400000) }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: S(NOW + 3 * 86400000) } }))], NOW - 2 * 86400000);
  r = C.readCodexUsage({ home, now: NOW });
  assert.deepStrictEqual(r.limits.map((l) => [l.percent, l.resetsAt === null]), [[0, true], [30, false]], 'an old reading: the short window has started over, the week has not');
  rollout(home, '2026-09-29', 'noturn', [other(NOW - 1000, 'task_started')], NOW - 1000);           // newest, but has no reading yet
  const mid = rollout(home, '2026-09-29', 'mid', [tokenCount(NOW - 60000, limits({ primary: { used_percent: 12, window_minutes: 300, resets_at: S(NOW + 3600000) } }))], NOW - 60000);
  rollout(home, '2026-09-29', 'earlier', [tokenCount(NOW - 3600000, limits({ primary: { used_percent: 2, window_minutes: 300, resets_at: S(NOW + 3600000) } }))], NOW - 3600000);
  fs.writeFileSync(path.join(home, 'sessions', '2026', '09', '29', 'notes.txt'), tokenCount(NOW, limits({ primary: { used_percent: 99, window_minutes: 300, resets_at: S(NOW + 1) } })));
  r = C.readCodexUsage({ home, now: NOW });
  assert.deepStrictEqual([r.limits[0].percent, r.file, r.error, r.plan], [12, mid, null, 'plus'], 'the newest file that has a reading, skipping one still on its first turn and anything that is not a rollout');
  assert.deepStrictEqual(C.newestRollouts(path.join(home, 'sessions'), 40).map((f) => path.basename(f.file)), ['rollout-noturn.jsonl', 'rollout-mid.jsonl', 'rollout-earlier.jsonl', 'rollout-old.jsonl'], 'newest first, across days');
  assert.strictEqual(C.newestRollouts(path.join(home, 'sessions'), 2).length, 2);

  // a long final turn pushes the reading back from the end of the file; a very large file is read from its tail only
  const pad = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(200), i } }));
  const big = rollout(home, '2026-09-29', 'big', [tokenCount(NOW - 30000, limits({ primary: { used_percent: 1, window_minutes: 300, resets_at: S(NOW + 1000) } })), ...pad, tokenCount(NOW - 20000, limits({ primary: { used_percent: 33, window_minutes: 300, resets_at: S(NOW + 3600000) } })), ...pad.slice(0, 200)], NOW - 500);
  assert(fs.statSync(big).size > 600000);
  r = C.readCodexUsage({ home, now: NOW });
  assert.deepStrictEqual([r.limits[0].percent, path.basename(r.file)], [33, 'rollout-big.jsonl']);

  // what the footer shows
  const s = summarize({ mode: 'subscription', backend: 'subscription', limits: r.limits, error: r.error, fetchedAt: r.at }, { vendor: 'Codex', now: NOW });
  assert.strictEqual(s.text, '1.0h 67% 6.0d 99%');
  assert.deepStrictEqual([s.vendor, s.lines[0], s.level], ['Codex', 'Codex usage, percent remaining', 'ok']);
  assert(/^5h session: 67% remaining, resets .* \(1\.0h\)$/.test(s.segments[0].title));
  const old = C.readCodexUsage({ home: (() => { const h = mk(); rollout(h, '2026-09-20', 'x', [tokenCount(NOW - 9 * 86400000, limits({ primary: { used_percent: 90, window_minutes: 300, resets_at: S(NOW - 8 * 86400000) }, secondary: { used_percent: 95, window_minutes: 10080, resets_at: S(NOW - 86400000) } }))], NOW - 9 * 86400000); return h; })(), now: NOW });
  const so = summarize({ mode: 'subscription', backend: 'subscription', limits: old.limits }, { vendor: 'Codex', now: NOW });
  assert.deepStrictEqual([so.text, so.level], ['5h 100% wk 100%', 'ok'], 'a reading from before both windows reset shows them full, not nearly empty');
  assert.strictEqual(so.segments[0].title, '5h session: 100% remaining, window has started over');
  const none = summarize({ mode: 'subscription', backend: 'subscription', limits: null, error: 'no-codex-data' }, { vendor: 'Codex' });
  assert.deepStrictEqual([none.text, none.action], ['—', 'refresh'], 'nothing to log in to: Codex has its own login'); assert(/^Codex usage unavailable: no Codex session on this machine has reported usage yet/.test(none.lines[0]));

  // a sessions directory that cannot be read
  if (process.getuid && process.getuid() !== 0) {
    const day = path.join(home, 'sessions', '2026', '09', '29');
    for (const f of fs.readdirSync(day)) fs.chmodSync(path.join(day, f), 0o000);
    fs.chmodSync(path.join(home, 'sessions', '2026', '09', '27', 'rollout-old.jsonl'), 0o000);
    assert.deepStrictEqual(C.readCodexUsage({ home, now: NOW }), { limits: null, error: 'codex-scan' }, 'unreadable files are reported as such, not as "never used"');
    for (const f of fs.readdirSync(day)) fs.chmodSync(path.join(day, f), 0o644);
  }
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('CODEX METER OK');
