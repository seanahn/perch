'use strict';
// Codebase search's Perch side (src/codeIndex.js): the Python the server runs on, the server Perch gives a tab, and the
// one-time install of search by meaning, against a stand-in for Python. No pip, no model, no network.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const { CodeIndex, DEFAULT_HOME, PROBE } = require('../src/codeIndex');

const ROOT = path.join(__dirname, '..');                         // the real codeindex/: its requirements are hashed
const tmp = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-codeindex-js-')); tmp.push(d); return d; };
process.on('exit', () => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

/** A CodeIndex whose Python is node, saying what each step would: o.fail names the step that fails. */
function make(o = {}) {
  const home = mk(); const calls = [];
  const ok = (opts, out = '') => cp.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(out)})`], opts);
  const fail = (opts, msg) => cp.spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(msg + '\n')}); process.exit(1)`], opts);
  const ix = new CodeIndex({ root: ROOT, home, python: 'python3', fetch: async () => 'print("get-pip")', spawn: (cmd, args, opts) => {
    const a = args.map((x) => (x.startsWith(home) ? x.slice(home.length + 1) : x.startsWith(ROOT) ? path.relative(ROOT, x) : x));
    calls.push([cmd.startsWith(home) ? cmd.slice(home.length + 1) : cmd, ...a]);
    if (args[0] === '-c' && args[1] === PROBE) return o.fail === 'probe' ? fail(opts, 'AssertionError') : ok(opts);
    if (args[0] === '-m' && args[1] === 'venv') {
      fs.mkdirSync(path.dirname(ix.venvPython), { recursive: true }); fs.writeFileSync(ix.venvPython, '');   // laid out even when it fails, as Debian's does
      return o.fail === 'ensurepip' && !args.includes('--without-pip') ? fail(opts, "Error: Command '[...] -m ensurepip --upgrade --default-pip' returned non-zero exit status 1.") : ok(opts);
    }
    if (args[0] === '-c' && args[1] === 'import pip') return o.fail === 'ensurepip' && !ix._pip ? fail(opts, "No module named 'pip'") : ok(opts);
    if (args[0] === '-m' && args[1] === 'ensurepip') return o.fail === 'ensurepip' ? fail(opts, 'No module named ensurepip') : ok(opts);
    if (/get-pip\.py$/.test(args[0])) { ix._pip = true; return ok(opts); }
    if (args[0] === '-m' && args[1] === 'pip') return o.fail === 'pip' ? fail(opts, 'ERROR: No matching distribution found for fastembed') : ok(opts);
    if (args.includes('--download-only')) {
      assert.strictEqual(opts.env.CODEINDEX_MODELS, ix.modelsDir, 'the model goes into Perch\'s own directory');
      return o.fail === 'model' ? cp.spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ready:false,error:"no route to huggingface.co"})+"\\n"); process.exit(1)'], opts)
        : ok(opts, JSON.stringify({ ready: true, model: 'sentence-transformers/all-MiniLM-L6-v2' }) + '\n');
    }
    if (args.includes('--status')) return ok(opts, 'a log line first\n' + JSON.stringify({ meaning: false, folders: [{ name: 'repo', root: args[args.length - 1] }] }) + '\n');
    return fail(opts, 'unexpected ' + args.join(' '));
  } });
  return { ix, home, calls };
}

(async () => {
  assert(DEFAULT_HOME.startsWith(os.homedir()) && /perch.codeindex$/.test(DEFAULT_HOME), 'in the user\'s home, beside dictation\'s, never the system Python');

  // ---- the server a tab gets: before search by meaning is installed, on the machine's own Python
  {
    const { ix } = make();
    const s = ix.mcpServer('/w/repo');
    assert.deepStrictEqual([s.command, s.args], ['python3', [path.join(ROOT, 'codeindex', 'server.py'), '/w/repo']]);
    assert.deepStrictEqual(s.env, { CODEINDEX_MODELS: ix.modelsDir, CODEINDEX_PYTHON: ix.venvPython, CODEINDEX_MARKER: ix.markerPath }, 'and where the environment will be, for the server to move onto it');
    assert.strictEqual(ix.isInstalled(), false);
    assert.deepStrictEqual(ix.mcpServer(['/w/a', '/w/b']).args, [path.join(ROOT, 'codeindex', 'server.py'), '/w/a', '/w/b'], 'a multi-root workspace: every folder, an index each');
  }

  // ---- what the indexes hold, for the panel the footer opens: the server's --status, on the Python the server runs on
  {
    const { ix, calls } = make();
    const s = await ix.status(['/w/a', '/w/b']);
    assert.deepStrictEqual([s.meaning, s.folders, calls.pop()], [false, [{ name: 'repo', root: '/w/b' }], ['python3', 'codeindex/server.py', '--status', '/w/a', '/w/b']], 'the last line is the answer; a log line before it is not');
    assert.strictEqual((await ix.status('/w/a')).folders[0].root, '/w/a', 'one folder, as a string');
    await ix.install(() => {});
    await ix.status('/w/a');
    assert.strictEqual(calls.pop()[0], path.join('venv', 'bin', 'python'), 'search by meaning installed: on that environment\'s Python, where the packages are');
  }

  // ---- whether this machine's Python can run it: asked once
  {
    const { ix, calls } = make();
    assert.strictEqual(await ix.probe(), true);
    assert.strictEqual(await ix.probe(), true);
    assert.strictEqual(calls.length, 1, 'asked once');
    const bad = make({ fail: 'probe' });
    assert.strictEqual(await bad.ix.probe(), false, 'too old, or SQLite without FTS5: no tool, rather than a server that fails');
  }

  // ---- installing search by meaning
  {
    const { ix, calls } = make();
    const steps = [];
    const [a, b] = [ix.install((m, p) => steps.push(p)), ix.install(() => {})];
    assert.strictEqual(a, b, 'one install at a time: a second ask waits for the first');
    assert.deepStrictEqual(await a, { ready: true, model: 'sentence-transformers/all-MiniLM-L6-v2' });
    assert.deepStrictEqual(steps, [5, 15, 70, 100]);
    assert.deepStrictEqual(calls.map((c) => c.slice(0, 3).join(' ')), ['python3 -m venv', 'venv/bin/python -c import pip', 'venv/bin/python -m pip', 'venv/bin/python -m pip', 'venv/bin/python codeindex/server.py --download-only']);
    assert(calls.some((c) => c.includes('-r') && c.includes('codeindex/requirements.txt')), 'fastembed, pinned, from Perch\'s own requirements');
    assert.strictEqual(ix.isInstalled(), true);
    assert.strictEqual(ix.mcpServer('/w').command, ix.venvPython, 'from then on, the server runs on the environment\'s Python');
    const m = JSON.parse(fs.readFileSync(ix.markerPath, 'utf8'));
    assert.deepStrictEqual([m.ready, m.model, m.requirements], [true, 'sentence-transformers/all-MiniLM-L6-v2', ix.requirementsHash()]);
    fs.writeFileSync(ix.markerPath, JSON.stringify(Object.assign(m, { requirements: 'older' })));
    assert.strictEqual(ix.isInstalled(), false, 'new requirements: installed again');
    calls.length = 0;
    await ix.install();
    assert.deepStrictEqual(calls[0].slice(0, 3), ['venv/bin/python', '-c', 'import pip'], 'the environment is there: only what changed is done');
  }

  // ---- a Python without ensurepip (Debian, and Ubuntu without python3-venv): pip's own installer
  {
    const { ix, calls } = make({ fail: 'ensurepip' });
    await ix.install();
    assert(calls.some((c) => c.includes('--without-pip')) && calls.some((c) => /get-pip\.py$/.test(c[1] || '')), calls.map((c) => c.join(' ')).join('\n'));
    assert(!fs.existsSync(path.join(ix.home, 'get-pip.py')), 'and the installer is not left behind');
    assert.strictEqual(ix.isInstalled(), true);
  }

  // ---- failures: said, and nothing marked installed
  for (const fail of ['pip', 'model']) {
    const { ix } = make({ fail });
    await assert.rejects(ix.install(), fail === 'pip' ? /No matching distribution found for fastembed/ : /no route to huggingface\.co/);
    assert.strictEqual(ix.isInstalled(), false, fail);
    assert.strictEqual(ix.installing, null, 'and a later install may try again');
  }
  console.log('CODE INDEX OK');
})().catch((e) => { console.error(e); process.exit(1); });
