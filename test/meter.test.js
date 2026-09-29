'use strict';
// Usage and backend logic, against throwaway home directories. No network, no real ~/.claude.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const M = require('../src/meter');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-meter-'));
const write = (home, rel, body) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); return p; };
const read = (home, rel) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));
const stashOf = (init) => { const m = Object.assign({}, init); return { get: (k) => m[k], set: (k, v) => { if (v === undefined) delete m[k]; else m[k] = v; }, all: m }; };

(async () => {
  // ---- formatters
  assert.deepStrictEqual([0, 999, 1000, 1499, 5.2e6, 3.14e9].map(M.fmtTok), ['0', '999', '1k', '1k', '5.2M', '3.1B']);
  assert.deepStrictEqual([0.004, 9.999, 18.94, 250.4].map(M.fmtUsd), ['$0.00', '$10.00', '$18.9', '$250']);
  const NOW = Date.parse('2026-09-29T12:00:00Z');
  assert.deepStrictEqual(['2026-09-29T12:00:20Z', '2026-09-29T12:43:00Z', '2026-09-29T16:12:00Z', '2026-10-01T02:24:00Z', '2026-09-29T11:00:00Z', 'junk'].map((t) => M.fmtEta(t, NOW)), ['1m', '43m', '4.2h', '1.6d', '', '']);
  assert.deepStrictEqual([100, 74, 5, 0, -5, 140].map(M.tankBar), ['▮▮▮▮▮▮▮▮▮▮', '▮▮▮▮▮▮▮▯▯▯', '▮▯▯▯▯▯▯▯▯▯', '▯▯▯▯▯▯▯▯▯▯', '▯▯▯▯▯▯▯▯▯▯', '▮▮▮▮▮▮▮▮▮▮']);
  assert.deepStrictEqual(['us.anthropic.claude-opus-5', 'claude-haiku-4-5-20251001', 'us.anthropic.claude-sonnet-4-6-v1:0', 'fable'].map(M.shortModel), ['opus-5', 'haiku-4-5', 'sonnet-4-6', 'fable']);
  assert.deepStrictEqual(['claude-fable-5-1', 'claude-haiku-4-5', 'claude-haiku-3-5', 'claude-opus-4-1-x', 'claude-opus-5', 'us.anthropic.claude-sonnet-5', 'gpt-6'].map(M.priceFor), [[10, 50], [1, 5], [0.8, 4], [15, 75], [5, 25], [3, 15], null]);
  assert.strictEqual(M.recordCost('claude-opus-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheW5: 1e6, cacheW1: 1e6 }), 5 + 25 + 0.5 + 6.25 + 10);
  assert.strictEqual(M.recordCost('mystery', { input: 1e6, output: 1e6, cacheRead: 0, cacheW5: 0, cacheW1: 0 }), 0, 'unpriced models cost nothing rather than guessing');

  // ---- usage response shapes
  assert.deepStrictEqual(M.parseUsageResponse({ five_hour: { utilization: 11, resets_at: 'a' }, seven_day: { utilization: 3, resets_at: 'b' }, seven_day_opus: null, seven_day_fable: { utilization: 5, resets_at: 'b' }, seven_day_sonnet: { utilization: 1, resets_at: 'c' }, extra: 1 }),
    [{ kind: 'session', percent: 11, resetsAt: 'a', model: null }, { kind: 'weekly_all', percent: 3, resetsAt: 'b', model: null }, { kind: 'weekly_scoped', percent: 5, resetsAt: 'b', model: 'Fable' }, { kind: 'weekly_scoped', percent: 1, resetsAt: 'c', model: 'Sonnet' }], 'any model-scoped weekly is picked up, not only opus and sonnet');
  assert.deepStrictEqual(M.parseUsageResponse({ limits: [{ kind: 'session', percent: 9, resets_at: 'a' }, { kind: 'weekly_scoped', percent: 2, resets_at: 'b', scope: { model: { display_name: 'Fable' } } }] }),
    [{ kind: 'session', percent: 9, resetsAt: 'a', model: null }, { kind: 'weekly_scoped', percent: 2, resetsAt: 'b', model: 'Fable' }], 'legacy shape');
  for (const bad of [null, 'x', {}, { limits: [] }, { error: { type: 'authentication_error' } }]) assert.strictEqual(M.parseUsageResponse(bad), null);

  // ---- fetchUsage: credentials, expiry, network, bad body. The token goes only to api.anthropic.com.
  {
    const home = mk(); const calls = [];
    const meter = (body, fail) => M.createMeter({ home, env: {}, platform: 'linux', request: async (o) => { calls.push(o); if (fail) throw new Error('down'); return body; } });
    assert.deepStrictEqual(await meter('{}').fetchUsage(NOW), { limits: null, error: 'no-credentials' });
    write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW - 1 } });
    assert.deepStrictEqual(await meter('{}').fetchUsage(NOW), { limits: null, error: 'token-expired' });
    assert.strictEqual(calls.length, 0, 'no request without a usable token');
    write(home, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'tok-2', expiresAt: NOW + 1000 } });
    assert.deepStrictEqual(await meter('', true).fetchUsage(NOW), { limits: null, error: 'network' });
    assert.deepStrictEqual(await meter('<html>').fetchUsage(NOW), { limits: null, error: 'bad-response' });
    assert.deepStrictEqual(await meter('{"five_hour":null}').fetchUsage(NOW), { limits: null, error: 'bad-response' });
    const ok = await meter(JSON.stringify({ five_hour: { utilization: 26, resets_at: 'r' } })).fetchUsage(NOW);
    assert.deepStrictEqual(ok, { limits: [{ kind: 'session', percent: 26, resetsAt: 'r', model: null }], error: null });
    const last = calls.pop();
    assert.deepStrictEqual([last.hostname, last.path, last.headers.Authorization, last.headers['anthropic-beta']], ['api.anthropic.com', '/api/oauth/usage', 'Bearer tok-2', 'oauth-2025-04-20']);
    // the HTTP status decides the kind of failure
    const st = (status, body, headers) => M.createMeter({ home, env: {}, platform: 'linux', request: async () => ({ status, headers: headers || {}, body }) }).fetchUsage(NOW);
    const RL = '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}';
    assert.deepStrictEqual(await st(429, RL), { limits: null, error: 'rate-limited', retryAfterMs: 0 }, 'a rate limit is not a malformed body');
    assert.deepStrictEqual(await st(429, RL, { 'retry-after': '120' }), { limits: null, error: 'rate-limited', retryAfterMs: 120000 });
    assert.deepStrictEqual(await st(429, '', { 'retry-after': new Date(NOW + 90000).toUTCString() }), { limits: null, error: 'rate-limited', retryAfterMs: 90000 });
    assert.deepStrictEqual([M.retryAfterMs(undefined), M.retryAfterMs(''), M.retryAfterMs('soon'), M.retryAfterMs('-5'), M.retryAfterMs(new Date(NOW - 1000).toUTCString(), NOW)], [0, 0, 0, 0, 0]);
    for (const code of [401, 403]) assert.strictEqual((await st(code, '{"error":{}}')).error, 'token-expired', String(code));
    for (const code of [500, 502, 503]) assert.strictEqual((await st(code, '<html>')).error, 'network', String(code));
    assert.strictEqual((await st(404, '{}')).error, 'bad-response');
    assert.strictEqual((await st(200, JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 12, severity: 'normal', resets_at: 'r', scope: null, is_active: true }] }))).limits[0].percent, 12, 'the shape the endpoint returns today');
    write(home, '.claude/.credentials.json', '{ broken');
    assert.strictEqual((await meter('{}').fetchUsage(NOW)).error, 'no-credentials', 'an unreadable credentials file is treated as not logged in');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- which backend the next session uses: settings over environment, local settings over user settings
  {
    const home = mk(); const on = (env) => M.createMeter({ home, env, platform: 'linux' }).bedrockConfigured();
    assert.strictEqual(on({}), false, 'nothing set: subscription');
    assert.strictEqual(on({ CLAUDE_CODE_USE_BEDROCK: '1' }), true, 'environment decides when settings are silent');
    for (const off of ['0', 'false', '']) assert.strictEqual(on({ CLAUDE_CODE_USE_BEDROCK: off }), false);
    assert(/following CLAUDE_CODE_USE_BEDROCK=1/.test(M.createMeter({ home, env: { CLAUDE_CODE_USE_BEDROCK: '1' } }).envNote()));
    write(home, '.claude/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
    assert.strictEqual(on({ CLAUDE_CODE_USE_BEDROCK: '1' }), false, 'settings win over the environment');
    assert.strictEqual(M.createMeter({ home, env: { CLAUDE_CODE_USE_BEDROCK: '1' } }).envNote(), '', 'no note once settings carry a value');
    write(home, '.claude/settings.json', { env: { CLAUDE_CODE_USE_BEDROCK: 1 } });
    assert.strictEqual(on({}), true, 'a numeric value counts');
    write(home, '.claude/settings.local.json', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
    assert.strictEqual(on({}), false, 'settings.local.json overrides settings.json');
    write(home, '.claude/settings.local.json', '{ broken');
    assert.strictEqual(on({}), true, 'an unparsable file is skipped');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- API credentials
  {
    const home = mk(); const has = (env) => M.createMeter({ home, env }).apiCredentialsPresent();
    assert.strictEqual(has({}), false);
    for (const k of ['ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE']) assert.strictEqual(has({ [k]: 'x' }), true, k);
    write(home, '.aws/config', '[default]'); assert.strictEqual(has({}), true, '~/.aws/config counts');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- the switch: writes one flag, keeps everything else, and moves backend-specific model pins out of the way
  {
    const home = mk();
    const BED = 'us.anthropic.claude-sonnet-4-6';
    const meter = M.createMeter({ home, env: { ANTHROPIC_MODEL: BED, ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' } });
    const stash = stashOf();
    meter.setBedrockSetting(true, stash);                                     // no settings file yet
    assert.deepStrictEqual(read(home, '.claude/settings.json'), { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, 'creates the file when missing');
    assert(fs.readFileSync(meter.settingsPath, 'utf8').endsWith('}\n'));

    const original = { model: BED, permissions: { allow: ['Bash(ls)'], deny: [] }, hooks: { Stop: [{ hooks: [] }] }, env: { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1', AWS_REGION: 'us-west-2' }, statusLine: { type: 'command' } };
    write(home, '.claude/settings.json', original);
    meter.setBedrockSetting(false, stash);                                    // to subscription
    let j = read(home, '.claude/settings.json');
    assert.strictEqual(j.env.CLAUDE_CODE_USE_BEDROCK, '0');
    assert.strictEqual(j.model, undefined, 'a Bedrock model id is taken out: a subscription session cannot use it');
    assert.strictEqual(stash.all.model, BED, 'and kept for the way back');
    assert.strictEqual(j.env.ANTHROPIC_MODEL, '', 'a Bedrock model exported in the environment is blanked for Claude Code');
    assert.strictEqual(j.env.ANTHROPIC_SMALL_FAST_MODEL, undefined, 'a plain model id in the environment is left alone');
    assert.deepStrictEqual([j.permissions, j.hooks, j.statusLine, j.env.AWS_REGION, j.env.CLAUDE_CODE_ENABLE_TELEMETRY], [original.permissions, original.hooks, original.statusLine, 'us-west-2', '1'], 'everything else is preserved');
    assert.deepStrictEqual(Object.keys(j), ['permissions', 'hooks', 'env', 'statusLine'], 'key order is preserved');

    meter.setBedrockSetting(true, stash);                                     // and back
    j = read(home, '.claude/settings.json');
    assert.strictEqual(j.env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.strictEqual(j.model, BED, 'the Bedrock model is restored');
    assert.strictEqual(stash.all.model, undefined, 'the stash is emptied');
    assert.strictEqual('ANTHROPIC_MODEL' in j.env, false, 'the blank override is removed so the exported model applies again');
    assert.strictEqual(fs.readdirSync(path.join(home, '.claude')).filter((f) => /\.tmp$/.test(f)).length, 0, 'no temp file left behind');

    write(home, '.claude/settings.json', { model: 'fable', env: { ANTHROPIC_MODEL: 'opus' } });
    const s2 = stashOf({ model: BED });
    meter.setBedrockSetting(false, s2);
    j = read(home, '.claude/settings.json');
    assert.deepStrictEqual([j.model, j.env.ANTHROPIC_MODEL, s2.all.model], ['fable', 'opus', BED], 'a plain saved model and an explicit settings pin are not touched');
    meter.setBedrockSetting(true, s2);
    assert.strictEqual(read(home, '.claude/settings.json').model, 'fable', 'a stashed model never overwrites one chosen since');

    // a settings file that cannot be parsed is never overwritten
    write(home, '.claude/settings.json', '{ "permissions": { "allow": ["x"] }, // comment\n');
    const before = fs.readFileSync(meter.settingsPath, 'utf8');
    assert.throws(() => meter.setBedrockSetting(true, stashOf()), /is not valid JSON/);
    assert.strictEqual(fs.readFileSync(meter.settingsPath, 'utf8'), before, 'the broken file is left exactly as it was');
    write(home, '.claude/settings.json', '[1,2]');
    assert.throws(() => meter.setBedrockSetting(true, stashOf()), /does not hold a JSON object/);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- cost mode: transcripts. "Today" is a local-time notion, so this section's clock is local noon.
  {
    const NOW = new Date(2026, 8, 29, 12, 0, 0).getTime();
    assert.strictEqual(M.parseUsageLine('{"type":"user","message":{}}'), null);
    assert.strictEqual(M.parseUsageLine('not json "usage"'), null);
    const line = (id, ts, model, u) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, model, usage: u } });
    assert.strictEqual(M.parseUsageLine(line('m0', NOW, 'x', { input_tokens: 0, output_tokens: 0 })), null, 'synthetic zero-usage entries are skipped');
    assert.deepStrictEqual(M.parseUsageLine(line('m1', NOW, 'claude-opus-5', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } })),
      { id: 'm1', ts: NOW, model: 'claude-opus-5', input: 10, output: 20, cacheRead: 30, cacheW5: 60, cacheW1: 40 });

    const home = mk(); const meter = M.createMeter({ home, env: {} });
    assert.deepStrictEqual(meter.computeCostStats(NOW).today, { tokens: 0, cost: 0 }, 'no transcripts, no usage');
    const H = 3600000, u = (i, o) => ({ input_tokens: i, output_tokens: o });
    const f1 = write(home, '.claude/projects/-git-a/s1.jsonl', [
      line('a1', NOW - 1 * H, 'claude-opus-5', u(1e6, 0)),
      line('a1', NOW - 1 * H, 'claude-opus-5', u(1e6, 0)),                      // same message, second content block
      line('a2', NOW - 6 * H, 'claude-sonnet-5', u(0, 1e6)),                    // today, outside the 5h session
      line('a3', NOW - 3 * 24 * H, 'claude-haiku-4-5', u(2e6, 0)),              // three days ago
      line('a4', NOW - 9 * 24 * H, 'claude-opus-5', u(5e6, 0)),                 // older than the window
      '{"type":"user","message":{"content":"hi"}}', '',
    ].join('\n') + '\n');
    write(home, '.claude/projects/-git-b/s2.jsonl', line('a1', NOW - 1 * H, 'claude-opus-5', u(1e6, 0)) + '\n' + line('b1', NOW - 2 * H, 'mystery-model', u(500, 500)) + '\n');
    write(home, '.claude/projects/-git-b/notes.txt', 'ignored');
    let s = meter.computeCostStats(NOW);
    assert.deepStrictEqual(s.session, { tokens: 1e6 + 1000, cost: 5 }, 'the same message in two files is counted once');
    assert.deepStrictEqual(s.today, { tokens: 2e6 + 1000, cost: 5 + 15 });
    assert.strictEqual(s.latestModel, 'claude-opus-5');
    assert.strictEqual(s.days.length, 7);
    assert.deepStrictEqual(s.days.map((d) => d.tokens), [0, 0, 0, 2e6, 0, 0, 2e6 + 1000]);
    assert.deepStrictEqual([...s.models.keys()].sort(), ['claude-opus-5', 'claude-sonnet-5', 'mystery-model']);
    assert.strictEqual(s.models.get('mystery-model').unpriced, true);
    fs.appendFileSync(f1, line('a5', NOW - 60000, 'claude-fable-5-1', u(1e6, 1e6)).slice(0, 40));   // a line still being written
    assert.strictEqual(meter.computeCostStats(NOW).today.tokens, 2e6 + 1000, 'a partial trailing line is not counted');
    fs.writeFileSync(f1, fs.readFileSync(f1, 'utf8').slice(0, -40) + line('a5', NOW - 60000, 'claude-fable-5-1', u(1e6, 1e6)) + '\n');
    s = meter.computeCostStats(NOW);
    assert.deepStrictEqual([s.today.tokens, s.latestModel, s.models.get('claude-fable-5-1').cost], [4e6 + 1000, 'claude-fable-5-1', 60], 'appended lines are picked up on the next poll');
    fs.writeFileSync(f1, line('z1', NOW - 1000, 'claude-opus-5', u(7, 0)) + '\n');                  // file replaced by a shorter one
    assert.strictEqual(meter.computeCostStats(NOW).models.get('claude-opus-5').input, 1e6 + 7, 'a truncated file is re-read from the start');
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- one summary for every surface
  {
    const at = (h) => new Date(NOW + h * 3600000).toISOString();
    const limits = [{ kind: 'session', percent: 9, resetsAt: at(1), model: null }, { kind: 'weekly_all', percent: 5, resetsAt: at(156), model: null }, { kind: 'weekly_scoped', percent: 5.4, resetsAt: at(156), model: 'Fable' }, { kind: 'weekly_scoped', percent: 80, resetsAt: at(30), model: 'Opus' }];
    let s = M.summarize({ mode: 'subscription', backend: 'subscription', limits }, { now: NOW });
    assert.strictEqual(s.text, '1.0h 91% 6.5d 95% fable 94.6% 1.3d 20%');
    assert.deepStrictEqual(s.segments.map((x) => x.level), ['ok', 'ok', 'ok', 'warn']); assert.strictEqual(s.level, 'warn', 'the worst limit sets the colour');
    assert.deepStrictEqual([s.backendLabel, s.backendWarn, s.action], ['sub', false, 'refresh']);
    assert(/^Weekly Opus: 20% remaining, resets .* \(1\.3d\)$/.test(s.segments[3].title));
    assert.strictEqual(s.lines.length, 5); assert(/^▮▮▮▮▮▮▮▮▮▯  5h session  91%  resets /.test(s.lines[1]));
    s = M.summarize({ mode: 'subscription', backend: 'subscription', limits }, { now: NOW, display: 'used', showModelWeekly: false, warnBelow: 96, errorBelow: 92 });   // thresholds are strict: exactly at the threshold is still fine
    assert.strictEqual(s.text, '1.0h 9% 6.5d 5%'); assert.deepStrictEqual([s.segments.map((x) => x.level), s.level], [['error', 'warn'], 'error']);
    s = M.summarize({ mode: 'subscription', backend: 'subscription', limits: [{ kind: 'session', percent: 140, resetsAt: at(-1), model: null }] }, { now: NOW });
    assert.strictEqual(s.text, '5h 0%', 'over the limit reads as empty, and a past reset falls back to the label');

    s = M.summarize({ mode: 'subscription', backend: 'subscription', limits, error: 'rate-limited' }, { now: NOW });
    assert.deepStrictEqual([s.stale, s.segments.length, s.action], [true, 4, 'refresh'], 'a failed refresh keeps the reading and marks it stale');
    assert(/^Showing the last reading: the usage endpoint is rate limiting/.test(s.lines[s.lines.length - 1]));
    assert.strictEqual(M.summarize({ mode: 'subscription', backend: 'subscription', limits, error: 'token-expired' }, { now: NOW }).action, 'login', 'an expired login is offered even while an old reading is shown');
    assert.strictEqual(M.summarize({ mode: 'subscription', backend: 'subscription', limits }, { now: NOW }).stale, undefined);

    s = M.summarize({ mode: 'subscription', backend: 'subscription', limits: null, error: 'no-credentials' });
    assert.deepStrictEqual([s.text, s.level, s.action, s.segments], ['—', 'none', 'login', []]); assert(/not logged in/.test(s.lines[0]));
    assert.strictEqual(M.summarize({ mode: 'subscription', backend: 'subscription', limits: null, error: 'network' }).action, 'refresh');

    s = M.summarize({ mode: 'cost', backend: 'api', apiCredentials: false, envNote: 'NOTE', cost: null });
    assert.deepStrictEqual([s.backendLabel, s.backendWarn, s.text], ['API', true, '—']); assert(/no credentials were found/.test(s.backendTitle) && / NOTE$/.test(s.backendTitle));
    const cost = { session: { tokens: 1.2e6, cost: 4.5 }, today: { tokens: 5.2e6, cost: 18.94 }, latestModel: 'us.anthropic.claude-opus-5', days: [], models: new Map([['a', { cost: 1 }], ['b', { cost: 9 }]]) };
    s = M.summarize({ mode: 'cost', backend: 'api', apiCredentials: true, cost });
    assert.deepStrictEqual([s.text, s.backendWarn, s.cost.models.map((m) => m.model)], ['opus-5 5.2M $18.9', false, ['b', 'a']]);
  }

  console.log('METER OK');
})().catch((e) => { console.error('METER FAILED:', e.stack || e.message); process.exit(1); });
