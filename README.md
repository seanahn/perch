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

## Model and effort

Each tab's status bar shows its state (idle, working, ready) and a
one-line summary such as `Opus 5.5 · high · default`. Press the **gear**
to show the selectors: **model**, **effort**, and **mode** (Claude) or
**sandbox** (Codex). They are hidden by default, one switch covers every
tab, and the choice is remembered.

The lists come from the agents themselves, so they match your account:

| | Models from | Efforts from | Default labels |
| --- | --- | --- | --- |
| Claude | the Claude Code CLI, asked at startup without sending a message | each model's supported levels | `default · Opus 5.5` names the model the default resolves to |
| Codex | `~/.codex/models_cache.json` | each model's supported levels | `default · GPT-5.6-Sol` and `default · ultra` come from `~/.codex/config.toml` |

The effort list follows the selected model. A model with no effort
control disables the selector, and an effort the new model does not
accept resets to default. `Perch: Refresh Model Lists` re-reads both.

Claude: model, effort, and mode all change live, from the next message.
Hover the model selector to see the model actually running.

Codex: a thread keeps the model, effort, and sandbox it started with, so
choose them before the first message. Changing one later tells you it
applies to a new tab. Hover the sandbox selector for the approval policy.

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
