# perch

Claude Code and Codex as tabs in one VS Code sidebar. Any number of sessions.

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

## Cost

Both agents run on your subscriptions through their normal logins. This
is for personal use on your own machine. Shipping it to other people
would require API-key billing under both vendors' terms.

## Layout

- `src/extension.js` — the view, sessions, tab state, persistence, commands
- `src/claudeAgent.js` — Claude Agent SDK session, no VS Code dependency
- `src/codexAgent.js` — Codex SDK thread, no VS Code dependency
- `src/webview.js` — the page: tab bar, per-tab panes, compose box
- `test/host.test.js` — host logic against a stubbed VS Code API, no model calls
- `test/page.test.js` — the real page script in a DOM, no model calls
- `test/harness.mjs` — one live turn through each agent, uses your logins

`make test-offline` runs the first two. `make test` runs all three.
