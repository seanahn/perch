'use strict';
// Codex on Bedrock: the settings, the --config overrides, and the model ids.
const assert = require('assert');
const B = require('../src/codexBedrock');

// ---- settings: perch's own first, then the environment, then Claude Code's settings env; Mantle wants its own region
const cfgOf = (o) => (k) => o[k];
assert.deepStrictEqual(B.bedrockSettings(), { endpoint: 'runtime', provider: 'amazon-bedrock-runtime', region: 'us-east-1', profile: '' }, 'nothing set: the runtime endpoint, us-east-1 for want of a region, the default credential chain');
assert.deepStrictEqual(B.bedrockSettings({ env: { AWS_REGION: 'us-west-2', AWS_PROFILE: 'stage2' } }), { endpoint: 'runtime', provider: 'amazon-bedrock-runtime', region: 'us-west-2', profile: 'stage2' }, 'the runtime endpoint follows the environment\'s region and profile');
assert.deepStrictEqual(B.bedrockSettings({ cfg: cfgOf({ 'codex.bedrock.endpoint': 'mantle' }), env: { AWS_REGION: 'us-west-2', AWS_PROFILE: 'stage2' } }), { endpoint: 'mantle', provider: 'amazon-bedrock', region: 'us-east-1', profile: 'stage2' }, 'Mantle keeps its own region, since the environment\'s may not have it');
assert.deepStrictEqual(B.bedrockSettings({ cfg: cfgOf({ 'codex.bedrock.endpoint': 'runtime' }), env: { AWS_REGION: 'us-west-2' }, claudeEnv: { AWS_PROFILE: 'stage2' } }), { endpoint: 'runtime', provider: 'amazon-bedrock-runtime', region: 'us-west-2', profile: 'stage2' }, 'the runtime endpoint follows the environment\'s region; the profile may come from Claude Code\'s settings');
assert.deepStrictEqual(B.bedrockSettings({ cfg: cfgOf({ 'codex.bedrock.endpoint': 'runtime' }), claudeEnv: { AWS_REGION: 'eu-west-1' } }).region, 'eu-west-1');
assert.deepStrictEqual(B.bedrockSettings({ cfg: cfgOf({ 'codex.bedrock.endpoint': 'runtime' }) }).region, 'us-east-1', 'no region anywhere: us-east-1');
assert.deepStrictEqual(B.bedrockSettings({ cfg: cfgOf({ 'codex.bedrock.region': ' us-west-2 ', 'codex.bedrock.profile': 'mine', 'codex.bedrock.endpoint': 'bogus' }), env: { AWS_REGION: 'eu-west-1', AWS_PROFILE: 'env' } }), { endpoint: 'runtime', provider: 'amazon-bedrock-runtime', region: 'us-west-2', profile: 'mine' }, 'perch\'s settings win; an unknown endpoint is the runtime one');

// ---- the overrides
assert.deepStrictEqual(B.bedrockConfig({ provider: 'amazon-bedrock', region: 'us-east-1', profile: '' }), { model_provider: 'amazon-bedrock', model_providers: { 'amazon-bedrock': { aws: { region: 'us-east-1' } } }, features: { apps: false } }, 'the ChatGPT connector apps off: not usable on Bedrock, and 190 KB of schemas a request on the runtime endpoint');
assert.deepStrictEqual(B.bedrockConfig({ provider: 'amazon-bedrock-runtime', region: 'us-west-2', profile: 'stage2' }), { model_provider: 'amazon-bedrock-runtime', model_providers: { 'amazon-bedrock-runtime': { aws: { region: 'us-west-2', profile: 'stage2' } } }, features: { apps: false } });

// ---- model ids: Codex's slugs in Bedrock's form, cross-region on the runtime endpoint; a Bedrock name is left alone
assert.strictEqual(B.bedrockModel('gpt-6-luna', 'mantle'), 'openai.gpt-6-luna');
assert.strictEqual(B.bedrockModel('gpt-6-luna', 'runtime'), 'us.openai.gpt-6-luna');
assert.strictEqual(B.bedrockModel('openai.gpt-6-luna', 'runtime'), 'openai.gpt-6-luna', 'given in Bedrock\'s form: sent as it is');
assert.strictEqual(B.bedrockModel('global.openai.gpt-6-luna', 'mantle'), 'global.openai.gpt-6-luna');
assert.strictEqual(B.bedrockModel('', 'mantle'), undefined);
assert.strictEqual(B.bedrockModel(undefined, 'mantle'), undefined);

console.log('CODEX BEDROCK OK');
