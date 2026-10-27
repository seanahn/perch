# 111 — Usage meters

The footer follows the active tab.

## Claude

Ported from [AI Meter](https://github.com/seanahn/ai-meter), by the same
author, and merged in rather than called across extensions.

**Subscription mode.** `GET api.anthropic.com/api/oauth/usage`, with the
OAuth token Claude Code stores in `~/.claude/.credentials.json` or the
macOS Keychain. Polled every five minutes and cached in `globalState`,
so the gauge is there at once after a reload.

**Cost mode.** Used when Claude is configured for Bedrock or API, where
there is no quota to report. Tokens and estimated cost are computed from
the transcripts under `~/.claude/projects/`. Files are read
incrementally, and one message, which produces a line per content block,
is counted once.

Prices used, in dollars per million tokens:

| Model family | Input | Output |
| --- | --- | --- |
| Fable, Mythos | 10 | 50 |
| Opus 5 and 4.5 to 4.8 | 5 | 25 |
| Opus 4.0, 4.1, 3 | 15 | 75 |
| Sonnet | 3 | 15 |
| Haiku 4 | 1 | 5 |
| Haiku 3.5 | 0.8 | 4 |
| Older Haiku | 0.25 | 1.25 |

A model that matches none of these is counted in tokens and shown as
having no price data, rather than priced by guess.

Cache reads bill at 0.1 times input; cache writes at 1.25 times for a
five-minute lifetime and 2 times for an hour. These are list prices.
Bedrock or partner billing may differ.

**Failures are classified by HTTP status.**

| Status | Read as | Response |
| --- | --- | --- |
| 429 | rate limited | Keep the reading, mark it stale, wait |
| 401, 403 | login expired | Offer login |
| 5xx | network | Retry |
| 200, unusable body | bad response | Retry |

**Back-off.** After a 429 perch waits at least a minute, doubling to
half an hour and honouring `Retry-After`, and makes no request in that
time even when refresh is clicked. The original read a 429 as a
malformed body and retried every 15 seconds, which prolongs a rate
limit.

**The backend switch** writes `env.CLAUDE_CODE_USE_BEDROCK` in
`~/.claude/settings.json`.

- The settings value wins over an exported environment variable, and
  `settings.local.json` over `settings.json`. Verified against Claude
  Code by AI Meter.
- Model pins are backend-specific. Switching to subscription sets aside
  a Bedrock model id and blanks provider-prefixed `ANTHROPIC_MODEL` pins.
  Switching back restores them.
- The file is written atomically, by rename.
- A settings file that is not valid JSON is **refused**, not replaced.
- An open Claude tab moves to the new backend: its process ends (after
  the current turn, if one is running) and the next message resumes the
  session on the new backend, as after a window reload. The transcript
  and the session id stay; the prompt cache starts over, being a
  property of the backend. The tab is told so.

**The gateway** is a third backend, a tab's own rather than the window's.
A gateway is an Anthropic-compatible endpoint reached with
`ANTHROPIC_BASE_URL` and a token, as a company's LLM proxy is. The user
keeps its variables in a file written as a shell reads it
(`export KEY=VALUE`), `~/.config/gateway-claude/env` by default
(`perch.claude.gatewayEnv`), so one file serves a terminal launcher and
perch. A tab on the gateway gets the file's variables added to its
process's environment (`src/gateway.js` reads the file each time a
process starts, or a `tabs` message is built: it is small, and the user
may be editing it). Nothing else changes: `~/.claude/settings.json` is
not written, the token is never in a file of perch's, and the session
record, `CLAUDE.md`, memory, and MCP servers are those of any other tab.
Verified: with an OAuth login present in `~/.claude`, Claude Code
authenticates with the environment's bearer token at the environment's
base URL and leaves the login alone ([note 115](115-verified-and-not-verified.md)).

- The choice is a field of the session, saved with it. Moving a tab onto
  or off the gateway ends its process and resumes the session, as the
  window's switch does; the window's switch leaves tabs on the gateway
  alone.
- A gateway tab's first message is held when the file is missing or sets
  no URL or token, or when the window is on API / Bedrock, since Claude
  Code's settings win over a process's environment. The offers: open the
  file (made from a template, mode 600, never over an existing one), use
  the subscription, or take the tab off the gateway.
- The gateway is a backend of a Claude tab, not a kind of tab. It is
  chosen in the footer's backend menu under any Claude tab, where the
  entry reads **LLM gateway** (this tab only), beside the window's two;
  the picker, **+** and the sessions list offer Claude and Codex only.
  A kind of its own ("Claude on the gateway", then "LLM gateway", with
  its own numbering and icon) was tried on 2026-10-02 and taken out the
  same day: the tab's prompt, tools, permissions, `CLAUDE.md`, skills and
  record are all Claude Code's, and only the route differs, so a second
  identity in the tab bar said the wrong thing. The name "LLM gateway"
  stayed, since the client being Claude Code matters less than the router
  behind it, which is what the tab is of; the file, the setting and the
  code keep the plain word "gateway", which fits anyone's proxy.
- The choice sticks. Once a tab is put on the gateway, new Claude tabs
  start on it (`perch.claude.newTabsOnGateway` in global state, since the
  gateway file is the machine's), until a tab is put back on the
  subscription or API / Bedrock from the same menu; those two stick
  through Claude Code's own setting, as before. The first-message help's
  "Leave the Gateway" moves one tab and changes no default.
- The gateway's model menu is the file's names, not Claude Code's
  catalog: the default is `ANTHROPIC_MODEL`, and opus, sonnet and haiku
  are what `ANTHROPIC_DEFAULT_*_MODEL` map them to (`src/gateway.js`,
  `gatewayModels`), which is what the gateway receives, because those
  three aliases are exactly what Claude Code translates through those
  variables and a catalog id such as `claude-fable-5-1` would go out
  untranslated to a router that has no such name. Effort offers the usual
  levels, a router's names saying nothing of it. A tab moved onto the
  gateway with a catalog model chosen starts from the file's default, so
  the pill never names a Claude model while the gateway answers; an alias
  survives the move back.
- A tab whose file is missing or incomplete holds its first message,
  puts it back in the box, and says why in a note. The two ways on, the
  file (made from the template if absent) and the tab off the gateway,
  are buttons under that note (a note event may carry `actions`; the page
  posts `noteAction`), where they stay: the notification beside them,
  which says more, hides itself after a few seconds, and on a first run
  that was the whole of the guidance. Each button is safe to press again,
  since an old note keeps its buttons. The other first-message holds
  carry theirs the same way: Claude on API / Bedrock with no credentials
  (Open settings.json, Use Subscription), Claude on the subscription with
  no login (Log In, Use API / Bedrock), and Codex with no login (Log In,
  Device Code). A button acts only on what still applies: Use
  Subscription does nothing in a window already on it, Log In says so
  when the login is already there, and a login taken from a button runs
  without the notification, which may be gone or still waiting unseen
  in the notification centre. The Codex sign-in is one run at a time
  whichever asked for it, since it listens on a fixed port.
- With no `ANTHROPIC_MODEL` in the file the model button reads
  "default" and its tooltip says to set one. It first read "the gateway's
  default", which was wrong as well as long: the gateway does not choose,
  Claude Code sends the name it would use anyway (the environment's
  `ANTHROPIC_MODEL`, or its own default), which a gateway may not know.
- The template turns the hour-long prompt cache on (`ENABLE_PROMPT_CACHING_1H=1`).
  Claude Code's rule, read from the 2.1.119 binary: `FORCE_PROMPT_CACHING_5M`
  forces five minutes, `ENABLE_PROMPT_CACHING_1H` forces the hour (Bedrock
  needs `ENABLE_PROMPT_CACHING_1H_BEDROCK`), and otherwise the hour goes only
  to a claude.ai login that is not in overage, which an `ANTHROPIC_AUTH_TOKEN`
  is not, so a gateway tab would send no `ttl` and get five minutes. On a
  per-token bill the hour costs 0.75× more on each write and saves a whole
  re-write of the context at the first pause over five minutes; with a 150 K
  context one pause an hour pays for it several times over, so the file
  turns it on and says what to remove if the gateway rejects it. The cache
  pill reads the same three variables, from settings.local.json's env block
  over settings.json's over the gateway file over the process (the order
  Claude Code applies them); overage is not visible to it.
- The gauge shows nothing under a gateway tab. The gateway's usage is its
  own, and the cost-mode figures would be at Anthropic list prices for
  names the gateway may map to anything. The result line under each
  answer still shows the tokens.
- The cache clock assumes five minutes, the API's lifetime.
- **Which model answered.** A routed name is resolved per request, and
  the gateway's answer body carries the alias, not the deployment; the
  Agent SDK surfaces no response headers. So the tab's process goes
  through the relay ([note 108](108-agents.md)), and the gateway's `x-litellm-model-name`
  is read off each response. The host counts them per turn and puts them
  on the `result` (`via gpt-6-luna ×3, grok-4.6` under the answer: a turn
  is several requests, and the router may send each somewhere else), and
  the last one on the tab, for the model button's tooltip. The same
  headers carry the gateway's own
  price for each response (`x-litellm-response-cost`); the host sums
  them per turn and the result line shows that figure in place of
  Claude Code's `total_cost_usd`, which prices a gateway's names by
  guess (≈$0.045 against the gateway's $0.0021 for one "hello" on
  Luna). The session's sum is saved with the tab. But LiteLLM puts that
  header only on a response it has finished pricing, and a streamed one
  is not priced when its headers go out: Claude Code streams every
  request, so a tab never sees it (measured 2026-10-02: the same request
  unstreamed carried `x-litellm-response-cost: 0.000918`, streamed it
  carried the zeroed `-original`, `-input`, `-output` parts and no cost).
  So each response's token counts are priced by the host at the
  answering model's list rates. The counts are taken from the response's
  own stream, when it ends (`claudeAgent.js`: the largest value of each
  field across `message_start` and `message_delta`, per conversation,
  said at `message_stop`), not from the SDK's assistant message: a
  gateway in front of another vendor's model sends zeros at the start and
  the real counts in the closing delta (measured 2026-10-05: start
  `input 0, output 0`, end `input 9, output 17`), and a figure taken at
  the start read ≈$0.0000 for a turn that had written 92,842 tokens. They
  are priced
  (`src/prices.js`): the relay's model names are queued per turn in
  order and each `usage` takes the next, so a turn of two requests on
  Luna and one on Grok is three requests at their own rates. The rates
  are LiteLLM's public table (`model_prices_and_context_window.json`,
  the one the gateway prices with, short of a deployment's own
  overrides), fetched once a week into the extension's global storage,
  and a name is looked up as the gateway spells it and then without its
  region and provider prefixes (`global.openai.gpt-6-luna` →
  `openai.gpt-6-luna`; `xai/grok-4.6` as is). The result line shows that
  figure with `≈` when the gateway gave none, and the tooltip says the
  reckoning; for the `hello` that Claude Code priced at ≈$0.594 as Opus
  the Luna rate gives ≈$0.012. The gateway also puts the token's running
  total on every response (`x-litellm-key-spend`, every use of the token
  included, and not quite monotonic across the gateway's replicas); the
  host keeps the last seen and the tooltip states it, since it is the
  one figure that is the gateway's own. Observed on a gateway with routed names: a routed name sent trivial
  and code prompts to one model and a proof to another, and a one-word
  turn from Claude Code went to a third through a fallback. The agent is Claude Code; the
  model is whatever answered, and the tab now says which.

**No status bar items.** The gauge is the footer of each tab, where it
follows the tab's vendor. An earlier version put AI Meter's two items in
the status bar as well, standing down while that extension was installed;
they showed Claude's figures under a Codex tab too, and were removed.

## Codex

After every turn Codex appends a `token_count` event to the session's
rollout file under `~/.codex/sessions/YYYY/MM/DD/`. It carries the plan's
limits:

```json
"rate_limits": {
  "primary":   { "used_percent": 4.0, "window_minutes": 300,   "resets_at": 1790719106 },
  "secondary": { "used_percent": 1.0, "window_minutes": 10080, "resets_at": 1791305906 },
  "plan_type": "plus"
}
```

perch reads the newest such event, from the last 256 KB of the newest
files.

- No request is made, so there is nothing to rate-limit.
- The reading is as old as the last Codex turn on the machine, from any
  client. The tooltip says when.
- **A window whose reset has passed is shown as full.** Otherwise a
  reading from yesterday would show a nearly empty window that has long
  since reset.
- perch re-reads after each Codex turn it runs.

## A session's usage, thread by thread

Built for Codex first (below), and given to Claude tabs on 2026-10-27, from Claude Code's own
records: the session's file for the main thread, and for each sub-agent the file Claude Code 2.1
keeps under `<session>/subagents/` (`agent-<id>.jsonl`, with `agent-<id>.meta.json` naming it and
the Agent call that started it; the call's result in the parent's file says it finished). A response
comes as one record per block, each with the response's usage so far, so it is counted once, at its
largest figures; `input` counts every token sent, cached and written among them, as Codex's does; a
turn is a prompt of the user's, attributed to the model that answered it. Priced at Anthropic's list
rates from the same LiteLLM table; on a subscription the figures say where the work went. Read from
this session's own files: 387 turns, 1.03 G input tokens of which 1.015 G from the cache, 3.4 M out,
two models over its life, and one sub-agent.

The plan's limits say how much is left, not where it went. A session that
starts sub-agents spends in many threads at once: the user's own thread on
2026-10-12 had 76 sub-agents, which together took 42 % of the session's
cost. Under a Codex tab, the footer's **sub-agents** button opens a table
of the whole session, one row per thread: the main thread first, then each
sub-agent it started (and any those started, by path, `alpha/deep`), then
the sub-agents' total and the session's. Each row has the model and effort
(every model, with its turns, when the thread moved), turns, input with
the cached part of it, output, the cost at list prices, and its share of
the session. The sub-agents sort by any column; by cost until another is
chosen.

- **Read from the files, on demand.** The host reads the session's rollout
  file and each sub-agent's own (`sessionStore.sessionUsage`): the threads
  from the `SubAgentActivity` records, each thread's tally from its own
  `turn_context` and `token_usage_record` records, whole. Nothing is kept
  in perch's state. The table is read when opened, and again when a turn
  ends while it is open. The user's thread (95 MB, 76 sub-agent files) reads
  in under a second.
- **A turn is counted once, by its id.** A turn records its context again
  after a compaction: 21 of that thread's 205 turns did. Counting records
  showed 226.
- **A fork's copy of its parent's history is not its own.** A sub-agent
  forked from the conversation has the parent's history copied into the top
  of its file, contexts included: 390 copied against 161 of their own, in
  those 74 files. The sub-agent's own `session_meta`, the file's first
  line, names where its own records begin
  (`subagent_history_start_ordinal`), and `UsageTally` skips the records
  before it. Before this, every forked sub-agent showed a turn more than it
  had, on its parent's model, in the foot's table and on its end line too.
  Token records are never copied (none of the 2,121 in those files names
  another thread), so the token figures were right.
- **Priced per model, at list rates.** Each request's tokens go under the
  model of the turn they are in, so a thread moved to another model is
  priced at each one's rates: uncached input, input written to the cache,
  cached input, and output, from LiteLLM's public price table, the same one
  a gateway's turns are priced with. A thread with a model the table does
  not price shows no cost, and says which model; shares are then of tokens.
- **What the cost means.** On a ChatGPT plan nothing is billed per token:
  turns count against the plan's limits, and the cost says where the work
  went. On an API key it is what OpenAI's list prices charge; Bedrock bills
  at its own rates. The tooltip says which.
