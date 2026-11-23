'use strict';
// The skills Claude Code loads, for the Perch view to list: the workspace folder's (.claude/skills), the user's own
// (~/.claude/skills), those synced from claude.ai (~/.claude/skills/synced/<id>/, which Claude Code names anthropic-skills:…),
// and each enabled plugin's (its install path's skills/, named <plugin>:…). Read from the files; no agent is started.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HEAD_BYTES = 8192;

/** The name and description a SKILL.md gives in its front matter: plain, quoted, or a folded or literal block. */
function skillHead(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const out = { name: '', description: '' };
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[|>][+-]?$/.test(v)) {   // a block: the indented lines after it
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      v = block.filter(Boolean).join(' ');
    }
    out[kv[1]] = v.replace(/^(['"])(.*)\1$/, '$2').replace(/\s+/g, ' ').trim();
  }
  return out;
}

function read(file) { try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(HEAD_BYTES); const n = fs.readSync(fd, b, 0, HEAD_BYTES, 0); return b.slice(0, n).toString('utf8'); } finally { fs.closeSync(fd); } } catch (_) { return ''; } }
function dirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (_) { return []; } }
function json(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

/** The skills in one skills/ folder: each subfolder with a SKILL.md, named with `prefix`. */
function inFolder(root, source, prefix) {
  const out = [];
  for (const d of dirs(root)) {
    const file = path.join(root, d, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const h = skillHead(read(file));
    out.push({ name: prefix + (h.name || d), source, description: h.description, file });
  }
  return out;
}

/**
 * Every skill Claude Code loads for a folder, grouped by where it comes from: the folder's, the user's, claude.ai's, then
 * each enabled plugin's, each group by name.
 * @returns {{ name: string, source: string, description: string, file: string }[]}
 */
function listSkills({ dir, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const out = [];
  if (dir) out.push(...inFolder(path.join(dir, '.claude', 'skills'), 'folder', ''));
  out.push(...inFolder(path.join(home, 'skills'), 'yours', ''));
  for (const id of dirs(path.join(home, 'skills', 'synced'))) out.push(...inFolder(path.join(home, 'skills', 'synced', id), 'claude.ai', 'anthropic-skills:'));
  const enabled = ((json(path.join(home, 'settings.json')) || {}).enabledPlugins) || {};
  const installed = ((json(path.join(home, 'plugins', 'installed_plugins.json')) || {}).plugins) || {};
  for (const key of Object.keys(installed).sort()) {
    if (enabled[key] !== true) continue;
    const entry = [].concat(installed[key]).find((e) => e && e.installPath);
    if (!entry) continue;
    const plugin = key.split('@')[0];
    out.push(...inFolder(path.join(entry.installPath, 'skills'), plugin, plugin + ':'));
  }
  return out;
}

module.exports = { listSkills, skillHead };
