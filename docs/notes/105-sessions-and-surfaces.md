# 105 — Sessions and surfaces

A **session** is one tab: one agent, one context. A **surface** is a page
that shows sessions. There are two kinds.

| Surface | Shows | Tab bar | VS Code API |
| --- | --- | --- | --- |
| Editor tab | one session | VS Code's own | `WebviewPanel`, `WebviewPanelSerializer` |
| Sidebar view | every session that lives in the sidebar | perch's own, in the page | `WebviewView` |

`perch.newTabs` chooses where new tabs open, `editor` by default.

## Why editor tabs

A view docked in a sidebar carries two rows of VS Code's own chrome: the
container icon row and the view title. An extension cannot remove them.
The editor area has neither, so there the tab row is the first line.
This is also how Claude Code's own extension presents its sessions.

## Routing

The host does not assume one page. Each session has a `location`, and
every message is sent to the surface that shows that session:

| Message | Goes to |
| --- | --- |
| A session's events | the surface showing that session |
| `tabs` | the sidebar gets its sessions; each editor tab gets its one, with `single: true` |
| Usage, slash commands | every page |

## Native tab titles

An editor tab cannot draw the status dots that the sidebar's tab bar
does, so status goes in the title:

| State | Title |
| --- | --- |
| Idle | `fix the flush bug` |
| Working | `fix the flush bug …` |
| Permission prompt waiting, tab hidden | `● fix the flush bug` |

## Closing and moving

Closing an editor tab closes the session and stops its agent. The host
tells that apart from a tab that goes away for another reason, a move
or a shutdown, so that neither closes a session by accident.

A tab can be moved between surfaces. The session, its agent, and its
transcript are untouched; only its `location` changes and the new
surface is sent a replay.

## Locking the editor group

VS Code opens a file from the Explorer in the group last used, which
after a message is the session's. So a group that holds only Perch tabs
is locked, as VS Code locks a terminal's, and the file goes to the group
beside it. Two things lock it. The package's `configurationDefaults` put
the session webview (`mainThreadWebview-perch.session`) in
`workbench.editor.autoLockGroups`, which VS Code applies when a session
is the first tab of a group and there is more than one group. And the
host locks the active group when a session's tab becomes active there
and every tab in it is Perch's (`lockGroup`). The only group is locked
too: VS Code honours a lock there as well, and opens the file in a new
group beside it.

VS Code never takes a lock off by itself. A group locked for sessions
that later took files, and then lost its sessions, stayed locked with
only files in it, and a file opened from the Explorer went past it into
a new group (2026-10-14). So the host watches tabs close
(`tabGroups.onDidChangeTabs`). A tab moved to another group is told as an
open there and then a close in the group it left, the closed tab's
`group` being that group. A short while after a Perch tab leaves a group
(`UNLOCK_DELAY_MS`, 150 ms, since a tab that takes the place of another
opens just after the old one closes), the host unlocks the group if it
still has tabs, none of them Perch's, and none of an editor that
`autoLockGroups` locks a group for (a terminal's, by default), whose lock
it may be (`tabsChanged`, `unlockGroups`).

The tab API does not tell whether a group is locked, and
`workbench.action.unlockEditorGroup` is not given a group but a file.
VS Code unlocks the first group, most recently used first and so the
active one first, that has an editor of the file, and the active group if
none has. Before 1.92 it looked only at each group's active editor, and
named the group it found by its place in the window where an id was
wanted, which can be another group (1.90 and 1.91: `editorGroup.index`
passed to `getGroup`). So the host passes a file it has just seen in the
group and open in no other group (either side of a diff counts as open),
or any of its files if the group is the active one. It does nothing
before 1.92, or when the group has no such file. Unlocking a group that
is not locked does nothing.

What is left alone: a group whose every file is open in another group as
well keeps its lock, and so does a locked group left empty
(`workbench.editor.closeEmptyGroups` off), which no file can name. A lock
the user put on such a group by hand is taken off with Perch's, since the
API cannot tell the two apart. `perch.lockGroup` off stops both the
locking and the unlocking; the `autoLockGroups` default stays, as VS
Code's to apply.

## A tab's title

A tab is titled from the start of its first message, until its agent's
record has a title of its own: Claude Code titles a session itself as the
conversation goes on (`ai-title` records), and the sessions list reads the
records. A tab the user has not named takes the record's title when a turn
ends (`getSessionInfo`), and again when the list opens, so a tab and its
row say the same name. Before 2026-10-05 the tab kept its first-message
title and an open session could not be found in the list by the name on
its tab ("review https://github.com/…" on the tab,
"… PR #277" in the list). A name the user gave (`named`,
kept with the tab and written to the record as before) is never replaced.

## Deleting a session

Each row of the sessions list has a bin beside the pencil. It asks first,
in a dialog that waits (the one modal dialog perch shows: the record
cannot be brought back), and then removes the session by its agent's own
means: the Agent SDK's `deleteSession` for Claude, and
`codex delete --force <id>` for Codex, which takes a UUID only and removes
the rollout with its name (`src/sessionStore.js`, `deleteSession`).
Nothing of either agent's store is touched by perch's own hand. A tab open
on the session is closed first, since its agent would write the record
again; the dialog says so. The list opens again afterwards, without the
row.
