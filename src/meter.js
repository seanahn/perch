'use strict';
// Claude usage and backend switching. Merged from AI Meter (github.com/seanahn/ai-meter, MIT, same author).
// No VS Code dependency: everything here takes its home directory and environment as parameters.
//
// Two modes:
//  - subscription: the Claude Code OAuth token (~/.claude/.credentials.json, or the macOS Keychain) is
//    used to call GET api.anthropic.com/api/oauth/usage. Nothing else is read and no data leaves the
//    machine except that one request.
//  - cost: tokens and estimated spend, computed locally from the Claude Code transcripts under
//    ~/.claude/projects/. Nothing leaves the machine. Used when Claude Code is configured for Bedrock,
//    where there are no subscription limits to show.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const SESSION_MS = 5 * 3600000; // "session" = the last 5 hours, matching Claude's session window

/** Provider-prefixed model ids (Bedrock/Vertex style) that subscription sessions cannot use. */
const PROVIDER_MODEL = /(^|[.:])anthropic\.claude|^arn:aws:bedrock/;

// Anthropic list prices, $/MTok [input, output]. Cache write bills at input ×1.25 (5m TTL) or ×2 (1h TTL);
// cache read at input ×0.1. Bedrock ids carry prefixes, so match by substring. First match wins.
const PRICES = [
  [/fable|mythos/, [10, 50]],
  [/haiku-4/, [1, 5]],
  [/haiku-3-5/, [0.8, 4]],
  [/haiku/, [0.25, 1.25]],
  [/opus-4-[01]-|opus-3/, [15, 75]],
  [/opus/, [5, 25]],
  [/sonnet/, [3, 15]],
];

function priceFor(model) {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return null;
}

/** Estimated $ cost of one usage record ({input, output, cacheRead, cacheW5, cacheW1}). */
function recordCost(model, r) {
  const p = priceFor(model);
  if (!p) return 0;
  const [inP, outP] = p;
  return (r.input * inP + r.output * outP + r.cacheRead * inP * 0.1 + r.cacheW5 * inP * 1.25 + r.cacheW1 * inP * 2) / 1e6;
}

/** Parse one transcript JSONL line into a usage record, or null. */
function parseUsageLine(line) {
  if (line.indexOf('"usage"') === -1) return null;
  let e;
  try { e = JSON.parse(line); } catch (_) { return null; }
  if (!e || e.type !== 'assistant' || !e.message) return null;
  const m = e.message, u = m.usage;
  if (!u || !m.id) return null;
  const cc = u.cache_creation || {};
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  const r = {
    id: m.id,
    ts: new Date(e.timestamp).getTime(),
    model: m.model || 'unknown',
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheW5: Math.max(0, (u.cache_creation_input_tokens || 0) - w1),   // without a TTL breakdown, assume the cheaper 5m rate
    cacheW1: w1,
  };
  if (!(r.ts > 0)) return null;
  if (r.input + r.output + r.cacheRead + r.cacheW5 + r.cacheW1 === 0) return null;   // synthetic entries
  return r;
}

/** The usage endpoint's body → [{kind: 'session'|'weekly_all'|'weekly_scoped', percent, resetsAt, model}], or null. */
function parseUsageResponse(j) {
  if (!j || typeof j !== 'object') return null;
  const limits = [];
  if (Array.isArray(j.limits)) {
    // Legacy shape: {limits: [{kind, percent, resets_at, scope}]}
    for (const l of j.limits) if (l) limits.push({ kind: l.kind, percent: l.percent, resetsAt: l.resets_at, model: l.scope && l.scope.model ? l.scope.model.display_name : null });
  } else {
    // Current shape: {five_hour: {utilization, resets_at}, seven_day: {...}, seven_day_<model>: model-scoped or null}
    if (j.five_hour) limits.push({ kind: 'session', percent: j.five_hour.utilization, resetsAt: j.five_hour.resets_at, model: null });
    if (j.seven_day) limits.push({ kind: 'weekly_all', percent: j.seven_day.utilization, resetsAt: j.seven_day.resets_at, model: null });
    for (const k of Object.keys(j)) {
      const m = /^seven_day_([a-z0-9]+)$/.exec(k);
      if (m && j[k] && typeof j[k].utilization === 'number') limits.push({ kind: 'weekly_scoped', percent: j[k].utilization, resetsAt: j[k].resets_at, model: m[1][0].toUpperCase() + m[1].slice(1) });
    }
  }
  return limits.length ? limits : null;
}

/** "us.anthropic.claude-opus-5" → "opus-5", "claude-haiku-4-5-20251001" → "haiku-4-5". */
function shortModel(model) { return String(model).replace(/^.*claude-/, '').replace(/-v\d+:\d+$/, '').replace(/-\d{8}$/, ''); }

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}
function fmtUsd(n) { return '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)); }

function labelFor(limit) {
  if (limit.kind === 'session') return '5h';
  if (limit.kind === 'weekly_all') return 'wk';
  return limit.model ? limit.model.toLowerCase() : limit.kind;
}
function nameFor(limit) { return limit.kind === 'session' ? '5h session' : limit.kind === 'weekly_all' ? 'Weekly' : 'Weekly ' + (limit.model || 'model'); }

/** '43m' / '4.2h' / '1.6d', or '' when the reset is in the past or unparsable. */
function fmtEta(resetsAt, now = Date.now()) {
  const ms = new Date(resetsAt).getTime() - now;
  if (!(ms > 0)) return '';
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + 'm';
  if (ms < 86400000) return (ms / 3600000).toFixed(1) + 'h';
  return (ms / 86400000).toFixed(1) + 'd';
}
function fmtResetTime(limit) {
  try {
    const d = new Date(limit.resetsAt);
    if (isNaN(d.getTime())) return String(limit.resetsAt);
    return limit.kind === 'session' ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (_) { return String(limit.resetsAt); }
}
function tankBar(remaining) {
  const cells = 10;
  const filled = Math.round(Math.max(0, Math.min(100, remaining)) / 100 * cells);
  return '▮'.repeat(filled) + '▯'.repeat(cells - filled);
}

const ERRORS = {
  'no-credentials': 'not logged in to a Claude subscription on this machine',
  'token-expired': 'the Claude login has expired; run Claude Code once to refresh it',
  network: 'could not reach api.anthropic.com',
  'rate-limited': 'the usage endpoint is rate limiting requests; it will be tried again after a pause',
  'bad-response': 'the usage endpoint returned something unexpected',
  'cost-scan': 'could not read the Claude Code transcripts',
};

/**
 * One description of the meter for every surface (panel footer, status bar).
 * @param {object} s  { mode, backend, apiCredentials, limits, cost, error, fetchedAt, envNote }
 * @param {object} o  { display, showModelWeekly, warnBelow, errorBelow, now }
 */
function summarize(s, o = {}) {
  const now = o.now || Date.now();
  const warnBelow = o.warnBelow === undefined ? 25 : o.warnBelow, errorBelow = o.errorBelow === undefined ? 10 : o.errorBelow;
  const api = s.backend === 'api';
  const out = {
    mode: s.mode, backend: s.backend,
    backendLabel: api ? 'API' : 'sub',
    backendName: api ? 'API / Bedrock' : 'subscription (login)',
    backendWarn: api && !s.apiCredentials,
    segments: [], text: '—', level: 'ok', lines: [], action: 'refresh', error: s.error || null, fetchedAt: s.fetchedAt || null,
  };
  out.backendTitle = (out.backendWarn
    ? 'Claude backend: API / Bedrock, but no credentials were found on this machine (no ~/.aws credentials, AWS_* variables, or ANTHROPIC_API_KEY). The next Claude session may fail to authenticate.'
    : 'Claude backend: ' + out.backendName + '.')
    + ' Click to switch. New tabs use the new backend; running tabs keep theirs.' + (s.envNote ? ' ' + s.envNote : '');

  if (s.mode === 'cost') {
    const c = s.cost;
    if (!c) { out.lines.push('Cost mode: no data yet.'); if (s.error) out.lines.push(ERRORS[s.error] || s.error); return out; }
    if (c.latestModel) out.segments.push({ text: shortModel(c.latestModel), level: 'ok' });
    out.segments.push({ text: fmtTok(c.today.tokens), level: 'ok' }, { text: fmtUsd(c.today.cost), level: 'ok' });
    out.text = out.segments.map((x) => x.text).join(' ');
    out.lines.push('Claude cost, estimated from local transcripts at Anthropic list prices');
    out.lines.push('Session (5h)  ' + fmtTok(c.session.tokens) + ' tokens  ≈' + fmtUsd(c.session.cost));
    out.lines.push('Today  ' + fmtTok(c.today.tokens) + ' tokens  ≈' + fmtUsd(c.today.cost) + (c.latestModel ? '  current model ' + shortModel(c.latestModel) : ''));
    out.cost = { session: c.session, today: c.today, latestModel: c.latestModel, days: c.days, models: [...c.models.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([model, m]) => Object.assign({ model }, m)) };
    return out;
  }

  if (!s.limits) {
    out.level = 'none';
    out.lines.push('Claude usage unavailable: ' + (ERRORS[s.error] || s.error || 'no reading yet') + '.');
    if (s.error === 'no-credentials' || s.error === 'token-expired') out.action = 'login';
    return out;
  }
  const showRemaining = o.display !== 'used';
  const shown = s.limits.filter((l) => o.showModelWeekly !== false || l.kind !== 'weekly_scoped');
  const weeklyAll = shown.find((l) => l.kind === 'weekly_all');
  const sameReset = (a, b) => Math.abs(new Date(a.resetsAt).getTime() - new Date(b.resetsAt).getTime()) < 60000;
  const levelOf = (rem) => (rem < errorBelow ? 'error' : rem < warnBelow ? 'warn' : 'ok');
  const rank = { ok: 0, warn: 1, error: 2 };
  out.lines.push('Claude usage, percent ' + (showRemaining ? 'remaining' : 'used'));
  out.limits = [];
  for (const l of shown) {
    const remaining = Math.max(0, 100 - (l.percent || 0));
    const pct = showRemaining ? remaining : Math.round(l.percent || 0);
    const eta = fmtEta(l.resetsAt, now), level = levelOf(remaining);
    if (rank[level] > rank[out.level]) out.level = level;
    // a model-scoped weekly that resets with the overall weekly shows the model name instead of a duplicate countdown
    const head = (l.kind === 'weekly_scoped' && weeklyAll && sameReset(l, weeklyAll)) ? (l.model || l.kind).toLowerCase() : (eta || labelFor(l));
    out.segments.push({ text: head + ' ' + pct + '%', level, title: nameFor(l) + ': ' + remaining + '% remaining, resets ' + fmtResetTime(l) + (eta ? ' (' + eta + ')' : '') });
    out.lines.push(tankBar(remaining) + '  ' + nameFor(l) + '  ' + remaining + '%  resets ' + fmtResetTime(l) + (eta ? ' (' + eta + ')' : ''));
    out.limits.push({ kind: l.kind, model: l.model, name: nameFor(l), remaining, percent: l.percent || 0, resetsAt: l.resetsAt, reset: fmtResetTime(l), eta, level });
  }
  out.text = out.segments.map((x) => x.text).join(' ');
  if (s.error) { out.stale = true; out.lines.push('Showing the last reading: ' + (ERRORS[s.error] || s.error) + '.'); if (s.error === 'token-expired') out.action = 'login'; }
  return out;
}

function defaultRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.get(options, (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers || {}, body })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

/** Retry-After is seconds or an HTTP date. Returns milliseconds, or 0 when absent or unusable. */
function retryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/**
 * @param {object} [o]
 * @param {string} [o.home]      home directory holding .claude and .aws
 * @param {object} [o.env]       process environment
 * @param {string} [o.platform]
 * @param {(options: object) => Promise<string|{status:number,headers:object,body:string}>} [o.request]  HTTPS GET; replaced in tests
 */
function createMeter({ home = os.homedir(), env = process.env, platform = process.platform, request = defaultRequest } = {}) {
  const claudeDir = path.join(home, '.claude');
  const SETTINGS = path.join(claudeDir, 'settings.json');
  const fileCache = new Map();   // transcript path -> {offset, tail, records}

  /** Read the Claude Code OAuth credentials. Returns {accessToken, expiresAt} or null. */
  function readCredentials() {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).claudeAiOauth;
      if (creds && creds.accessToken) return creds;
    } catch (_) { /* fall through */ }
    if (platform === 'darwin') {
      try {   // Claude Code on macOS stores credentials in the Keychain
        const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 5000 });
        const creds = JSON.parse(raw).claudeAiOauth;
        if (creds && creds.accessToken) return creds;
      } catch (_) { /* no keychain entry */ }
    }
    return null;
  }

  /**
   * One request to the usage endpoint. The HTTP status decides the kind of failure, so a rate limit is never
   * mistaken for a malformed body.
   * @returns {Promise<{limits: object[]|null, error: null|'no-credentials'|'token-expired'|'rate-limited'|'network'|'bad-response', retryAfterMs?: number}>}
   */
  async function fetchUsage(now = Date.now()) {
    const creds = readCredentials();
    if (!creds) return { limits: null, error: 'no-credentials' };
    if (creds.expiresAt && creds.expiresAt < now) return { limits: null, error: 'token-expired' };
    let res;
    try {
      res = await request({ hostname: 'api.anthropic.com', path: '/api/oauth/usage', headers: { Authorization: 'Bearer ' + creds.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, timeout: 10000 });
    } catch (_) { return { limits: null, error: 'network' }; }
    const status = typeof res === 'object' && res ? res.status : 200;
    const body = typeof res === 'object' && res ? res.body : res;
    if (status === 429) return { limits: null, error: 'rate-limited', retryAfterMs: retryAfterMs(res.headers && res.headers['retry-after'], now) };
    if (status === 401 || status === 403) return { limits: null, error: 'token-expired' };
    if (status >= 500) return { limits: null, error: 'network' };
    let limits = null;
    try { limits = parseUsageResponse(JSON.parse(body)); } catch (_) { /* bad body */ }
    return limits ? { limits, error: null } : { limits: null, error: 'bad-response' };
  }

  /** CLAUDE_CODE_USE_BEDROCK from Claude Code's settings files (settings.local.json overrides settings.json), or undefined. */
  function settingsBedrockValue() {
    for (const f of ['settings.local.json', 'settings.json']) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        if (j && j.env && j.env.CLAUDE_CODE_USE_BEDROCK !== undefined) return String(j.env.CLAUDE_CODE_USE_BEDROCK);
      } catch (_) { /* missing or unparsable settings file */ }
    }
    return undefined;
  }

  /** True when the NEXT Claude session will use Bedrock/API. Claude Code applies the settings env block over the
   * inherited process environment, so the settings value decides whenever present and an exported variable only fills the gap. */
  function bedrockConfigured() {
    const sv = settingsBedrockValue();
    const v = sv !== undefined ? sv : env.CLAUDE_CODE_USE_BEDROCK;
    return !!v && v !== '0' && v !== 'false';
  }

  /** Says so when the backend is coming from an exported variable rather than from settings. */
  function envNote() {
    const v = env.CLAUDE_CODE_USE_BEDROCK;
    return (v !== undefined && settingsBedrockValue() === undefined)
      ? 'Currently following CLAUDE_CODE_USE_BEDROCK=' + v + ' from this machine\'s environment; switching writes ~/.claude/settings.json, which Claude Code applies over the environment.' : '';
  }

  /** Set env.CLAUDE_CODE_USE_BEDROCK in ~/.claude/settings.json, preserving the rest of the file. Also reconciles model
   * pins, which are backend-specific: switching to subscription stashes a provider-prefixed saved model and blanks
   * provider-prefixed ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL env pins (an empty settings value unsets the inherited
   * variable for Claude Code); switching back restores them. `stash` is {get(key), set(key, value)}. */
  function setBedrockSetting(on, stash) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') throw new Error(SETTINGS + ' is not valid JSON; fix it by hand before switching (' + e.message + ')'); }
    if (typeof j !== 'object' || Array.isArray(j)) throw new Error(SETTINGS + ' does not hold a JSON object');
    if (!j.env || typeof j.env !== 'object') j.env = {};
    j.env.CLAUDE_CODE_USE_BEDROCK = on ? '1' : '0';
    if (!on) {
      if (typeof j.model === 'string' && PROVIDER_MODEL.test(j.model)) { stash.set('model', j.model); delete j.model; }
      for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
        const pin = env[k];
        if (j.env[k] === undefined && pin && PROVIDER_MODEL.test(pin)) j.env[k] = '';
      }
    } else {
      const m = stash.get('model');
      if (m && j.model === undefined) j.model = m;
      stash.set('model', undefined);
      for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) if (j.env[k] === '') delete j.env[k];
    }
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    const tmp = SETTINGS + '.perch-' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    fs.renameSync(tmp, SETTINGS);      // atomic: a crash mid-write cannot leave Claude Code with a truncated settings file
  }

  /** Rough check for API/Bedrock credentials: an Anthropic API key, a Bedrock bearer token, or any AWS credential source. */
  function apiCredentialsPresent() {
    if (env.ANTHROPIC_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE) return true;
    for (const f of ['credentials', 'config']) { try { fs.accessSync(path.join(home, '.aws', f)); return true; } catch (_) { /* keep looking */ } }
    return false;
  }

  // Transcript files are append-only JSONL; remember how far each was parsed so each poll reads only the appended bytes.
  // One message produces one line per content block, all sharing message.id with identical usage: dedupe on id.
  function readAppended(fp, c, size) {
    const fd = fs.openSync(fp, 'r');
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      c.offset = size;
      const lines = (c.tail + buf.toString('utf8')).split('\n');
      c.tail = lines.pop();
      const ids = new Set(c.records.map((r) => r.id));
      for (const line of lines) { const r = parseUsageLine(line); if (r && !ids.has(r.id)) { ids.add(r.id); c.records.push(r); } }
    } finally { fs.closeSync(fd); }
  }

  /** All usage records at or after cutoffMs, across every project transcript. */
  function collectRecords(cutoffMs) {
    const root = path.join(claudeDir, 'projects');
    const files = new Set();
    let projects;
    try { projects = fs.readdirSync(root); } catch (_) { return []; }
    for (const proj of projects) {
      let names;
      try { names = fs.readdirSync(path.join(root, proj)); } catch (_) { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const fp = path.join(root, proj, n);
        let st;
        try { st = fs.statSync(fp); } catch (_) { continue; }
        if (st.mtimeMs < cutoffMs) continue;
        files.add(fp);
        let c = fileCache.get(fp);
        if (!c || st.size < c.offset) c = { offset: 0, tail: '', records: [] };
        try { if (st.size > c.offset) readAppended(fp, c, st.size); } catch (_) { /* transient read error: retry next poll */ }
        c.records = c.records.filter((r) => r.ts >= cutoffMs);
        fileCache.set(fp, c);
      }
    }
    for (const fp of fileCache.keys()) if (!files.has(fp)) fileCache.delete(fp);
    const seen = new Set(), out = [];
    for (const fp of files) for (const r of fileCache.get(fp).records) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    return out;
  }

  /** Token totals and estimated cost for the 5h session, today, and the last 7 days. */
  function computeCostStats(now = Date.now()) {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const dayStart = midnight.getTime(), sessionStart = now - SESSION_MS;
    const days = [];   // oldest first, 7 entries ending today
    for (let i = 6; i >= 0; i--) { const d = new Date(midnight); d.setDate(d.getDate() - i); days.push({ start: d.getTime(), label: d.toLocaleDateString([], { weekday: 'short' }), tokens: 0, cost: 0 }); }
    const stats = { session: { tokens: 0, cost: 0 }, today: { tokens: 0, cost: 0 }, days, latestModel: null, models: new Map() };
    let latestTs = 0;
    for (const r of collectRecords(Math.min(days[0].start, sessionStart))) {
      const cost = recordCost(r.model, r);
      const tokens = r.input + r.output + r.cacheRead + r.cacheW5 + r.cacheW1;
      if (r.ts > latestTs) { latestTs = r.ts; stats.latestModel = r.model; }
      if (r.ts >= sessionStart) { stats.session.tokens += tokens; stats.session.cost += cost; }
      for (let i = days.length - 1; i >= 0; i--) if (r.ts >= days[i].start) { days[i].tokens += tokens; days[i].cost += cost; break; }
      if (r.ts >= dayStart) {
        stats.today.tokens += tokens; stats.today.cost += cost;
        let m = stats.models.get(r.model);
        if (!m) stats.models.set(r.model, m = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: !priceFor(r.model) });
        m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead; m.cacheWrite += r.cacheW5 + r.cacheW1; m.cost += cost;
      }
    }
    return stats;
  }

  return { claudeDir, settingsPath: SETTINGS, readCredentials, fetchUsage, settingsBedrockValue, bedrockConfigured, envNote, setBedrockSetting, apiCredentialsPresent, collectRecords, computeCostStats };
}

module.exports = { createMeter, summarize, retryAfterMs, parseUsageResponse, parseUsageLine, priceFor, recordCost, shortModel, fmtTok, fmtUsd, fmtEta, fmtResetTime, labelFor, tankBar, PROVIDER_MODEL, ERRORS };
