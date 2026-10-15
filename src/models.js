'use strict';
// Model catalogs, read from the agents themselves. No VS Code dependency.
// A catalog is { defaultModel: { label, efforts, defaultEffort }, models: [{ value, label, description, efforts, defaultEffort }] }.
// Claude's defaultModel also has the model id and a description, and its entries the id each resolves to (resolved).
// efforts is the list of effort levels that model accepts; empty means the model has no effort control.

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Top-level string keys of a TOML file: everything before the first [table]. Enough for ~/.codex/config.toml. */
function parseTopLevelToml(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

/** Codex keeps its model list in ~/.codex/models_cache.json and the user's defaults in ~/.codex/config.toml. */
function loadCodexModels(home = path.join(os.homedir(), '.codex')) {
  let cache;
  try { cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')); } catch (_) { return null; }
  const all = (Array.isArray(cache && cache.models) ? cache.models : []).filter((m) => m && typeof m.slug === 'string');
  if (!all.length) return null;
  let cfg = {};
  try { cfg = parseTopLevelToml(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')); } catch (_) { /* no config: codex picks */ }
  const levels = (m) => (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
    .map((l) => (l && typeof l === 'object' ? l.effort : l)).filter((l) => typeof l === 'string');
  // the user's configured effort applies to any model that accepts it; otherwise the model's own default
  const effortFor = (m) => { const e = levels(m); return (cfg.model_reasoning_effort && e.includes(cfg.model_reasoning_effort)) ? cfg.model_reasoning_effort : (m.default_reasoning_level || ''); };
  const entry = (m) => ({ value: m.slug, label: m.display_name || m.slug, description: m.description || '', efforts: levels(m), defaultEffort: effortFor(m) });
  const listed = all.filter((m) => m.visibility !== 'hide').sort((a, b) => (a.priority || 0) - (b.priority || 0)).map(entry);
  const def = cfg.model && all.find((m) => m.slug === cfg.model);
  const defaultModel = def ? { label: def.display_name || def.slug, slug: def.slug, efforts: levels(def), defaultEffort: effortFor(def) }
    : { label: cfg.model || '', slug: cfg.model || '', efforts: [...new Set(listed.flatMap((m) => m.efforts))], defaultEffort: cfg.model_reasoning_effort || '' };
  return { defaultModel, models: listed };
}

/**
 * Pure: turn the SDK's ModelInfo[] into a catalog. Each entry keeps the id it resolves to, by which a model the CLI
 * reports is named. `current` is the model the CLI says it is on before anything is chosen: what a new session starts on,
 * which ANTHROPIC_MODEL or the model in Claude Code's settings decide. The SDK's own "default" entry is Claude Code's
 * built-in default whatever those say, so it names defaultModel only when the CLI could not say.
 */
function normalizeClaudeModels(list, current) {
  const infos = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.value === 'string');
  if (!infos.length) return null;
  const efforts = (m) => (m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.slice() : []);
  const def = infos.find((m) => m.value === 'default');
  const rest = infos.filter((m) => m.value !== 'default');
  const entry = (id) => (id ? rest.find((m) => m.value === id || m.resolvedModel === id) : null);
  const builtIn = (def && def.resolvedModel) || '';
  const model = (typeof current === 'string' && current) || builtIn;
  const m = entry(model), own = entry(builtIn);
  const label = m ? m.displayName || m.value : model;
  const description = model === builtIn ? (def && def.description) || ''
    : 'New sessions start on ' + label + ', which ANTHROPIC_MODEL or Claude Code\'s settings name. In a running session, choosing default gives Claude Code\'s own default' + (builtIn ? ', ' + ((own && own.displayName) || builtIn) : '') + '.';
  return {
    defaultModel: { label, model, description, efforts: m ? efforts(m) : def ? efforts(def) : [], defaultEffort: '' },
    models: rest.map((x) => ({ value: x.value, label: x.displayName || x.value, resolved: x.resolvedModel || '', description: x.description || '', efforts: efforts(x), defaultEffort: '' })),
  };
}

/** The catalog entry that is a model the CLI reported by its id: by value, or by the id it resolves to; else null. */
function modelEntry(cat, id) {
  return id && cat && Array.isArray(cat.models) ? cat.models.find((x) => x.value === id || (x.resolved && x.resolved === id)) || null : null;
}
/** What a catalog calls a model the CLI reported: its entry's name, else the id. */
function modelLabel(cat, id) { const m = modelEntry(cat, id); return m ? m.label : id || ''; }

/**
 * The model a CLI is on before anything is chosen, which a new session starts on; '' if it cannot say. The summary
 * answers from local figures, without the token-count requests of a full breakdown.
 */
async function startModel(q, timeoutMs = 5000) {
  if (!q || typeof q.getContextUsage !== 'function') return '';
  let timer;
  try {
    const u = await Promise.race([q.getContextUsage({ detail: 'summary' }), new Promise((r) => { timer = setTimeout(() => r(null), timeoutMs); })]);
    return u && typeof u.model === 'string' ? u.model : '';
  } catch (_) { return ''; } finally { clearTimeout(timer); }   // older CLI: the SDK's default entry names the default
}

/** Pure: the SDK's SlashCommand[] as [{ name, description, hint }], sorted, without internal (double-underscore) commands. */
function normalizeCommands(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.name === 'string' && c.name && !c.name.startsWith('__') && !seen.has(c.name) && seen.add(c.name))
    .map((c) => ({ name: c.name, description: String(c.description || '').replace(/\s+/g, ' ').trim().slice(0, 160), hint: String(c.argumentHint || c.hint || '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ask Claude Code for its model list, the model it starts on, and its slash commands. Starts the CLI with an input
 * stream that never yields, so the CLI initializes but no model request is made and nothing is billed.
 */
async function loadClaudeModels({ cwd, executable, timeoutMs = 15000 } = {}) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const abort = new AbortController();
  let release = () => {};
  const idle = { [Symbol.asyncIterator]() { return { next: () => new Promise((r) => { release = () => r({ done: true, value: undefined }); }), return: async () => ({ done: true, value: undefined }) }; } };
  const options = { cwd: cwd || process.cwd(), permissionMode: 'default', abortController: abort, stderr: () => {} };
  if (executable) options.pathToClaudeCodeExecutable = executable;
  let timer;
  try {
    const q = sdk.query({ prompt: idle, options });
    const list = await Promise.race([
      q.supportedModels(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out asking Claude Code for its models')), timeoutMs); }),
    ]);
    const catalog = normalizeClaudeModels(list, await startModel(q));
    if (catalog) { try { catalog.commands = normalizeCommands(await q.supportedCommands()); } catch (_) { catalog.commands = []; } }
    return catalog;
  } finally {
    clearTimeout(timer); release(); abort.abort();
  }
}

module.exports = { loadCodexModels, loadClaudeModels, normalizeClaudeModels, normalizeCommands, modelEntry, modelLabel, startModel, parseTopLevelToml };
