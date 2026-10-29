# Purpose and rationale

What Perch is for, why it is a shell over the vendors' agents rather than an agent of its own, how the token reuse is achieved and what it was measured to cost, the decisions taken on the way, and the references. One file, formerly 5 notes, each a section that keeps its number: links from elsewhere point at `#n<number>`.

- [101 — Purpose](#n101)
- [102 — Why a shell and not an agent](#n102)
- [103 — Token economy: how the reuse is achieved](#n103)
- [117 — Decision log](#n117)
- [118 — References](#n118)

<a id="n101"></a>

## 101 — Purpose

Version 0.6.0, 2026-09-30. These notes describe perch as built, the
reasons behind its shape, and what has and has not been verified. Setup
and everyday use are in [README.md](../../README.md).

perch puts Claude Code and Codex in one VS Code extension: any number of
sessions of either kind, each in its own tab, each looking and behaving
like its vendor's own panel.

It exists because running two vendor extensions means two panels, two
sets of habits, and no way to pass work between them, while the tools
that do unify models do it by replacing the agent.

The reason it is written this way, rather than adopting Continue or
another harness that already unifies models, is token usage. perch reuses
the vendors' own agents, the Claude Code CLI and the Codex CLI, whole:
their prompt layout, their caching, their compaction, their logins. It
adds no request of its own. [Note 102](#n102) argues the choice; [note 103](#n103) sets
out how the reuse is achieved and what it was measured to cost.

### The notes

- [101 — Purpose and rationale](101-purpose-and-rationale.md): purpose, why a shell and not an agent, the token economy, the decision log, references
- [104 — Architecture](104-architecture.md#n104): architecture, sessions and surfaces, state and persistence, the page protocol, the agents, model catalogs
- [110 — Features](110-features.md): the composer, usage meters, dictation, security and privacy
- [114 — Quality and open work](114-quality-and-open-work.md): testing, verified and not verified, limitations and open work

Each is one file of several former notes, a section each that keeps its number: links point at `<file>#n<number>`.

Proposals:

- [201 — Codebase indexing for Perch tabs](201-codebase-indexing.md)

---

<a id="n102"></a>

## 102 — Why a shell and not an agent

An **agent** is the program that runs the loop: it decides what goes
into each request, receives the model's requests to read, run, and
edit, executes them, and feeds back the results. A **model** only
produces text. Whoever runs the loop owns the tools, the permissions,
and the cost.

perch does not run the loop. Each tab starts the vendor's agent through
the vendor's SDK and renders its event stream. This is the central
decision, and the reason is cost.

### The cost of replacing the agent

An agent does not send one request per message. It sends one per step,
and each carries the whole conversation. A 20-step task whose context
grows by about 3k tokens a step sends on the order of 930k input tokens.
Prompt caching is what makes that affordable: a cache hit is billed at
0.1 times the input rate, a write at 1.25 times.

A cache hit needs a **byte-identical prefix**. So caching is not a header
to add. It is a property of how the whole prompt is laid out and kept
stable from call to call, which only the agent controls.

| Harness, with Claude as the model | Cache markers | Prefix kept stable | Cache lifetime | Billing |
| --- | --- | --- | --- | --- |
| Claude Code | placed by the agent | yes, by design | 1 hour on a subscription | subscription, or API |
| OpenCode | first two system messages and last two conversation messages | largely: a purpose-built coding agent | 5 minutes | API, per token |
| Continue | opt-in, coarse (`cacheBehavior`) | no: context providers re-render near the front | 5 minutes | API, per token |
| Continue behind LiteLLM | injected at the gateway | no, same | 5 minutes | API, per token, capped |
| Cursor | its own, closed source | yes, measured: ~96 % of each turn read back on turns 2+ (bench 006, Bedrock Opus 5.5) | 5 minutes on Bedrock | Cursor's plans, or API |

OpenCode's row was checked against its source
(`packages/opencode/src/provider/transform.ts`, `applyCaching`). Its
caching is sound. What it lacks relative to Claude Code is the one-hour
lifetime and subscription billing, not the markers. Continue's weakness
is the prefix, which a gateway cannot repair because it sits below the
harness.

The same reasoning applies on the other side: Codex's agent manages its
own caching against OpenAI's API.

### What was claimed about Cursor, and what was measured

Until 2026-10-06 the design document and the README said a harness such as
Cursor costs "several times a terminal session", and the README's diagram
showed a harness missing the cache on every turn because it re-renders
editor state near the front of the prompt. That was reasoning from
Continue's source applied to Cursor by analogy, and the "several times"
figure had no source of its own. Two sources now exist, and they say
less than the claim did.

- **A public comparison** ([futureproofing.dev, "Claude Code vs Cursor:
  token efficiency, 2026"](https://www.futureproofing.dev/resources/ai-native-team/claude-code-vs-cursor-token-efficiency-2026))
  reports Claude Code using 33 K tokens against Cursor Agent's 188 K on
  one task, a Next.js build with Tailwind 4 and shadcn: 5.5×. Read
  closely it does not support a caching claim: it is one run by one
  developer, Claude Code on Opus against Cursor on GPT-5 (the authors
  say so, and warn against "a universal constant across every task"),
  it gives no cache hit rates and no cache-busting analysis, and it
  states that "a controlled, multi-task, peer-reviewed token benchmark
  across identical models does not exist in sourceable form".
- **A controlled measurement**, the user's bench (2026-10-06):
  Claude Code and Cursor on the same model and provider, Opus 5.5 on
  Bedrock, the same three prompts, on one price basis. Cache hits on
  turns 2+: 95 % for Claude Code, 96 % for Cursor. Model cost per run:
  $0.40 against $0.44 (tokens only), a 10 % gap, which is Cursor's
  twice-as-many tool calls (19 against 8) at cached rates, not the cache.
  An earlier 50 % figure in that bench came from pricing Opus 5.5 at Opus
  4.x list; the corrected rates fit Claude Code's own accounting to a
  cent.

So the cache is not what separates a shell from a harness: a harness
that lays its prompt out carefully, as Cursor evidently does, keeps its
prefix stable too. What separates them is the billing path (a
subscription applies only to the vendor's own agent; a harness is API
billing by construction), the agent's own prompt, tools, compaction and
permissions, and the agent's tool-call style. perch's claim is
accordingly narrower than it was: it adds nothing that could bust the
cache, which is a guarantee of not making it worse, and it keeps the
vendor's billing. The 5.5× above is a mixed-model single run and is not
cited as a multiple anywhere else in these notes.

### What follows from the decision

- perch never constructs a model request. It cannot break caching,
  because it does not take part in it.
- Permissions, memory, skills, hooks, `CLAUDE.md`, MCP servers, and
  compaction are the vendor's, unchanged.
- Two agents means two contexts. Tabs do not share history. The one
  bridge is **handoff**, which pastes a tab's last answer into another
  tab's message box. Shared context would defeat each agent's caching.
- Both agents run on the user's existing logins. That is a personal-use
  arrangement. Distributing perch to others would require API-key
  billing under both vendors' terms.

---

<a id="n103"></a>

## 103 — Token economy: how the reuse is achieved

### What a turn costs

An agent's turn is a loop of model calls, one per step, and each call
carries the whole conversation: system prompt, tool definitions, every
message and tool result so far, then the new step. The cost of a turn is
therefore dominated by the size of the conversation, not by what the
user just typed. Two things keep it affordable:

- **Prompt caching.** A call whose prefix is byte-identical to a recent
  one is billed at 0.1 times the input rate for the cached part; writing
  the cache costs 1.25 times. On a subscription the cache lives an hour
  after each answer; on the API, Bedrock, Vertex, or Foundry, five
  minutes. With a 100k-token conversation, a cached step bills the
  equivalent of about 10k input tokens; a cold one about 125k. The whole
  economy of a long session rests on staying cached.
- **Compaction.** When the conversation nears the window, the agent
  summarises it. Done well, the summary keeps what the rest of the task
  needs; done badly, or too often, the model re-reads files it had.

Caching needs the prefix to be stable, so it is a property of how the
agent lays out and reuses the prompt. Compaction needs judgement about
the task, so it is a property of the agent too. perch's approach is to
own neither: it runs each vendor's agent as the vendor's own terminal
would, and only shows what happens.

### Where the cache lives: the vendor, Bedrock, a proxy

The promise is only ever that the vendor's caching is left intact; whether
a cache exists is the provider's doing, and the three kinds of provider
differ.

- **The vendor's own API** (claude.ai, api.anthropic.com, OpenAI) is the
  reference: Anthropic caches where Claude Code puts its `cache_control`
  markers and returns the 5m/1h split in `cache_creation`; OpenAI caches
  any ≥1,024-token prefix on its own and reports hits and writes in
  `usage`.
- **Amazon Bedrock is not a proxy.** It hosts the models on its own
  serving stack, so its caching is its own implementation of each
  vendor's semantics, with no upstream to lose information between.
  Measured for OpenAI models on 2026-10-06 ([note 115](114-quality-and-open-work.md#n115)): automatic prefix
  caching within a thread, usage in OpenAI's shape with write counts.
  Documented and used daily for Anthropic models: `cache_control`
  honoured (the Converse API has its own `cachePoint` form), reads and
  writes reported. Bedrock trails the vendors on newer options, though:
  the hour-long TTL came later and only for some Claude models (which is
  why LiteLLM checks the model before passing `ttl: "1h"` to Bedrock),
  and the 5m/1h split in `cache_creation` is not returned (the zeroed
  split seen through the gateway was almost certainly a Bedrock route);
  for OpenAI models there is no published TTL and no cross-thread hit on
  a first turn.
- **A proxy** such as a LiteLLM gateway sits between client and
  provider, and whether the markers survive is a property of its route:
  passed through unchanged to Anthropic direct, honoured on Bedrock for
  some models and silently dropped for others, stripped on routes with
  automatic caching, translated for the Responses API, and the usage
  breakdown dropped (measured on one such gateway). The careful-implementation question
  is a proxy's, not Bedrock's.

### The mechanisms

1. **No request of perch's own.** perch never assembles a prompt, never
   inserts a system message, never re-renders a context provider near
   the front of the conversation. The prompt an agent sends from a perch
   tab is the prompt it would send from a terminal, so its cache hits
   are the terminal's cache hits. Everything the page shows is derived
   from the agent's event stream, not requested from a model.

2. **One conversation per tab, kept alive.** A Claude tab is one Claude
   Code process fed messages over its lifetime (the SDK's streaming-input
   mode). Every turn extends the same conversation, so the prefix grows
   at the end and the cache written by one turn is read by the next. A
   message sent mid-turn is queued in that same process, not sent as a
   new conversation. Mode and effort changes are applied to the running
   session rather than by restarting it.

3. **A Codex thread continued, not replayed.** The Codex SDK runs each
   turn as a `codex exec` process that resumes the thread by id. What
   goes to the model is the thread as Codex itself recorded it, with the
   same prefix each time, so OpenAI's prefix caching applies as it does
   from the Codex CLI. A model, effort, or sandbox change is made by
   taking the thread up again with the new setting; Codex then compacts
   once, which is the one token cost of switching.

4. **Resume by the agent's own id.** A tab that is reopened, or brought
   back after a window reload, hands the agent its session id. The agent
   continues the transcript it kept, with its own compaction state. perch
   does not re-send history, summarise it, or hold a copy that could
   drift from the agent's. The transcript the page shows after a resume
   is read from the agent's file on disk: a file read, no tokens.

5. **The system prompt is the SDK's, which is smaller.** Started through
   the Agent SDK without a `systemPrompt` option, Claude Code runs with
   the SDK's default prompt rather than the full Claude Code prompt.
   Measured on 2026-09-30 with a one-line question on Haiku: **15,226
   tokens** written to the cache on the first turn as perch runs it,
   against **21,581** with `systemPrompt: { type: 'preset', preset:
   'claude_code' }`. The difference is paid once per session and again on
   every cache miss. What is lost is Claude Code's own guidance on how to
   work; `CLAUDE.md`, settings, skills, hooks, and MCP servers are still
   loaded, because the SDK loads all setting sources by default.
   Switching to the preset is one line in `src/claudeAgent.js` if parity
   with the terminal matters more than the tokens.

6. **Nothing else perch does touches a model.** Opening a tab starts no
   process. Model lists come from a Claude Code process started without
   a message, and from Codex's `models_cache.json`. The sessions list,
   renaming, and the transcript reader work on the agents' files.
   Context usage is asked of the running Claude process locally. Claude's
   usage gauge reads Anthropic's usage endpoint, which reports limits and
   costs no tokens; Codex's is read from the last `token_count` event in
   its session files. Dictation is local Whisper.

7. **No shared context between tabs.** Two tabs are two conversations.
   The only bridge, handoff, pastes one tab's last answer into another's
   message box, so the receiving agent sees a message, not a transplanted
   history that would invalidate its prefix and duplicate its context.

8. **The cache clock.** The composer shows how long the prompt cache
   stays warm after the last answer, so a follow-up can be sent before it
   goes cold. It is a display of the agent's timing, not a mechanism of
   perch's; it exists because the difference between a warm and a cold
   turn is the 12-fold one above.

### What a perch tab spends that a terminal would not

| Cost | When | Size |
| --- | --- | --- |
| IDE context on a message | With the toggle on, which it is by default | The active file's selection, up to 12,000 characters |
| Compaction on a Codex model switch | Only when the model is changed mid-thread | One compaction of the thread |
| A pasted image | Only when one is sent | Scaled to at most 1568 px on the long side, the most the API keeps; roughly 1,800 tokens for a full-width screenshot, by the vendors' area-based estimates. Past 20 images in a conversation the API refuses any image of 2000 px or wider (measured: 2000 exactly is refused), and the agent keeps every earlier image until it compacts; the tab says so at the twentieth |

Nothing else. In particular perch adds no per-message instructions, no
retrieval, no summaries, and no hidden calls.

### Comparison

[Note 102](#n102) compares the harnesses. In these terms: OpenCode caches
soundly but on API billing with a five-minute lifetime; Continue's
context providers re-render near the front of the prompt, so its prefix
is not stable and a gateway below it cannot make it so. Both replace the
vendor's agent, so neither gets its compaction or its subscription
billing. perch gets both because it changes nothing in the agent.

### How to see it

Each turn's result line in the transcript shows the agent's own usage
figures: tokens in, tokens read from cache, tokens out, and for Claude
the cost. A warm turn shows nearly all of its input as cached. The
figures come from the agents (`result` messages from Claude Code,
`turn.completed` from Codex), not from an estimate of perch's.

### Not verified

- Codex's cache behaviour is inferred from the SDK's design (one thread,
  resumed by id, the same prefix) and its `cached_input_tokens` figures,
  not from OpenAI's cache keys, which the SDK does not expose.
- The image token figure is the vendors' published estimate, not a
  measurement.

---

<a id="n117"></a>

## 117 — Decision log

| Decision | Alternative | Why |
| --- | --- | --- |
| Embed the vendors' agents | Continue, OpenCode, a LiteLLM gateway | Caching is a property of the agent ([note 102](#n102)) |
| Host owns all state | State in the page | Webviews are destroyed when a view moves |
| Agents start on first message | On tab open | An open tab costs nothing |
| Tabs resume by agent session id | Save transcripts | The agent already has the conversation |
| Sessions as editor tabs | Sidebar only | Sidebar chrome cannot be removed |
| Lists from the agents | Hardcoded | The hardcoded Codex efforts were wrong |
| Icons from installed extensions | Bundled artwork | No trademarked files redistributed |
| Merge AI Meter | Have it export an API | The user's choice. One extension to install |
| No status bar items | AI Meter's two items, standing down while it is installed | They showed Claude under a Codex tab; the tab footer follows the vendor |
| Codex usage from files | Query the app-server | No request, no rate limit |
| Footer follows the active tab | One gauge for all | Claude's usage under a Codex tab was wrong |
| Queue Codex messages in the host | Refuse while busy | Same behaviour in both kinds of tab |
| Dictation in two extensions | One | The microphone and the GPU may be on different machines |
| Local Whisper | ChatGPT's endpoint, the OpenAI API | Private, free, not dependent on private interfaces |
| Probe jacks with `pactl` | Judge by signal level | Noise from an empty jack is indistinguishable from a quiet room |
| Transcripts read from the agents' records | Save them in perch | The record is the agent's truth, and reading it costs nothing |
| Names written to the agents' records | Keep them in perch | One name wherever the session is listed |
| The sessions list is a quick pick | A page of perch's own | Search, rows, and buttons for free; works from either surface |
| Own Markdown renderer, DOM-built | `marked` and a sanitiser | No dependency, and no path by which text becomes markup |
| Programs from the vendors' extensions when packaged | Bundle per platform | Hundreds of megabytes per platform, against 8 MB |
| Lock an editor group of sessions | Leave it | Files opened from the Explorer landed among the sessions |
| Unlock that group when its last session leaves and other tabs stay | Leave the lock on | VS Code never takes it off: a group of files stayed locked, and files from the Explorer went past it into a new group |
| Codex settings changed by resuming the thread | Fixed for the thread's life | Each turn is a process anyway; the cost is one compaction |
| perch-audio through `extensionPack`, not a dependency | `extensionDependencies` | A missing companion must not stop perch from starting |
| The vendors' extensions in the `extensionPack` too | Leave them to the user; bundle the programs | Perch runs their programs, so a remote with one vendor's extension missing showed only a message; the pack installs both, and either can be removed |
| Thumbnails saved with the tab (about 1.5 MB at most), rejoined to the record's messages on reload | Re-read the images from the record; save nothing | The record holds the images at up to 1568 px, too heavy for a page; a 320 px thumbnail is 20-30 KB, and the newest messages matter most |
| On the gateway the model menu is the file's names, carried by Claude Code's aliases | Claude Code's catalog; the gateway's `/v1/models` | A catalog id such as `claude-fable-5-1` goes to the gateway as it is, and the router has no such name; the aliases opus, sonnet and haiku are what Claude Code maps through `ANTHROPIC_DEFAULT_*_MODEL`, so they are the choices that mean something. Discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`) could add the gateway's own list later |
| A Codex backend switch of perch's own (ChatGPT login or API key, the key in VS Code's secret storage, given to each `codex` process as `CODEX_API_KEY`) | `codex login --with-api-key`, which rewrites Codex's own `auth.json` | Codex has no setting for the choice as Claude Code has (`CLAUDE_CODE_USE_BEDROCK`), and overwriting its login to use a key would lose the login; a key in the process environment leaves `auth.json` alone and switches back for free |
| Codex without a sandbox on a machine whose kernel forbids user namespaces, by the user's choice, remembered by hostname | Fail every command; Codex's legacy Landlock sandbox | bubblewrap cannot start in such a container, and `features.use_legacy_landlock` is deprecated and panics in codex 0.155 ("filesystem-restricted execution requires bubblewrap"); `danger-full-access` runs (verified there). Silently dropping the sandbox is not perch's call, so it asks |
| Claude's credentials looked for before the first message, on the backend the tab would get | Let the process fail and show its error | A first-time user on a fresh machine sees a way in (Claude Code's sign-in, or the settings file for Bedrock) instead of the CLI's refusal; the same shape as the Codex check |
| A backend switch resumes open Claude tabs on the new backend | Tabs keep their backend until closed | The user switches sub and API mid-conversation and wants the same tab; a process cannot change its auth, but the session is a file, and resuming it is what a reload does anyway |
| Codex login looked for before the first message; the browser sign-in run by perch, its port forwarded when remote; device code as the other way | Let the turn fail; the ChatGPT panel's sign-in; device code only | Without a login the SDK reconnects five times on 401 and shows nothing useful. `codex login` returns to `localhost:1455`, which `asExternalUri` carries from the user's machine to the remote, so any user with a browser can sign in. Device code needs a ChatGPT setting that some accounts cannot turn on (seen 2026-09-30). Both land in the same `auth.json` the ChatGPT extension uses |
| Voice setup brings pip in itself when `venv` cannot | Tell the user to install `python3-venv` | Containers often have no `sudo`; pip's installer is one fetch from `bootstrap.pypa.io` |
| Bluetooth headsets switched to their headset profile around a recording | Tell the user to switch profiles; record from the default source and let PipeWire switch | The default source is often a monitor; and the user dictates into ear buds |
| Voice model `auto`, chosen by device | `large-v3-turbo` always, with a setting | A remote workspace is usually CPU-only; "hello" took 10 s there, and nobody reads a setting's description to learn why |
| A gateway as a tab's own backend, its variables from the user's shell env file into that tab's process environment, the shared `~/.claude` kept | A separate `CLAUDE_CONFIG_DIR` per gateway, as a terminal launcher uses; the variables in `~/.claude/settings.json`; a window-wide switch | The settings file would put every session, every tool, on the gateway and bake the token into a config file. A separate config dir isolates settings, which is not the point: the environment is what differs, and perch sets it per process, so the session record, memory, and MCP servers stay shared and a tab resumes across the move. Per tab rather than per window because the user mixes: a gateway tab beside subscription tabs, to try it |
| A loopback relay per gateway process, to read which model answered | Trust the body's `model`; ask the gateway's spend log; a fingerprint prompt | The body carries the alias, so a routed name tells nothing; the log endpoint answered 401 to the token; a model's word on its own name is worth nothing. The header is authoritative and costs one `pipe()`. The relay forwards everything as it is, so the prompt cache and the token path are unchanged |
| Ask the CLI for its idle/running word (`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`) | Count results against messages sent | A message sent mid-turn can be folded into that turn and answered by its one result, which left the tab working for good; the count cannot tell, the CLI can |
| Transcribe in perch-audio when the user's machine has the GPU | Always with the workspace; Whisper in the webview | The user's desktop has an RTX 3090 and the remote is a CPU-only container. Same engine, copied at build; the webview route would be a second engine, and slower |

| "LLM gateway" as the name, not "Claude on the gateway" | The vendor's name first | What the tab is of is the router behind it; the client being Claude Code matters less, and the name fits anyone's proxy. The file, setting and code keep the plain word |
| The gateway is a backend of a Claude tab, chosen in the footer's menu | A tab kind of its own, with picker entry, numbering and icon (tried and reverted on 2026-10-02) | Everything but the route is Claude Code's; a second identity in the tab bar said the wrong thing |
| A turn through the gateway is priced per response at the answering model's list rates, from LiteLLM's public table | Trust Claude Code's `total_cost_usd` (prices a gateway's names as Opus, 50× Luna); ask the gateway after the fact by call id (its management routes refuse the token); read the token's running total off the headers (every use of the token, not this tab's; not monotonic across replicas) | The gateway prices nothing on a streamed response; the model that answered and the token counts are both known, and the table is the one the gateway itself uses. Shown with `≈` and the reckoning in the tooltip; the gateway's own figure, when it ever comes, is preferred |
| A tab the user has not named takes the title in its agent's record | Keep the first-message title on the tab; or show the tab's title in the list | Claude Code retitles a session as it goes and the list reads the records, so a tab could not be found in the list by the name on it. The record is the one name that outlives the tab |
| Deleting a session goes through the agent's own delete, after a modal question | Remove the files by hand; no confirmation | Each agent knows what its record consists of (Codex keeps names apart from rollouts); a deleted conversation cannot be brought back, which is what a waiting dialog is for |
| The cache clock restarts with each request, and a turn's token counts are read at each response's end | Once per turn, from the result and the assistant message | A long turn read "cold" throughout after an expiry; a gateway reports its counts only when a streamed response closes |
| Codex on Bedrock through Codex's own provider, as `--config` overrides per process | A custom `[model_providers.x]` with Bedrock's OpenAI-compatible URL; a gateway only | Codex signs for Bedrock itself and knows the two endpoints; overrides per process leave `~/.codex/config.toml` alone, as the API key does, and a tab moves on its next turn |
| The runtime endpoint by default, in the machine's region, with the ChatGPT connector apps off; Mantle by setting | Mantle by default (chosen first, for a third of the tokens); the apps left on | The token gap was the connector apps' schemas sent in full for a model id Codex's catalog does not know, not the endpoint; with the apps off, which cannot work on Bedrock anyway, the runtime endpoint is the leaner one, is in every region, and takes the IAM actions already granted |
| The Cursor cost claim withdrawn: "several times a terminal session" and the cache-miss diagram replaced by the measurement | Keep the claim with the public 5.5× as its source | The 5.5× is one run on mixed models with no cache analysis, by its own authors' account; the controlled bench (006) finds the same cache efficiency as Claude Code and a 10 % gap from tool calls. A design document that argues from caching cannot keep a caching claim it has measured to be wrong |
| A Codex turn's sub-agents and async questions read from the thread's rollout file while the turn runs | Wait for the SDK to stream them; the app-server protocol, which Codex's own extension uses | The SDK's item types do not include them in this version, and a turn of 14 minutes with three sub-agents showed nothing but the root's last command; the app-server would replace `codex exec` and the SDK altogether. The file is Codex's own record, read only, and perch already reads it for usage and transcripts |
| Each sub-agent's model, effort and tokens read from its own thread file, shown in a table the foot's count opens, on its end line, and under the turn's result | Guess the model from the parent's (true only until the parent is moved to another model, or a custom agent pins its own); Codex's own agents overview, which `codex exec` has no TUI for; a panel of all threads like `codex agents` | A sub-agent starts on the parent's model but a custom agent file or `[agents] default_subagent_model` can give it another, and the user's own five-day thread had 15 sub-agents on one model and 62 on the next: only the sub-agent's file says which. The three records read are a few lines of a file that is read anyway for its lifecycle; the table is the smallest surface that answers "which model, at what cost" without a second view, and a past turn's end lines answer the same from the files when the transcript is read back |
| A Codex session's usage read from its files when its table is opened, each thread priced by model at list rates | A running tally in perch's state as turns run; one rate for a whole thread; ChatGPT's own usage page | perch sees only the turns it runs, so a session resumed after a reload or worked on in another client would be short; the files are Codex's own record of every thread, and the largest read in under a second. A thread moved between models (the main thread here: 95 turns on one, 112 on the other, at rates 2× apart) is wrong at one rate. ChatGPT's usage page has no view by thread |
| A turn counted once, by its id; a fork's copied history skipped from its own start ordinal | Count the turn records | The records over-count: a compaction records a turn's context again, and a forked sub-agent's file opens with its parent's history (390 copied contexts in one thread's sub-agents), so each forked sub-agent showed a turn more, on its parent's model |
| A Codex web search's card drawn at its start and again, in place, from its completion | Draw it only on completion; leave it as the start says | Codex fills the item in only on completing, but the start is the only sign one is running. Drawn twice in place, the card shows both, and the foot says *Searching the web* only between the two |
| A queued Claude message is taken back from Claude Code's own queue, by a uuid perch gives it | Hold Claude's queued messages in perch, as Codex's are | Claude Code's queue is where they belong: it merges messages sent close together into one turn, and Stop's handling of what is queued is its own. Its cancel request does exactly this job and says whether it was in time |
| A Codex login Codex refuses is a state, held until auth.json holds another login, recognised by Codex's own codes | Treat "auth.json has tokens" as logged in, and offer the login on any 401; validate the login with a request before each turn | The file says nothing of whether ChatGPT still honours it (`codex login status` says "Logged in" for a revoked one), and a bare 401 can be any server's. Codex's codes are the authority, and a fingerprint of the file (time, size, `last_refresh`; no token) tells when a new login, or a refresh by another Codex, has replaced the refused one, with no request of perch's. The wait for a login had to change with it: it returned at once because the old file was there, and the sign-in was stopped before the browser came back. `codex login` removes the old `auth.json` as it starts, so the wait asks for a login that exists and is not the refused one. And the login is run with the program's real path: where perch runs the SDK's own `codex` (from a checkout), `resolveProgram` leaves the path to the SDK, and the bare name `codex` was run instead, which failed with ENOENT on a machine with none on PATH (`sdkCodex` in `src/binaries.js`) |
| A login button always answers: pressed while a login waits, the same sign-in page again; a login made marks every login note done, in place | One login at a time, a second press ignored; the notes left as they were | The browser sign-in listens on a fixed port, so one at a time stays; but a press that does nothing reads as broken (seen on 2026-10-12: the notification's Log In started the login and the note's, pressed while it waited, was dropped without a word), and notes still offering a login after one is made invite a second. Notes carry `nid: 'codexLogin'`; `noteDone` replaces their buttons with the word, and the history keeps it for replays |
| An app's connect link is shown as a button; installing a plugin is left to the CLI | A plugin browser and an OAuth flow in perch; perch on the app-server, which has `plugin/install` and elicitation | The connection is ChatGPT's (made on chatgpt.com, kept there), so perch has only to show the link Codex already gives, which nothing else shows under `codex exec`; installation is once per account with one command, and the app-server's plugin methods are marked not for production clients yet |
| An async question's answer goes as the next message | Answer through the tool | `codex exec` has no channel back into a running turn: the tool returns `{"accepted":true}` at once and the agent carries on; the next message is the only way the answer reaches it, and it says so on the card |
| The ways on from a held message are buttons under its note | A VS Code notification alone | A notification hides itself after a few seconds; on a first run it was gone before it was read. The notification stays for the longer explanation |
| A gateway tab's process is given the gateway's variables as its own settings, over the user's | Hold the tab's first message and tell the user to switch the window to the subscription (as it did until 0.6.41) | On a machine whose only Claude login is Bedrock the instruction had no good outcome: switching the window would strand the Bedrock tabs. Settings given on the command line outrank the user's file, so the tab can be made right by itself; the token is kept out of them, since a process's arguments are readable by others on the machine |
| The gateway template turns the hour-long prompt cache on | Leave Claude Code's default (five minutes on a token) | Per-token billing makes the hour the cheaper choice at the first pause over five minutes; the line says what it costs and when to remove it |
| The backend chosen for a tab becomes the default for new Claude tabs | Every new tab on the window's backend; a setting | The user opening a gateway tab wants the next one there too; subscription and API already stick through Claude Code's setting, so the gateway is made to stick the same way, in global state |
| Claude's default is named by the model the CLI says it is on: the idle CLI's start model before the process starts, then the model the process reports; the effort list follows the same model | The SDK's `default` entry, as until 0.6.53 | That entry is Claude Code's built-in default whatever `ANTHROPIC_MODEL` or the settings say, so where `ANTHROPIC_MODEL` named Sonnet 4.6 a tab running it read Opus and was offered `xhigh`, which Sonnet lacks. Asking the idle CLI costs no request |

---

<a id="n118"></a>

## 118 — References

### VS Code

- [Webview API](https://code.visualstudio.com/api/extension-guides/webview):
  panels, message passing, Content Security Policy, state and
  serialization.
- [Views guidelines](https://code.visualstudio.com/api/ux-guidelines/views):
  view containers and their chrome.
- [Supporting remote development](https://code.visualstudio.com/api/advanced-topics/remote-extensions):
  extension kinds, where `ui` and `workspace` extensions run, and
  commands across hosts.
- [Extension host](https://code.visualstudio.com/api/advanced-topics/extension-host).
- [API reference](https://code.visualstudio.com/api/references/vscode-api):
  `WebviewViewProvider`, `WebviewPanelSerializer`, `Memento`.
- [Contribution points](https://code.visualstudio.com/api/references/contribution-points):
  `views`, `menus`, `editor/title`.

### Claude

- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
  and [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  breakpoints, lifetimes, pricing.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort).
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`: the authority
  for every SDK call perch makes. Where these notes and that file
  disagree, the file is right.

### Codex

- [openai/codex](https://github.com/openai/codex), and its
  [TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript).
- `codex app-server generate-ts`: prints the app-server protocol as
  TypeScript. Used to confirm that realtime voice exists only there.
- `~/.codex/models_cache.json`, `~/.codex/config.toml`,
  `~/.codex/sessions/`: formats observed on disk, not documented.

### Speech

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and
  [CTranslate2](https://github.com/OpenNMT/CTranslate2).
- [whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo).
- [PvRecorder](https://github.com/Picovoice/pvrecorder).

### Compared and related

- [AI Meter](https://github.com/seanahn/ai-meter): the origin of
  [note 111](110-features.md#n111).
- [OpenCode](https://github.com/sst/opencode):
  `packages/opencode/src/provider/transform.ts`, `applyCaching`.
- [Continue](https://github.com/continuedev/continue).
- [LiteLLM prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching).
- [Claude Code vs Cursor: token efficiency, 2026](https://www.futureproofing.dev/resources/ai-native-team/claude-code-vs-cursor-token-efficiency-2026)
  (futureproofing.dev): the public 5.5× figure, one run on mixed models,
  no cache analysis; read in [note 102](#n102) for what it does and does not
  support.
- The user's controlled bench (2026-10-06): Claude Code and Cursor on Opus
  5.5 through Bedrock, same prompts, one price basis; the source of
  [note 102](#n102)'s Cursor row.

### Observed, not documented

These are behaviours perch depends on that come from inspection rather
than from published documentation. Each may change without notice.

| Behaviour | Source |
| --- | --- |
| The Claude usage endpoint and its response | AI Meter; a live response |
| That endpoint returns 429 under load | Observed |
| Codex's rollout file format | Files on disk |
| Codex's model cache format | File on disk |
| Settings win over environment for `CLAUDE_CODE_USE_BEDROCK` | Verified empirically by AI Meter |
| ChatGPT dictation uploads to `/transcribe` | The ChatGPT extension's code |
| `workbench.action.unlockEditorGroup` given a file unlocks the first group, most recently used first, that has an editor of it, and otherwise the active group; before 1.92 it matched only a group's active editor, and passed the group's position where its id was wanted | VS Code's source (`resolveCommandsContext`, 1.92 to 1.129; `getCommandsContext`, 1.90 and 1.91) |
| A tab moved to another group is told as an open there, then a close whose tab's `group` is the group it left | VS Code's source (`extHostEditorTabs.ts`, 1.129) |
| The SDK's `default` model entry is Claude Code's built-in default, whatever `ANTHROPIC_MODEL` or the settings' `model` say | Probed, SDK 0.3.284 (2026-10-15) |
| On an idle CLI, `getContextUsage({ detail: 'summary' }).model` is the model a new session starts on, and makes no request; after `setModel(undefined)` it is the built-in default, which then answers | Probed, SDK 0.3.284 (2026-10-15) |
