'use strict';
// Where the agents' programs are. No VS Code dependency: the host says where the vendors' extensions are installed.
//
// Each SDK runs a program of its vendor's: `claude`, `codex`. Installed from npm, an SDK brings its program with it,
// for the platform it was installed on. A packaged Perch does not carry them: they are hundreds of megabytes, and
// those of one platform only. It runs the ones inside the vendors' own VS Code extensions, which are there already
// wherever the vendors' tools are used, and are kept up to date by them.

const fs = require('fs');
const path = require('path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const ls = (d) => { try { return fs.readdirSync(d).sort(); } catch (_) { return []; } };
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Whether the SDK's own program is installed beside it. `prefix` is what its platform packages' names begin with. */
function bundled(scopeDir, prefix, skip) {
  return ls(scopeDir).some((n) => n.startsWith(prefix) && !(skip || []).includes(n) && ls(path.join(scopeDir, n)).length > 0);
}

/** The `claude` inside the Claude Code extension. */
function vendorClaude(root) {
  if (!root) return '';
  const p = path.join(root, 'resources', 'native-binary', 'claude' + EXE);
  return isFile(p) ? p : '';
}

/** The `codex` inside the ChatGPT extension: under bin/, in a directory named for the platform. */
function vendorCodex(root) {
  if (!root) return '';
  for (const d of ls(path.join(root, 'bin'))) { const p = path.join(root, 'bin', d, 'codex' + EXE); if (isFile(p)) return p; }
  return '';
}

/**
 * The program an agent is to run.
 * @param {'claude'|'codex'} kind
 * @param {object} o
 * @param {string} [o.configured]   the user's own choice: it is used as given
 * @param {string} [o.vendorRoot]   where the vendor's VS Code extension is installed, if it is
 * @param {string} [o.modules]      Perch's node_modules
 * @returns {{ path: string, from: 'setting'|'sdk'|'extension'|'none' }}  an empty path with 'sdk' leaves it to the SDK
 */
function resolveProgram(kind, { configured, vendorRoot, modules = path.join(__dirname, '..', 'node_modules') } = {}) {
  if (configured) return { path: configured, from: 'setting' };
  const own = kind === 'claude' ? bundled(path.join(modules, '@anthropic-ai'), 'claude-agent-sdk-') : bundled(path.join(modules, '@openai'), 'codex-', ['codex-sdk']);
  if (own) return { path: '', from: 'sdk' };
  const p = kind === 'claude' ? vendorClaude(vendorRoot) : vendorCodex(vendorRoot);
  return p ? { path: p, from: 'extension' } : { path: '', from: 'none' };
}

module.exports = { resolveProgram, vendorClaude, vendorCodex, bundled };
