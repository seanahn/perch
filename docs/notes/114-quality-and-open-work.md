# Quality and open work

How Perch is tested, what has been verified against the vendors' agents and what has not, and the limitations and the work still open. One file, formerly 3 notes, each a section that keeps its number: links from elsewhere point at `#n<number>`.

- [114 — Testing](#n114)
- [115 — Verified and not verified](#n115)
- [116 — Limitations and open work](#n116)

<a id="n114"></a>

## 114 — Testing

| Suite | What it runs | Model calls |
| --- | --- | --- |
| `test/meter.test.js` | Usage, cost, the switch, in throwaway homes and four timezones | no |
| `test/gateway.test.js` | The gateway file: parsing, what makes it usable, the template, in a throwaway directory | no |
| `test/relay.test.js` | The relay, against a stand-in gateway on the loopback interface: forwarding, streaming, headers read, errors passed on, a gateway that is down | no |
| `test/codexMeter.test.js` | Codex usage, in throwaway session directories | no |
| `test/models.test.js` | Catalog and command parsing | no |
| `test/voice.test.js` | The engine, against a stand-in server | no |
| `audio/test/recorder.test.js` | The recorder and its commands, with a library that plays back frames | no |
| `test/host.test.js` | The host, against a stubbed VS Code API and stand-in agents | no |
| `test/page.test.js` | The real page script, in jsdom | no |
| `test/harness.mjs` | Live: both agents, catalogs, usage, queueing | **yes** |

`make test-offline` runs the first nine. `make test` runs all ten.

### Rules learned the hard way

1. **Assert on what is rendered, not on attributes.** A test checked the
   `hidden` attribute while a `display: flex` rule overrode it, so every
   pane drew on top of the others and the test passed. It now checks
   computed style.
2. **`set -o pipefail` before any pipeline that gates a commit.** A
   failing suite was piped through a filter, the filter's status won,
   and a commit went in with a test failing.
3. **The page script lives in a template literal.** An escape written one
   level short, `\n` for `\\n`, becomes a raw line break inside a string
   and the script does not parse. The page test checks parsing first and
   names this cause.
4. **Never exercise the real backend switch.** It writes the user's
   Claude settings. The suite compares that file before and after.
5. **Do not call the usage endpoint in a loop.** It rate-limits. The live
   check treats a rate limit as a skip.
6. **Kill test processes by name, not by pattern.** A pattern that
   appears in the command that runs it matches that command's own shell.
7. **Anchor time-dependent tests to local noon.** "Today" is a local
   notion, and a fixed UTC instant lands on different days.
8. **A stand-in must behave like the real thing.** A stand-in server that
   answered requests concurrently produced failures the real server
   cannot.
9. **Point the tests at a gateway file of their own.** The default path
   is a real file on the developer's machine; a host test read it and
   found a gateway on offer that the test had not made. The stub now
   names a path that does not exist, and the gateway tests write their
   own file in a throwaway directory.
10. **Probe the CLI from a clean environment.** A probe run from inside a
    Claude Code session inherits its variables (`CLAUDECODE`,
    `CLAUDE_CODE_CHILD_SESSION`, its effort), and the CLI it started
    answered `supportedModels()` without the `default` entry, which
    looked like a finding about the SDK. Probes now run under `env -i`
    with only `HOME`, `PATH`, `USER` and `LANG`.

---

<a id="n115"></a>

## 115 — Verified and not verified

### Verified against real services, on the development machine

| Claim | Evidence |
| --- | --- |
| Both agents run on existing logins | Live harness, every run |
| Claude's permission callback | A `Write` prompted, was allowed, and wrote the file |
| Live effort change | Started at low, switched to medium, completed a turn |
| Context usage and slash commands | 3% of a 1M window; 69 to 70 commands |
| Claude queueing | Two messages sent together answered in order, idle once |
| Claude's idle word | `session_state_changed` running/idle arrives when `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` is in the CLI's environment; without it the SDK has the CLI mark it host-only and swallows it (probed 2026-09-30; 6 state words over the harness run) |
| Claude catalog without a request | 11 models in about 0.5 s |
| The model a Claude session starts on, read without a request | SDK 0.3.284's CLI on Bedrock, idle, in a clean environment (2026-10-15): `getContextUsage({ detail: 'summary' })` gave the start model's id. With `ANTHROPIC_MODEL` set to Sonnet 4.6, the catalog named the default Sonnet 4.6, efforts low to max with no `xhigh`, in 712 ms; with the settings' `model` set to Fable, as on the desktop, Fable, in 694 ms. With either, and with neither, the SDK's `default` entry was the built-in Opus 5.5 |
| Default in a running Claude session is the built-in default | The same CLI (2026-10-15): started on `ANTHROPIC_MODEL`, on the settings' `model`, and on neither, `setModel(undefined)` then reported Opus 5.5 each time. One request after it, from a start on Haiku 4.5: `init` and the answer both Opus 5.5, $0.07 |
| Codex usage, fresh after a turn | A reading zero to one second old |
| Claude usage response shape | Parsed three limits from a live response |
| The usage endpoint rate-limits | Observed HTTP 429 |
| Whisper on the GPU | 11 s of speech in 0.3 s, transcribed exactly |
| Whisper resampling, silence, CPU fallback | 48 kHz input; empty result for silence; `small` on CPU in 1.9 s |
| The recorder library loads and opens a device | Captured frames |
| Unplugged-jack detection | This machine's input reported `unplugged` |
| Dictation end to end | Messages dictated into a tab by the user, 2026-09-30 |
| System prompt size, SDK default against Claude Code's | 15,226 and 21,581 tokens written to the cache on a first turn (2026-09-30) |
| Images reach both agents | A solid red 64×64 PNG; both answered "Red" |
| A Claude question round trip | Claude asked "Which colour do you prefer?", perch answered "Blue", Claude replied "You chose Blue" |
| Renaming a Claude session | On a copy of a real session in a temporary config directory: the custom title was written and read back |
| Reading real records | 23 sessions listed for a folder; transcripts of 86 and 169 entries read |
| A Codex model switch is accepted | A thread on `gpt-5.5` was taken up on `gpt-5.6-luna`; Codex noted the change. The turn itself was refused by a usage limit |
| The packaged extension runs | From the unpacked `.vsix`, Claude answered through the Claude Code extension's program |
| The environment's token wins over the login | With an OAuth login in `~/.claude`, `claude -p` run with `ANTHROPIC_BASE_URL` pointing at a local listener and `ANTHROPIC_AUTH_TOKEN=probe-…` sent `Authorization: Bearer probe-…` to the listener's `/v1/messages`, no `x-api-key`, and nothing to Anthropic (2026-10-01, Claude Code 2.1.119). This is what lets a gateway tab share `~/.claude` with the others |
| The gateway names the deployment in a header, not the body | Direct calls to a LiteLLM gateway with a routed model name answered with the deployment's model or the alias in the body and the deployment in `x-litellm-model-name` in the headers, with `x-litellm-attempted-fallbacks`; through Claude Code the body says the alias. LiteLLM 1.102.0, 2026-10-01 |
| Claude Code through the relay | The real Agent SDK, `ANTHROPIC_BASE_URL` on the relay, the relay on the gateway: a turn streamed and answered in 4.5 s; the relay saw `/api/hello` (302, no model) and `/v1/messages?beta=true` (200, `global.openai.gpt-6-luna`) (2026-10-01) |
| Installation from the marketplace, and under Remote-SSH | Perch 0.6.1 through 0.6.37 and Perch Audio 0.1.0 through 0.3.5 published; installed on a CPU-only JupyterHub container over Remote-SSH and used there daily since 2026-09-30, with Perch Audio on the desktop recording for it |
| A Bluetooth headset as the microphone | Galaxy Buds Live, in A2DP with no source: switched to `headset-head-unit-msbc`, the source "Galaxy Buds Live (0310)" appeared in about a second, recorded, switched back (2026-09-30). The user found a condenser microphone clearer and kept it |
| Codex without a sandbox where the kernel forbids user namespaces | On such a container `bwrap` failed every command and `features.use_legacy_landlock` panicked; `danger-full-access` ran `echo` and `uname` through one `codex exec` (2026-09-30) |
| Codex's device-code login, as far as ChatGPT allows it | `codex login --device-auth` printed the link and code on the container; ChatGPT's consent page then asked for a setting the account could not turn on. The user's own login was copied to the container instead (2026-09-30) |
| A LiteLLM gateway is Anthropic-compatible | One serving `/v1/messages`: Claude Code, which speaks nothing else, runs through it (the relay row above) |
| A streamed response carries no price from the gateway | The same `Reply with ok` to a LiteLLM gateway twice (2026-10-02): unstreamed, `x-litellm-response-cost` and the parts; streamed, no `x-litellm-response-cost`, the parts at `0.0`. Both carried `x-litellm-model-name`, `x-litellm-call-id` and `x-litellm-key-spend`; the proxy said `x-litellm-version: 1.102.0`. The management routes (`/model/info`, `/key/info`, `/spend/logs`) answered 401 to the token: no price catalog or after-the-fact lookup from the client |
| LiteLLM's public table names the gateway's deployments | `xai/grok-4.6`, `gpt-6-luna` and `openai.gpt-6-luna`, `claude-opus-5-5` and the Bedrock spellings are all entries (4,453 entries, 3 MB, 2026-10-02) |
| A gateway tab under a `settings.json` that forces Bedrock | In a throwaway `CLAUDE_CONFIG_DIR` whose settings set `CLAUDE_CODE_USE_BEDROCK=1` and a Bedrock `ANTHROPIC_MODEL`, with a stand-in gateway on the loopback (2026-10-05): the gateway's variables in the environment alone, nothing reached the gateway (the CLI went to Bedrock); with `--settings '{"env":{"CLAUDE_CODE_USE_BEDROCK":"0"}}'` the CLI's request arrived at `/v1/messages`; through the Agent SDK with `gatewaySettings(...)`, it arrived with the file's model and the token |
| The gateway on a machine pinned to Bedrock, first run to first answer | A remote container (2026-10-05): `CLAUDE_CODE_USE_BEDROCK=1` in both `~/.claude/settings.json` and the container's environment, a Bedrock `ANTHROPIC_MODEL` exported, no gateway file. A tab put on the gateway held its message with the note and its two buttons; the file was made from the template, then filled; the next message was answered through the gateway (a `via` line, the file's model on the model button, cache pill 60m), the window's Bedrock tabs untouched |
| Deleting a session, by each agent's own means | Two sessions made for the purpose in a temporary folder (2026-10-05): a Claude one, listed by the SDK before `deleteSession` and not after (`getSessionInfo` then answers nothing); a Codex one, whose rollout was there before `codex delete --force` and gone after |
| A streamed response's token counts arrive at its end | One streamed request to a LiteLLM gateway (2026-10-05): `message_start` usage `input 0, output 0, cache 0`; `message_delta` usage `input 9, output 17`. On a remote container the estimate taken at the start had read ≈$0.0000 for a turn whose record shows 92,842 tokens written |
| What Codex's cache is worth on Luna through Bedrock | A five-turn session on `us.openai.gpt-6-luna` through the runtime endpoint (2026-10-06): read README and design, four questions on them. 401 K input tokens in all, of which 352,575 read from the cache, 48,424 written, 22 sent fresh; 4,474 out. As billed at Bedrock's list prices $0.0130; the same tokens with no cache $0.0466: 72 % less. The hits are within a turn as much as between turns: the first turn, a dozen file reads, already read 61,679 tokens from the cache of its own earlier steps |
| The runtime endpoint's extra tokens were the connector apps | Requests captured against a stand-in endpoint (2026-10-06): runtime with `us.openai.gpt-6-luna` 236 KB, 25 tools (218 KB: `mcp__codex_apps__chatgpt_space` 62 KB, `sites` 41 KB, `gmail` 33 KB, `google_calendar` 18 KB, …, `multi_agent_v1` 10 KB); Mantle with `openai.gpt-6-luna` 51 KB, 16 tools (27 KB, `tool_search` among them); instructions 18 KB and the three input items identical. Of five overrides tried, only `features.apps=false` changed anything: 44 KB, 11 tools. Real turns with it: runtime 7,914 in, Mantle 9,220 in, both `ok` |
| Codex on Amazon Bedrock | `codex exec` with the built-in provider and the user's AWS profile (2026-10-06): Mantle in us-east-1 with `openai.gpt-6-luna` answered (12,412 in, 5 out); the runtime endpoint in us-west-2 with `us.openai.gpt-6-luna` answered (37,536 in); Mantle in us-west-2 was 404 for every spelling; the runtime endpoint refused `openai.gpt-6-luna` without the cross-region prefix. Then one turn through perch's `CodexAgent` with the Bedrock options and no model chosen: `ok`, the model sent as `openai.gpt-6-luna` |
| Codex's prompt cache holds on Bedrock | Three one-line turns in one thread on Bedrock Mantle, GPT-6 Luna (2026-10-06), Codex's cumulative usage: input 12,438 / 24,894 / 37,425, cache reads 0 / 12,396 / 24,810, so each turn after the first read its whole prefix from the cache and wrote only its own ~12.4 K (the system instructions and tools; a turn's own text is a few hundred). The same three turns on the ChatGPT backend: input 14,508 / 29,511 / 44,542, cache reads 11,008 / 25,088 / 36,096 (the first turn already hit a shared prefix), no writes reported on the plan. So Bedrock Mantle carries OpenAI's prompt caching through: automatic prefix caching within a thread, and the usage in OpenAI's shape (`cached_input_tokens`, `cache_write_input_tokens`, so writes billed the GPT-5.6 way). Two differences: no cross-thread hit on a first turn (identical runs 15–20 minutes earlier had cached nothing reusable: the cache is scoped by `prompt_cache_key`, which Codex sets to the thread id, or its lifetime is shorter than OpenAI's 30 minutes), and no published TTL |
| Codex in a multi-root VS Code workspace | An eleven-folder workspace (2026-10-07): after Perch passed the ten secondary roots as SDK `additionalDirectories`, a new Codex session in **Workspace** mode reported every folder as a writable workspace root, including `/git/ai-assistant`; the offline host test also verifies deduplication and the real agent's SDK options |
| A revoked Codex login, as `codex exec` reports it | The desktop's login, a copy of which had been put on a remote container by hand on 2026-09-30, failed on 2026-10-12 15:54 UTC, five minutes after the container refreshed its copy (15:49): `codex exec` (0.159) wrote ten JSON errors `Reconnecting... n/5 (workspace routing discovery unauthorized (401))` and `turn.failed` with the same, and in its log `auth error code: token_revoked` and `TokenErrorDetail { error_code: Some("refresh_token_invalidated"), error_message: Some("Your session has ended. Please log in again.") }`; `auth.json` was not rewritten by the failed attempt. `codexAuth.refused` takes all of them; the container's copy went on working |
| A ChatGPT plugin installed for Perch's Codex, and its connect link | A remote container (2026-10-09), with the binary perch runs there (the ChatGPT extension's `codex-cli 0.162.0-alpha.17.2`): `codex plugin add sharepoint@openai-curated-remote --json` installed version 0.1.8, `authPolicy: ON_INSTALL`, with no prompt and no change to `config.toml`; `codex plugin list` then said *installed, enabled*. The next `codex exec` had `microsoft_sharepoint.search` and called it on a SharePoint site; it answered `connector_1e4f6a44acf14e3ca1d96672f8c945bc is not connected` (`USER_NOT_LOGGED_IN`) with `_meta._codex_apps.connector_auth_failure` `{auth_reason: missing_link, install_url: https://chatgpt.com/plugins/plugin_connector_1e4f6a44acf14e3ca1d96672f8c945bc}`; the model reported that no link was given |
| A queued Claude message taken back by Claude Code | The vendor extension's Claude Code (2.1.295) on Haiku (2026-10-09): a message queued 2.5 s into a long first turn and handed over, then `cancelAsyncMessage` 0.6 s later: `{cancelled: true}`, and the session had one turn and one result. Left queued instead, it ran, and the turn that took it up was stamped with its uuid. Cancelled after a short first turn had ended: `{cancelled: false}`, and it ran: too late, as the tab says |
| Sub-agents and async questions read from a running Codex turn's file | The user's own thread (2026-10-09, 49.5 MB, two days): read back in 195 ms as 2,587 events with 365 sub-agent lines and 6 past questions, no collaboration call left as a tool call; a watch on the running turn said `desktop_local_conversation answered` and `desktop_audio_transport reported` as they were written. The record shapes were read from 127 session files: `SubAgentActivity` kinds started 42, interacted 366, completed 77, interrupted 2; reports to `/root` MESSAGE 224, FINAL_ANSWER 76; seven async questions, all answered `{"accepted":true}` by Codex itself |
| Each sub-agent's model and tokens from its own thread file | The same thread on 2026-10-12 (77 MB, five days, 74 sub-agent threads of 0.2–8.7 MB): read back in 822 ms as 3,892 events with 759 sub-agent lines; every one of its 146 end lines was given `info` for the turn it ended in (133 on `gpt-6.1-sol`, 13 on `gpt-5.6-sol`: the parent was moved from one to the other on 2026-10-08, and each sub-agent kept the model it started on), the last, `capture_failure_diagnosis` (Lagrange), at 2 turns, 2.1 M input nearly all cached, 5.6 k output; read over its whole life, as the first version did, the same line said 17 turns and 14.4 M. The turn of 16:30 that day, whose foot said `…` for that sub-agent (started 2026-10-09, given a follow-up), was replayed through the watch from its root file: found by the follow-up's `interacted`, said as `gpt-6.1-sol` · ultra, 1 turn, 485 k input, 1.3 k output. The three record shapes (`turn_context` model/effort, `token_usage_record` usage, `session_meta` agent_nickname/parent_thread_id/agent_path) were read from those 74 files and the root's; one sub-agent spawned 29 s after the parent's model change held 30 token-less `turn_context` records on the old model before its real turns on the new, which the table shows as both. Not yet seen in a running perch turn after that fix |
| A Codex session's usage, thread by thread | The user's thread on 2026-10-12 (95 MB, its 76 sub-agents' files all found): read in 0.9 s. The main thread 207 turns (226 context records: 21 turns recorded theirs twice), on `gpt-5.6-sol` for 95 and `gpt-6.1-sol` for 112; at LiteLLM's list prices fetched that day (`gpt-6.1-sol` $2, $0.10 cached, $10 out per million; `gpt-5.6-sol` $4, $0.40, $20), ≈$82.46, and the sub-agents ≈$58.79, 42 % of ≈$141.26. 65 of its first 74 sub-agents were forked: 390 copied contexts against 161 of their own, and none of their 2,121 token records named another thread. `inference_adapters` showed 17 turns before the fix and 10 after; `mic_research` 2 and 1 |
| A web search as `codex exec` reports it | `codex-cli 0.159.0`, the binary the SDK carries, on `gpt-6.1-sol` in code mode (2026-10-12), asked to search, open the page found, and look for a phrase in it: three `web_search` items, each `item.started` with `query: ""` and `action: {type: "other"}`, and `item.completed` with `{type: "search", query}` and 12 results; `other` with an empty query and the page as its one result; `{type: "find_in_page", url, pattern}` and the page. Each result: `type`, `domain`, `ref_id`, `snippet`, `title`, `url` (and `thumbnail_url` for a page). The rollout file spells the last `findInPage` and gives a search's `queries` |
| What Claude Code sends through a gateway, with and without the hour flag | A stand-in gateway on the loopback read the bodies: with the gateway file as it is, `cache_control.ttl` is `1h` on every cached block; with `ENABLE_PROMPT_CACHING_1H` unset, no `ttl` at all (2026-10-02). A real turn through a LiteLLM gateway with the flag answered (22,306 tokens written); its usage carried a zeroed `cache_creation` breakdown, so the route accepts the field; whether the hour took upstream is not visible from the client (the `total_cost_usd` of that run was Claude Code's own reckoning, Opus-class list prices at the five-minute write rate for a model name it does not know, not the gateway's figure) |

### Not verified

| Claim | Why not |
| --- | --- |
| **Anything under Remote-SSH** | Not run in a remote window. The design follows VS Code's documented extension-kind model |
| **perch-audio on macOS or Windows** | Prebuilt binaries ship for both. Not run |
| **Microphone permission prompts** | No device to trigger one |
| **The page in a real webview** | Tested in jsdom, which does not lay out or paint. Visual defects have been found by eye and fixed |
| **Editor-tab restoration in VS Code** | The serializer is tested against a stub |
| **Codex cache reuse across `exec` processes** | Inferred from the design and the `cached_input_tokens` figures; the SDK exposes no cache key |
| **Group locking, the sessions list, and the question card in a live window** | Tested against stubs and jsdom |
| **The browser sign-in for Codex over Remote-SSH** | The port-forwarded return trip (`asExternalUri` on `localhost:1455`) is tested against stubs; the remote container was already logged in when it was built |
| **The gateway's model menu and the sticky default in a live window** | Tested against stubs; the file's names are read, not asked of the gateway |
| **A second gateway** | One file, one gateway. A list of gateways in settings is the natural extension when one is needed |

---

<a id="n116"></a>

## 116 — Limitations and open work

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
| A gateway tab is told apart in the footer, not the tab bar | By choice ([note 111](110-features.md#n111)): the tab is Claude's. A small `gw` mark on the title would be the cheap remedy if wanted |
| Backend switch under a gateway pinned in `settings.json` | Fixed in 0.6.55: see *Backend-correct tabs* below |

### Backend-correct tabs (0.6.55): subscription / gateway / API first-class

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
