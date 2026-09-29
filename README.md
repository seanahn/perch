# perch

Claude Code and Codex as tabs in one VS Code sidebar. Any number of sessions,
with Claude usage and backend switching built in.

perch is a **shell, not an agent**. Each tab spawns the vendor's own
agent through its SDK, so prompt caching, context compaction,
permissions, memory, and tool behavior are the vendor's, unchanged. perch
only renders the event stream and forwards your input. Continue and
similar harnesses replace the agent; perch keeps it.

| Tab kind | Agent | How it runs | Auth |
| --- | --- | --- | --- |
| Claude | Claude Code | `@anthropic-ai/claude-agent-sdk`, streaming input, `canUseTool` for permission prompts | your existing `claude` login |
| Codex | Codex | `@openai/codex-sdk`, which bundles the `codex` binary | your existing `codex` login |

## Tabs

Press **+** to open a Claude or a Codex tab. Each tab is its own session
with its own agent process, context, mode, draft, and transcript. Open as
many as you like of either kind. A tab is titled from its first message.
A dot on a tab means it is working; a red dot means it is waiting on a
permission prompt. Middle-click or × closes a tab and stops its agent.

Tab icons are the vendors' own, read at runtime from the Claude Code and
ChatGPT extensions if they are installed. perch ships no logos. It uses
each extension's glyph, tinted as the vendor tints it on its own tabs:
Claude's spark in orange, the ChatGPT blossom in the theme's text colour.
Without a glyph it uses the marketplace image, and without the extension
a letter, C or X.

Agents start lazily: an open tab costs nothing until you send a message.

Tabs survive a window reload. perch saves each tab's session id and the
agent resumes its own saved conversation on the next message. The earlier
transcript is not redrawn; the agent still has it.

Tabs do not share history. **Hand off** (the swap icon in the view title,
or `Perch: Hand Off Last Answer to Another Tab…`) pastes the active tab's
last answer into another tab's input box, or into a new tab. That is the
only bridge, on purpose: shared context would defeat each agent's caching.

## Install

```
make install     # npm install, syntax check, symlink into the extension dirs
```

Reload the window and click the Perch icon in the activity bar. Drag the
view into the secondary sidebar to keep it beside the editor.

## Permissions

Claude: the SDK calls back on every tool use and perch shows Allow /
Always / Deny. The default mode for new tabs is a setting
(`perch.claude.permissionMode`) and each tab can switch live.

Codex: the SDK runs `codex exec`, which is non-interactive. Approvals
resolve by policy (`perch.codex.approvalPolicy`) and the sandbox
(`perch.codex.sandboxMode`). There is no per-command prompt. A Codex
thread keeps the sandbox it started with, so choose it before the first
message.

## The composer

Each kind of tab takes its own vendor's look, so a Claude tab feels like
Claude Code and a Codex tab like Codex.

**Claude tab**, left to right:

| Tool | What it does |
| --- | --- |
| **+** | Pick files and mention them by path, as `@src/a.js`. |
| **/** | Slash commands, read from Claude Code. Typing `/` opens the same list, filtered as you type; Enter completes. |
| ring | How full the context window is. Amber at 80%, red at 95%. |
| clock | Minutes until the prompt cache goes cold. A message sent before then is billed at the cached rate. One hour on a subscription, five minutes on API or Bedrock, unless you set `promptCacheTtl`. |
| pill | Model and effort. Opens a menu for both. |
| bolt | Permission mode: Ask, Edits, Plan, Auto, Bypass. |
| square | Send. While Claude is working it becomes Stop. |

**Codex tab**: **+**, then the sandbox behind a shield (Read only, Workspace,
Full access, the last in amber), the model with its effort, **IDE context**,
and a round send button. "Work locally" sits beneath, because perch runs
Codex on this machine through the SDK.

**IDE context** is off by default and remembered per tab. When on, each
message carries the active file and, if there is one, the selection with
its line numbers. The transcript shows your message and a tag naming what
was attached, not the attachment itself. The context is read when you
write the message, so a queued message keeps the file that was open then.

**Queueing.** Enter always sends. While the agent is working, the message
is queued behind the current turn and marked so. Claude Code queues it
itself; Codex takes one turn at a time, so perch holds the queue and feeds
it as each turn ends. Stop ends the turn and drops what is queued.

Not included: Codex's microphone. A webview cannot open the microphone;
Codex does it with a companion extension that records natively. perch could
do the same, but dictation also needs a speech-to-text service, which is a
choice for you to make.

## Model and effort

The model and effort menu opens from the pill (Claude) or the model name
(Codex).

The lists come from the agents themselves, so they match your account:

| | Models from | Efforts from | Default labels |
| --- | --- | --- | --- |
| Claude | the Claude Code CLI, asked at startup without sending a message | each model's supported levels | `default · Opus 5.5` names the model the default resolves to |
| Codex | `~/.codex/models_cache.json` | each model's supported levels | `default · GPT-5.6-Sol` and `default · ultra` come from `~/.codex/config.toml` |

The effort list follows the selected model. A model with no effort
control says so in the menu, and an effort the new model does not accept
resets to default. `Perch: Refresh Model Lists` re-reads both.

Claude: model, effort, and mode all change live, from the next message.
Hover the model selector to see the model actually running.

Codex: a thread keeps the model, effort, and sandbox it started with, so
choose them before the first message. Once it has started, the menus show
the current choices and say why they cannot change. The sandbox menu also
shows the approval policy.

Defaults for new tabs: `perch.claude.model`, `perch.claude.effort`,
`perch.claude.permissionMode`, `perch.codex.model`,
`perch.codex.reasoningEffort`, `perch.codex.sandboxMode`.

## Claude usage and backend

The footer of the panel shows, for Claude:

- a **backend switch**, `sub` or `API`. Click it to move new Claude tabs
  and sessions between your subscription login and API / Bedrock. It
  writes `env.CLAUDE_CODE_USE_BEDROCK` in `~/.claude/settings.json` and
  leaves the rest of the file alone. Running tabs keep the backend they
  started on, and are told so.
- a **usage gauge**. On a subscription: percent remaining and time to
  reset for the 5-hour session, the week, and any model-scoped weekly
  limit, amber or red when one runs low. On API / Bedrock: the model in
  use and today's tokens and estimated cost, from the local transcripts.
  Click to refresh. Hover for detail.

This is [AI Meter](https://github.com/seanahn/ai-meter) merged into perch.
perch also provides AI Meter's two status bar items, but stands down while
the standalone extension is installed, so the gauge is never shown twice.
Uninstall AI Meter and perch takes over the status bar on its own. Set
`perch.meter.statusBar` to `on` or `off` to decide yourself.

Privacy is unchanged from AI Meter. Subscription mode reads the OAuth token
Claude Code stores and sends it only to `api.anthropic.com/api/oauth/usage`.
Cost mode makes no network requests. Costs are estimates at Anthropic list
prices; Bedrock or partner billing may differ.

Switching models pins: a Bedrock model id saved in the settings file is
set aside when you switch to subscription, which cannot use it, and put
back when you switch to API. A settings file that is not valid JSON is
never overwritten; perch tells you instead.

The usage endpoint rate-limits. When it does, perch keeps the last reading,
marks it stale in the tooltip, and leaves the endpoint alone for at least a
minute, doubling up to half an hour. Clicking refresh during that pause
makes no request.

Settings: `perch.meter.mode`, `pollMinutes`, `display`, `showModelWeekly`,
`warnBelow`, `errorBelow`, `hideWhenUnavailable`, `statusBar`.

Codex has no equivalent gauge; the footer is about Claude only.

## Cost

Both agents run on your subscriptions through their normal logins. This
is for personal use on your own machine. Shipping it to other people
would require API-key billing under both vendors' terms.

## Layout

- `src/extension.js` — the view, sessions, tab state, persistence, commands
- `src/claudeAgent.js` — Claude Agent SDK session, no VS Code dependency
- `src/codexAgent.js` — Codex SDK thread, no VS Code dependency
- `src/models.js` — model catalogs read from the agents, no VS Code dependency
- `src/meter.js` — Claude usage, cost, and the backend switch, no VS Code dependency
- `src/meterHost.js` — polling, status bar items, login
- `src/webview.js` — the page: tab bar, per-tab panes, compose box
- `test/meter.test.js` — usage, cost, and the switch, against throwaway home directories
- `test/models.test.js` — catalog parsing, no model calls
- `test/host.test.js` — host logic against a stubbed VS Code API, no model calls
- `test/page.test.js` — the real page script in a DOM, no model calls
- `test/harness.mjs` — one live turn through each agent, uses your logins

`make test-offline` runs everything except the live harness. `make test` runs all of it.
