# 201 — Codebase indexing for Perch tabs

Proposal, 2026-10-26. Status: built the same day, behind a switch that is off by default; Phase 0, on one
repository, showed no gain, and a re-measurement with a stricter tool description the same (see What
was built, and Success).

Give Perch tabs, Claude Code and Codex alike, a semantic "where is this?" search over the opened
workspace, similar in effect to Cursor's codebase index: a question in plain words finds the right
files even when the identifiers do not match.

Not the goal: Cursor's cloud index, its Merkle trees, Turbopuffer, or Cursor's agent loop.

## The constraint that decides the architecture

Perch is a shell, not an agent ([note 102](102-why-a-shell.md)). It runs the Claude Code CLI and
the Codex CLI through their SDKs, one process per tab, and never builds a model request. Prompt
caching only works if the prefix is byte-identical, and only the vendor's agent owns that prefix
([note 103](103-token-economy.md)). That is why IDE context is appended at the end of the user's
message: a harness that re-renders editor state near the front, as Continue does, busts the cache.

So Perch must not index the repo and put the top chunks into every turn. That would make it a
harness, break the cache, and cost most where tokens are billed per request.

What is allowed is a tool the agents call. Tool results land after the cached prefix; Claude Code
and Codex already work that way with Grep, Glob and Read. Semantic search is one more tool, not a
hidden context injector.

## What Cursor does, so it is not copied blindly

On opening a project, Remote-SSH included, Cursor:

- walks the workspace, respecting `.gitignore` and `.cursorignore`;
- splits files into syntactic chunks (tree-sitter);
- embeds the chunks, stores the vectors remotely, and caches embeddings by content hash;
- at query time embeds the question, finds the nearest neighbours, and reads the matching source
  locally.

Its agent uses that as a retrieval tool, beside grep. It is not Lucene: Lucene is an inverted index
(terms to documents); Cursor is embeddings, with exact search as the complement.

Claude Code and Codex do not do this today. They grep and walk the tree at run time. That is why
Cursor feels as if it already knows the repo, and a Perch tab like a smart intern with `rg`.

**What the installed Cursor says of its own model** (read from Cursor 3.12.17, the desktop app and
the Remote-SSH server, 2026-10-27). Cursor runs no embedding model on the user's machine: neither
install carries a model file (no ONNX, safetensors or tokenizer) and neither mentions MiniLM,
sentence-transformers or ONNX Runtime. Its protocol names the models it has used, the enum
`aiserver.v1.EmbeddingModel` in `out/vs/code/electron-utility/alwaysLocalSingleton/alwaysLocalSingletonMain.js`:

| | Value | What it is |
| --- | --- | --- |
| 1 | `VOYAGE_CODE_2` | Voyage AI's hosted code-embedding model |
| 2 | `TEXT_EMBEDDINGS_LARGE_3` | OpenAI `text-embedding-3-large` |
| 3, 5, 6 | `QWEN_1_5B_CUSTOM`, `QWEN_1_5B_0618_CUSTOM`, `QWEN_1_5B_0618_FP8_MM_CUSTOM` | Cursor's own: a 1.5-billion-parameter Qwen fine-tune, a June version, an FP8 build |
| 4 | `MOCK_CHUNKER_ERROR` | a test value |

The numbering is the history: Voyage, then OpenAI, then the model of their own that their blog
says they trained on agent sessions. Which one serves a user is the server's choice; the client
carries only the enum. Nothing of the index is on the user's disk: a workspace's
`anysphere.cursor-retrieval` store holds the list of embeddable files and a folder description,
8 KB for one of this user's workspaces. Chunks go up; the vectors stay on Cursor's side.

Against this design's MiniLM, 22 million parameters, 384 dimensions, general English, on the
user's CPU, Cursor's current model is some 70 times the size, trained on code and on its own agents'
sessions, run on their GPUs. That is the quality gap the measurements show, and it is not closed by
a base-sized local model (tried: no better than MiniLM here); a model of Cursor's class on a CPU
would be minutes per thousand files, and sending the code out is the line this design draws.

## The shape: an MCP server, local-first

```
Perch tab → Claude Code CLI or Codex CLI → MCP: codebase_search
                                                │
            workspace files ──► indexer ──► local store
            query ──► (embed query) ──► top-k paths and line ranges
            the agent then Reads those files itself
```

| Approach | Verdict |
| --- | --- |
| Perch injects retrieved chunks into the prompt | No: it breaks the shell contract and the cache |
| A Perch command or page search, for people | A nice extra; not what makes the agent smarter |
| An MCP server both CLIs attach | Yes: the same tool in Claude and Codex tabs, and Perch stays a shell |
| Patching Claude Code or Codex | Out of our control |

Perch needs to know nothing of the index. Its tabs already take whatever MCP servers the CLIs are
configured with: a Claude tab loads all of Claude Code's settings, since Perch sets no
`settingSources`, and a Codex tab reads `~/.codex/config.toml`, Perch overriding it only for
Bedrock. Perch already shows Codex's MCP calls. So the server is installed once for the CLIs and the
tabs inherit it, and so does `claude` in a terminal. Perch must not rewrite the MCP configuration in
`~/.claude/settings.json` as a side effect of opening a tab; at most an explicit, reversible
setting.

### What the server must get right

Checked against Perch 0.6.55 and the Claude Agent SDK it ships (0.3.284):

1. **The tool's definition sits in the cached prefix.** Tool results come after the prefix, but the
   tool list is at its front, unless Claude Code's tool search defers the tool. MCP servers start
   in the background, so one that connects late adds its tool after turn 1, and the whole
   conversation is cached again: once per process start, which in Perch is every reload and
   resume. So:
   - set `"alwaysLoad": true` in the server's MCP configuration: Claude Code then waits up to 5 s
     for it and includes the tool from turn 1;
   - answer the MCP handshake at once and build the index in the background;
   - never put live state in the description or schema: "index building, 40%" belongs in a result.
   Codex's caching depends on an unchanged prefix too.
2. **A project `.mcp.json` does not load on its own in a Perch tab.** Project servers need approval
   (`enableAllProjectMcpServers`, `enabledMcpjsonServers`), and the SDK has no prompt for it. Add the
   server at user scope (`claude mcp add -s user`), or approve it once in a terminal `claude`.
3. **Every call asks for permission** unless allowed. In default mode Claude Code asks `canUseTool` for
   each MCP call, `readOnlyHint` or not (checked live, 2026-10-26): in Perch that would be a permission
   card per search. Perch passes the two tools in the SDK's `allowedTools`, so no card and nothing
   written to the user's settings; `claude` in a terminal wants them in `permissions.allow`. Codex's
   approval policy does not cover MCP calls.
4. **Changes from git, not a watcher.** Without its generated and vendored trees a working repo is
   often small: one test repo is a couple of thousand files once its bulk of templates is left out,
   and rebuilding that takes seconds. On each query compare `git ls-files -s` (each file's blob hash,
   a content hash for free) and the untracked files (`git ls-files -o --exclude-standard`), and index
   what changed. That honours `.gitignore` exactly and avoids a container's file-watch limits.
5. **The index lives outside the repo**: `~/.cache/codebase-index/<hash of the root>/`, so no
   `.gitignore` entry is needed and two clones do not fight.
6. **Phase 0 needs questions worded without the code's own terms.** A "meaning-only" question that
   shares a distinctive word with its answer is found by grep, and cannot show the gap that
   embeddings close.
7. **One server per agent process, unless it is shared.** Each CLI process starts its own stdio MCP
   server, and every Perch tab is one: eight tabs are eight servers, each holding the model and the
   vectors (about 250 MB with MiniLM, measured). Either run one server per machine that every CLI
   reaches over HTTP (Claude Code's `http` server type, Codex's `--url` for a streamable HTTP
   server), or have each load the model on its first search and let it go after a quiet spell.

## How the agents learn to use it

Not through a harness: Perch adds nothing to any turn. The agents learn of the tool from text they
load into their own prompt, once a session:

1. **The tool's description**, which both CLIs send to the model with the tool: when to use it (you
   do not know the name), when not to (exact names: grep), and what to do with the hits (Read two to
   four files; do not carry the list forward).
2. **The MCP server's instructions**, returned in the handshake. Claude Code puts them in its system
   prompt, as it does for every MCP server that gives some; whether Codex uses them is not verified.
3. **The repository's own instruction files**, if more is needed: a line in `CLAUDE.md` for Claude
   Code, in `AGENTS.md` for Codex.

All three are fixed text read once a session, so they sit in the cached prefix and cost nothing per
turn, as long as they do not change between turns. Whether they steer well is measured, not
assumed: by Phase 0's numbers and the test under *Success*.

## Phases

### Phase 0: prove the gap, with no product

On a test repo, pick ten questions of two kinds:

- **Identifier known**: a function, a flag, an extension id.
- **Meaning only**: what the code does, worded without its identifiers, and three or four with none
  of its distinctive words either.

Run each in Cursor with indexing on, in a Perch Claude tab, and in a Perch Codex tab, on one pinned
commit. Count the turns until the right file, the files read, the tokens, and the share read from
the cache. Both agents' records give these: Claude Code's session file and Codex's rollout.

Expected: identifier-known questions are a tie, since grep wins. On meaning-only questions Cursor is
faster and Perch wanders. If Perch is already fine there, stop: indexing is not worth its privacy and
upkeep cost.

### Phase 1: a lexical index, no embeddings (the 80 %)

A local process on the machine that holds the workspace, the remote one under Remote-SSH:

- the file walk, with `.gitignore` and an extra ignore list (below);
- SQLite FTS5 (BM25) over chunks: path, language, start and end line;
- optionally tree-sitter, or a cheap regex splitter, for functions, classes and headings;
- incremental re-indexing by content hash, skipping what is unchanged (point 4 above);
- the MCP tools:
  - `codebase_search(query, top_k=10, path_prefix?)` returning `{path, start, end, score, snippet}`;
  - `codebase_status`: file count, last sync, ignore rules.

Search returns pointers, not whole files: the agent still Reads the file. This is closer to Lucene
than to Cursor, and that is fine: where meaning-only questions still share words with their answers,
BM25 gets most of the win, with no embedding service, no GPU, and no code leaving the machine.

### Phase 2: embeddings, only if Phase 0 and 1 say so

Vectors beside the full-text index, the scores fused (reciprocal rank fusion, say). The embedder,
in order of preference:

1. None, if Phase 1 is enough.
2. A small local model (`nomic-embed-text` or `qwen3-embedding:0.6b` through Ollama), if the machine
   can run it. On CPU the first pass is the slow part, and done once. Measured on a 12-thread desktop
   CPU (2026-10-26), about 13,000 sections from 1,500 files: 2.2 minutes with `all-MiniLM-L6-v2`, 5.3
   with `bge-small-en-v1.5`, once each batch holds sections of like length (a batch is padded to its
   longest; unsorted, bge-small took 16 minutes) and each section is cut to 256 tokens. 8 threads were
   as fast as 16. Base-sized models measured 30 to 40 minutes, unsorted. After that a search takes 13
   to 30 ms, and an edit re-embeds only its own sections.
3. An embedding model inside the provider account (Bedrock Titan or Cohere, say). The code then
   leaves the machine as chunks, billed: a security decision, the same class of question as
   Cursor's cloud index.
4. A third-party embedding API (OpenAI, Voyage): no, for any sensitive source.

Cursor's edge in quality is a code-trained embedding model and ranking learnt from agent traces. A
generic model will be weaker: do not promise Cursor's quality. Never send raw source to a
third-party embedding API without an explicit security decision.

## What to try, and how to judge it

| | What | Why it is in the running |
| --- | --- | --- |
| A, the control | What the agents do today: `rg`, Glob, Read | The bar to beat |
| B, adopt | [Probe](https://probeai.dev): ripgrep and tree-sitter, BM25 or TF-IDF ranking, fully local, with an MCP server mode | Nothing to write: shows whether a code-aware lexical search alone closes the gap |
| C, build | SQLite FTS5 (BM25) from Python's standard library, behind a small stdio MCP server | Nothing to install, and the chunking and ranking are ours to tune |
| D, only if C falls short on meaning-only questions | C plus local embeddings on CPU, fused with BM25 | The vocabulary gap, closed without code leaving the machine |

**C in detail.**

- Chunks: Python by `ast` (functions and classes with exact line ranges, from the standard library);
  Markdown by headings; YAML by top-level blocks; anything else in windows of about 60 lines that
  overlap a little.
- What is indexed per chunk: its path, its name, and its text, with identifiers also split into
  words (`gateway_setup` and `gatewaySetup` as `gateway setup`), so a question in words meets code in
  identifiers; FTS5's Porter stemmer.
- Ranking: BM25 with the path and the chunk's name weighted above its text (`bm25()` column
  weights).
- Changes from git blob hashes, and the index under `~/.cache/codebase-index/`, as above.
- The MCP server by hand: JSON-RPC over stdio, `initialize`, `tools/list` and `tools/call`; no SDK to
  install.

**D in detail.**

- A small embedding model on CPU: a code-trained one (`jina-embeddings-v2-base-code`) against general
  ones (`nomic-embed-text`, Qwen3-Embedding 0.6B), through ONNX Runtime or Ollama.
- The vectors in a NumPy array: at tens of thousands of chunks a brute-force cosine scan takes
  milliseconds, so no vector database.
- Reciprocal rank fusion of the BM25 and vector rankings.
- D is the first candidate with dependencies to install (NumPy, an embedding runtime, a model).
- Memory, measured for about 13,000 sections (8 threads, length-sorted batches of 32): building
  peaks at 0.7 GB with MiniLM or bge-small (the BM25 index alone at 36 MB), 1.4 GB with jina's code
  model and 3.0 GB with nomic; a full build adds about 50 MB for the text and the vectors. Batches
  padded to 512 tokens took bge-small to 1.6 GB. A server holding MiniLM and its vectors stays at
  about 250 MB.

**MiniLM, the model D runs.** MiniLM is a small transformer from Microsoft (2020), distilled from a
larger BERT-style model. The one used here is `all-MiniLM-L6-v2`, the sentence-transformers version
trained to turn a text into one embedding: a vector of 384 numbers, close to the vectors of texts
that mean the same. Six layers and about 22M parameters, some 90 MB on disk, fast on a CPU without a
GPU. It reads about 256 tokens of a section and ignores the rest, which is why sections are kept
small. It was trained mostly on English prose, not code: it matches comments, docs and identifiers
split into words well enough, but understands code less well than a code-trained model would. It is
the common default for local semantic search because it is small, free and quick, not because it is
the best at code.

**How to judge, cheapest first.**

1. Retrieval alone, with no model: run the Phase 0 questions straight against B, C and D, and score
   recall at 5 and at 10 of the files that answer each. For A, a fixed list of the identifiers and
   keywords a model would grep for, per question. Minutes, and no tokens.
2. The agents, for the best candidate only: the Phase 0 runs in Perch tabs with the tool attached,
   against A, by turns, files read, tokens, and cache-read share.

**Not tried.** Zoekt or Sourcegraph, built for millions of files; vector databases (Milvus, Qdrant,
LanceDB), unneeded at this size; cloud indexes; a repository map put into the prompt, as Aider does,
which is the injection ruled out above (as a tool it could come later).

## Where the pieces live

Perch stays a shell: it never puts a search result into a prompt. The indexer and its MCP server
ship with Perch, in `codeindex/`, so the toggle below has something to start, and are written to run
without it: `claude mcp add -s user codebase -- python3 <perch>/codeindex/server.py` gives `claude`
in a terminal the same tool, and `codex mcp add` the same for Codex. Under Remote-SSH the server runs
on the remote, where the CLIs run; run on the desktop against a remote filesystem it would be slow
and wrong.

## The toggle

Decided 2026-10-26, after the Phase 0 runs showed no gain on the first test repository: build it
anyway, behind a switch, so it can be turned off, or refined, wherever it does not pay. On by default
for a few hours that day, then off: the re-measurement (*Success*) showed the tool still costing
Claude steps and tokens for no change in answers on the one repository measured, and a default
follows the evidence there is.

- **A Perch setting, `perch.codebaseIndex.enabled`**, off by default, settable per workspace, and the
  command `Perch: Toggle Codebase Search`, which changes it where it is set (the workspace's settings
  if they have it, else the user's). When on, Perch adds the server to the processes of its own tabs
  through the SDKs: Claude Code's `mcpServers` option, Codex's `--config mcp_servers.*` overrides. No
  file is written: not `~/.claude/settings.json`, not `~/.codex/config.toml`. Off leaves no trace.
  Where the machine's Python cannot run the server (older than 3.8, or SQLite without FTS5), there is
  no tool at all, rather than one that fails.
- **Per folder.** The setting's scope is `resource`: Perch reads it for each folder of the workspace,
  a folder's own `.vscode/settings.json` first, and hands the server every folder that is on, in the
  Explorer's order, an index each (`server.py root1 root2 …`). A folder added or removed reaches a
  tab from its next process, like the setting. With several folders the results carry full paths,
  since a tab's process works in the first folder only; search by meaning merges them by score,
  keywords a folder at a time by rank, BM25 scores not comparing across indexes. One embedding
  model serves all the folders of a server. A window with no folder gets no server: never the
  home directory. Many folders compete: measured on a twelve-folder workspace, three answers in
  the c3securitytools folder's own top ten fell out of the top five, mostly to another folder's
  skill documents matching generic words. So the tool takes an optional `folder`, one workspace
  folder by its Explorer name (`codebase_status` lists them), and returns 8 hits instead of 5
  when the workspace has more than two folders.
- **From each tab's next process, not mid-conversation.** The tool list sits at the front of the
  cached prompt, so a change re-caches the conversation once. A Claude tab picks it up after its
  current turn, as on a backend switch; a Codex tab, which runs each turn as a process, from its
  next turn.
- **A repository can opt out** with a `.codebaseignore` that is just `*`: the tool stays listed, so
  the prompt does not change, and answers that search is off here and to use grep.
- **Search by meaning is an install.** Keyword search (BM25) needs Python's standard library alone
  and works at once. Search by meaning needs fastembed and MiniLM in a private environment
  (`~/.local/share/perch/codeindex`, about 300 MB, built the way dictation's is). Perch offers it
  once a machine, as the first tab starts with search on (Install, Not Now, Turn Off), and `Perch:
  Install Codebase Search by Meaning` does it later. A server already running moves onto the new
  environment by itself: between two messages it replaces itself with the environment's Python
  (`exec`, POSIX only, once: the environment's `python` is a symlink to the machine's, so the two
  cannot be told apart by path, and a guard in the environment stops a second exec), on the same
  pipe with the same tools, so no tab restarts and no prompt changes. On Windows a tab takes it up
  with its next process.

## When the index is built, and what a search gets meanwhile

The server is started by the agent, as one of its MCP tools, when the agent's own process starts;
Perch starts that process at a tab's first message. So nothing is indexed until some tab has an
agent running: after a reload, a "hello" in any tab is what starts the build. (Perch building the
index itself at activation, so the first tab finds it ready, is offered below under *Not yet*.)

From the moment the server starts, it builds in the background, keywords for every folder first,
then vectors, and a search never fails for it; what changes is the text it returns:

1. **Keyword index not built yet** (the first seconds; about 3 s for 1,900 files): the call waits up
   to 10 s for it. If it is still not there, the result says so, with the count ("The index of
   c3securitytools is being built: 640 of 1,908 files. Use grep meanwhile."), and the agent greps.
2. **Keywords done, vectors still building** (minutes, on a CPU): the call answers by keywords and
   says so in its first line ("by keywords; search by meaning is still being built"). In a
   multi-folder search a folder whose vectors are finished already answers by meaning; folders are
   merged by rank until all are done.
3. **All vectors done**: "by meaning", merged by score.

Vectors are built on a background thread, so a search is not blocked by them; it shares the CPU
with them for those minutes. A second tab's server, starting while the first builds, finds the
index's lock held, waits for the keyword index rather than searching an empty one, and then shares
it; it never builds a second copy. `codebase_status` says where each folder stands.

The same for the user, with the switches: the footer's **index** button, beside **sub-agents**,
opens a table of the workspace's folders, each with its setting (a switch that writes the folder's
own `.vscode/settings.json`, the WorkspaceFolder target) and its index (files, sections, sections
with vectors, keywords or meaning, and whether the folder is being indexed or embedded: its lock
held); a switch in the header turns search on or off for the workspace, as the command does, where
the setting is set. The table is read from the indexes' files by `server.py --status` when opened,
at each turn's end, and every 5 s while open, so a first build shows its counts growing. It only
reads; a build starts with a tab's server, never from the panel. A change reaches a tab at its next
message, as from the command.

**A file changed later.** There is no file watcher: the server looks for changes when it is asked
something, at most every 30 s. The first search past that window does the check inline before
answering, a `stat` of every file (milliseconds for 1,900) and the re-indexing of the files whose
size or modification time changed, so the change is in that very answer by keywords; the changed
sections' vectors are made in the background, so by meaning it is there from the next search, a
second or so later. Searches within the window answer from the index as it stands: a pointer into a
changed file may be off by the edit, and the agent then reads the file itself, which is current.
Codex, whose every turn is a new process, starts each turn with a full check. Embedding holds a
lock of its own, so a keyword update never waits behind the minutes of a first build; two updaters
(two tabs started at the same moment) take turns, the second waiting up to two seconds for the
first.

```
Agent (Claude Code or Codex)   Search server (one per agent process)   Index (SQLite, ~/.cache/…)   Files
        │                                   │                                    │                     │
        │ process starts (a tab's first     │                                    │                     │
        │ message); MCP initialize          │                                    │                     │
        ├──────────────────────────────────▶│                                    │                     │
        │◀──────────────────────────────────┤ the tools, at once                 │                     │
        │                                   ├─ background, folder by folder:     │                     │
        │                                   │   update(): stat every file ───────┼────────────────────▶│
        │                                   │   changed files → sections ───────▶│                     │
        │                                   │   embed_missing(): vectors ───────▶│  (minutes, CPU)     │
        │                                   │                                    │                     │
        │ codebase_search(q)                │  keyword index not built yet       │                     │
        ├──────────────────────────────────▶│  waits ≤ 10 s                      │                     │
        │◀──────────────────────────────────┤ "being built: 640 of 1,908 files.  │                     │
        │                                   │  Use grep meanwhile."              │                     │
        │                                   │                                    │                     │
        │ codebase_search(q)                │  keywords built, vectors not       │                     │
        ├──────────────────────────────────▶├─ keywords(q) ─────────────────────▶│                     │
        │◀──────────────────────────────────┤ "by keywords; search by meaning    │                     │
        │                                   │  is still being built" + the files │                     │
        │                                   │                                    │                     │
        │ edits a file ─────────────────────┼────────────────────────────────────┼────────────────────▶│
        │                                   │                                    │                     │
        │ codebase_search(q)                │  > 30 s since the last check       │                     │
        ├──────────────────────────────────▶├─ update(), inline: stat all ───────┼────────────────────▶│
        │                                   ├─ the changed file → sections ─────▶│                     │
        │                                   ├─ background: its vectors ─────────▶│  (a second)         │
        │                                   ├─ meaning(q), or keywords(q) ──────▶│                     │
        │◀──────────────────────────────────┤ the files: current by keywords     │                     │
        │                                   │  now, by meaning from the next     │                     │
        │                                   │  search                            │                     │
        │ Read(file) ───────────────────────┼────────────────────────────────────┼────────────────────▶│
```

## What was built (2026-10-26)

- `codeindex/indexer.py`: sections (Python by `ast`, Markdown by headings, else windows of 60 lines),
  SQLite FTS5 with identifiers split into words, and vectors from MiniLM through fastembed (batches
  sorted by length, 8 threads, a section's first 2,000 characters). One SQLite file a tree, in
  `~/.cache/codebase-index/<hash of the root>/`: the files with their size, modification time and
  content hash; the sections; the full-text table; the vectors, keyed by the section's text and the
  model, so unchanged text keeps its vector. One process updates at a time (a file lock); the others
  read. Search is by meaning once nine sections in ten have vectors, else by keywords.
- `codeindex/server.py`: the MCP server over stdio. Two tools with fixed descriptions,
  `codebase_search` and `codebase_status`; the handshake answered at once and the index built in the
  background; changed files looked for at most every 30 seconds, on a search; the model let go after
  10 idle minutes. Its stdin is read without read-ahead, so the move onto the installed environment
  loses no message.
- `src/codeIndex.js`: whether the machine's Python can run the server (asked once), the server a tab
  gets, the install of search by meaning (a virtual environment, with pip's own installer where
  `ensurepip` is missing, as on Ubuntu without python3-venv), and its marker.
- In Perch: the setting and the two commands, the server handed to each tab's agent, a change applied
  from each tab's next process (a Claude tab restarted after its turn, a Codex agent told for its next
  turn), the one-time offer. Tests: `test/codeindex_test.py`, `test/codeIndex.test.js`, and the host
  tests.
- Measured on Perch's own repository (75 files, 448 sections): the keyword index in 0.2 s, its vectors
  in 6.2 s, a search by meaning in 0.4 s with the model to load and instantly after.

Not yet: Perch building the index itself at activation (`server.py --index <folders>` in the
background when the setting is on, and again on a change), so the first tab finds it ready and no
"hello" is needed; one shared server per machine (point 7 above: each tab's process has its own,
the model loaded on its first search and let go when idle); vectors shared between clones of one
repository; and a way for Codex to reach for the tool unprompted.

## What is indexed

In a repository, git's own view of its files: tracked, and untracked but not ignored. A folder that
is no repository but holds some (a home directory opened as the workspace, as on a pod) is walked:
each repository inside is taken by git's view and its own `.codebaseignore`, and every hidden file
and directory is left out, there being no `.gitignore` to go by and a hidden file at a home's root
being a shell's history or a tool's credentials. The root's own `.codebaseignore` prunes that walk,
so a repository it names is never listed and cannot fill the 50,000-file cap before the others are
reached; links are followed, each real directory once. (Found on 2026-10-27: a pod's home as the
workspace, 46,000 files indexed with `.bash_history` among them, each repository's ignore files
unread; then, the ignore file applied only after the walk, three repositories never reached.) Then `.gitignore`, plus a `.codebaseignore`, plus a default list: virtual environments (`.venv*`),
`node_modules`, lockfiles, `.git`, build output, and any large generated or vendored tree. A library
of thousands of scanner templates, say, drowns every search unless it is left out; it is indexed
only on request, when that is the work. Notes and docs are indexed: much of "how does X work?" is
answered there, not in code.

## Security and privacy

- Phase 1 uses no network beyond the MCP channel to the local CLI.
- Queries and snippets are logged to no cloud.
- Secrets are never indexed: whatever git ignores, and by name whatever git says: `.env` and
  `.env.*`, `.netrc`, `.npmrc`, `.pypirc`, `credentials*`, `id_rsa` and its kin, `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, key stores, `*.gpg`, `*.pat`. The index itself is as sensitive as the code: it
  holds the sections' text, in a directory of the user's alone (mode 0700), never uploaded.
- If Phase 2 sends chunks to a cloud embedder, write down that they leave the machine, beside
  Cursor's own "code chunks are embedded off-box", so the comparison is honest.
- Guardrails that already keep token files out of scans must not be undone by the indexer.

## What not to do

- Reimplement Cursor's cloud index.
- Put search hits into the prompt's prefix, system or tools.
- Make Perch spend an extra model call per turn choosing context: Continue-shaped, hostile to the
  cache, and dear where tokens are billed.
- Replace grep. Semantic search is for "I don't know the name"; exact names should still be grepped.
- Index every folder on the machine: the workspace root only.
- Block the first message on a cold index: the tool says the index is building, how far along, and
  that grep is the way meanwhile.

## Success

Phase 1 ships if, on the Phase 0 set, meaning-only questions take fewer turns and fewer file reads
in Perch than today, and the cache-read share stays high (`cache_read_input_tokens`).

If token spend goes up, the agent searching and then grepping everything anyway, the tool's
description is wrong. It should teach: use `codebase_search` when you lack identifiers and grep
when you have them; do not carry the hit list into the next prompt; read the first file, another
only if it does not answer. Tried on the first test repository (2026-10-26): the stricter wording
and 5 hits instead of 8 cut the files read (20 to 14–16 over ten questions) but not the steps or
the tokens, and where the first hit was wrong it cost more. The description is a weak lever; the
ranking and the repository decide.

## Open questions before coding

1. Is the win for the agent (MCP) only, or also a search for people in Perch? Agent first.
2. Is a BM25 Phase 1, without embeddings, acceptable?
3. May code ever be sent to a cloud embedder? No, until decided otherwise.
4. Perch in-tree, or a separate MCP server the CLIs load even without Perch? Separate preferred:
   `claude` in a terminal gets it too.
5. Scope: one team's machines, or any Perch user?

## Pointers

- Perch's design: notes [102](102-why-a-shell.md) (shell, not agent) and
  [103](103-token-economy.md) (the cache).
- Cursor's documentation on codebase indexing, semantic search, and secure indexing.
- Prior art: local MCP indexers, full-text search with optional Ollama embeddings; Probe
  ([probeai.dev](https://probeai.dev), candidate B), checked on 2026-10-26: fully local, ripgrep and
  tree-sitter, BM25 or TF-IDF ranking, an MCP server mode.

In one line: do not put Cursor's index inside Perch; give Claude Code and Codex a local MCP search
tool, so they retrieve without Perch touching the prompt.
