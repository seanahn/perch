# 107 — The page protocol

The page and the host exchange plain JSON with `postMessage`.

## Page to host

| Type | Fields | Meaning |
| --- | --- | --- |
| `ready` | | The page has loaded and wants a replay |
| `send` | `sid`, `text` | A message. Queued if the agent is working |
| `stop` | `sid` | Stop the turn and drop what is queued |
| `unqueue` | `sid`, `qid` | Take a queued message back (the × on its bubble) |
| `permission` | `sid`, `id`, `decision` | `allow`, `always`, or `deny` |
| `setModel`, `setEffort`, `setMode` | `sid`, `value` | A choice from a menu |
| `setIde` | `sid`, `value` | IDE context on or off |
| `setBackend` | `sid`, `value` | A Claude tab's backend from the footer's menu: `subscription` or `api` (the window's, through its switch), or `gateway` (this tab's) |
| `switchVendor` | `sid`, `kind`, `model`, `effort` | Continue the tab on the destination vendor. `effort: ""` means that model's default (a click on its model row); a contextual effort item sends its explicit value |
| `attach` | `sid` | Open the file picker for mentions |
| `new`, `close`, `activate` | `kind` (and `gateway` for a Claude tab on the gateway) or `sid` | Sidebar tab bar |
| `meterRefresh` | `vendor` | Re-read usage |
| `subagentUsage` | `sid` | Read a session's usage, thread by thread, Codex's or Claude's (the footer's **sub-agents**); asked again at a turn's end while the table is open |
| `indexStatus` | `sid` | Read codebase search's state: every folder of the workspace with its setting and its index (the footer's **index**, shown while the tab's `index` is true: a folder is open); asked again at a turn's end and every 5 s while the panel is open |
| `searchToggle` | `sid` | Turn codebase search on or off for the workspace: the setting where it is set (the workspace's settings if they have it, else the user's), without the command's message; answered with `indexStatus` |
| `searchFolder` | `sid`, `root`, `on` | Turn codebase search on or off for one folder, in its own settings (`.vscode/settings.json`, the WorkspaceFolder target); answered with `indexStatus` |
| `meterToggle`, `meterLogin` | | Claude backend switch, login |
| `voiceStart`, `voiceStop`, `voiceCancel` | `sid` | Dictation |

## Host to page

| Type | Fields | Meaning |
| --- | --- | --- |
| `tabs` | `tabs`, `active`, `single`, `gateway` | The sessions this page shows; a tab's `switchTo` names the destination vendor and each model's `efforts` and `defaultEffort`; `gateway` says where the gateway file is, whether it exists, and whether it is in order |
| `event` | `sid`, `ev` | One event for one session |
| `meter` | `meter`, `codex` | Claude usage, and ChatGPT plan usage |
| `indexStatus` | `sid`, `at`, `on`, `usable`, `folders`, and `meaning`, or `why`, `error` | The answer: `on` is the workspace's setting, `usable` whether a Python here can run the search; every folder its `name`, `root` and `on` (its own setting as it resolves) and, read from the indexes' files by `server.py --status` (nothing is built), `files`, `sections`, `vectors`, `built`, `updating`, `embedding`, `off`, `ignore`, `updated`; `meaning` says whether search by meaning is installed on the Python the server runs on; `why` when no folder is open or no Python can run it, `error` when the read failed |
| `subagentUsage` | `sid`, `at`, and `main`, `subagents`, `prices`, `backend`, or `error` | The answer: each thread's model, effort, turns, tokens, and `cost` at list prices (null, with `unpriced` naming the model, when the table has no price for one it ran on); a sub-agent's `name`, `thread`, `state`, `first`, `last`, and `missing` when its file is not found |
| `commands` | `kind`, `list` | Slash commands |

## Event kinds

| Kind | Recorded for replay | Shown as |
| --- | --- | --- |
| `user` | yes | A message bubble, tagged if queued or carrying IDE context. A queued one carries `qid`, and an × that sends `unqueue` |
| `dequeued` | no, the `user` it names is changed instead | A turn has taken a queued message up: its bubble is an ordinary one from then on (no ×, not marked queued), and so in what is replayed |
| `unqueued` | no, the `user` it names is removed instead | The answer to `unqueue`: `ok` and the bubble goes (`quiet` when Stop dropped it, the note saying how many); or not, `why` `taken` (its turn had started: an ordinary bubble, and a line saying so) or `unsupported` (a Claude Code that cannot be asked: still queued, without the ×) |
| `text`, `thinking` | yes | The agent's answer, its reasoning |
| `delta` | no | Streaming text in a live bubble |
| `tool_use`, `tool_result` | yes | A tool call with its result beneath. A `tool_use` with `update: true` is the same call said again in full (a Codex web search, on completing): its card is drawn again in place |
| `permission` | yes, becomes a `note` once answered | Allow, Always, Deny |
| `question` | yes, becomes `answered` | Claude's `AskUserQuestion`: choices as buttons, a line of your own, one answer for all. With `async: true`, a question Codex asked without waiting (`request_user_input_async`): the card says so, the tab does not wait on it, and the answers go as the next message (queued behind the turn); read back from an earlier session, it is an `answered` with `answers: null`, what was asked and no answer either way |
| `subagent` | yes, but `waiting` and `usage` are not | Codex: a sub-agent's `started`, `tasked` (a follow-up task), `reported`, `finished`, `interrupted`, a line each (`⤷ name started`); each read from an activity record carries the sub-agent's own `thread`; an end line carries `info`, what its own thread file said of it in the turn it ended in (model, effort, turns, tokens, nickname, every model when more than one), and says it after the words. `waiting`, the root waiting on its sub-agents, is said at the foot; `usage`, read from a sub-agent's own file, goes into the tab's `subagents` and is no line. The tab's `subagents` (working, finished, stopped, and each by name with its reports and its `info` fields once known) is at the foot while the turn runs: a count that opens to a table of them. The turn's `result` carries the same `subagents`, a count under the line that opens to the table |
| `result` | yes | Duration, tokens in, cached, out; through a gateway, `via`: the models that answered the turn's requests, each with a count, and `gatewayCost`, `gatewayCostSoFar`: the gateway's own figures, for the turn and the session; off the gateway, `answered` and `wanted`: the models that answered the turn, as each response named its own, when one is not the model meant ([note 109](109-model-catalogs.md)) |
| `note`, `error` | yes | A line in the transcript; a note with `level: 'warn'` in the warning colour (Claude Code's notice of a refusal fallback) |
| `status`, `busy` | latest value only | A working line at the foot of the transcript: what the agent is doing, for how long. A status that is not idle, working, or ready becomes a `note` |
| `fill`, `insert` | no, held as a draft if no page | Text into the message box |
| `voice` | no, re-sent on `ready` | The microphone's state |

Agents emit a few more that the host consumes and does not forward:
`session`, `model`, `context`, `responded`, `commands`, `relay` (one
response through the gateway: which model it came from, folded into the
next `result` as `via` and onto the tab as its last model), and
`fallback` (Claude Code retried a refused response on another model: a
`note`, and the tab's running model, [note 109](109-model-catalogs.md)).
