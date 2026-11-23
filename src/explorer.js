'use strict';
// What the Perch view's explorer lists, read from the files, with no agent started: the skills, MCP servers, agents and
// commands Claude Code loads for a folder (the folder's own, the user's, claude.ai's synced skills, each enabled plugin's),
// and Codex's MCP servers. Each entry: name, source (where it comes from), description, file (and the line its entry starts
// on, where the file can say). Secrets are never carried: an MCP server's env and headers are left out.

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

const MAX_FILES = 200;
/** The files of a skill's folder, relative to it, SKILL.md first, then by path; at most MAX_FILES. */
function filesOf(root) {
  const out = [];
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
}

/** The skills in one skills/ folder: each subfolder with a SKILL.md, named with `prefix`. */
function inFolder(root, source, prefix) {
  const out = [];
  for (const d of dirs(root)) {
    const file = path.join(root, d, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const h = skillHead(read(file));
    out.push({ name: prefix + (h.name || d), source, description: h.description, file, files: filesOf(path.join(root, d)) });
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
  if (dir) out.push(...inFolder(path.join(dir, '.claude', 'skills'), 'this folder', ''));
  out.push(...inFolder(path.join(home, 'skills'), 'yours', ''));
  for (const id of dirs(path.join(home, 'skills', 'synced'))) out.push(...inFolder(path.join(home, 'skills', 'synced', id), 'claude.ai', 'anthropic-skills:'));
  for (const p of plugins(home)) out.push(...inFolder(path.join(p.root, 'skills'), p.name, p.name + ':'));
  return out;
}

/** The plugins settings.json turns on, each with its name and install path. */
function plugins(home) {
  const enabled = ((json(path.join(home, 'settings.json')) || {}).enabledPlugins) || {};
  const installed = ((json(path.join(home, 'plugins', 'installed_plugins.json')) || {}).plugins) || {};
  const out = [];
  for (const key of Object.keys(installed).sort()) {
    if (enabled[key] !== true) continue;
    const entry = [].concat(installed[key]).find((e) => e && e.installPath);
    if (entry) out.push({ name: key.split('@')[0], root: entry.installPath });
  }
  return out;
}

/** What an MCP server runs, or where it is: its command and arguments, or its type and address. Never its env or headers. */
function mcpWhat(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.command) return [c.command, ...(Array.isArray(c.args) ? c.args : [])].map(String).join(' ');
  if (c.url) return (c.type ? c.type + ' ' : '') + c.url;
  return c.type || '';
}
/** The line a JSON file's entry for `name` starts on (1-based), or 0: the first line that opens a key of that name. */
function keyLine(text, name) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => l.includes(JSON.stringify(name) + ':') || l.includes(JSON.stringify(name) + ' :'));
  return i >= 0 ? i + 1 : 0;
}
function fromMcpJson(file, source, { lines = true } = {}) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  let j; try { j = JSON.parse(text); } catch (_) { return []; }
  const servers = (j && j.mcpServers) || {};
  return Object.keys(servers).map((name) => ({ name, source, description: mcpWhat(servers[name]), file, line: lines ? keyLine(text, name) : 0 }));
}
/** Codex's MCP servers: its config.toml's [mcp_servers.<name>] tables, read for command, args and url. */
function codexMcp(file) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = []; let cur = null;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const h = /^\s*\[mcp_servers\.("?)([^"\]]+)\1\]\s*$/.exec(l);
    if (h) { cur = { name: h[2], source: 'codex', conf: {}, file, line: i + 1 }; out.push(cur); return; }
    if (/^\s*\[/.test(l)) { cur = null; return; }
    const kv = cur && /^\s*(command|url|args)\s*=\s*(.+?)\s*$/.exec(l);
    if (kv) { try { cur.conf[kv[1]] = JSON.parse(kv[2]); } catch (_) { cur.conf[kv[1]] = kv[2].replace(/^"|"$/g, ''); } }
  });
  return out.map(({ conf, ...x }) => Object.assign(x, { description: mcpWhat(conf) }));
}

/**
 * Every MCP server Claude Code or Codex would start for a folder: the folder's .mcp.json, the user's for this folder and
 * everywhere (~/.claude.json), each enabled plugin's (.mcp.json, or mcpServers in its plugin.json), then Codex's config.toml.
 */
function listMcp({ dir, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), userFile = path.join(os.homedir(), '.claude.json'), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const out = [];
  if (dir) out.push(...fromMcpJson(path.join(dir, '.mcp.json'), 'this folder'));
  const user = json(userFile) || {};
  const local = (dir && user.projects && user.projects[dir] && user.projects[dir].mcpServers) || {};
  for (const name of Object.keys(local)) out.push({ name, source: 'this folder (yours)', description: mcpWhat(local[name]), file: userFile, line: 0 });
  for (const name of Object.keys(user.mcpServers || {})) out.push({ name, source: 'yours', description: mcpWhat(user.mcpServers[name]), file: userFile, line: 0 });
  for (const p of plugins(home)) {
    const own = path.join(p.root, '.mcp.json');
    if (fs.existsSync(own)) { out.push(...fromMcpJson(own, p.name, { lines: false })); continue; }
    const pj = path.join(p.root, '.claude-plugin', 'plugin.json'), conf = (json(pj) || {}).mcpServers;
    if (conf && typeof conf === 'object') for (const name of Object.keys(conf)) out.push({ name, source: p.name, description: mcpWhat(conf[name]), file: pj, line: 0 });
  }
  out.push(...codexMcp(path.join(codexHome, 'config.toml')));
  return out;
}

/** The Markdown files of a folder, at its top or (deep) in subfolders too, each with the names of the folders it is under. */
function mdFiles(root, deep, under = []) {
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isFile() && e.name.endsWith('.md')) out.push({ file: path.join(root, e.name), base: e.name.slice(0, -3), under });
    else if (deep && e.isDirectory()) out.push(...mdFiles(path.join(root, e.name), deep, under.concat(e.name)));
  }
  return out;
}
/** A description from a file's front matter, else its first line of text. */
function firstWords(text) {
  const h = skillHead(text);
  if (h.description) return h;
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const line = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return { name: h.name, description: line };
}

/** Sub-agent definitions: .claude/agents/*.md of the folder, the user's, and each enabled plugin's agents/. */
function listAgents({ dir, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const from = (root, source, prefix) => mdFiles(root, false).map((f) => { const h = firstWords(read(f.file)); return { name: prefix + (h.name || f.base), source, description: h.description, file: f.file }; });
  const out = [];
  if (dir) out.push(...from(path.join(dir, '.claude', 'agents'), 'this folder', ''));
  out.push(...from(path.join(home, 'agents'), 'yours', ''));
  for (const p of plugins(home)) out.push(...from(path.join(p.root, 'agents'), p.name, p.name + ':'));
  return out;
}

/** Slash commands of Markdown files: .claude/commands of the folder, the user's, each plugin's; a subfolder is a namespace. */
function listCommands({ dir, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const from = (root, source, prefix) => mdFiles(root, true)
    .map((f) => ({ name: '/' + prefix + f.under.concat(f.base).join(':'), source, description: firstWords(read(f.file)).description, file: f.file }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  if (dir) out.push(...from(path.join(dir, '.claude', 'commands'), 'this folder', ''));
  out.push(...from(path.join(home, 'commands'), 'yours', ''));
  for (const p of plugins(home)) out.push(...from(path.join(p.root, 'commands'), p.name, p.name + ':'));
  return out;
}

module.exports = { listSkills, skillHead, listMcp, listAgents, listCommands };
