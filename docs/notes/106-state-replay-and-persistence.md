# 106 — State, replay, and persistence

## The host owns everything

VS Code destroys and recreates a webview whenever a view is moved
between sidebars, and again on reload. A page therefore cannot be trusted
to hold state. The host records every transcript event, the status, the
busy flag, pending permission prompts, and drafts that arrive for a page
that is not there. When a page announces `ready`, it is sent a replay.

This was learned from a bug: the first version announced "ready" once,
so a moved view showed "starting…" forever and lost its transcript.

**Rule:** any new state the page shows must be recorded in the host and
included in the replay, or it will be lost the first time a view moves.

Details that follow from it:

- Streaming deltas are not recorded. The final text covers them.
- A pending permission prompt replays as a prompt. An answered one
  replays as a one-line note, so it cannot be answered twice.
- History is capped at 2000 events a session.

## Persistence

Saved in `workspaceState` under `perch.sessions.v1`: for each session its
id, kind, title, mode, effort, model, IDE-context flag, location, and the
**agent's own session id**. The transcript is not saved.

On reload a tab resumes by handing that id back to the agent
(`resume` for Claude, `resumeThread` for Codex). The agent has the
conversation on disk. The transcript shown in the tab is read back from
the agent's own record, by `src/sessionStore.js`: the Agent SDK's
`getSessionMessages` for Claude, the rollout file for Codex. The last
thousand entries are shown; a note says how many earlier ones are not.
Until the record has been read, or if it cannot be, the tab says the
earlier transcript is not shown. No tokens are spent on any of this.

A tab's name is saved with the tab and also written to the agent's own
record of the session (`renameSession` for Claude; a line appended to
`~/.codex/session_index.jsonl` for Codex), so the vendors' own clients
show the same name. A name given before the first turn is written when
the first turn ends, since the record does not exist before then.

Tab counters are saved too. Rebuilding them by counting restored tabs
let a new tab reuse the name of an open one; a test caught that.

## Restoring editor tabs

1. The page of an editor tab calls `setState({ sid })`.
2. After a reload VS Code calls `deserializeWebviewPanel(panel, state)`.
3. The host attaches that panel to the session, or disposes it if the
   session is gone, has moved, or already has a tab.
4. VS Code brings a tab back lazily: one behind another has no page
   until it is shown. After a four-second wait, a session with no page
   is checked against the tabs VS Code still holds (`tabGroups`); only a
   session with no tab at all is given one. The first version opened a
   tab for every session without a page, which duplicated the tabs that
   were merely waiting.

A tab saved before editor tabs existed has no `location`. It takes the
current setting, which migrates old sidebar tabs on the next reload.
