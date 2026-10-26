# 109 — Model catalogs

Lists are read from the agents, never hardcoded. An earlier hardcoded
Codex effort list was wrong: it offered `minimal`, which no listed model
accepts, and lacked `max` and `ultra`.

| | Claude | Codex |
| --- | --- | --- |
| Models | `supportedModels()` | `~/.codex/models_cache.json`, entries with `visibility: list` |
| Efforts | per model, `supportedEffortLevels` | per model, `supported_reasoning_levels` |
| Default model | the model the idle CLI says it is on, `getContextUsage({ detail: 'summary' }).model`, named by the entry that is it or resolves to it; the SDK's `default` entry if the CLI cannot say | `model` in `~/.codex/config.toml` |
| Default effort | not reported | `model_reasoning_effort` in the config, if the model accepts it |
| Cost to read | about 0.7 s, no request | a file read |

**Reading Claude's list without a request.** The CLI is started with an
input stream that never yields. It initializes, answers
`supportedModels()`, `getContextUsage({ detail: 'summary' })` and
`supportedCommands()`, and is stopped. No message is sent, so nothing is
billed; the summary is worked out from local figures.

**Effort follows the model.** Changing the model rebuilds the effort
list. An effort the new model does not accept resets to default. A model
with no effort control, Haiku for one, says so. On Claude's default the
model is the one the session reports (below), so there the check is made
when it reports.

**Defaults are labelled.** `default · Sonnet 4.6`, `default · ultra`.

On Claude, default is two models. A new session starts on
`ANTHROPIC_MODEL`, else the settings' `model`, else Claude Code's
built-in default; `setModel(undefined)` in a running session goes to the
built-in default, whatever the session started on. The SDK's `default`
entry names the built-in one in both cases, and the label used to come
from it, so a machine that sets `ANTHROPIC_MODEL` to Sonnet 4.6 showed a
tab running Sonnet as default Opus and offered it Opus's `xhigh`. So:

- Before a tab's process starts, the label is the model the idle CLI
  says it is on, read with the catalog.
- Once it runs, the label is the model the process reports: the `model`
  of its `init` message and of each context reading. After a model
  change Claude is asked at once; until it answers, the label is the
  start model's.
- A reported id is named by the catalog entry that is it or resolves to
  it, and shown as it is when the list lacks it.
- The effort list follows the same model. An effort the reported model
  lacks resets to default when the report arrives, and again when the
  process is restarted, since the next one starts on the start model.
- The option's tooltip says when the running model is not the one new
  sessions start on. A gateway tab's default is the file's ([note 111](111-usage-meters.md)).

**Refusal fallback.** Claude Code moves a session itself when a model's
safeguards refuse a response: it retries the response on a fallback
model, takes the refused one back, and keeps the session on the fallback
(`model_refusal_fallback` with scope `session`; scope `local` is one
response of a sub-agent or a side question). Seen on 2026-10-20: Opus 5.5
to Opus 4.8, category `cyber`, while the pill still said Opus 5.5. So:

- The fallback model is the one the session runs from then on, until a
  model is chosen or the process restarts. A context reading that names
  the model asked for does not undo it.
- When the model running is not the one meant (the one chosen, by the id
  it resolves to; on default, the one Claude Code moved the session
  off), the pill names the running one, in the warning colour, and its
  tooltip says why. Ids are compared by the model they name, so a
  provider's id (`us.anthropic.claude-opus-5-5-v1:0`) is that model.
- Claude Code's notice is a `note` with `level: 'warn'`. The Agent SDK's
  reader gives a past session's system records without their words, so
  a past transcript reads those from the session's own file.
- Each main-thread response names its model (`message.model`). The
  turn's `result` lists them, less any a fallback took back
  (`supersedes`, `retracted_message_uuids`), and its line says
  `answered by` when one is not the model meant. The gateway's own
  `via` does this for a gateway tab.

**Fallback.** Until a catalog loads, or if it cannot, tabs use a static
effort list and offer only the default model. A catalog that arrives
after a tab exists corrects that tab.
