'use strict';
// Catalog parsing: Codex's files on disk and the Claude SDK's model list. No model calls.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { loadCodexModels, normalizeClaudeModels, normalizeCommands, modelLabel, modelKey, sameModel, fallbackNote, startModel, parseTopLevelToml } = require('../src/models');

// ---- TOML: top-level string keys only, stops at the first table
assert.deepStrictEqual(parseTopLevelToml('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"  # mine\nn = 3\nflag = true\nsq = \'single\'\n\n[profiles.x]\nmodel = "other"\n'),
  { model: 'gpt-5.6-sol', model_reasoning_effort: 'ultra', sq: 'single' });
assert.deepStrictEqual(parseTopLevelToml(''), {});
assert.deepStrictEqual(parseTopLevelToml('[a]\nmodel = "x"'), {}, 'keys inside a table are not top-level');

// ---- Codex
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-codex-'));
const lv = (...e) => e.map((x) => ({ effort: x, description: '' }));
const cache = { fetched_at: 'x', models: [
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13, default_reasoning_level: 'medium', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh') },
  { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'big', visibility: 'list', priority: 3, default_reasoning_level: 'medium', supported_reasoning_levels: lv('low', 'medium', 'high', 'xhigh', 'max', 'ultra') },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: lv('low', 'medium') },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 5, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'ultra'] },
  { display_name: 'no slug' }, null,
] };
assert.strictEqual(loadCodexModels(home), null, 'no cache file, no catalog');
fs.writeFileSync(path.join(home, 'models_cache.json'), '{ not json');
assert.strictEqual(loadCodexModels(home), null, 'unreadable cache, no catalog');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [] }));
assert.strictEqual(loadCodexModels(home), null, 'empty cache, no catalog');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(cache));

let c = loadCodexModels(home);                                       // no config.toml
assert.deepStrictEqual(c.models.map((m) => m.value), ['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5'], 'listed models only, by priority');
assert.deepStrictEqual(c.models[0], { value: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'big', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' });
assert.deepStrictEqual(c.models[1].efforts, ['low', 'ultra'], 'levels may be plain strings');
assert.deepStrictEqual(c.defaultModel, { label: '', slug: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: '' }, 'unknown default: any listed effort may be chosen');

fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n[mcp_servers.x]\ncommand = "y"\n');
c = loadCodexModels(home);
assert.deepStrictEqual(c.defaultModel, { label: 'GPT-5.6-Sol', slug: 'gpt-5.6-sol', efforts: ['low', 'ultra'], defaultEffort: 'ultra' }, 'default model and effort from the user config; the slug is what Bedrock\'s id is made from');
assert.strictEqual(c.models.find((m) => m.value === 'gpt-6-sol').defaultEffort, 'ultra', 'the configured effort applies to a model that accepts it');
assert.strictEqual(c.models.find((m) => m.value === 'gpt-5.5').defaultEffort, 'medium', 'and falls back to the model default where it does not');

fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-reserve"\n');
assert.deepStrictEqual(loadCodexModels(home).defaultModel, { label: 'GPT-Reserve', slug: 'gpt-reserve', efforts: ['low', 'medium'], defaultEffort: 'medium' }, 'a hidden model can still be the configured default');
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-private"\n');
assert.strictEqual(loadCodexModels(home).defaultModel.label, 'gpt-private', 'a default the cache does not know is shown by its id');
fs.rmSync(home, { recursive: true, force: true });

// ---- Claude
const L = ['low', 'medium', 'high', 'xhigh', 'max'];
const LIST = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best', supportsEffort: true, supportedEffortLevels: L },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: L },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'odd', displayName: 'Odd', supportsEffort: false, supportedEffortLevels: L },
  { displayName: 'no value' }, null,
];
const cl = normalizeClaudeModels(LIST);
assert.deepStrictEqual(cl.defaultModel, { label: 'Opus 5.5', model: 'claude-opus-5-5', description: 'Opus 5.5 · Best', efforts: L, defaultEffort: '' }, 'unasked, the default is the SDK\'s, named after the model it resolves to');
assert.deepStrictEqual(cl.models.map((m) => m.value), ['opus', 'haiku', 'claude-opus-4-6', 'odd'], 'the SDK default entry is not repeated in the list');
assert.deepStrictEqual(cl.models.map((m) => m.efforts), [L, [], ['low', 'medium', 'high', 'max'], []], 'efforts only where the model supports them');
assert.deepStrictEqual(cl.models.map((m) => m.resolved), ['claude-opus-5-5', 'claude-haiku-4-5', '', ''], 'each entry keeps the id it resolves to');
assert.strictEqual(normalizeClaudeModels([{ value: 'default', resolvedModel: 'claude-x', displayName: 'Default' }]).defaultModel.label, 'claude-x', 'falls back to the resolved id');
assert.deepStrictEqual(normalizeClaudeModels([{ value: 'opus', displayName: 'Opus' }]).defaultModel, { label: '', model: '', description: '', efforts: [], defaultEffort: '' });
assert.strictEqual(normalizeClaudeModels([]), null); assert.strictEqual(normalizeClaudeModels(undefined), null);

// the model the CLI says a new session starts on names the default: ANTHROPIC_MODEL or the settings' model, both of which the SDK's own entry ignores
const S = ['low', 'medium', 'high', 'max'];
const withSonnet = [...LIST, { value: 'sonnet', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Everyday', supportsEffort: true, supportedEffortLevels: S }];
const started = normalizeClaudeModels(withSonnet, 'claude-sonnet-4-6').defaultModel;
assert.deepStrictEqual([started.label, started.model, started.efforts], ['Sonnet 4.6', 'claude-sonnet-4-6', S], 'named after the entry that resolves to it, with that model\'s efforts');
assert.strictEqual(started.description, 'New sessions start on Sonnet 4.6, which ANTHROPIC_MODEL or Claude Code\'s settings name. In a running session, choosing default gives Claude Code\'s own default, Opus 5.5.');
assert.strictEqual(normalizeClaudeModels(withSonnet, 'sonnet').defaultModel.label, 'Sonnet 4.6', 'or the entry it is by value');
assert.deepStrictEqual(normalizeClaudeModels(LIST, 'claude-opus-5-5').defaultModel, cl.defaultModel, 'starting on the built-in default is the SDK\'s default');
const unlisted = normalizeClaudeModels(LIST, 'custom-model-7').defaultModel;
assert.deepStrictEqual([unlisted.label, unlisted.model, unlisted.efforts], ['custom-model-7', 'custom-model-7', L], 'a model the list lacks goes by its id, with the SDK default\'s efforts');
assert.strictEqual(normalizeClaudeModels([{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' }], 'claude-opus-5-5').defaultModel.label, 'Opus', 'and with no SDK default entry');

// a model the CLI reports, named from the catalog
assert.deepStrictEqual(['claude-haiku-4-5', 'haiku', 'claude-opus-4-6', 'claude-mystery-1', '', undefined].map((id) => modelLabel(cl, id)), ['Haiku 4.5', 'Haiku 4.5', 'Opus 4.6', 'claude-mystery-1', '', ''], 'by the id an entry resolves to or by its value; one the list lacks by its id');
assert.strictEqual(modelLabel(null, 'claude-x'), 'claude-x', 'and with no catalog');
// a provider's id for a listed model is that model: Claude Code on Bedrock names it so, a response by the model's own id
assert.deepStrictEqual(['us.anthropic.claude-haiku-4-5-v1:0', 'claude-opus-5-5[1m]', 'global.anthropic.claude-opus-4-6', 'claude-opus-4-6@20260101'].map((id) => modelLabel(cl, id)), ['Haiku 4.5', 'Opus 5.5', 'Opus 4.6', 'Opus 4.6']);

// ---- one model, whoever serves it
assert.deepStrictEqual(['us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5[1m]', 'Claude-Opus-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-1@20250805', 'global.openai.gpt-6-luna', '', null].map(modelKey),
  ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'global.openai.gpt-6-luna', '', '']);
assert.deepStrictEqual([sameModel('us.anthropic.claude-opus-5-5', 'claude-opus-5-5'), sameModel('claude-opus-5-5', 'claude-opus-4-8'), sameModel('claude-opus-5', 'claude-opus-5-5'), sameModel('', ''), sameModel(undefined, 'x')], [true, false, false, false, false],
  'Opus 5 is not Opus 5.5, and no id is no model');

// ---- what the transcript says when another model answered a refused response: Claude Code's words, else perch's
assert.strictEqual(fallbackNote({ content: '  Opus 5.5\'s safeguards flagged this session.\n', from: 'a', to: 'b' }), 'Opus 5.5\'s safeguards flagged this session.');
assert.deepStrictEqual([fallbackNote({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', scope: 'session' }), fallbackNote({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', scope: 'local' }), fallbackNote()], [
  'claude-opus-5-5\'s safeguards stopped a response, and claude-opus-4-8 answered it instead. This session runs on claude-opus-4-8 from now on.',
  'claude-opus-5-5\'s safeguards stopped a response, and claude-opus-4-8 answered it instead.',
  'The model\'s safeguards stopped a response, and another model answered it instead. This session runs on another model from now on.',
]);

// ---- slash commands
assert.deepStrictEqual(normalizeCommands([
  { name: 'review', description: 'Review  the\n changes', argumentHint: '[pr]' }, { name: 'clear', description: '', argumentHint: '' }, { name: '__remote-workflow', description: 'internal' },
  { name: 'review', description: 'duplicate' }, { name: '', description: 'nameless' }, { description: 'no name' }, null, { name: 'long', description: 'x'.repeat(400) },
]), [{ name: 'clear', description: '', hint: '' }, { name: 'long', description: 'x'.repeat(160), hint: '' }, { name: 'review', description: 'Review the changes', hint: '[pr]' }], 'sorted, deduplicated, internal ones dropped, descriptions tidied');
assert.deepStrictEqual(normalizeCommands(normalizeCommands([{ name: 'a', description: 'd', argumentHint: '[x]' }])), [{ name: 'a', description: 'd', hint: '[x]' }], 'normalising twice keeps the hint');
assert.deepStrictEqual([normalizeCommands(undefined), normalizeCommands('x')], [[], []]);

// ---- the model an idle CLI is on, asked in summary
(async () => {
  const asked = [];
  assert.strictEqual(await startModel({ getContextUsage: async (o) => { asked.push(o); return { model: 'claude-sonnet-4-6', percentage: 3 }; } }), 'claude-sonnet-4-6');
  assert.deepStrictEqual(asked, [{ detail: 'summary' }], 'in summary, which makes no token-count requests');
  assert.deepStrictEqual([await startModel({}), await startModel(null)], ['', ''], 'a CLI that cannot be asked');
  assert.strictEqual(await startModel({ getContextUsage: async () => { throw new Error('unknown request'); } }), '', 'one that refuses');
  assert.strictEqual(await startModel({ getContextUsage: async () => ({ percentage: 3 }) }), '', 'one that does not say');
  assert.strictEqual(await startModel({ getContextUsage: () => new Promise(() => {}) }, 20), '', 'and one that never answers');
  console.log('MODELS OK');
})().catch((err) => { console.error(err); process.exit(1); });
