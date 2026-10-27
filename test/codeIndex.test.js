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

// what Ubuntu 22.04's python3 -m venv prints, on stdout, exiting 1 with stderr empty, when python3-venv is not installed
const UBUNTU_VENV = 'The virtual environment was not created successfully because ensurepip is not\navailable.  On Debian/Ubuntu systems, you need to install the python3-venv\npackage using the following command.\n\n    apt install python3.10-venv\n\nYou may need to use sudo with that command.  After installing the python3-venv\npackage, recreate your virtual environment.\n\nFailing command: /home/u/.local/share/perch/codeindex/venv/bin/python3\n\n';

/** A CodeIndex whose Python is node, saying what each step would: o.fail names the step that fails. */
function make(o = {}) {
  const home = mk(); const calls = [];
  const ok = (opts, out = '') => cp.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(out)})`], opts);
  const fail = (opts, msg) => cp.spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(msg + '\n')}); process.exit(1)`], opts);
  const ix = new CodeIndex({ root: ROOT, home, python: 'python3', fetch: async () => 'print("get-pip")', spawn: (cmd, args, opts) => {
    const a = args.map((x) => (x.startsWith(home) ? x.slice(home.length + 1) : x.startsWith(ROOT) ? path.relative(ROOT, x) : x));
    calls.push([cmd.startsWith(home) ? cmd.slice(home.length + 1) : cmd, ...a]);
    if (args[0] === '-c' && args[1] === PROBE) return o.fail === 'probe' ? fail(opts, 'AssertionError') : ok(opts);
    const noPip = o.fail === 'ensurepip' || o.fail === 'ensurepip-stdout';   // Debian says so on stderr, Ubuntu on stdout with nothing on stderr
    if (args[0] === '-m' && args[1] === 'venv') {
      fs.mkdirSync(path.dirname(ix.venvPython), { recursive: true }); fs.writeFileSync(ix.venvPython, '');   // laid out even when it fails, as Debian's does
      if (noPip && !args.includes('--without-pip')) {
        if (o.fail === 'ensurepip') return fail(opts, "Error: Command '[...] -m ensurepip --upgrade --default-pip' returned non-zero exit status 1.");
        return cp.spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(UBUNTU_VENV)}); process.exit(1)`], opts);
      }
      return ok(opts);
    }
    if (args[0] === '-c' && args[1] === 'import pip') return noPip && !ix._pip ? fail(opts, "No module named 'pip'") : ok(opts);
    if (args[0] === '-m' && args[1] === 'ensurepip') return noPip ? fail(opts, 'No module named ensurepip') : ok(opts);
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

  // ---- Ubuntu without python3-venv: venv lays the environment out, says why on stdout and exits 1 with nothing on stderr;
  // the environment is taken without pip all the same, and pip brought in from PyPI's bootstrap
  {
    const { ix, calls } = make({ fail: 'ensurepip-stdout' });
    await ix.install(() => {});
    assert.deepStrictEqual([calls.some((c) => c[1] === '-m' && c[2] === 'venv' && c[3] === '--without-pip'), calls.some((c) => /get-pip\.py$/.test(c[1])), ix.isInstalled()], [true, true, true]);
  }
  // a command that fails saying nothing on stderr: its last words on stdout, not just the exit code; the whole on the error
  {
    const ix = new CodeIndex({ root: ROOT, home: mk(), python: 'python3' });
    await assert.rejects(ix.run(process.execPath, ['-e', 'process.stdout.write("one\\ntwo\\n\\nthree\\nfour\\n"); process.exit(2)']), (e) => e.message === 'two three four' && /one\ntwo/.test(e.output));
    await assert.rejects(ix.run(process.execPath, ['-e', 'process.stderr.write("bad\\n"); process.stdout.write("noise\\n"); process.exit(2)']), (e) => e.message === 'bad', 'stderr first, as before');
    await assert.rejects(ix.run(process.execPath, ['-e', 'process.exit(3)']), (e) => /exited with 3$/.test(e.message), 'nothing said: the exit code');
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
