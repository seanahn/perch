'use strict';
// Catalog parsing: Codex's files on disk and the Claude SDK's model list. No model calls.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { loadCodexModels, normalizeClaudeModels, normalizeCommands, parseTopLevelToml } = require('../src/models');

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
const cl = normalizeClaudeModels([
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best', supportsEffort: true, supportedEffortLevels: L },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work', supportsEffort: true, supportedEffortLevels: L },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'odd', displayName: 'Odd', supportsEffort: false, supportedEffortLevels: L },
  { displayName: 'no value' }, null,
]);
assert.deepStrictEqual(cl.defaultModel, { label: 'Opus 5.5', efforts: L, defaultEffort: '' }, 'the default is named after the model it resolves to');
assert.deepStrictEqual(cl.models.map((m) => m.value), ['opus', 'haiku', 'claude-opus-4-6', 'odd'], 'the SDK default entry is not repeated in the list');
assert.deepStrictEqual(cl.models.map((m) => m.efforts), [L, [], ['low', 'medium', 'high', 'max'], []], 'efforts only where the model supports them');
assert.strictEqual(normalizeClaudeModels([{ value: 'default', resolvedModel: 'claude-x', displayName: 'Default' }]).defaultModel.label, 'claude-x', 'falls back to the resolved id');
assert.deepStrictEqual(normalizeClaudeModels([{ value: 'opus', displayName: 'Opus' }]).defaultModel, { label: '', efforts: [], defaultEffort: '' });
assert.strictEqual(normalizeClaudeModels([]), null); assert.strictEqual(normalizeClaudeModels(undefined), null);

// ---- slash commands
assert.deepStrictEqual(normalizeCommands([
  { name: 'review', description: 'Review  the\n changes', argumentHint: '[pr]' }, { name: 'clear', description: '', argumentHint: '' }, { name: '__remote-workflow', description: 'internal' },
  { name: 'review', description: 'duplicate' }, { name: '', description: 'nameless' }, { description: 'no name' }, null, { name: 'long', description: 'x'.repeat(400) },
]), [{ name: 'clear', description: '', hint: '' }, { name: 'long', description: 'x'.repeat(160), hint: '' }, { name: 'review', description: 'Review the changes', hint: '[pr]' }], 'sorted, deduplicated, internal ones dropped, descriptions tidied');
assert.deepStrictEqual(normalizeCommands(normalizeCommands([{ name: 'a', description: 'd', argumentHint: '[x]' }])), [{ name: 'a', description: 'd', hint: '[x]' }], 'normalising twice keeps the hint');
assert.deepStrictEqual([normalizeCommands(undefined), normalizeCommands('x')], [[], []]);

console.log('MODELS OK');
