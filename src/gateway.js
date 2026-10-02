'use strict';
// A gateway: an Anthropic-compatible endpoint that Claude Code reaches through its environment (ANTHROPIC_BASE_URL and a
// token), as a company's LLM proxy is. The variables live in a file of the user's, in the form a shell reads
// (`export KEY=VALUE`), so the same file serves a terminal launcher and perch. A tab on the gateway runs its Claude Code
// process with those variables added; nothing is written to Claude Code's settings, and the token is never in a file of
// perch's. No VS Code dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');

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
 * gateway speaks the Anthropic protocol. (A setting in ~/.claude/settings.json still wins over these: Claude Code applies
 * its settings over the environment, so a window on API / Bedrock has to be switched to the subscription first.) */
function gatewayEnv(vars) { return Object.assign({ CLAUDE_CODE_USE_BEDROCK: '0' }, vars || {}); }

/**
 * The models a tab on the gateway can choose, from the file: Claude Code's three aliases, each sent as the gateway name the
 * file maps it to (ANTHROPIC_DEFAULT_OPUS_MODEL and the others), and the default, ANTHROPIC_MODEL. Claude Code's own
 * catalog does not apply: its ids would go to the gateway as they are, and the gateway routes by its own names.
 * @returns {{ models: {value: string, label: string, description: string, efforts: string[]}[], defaultModel: {value: string, label: string, description: string, efforts: string[]} }}
 */
function gatewayModels(vars) {
  const v = vars || {};
  const EFFORTS = ['low', 'medium', 'high'];   // a gateway's names say nothing of effort; Claude Code's usual levels are offered
  const defaultModel = { value: '', label: v.ANTHROPIC_MODEL || 'the gateway\'s default', description: v.ANTHROPIC_MODEL ? 'ANTHROPIC_MODEL in the gateway file' : 'The gateway file sets no ANTHROPIC_MODEL; the gateway decides', efforts: EFFORTS };
  const models = [];
  for (const [alias, key] of [['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'], ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']]) {
    if (!v[key]) continue;
    models.push({ value: alias, label: v[key], description: `${key} in the gateway file; sent as Claude Code's "${alias}"`, efforts: EFFORTS });
  }
  return { models, defaultModel };
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

module.exports = { DEFAULT_FILE, URL_VAR, TOKEN_VARS, TEMPLATE, expandHome, gatewayFile, parseEnvFile, readGateway, gatewayEnv, gatewayModels, describe, createTemplate };
