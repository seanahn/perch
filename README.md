# perch

Claude Code and Codex side by side in one VS Code sidebar.

perch is a **shell, not an agent**. Each panel spawns the vendor's own
agent through its SDK, so prompt caching, context compaction,
permissions, memory, and tool behavior are the vendor's, unchanged. perch
only renders the event stream and forwards your input. Continue and
similar harnesses replace the agent; perch keeps it.

| Panel | Agent | How it runs | Auth |
| --- | --- | --- | --- |
| Claude | Claude Code | `@anthropic-ai/claude-agent-sdk`, streaming input, `canUseTool` for permission prompts | your existing `claude` login |
| Codex | Codex | `@openai/codex-sdk`, which bundles the `codex` binary | your existing `codex` login |

Two agents, two contexts. They do not share history. The two handoff
commands paste one agent's last answer into the other's input box, which
is the only bridge, on purpose: shared context would defeat each agent's
caching.

## Install

```
make install     # npm install, syntax check, symlink into the extension dirs
```

Reload the window. Both views appear under the Perch icon in the activity
bar. Drag one into the secondary sidebar to see them side by side.

## Permissions

Claude: the SDK calls back on every tool use and perch shows Allow /
Always / Deny. Mode is in settings (`perch.claude.permissionMode`) and
switchable per session from the panel.

Codex: the SDK runs `codex exec`, which is non-interactive. Approvals
resolve by policy (`perch.codex.approvalPolicy`) and the sandbox
(`perch.codex.sandboxMode`). There is no per-command prompt.

## Cost

Both agents run on your subscriptions through their normal logins. This
is for personal use on your own machine. Shipping it to other people
would require API-key billing under both vendors' terms.

## Layout

- `src/extension.js` — activation, two `WebviewViewProvider`s, commands
- `src/claudeAgent.js` — Claude Agent SDK session, no VS Code dependency
- `src/codexAgent.js` — Codex SDK thread, no VS Code dependency
- `src/webview.js` — the panel HTML and script
- `test/harness.mjs` — runs one turn through each agent headlessly
