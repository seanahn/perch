# 110 — The composer

One composer, shared by all tabs on a page, reflecting the active tab.
It takes its vendor's look through a class on the container and CSS
`order`, so both layouts are the same elements.

## Claude tab

| Tool | Data |
| --- | --- |
| **+** | File picker. Inserts `@relative/path` |
| **/** | Slash commands. Typing `/` opens the same list |
| Ring | Context used. Amber at 80%, red at 95% |
| Clock | Minutes until the prompt cache goes cold |
| Pill | Model and effort, opens a menu |
| Bolt | Permission mode: Ask, Edits, Plan, Auto, Bypass |
| Microphone | Dictation |
| Square | Send, or Stop |

## Codex tab

**+**, the sandbox behind a shield (Full access in amber), the model with
its effort and a chevron, IDE context, the microphone, and a round send
button. The Codex extension's "Work locally" chooser is not copied: the
SDK runs local threads only (no cloud option), and a label styled like
the vendor's chooser read as a broken switch; it was taken out on
2026-10-02.

## The cache clock

How long Claude Code keeps the prompt cache warm, by Claude Code's own
rule (read from the 2.1.119 binary; `src/meter.js`, `promptCacheMinutes`):

1. `FORCE_PROMPT_CACHING_5M` set: five minutes.
2. `ENABLE_PROMPT_CACHING_1H` set (on Bedrock,
   `ENABLE_PROMPT_CACHING_1H_BEDROCK`): one hour.
3. Otherwise one hour on a claude.ai login, five minutes on an API key,
   a gateway token, Bedrock, Vertex, or Foundry.

The variables are read as Claude Code sees them: the settings files'
`env` blocks over a gateway file's variables over the process
environment. A running tab keeps the lifetime of the backend it started
on.

The clock counts down from the last request, not the last answer: the
agent says `responded` when each response of a turn begins (the SDK's
`message_start`, which the request that touched the cache brought), and
again at the turn's end. Counting from the turn's end only, as it first
did, left the pill reading "cold" all through a turn that began after an
expiry, however long the turn ran and however many requests had warmed
the cache since (seen on 2026-10-05). A subagent's requests are another
conversation's cache and do not restart the clock.

## Slash filter

A filter of one or two letters matches command **names** only.
Descriptions are searched from three letters. Otherwise `/c` matched
`/model`, whose description contains a "c".
