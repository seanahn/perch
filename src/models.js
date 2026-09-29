'use strict';
// Model catalogs, read from the agents themselves. No VS Code dependency.
// A catalog is { defaultModel: { label, efforts, defaultEffort }, models: [{ value, label, description, efforts, defaultEffort }] }.
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
  const defaultModel = def ? { label: def.display_name || def.slug, efforts: levels(def), defaultEffort: effortFor(def) }
    : { label: cfg.model || '', efforts: [...new Set(listed.flatMap((m) => m.efforts))], defaultEffort: cfg.model_reasoning_effort || '' };
  return { defaultModel, models: listed };
}

/** Pure: turn the SDK's ModelInfo[] into a catalog. The SDK's own "default" entry becomes defaultModel. */
function normalizeClaudeModels(list) {
  const infos = (Array.isArray(list) ? list : []).filter((m) => m && typeof m.value === 'string');
  if (!infos.length) return null;
  const efforts = (m) => (m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.slice() : []);
  const def = infos.find((m) => m.value === 'default');
  const rest = infos.filter((m) => m.value !== 'default');
  const twin = def && rest.find((m) => m.resolvedModel && m.resolvedModel === def.resolvedModel);
  return {
    defaultModel: def ? { label: (twin && twin.displayName) || def.resolvedModel || '', efforts: efforts(def), defaultEffort: '' } : { label: '', efforts: [], defaultEffort: '' },
    models: rest.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description || '', efforts: efforts(m), defaultEffort: '' })),
  };
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
 * Ask Claude Code for its model list and slash commands. Starts the CLI with an input stream that never yields,
 * so the CLI initializes but no model request is made and nothing is billed.
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
    const catalog = normalizeClaudeModels(list);
    if (catalog) { try { catalog.commands = normalizeCommands(await q.supportedCommands()); } catch (_) { catalog.commands = []; } }
    return catalog;
  } finally {
    clearTimeout(timer); release(); abort.abort();
  }
}

module.exports = { loadCodexModels, loadClaudeModels, normalizeClaudeModels, normalizeCommands, parseTopLevelToml };
