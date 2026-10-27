#!/usr/bin/env python3
"""codebase_search for Claude Code and Codex, over stdio MCP (design: docs/notes/201-codebase-indexing.md).

usage: server.py [root ...]     the trees to search, each with an index of its own; the current directory if none
       server.py --index [root ...] build or bring the indexes up to date once, and say what is there
       server.py --status [root ...] what the indexes hold, as JSON, for Perch's footer; nothing is built
       server.py --download-only    fetch the embedding model and say whether it loads, for Perch's installer

Plain JSON-RPC, one message a line. The handshake is answered at once and the index is built or brought up to date
in the background, keywords first (seconds), then vectors where the embedding runtime is installed. The two tools and
their descriptions are fixed text: they sit in the cached prefix of every request, so anything that changes (how far
the index has got, whether search is by meaning yet) is said in results, never in descriptions.
"""
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import indexer  # noqa: E402

REFRESH_S = float(os.environ.get('CODEINDEX_REFRESH_S', 30))   # a search looks for changed files at most this often
IDLE_UNLOAD_S = 600       # the embedding model is let go after this long unused: each tab's process has its own server

SEARCH = {
    'name': 'codebase_search',
    'description': (
        'Search this repository by meaning. Use it when you do not know the names of the files, functions or settings '
        'involved: describe what the code or document does, in plain words. It returns the files whose sections match '
        'best, most relevant first, with the matching line range. Read the first file; read another only if the first '
        'does not answer the question. When you know an exact name, use grep instead.'),
    'inputSchema': {'type': 'object', 'properties': {
        'query': {'type': 'string', 'description': 'What you are looking for, in plain words'},
        'folder': {'type': 'string', 'description': 'Search one workspace folder only, by its name as the Explorer shows it (codebase_status lists them). Default: every folder'},
        'top_k': {'type': 'integer', 'description': 'How many files to return (default 5; 8 when the workspace has more than two folders)', 'minimum': 1, 'maximum': 20}},
        'required': ['query']},
    'annotations': {'readOnlyHint': True},
}
STATUS = {
    'name': 'codebase_status',
    'description': 'How far the codebase_search index has got: files and sections indexed, whether search is by meaning or by keywords, and what is left out.',
    'inputSchema': {'type': 'object', 'properties': {}},
    'annotations': {'readOnlyHint': True},
}
INSTRUCTIONS = ('codebase_search finds files in this repository by meaning. Use it first when a question describes what '
                'something does without naming its files or identifiers; use grep for exact names.')


class Folder:
    """One root of the workspace: its index, and whether it could be built."""

    def __init__(self, root):
        self.root = root
        self.name = os.path.basename(root.rstrip(os.sep)) or root
        self.index = None
        self.error = None

    def off(self):
        return indexer.Ignore(self.root).off


class Server:
    """The folders of a workspace, searched together: one index each (its own .codebaseignore, its own place under
    ~/.cache/codebase-index/), one embedding model between them."""

    def __init__(self, roots):
        seen, self.folders = set(), []
        for r in roots:
            key = os.path.realpath(r)
            if key not in seen:
                seen.add(key)
                self.folders.append(Folder(r))
        names = [f.name for f in self.folders]
        for f in self.folders:                   # two folders of one name: told apart by their paths
            if names.count(f.name) > 1:
                f.name = f.root
        self.many = len(self.folders) > 1
        self.embedder = indexer.Embedder()
        self.ready = threading.Event()          # every folder's keyword index has been built once, or failed
        self.refreshing = threading.Lock()
        self.checked = 0.0
        threading.Thread(target=self._start, daemon=True).start()
        threading.Thread(target=self._idle, daemon=True).start()

    def _start(self):
        try:
            for f in self.folders:
                try:
                    f.index = indexer.Index(f.root, embedder=self.embedder)
                    # another process may be building this index (two tabs started together): wait for it rather than
                    # search what little is there yet
                    while f.index.update() is None and not f.index.counts()['files']:
                        time.sleep(1)
                except Exception as e:            # an index that cannot be made is said in results, not by a dead server
                    f.error = str(e)
            self.ready.set()
            self._refresh()
        finally:
            self.ready.set()

    def _update(self):
        """Every folder's keyword index brought up to date, now: a stat of each file, milliseconds, and the changed
        files re-indexed."""
        self.checked = time.time()
        for f in self.folders:
            if f.index and not f.error:
                try:
                    f.index.update(wait_s=2.0)   # another updater (a tab started at the same moment) is brief: wait for it
                except Exception as e:
                    f.error = str(e)

    def _embed(self):
        """Vectors for the sections that have none, in the background, one run at a time."""
        if not self.refreshing.acquire(blocking=False):
            return
        try:
            for f in self.folders:
                if f.index and not f.error:
                    try:
                        f.index.embed_missing()
                    except Exception as e:
                        f.error = str(e)
        finally:
            self.refreshing.release()

    def _refresh(self):
        self._update()
        self._embed()

    def _idle(self):
        while True:
            time.sleep(60)
            self.embedder.unload(IDLE_UNLOAD_S)

    def _waiting(self):
        for f in self.folders:
            p = f.index.progress if f.index else {}
            if p.get('total'):
                where = f' of {f.name}' if self.many else ''
                return f"The index{where} is being built: {p['done']} of {p['total']} {'files' if p.get('phase') == 'keywords' else 'sections'}. Use grep meanwhile."
        return 'The index is being built. Use grep meanwhile.'

    def _path(self, f, h):
        return os.path.join(f.root, h['path']) if self.many else h['path']   # several folders: paths the agent can open from anywhere

    def default_k(self):
        return 8 if len(self.folders) > 2 else 5     # many folders compete: five is thin

    def search(self, query, k, folder=None):
        chosen = self.folders
        if folder:
            want = folder.strip().rstrip('/')
            chosen = [f for f in self.folders if want.lower() in (f.name.lower(), f.root.lower(), os.path.basename(f.root.rstrip(os.sep)).lower())]
            if not chosen:
                return f"No workspace folder is called {folder!r}. The folders: {', '.join(f.name for f in self.folders)}."
        on = [f for f in chosen if not f.off()]
        if not on:
            return ("Search is off for this workspace: every folder's .codebaseignore is '*'. Use grep." if self.many
                    else "Search is off for this repository: its .codebaseignore is '*'. Use grep.")
        if not self.ready.wait(timeout=10):
            return self._waiting()
        if time.time() - self.checked > REFRESH_S:
            self._update()                       # inline: a changed file is in this answer, by keywords
            threading.Thread(target=self._embed, daemon=True).start()   # its vectors a moment later
        found, failed = [], []
        for f in on:
            if f.error or not f.index:
                failed.append(f)
                continue
            mode, hits = f.index.search(query, k)
            found.append((f, mode, hits))
        if not found:
            return f'The index could not be built: {failed[0].error}. Use grep.'
        meaning = all(mode == 'meaning' for _, mode, _ in found)
        if meaning:                              # cosine scores compare across folders
            rows = sorted(((h['score'], f, h) for f, _, hits in found for h in hits), key=lambda r: -r[0])
        else:                                    # BM25 scores do not: by rank, a folder at a time
            lists = [[(h['score'], fo, h) for h in hits] for fo, _, hits in found]
            rows = [l[i] for i in range(k) for l in lists if i < len(l)]
        rows = rows[:k]
        if not rows:
            return 'Nothing matched. Try other words, or grep for a name.'
        files = sum(f.index.counts()['files'] for f, _, _ in found)
        how = ('by meaning' if meaning else
               'by keywords; search by meaning is still being built' if self.embedder.available() else
               'by keywords; search by meaning is not installed')
        where = (f', in {found[0][0].name}' if folder else f' in {len(found)} folders') if self.many else ''
        broken = f"; no index for {', '.join(f.name for f in failed)}" if failed else ''
        lines = [f"{self._path(f, h)}:{h['start']}-{h['end']}  {h['name'][:60]}  ({h['score']})" for _, f, h in rows]
        return f"Files by relevance, {how} ({files} files indexed{where}{broken}):\n" + '\n'.join(lines)

    def _line(self, f):
        if f.error:
            return f'index failed: {f.error}'
        if not f.index:
            return 'being built'
        s = indexer.summary(f.index)
        mode = 'off (.codebaseignore is *)' if s['off'] else ('by meaning' if s['meaning'] and s['sections'] and s['vectors'] >= 0.9 * s['sections'] else 'by keywords')
        return (f"{mode}. {s['files']} files, {s['sections']} sections, {s['vectors']} with vectors. "
                f"Left out by .codebaseignore: {', '.join(s['ignore']) or 'nothing'}")

    def status(self):
        self.ready.wait(timeout=10)             # the keyword indexes take a second: say what is there, not that nothing is yet
        tail = (f"{'' if self.embedder.available() else ' The embedding runtime is not installed.'} Also left out: lockfiles, binaries, "
                f"files over 256 KB and what git ignores. Indexes under {os.path.dirname(indexer.cache_dir(self.folders[0].root))}.")
        if not self.many:
            f = self.folders[0]
            if f.error or not f.index:
                return self._waiting() if not f.error else f'The index could not be built: {f.error}'
            return f'Search: {self._line(f)};' + tail.replace(' Also left out:', ' also') + ''
        return 'Search by folder:\n' + '\n'.join(f'- {f.name}: {self._line(f)}' for f in self.folders) + '\n' + tail.strip()


def reply(id_, result=None, error=None):
    msg = {'jsonrpc': '2.0', 'id': id_}
    msg.update({'error': error} if error else {'result': result})
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()


def text(t, error=False):
    return {'content': [{'type': 'text', 'text': t}], **({'isError': True} if error else {})}


def lines():
    """Messages from stdin, a line each, read without read-ahead: what is buffered is known, so the process can be
    replaced between two messages with nothing lost (upgrade). Yields None when nothing is waiting in the buffer."""
    buf = b''
    while True:
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            yield line.decode('utf-8', 'replace'), bool(buf)
        chunk = os.read(0, 65536)
        if not chunk:
            return
        buf += chunk


def upgrade(server):
    """Once search by meaning is installed (Perch says where: CODEINDEX_PYTHON, CODEINDEX_MARKER), go on as the private
    environment's Python: the same process, the same pipe, the same tools, so the client sees nothing change."""
    py, marker = os.environ.get('CODEINDEX_PYTHON'), os.environ.get('CODEINDEX_MARKER')
    if os.name != 'posix' or not py or not marker or not os.path.exists(marker) or not os.path.exists(py):
        return
    # once: the environment's python is a symlink to the machine's, so the two cannot be told apart by path
    if os.environ.get('CODEINDEX_UPGRADED') or server.embedder.available():
        return
    sys.stdout.flush()
    os.execve(py, [py, os.path.abspath(__file__)] + sys.argv[1:], dict(os.environ, CODEINDEX_UPGRADED='1'))


def serve(roots):
    server = Server(roots)
    checked = 0.0
    for line, more in lines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        method, id_ = m.get('method'), m.get('id')
        if id_ is None:
            continue                               # notifications: initialized, cancelled
        try:
            if method == 'initialize':
                reply(id_, {'protocolVersion': (m.get('params') or {}).get('protocolVersion', '2025-06-18'),
                            'capabilities': {'tools': {}}, 'serverInfo': {'name': 'codebase', 'version': '1'},
                            'instructions': INSTRUCTIONS})
            elif method == 'tools/list':
                reply(id_, {'tools': [SEARCH, STATUS]})
            elif method == 'tools/call':
                p = m.get('params') or {}
                a = p.get('arguments') or {}
                if p.get('name') == 'codebase_search':
                    q = str(a.get('query', '')).strip()
                    if not q:
                        reply(id_, text('codebase_search needs a query.', True))
                    else:
                        k = max(1, min(20, int(a.get('top_k') or server.default_k())))
                        reply(id_, text(server.search(q, k, str(a.get('folder') or '').strip() or None)))
                elif p.get('name') == 'codebase_status':
                    reply(id_, text(server.status()))
                else:
                    reply(id_, text('No such tool: ' + str(p.get('name')), True))
            elif method == 'ping':
                reply(id_, {})
            else:
                reply(id_, error={'code': -32601, 'message': 'method not found: ' + str(method)})
        except Exception as e:                     # a failed call is an answer, not a dead server
            reply(id_, text(f'codebase_search failed: {e}', True))
        if not more and time.time() - checked > REFRESH_S:
            checked = time.time()
            upgrade(server)


def status_json(roots):
    """What the indexes of these trees hold, from their files alone, for the panel Perch's footer opens and reads again
    every few seconds while open: per folder the counts, and whether another process is indexing or embedding it now
    (its lock held); whether search by meaning is installed on this Python, by its packages being there (no import: an
    import of fastembed takes a second, too much for a poll). Nothing is built or brought up to date here."""
    import importlib.util
    folders = [Folder(os.path.abspath(r)) for r in roots]
    names = [f.name for f in folders]
    out = {'meaning': all(importlib.util.find_spec(m) is not None for m in ('fastembed', 'numpy')), 'folders': []}
    for f in folders:
        d = indexer.cache_dir(f.root, create=False)
        e = {'name': f.root if names.count(f.name) > 1 else f.name, 'root': f.root, 'off': f.off(), 'built': os.path.exists(os.path.join(d, 'index.db')),
             'files': 0, 'sections': 0, 'vectors': 0, 'updated': None, 'updating': False, 'embedding': False, 'ignore': indexer.Ignore(f.root).patterns}
        if e['built']:
            e.update(indexer.Index(f.root, cache=d).counts())
            for key, name in (('updating', 'update.lock'), ('embedding', 'embed.lock')):
                lock = indexer.Lock(os.path.join(d, name))
                if lock.acquire():
                    lock.release()
                else:
                    e[key] = True
        out['folders'].append(e)
    return out


def download_only():
    """Fetch the embedding model and check it loads: one JSON line, {"ready": true} or {"ready": false, "error": ...}."""
    try:
        e = indexer.Embedder()
        if not e.available():
            raise RuntimeError('fastembed is not installed in this Python')
        e.query('hello')
        print(json.dumps({'ready': True, 'model': e.model_name}), flush=True)
        return 0
    except Exception as err:
        print(json.dumps({'ready': False, 'error': str(err)}), flush=True)
        return 1


USAGE = """usage: server.py [root ...]       serve codebase_search over stdio MCP for these trees, an index each (default: the current directory)
       server.py --index [root ...]  build or bring the indexes up to date once, and say what is there
       server.py --status [root ...] what the indexes hold, as JSON; nothing is built
       server.py --download-only  fetch the embedding model and say whether it loads

Outside Perch:  claude mcp add -s user codebase -- python3 /path/to/perch/codeindex/server.py
                and allow the tools in ~/.claude/settings.json:
                {"permissions": {"allow": ["mcp__codebase__codebase_search", "mcp__codebase__codebase_status"]}}
                codex mcp add codebase -- python3 /path/to/perch/codeindex/server.py
Search by meaning needs fastembed in that Python (codeindex/requirements.txt)."""


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if '-h' in args or '--help' in args:
        print(USAGE)
        return 0
    if '--download-only' in args:
        return download_only()
    roots = [os.path.abspath(a) for a in args if not a.startswith('-')] or [os.getcwd()]
    if '--index' in args:
        print(json.dumps([indexer.main(r) for r in roots] if len(roots) > 1 else indexer.main(roots[0]), indent=1))
        return 0
    if '--status' in args:
        print(json.dumps(status_json(roots)))
        return 0
    serve(roots)
    return 0


if __name__ == '__main__':
    sys.exit(main())
