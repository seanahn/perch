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

/**
 * The SDK's own `codex`, where its platform package keeps it (`@openai/codex-<platform>-<arch>/vendor/<target>/bin/codex`), for
 * running the program directly, as a login does: the SDK finds it by itself when it runs it, so resolveProgram leaves the
 * path empty, and `codex` alone names nothing unless the user has one on PATH. This machine's package first.
 * @returns {string} '' when there is none
 */
function sdkCodex(modules = path.join(__dirname, '..', 'node_modules')) {
  const scope = path.join(modules, '@openai');
  const mine = `codex-${process.platform}-${process.arch}`;
  const names = ls(scope).filter((n) => n.startsWith('codex-') && n !== 'codex-sdk').sort((a, b) => (b === mine) - (a === mine));
  for (const n of names) {
    const vendor = path.join(scope, n, 'vendor');
    for (const t of ls(vendor)) for (const p of [path.join(vendor, t, 'bin', 'codex' + EXE), path.join(vendor, t, 'codex', 'codex' + EXE)]) if (isFile(p)) return p;
  }
  return '';
}

/** Whether this Linux runs on musl rather than glibc, told the way the Claude SDK tells it. */
function isMusl() {
  try {
    const r = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null;
    return !!r && (r.header ? r.header.glibcVersionRuntime : undefined) === undefined;
  } catch (_) { return false; }
}

/**
 * The SDK's own `claude`, found where the SDK looks for it: in its platform package, `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`,
 * and on Linux in both builds, the one of this machine's C library first. For running the program directly, as a login
 * does: the SDK finds it by itself when it runs it, so resolveProgram leaves the path empty.
 * @returns {string} '' when there is none
 */
function sdkClaude(modules = path.join(__dirname, '..', 'node_modules'), { platform = process.platform, arch = process.arch, musl } = {}) {
  if (musl === undefined) musl = platform === 'linux' && isMusl();
  const names = platform === 'android' ? [`linux-${arch}-android`]
    : platform === 'linux' ? (musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`])
    : [`${platform}-${arch}`];
  for (const n of names) {
    const p = path.join(modules, '@anthropic-ai', 'claude-agent-sdk-' + n, 'claude' + (platform === 'win32' ? '.exe' : ''));
    if (isFile(p)) return p;
  }
  return '';
}

/**
 * A program on PATH, found as a shell would find it: the first file of that name that may be run, on Windows with one of
 * the endings PATHEXT lists.
 * @returns {string} its path; '' when there is none
 */
function onPath(name, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const ends = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const e of ends) {
      const p = path.join(d, name + e);
      if (!isFile(p)) continue;
      if (win) return p;
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* there, but not to be run */ }
    }
  }
  return '';
}

/** A word as a POSIX shell reads it back unchanged: bare when nothing in it means anything to a shell, else in single quotes. */
function shellQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_./:@+-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * How a terminal is to run a program, with its arguments. On Windows the terminal runs the program itself and VS Code
 * hands it the arguments as given, so no shell reads them: PowerShell and cmd quote differently, and Windows PowerShell
 * drops the quotes inside an argument. That terminal closes when the program ends. Elsewhere the command is typed into the
 * user's shell, quoted for a POSIX shell, so what the program printed stays on screen once it has ended.
 * @param {string} program
 * @param {string[]} args
 * @returns {{ options: object, text: string }}  more options for createTerminal, and the line to send it ('' for none)
 */
function terminalRun(program, args, platform = process.platform) {
  if (platform === 'win32') return { options: { shellPath: program, shellArgs: args.slice() }, text: '' };
  return { options: {}, text: [program, ...args].map(shellQuote).join(' ') };
}

module.exports = { resolveProgram, vendorClaude, vendorCodex, bundled, sdkCodex, sdkClaude, onPath, shellQuote, terminalRun };
