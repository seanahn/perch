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
    "ANTHROPIC_MODEL='nexus-auto[1m]'",
    'PLAIN=value # a comment after an unquoted value',
    'HASHED=a#b',
    'EMPTY=',
    'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'alias gw=claude', 'echo hello', 'not an assignment',
    '  export   SPACED =x',
    '1BAD=x',
  ].join('\n'));
  assert.deepStrictEqual(vars, {
    ANTHROPIC_BASE_URL: 'https://gw.example.com/llm-api', ANTHROPIC_AUTH_TOKEN: 'sk-abc=def', ANTHROPIC_MODEL: 'nexus-auto[1m]',
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
    const vars = { ANTHROPIC_MODEL: 'nexus-auto-bargain[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL: 'nexus-auto-quality[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL: 'nexus-auto-unlimited[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'nexus-auto-bargain[1m]' };
    const c = G.gatewayModels(vars);
    assert.deepStrictEqual([c.defaultModel.value, c.defaultModel.label, c.defaultModel.description], ['', 'nexus-auto-bargain[1m]', 'ANTHROPIC_MODEL in the gateway file']);
    assert.deepStrictEqual(c.models.map((m) => [m.value, m.label]), [['opus', 'nexus-auto-quality[1m]'], ['sonnet', 'nexus-auto-unlimited[1m]'], ['haiku', 'nexus-auto-bargain[1m]']], 'each alias sent as itself, shown as what the gateway receives');
    assert.deepStrictEqual(c.models[0].efforts, ['low', 'medium', 'high']);
    assert(/ANTHROPIC_DEFAULT_OPUS_MODEL in the gateway file; sent as Claude Code's "opus"/.test(c.models[0].description));
    const bare = G.gatewayModels({ ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 't' });
    assert.deepStrictEqual([bare.defaultModel.label, bare.models, /Set ANTHROPIC_MODEL in the file/.test(bare.defaultModel.description)], ['', [], true], 'a file that names no models offers only the default, unnamed, and says what to set');
    assert.deepStrictEqual(G.gatewayModels(undefined).models, []);
  }

  // ---- the same variables as the process's own settings, which Claude Code applies over ~/.claude/settings.json: without the token, to the relay
  assert.deepStrictEqual(G.gatewaySettings(G.gatewayEnv({ ANTHROPIC_BASE_URL: 'https://gw.example.com/llm-api', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key', ANTHROPIC_MODEL: 'nexus-auto[1m]' }), 'http://127.0.0.1:5000'),
    { env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5000', ANTHROPIC_MODEL: 'nexus-auto[1m]' } }, 'Bedrock off and the file\'s names over the user\'s settings; the token stays in the environment; requests go to the relay');
  assert.deepStrictEqual(G.gatewaySettings(undefined), { env: {} });

  console.log('gateway tests passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
