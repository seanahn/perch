# 108 — The agents

Both agent modules take an `emit` callback and know nothing of VS Code.
They translate the vendor's events into the kinds above.

## Claude

| Aspect | How |
| --- | --- |
| Process | One CLI process per tab, in **streaming-input** mode: `query({ prompt: asyncIterable })` |
| Why one process | Every turn shares the same prompt cache and context |
| Permissions | `canUseTool` calls back on each tool use. The page shows the prompt. "Always" returns the SDK's own suggestions as `updatedPermissions` |
| Mode, model, effort | Live, on the running session: `setPermissionMode`, `setModel`, `applyFlagSettings({ effortLevel })` |
| Queueing | A message sent mid-turn is pushed with `priority: 'next'` and a `uuid` of perch's. Claude Code queues it. Taken back with `cancel_async_message` by that uuid (`query.cancelAsyncMessage`, implemented in the Agent SDK though this version does not declare it; Claude Code answers whether it still had it), or out of perch's own input stream if not yet handed over. Claude Code stamps the uuids a turn takes up (`user_message_uuids`) on the turn's first messages, which is when a bubble stops being queued |
| Context usage | `getContextUsage()` after each turn |
| Slash commands | `supportedCommands()` |
| Stop | `interrupt()` |
| Settings | All sources are loaded, the SDK's default, so the user's `~/.claude/settings.json` applies |
| Environment | The extension host's, plus, for a tab on the gateway, the variables of the user's gateway file (`src/gateway.js`) with `CLAUDE_CODE_USE_BEDROCK=0` unless the file says otherwise; and the same variables, the token left out and the base URL the relay's, as the process's own settings (the SDK's `settings`, Claude Code's `--settings`), which Claude Code applies over `~/.claude/settings.json`. Without that a window set to API / Bedrock there sends the tab to Bedrock whatever its environment says, since the settings' `env` block is applied over the environment |
| Relay | On the gateway, `ANTHROPIC_BASE_URL` is a loopback port of perch's (`src/relay.js`), one per process, started before the CLI and stopped with it. Every request is forwarded to the gateway as it came, path prefix kept, token included, and the response streamed back byte for byte; the relay only reads the gateway's `x-litellm-*` headers, which name the deployment that answered. Nothing a model sees changes. A gateway that sets no such header is relayed the same and reports nothing |
| System prompt | The SDK's default, not Claude Code's full prompt: about 6,400 tokens smaller ([note 103](103-token-economy.md)) |
| Questions | `AskUserQuestion` arrives through `canUseTool`; the answers go back as `updatedInput.answers` |
| Images | Pasted images go as base64 `image` blocks before the text |

Claude Code auto-approves a set of read-only shell commands such as
`echo` without prompting. That is the agent's behaviour, not a gap in
perch. A `Write` prompts every time in default mode.

## Codex

| Aspect | How |
| --- | --- |
| Process | The SDK wraps `codex exec`: one process per turn, one thread across turns |
| Approvals | **By policy, not by prompt.** `codex exec` is non-interactive. `perch.codex.approvalPolicy` and the sandbox decide |
| Model, effort, sandbox | Changed from the next turn: the thread is taken up again (`resumeThread`) with the new options. Codex compacts once and notes the model change |
| Images | Written to a private temporary directory and passed as `local_image` inputs; removed with the agent |
| Queueing | One turn at a time, so **perch holds the queue** and drains it as each turn ends, without the tab flickering to idle. Each entry has an id; one taken back leaves the queue and its echo is no longer awaited (by place, not by words, since two queued messages may say the same) |
| IDE context | Attached by perch (below) |
| Stop | An `AbortSignal` on the turn |
| Web searches | The SDK's `web_search` item says nothing when it starts (an empty `query`, the action `other`) and everything when it completes: the action (`search` with its query or `queries`; `find_in_page` with the pattern and page; a page opened stays `other`, the page being the result) and the `results`, each with its title and address. The card is drawn at the start (`web search …`) and drawn again in place from the completion (`webInput`), with the pages found under it, eight at most (`webFound`); the foot says *Searching the web* in between. Reading only the start left `{"query": ""}` cards and a foot that said *Running web_search* for minutes after the searches ended (seen on 2026-10-12, in a turn whose last search had finished four minutes before) |
| Apps and plugins | Codex's own: `codex exec` loads the plugins installed in the ChatGPT account of its login (the `openai-curated-remote` marketplace, cached under `~/.codex/plugins/cache/`) and reaches their apps through ChatGPT's hosted `codex_apps` MCP server; installing is `codex plugin add <name>@<marketplace>` (or `/plugins` in the interactive CLI, or the ChatGPT apps), and the model's own plugin tools can search, suggest, and uninstall but not install. An app's connection (its OAuth, Microsoft's for SharePoint) is made on chatgpt.com and kept by ChatGPT. A call to an app that is not connected returns `connector_auth_failure` in the result's `_meta` with an `install_url`; neither the result's text nor the model sees it, so perch says it in a note with a **Connect on ChatGPT** button (`connectLink` in `src/codexAgent.js`, chatgpt.com links only, once a turn). Read-only use is Codex's config: `apps.<connector_id>.destructive_enabled = false` |
| Sub-agents and questions | Not in the SDK's stream, which carries agent messages, commands, file changes, MCP calls, reasoning, todo lists, web searches, and errors. The rest is in the thread's rollout file, so while a turn runs perch reads the lines it gains (`src/codexWatch.js`, from where the file ended when the turn began, or from its start for a new thread, about once a second, and once more before the turn is said to end) and translates them (`collabEvent` in `src/sessionStore.js`): `SubAgentActivity` items (started, interacted, completed, interrupted), a sub-agent's reports to `/root` (`agent_message`, MESSAGE as it goes and FINAL_ANSWER at the end of a task, their words encrypted, so only that a report came is shown), the root's `followup_task` and `wait_agent`, and `request_user_input_async`. The same translation reads them back into an earlier session's transcript, where the collaboration calls and their outputs (encrypted messages, `{"accepted":true}`) are no longer shown as tool calls. A turn's sub-agents end with its `codex exec` process. Each sub-agent is a thread of its own, with a rollout file of its own that every one of its activity records names (`agent_thread_id`), so one started in an earlier turn is found by this turn's follow-up (`interacted`). Seen on 2026-10-12, when only a start was read: a follow-up to a sub-agent started three days before left its row saying `…`. The watch reads that file too, from its start, for three records only (`turn_context`, the model and effort of each of its turns; `token_usage_record`, what each cost; `session_meta`, the nickname Codex gives it), tallied in `UsageTally` (`src/sessionStore.js`) and said as the sub-agent's `usage`: the model and effort of its latest turn whenever that was, and the turns and tokens of this turn only, those stamped from the watch's start on. The sub-agents' files are read before the root's on each poll, so a sub-agent's end finds its usage known. Read back later, `addSubagentUsage` gives each end line the same: the turn it ended in, from that turn's `task_started` to the end, so a sub-agent that ended in several turns shows each turn's model and cost and not its whole life. Each thread's file is read and parsed once, and the sessions tree walked once, for all of them. Seen on 2026-10-09: a thread's turn spawned three sub-agents that worked for 14 minutes while the tab showed only the root's last command, and an async question was never seen |
| Backends | Three, perch's own choice (`perch.codex.backend` in global state), given per process so a tab moves on its next turn: the ChatGPT login (nothing given); an OpenAI API key (`CODEX_API_KEY`, from VS Code's secret storage); Amazon Bedrock (`--config` overrides through the SDK's `config`: `model_provider` and `model_providers.<provider>.aws.{region,profile}`, `src/codexBedrock.js`). Codex 0.159 has the Bedrock provider built in, in two forms: `amazon-bedrock`, the Bedrock Mantle endpoint (`bedrock-mantle.<region>.api.aws/openai/v1`), and `amazon-bedrock-runtime`, the runtime's OpenAI-compatible endpoint; both sign with the AWS credential chain (profile, `AWS_*`, `AWS_BEARER_TOKEN_BEDROCK`). On Bedrock a model goes by its Bedrock id: `openai.<slug>` on Mantle, `us.openai.<slug>` on the runtime endpoint (on-demand throughput there wants a cross-region inference profile; `openai.gpt-6-luna` alone is refused), and a tab with no model of its own sends the catalog's default slug in that form, since Codex's own default (`config.toml`) is not a Bedrock name. The ChatGPT connector apps (`features.apps`: Gmail, Calendar, ChatGPT spaces and the rest) are turned off for a Bedrock process: they are features of a ChatGPT account and cannot work there, and for a model Codex's catalog does not know by its cross-region id Codex sends every one of their schemas in full with each request (captured 2026-10-06 against a stand-in endpoint: 236 KB a request with 25 tools on the runtime endpoint, 44 KB with 11 once the apps are off; Mantle with its recognised id and the apps on, 51 KB with `tool_search` deferring them). Measured with GPT-6 Luna and a one-line prompt, apps off: the runtime endpoint 7.9 K input tokens a request, Mantle 9.2 K (with the apps on they had been 37.5 K and 12.4 K). So the runtime endpoint is the default: every Bedrock region, the `bedrock:*` actions a machine on Claude-on-Bedrock already has, and the leaner request; Mantle is the setting, wants its own IAM action (`bedrock-mantle:CreateInference` on a project resource, which a key for Claude on Bedrock may lack) and is not in every region (us-west-2 answered 404 for every model), so its region defaults to us-east-1 while the runtime endpoint follows the machine's. A thread cannot cross between OpenAI and Bedrock: its reasoning items are `encrypted_content`, encrypted for the provider that made them, and the other refuses them (`invalid_encrypted_content`, seen 2026-10-06 when a ChatGPT thread was resumed on Bedrock). So a switch across providers starts a new thread with the next message, said in a note, and a thread resumed from the sessions list on the other provider is started over once and the message sent again; the old thread stays on record. ChatGPT and the API key are the same provider, and a thread goes on between them |

## IDE context

On both kinds of tab; on by default for new tabs (`perch.ideContext`), and
kept per tab. When on, a message carries the active file and, if there is
one, the selection:

````
why is b 2?

<ide_context>
Active file: src/a.js (javascript)
Selection: lines 3-4
```javascript
const a = 1;
const b = 2;
```
</ide_context>
````

- The transcript shows the message and a tag, `IDE context · src/a.js:3-4`,
  not the attachment.
- It is read **when the message is written**, so a queued message keeps
  the file that was open then.
- A selection over 12000 characters is cut, and says so.
- The code fence is made longer than any run of backticks inside.
- Unsaved and non-file editors attach nothing.
