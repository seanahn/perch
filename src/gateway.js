'use strict';
// A gateway: an Anthropic-compatible endpoint that Claude Code reaches through its environment (ANTHROPIC_BASE_URL and a
// token), as a company's LLM proxy is. The variables live in a file of the user's, in the form a shell reads
// (`export KEY=VALUE`), so the same file serves a terminal launcher and perch. A tab on the gateway runs its Claude Code
// process with those variables added; nothing is written to Claude Code's settings, and the token is never in a file of
// perch's. No VS Code dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDER_MODEL } = require('./meter');

const DEFAULT_FILE = '~/.config/gateway-claude/env';
const URL_VAR = 'ANTHROPIC_BASE_URL';
const TOKEN_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** What a new file holds: the names Claude Code reads, with nothing in them. */
const TEMPLATE = [
  '# Claude Code through a gateway: perch adds these to the environment of a tab opened on the gateway.',
  '# Lines are read as a shell would: export KEY=VALUE, quotes allowed, # starts a comment.',
  'export ANTHROPIC_BASE_URL=',
  'export ANTHROPIC_AUTH_TOKEN=',
  '# How Claude Code\'s model names map to the gateway\'s, if they differ:',
  '# export ANTHROPIC_MODEL=',
  '# export ANTHROPIC_DEFAULT_OPUS_MODEL=',
  '# export ANTHROPIC_DEFAULT_SONNET_MODEL=',
  '# export ANTHROPIC_DEFAULT_HAIKU_MODEL=',
  '# Keep the prompt cache for an hour. Claude Code does that by itself only on a claude.ai login; on a token it sends',
  '# nothing and gets five minutes, after which the next turn re-sends the whole conversation at the cache-write rate.',
  '# The hour costs more per write (2x input instead of 1.25x) and is cheaper by the first pause longer than five',
  '# minutes. Remove the line if the gateway rejects the request.',
  'export ENABLE_PROMPT_CACHING_1H=1',
  '',
].join('\n');

/** `~` and `~/x` to the home directory. */
function expandHome(p, home = os.homedir()) {
  const s = String(p || '').trim();
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

/** Where the file is: the setting, or the default. */
function gatewayFile(setting, home) { return expandHome(setting || DEFAULT_FILE, home); }

/**
 * The assignments in a shell-style env file. `export K=V` and `K=V`; a value may be in single or double quotes, and an
 * unquoted one ends at a `#`. Lines that are not assignments are passed over, so a comment or a stray command breaks nothing.
 * @returns {Record<string,string>}
 */
function parseEnvFile(text) {
  const vars = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(v);   // what follows a closing quote is a comment, or nothing a shell would keep
    if (quoted) v = quoted[1] !== undefined ? quoted[1] : quoted[2];
    else { const hash = v.search(/\s#/); if (hash >= 0) v = v.slice(0, hash).trim(); }
    vars[m[1]] = v;
  }
  return vars;
}

/**
 * The gateway as the file describes it.
 * @param {string} file
 * @returns {{ file: string, exists: boolean, ok: boolean, error: null|'missing'|'unreadable'|'no-url'|'no-token', vars: Record<string,string> }}
 */
function readGateway(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { file, exists: e.code !== 'ENOENT', ok: false, error: e.code === 'ENOENT' ? 'missing' : 'unreadable', vars: {} }; }
  const vars = parseEnvFile(text);
  const error = !vars[URL_VAR] ? 'no-url' : !TOKEN_VARS.some((k) => vars[k]) ? 'no-token' : null;
  return { file, exists: true, ok: !error, error, vars };
}

/** The variables a tab's process is given: the file's, and Bedrock turned off unless the file says otherwise, since a
 * gateway speaks the Anthropic protocol. */
function gatewayEnv(vars) { return Object.assign({ CLAUDE_CODE_USE_BEDROCK: '0' }, vars || {}); }

/**
 * The same variables as settings for that one process (the SDK's `settings`, Claude Code's --settings). Claude Code applies
 * the `env` block of ~/.claude/settings.json over a process's environment, so a window set to API / Bedrock there
 * (CLAUDE_CODE_USE_BEDROCK=1) would send a gateway tab to Bedrock whatever its environment said; settings given on the
 * command line are applied over the user's, and put the gateway's variables back on top. The token is left out: these
 * settings are an argument of the process, which other users of the machine can read, and the environment carries it.
 * `baseUrl` is where the process is to send its requests (the relay), in place of the file's.
 * @returns {{ env: Record<string,string> }}
 */
function gatewaySettings(env, baseUrl) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!TOKEN_VARS.includes(k) && typeof v === 'string') out[k] = v;
  if (baseUrl) out[URL_VAR] = baseUrl;
  return { env: out };
}

/**
 * What a pinned gateway also sets in settings.json and a tab off it must not keep: the model slots, which name the
 * gateway's own models (a gateway's login script may point the Opus, Sonnet and Haiku slots at its routes) that the
 * subscription and Bedrock refuse, and the gateway's switch-off of Anthropic's betas.
 */
const OFF_GATEWAY_VARS = ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'];

/**
 * The switch a gateway's setup also throws, since a gateway serves none of it: Claude Code's side traffic (feature flags,
 * telemetry, error reports, update checks). A subscription tab off the gateway must not keep it. With it on, Claude Code
 * lists a short set of models that can be a release behind: seen 2026-11-10 with Claude Code 2.1.322, four of them, the
 * "Fable" among them still 5.1 the day after 5.2, where the same login without the switch listed thirteen, 5.2 included.
 * It is cleared with '': Claude Code read '0' as on too. A tab on API / Bedrock keeps the file's value: its list does not
 * depend on the switch, and its conversations do not go to Anthropic, so nothing is gained by sending Anthropic the rest.
 * (docs/notes/114-quality-and-open-work.md, Backend-correct tabs, 5.)
 */
const TRAFFIC_VAR = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';

/**
 * Settings that put one tab on a backend of its own, whatever ~/.claude/settings.json says for the window: command-line
 * settings rank above the file, so CLAUDE_CODE_USE_BEDROCK given here decides. The model slots are set as offGatewaySettings
 * sets them, for the same reason: a Bedrock id the file pins for the window is no name the subscription knows.
 * @param {boolean} bedrock  true for API / Bedrock, false for the subscription
 * @param {Record<string,string|undefined>} [inherited]  the environment the tab's Claude Code inherits (this process's)
 * @returns {{ env: Record<string,string> }}
 */
function ownBackendSettings(bedrock, inherited = process.env) {
  const env = { CLAUDE_CODE_USE_BEDROCK: bedrock ? '1' : '0' };
  for (const k of OFF_GATEWAY_VARS) {
    const v = typeof inherited[k] === 'string' ? inherited[k] : '';
    env[k] = (bedrock || !PROVIDER_MODEL.test(v)) ? v : '';
  }
  return { env };
}

/**
 * Settings that take a Claude tab OFF a gateway the machine pins in ~/.claude/settings.json for every Claude Code
 * (ANTHROPIC_BASE_URL + an apiKeyHelper). Command-line settings rank above the file, so empty values clear the pin
 * (verified 2026-10-22: the CLI then left the gateway). The model is cleared too — the gateway's own name for a model
 * is not one a subscription or Bedrock knows, and would 400 — and so are the model slots
 * (OFF_GATEWAY_VARS): each goes back to what this process inherited, the machine's own export, when that suits the backend
 * (a Bedrock id such as us.anthropic.claude-sonnet-4-6 only on Bedrock), else to '', Claude Code's default. On the
 * subscription the gateway's traffic switch (TRAFFIC_VAR) goes back the same way: to the machine's own export, else to ''.
 * @param {boolean} bedrock  true for API / Bedrock, false for the subscription
 * @param {Record<string,string|undefined>} [inherited]  the environment the tab's Claude Code inherits (this process's)
 * @returns {{ env: Record<string,string>, apiKeyHelper: string, model: string }}
 */
function offGatewaySettings(bedrock, inherited = process.env) {
  const env = { CLAUDE_CODE_USE_BEDROCK: bedrock ? '1' : '0', ANTHROPIC_BASE_URL: '' };
  for (const k of OFF_GATEWAY_VARS) {
    const v = typeof inherited[k] === 'string' ? inherited[k] : '';
    env[k] = (bedrock || !PROVIDER_MODEL.test(v)) ? v : '';
  }
  if (!bedrock) env[TRAFFIC_VAR] = typeof inherited[TRAFFIC_VAR] === 'string' ? inherited[TRAFFIC_VAR] : '';
  return { env, apiKeyHelper: '', model: '' };
}

/**
 * The models a tab on the gateway can choose, from the file: Claude Code's three aliases, each sent as the gateway name the
 * file maps it to (ANTHROPIC_DEFAULT_OPUS_MODEL and the others), and the default, ANTHROPIC_MODEL. Claude Code's own
 * catalog does not apply: its ids would go to the gateway as they are, and the gateway routes by its own names.
 * @returns {{ models: {value: string, label: string, description: string, efforts: string[]}[], defaultModel: {value: string, label: string, description: string, efforts: string[]} }}
 */
function gatewayModels(vars) {
  const v = vars || {};
  const EFFORTS = ['low', 'medium', 'high'];   // a gateway's names say nothing of effort; Claude Code's usual levels are offered
  const defaultModel = { value: '', label: v.ANTHROPIC_MODEL || '', description: v.ANTHROPIC_MODEL ? 'ANTHROPIC_MODEL in the gateway file' : 'The gateway file sets no ANTHROPIC_MODEL: Claude Code sends the name it would use anyway (ANTHROPIC_MODEL from the environment, or its own default), which the gateway may not know. Set ANTHROPIC_MODEL in the file.', efforts: EFFORTS };
  const models = [];
  for (const [alias, key] of [['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']]) {
    if (!v[key]) continue;
    models.push({ value: alias, label: v[key], description: `${key} in the gateway file; sent as Claude Code's "${alias}"`, efforts: EFFORTS });
  }
  return { models, defaultModel };
}

/** Effort levels a gateway publishes as name suffixes (`opus-high`), in the menu's order. */
const NAME_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_ORDER = ['opus', 'fable', 'sonnet', 'haiku'];
const GROUP_ORDER = ['Claude', 'OpenAI', 'Other', 'Routers'];
function groupOf(base) {
  if (CLAUDE_ORDER.includes(base)) return 'Claude';
  if (/^gpt-/.test(base)) return 'OpenAI';
  if (/^nexus-auto/.test(base)) return 'Routers';
  return 'Other';
}

/**
 * The models a tab on the gateway can choose, from the names the gateway lists (GET /v1/models): one entry per model, its
 * effort variants (`opus-high`) folded into its efforts, the `anthropic/` duplicates dropped, grouped Claude, OpenAI,
 * other, routers. Each is sent as `anthropic/<name>[1m]`, which Claude Code passes through as it is; the effort chosen
 * goes into the name (gatewayModelName), since the variants are how the gateway pins effort. The default stays the
 * file's ANTHROPIC_MODEL, sent by no name at all, so it offers no effort.
 * @param {string[]} ids  the gateway's model ids
 * @param {Record<string,string>} [vars]  the gateway file's variables
 */
function gatewayCatalog(ids, vars) {
  const names = new Set((ids || []).filter((s) => typeof s === 'string' && s).map((s) => s.replace(/^anthropic\//, '')));
  const efforts = new Map();
  for (const n of names) {
    const m = /^(.*)-(low|medium|high|xhigh|max)$/.exec(n);
    if (m && names.has(m[1])) continue;               // a variant: counted under its model below
    efforts.set(n, NAME_EFFORTS.filter((e) => names.has(`${n}-${e}`)));
  }
  const rank = (b) => [GROUP_ORDER.indexOf(groupOf(b)), groupOf(b) === 'Claude' ? CLAUDE_ORDER.indexOf(b) : 0, b];
  const bases = [...efforts.keys()].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); });
  const models = bases.map((b) => {
    const group = groupOf(b);
    const description = group === 'Claude' ? `${b} on the gateway`
      : group === 'Routers' ? 'The gateway picks a model for each request'
      : 'Not a Claude model: the gateway translates, and tools or thinking may behave differently in Claude Code';
    return { value: `anthropic/${b}[1m]`, label: b, group, description, efforts: efforts.get(b), effortInName: true };
  });
  const defaultModel = Object.assign({}, gatewayModels(vars).defaultModel, { efforts: [] });
  return { models, defaultModel };
}

/** The name sent for a gateway model at an effort: `anthropic/opus[1m]` at high is `anthropic/opus-high[1m]`. */
function gatewayModelName(value, effort) {
  const m = /^(.*?)(\[1m\])?$/i.exec(String(value || ''));
  return m[1] + (effort ? '-' + effort : '') + (m[2] || '');
}

/**
 * The model ids the gateway lists for the file's token, or null when it cannot say (no file, no network, an error).
 * @param {Record<string,string>} vars  the gateway file's variables
 * @param {{ timeoutMs?: number, fetch?: Function }} [opts]
 * @returns {Promise<string[]|null>}
 */
async function fetchGatewayModels(vars, opts = {}) {
  const v = vars || {};
  const token = TOKEN_VARS.map((k) => v[k]).find(Boolean);
  if (!v[URL_VAR] || !token) return null;
  const doFetch = opts.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 10000);
  try {
    const res = await doFetch(String(v[URL_VAR]).replace(/\/+$/, '') + '/v1/models', { headers: { Authorization: 'Bearer ' + token, 'x-api-key': token }, signal: ctl.signal });
    if (!res || !res.ok) return null;
    const body = await res.json();
    const ids = Array.isArray(body && body.data) ? body.data.map((m) => m && m.id).filter((x) => typeof x === 'string') : [];
    return ids.length ? ids : null;
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

/** What is wrong with the file, in a sentence that names it. */
function describe(gw) {
  const why = { missing: 'does not exist', unreadable: 'cannot be read', 'no-url': 'sets no ' + URL_VAR, 'no-token': 'sets no ' + TOKEN_VARS.join(' or ') }[gw.error];
  return why ? `${gw.file} ${why}.` : '';
}

/** Make the file from the template, readable by its owner only. Leaves an existing file alone. */
function createTemplate(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE, { flag: 'wx', mode: 0o600 });
}

module.exports = { DEFAULT_FILE, URL_VAR, TOKEN_VARS, TEMPLATE, expandHome, gatewayFile, parseEnvFile, readGateway, gatewayEnv, gatewaySettings, offGatewaySettings, ownBackendSettings, gatewayModels, gatewayCatalog, gatewayModelName, fetchGatewayModels, describe, createTemplate };
