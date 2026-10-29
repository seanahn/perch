# 901 — Setting up Perch, step by step

Guide, 2026-10-29, for Perch 0.7.11. From a bare VS Code to the working
layout — files in the middle, Perch tabs in a locked group on the right —
with a login for each vendor and backend. The reference for every item is
the [README](../../README.md); this note is the order to do things in.

## 1. VS Code

- **VS Code 1.92 or later** (the editor-group lock Perch relies on arrived
  in 1.92). Desktop VS Code, or code-server in a browser: both work.
- **Where Perch runs is where the workspace is.** Under Remote-SSH, Dev
  Containers or code-server, Perch, the agents and the search server run
  on the remote machine, with the logins and files there; the local
  machine shows the window. Only dictation's recorder (Perch Audio) runs
  locally, since the microphone is there.
- For a remote, connect first (`Remote-SSH: Connect to Host…`) and open
  the folder or `.code-workspace` there; then do the steps below in that
  window, so the extensions install on the remote.

## 2. The extensions

**From the Marketplace** (Extensions view, or
`ext install seanahn.perch`): install **Perch**. It brings three
companions through its extension pack — **Perch Audio** (dictation's
recorder, which must be on the local machine), and the vendors'
extensions, **Claude Code** (`anthropic.claude-code`) and **ChatGPT**
(`openai.chatgpt`), whose programs Perch runs. Under a remote, the
Extensions view installs Perch and the vendors' extensions on the remote
("Install in SSH: host"); Perch Audio goes on the local side by itself.

**From a `.vsix`** (a machine without Marketplace access): `code
--install-extension perch-<version>.vsix`, or on a VS Code server
`~/.vscode-server/cli/servers/Stable-*/server/bin/code-server
--install-extension perch-<version>.vsix`.

Then **Developer: Reload Window**. Press **Ctrl+Alt+P** (Cmd+Alt+P on a
Mac): `Perch: Open` shows the sessions list, which starts a new tab of
either kind at the top. The Perch icon in the activity bar does the same.

A missing vendor program shows as a message in the tab, not a failure:
`perch.claude.executable` and `perch.codex.executable` point Perch at a
`claude` or `codex` elsewhere if the extensions' own are not wanted.

## 3. The window: files in the middle, Perch on the right

The target: Explorer on the left; an editor group in the middle for
files; a second group on the right holding only Perch tabs, locked, so a
file opened from the Explorer never lands among the sessions; the
terminal panel below.

1. **Tabs as editor tabs.** `perch.newTabs` is `editor` by default: each
   session is a native editor tab with its vendor's icon, like a file.
   (`sidebar` puts them under the Perch icon instead; both can be used at
   once, and `Perch: Move Tab to the Editor Area` / `…to the Sidebar`
   move a tab without touching its session.)
2. **Make the right-hand group.** Open a file, then start a Perch tab
   (**Ctrl+Alt+P** → New Claude Tab or New Codex Tab, or `Perch: New
   Tab…`). It opens beside the editor. If it opened in the same group,
   drag its tab to the right edge of the editor area until the drop zone
   shows a second group, or use **View: Move Editor into Next Group**.
3. **The lock.** A group that holds only Perch tabs is locked by Perch
   itself, the way a terminal's is (`perch.lockGroup`, on by default):
   files from the Explorer go to the group beside it. When the last Perch
   tab leaves a group that still has files, Perch takes the lock off.
   Nothing to do by hand; **View: Lock Editor Group** is there if you
   want a lock Perch does not manage.
4. **More tabs.** The **+** in the editor title bar of the Perch group, or
   Ctrl+Alt+P again, opens the next session in that group. Tabs can be
   dragged, split and reordered like files; closing the editor tab closes
   the session (its record stays; `Perch: Sessions…`, the clock icon,
   reopens any past session).
5. **Widths.** Drag the sash between the groups; a Perch tab is happy at
   a third of the window. Toggle the terminal with Ctrl+` (the panel sits
   under both groups).
6. **It survives a reload.** VS Code puts the groups and tabs back where
   they were, and each tab resumes its session: the transcript is read
   back from the vendor's own record, so Perch keeps no copy.

## 3b. The window, annotated

![The working layout: Explorer, files in the middle, a locked group of Perch tabs on the right, the terminal below](901-window.png)

The numbers, left to right and top to bottom. Everything from 4 on is
Perch's; 1–3, 26 and 27 are VS Code's.

| # | What it is | What it does |
| --- | --- | --- |
| 1 | The Explorer | The workspace's folders. A file opened here goes to the middle group, never into the Perch group, which is locked. |
| 2 | The editor group in the middle | Files. The group Explorer opens land in. |
| 3 | The lock in a group's title bar | VS Code's own mark of a locked group; Perch locks a group that holds only its tabs (`perch.lockGroup`). |
| 4 | The Perch group's tab row | One tab per session, each with its vendor's mark; a working tab's title ends in `…`. Drag, split and reorder like files; closing the tab closes the session. |
| 5 | The Perch group's title-bar icons | **+** opens a new tab here; the clock is `Perch: Sessions…`, every past session on the machine; the `…` menu has *Continue This Tab in …* and *Hand Off Last Answer*. |
| 6 | The transcript | The conversation, read back from the vendor's own record after a reload. Code blocks and commands have a copy button. |
| 7 | A message of yours | On the right, with the IDE-context tag when one was sent. |
| 8 | A tool call | One card per call (`Bash · …`), its command and its output; a failed one says so. Sub-agents show as lines and a count. |
| 9 | The result line | What the turn cost: time, tokens in, cached, out, and the price at the backend's rates (`≈` for an estimate). |
| 10 | The composer | Enter sends, Shift+Enter breaks a line; paste an image to attach it. |
| 11 | **+** | Pick files and mention them by path (`@src/a.js`). |
| 12 | **/** | Slash commands, read from Claude Code; typing `/` opens the same list. |
| 13 | The ring | How full the context window is: amber at 80 %, red at 95 %. |
| 14 | The clock | Minutes until the prompt cache goes cold (an hour on a subscription, five on API / Bedrock). |
| 15 | The model pill | Model and effort; a menu for both. |
| 16 | **IDE context** | Send the active file and selection with the message; remembered per tab. |
| 17 | The bolt | Permission mode: Ask, Edits, Plan, Auto, Bypass (a Codex tab shows its sandbox behind a shield instead). |
| 18 | The microphone | Dictation, once set up; it records on the local machine. |
| 19 | Send | Stop while the tab works. |
| 20 | The destination vendor's mark | **Continue in Codex** (Claude's mark under a Codex tab): the other vendor's models, each with its effort levels; the conversation is handed over as text. |
| 21 | The backend pill | `sub`, `API` or `gw` (Codex: `ChatGPT`, `API`, `Bedrock`): a menu, each choice this tab's own. |
| 22 | **usage** | The panel: backend, the plan as the vendor reports it, each window and when it was read, refresh or log in. |
| 23 | **index** | Codebase search: each folder's state and switches. |
| 24 | **sub-agents** | This session's usage, thread by thread. |
| 25 | The compact reading | The plan's windows (5-hour, weekly, per model) in colour; it opens the same panel as **usage**. |
| 26 | The terminal panel | VS Code's; where **Log In** runs the vendors' sign-in. |
| 27 | The status bar | VS Code's and other extensions'; Perch puts nothing here. |

## 4. Logins, per vendor and backend

Perch runs the agents on the logins already on the machine with the
workspace — Claude Code's (`~/.claude`) and Codex's
(`~/.codex/auth.json`). It copies nothing; a fresh remote has neither, and
asks on the first message to a tab of that kind, which it holds back and
puts back in the box once the login lands.

The **footer's backend button** (`sub`, `API`, `gw`, or Codex's
`ChatGPT`, `API`, `Bedrock`) is a menu, and under a Claude tab each
choice is **this tab's own**: two tabs can run on different backends side
by side. The palette's `Perch: Switch Claude Backend` sets the window's
default instead, for tabs that have not chosen and for `claude` in a
terminal.

### Claude, subscription (login)

Send a message; press **Log In**. It runs `claude auth login` in a
terminal, with the `claude` the tabs run and off Bedrock even if
`~/.claude/settings.json` says otherwise; sign in in the browser. Perch
notices when the login lands; send the message again. `Perch: Log in to
Claude (subscription)` does the same at any time. The footer then shows
the plan's windows (5-hour, weekly); **usage** opens the panel.

### Claude, API / Bedrock

Credentials are Claude Code's, not Perch's, on the workspace machine:
an AWS profile or `~/.aws` credentials, or `AWS_*` variables, or
`ANTHROPIC_API_KEY`. Region and model go in the `env` block of
`~/.claude/settings.json` (`AWS_REGION`, `ANTHROPIC_MODEL`, and the
small/fast model if you use one). Then footer → **API / Bedrock** for
this tab. With nothing to authenticate with, the first message is held
back and the note offers to open that file, or to use the subscription
instead.

### Claude, through a gateway

A gateway is an Anthropic-compatible endpoint reached with
`ANTHROPIC_BASE_URL` and a token (a company's LLM proxy, say). Its
variables live in a file of yours, `~/.config/gateway-claude/env` by
default (`perch.claude.gatewayEnv`), written as a shell reads it:

```
export ANTHROPIC_BASE_URL=https://gateway.example/llm-api
export ANTHROPIC_AUTH_TOKEN=…        # or ANTHROPIC_API_KEY
export ANTHROPIC_MODEL=…             # optional: the gateway's model names
export ANTHROPIC_DEFAULT_OPUS_MODEL=…
```

Footer → **LLM gateway** (or `Perch: New Claude Tab on the Gateway`).
A tab whose file is missing or incomplete holds its first message and
offers to open the file, made from a template readable by you alone.
Nothing is written to `~/.claude/settings.json`; the token stays in your
file. Under a remote the file lives on the remote. The model menu is
the file's names; the line under each answer says which model the
gateway actually used and what it charged.

### Codex, ChatGPT login

Send a message; press **Log In**: `codex login` on the workspace machine
opens ChatGPT's sign-in in your browser, returning to a local port that
VS Code forwards from a remote. Without forwarding, **Device Code** runs
`codex login --device-auth` in a terminal: a link and a one-time code
(ChatGPT must allow device-code sign-in: Settings → Security and login →
App security). **Give each machine its own login — never copy
`~/.codex/auth.json` between machines**: two copies share one session
and the first to refresh it logs the other out.

### Codex, OpenAI API key

`Perch: Set OpenAI API Key for Codex…` keeps the key in VS Code's secret
storage, never in a file; footer → **OpenAI API key**. No plan limits
apply, only the account's bill; `Perch: Forget the OpenAI API Key for
Codex` removes it.

### Codex, Amazon Bedrock

AWS credentials on the workspace machine as for Claude; the region and
profile from `perch.codex.bedrock.region` / `.profile`, else from the
environment or the `env` block of `~/.claude/settings.json`;
`perch.codex.bedrock.endpoint` chooses the runtime endpoint (default) or
Mantle. Footer → **Amazon Bedrock**.

### Checking

Under a tab, the footer shows the backend pill and the compact reading;
**usage** opens the panel with the backend, the plan as the vendor
reports it, each window and when it was read. `Perch: Sessions…` lists
every session on the machine, both vendors', with the way each went.

## 5. Optional

- **Dictation.** `Perch: Set Up Voice Input` installs the speech model on
  the workspace machine (a private Python environment); Perch Audio on
  the local machine records. The microphone button in the composer, or
  `Perch: Start or Finish Dictation`.
- **Codebase search.** Off by default. `Perch: Toggle Codebase Search`
  turns it on (the setting is per folder); put a `.codebaseignore` at a
  repository root first for what to leave out (`security_scripts/` style
  directories, vendored template libraries). Keywords work at once on the
  machine's `python3`; `Perch: Install Codebase Search by Meaning` adds
  the embedding model (about 300 MB). The footer's **index** shows each
  folder's state and switches it on or off.
- **IDE context.** The toggle in the composer sends the active file and
  selection with each message; remembered per tab.
- **Permission modes and sandboxes.** The mode pill in the composer:
  Claude's Ask / full access / plan, Codex's sandbox and approval
  policy (`perch.codex.sandboxMode`, `perch.codex.approvalPolicy`).

## 6. Under a remote, in short

Install Perch in the remote's window so it lands on the remote; log in
on the remote (the browser login is forwarded; Device Code when it is
not); keep the gateway file on the remote; expect the index under the
remote's `~/.cache/codebase-index/`. Perch Audio alone belongs to the
local machine.
