# 203 — The workflow phase pill, and settings an installer can set

Built 2026-11-23, released in 0.7.41 (see [Built](#built) and [Checked live](#checked-live)). Written against
Perch 0.7.36. Three small changes, wanted by an installer that sets up a
whole machine (VS Code, Perch, an LLM gateway, MCP servers, a workflow plugin) in one run, so that the first
time the user opens VS Code, Perch is already in place and on the right backend. Each is useful without that
installer too.

1. A **phase pill** in a Claude tab's footer: which phase of a skill-driven workflow (Superpowers, or a fork
   of it) the conversation is in.
2. **`perch.claude.defaultBackend`**: where new Claude tabs start before the user has chosen.
3. **`perch.firstStart.openClaudeTab`**: open one Claude tab on the right the next time Perch starts, once.

## 1. The phase pill

Superpowers-style plugins drive a conversation through skills: brainstorm a design, write a plan, build it,
finish the branch. The conversation shows which skill ran only as a tool call scrolled out of sight, so after
an hour it is hard to say where a session stands. The pill says it.

**Phases.** The phase is set by the last workflow skill the agent invoked (a `Skill` tool call), matched on
the name after the `:`, so `superpowers:writing-plans` and `trivialpowers:writing-plans` both count:

| Phase | Skills |
|---|---|
| Design | `brainstorming`, `resuming-design-work` |
| Plan | `writing-plans` |
| Build | `using-git-worktrees`, `executing-plans`, `subagent-driven-development` |
| Finish | `finishing-a-development-branch` |

Any other skill (test-driven development, debugging, verification, reviews) runs inside a phase and leaves it
unchanged. Before any of these has run there is no phase, and no pill.

**Where.** In the footer of a Claude tab, right after the backend pill:

```text
[Codex icon]  [sub] [Plan]  [usage] [index] [sub-agents]  …  [5h 91%] [week 20%]
```

**Hover.** A tooltip lists all four phases in order with the current one highlighted:

```text
┌────────────────────────────────┐
│ Workflow phase · trivialpowers │
│   Design                       │
│ ▸ Plan            writing-plans│
│   Build                        │
│   Finish                       │
└────────────────────────────────┘
```

A native `title` cannot highlight one line, so it is a small hover card in the page, styled like the footer's
other panels, opened on hover and on keyboard focus, closed on leave, blur and Escape. It shows the skill that
set the phase beside the current one, without its plugin prefix; the header names the plugin
(`Workflow phase · <plugin>`, the part before the last `:`) and is just `Workflow phase` when the skill has none. The header is shown in capitals, as the footer's other panels' headings are. The pill itself does nothing on click.

**What counts:**
- The main conversation only. Skill calls inside sub-agents (a builder sub-agent running test-driven
  development, say) never move the phase. The live stream carries sub-agent calls too; they are ignored, so the
  pill reads the same live and after a reload (the replayed record already leaves sub-agent turns out).
- A workflow skill the user starts themselves with its slash command (`/brainstorming`, `/writing-plans`, …)
  counts like the agent's call. It is read from what is actually sent to the agent (a message that starts
  with `/name`; `/name/path` is a path), not from what was typed, and a bare name is resolved against Claude
  Code's command list (the one behind the `/` menu): with exactly one command named `<plugin>:<name>` the
  skill is recorded under that full name, so the card can name the plugin; with none or several it stays bare.
- A call that failed (denied, an error result, an unknown skill) does not count: the phase moves when the
  call's result arrives and is not an error.

**Source.** The host already sees every tool call as the agent streams it, and the transcript replayed from the
session's record when a tab is reopened. The phase is derived from both: no new state is stored, so a reloaded
window, a resumed session and a session moved between the sidebar and the editor all show the same pill. On reopening,
the host reads the session's record from the end until it meets the last workflow skill, so a long session's
phase is found even when it lies before the part of the transcript that is shown; the result is kept in memory
for the tab. The phase rides on the tab's existing description sent to the page (one more field), not a message
of its own.

**Across vendors.** The phase belongs to a Claude stretch of the tab. A Codex stretch has no pill (Codex's skill
calls look different, and a Codex workflow has not been tried). Coming back to Claude resumes the earlier Claude
session, whose record gives its phase back; a handoff into a new Claude session starts with none.

**Not** a setting: the pill appears only once a workflow skill runs, so a user without such a plugin never sees
it.

## 2. `perch.claude.defaultBackend`

Today a new Claude tab starts where the last Claude tab was put: once the user picks the gateway for a tab, new
tabs follow (`perch.claude.newTabsOnGateway`, kept in Perch's own stored state), until the user picks the
subscription or API / Bedrock. An installer cannot write that state, so a fresh machine always starts on the
window's backend, and the first tab has to be moved by hand.

The setting gives that remembered default its **starting value**:

| Value | Meaning |
|---|---|
| `remembered` (default) | as today |
| `gateway` | until the user has chosen a backend for a tab, new Claude tabs start on the gateway |

Once the user chooses a backend in any tab's menu, the remembered choice wins, as today; the setting is only
read while nothing is remembered. A `gateway` default with no usable gateway file behaves as a gateway tab does
today: the first message is held and the tab offers the file, the subscription, or leaving the gateway.

## 3. `perch.firstStart.openClaudeTab`

A boolean, default `false`. When Perch activates and finds it `true`:

1. Write `false` to the setting first, at the scope it was read from. If that write fails (a scope Perch
   cannot write, such as a policy), do nothing more: never open a tab that would open again on every start.
2. If no Perch tab is open anywhere (in an editor or the sidebar), open a new Claude tab (on the backend item 2 gives it) in an editor group
   to the right of the active one, creating that group; Perch locks it as it locks any group holding only its
   tabs (`perch.lockGroup`).
3. Keep a group on the left: if the window has a single group once the tab is open, make an empty group to its
   left (VS Code's empty-group watermark); only if VS Code keeps no second group, open one empty, unsaved untitled
   editor and move it to a group on the left. The Perch tab has the focus at the end.
**Write `false`; never remove the key**, or an installer that rewrites only missing keys would set it back to
`true` on its next run. Writing before opening also keeps two windows that start together from both opening a
tab, short of a near-simultaneous start.

If a Perch tab is already open (the window restored one), only step 1 runs.

Out of scope: Perch does not change the user's activity bar, Welcome page or secondary sidebar settings. An
installer that wants them sets them itself; Perch changing a user's workbench layout on its own first run is
left undecided (it would reach every Marketplace user, not only those who ran an installer).

## Flows

First start after an installer set both settings:

```
 VS Code            Perch (activate)              settings                 editor groups
    |                     |                           |                          |
    |-- activate -------->|                           |                          |
    |                     |-- read firstStart ------->|                          |
    |                     |<-- true ------------------|                          |
    |                     |-- write firstStart=false ->|                          |
    |                     | [write fails: stop, open nothing]                    |
    |                     |-- any Perch tab open (editor or sidebar)? ---------->|
    |                     | [a tab was restored: stop]                           |
    |                     |<-- none ---------------------------------------------|
    |                     |-- read defaultBackend --->| [nothing remembered]     |
    |                     |<-- gateway ---------------|                          |
    |                     |-- new Claude tab, gateway, in a group beside, lock ->|
    |                     |-- keep the left group (watermark, else untitled) --->|
    |                     | [no usable gateway file: first message held, offers]|
```

The phase, live and on reopening a tab:

```
 Claude Code (SDK)        Perch host                       page (footer)
        |                     |                                  |
        |-- tool_use Skill ---|  (main thread only)              |
        |   "x:writing-plans" |-- phase_of("x:writing-plans")    |
        |-- tool_result ok ---|   = Plan once the result is ok   |
        |                     |-- tabs / phase: Plan ----------->|-- pill "Plan", card ▸ Plan
        |-- tool_use Skill ---|                                  |
        |   "x:test-driven-…" |-- phase_of → none: unchanged     |
 [tab reopened]               |-- replay the session record:     |
                              |   last workflow Skill → Plan --->|-- same pill
```

## Settled while planning (2026-11-23)

- The phase logic is one small module, `src/phase.js`: the skill-to-phase map, a user message's slash command,
  and the last workflow skill in a list of events. The host keeps the result on each Claude session in memory
  only. A past session's phase is read from its raw record, `<id>.jsonl`, across every compaction (the Agent
  SDK returns only what follows the last `compact_boundary`): main-conversation Skill calls with an ok result,
  and slash commands; from the SDK's messages only when there is no file. The host keeps it per session id, so
  a switch back from Codex reads no record again.
- A bare slash command (`/brainstorming`) is recorded under its full name when Claude Code's command list (the one
  behind the `/` menu) has exactly one command named `<plugin>:<name>`; with none or several it stays bare. Claude
  Code records the resolved name itself (`<command-name>/trivialpowers:brainstorming`), so a reload agrees.
- Tool calls carry whether they came from a sub-agent (`sub`), so the live stream can ignore them as the
  replayed record already does.
- The first-start check runs after the restore grace period, so a tab VS Code brings back counts as open. When,
  after the Perch tab opens beside, the window has a single editor group, `workbench.action.newGroupLeft` makes an
  empty group on its left; only if a single group still remains is an empty untitled editor opened (not a preview)
  and moved left with `workbench.action.moveEditorToLeftGroup`. Either way the Perch tab is focused last. If the new
  tab does not show among the groups within a second, this step is skipped and said in Perch's output.
- The setting is written back at the scope that held `true` (user, workspace or folder).

- A tab's phase is read from the raw record across compactions and cached per session id; see the first item.
- The page cannot `require` modules, so its list of phases is a literal; a test compares it with `PHASES` in
  `src/phase.js`.

## Built

Branch `feat/phase-pill`, [PR #1](https://github.com/seanahn/perch/pull/1), released in 0.7.41 (not yet published). The plan was deleted after commit
`109ca51`. The README lists the two settings and links here: [README](../../README.md).

## Checked live

In a fresh VS Code profile, with both settings set:

- First start opened one Claude tab on the right and kept the left group; in that profile the left group held
  another extension's welcome page, so neither the empty group nor the untitled fallback was exercised there.
  The setting read `false` afterwards.
- The backend pill read the gateway, with the gateway's default model.
- `/brainstorming` showed Design between the backend pill and the usage button; the card showed the skill and
  resolved the plugin name in its header.

## Verification

- A Claude tab whose agent invokes `…:brainstorming`, then `…:writing-plans`, then
  `…:test-driven-development` shows Design, then Plan, then still Plan; the card highlights Plan.
- A window reload shows the same pill on the reopened tab; a tab with no workflow skill shows none.
- With `perch.claude.defaultBackend` = `gateway` and nothing remembered, **+** opens a gateway tab; after the
  user puts a tab on the subscription, **+** opens a subscription tab.
- With `perch.firstStart.openClaudeTab` = `true` and no tabs, one Claude tab opens on the right and the setting
  reads `false` afterwards (present, not removed); with a tab restored, no tab opens and the setting still
  becomes `false`.
