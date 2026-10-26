# 116 — Limitations and open work

| Item | Notes |
| --- | --- |
| Codex approvals cannot prompt, and Codex cannot ask a question | A property of `codex exec`. Codex's `request_user_input` needs the app-server protocol, at the cost of rewriting the Codex integration |
| A Codex name written by perch may not show in the ChatGPT extension | perch appends to `session_index.jsonl`, Codex's own name file; Codex also keeps titles in a database perch does not write |
| Resumed transcripts show the last thousand entries | Older ones are the agent's; a note says how many |
| No streaming for Codex text | The SDK reports completed messages |
| Mentions are inserted as text | The agent resolves `@path` |
| AI Meter's fixes are not upstreamed | The rate-limit back-off and the settings safeguards would benefit the standalone extension |
| Two extensions poll the usage endpoint | While AI Meter is also installed, both query it. Uninstalling AI Meter removes the duplicate |
| perch-audio must be installed by hand from a `.vsix` | From the marketplace it comes with perch, through `extensionPack` |
| No syntax colouring in code blocks | The Markdown renderer draws code as text |
| One gateway at a time | The file names one. `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` could also let Claude Code list the gateway's own models for the menu; off in the user's file, and not used |
| A gateway tab is told apart in the footer, not the tab bar | By choice ([note 111](111-usage-meters.md)): the tab is Claude's. A small `gw` mark on the title would be the cheap remedy if wanted |
| Backend switch under a gateway pinned in `settings.json` | Fixed in 0.6.55: see *Backend-correct tabs* below |

## Backend-correct tabs (0.6.55): subscription / gateway / API first-class

**Problem.** When `~/.claude/settings.json` pins a gateway for *all* Claude Code (`ANTHROPIC_BASE_URL`
plus an `apiKeyHelper`, as a managed machine may), a tab set to **subscription** or
**API/Bedrock** still runs on the gateway, yet the footer prints "sub" and the model menu lists the
gateway's own names. The label lies and the list is wrong. Perch should present every
backend truthfully, independent of what the machine pins.

**Root cause (code spots).**
- `claudeAgent.js:78` passes Claude Code's `--settings` **only for gateway tabs** (`gatewaySettings`).
  Non-gateway tabs pass nothing, so the pinned `settings.json` wins and the tab runs on the gateway.
- `extension.js:300` `catalog()` returns `Gateway.gatewayModels(...)` for gateway tabs, else the single
  `view.catalog.claude` — which `extension.js:1122` loads **once**, via `loadClaudeModels()` under the
  pinned env, so it *is* the gateway catalog. Sub/API tabs therefore show gateway models.

**Verified gate (2026-10-22).** `--settings` with `{"env":{"CLAUDE_CODE_USE_BEDROCK":"0","ANTHROPIC_BASE_URL":""},"apiKeyHelper":""}`
**does** take the CLI off the pinned gateway: it then rejected the gateway's model name as an
*unrecognized model* (that name exists only on the gateway) instead of answering. So a per-backend `--settings`
override works. It also proved a second requirement: switching off the gateway must **also drop the
gateway's `model`**, or the subscription 400s on an unknown id.

**Plan (coupled — they move together).**
1. **Per-backend `--settings`.** Add `offGatewaySettings(bedrock)` → `{env:{CLAUDE_CODE_USE_BEDROCK:
   bedrock?'1':'0', ANTHROPIC_BASE_URL:''}, apiKeyHelper:'', model:''}`. In `claudeAgent.js:78`, pass it
   for non-gateway tabs (gateway tabs keep `gatewaySettings`). This routes sub/API tabs off the pinned
   gateway.
2. **Per-backend catalog.** `loadClaudeModels` gains a `settings` arg (passed to the SDK `query`
   options); load `view.catalog.claude` under the subscription override so a sub tab lists native
   `Opus/Sonnet/Haiku`. Gateway tabs keep `gatewayModels`. (A machine with no subscription login simply
   gets no sub catalog and falls back to the static list — honest.)
3. **Model reset on switch + honest label.** On a non-gateway tab, don't carry a model that isn't in
   its catalog (drop to default); the footer label then reflects the real backend (the `gw`/label code
   at `webview.js:1095/1103` already distinguishes — it just needs the routing to be real).
4. **The model slots too (found 2026-10-23, before the release).** Clearing `model` was not enough: the
   pinned file also sets the model slots (`ANTHROPIC_DEFAULT_OPUS_MODEL` and the Sonnet and Haiku ones) to
   the gateway's names, so the sub catalog still resolved Opus, and Haiku, which Claude Code's background
   calls use, to names that are refused off the gateway. `offGatewaySettings(bedrock, inherited)` also sets
   each of `OFF_GATEWAY_VARS` (the three slots, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, the
   subagent model and the gateway's `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) to what the tab inherits,
   the machine's own export, when that suits the backend (a Bedrock id such as
   `us.anthropic.claude-sonnet-4-6` only on Bedrock), else to `''`, Claude Code's default.
