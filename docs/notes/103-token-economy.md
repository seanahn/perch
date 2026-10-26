# 103 — Token economy: how the reuse is achieved

## What a turn costs

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

## Where the cache lives: the vendor, Bedrock, a proxy

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
  Measured for OpenAI models on 2026-10-06 ([note 115](115-verified-and-not-verified.md)): automatic prefix
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

## The mechanisms

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

## What a perch tab spends that a terminal would not

| Cost | When | Size |
| --- | --- | --- |
| IDE context on a message | With the toggle on, which it is by default | The active file's selection, up to 12,000 characters |
| Compaction on a Codex model switch | Only when the model is changed mid-thread | One compaction of the thread |
| A pasted image | Only when one is sent | Scaled to at most 1568 px on the long side, the most the API keeps; roughly 1,800 tokens for a full-width screenshot, by the vendors' area-based estimates. Past 20 images in a conversation the API refuses any image of 2000 px or wider (measured: 2000 exactly is refused), and the agent keeps every earlier image until it compacts; the tab says so at the twentieth |

Nothing else. In particular perch adds no per-message instructions, no
retrieval, no summaries, and no hidden calls.

## Comparison

[Note 102](102-why-a-shell.md) compares the harnesses. In these terms: OpenCode caches
soundly but on API billing with a five-minute lifetime; Continue's
context providers re-render near the front of the prompt, so its prefix
is not stable and a gateway below it cannot make it so. Both replace the
vendor's agent, so neither gets its compaction or its subscription
billing. perch gets both because it changes nothing in the agent.

## How to see it

Each turn's result line in the transcript shows the agent's own usage
figures: tokens in, tokens read from cache, tokens out, and for Claude
the cost. A warm turn shows nearly all of its input as cached. The
figures come from the agents (`result` messages from Claude Code,
`turn.completed` from Codex), not from an estimate of perch's.

## Not verified

- Codex's cache behaviour is inferred from the SDK's design (one thread,
  resumed by id, the same prefix) and its `cached_input_tokens` figures,
  not from OpenAI's cache keys, which the SDK does not expose.
- The image token figure is the vendors' published estimate, not a
  measurement.
