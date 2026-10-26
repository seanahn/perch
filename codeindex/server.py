#!/usr/bin/env python3
"""codebase_search for Claude Code and Codex, over stdio MCP (design: docs/notes/201-codebase-indexing.md).

usage: server.py [root]         the tree to search; the current directory if not given
       server.py --index [root]     build or bring the index up to date once, and say what is there
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

REFRESH_S = 30            # a search looks for changed files at most this often
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
        'top_k': {'type': 'integer', 'description': 'How many files to return (default 5)', 'minimum': 1, 'maximum': 20}},
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


class Server:
    def __init__(self, root):
        self.root = root
        self.index = None
        self.error = None
        self.ready = threading.Event()        # the keyword index has been built once
        self.refreshing = threading.Lock()
        self.checked = 0.0
        threading.Thread(target=self._start, daemon=True).start()
        threading.Thread(target=self._idle, daemon=True).start()

    def _start(self):
        try:
            self.index = indexer.Index(self.root, embedder=indexer.Embedder())
            # another process may be building this index (two tabs started together): wait for it rather than search
            # what little is there yet
            while self.index.update() is None and not self.index.counts()['files']:
                time.sleep(1)
            self._refresh()
        except Exception as e:            # an index that cannot be made is said in results, not by a dead server
            self.error = str(e)
        finally:
            self.ready.set()

    def _refresh(self):
        if not self.refreshing.acquire(blocking=False):
            return
        try:
            self.checked = time.time()
            self.index.update()
            self.ready.set()
            self.index.embed_missing()
        finally:
            self.refreshing.release()

    def _idle(self):
        while True:
            time.sleep(60)
            if self.index and self.index.embedder:
                self.index.embedder.unload(IDLE_UNLOAD_S)

    def _waiting(self):
        p = self.index.progress if self.index else {}
        if p.get('total'):
            return f"The index is being built: {p['done']} of {p['total']} {'files' if p.get('phase') == 'keywords' else 'sections'}. Use grep meanwhile."
        return 'The index is being built. Use grep meanwhile.'

    def search(self, query, k):
        if indexer.Ignore(self.root).off:
            return "Search is off for this repository: its .codebaseignore is '*'. Use grep."
        if not self.ready.wait(timeout=10):
            return self._waiting()
        if self.error or not self.index:
            return f'The index could not be built: {self.error}. Use grep.'
        if time.time() - self.checked > REFRESH_S:
            threading.Thread(target=self._refresh, daemon=True).start()
        mode, hits = self.index.search(query, k)
        if not hits:
            return 'Nothing matched. Try other words, or grep for a name.'
        c = self.index.counts()
        how = ('by meaning' if mode == 'meaning' else
               'by keywords; search by meaning is still being built' if self.index.embedder.available() else
               'by keywords; search by meaning is not installed')
        lines = [f"{h['path']}:{h['start']}-{h['end']}  {h['name'][:60]}  ({h['score']})" for h in hits]
        return f"Files by relevance, {how} ({c['files']} files indexed):\n" + '\n'.join(lines)

    def status(self):
        if not self.index:
            return self._waiting() if not self.error else f'The index could not be built: {self.error}'
        s = indexer.summary(self.index)
        mode = 'off (.codebaseignore is *)' if s['off'] else ('by meaning' if s['meaning'] and s['sections'] and s['vectors'] >= 0.9 * s['sections'] else 'by keywords')
        return (f"Search: {mode}. {s['files']} files, {s['sections']} sections, {s['vectors']} with vectors"
                f"{'' if s['meaning'] else ' (the embedding runtime is not installed)'}. "
                f"Left out by .codebaseignore: {', '.join(s['ignore']) or 'nothing'}; also lockfiles, binaries, files over 256 KB "
                f"and what git ignores. Index: {s['index']}.")


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
    if os.environ.get('CODEINDEX_UPGRADED') or (server.index and server.index.embedder and server.index.embedder.available()):
        return
    sys.stdout.flush()
    os.execve(py, [py, os.path.abspath(__file__)] + sys.argv[1:], dict(os.environ, CODEINDEX_UPGRADED='1'))


def serve(root):
    server = Server(root)
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
                        reply(id_, text(server.search(q, max(1, min(20, int(a.get('top_k') or 5))))))
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


USAGE = """usage: server.py [root]           serve codebase_search over stdio MCP for the tree at root (default: the current directory)
       server.py --index [root]   build or bring the index up to date once, and say what is there
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
    rest = [a for a in args if not a.startswith('-')]
    root = os.path.abspath(rest[0] if rest else os.getcwd())
    if '--index' in args:
        print(json.dumps(indexer.main(root), indent=1))
        return 0
    serve(root)
    return 0


if __name__ == '__main__':
    sys.exit(main())
