'use strict';
// Whether Codex on this machine is logged in, and how to log it in. No VS Code dependency.
//
// Codex keeps its ChatGPT login in auth.json under its home (~/.codex, or $CODEX_HOME). Perch runs the codex program with
// that login, as the CLI and the ChatGPT extension do, so a machine that has never logged in (a fresh remote, say) has
// nothing to run with: the API answers 401 and the SDK reconnects five times before giving up. Better to look first.
const fs = require('fs');
const os = require('os');
const path = require('path');

function codexHome(env = process.env) { return env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

/** An API key in the environment serves as a login too. */
function loggedIn({ env = process.env, home = codexHome(env) } = {}) {
  if (env.OPENAI_API_KEY) return true;
  try { const j = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')); return !!(j && (j.tokens || j.OPENAI_API_KEY || j.auth_mode)); }
  catch (_) { return false; }
}

/** Device-code sign-in, for a terminal: it prints a link and a one-time code. ChatGPT must allow it (a setting, off by default). */
function loginCommand(program) { return (program === 'codex' ? 'codex' : JSON.stringify(program)) + ' login --device-auth'; }

const CALLBACK_PORT = 1455;      // codex login listens here for the browser's return; VS Code forwards it from the user's machine when remote

/**
 * The browser sign-in, run here: `codex login` starts a local server on port 1455 and prints the page to open. The caller
 * opens that page in the user's browser and, when remote, forwards the port so the browser's return reaches this machine.
 * Resolves with the URL once printed; rejects if the program exits first.
 * @param {string} program
 * @param {{spawn?: Function, env?: object}} [o]
 * @returns {Promise<{url: string, child: object}>}
 */
function startLogin(program, o = {}) {
  const spawn = o.spawn || require('child_process').spawn;
  return new Promise((resolve, reject) => {
    let child, out = '', done = false;
    try { child = spawn(program, ['login'], { stdio: ['ignore', 'pipe', 'pipe'], env: o.env || process.env }); }
    catch (e) { reject(new Error('could not run ' + program + ': ' + e.message)); return; }
    const look = (d) => {
      out += d;
      const m = /https:\/\/auth\.openai\.com\/\S+(?=\s)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''));   // whole: the URL may arrive in pieces, and ends at a line end
      if (m && !done) { done = true; resolve({ url: m[0].replace(/[).,]+$/, ''), child }); }
    };
    child.stdout.on('data', look); child.stderr.on('data', look);
    child.on('error', (e) => { if (!done) { done = true; reject(new Error('could not run ' + program + ': ' + e.message)); } });
    child.on('close', (code) => { if (!done) { done = true; reject(new Error('codex login ended' + (code ? ` (exit ${code})` : '') + (out.trim() ? ': ' + out.trim().split('\n').pop().slice(0, 300) : ''))); } });
  });
}

/** Resolves true once the login is there, false when the wait runs out. Polled: the directory may not exist yet. */
function waitForLogin({ env = process.env, home = codexHome(env), timeoutMs = 15 * 60000, intervalMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const check = () => loggedIn({ env, home });
    if (check()) { resolve(true); return; }
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(true); }
      else if (Date.now() - t0 >= timeoutMs) { clearInterval(timer); resolve(false); }
    }, intervalMs);
    if (timer.unref) timer.unref();
  });
}

module.exports = { codexHome, loggedIn, loginCommand, startLogin, waitForLogin, CALLBACK_PORT };
