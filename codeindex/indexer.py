"""The codebase index of one directory tree (design: docs/notes/201-codebase-indexing.md).

Its files are cut into sections (Python functions and classes, Markdown sections, windows of lines) and kept in a
SQLite FTS5 table for keyword search (BM25). When an embedding model can be loaded, each section also gets a vector,
for search by meaning. The index lives outside the repository, under ~/.cache/codebase-index/<hash of the root>/,
private to the user, and is brought up to date by size and modification time, then content hash: an unchanged file is
not read again, and a section whose text is unchanged keeps its vector (within one index: another clone has its own). Several processes may share one index (each
Claude Code or Codex process starts its own server): one at a time updates it, the others read.

Standard library only, but for the embeddings (numpy and fastembed), which are optional.
"""
import ast
import fnmatch
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
import warnings

VERSION = 1
MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
MAX_BYTES = 256 * 1024          # a bigger file is data, not code or prose
MAX_FILES = 50000               # the workspace root only; a tree this big is not one to index
WINDOW, OVERLAP = 60, 10        # lines, for files with no structure to follow
MAX_CHARS = 2000                # a section's vector is made from its head: about 256 tokens
SKIP_DIRS = {'.git', '.hg', '.svn', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache'}
SKIP_NAMES = {'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'go.sum',
              'Cargo.lock', 'composer.lock', 'Gemfile.lock',
              # secrets, whatever git says: their names
              '.env', '.netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'service-account.json',
              'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'auth.json', '.credentials.json'}
SKIP_PREFIXES = ('.env.',)      # .env.local, .env.production
SKIP_EXT = {'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.zip', '.gz', '.tgz', '.bz2', '.xz',
            '.7z', '.tar', '.jar', '.war', '.whl', '.egg', '.pyc', '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a',
            '.class', '.parquet', '.pkl', '.npy', '.npz', '.onnx', '.pt', '.db', '.sqlite', '.xlsx', '.xls', '.docx',
            '.pptx', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wav', '.mov', '.vsix',
            # secrets: keys and key stores
            '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.gpg', '.pat'}

warnings.filterwarnings('ignore', category=SyntaxWarning)   # a repository's own odd escapes are not ours to report


def cache_dir(root):
    """Where a tree's index lives: outside it, private to the user, one per tree."""
    base = os.environ.get('CODEINDEX_CACHE') or os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache'), 'codebase-index')
    d = os.path.join(base, hashlib.sha256(os.path.realpath(root).encode()).hexdigest()[:16])
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


class Ignore:
    """`.codebaseignore` at the root: a pattern a line, `#` for comments. `dir/` leaves out a directory, any other
    pattern is matched against the whole relative path (`*.min.js`, `docs/tickets/*`). A file that is just `*` turns
    search off for the tree."""

    def __init__(self, root):
        self.patterns = []
        try:
            with open(os.path.join(root, '.codebaseignore'), encoding='utf-8') as f:
                self.patterns = [l.strip() for l in f if l.strip() and not l.lstrip().startswith('#')]
        except OSError:
            pass
        self.off = self.patterns == ['*']

    def skip(self, rel):
        parts = rel.split('/')
        if any(p in SKIP_DIRS or p.startswith('.venv') for p in parts[:-1]):
            return True
        if parts[-1] in SKIP_NAMES or parts[-1].startswith(SKIP_PREFIXES) or os.path.splitext(parts[-1])[1].lower() in SKIP_EXT:
            return True
        for p in self.patterns:
            if p.endswith('/'):
                if rel.startswith(p) or ('/' + p) in ('/' + rel):
                    return True
            elif fnmatch.fnmatch(rel, p):
                return True
        return False


def list_files(root, ignore):
    """The tree's files, relative: git's view where it is a repository (tracked, and untracked but not ignored), else a walk."""
    try:
        out = subprocess.run(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                             capture_output=True, check=True, timeout=60).stdout.decode('utf-8', 'replace')
        names = sorted({p for p in out.split('\0') if p})
    except (OSError, subprocess.SubprocessError):
        names = []
        for d, dirs, files in os.walk(root):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith('.')]   # no .gitignore to go by: no hidden tree either
            names += [os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/') for f in files]
            if len(names) > MAX_FILES:
                break
    return [p for p in names if not ignore.skip(p)][:MAX_FILES]


def windows(lines, base=1, name=''):
    i = 0
    while i < max(len(lines), 1):
        seg = lines[i:i + WINDOW]
        if seg:
            yield name, base + i, base + i + len(seg) - 1, '\n'.join(seg)
        if i + WINDOW >= len(lines):
            break
        i += WINDOW - OVERLAP


def chunks(path, text):
    """A file's sections: (name, first line, last line, text)."""
    lines, ext = text.split('\n'), os.path.splitext(path)[1].lower()
    if len(lines) > 1 and lines[-1] == '':
        lines.pop()                        # the final newline ends the last line; it does not start another
    if ext == '.py':
        try:
            spans = []
            for node in ast.parse(text).body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    if isinstance(node, ast.ClassDef) and node.end_lineno - node.lineno > 120:   # a big class: its methods each
                        spans += [(node.name + '.' + s.name, s.lineno, s.end_lineno) for s in node.body
                                  if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))]
                        spans.append((node.name, node.lineno, node.lineno + 30))
                    else:
                        spans.append((node.name, node.lineno, node.end_lineno))
            first = min([s[1] for s in spans], default=len(lines) + 1)
            if first > 1:
                spans.append(('(module)', 1, first - 1))
            for name, s, e in spans:
                seg = lines[s - 1:e]
                yield from (windows(seg, s, name) if len(seg) > 200 else [(name, s, e, '\n'.join(seg))])
            return
        except (SyntaxError, ValueError, RecursionError):
            pass
    if ext in ('.md', '.markdown', '.rst'):
        starts = [i for i, l in enumerate(lines) if re.match(r'#{1,6} ', l)]
        if starts:
            bounds = ([0] if starts[0] else []) + starts + [len(lines)]
            for a, b in zip(bounds, bounds[1:]):
                seg = lines[a:b]
                name = seg[0].lstrip('#').strip() if seg and seg[0].startswith('#') else '(head)'
                yield from (windows(seg, a + 1, name) if len(seg) > 120 else [(name, a + 1, b, '\n'.join(seg))])
            return
    yield from windows(lines)


SPLIT = re.compile(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+')


def words(text):
    """Identifiers as their words: gatewaySetup, gateway_setup and gateway-setup all say "gateway setup"."""
    return ' '.join(m.group(0).lower() for m in SPLIT.finditer(text))


STOP = set('''a an and are as at be by can could did do does done for from get gets go goes has have how i in into is it
its me my of on or our out over should the their them then there these this to up us was we were what when where whether
which who why will with without would you your before between first each every most own some still such than that
until very'''.split())


def terms(q):
    out = []
    for w in re.findall(r'[A-Za-z0-9][A-Za-z0-9._-]*', q):
        for t in re.split(r'[._-]+', w.lower()):
            if t and t not in STOP and (len(t) > 2 or t.isdigit()) and t not in out:
                out.append(t)
    return out


class Lock:
    """One process at a time updates an index; the others go on reading what it has."""

    def __init__(self, path):
        self.path, self.fh = path, None

    def acquire(self):
        self.fh = open(self.path, 'a+')
        try:
            try:
                import fcntl
            except ImportError:                     # Windows
                import msvcrt
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (OSError, ImportError):
            self.fh.close()
            self.fh = None
            return False

    def release(self):
        if self.fh:
            self.fh.close()
            self.fh = None


class Embedder:
    """Vectors from MiniLM through fastembed, loaded on first use and let go when unused. available() is False where
    fastembed is not installed: search is then by keywords only."""

    def __init__(self, model=MODEL, threads=None, cache=None):
        self.model_name = model
        self.threads = threads or min(8, os.cpu_count() or 1)     # one process gains nothing past about 8
        self.cache = cache or os.environ.get('CODEINDEX_MODELS') or os.path.join(os.path.expanduser('~'), '.local', 'share', 'perch', 'codeindex', 'models')
        self.model, self.used = None, 0.0

    def available(self):
        try:
            import fastembed  # noqa: F401
            import numpy  # noqa: F401
            return True
        except ImportError:
            return False

    def _load(self):
        if self.model is None:
            from fastembed import TextEmbedding
            self.model = TextEmbedding(self.model_name, cache_dir=self.cache, threads=self.threads)
        self.used = time.time()
        return self.model

    def passages(self, texts):
        """Vectors for texts, normalized, in their order; batched by length, since a batch is padded to its longest."""
        import numpy as np
        m = self._load()
        order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
        out = np.empty((len(texts), 0), dtype=np.float32)
        for k, v in enumerate(m.embed([texts[i] for i in order], batch_size=32)):
            if out.shape[1] == 0:
                out = np.empty((len(texts), len(v)), dtype=np.float32)
            out[order[k]] = v
        n = np.linalg.norm(out, axis=1, keepdims=True)
        return out / np.where(n == 0, 1, n)

    def query(self, text):
        import numpy as np
        v = np.array(list(self._load().embed([text])), dtype=np.float32)[0]
        return v / (np.linalg.norm(v) or 1)

    def unload(self, idle_s):
        if self.model is not None and time.time() - self.used > idle_s:
            self.model = None


class Index:
    def __init__(self, root, cache=None, embedder=None):
        self.root = os.path.realpath(root)
        self.dir = cache or cache_dir(self.root)
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.path = os.path.join(self.dir, 'index.db')
        self.embedder = embedder
        self.ignore = Ignore(self.root)
        self.progress = {'phase': 'idle', 'done': 0, 'total': 0}
        self._matrix = None                 # (generation, model, numpy matrix, rows)
        with self._db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, sha TEXT);
                CREATE TABLE IF NOT EXISTS sections(id INTEGER PRIMARY KEY, path TEXT, name TEXT, start INTEGER, end INTEGER, hash TEXT);
                CREATE INDEX IF NOT EXISTS sections_path ON sections(path);
                CREATE TABLE IF NOT EXISTS vectors(hash TEXT, model TEXT, vec BLOB, PRIMARY KEY(hash, model));
                CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path, name, body, tokenize='porter unicode61');
            ''')
            v = db.execute("SELECT value FROM meta WHERE key='version'").fetchone()
            if v is None or int(v[0]) != VERSION:
                db.executescript('DELETE FROM files; DELETE FROM sections; DELETE FROM fts; DELETE FROM vectors;')
                db.execute("INSERT OR REPLACE INTO meta VALUES ('version', ?)", (str(VERSION),))

    def _db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute('PRAGMA journal_mode=WAL')
        return db

    def generation(self, db=None):
        own = db is None
        db = db or self._db()
        try:
            r = db.execute("SELECT value FROM meta WHERE key='generation'").fetchone()
            return int(r[0]) if r else 0
        finally:
            if own:
                db.close()

    def _bump(self, db):
        db.execute("INSERT OR REPLACE INTO meta VALUES ('generation', ?)", (str(self.generation(db) + 1),))

    def _section_text(self, path, name, lines, s, e):
        return (f'{path} :: {name}\n' + '\n'.join(lines[s - 1:e]))[:MAX_CHARS]

    def update(self, wait_s=0.0):
        """Bring the keyword index up to date with the tree. Returns what changed, or None when another process holds
        the update, which then has it in hand; `wait_s` is how long to wait for it first."""
        lock = Lock(os.path.join(self.dir, 'update.lock'))
        until = time.time() + wait_s
        while not lock.acquire():
            if time.time() >= until:
                return None
            time.sleep(0.05)
        try:
            self.ignore = Ignore(self.root)
            names = [] if self.ignore.off else list_files(self.root, self.ignore)
            db = self._db()
            known = {p: (s, m, h) for p, s, m, h in db.execute('SELECT path, size, mtime, sha FROM files')}
            seen, changed, removed = set(), 0, 0
            self.progress = {'phase': 'keywords', 'done': 0, 'total': len(names)}
            for n, rel in enumerate(names):
                self.progress['done'] = n
                full = os.path.join(self.root, rel)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                if not os.path.isfile(full) or st.st_size > MAX_BYTES:
                    continue
                old = known.get(rel)
                if old and old[0] == st.st_size and old[1] == st.st_mtime_ns:
                    seen.add(rel)
                    continue
                try:
                    with open(full, 'rb') as f:
                        raw = f.read()
                    text = raw.decode('utf-8')
                except (OSError, UnicodeDecodeError):
                    continue                                  # not text: left out, and dropped if it was in
                seen.add(rel)
                sha = hashlib.sha256(raw).hexdigest()
                if old and old[2] == sha:
                    db.execute('UPDATE files SET size=?, mtime=? WHERE path=?', (st.st_size, st.st_mtime_ns, rel))
                    continue
                self._drop(db, rel)
                lines = text.split('\n')
                for name, s, e, body in chunks(rel, text):
                    if not body.strip():
                        continue
                    h = hashlib.sha256(self._section_text(rel, name, lines, s, e).encode()).hexdigest()[:32]
                    cur = db.execute('INSERT INTO sections(path, name, start, end, hash) VALUES (?,?,?,?,?)', (rel, name, s, e, h))
                    db.execute('INSERT INTO fts(rowid, path, name, body) VALUES (?,?,?,?)',
                               (cur.lastrowid, words(rel), words(name) + ' ' + name, body + '\n' + words(body)))
                db.execute('INSERT OR REPLACE INTO files VALUES (?,?,?,?)', (rel, st.st_size, st.st_mtime_ns, sha))
                changed += 1
                if changed % 200 == 0:
                    db.commit()
            for rel in set(known) - seen:
                self._drop(db, rel)
                db.execute('DELETE FROM files WHERE path=?', (rel,))
                removed += 1
            if changed or removed:
                self._bump(db)
            db.execute("INSERT OR REPLACE INTO meta VALUES ('updated', ?)", (str(int(time.time())),))
            db.commit()
            db.close()
            self.progress = {'phase': 'idle', 'done': 0, 'total': 0}
            return {'files': len(seen), 'changed': changed, 'removed': removed}
        finally:
            lock.release()

    def _drop(self, db, rel):
        ids = [r[0] for r in db.execute('SELECT id FROM sections WHERE path=?', (rel,))]
        for i in ids:
            db.execute('DELETE FROM fts WHERE rowid=?', (i,))
        db.execute('DELETE FROM sections WHERE path=?', (rel,))

    def embed_missing(self, batch=512):
        """Vectors for the sections that have none yet, from the embedding model; None when another process holds the
        update. A section whose text is unchanged keeps its vector, wherever in the tree it has moved."""
        if not self.embedder or not self.embedder.available():
            return 0
        lock = Lock(os.path.join(self.dir, 'embed.lock'))   # its own: a keyword update never waits behind minutes of embedding
        if not lock.acquire():
            return None
        try:
            db = self._db()
            model = self.embedder.model_name
            todo = db.execute('''SELECT s.path, s.name, s.start, s.end, s.hash FROM sections s
                                 LEFT JOIN vectors v ON v.hash = s.hash AND v.model = ?
                                 WHERE v.hash IS NULL GROUP BY s.hash''', (model,)).fetchall()
            self.progress = {'phase': 'meaning', 'done': 0, 'total': len(todo)}
            src, done = {}, 0
            for k in range(0, len(todo), batch):
                part, texts = [], []
                for path, name, s, e, h in todo[k:k + batch]:
                    if path not in src:
                        try:
                            with open(os.path.join(self.root, path), encoding='utf-8') as f:
                                src[path] = f.read().split('\n')
                        except (OSError, UnicodeDecodeError):
                            src[path] = None
                    if src[path] is None:
                        continue
                    t = self._section_text(path, name, src[path], s, e)
                    if hashlib.sha256(t.encode()).hexdigest()[:32] != h:
                        continue                          # the file changed since: the next update redoes it
                    part.append(h)
                    texts.append(t)
                if texts:
                    vecs = self.embedder.passages(texts)
                    db.executemany('INSERT OR REPLACE INTO vectors VALUES (?,?,?)', [(h, model, v.tobytes()) for h, v in zip(part, vecs)])
                    self._bump(db)
                    db.commit()
                done += len(todo[k:k + batch])
                self.progress['done'] = done
            db.close()
            self.progress = {'phase': 'idle', 'done': 0, 'total': 0}
            return done
        finally:
            lock.release()

    def counts(self):
        db = self._db()
        try:
            files = db.execute('SELECT COUNT(*) FROM files').fetchone()[0]
            sections = db.execute('SELECT COUNT(*) FROM sections').fetchone()[0]
            model = self.embedder.model_name if self.embedder else MODEL
            vectors = db.execute('SELECT COUNT(*) FROM sections s JOIN vectors v ON v.hash = s.hash AND v.model = ?', (model,)).fetchone()[0]
            updated = db.execute("SELECT value FROM meta WHERE key='updated'").fetchone()
            return {'files': files, 'sections': sections, 'vectors': vectors, 'updated': int(updated[0]) if updated else None}
        finally:
            db.close()

    def keywords(self, query, k=8):
        """BM25 over sections, the path and the section's name weighted above its text; a file by its best section."""
        ts = terms(query)
        if not ts:
            return []
        db = self._db()
        try:
            rows = db.execute('''SELECT s.path, s.start, s.end, s.name, bm25(fts, 2.0, 3.0, 1.0) AS r
                                 FROM fts JOIN sections s ON s.id = fts.rowid WHERE fts MATCH ? ORDER BY r LIMIT 2000''',
                              (' OR '.join('"' + t + '"' for t in ts),)).fetchall()
        finally:
            db.close()
        best = {}
        for path, s, e, name, r in rows:
            if path not in best:
                best[path] = {'path': path, 'start': s, 'end': e, 'name': name, 'score': round(-r, 2)}
                if len(best) == k:
                    break
        return list(best.values())

    def _vectors(self):
        """The sections that have vectors, as one matrix; reloaded when the index has changed."""
        import numpy as np
        gen, model = self.generation(), self.embedder.model_name
        if self._matrix and self._matrix[0] == gen and self._matrix[1] == model:
            return self._matrix[2], self._matrix[3]
        db = self._db()
        try:
            got = db.execute('''SELECT s.path, s.start, s.end, s.name, v.vec FROM sections s
                                JOIN vectors v ON v.hash = s.hash AND v.model = ?''', (model,)).fetchall()
        finally:
            db.close()
        rows = [g[:4] for g in got]
        m = np.frombuffer(b''.join(g[4] for g in got), dtype=np.float32).reshape(len(got), -1) if got else np.zeros((0, 1), np.float32)
        self._matrix = (gen, model, m, rows)
        return m, rows

    def meaning(self, query, k=8):
        """Cosine similarity of the query's vector to every section's; a file by its best section."""
        import numpy as np
        m, rows = self._vectors()
        if not rows:
            return []
        sims = m @ self.embedder.query(query)
        best = {}
        for i in np.argsort(-sims)[:4000]:
            path, s, e, name = rows[i]
            if path not in best:
                best[path] = {'path': path, 'start': s, 'end': e, 'name': name, 'score': round(float(sims[i]), 2)}
                if len(best) == k:
                    break
        return list(best.values())

    def search(self, query, k=8):
        """By meaning once most sections have vectors, else by keywords. Returns (mode, results)."""
        c = self.counts()
        if self.embedder and self.embedder.available() and c['sections'] and c['vectors'] >= 0.9 * c['sections']:
            return 'meaning', self.meaning(query, k)
        return 'keywords', self.keywords(query, k)


def summary(index):
    c = index.counts()
    return dict(c, root=index.root, index=index.dir, model=index.embedder.model_name if index.embedder else None,
                meaning=bool(index.embedder and index.embedder.available()), off=index.ignore.off,
                ignore=index.ignore.patterns, progress=index.progress)


def main(root='.'):
    """Build or bring a tree's index up to date once, vectors included where the model is installed; what is there."""
    ix = Index(root, embedder=Embedder())
    t = time.time()
    return {'update': ix.update(), 'embedded': ix.embed_missing(), 'seconds': round(time.time() - t, 1), **summary(ix)}


if __name__ == '__main__':     # python3 indexer.py <root>
    import sys
    print(json.dumps(main(sys.argv[1] if len(sys.argv) > 1 else '.'), indent=1))
