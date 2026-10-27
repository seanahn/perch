"""Codebase search (codeindex/): the indexer and the MCP server, against throwaway git repositories. No model is loaded:
the vector path runs on a fake embedder, and the server is run on this Python, which has no fastembed."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'codeindex'))
import indexer  # noqa: E402

TMP = tempfile.mkdtemp(prefix='perch-codeindex-')
os.environ['CODEINDEX_CACHE'] = os.path.join(TMP, 'cache')       # never the developer's own ~/.cache
os.environ['CODEINDEX_MODELS'] = os.path.join(TMP, 'models')


def write(root, rel, text, mode='w'):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, mode) as f:
        f.write(text)


def git(root, *args):
    subprocess.run(['git', '-C', root, *args], check=True, capture_output=True)


def repo(name):
    root = os.path.join(TMP, name)
    os.makedirs(root)
    git(root, 'init', '-q')
    write(root, 'src/gateway.py', 'import os\n\n\ndef gatewaySetup(url):\n    """Point the client at the gateway."""\n    return url\n\n\nclass Relay:\n    def forward(self):\n        return 1\n')
    write(root, 'docs/notes/101-relay.md', '# 101 — The relay\n\nIntro.\n\n## How a response model is read\n\nThe relay reads the deployment header.\n\n## Cost\n\nPrices per token.\n')
    write(root, 'README.md', 'The project.\n' + 'Line about nothing.\n' * 150)
    write(root, 'package-lock.json', '{"lock": true}\n')
    write(root, 'logo.png', 'not really a png\n')
    write(root, 'node_modules/x/index.js', 'module.exports = 1\n')
    write(root, '.gitignore', 'secret.env\n')
    write(root, 'secret.env', 'TOKEN=abc\n')
    write(root, 'big.txt', 'x' * (300 * 1024))
    write(root, 'latin1.txt', b'caf\xe9\n', 'wb')
    git(root, 'add', '-A')
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one')
    write(root, 'scripts/untracked_tool.sh', '#!/bin/sh\necho "rotate the signing keys"\n')
    return root


try:
    # ---- sections and words
    names = [c[0] for c in indexer.chunks('a.py', 'import os\n\n\ndef one():\n    return 1\n\n\nclass Two:\n    pass\n')]
    assert names == ['one', 'Two', '(module)'], names
    md = list(indexer.chunks('n.md', '# Title\n\nx\n\n## Part\n\ny\n'))
    assert [(c[0], c[1], c[2]) for c in md] == [('Title', 1, 4), ('Part', 5, 7)], md
    win = list(indexer.chunks('a.txt', '\n'.join(str(i) for i in range(130))))
    assert [(c[1], c[2]) for c in win] == [(1, 60), (51, 110), (101, 130)], win
    assert [c[0] for c in indexer.chunks('bad.py', 'def (:\n')] == [''], 'a file Python cannot parse goes by windows'
    assert indexer.words('gatewaySetup gateway_setup HTTPServer v2') == 'gateway setup gateway setup http server v 2'
    assert indexer.terms('Where is the gateway_setup defined?') == ['gateway', 'setup', 'defined']

    # ---- what is left out
    root = repo('one')
    ig = indexer.Ignore(root)
    assert not ig.off and ig.patterns == []
    assert ig.skip('package-lock.json') and ig.skip('logo.png') and ig.skip('node_modules/x/index.js') and ig.skip('.venv-a/lib/x.py')
    assert not ig.skip('src/gateway.py')
    for s in ('.env', 'deploy/.env.production', 'certs/server.pem', 'keys/signing.key', '.ssh/id_ed25519', 'gcp/credentials.json', '~/.netrc'[2:], 'tokens/azure.pat'):
        assert ig.skip(s), 'a secret, whatever git says: ' + s
    assert not ig.skip('src/env.py') and not ig.skip('docs/keys.md')
    write(root, '.codebaseignore', '# templates are noise\nsecurity_scripts/nuclei/\n*.min.js\n')
    ig = indexer.Ignore(root)
    assert ig.patterns == ['security_scripts/nuclei/', '*.min.js']
    assert ig.skip('security_scripts/nuclei/x.yaml') and ig.skip('web/app.min.js') and not ig.skip('security_scripts/run.py')
    os.remove(os.path.join(root, '.codebaseignore'))
    files = indexer.list_files(root, indexer.Ignore(root))
    assert 'scripts/untracked_tool.sh' in files, 'untracked but not ignored: in'
    assert 'secret.env' not in files and 'package-lock.json' not in files and 'logo.png' not in files, files

    # ---- a folder that is no repository but holds some (a home directory opened as the workspace): each repository by
    # git's view and its own .codebaseignore; no hidden file or directory at all
    home = os.path.join(TMP, 'home')
    inner = repo('home/inner')
    write(inner, '.codebaseignore', 'docs/\n')
    write(home, 'notes.txt', 'plain notes\n')
    write(home, '.bash_history', 'export TOKEN=abc\n')
    write(home, '.cache/x.txt', 'cached\n')
    write(home, 'plain/sub/.hidden', 'x\n')
    write(home, 'plain/sub/readme.md', 'readme\n')
    got = indexer.list_files(home, indexer.Ignore(home))
    assert 'notes.txt' in got and 'plain/sub/readme.md' in got and 'inner/src/gateway.py' in got, got
    assert 'inner/scripts/untracked_tool.sh' in got, 'untracked but not ignored, by git\'s view of that repository'
    for bad in ('.bash_history', '.cache/x.txt', 'plain/sub/.hidden', 'inner/secret.env', 'inner/package-lock.json', 'inner/docs/notes/101-relay.md', 'inner/logo.png'):
        assert bad not in got, bad + ' must be out'
    write(inner, '.codebaseignore', '*\n')
    assert not any(p.startswith('inner/') for p in indexer.list_files(home, indexer.Ignore(home))), 'a repository that says no'

    # ---- building, and bringing up to date
    ix = indexer.Index(root)
    assert ix.dir.startswith(os.environ['CODEINDEX_CACHE']) and oct(os.stat(ix.dir).st_mode & 0o777) == '0o700', 'private, outside the tree'
    first = ix.update()
    assert first == {'files': 5, 'changed': 5, 'removed': 0}, first        # .gitignore, gateway.py, the note, README, the script
    assert ix.update() == {'files': 5, 'changed': 0, 'removed': 0}, 'nothing changed: nothing read again'
    assert ix.counts()['files'] == 5
    write(root, 'src/gateway.py', 'def gatewaySetup(url):\n    """Point the client at the gateway, and log it."""\n    return url\n')
    os.remove(os.path.join(root, 'scripts/untracked_tool.sh'))
    assert ix.update() == {'files': 4, 'changed': 1, 'removed': 1}
    g0 = ix.generation()
    os.utime(os.path.join(root, 'README.md'))                               # touched, not changed
    assert ix.update()['changed'] == 0 and ix.generation() == g0, 'same content: no new generation'

    # ---- keywords
    hits = ix.keywords('gateway setup', 3)
    assert hits[0]['path'] == 'src/gateway.py' and hits[0]['name'] == 'gatewaySetup', hits
    hits = ix.keywords('which deployment answered, from the response header', 3)
    assert hits[0]['path'] == 'docs/notes/101-relay.md' and hits[0]['name'] == 'How a response model is read', hits
    assert ix.keywords('the of and', 3) == [], 'nothing but stop words: nothing'
    assert ix.search('gateway setup')[0] == 'keywords', 'no embedder: keywords'

    # ---- one updater at a time
    a, b = indexer.Lock(os.path.join(ix.dir, 'update.lock')), indexer.Lock(os.path.join(ix.dir, 'update.lock'))
    assert a.acquire() and not b.acquire(), 'a second process does not update at the same time'
    assert ix.update() is None, 'and an update that finds it held leaves it be'
    a.release()
    assert b.acquire()
    b.release()

    # ---- vectors, on a fake embedder: a vector per word, hashed into 64 dimensions
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        class Fake:
            model_name = 'fake'
            calls = 0

            def available(self):
                return True

            def _v(self, t):
                v = np.zeros(64, np.float32)
                for w in indexer.words(t).split():
                    v[int(hashlib.md5(w.encode()).hexdigest(), 16) % 64] += 1
                return v / (np.linalg.norm(v) or 1)

            def passages(self, texts):
                Fake.calls += len(texts)
                return np.array([self._v(t) for t in texts])

            def query(self, t):
                return self._v(t)

        ix2 = indexer.Index(root, embedder=Fake())
        n = ix2.embed_missing()
        assert n == ix2.counts()['sections'] and ix2.counts()['vectors'] == n, (n, ix2.counts())
        assert ix2.embed_missing() == 0, 'every section has its vector'
        mode, hits = ix2.search('relay deployment header')
        assert mode == 'meaning' and hits[0]['path'] == 'docs/notes/101-relay.md', (mode, hits)
        calls = Fake.calls
        write(root, 'docs/notes/101-relay.md', '# 101 — The relay\n\nIntro.\n\n## How a response model is read\n\nThe relay reads the deployment header.\n\n## Cost\n\nPrices per token, and per request.\n')
        ix2.update()
        assert ix2.embed_missing() == 1 and Fake.calls == calls + 1, 'only the section whose text changed is embedded again'
        other = repo('two')                                                   # a second clone, its own index: sections
        ix3 = indexer.Index(other, cache=ix2.dir.replace(os.path.basename(ix2.dir), 'clone'), embedder=Fake())
        ix3.update()
        assert ix3.embed_missing() == ix3.counts()['sections'], 'another index: its own vectors'

    # ---- the server: MCP over stdio, on this Python (no fastembed: keywords)
    def server(root, *msgs):
        p = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'codeindex', 'server.py'), root],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env=dict(os.environ, CODEINDEX_PYTHON='', CODEINDEX_MARKER=''))
        out = []
        for m in msgs:
            p.stdin.write(json.dumps(m) + '\n')
            p.stdin.flush()
            if 'id' in m:
                out.append(json.loads(p.stdout.readline()))
        p.stdin.close()
        p.wait(timeout=20)
        assert p.returncode == 0, p.stderr.read()
        return out

    call = lambda i, name, args: {'jsonrpc': '2.0', 'id': i, 'method': 'tools/call', 'params': {'name': name, 'arguments': args}}

    def server_many(roots, *msgs):
        p = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'codeindex', 'server.py'), *roots],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env=dict(os.environ, CODEINDEX_PYTHON='', CODEINDEX_MARKER=''))
        out = []
        for m in msgs:
            p.stdin.write(json.dumps(m) + '\n')
            p.stdin.flush()
            out.append(json.loads(p.stdout.readline()))
        p.stdin.close()
        p.wait(timeout=20)
        assert p.returncode == 0, p.stderr.read()
        return out
    r = server(root,
               {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
               {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
               {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
               call(3, 'codebase_search', {'query': 'gateway setup', 'top_k': 2}),
               call(4, 'codebase_status', {}),
               call(5, 'codebase_search', {'query': '  '}),
               call(6, 'nothing_here', {}),
               {'jsonrpc': '2.0', 'id': 7, 'method': 'resources/list'})
    assert r[0]['result']['protocolVersion'] == '2025-06-18' and 'codebase_search' in r[0]['result']['instructions']
    tools = r[1]['result']['tools']
    assert [t['name'] for t in tools] == ['codebase_search', 'codebase_status'] and all(t['annotations']['readOnlyHint'] for t in tools)
    found = r[2]['result']['content'][0]['text']
    assert found.startswith('Files by relevance, by keywords') and 'src/gateway.py:1-3  gatewaySetup' in found, found
    assert r[3]['result']['content'][0]['text'].startswith('Search: by keywords. 4 files'), r[3]
    assert r[4]['result']['isError'] and r[5]['result']['isError'] and r[6]['error']['code'] == -32601
    # the tool list never depends on the index: the same text before and after it is built (it sits in the cached prefix)
    assert json.dumps(tools) == json.dumps(server(root, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})[0]['result']['tools'])

    # a repository that says no: the tool stays, and says so
    write(root, '.codebaseignore', '*\n')
    r = server(root, call(1, 'codebase_search', {'query': 'gateway'}))
    assert 'Search is off for this repository' in r[0]['result']['content'][0]['text'], r
    os.remove(os.path.join(root, '.codebaseignore'))

    # ---- a file changed between two searches of one server: the next search past the refresh window re-indexes it
    # before answering, so the change is found by keywords at once (its vectors follow in the background)
    p = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'codeindex', 'server.py'), root],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         env=dict(os.environ, CODEINDEX_PYTHON='', CODEINDEX_MARKER='', CODEINDEX_REFRESH_S='0'))

    def ask(i, q):
        p.stdin.write(json.dumps(call(i, 'codebase_search', {'query': q, 'top_k': 3})) + '\n')
        p.stdin.flush()
        return json.loads(p.stdout.readline())['result']['content'][0]['text']
    assert 'src/gateway.py' not in ask(1, 'rotate the signing keys'), 'not there yet'
    write(root, 'src/gateway.py', 'def gatewaySetup(url):\n    return url\n\n\ndef rotateSigningKeys():\n    # Rotate the signing keys.\n    return 2\n')
    t = ask(2, 'rotate the signing keys')
    assert 'src/gateway.py:5-7  rotateSigningKeys' in t, 'the change, in the very next search: ' + t
    p.stdin.close()
    p.wait(timeout=20)
    assert p.returncode == 0, p.stderr.read()

    # ---- several folders at once: an index each, searched together, paths the agent can open from anywhere, a folder's
    # own .codebaseignore honoured, the status by folder
    other2 = repo('three')
    write(other2, 'docs/firewall.md', '# Firewall\n\nThe package-install guard blocks a developer.\n')
    r = server_many([root, other2],
                    call(1, 'codebase_search', {'query': 'gateway setup', 'top_k': 4}),
                    call(2, 'codebase_search', {'query': 'package install guard blocks', 'top_k': 2}),
                    call(3, 'codebase_status', {}))
    t1 = r[0]['result']['content'][0]['text']
    assert 'in 2 folders' in t1 and os.path.join(root, 'src/gateway.py') + ':1-2' in t1, t1   # gatewaySetup, as the change above left it
    assert all(l.startswith('/') for l in t1.split('\n')[1:]), 'several folders: absolute paths\n' + t1
    t2 = r[1]['result']['content'][0]['text']
    assert os.path.join(other2, 'docs/firewall.md') in t2, t2
    t3 = r[2]['result']['content'][0]['text']
    assert t3.startswith('Search by folder:\n- one: by keywords. 4 files') and '\n- three: by keywords.' in t3, t3
    write(other2, '.codebaseignore', '*\n')
    r = server_many([root, other2], call(1, 'codebase_search', {'query': 'package install guard blocks', 'top_k': 2}), call(2, 'codebase_status', {}))
    assert os.path.join(other2, 'docs/firewall.md') not in r[0]['result']['content'][0]['text'], 'a folder that says no is left out'
    assert '- three: off (.codebaseignore is *)' in r[1]['result']['content'][0]['text']
    # one folder by name, and a name that is no folder; the default number of hits grows with the folders
    os.remove(os.path.join(other2, '.codebaseignore'))
    r = server_many([root, other2],
                    call(1, 'codebase_search', {'query': 'gateway setup', 'folder': 'three', 'top_k': 5}),
                    call(2, 'codebase_search', {'query': 'gateway setup', 'folder': 'nowhere'}))
    t = r[0]['result']['content'][0]['text']
    assert ', in three' in t.split('\n')[0] and all(l.startswith(other2) for l in t.split('\n')[1:]), 'that folder only\n' + t
    assert r[1]['result']['content'][0]['text'] == "No workspace folder is called 'nowhere'. The folders: one, three.", r[1]
    import server as S
    assert [S.Server.default_k(type('F', (), {'folders': [0] * n})()) for n in (1, 2, 3, 12)] == [5, 5, 8, 8]
    r = server_many([root, root], call(1, 'codebase_status', {}))
    assert r[0]['result']['content'][0]['text'].startswith('Search: by keywords. 4 files'), 'the same folder twice is one folder: ' + r[0]['result']['content'][0]['text']

    # ---- the move onto an installed environment: between two messages the server replaces itself with the environment's
    # Python (here a script that counts its runs, then runs this one), once, and nothing a client sent is lost
    if os.name == 'posix':
        wrapper, runs, marker = os.path.join(TMP, 'venv-python'), os.path.join(TMP, 'runs'), os.path.join(TMP, 'installed.json')
        write(TMP, 'venv-python', f'#!/bin/sh\necho run >> {runs}\nexec {sys.executable} "$@"\n')
        os.chmod(wrapper, 0o755)
        write(TMP, 'installed.json', '{"ready": true}')
        p = subprocess.Popen([sys.executable, os.path.join(HERE, '..', 'codeindex', 'server.py'), root],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env=dict(os.environ, CODEINDEX_PYTHON=wrapper, CODEINDEX_MARKER=marker))
        msgs = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
                {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                call(3, 'codebase_search', {'query': 'gateway setup', 'top_k': 1}),
                call(4, 'codebase_status', {}), {'jsonrpc': '2.0', 'id': 5, 'method': 'ping'}]
        p.stdin.write(''.join(json.dumps(m) + '\n' for m in msgs))     # all at once: a client does not wait between them
        p.stdin.flush()
        got = [json.loads(p.stdout.readline()) for _ in range(5)]
        p.stdin.close()
        p.wait(timeout=20)
        assert [g['id'] for g in got] == [1, 2, 3, 4, 5], got
        assert 'src/gateway.py' in got[2]['result']['content'][0]['text'], 'the search answered by the new process'
        assert open(runs).read().count('run') == 1, 'exec once, not on every message'
        assert p.returncode == 0, p.stderr.read()
    print('CODEINDEX OK')
finally:
    shutil.rmtree(TMP, ignore_errors=True)
