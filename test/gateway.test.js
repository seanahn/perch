'use strict';
// The gateway file: how it is read, what makes it usable, and the environment a tab gets from it. Throwaway files only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../src/gateway');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-gateway-'));
const file = path.join(tmp, 'env');
try {
  // ---- the path: the setting, or the default, with ~ expanded
  assert.strictEqual(G.gatewayFile('', '/home/u'), '/home/u/.config/gateway-claude/env', 'the default lives under the home directory');
  assert.strictEqual(G.gatewayFile('~/x/env', '/home/u'), '/home/u/x/env');
  assert.strictEqual(G.gatewayFile('/etc/gw', '/home/u'), '/etc/gw', 'an absolute path is taken as it is');
  assert.strictEqual(G.expandHome('~', '/home/u'), '/home/u');
  assert.strictEqual(G.expandHome('~user/x', '/home/u'), '~user/x', 'another user\'s home is not guessed at');

  // ---- parsing: what a shell would read
  const vars = G.parseEnvFile([
    '# a comment', '',
    'export ANTHROPIC_BASE_URL=https://gw.example.com/llm-api',
    'export ANTHROPIC_AUTH_TOKEN="sk-abc=def"   # trailing comment after a quoted value',
    "ANTHROPIC_MODEL='router-auto[1m]'",
    'PLAIN=value # a comment after an unquoted value',
    'HASHED=a#b',
    'EMPTY=',
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'alias gw=claude', 'echo hello', 'not an assignment',
    '  export   SPACED =x',
    '1BAD=x',
  ].join('\n'));
  assert.deepStrictEqual(vars, {
    ANTHROPIC_BASE_URL: 'https://gw.example.com/llm-api', ANTHROPIC_AUTH_TOKEN: 'sk-abc=def', ANTHROPIC_MODEL: 'router-auto[1m]',
    PLAIN: 'value', HASHED: 'a#b', EMPTY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, 'export or not, quotes stripped, a # with a space before it ends an unquoted value, a # inside a word does not; other lines are passed over');
  assert.deepStrictEqual(G.parseEnvFile('A=1\r\nB=2\r\n'), { A: '1', B: '2' }, 'Windows line ends');
  assert.deepStrictEqual(G.parseEnvFile(''), {}); assert.deepStrictEqual(G.parseEnvFile(null), {});

  // ---- reading: missing, incomplete, usable
  let gw = G.readGateway(file);
  assert.deepStrictEqual([gw.exists, gw.ok, gw.error, gw.vars, gw.file], [false, false, 'missing', {}, file], 'no file');
  assert.strictEqual(G.describe(gw), file + ' does not exist.');
  fs.writeFileSync(file, '# nothing set\nexport ANTHROPIC_AUTH_TOKEN=\n');
  gw = G.readGateway(file);
  assert.deepStrictEqual([gw.exists, gw.ok, gw.error], [true, false, 'no-url'], 'a file with no URL');
  assert.strictEqual(G.describe(gw), file + ' sets no ANTHROPIC_BASE_URL.');
  fs.writeFileSync(file, 'export ANTHROPIC_BASE_URL=https://gw.example.com\nexport ANTHROPIC_AUTH_TOKEN=\n');
  gw = G.readGateway(file);
  assert.deepStrictEqual([gw.ok, gw.error], [false, 'no-token'], 'a URL with an empty token is not usable');
  assert.strictEqual(G.describe(gw), file + ' sets no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.');
  fs.writeFileSync(file, 'export ANTHROPIC_BASE_URL=https://gw.example.com\nexport ANTHROPIC_API_KEY=k\n');
  gw = G.readGateway(file);
  assert.deepStrictEqual([gw.ok, gw.error, G.describe(gw)], [true, null, ''], 'an API key serves as the token');
  fs.writeFileSync(file, 'export ANTHROPIC_BASE_URL=https://gw.example.com\nexport ANTHROPIC_AUTH_TOKEN=t\nexport ANTHROPIC_MODEL=m\n');
  gw = G.readGateway(file);
  assert.deepStrictEqual([gw.ok, gw.vars.ANTHROPIC_MODEL], [true, 'm']);
  const dir = path.join(tmp, 'adir'); fs.mkdirSync(dir);
  gw = G.readGateway(dir);
  assert.deepStrictEqual([gw.exists, gw.ok, gw.error], [true, false, 'unreadable'], 'a path that is not a file');
  assert.strictEqual(G.describe(gw), dir + ' cannot be read.');

  // ---- the environment a tab gets: the file's variables, with Bedrock off unless the file says otherwise
  assert.deepStrictEqual(G.gatewayEnv({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' }), { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' });
  assert.deepStrictEqual(G.gatewayEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }), { CLAUDE_CODE_USE_BEDROCK: '1' }, 'the file has the last word');
  assert.deepStrictEqual(G.gatewayEnv(undefined), { CLAUDE_CODE_USE_BEDROCK: '0' });

  // ---- the template: made once, for the owner only, and never over an existing file
  const fresh = path.join(tmp, 'deep', 'er', 'env');
  G.createTemplate(fresh);
  const made = fs.readFileSync(fresh, 'utf8');
  assert.strictEqual(made, G.TEMPLATE);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o600, 'readable by its owner only: it will hold a token');
  const parsed = G.readGateway(fresh);
  assert.deepStrictEqual([parsed.exists, parsed.ok, parsed.error], [true, false, 'no-url'], 'the template names the variables and sets none: not usable until filled in');
  assert.deepStrictEqual(Object.keys(parsed.vars), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ENABLE_PROMPT_CACHING_1H'], 'the model names are comments, for the user to uncomment; the hour-long cache is on');
  assert.strictEqual(parsed.vars.ENABLE_PROMPT_CACHING_1H, '1', 'a token login gets five minutes from Claude Code; the hour is cheaper by the first pause over five minutes');
  fs.writeFileSync(fresh, 'export ANTHROPIC_BASE_URL=u\nexport ANTHROPIC_AUTH_TOKEN=t\n');
  assert.throws(() => G.createTemplate(fresh), /EEXIST/, 'an existing file is left alone');
  assert.strictEqual(fs.readFileSync(fresh, 'utf8'), 'export ANTHROPIC_BASE_URL=u\nexport ANTHROPIC_AUTH_TOKEN=t\n');

  // the models a tab on the gateway may choose: the file's names, carried by Claude Code's aliases; the default is ANTHROPIC_MODEL
  {
    const vars = { ANTHROPIC_MODEL: 'router-auto-bargain[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'router-auto-quality[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'router-auto-unlimited[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'router-auto-bargain[1m]' };
    const c = G.gatewayModels(vars);
    assert.deepStrictEqual([c.defaultModel.value, c.defaultModel.label, c.defaultModel.description], ['', 'router-auto-bargain[1m]', 'ANTHROPIC_MODEL in the gateway file']);
    assert.deepStrictEqual(c.models.map((m) => [m.value, m.label]), [['opus', 'router-auto-quality[1m]'], ['sonnet', 'router-auto-unlimited[1m]'], ['haiku', 'router-auto-bargain[1m]']], 'each alias sent as itself, shown as what the gateway receives');
    assert.deepStrictEqual(c.models[0].efforts, ['low', 'medium', 'high']);
    assert(/ANTHROPIC_DEFAULT_OPUS_MODEL in the gateway file; sent as Claude Code's "opus"/.test(c.models[0].description));
    const bare = G.gatewayModels({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' });
    assert.deepStrictEqual([bare.defaultModel.label, bare.models, /Set ANTHROPIC_MODEL in the file/.test(bare.defaultModel.description)], ['', [], true], 'a file that names no models offers only the default, unnamed, and says what to set');
    assert.deepStrictEqual(G.gatewayModels(undefined).models, []);
  }

  // the gateway's own list (GET /v1/models), as ai-gateway.c3ci.cloud gave it on 2026-11-10: 100 names, 13 models
  {
    const E = ['low', 'medium', 'high', 'xhigh', 'max'];
    const bare = [];
    const add = (b, effs) => { bare.push(b); for (const e of effs) bare.push(`${b}-${e}`); };
    for (const b of ['fable', 'gpt-astra', 'gpt-sol', 'gpt-terra', 'haiku', 'opus']) add(b, E);
    add('gpt-luna', ['high', 'xhigh', 'max']); add('sonnet', ['medium', 'high', 'xhigh', 'max']);
    for (const r of ['nexus-auto', 'nexus-auto-bargain', 'nexus-auto-fixed', 'nexus-auto-quality', 'nexus-auto-unlimited']) add(r, []);
    const ids = [...bare, ...bare.map((n) => 'anthropic/' + n)];
    assert.strictEqual(ids.length, 100);
    const c = G.gatewayCatalog(ids, { ANTHROPIC_MODEL: 'nexus-auto-bargain[1m]' });
    assert.deepStrictEqual(c.models.map((m) => m.label), ['opus', 'fable', 'sonnet', 'haiku', 'gpt-astra', 'gpt-luna', 'gpt-sol', 'gpt-terra', 'nexus-auto', 'nexus-auto-bargain', 'nexus-auto-fixed', 'nexus-auto-quality', 'nexus-auto-unlimited'], 'one entry per model, Claude first, routers last');
    assert.deepStrictEqual([...new Set(c.models.map((m) => m.group))], ['Claude', 'OpenAI', 'Routers']);
    const by = (l) => c.models.find((m) => m.label === l);
    assert.deepStrictEqual([by('opus').value, by('opus').efforts, by('opus').effortInName], ['anthropic/opus[1m]', E, true], 'sent with the prefix Claude Code passes through, and the 1M window');
    assert.deepStrictEqual(by('sonnet').efforts, ['medium', 'high', 'xhigh', 'max'], 'only the levels the gateway names');
    assert.deepStrictEqual(by('gpt-luna').efforts, ['high', 'xhigh', 'max']);
    assert.deepStrictEqual(by('nexus-auto').efforts, [], 'a router has no effort');
    assert(/Not a Claude model/.test(by('gpt-sol').description));
    assert.deepStrictEqual([c.defaultModel.label, c.defaultModel.efforts], ['nexus-auto-bargain[1m]', []], 'the default is still the file\'s, sent by no name, so no effort');
    assert.deepStrictEqual(G.gatewayCatalog(['nexus-auto-x-high'], {}).models.map((m) => [m.label, m.efforts]), [['nexus-auto-x-high', []]], 'a suffix with no model of that name is part of the name');
    assert.deepStrictEqual(G.gatewayCatalog(undefined, {}).models, []);
  }

  // the name a gateway model is sent by, at an effort
  assert.strictEqual(G.gatewayModelName('anthropic/opus[1m]', 'high'), 'anthropic/opus-high[1m]');
  assert.strictEqual(G.gatewayModelName('anthropic/opus[1m]', ''), 'anthropic/opus[1m]');
  assert.strictEqual(G.gatewayModelName('anthropic/fable', 'max'), 'anthropic/fable-max');

  // asking the gateway: the token goes in the headers, a failure is null, never a throw
  (async () => {
    let seen = null;
    const ok = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ data: [{ id: 'opus' }, { id: 'opus-high' }] }) }; };
    assert.deepStrictEqual(await G.fetchGatewayModels({ ANTHROPIC_BASE_URL: 'https://gw/llm-api/', ANTHROPIC_AUTH_TOKEN: 'sk-t' }, { fetch: ok }), ['opus', 'opus-high']);
    assert.strictEqual(seen.url, 'https://gw/llm-api/v1/models');
    assert.strictEqual(seen.init.headers.Authorization, 'Bearer sk-t');
    assert.strictEqual(await G.fetchGatewayModels({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' }, { fetch: async () => ({ ok: false }) }), null, 'a refusal');
    assert.strictEqual(await G.fetchGatewayModels({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' }, { fetch: async () => { throw new Error('down'); } }), null, 'no network');
    assert.strictEqual(await G.fetchGatewayModels({ ANTHROPIC_BASE_URL: 'u' }, { fetch: ok }), null, 'no token: not asked');
  })().catch((e) => { console.error(e); process.exitCode = 1; });

  // ---- the same variables as the process's own settings, which Claude Code applies over ~/.claude/settings.json: without the token, to the relay
  assert.deepStrictEqual(G.gatewaySettings(G.gatewayEnv({ ANTHROPIC_BASE_URL: 'https://gw.example.com/llm-api', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: 'router-auto[1m]' }), 'http://127.0.0.1:5000'),
    { env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000', ANTHROPIC_MODEL: 'router-auto[1m]' } }, 'Bedrock off and the file\'s names over the user\'s settings; the token stays in the environment; requests go to the relay');
  assert.deepStrictEqual(G.gatewaySettings(undefined), { env: {} });

  // ---- settings that take a non-gateway tab OFF a pod-pinned gateway: clear the base URL + apiKeyHelper + model, set the
  // Bedrock flag, and put the model slots back to what the tab inherits when that suits the backend (a Bedrock id only on Bedrock)
  const noSlots = { ANTHROPIC_MODEL: '', ANTHROPIC_SMALL_FAST_MODEL: '', ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '', CLAUDE_CODE_SUBAGENT_MODEL: '', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '' };
  // a gateway's setup also switches Claude Code's side traffic off; left on, the subscription's model list is the short built-in one
  const TRAFFIC = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
  assert.deepStrictEqual(G.offGatewaySettings(false, {}), { env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: '', ...noSlots, [TRAFFIC]: '' }, apiKeyHelper: '', model: '' }, 'subscription: Bedrock off, the pinned gateway, its model slots and its traffic switch cleared');
  assert.deepStrictEqual(G.offGatewaySettings(true, {}), { env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: '', ...noSlots }, apiKeyHelper: '', model: '' }, 'API/Bedrock: Bedrock on, the pinned gateway and its model slots cleared; the traffic switch stays as the file has it');
  const pod = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' };   // a pod's own export, and a first-party pin
  assert.strictEqual(G.offGatewaySettings(true, pod).env.ANTHROPIC_MODEL, 'us.anthropic.claude-sonnet-4-6', 'API/Bedrock: the pod\'s Bedrock model comes back');
  assert.strictEqual(G.offGatewaySettings(false, pod).env.ANTHROPIC_MODEL, '', 'subscription: a Bedrock id is not carried over');
  assert.strictEqual(G.offGatewaySettings(false, pod).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4-5', 'subscription: a first-party pin comes back');
  assert.strictEqual(G.offGatewaySettings(false, { [TRAFFIC]: '1' }).env[TRAFFIC], '1', 'subscription: a traffic switch the machine itself exports is not the gateway\'s, and is kept');
  assert.strictEqual(G.offGatewaySettings(false).env.CLAUDE_CODE_USE_BEDROCK, '0', 'the inherited environment defaults to this process\'s');
  // a backend of one tab's own, whatever the window's file says: only the switch and the model slots, nothing of a gateway touched
  assert.deepStrictEqual(G.ownBackendSettings(true, {}), { env: { CLAUDE_CODE_USE_BEDROCK: '1', ...noSlots } }, 'API/Bedrock for this tab: no base URL, helper or model cleared, since no gateway is pinned');
  assert.deepStrictEqual([G.ownBackendSettings(false, pod).env.CLAUDE_CODE_USE_BEDROCK, G.ownBackendSettings(false, pod).env.ANTHROPIC_MODEL, G.ownBackendSettings(true, pod).env.ANTHROPIC_MODEL], ['0', '', 'us.anthropic.claude-sonnet-4-6'], 'subscription for this tab: a Bedrock id the machine pins is not carried over; on Bedrock it is');

  console.log('gateway tests passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
