# perch

Claude Code and Codex as tabs in VS Code, in the editor area or the sidebar.
Any number of sessions, with usage and backend switching built in.

## Why: the vendors' own agents, so their caching

perch runs the **Claude Code CLI** and the **Codex CLI** themselves, one
process per tab, through the vendors' own SDKs. It is a shell around
them, not an agent of its own. That is the whole design, and the reason
is tokens.

An agent sends the whole conversation to the model at every step of a
turn. What keeps that affordable is prompt caching: a step whose prompt
prefix matches the last one is billed at a tenth of the rate. A cache hit
needs the prefix byte-identical from step to step, which only the program
that lays out the prompt can guarantee. Claude Code and Codex do; a
harness that replaces them with its own loop, as Continue and similar
tools do, gets its own caching, its own compaction, and API billing
instead of your subscription.

So perch never builds a request. Each tab is the vendor's agent, with the
vendor's prompt, caching, compaction, permissions, memory, `CLAUDE.md`,
skills, hooks, and MCP servers, unchanged, on your existing login. A tab
costs what a terminal session would; the earlier turns of a session stay
cached across a window reload, because the tab resumes the same session.
What perch adds on top (the sessions list, names, transcripts, usage
gauges) is read from the agents' files and asks nothing of a model.

The full reasoning, with measurements, is in
[design.md](design.md), section 3.

| Tab kind | Agent | How it runs | Auth |
| --- | --- | --- | --- |
| Claude | Claude Code | `@anthropic-ai/claude-agent-sdk`, streaming input, `canUseTool` for permission prompts | your existing `claude` login |
| Codex | Codex | `@openai/codex-sdk`, one `codex exec` per turn on one thread | your existing `codex` login |

Installed from the marketplace, perch runs the `claude` and `codex`
programs that come with the **Claude Code** and **ChatGPT** extensions,
so those two must be installed as well.

## Where tabs live

`perch.newTabs` decides where a new tab opens.

**`editor`** (the default): each session is a native editor tab, like a
file. The tab row is the first line: there is no container icon row and no
view title above it, because those belong to VS Code's sidebars and an
extension cannot remove them. Tabs carry the vendor's icon, can be dragged,
split, and reordered, and open beside your editor. The **+** in the editor
title bar opens a new one. A working tab's title ends in `…`, and a tab
waiting on a permission prompt while hidden starts with `●`. Closing the
editor tab closes the session.

**`sidebar`**: sessions are tabs inside the Perch view, under the Perch
icon in the activity bar.

Both can be used at once. `Perch: Move Tab to the Editor Area` and
`Perch: Move Tab to the Sidebar` move the active tab; the session, its
agent, and its transcript are untouched. There are `Move All` versions of
both. Tabs saved before this setting existed follow it on the next reload.

An editor group that holds only Perch tabs is locked, the way a terminal's
is, so a file opened from the Explorer goes to the group beside it and not
in among the sessions. `perch.lockGroup` turns that off.

After a window reload VS Code brings the editor tabs back where they were,
and each resumes its session.

## Tabs

Press **+** to open a Claude or a Codex tab: in the editor title bar, or in
the sidebar view's tab bar. Each tab is its own session
with its own agent process, context, mode, draft, and transcript. Open as
many as you like of either kind. Paste an image into the message box to
attach it: up to eight to a message, each scaled down to at most 1568 px
on its long side, the most the API keeps as is. A tab is titled from its first message,
or by you (see below).
While a session works, the foot of its transcript says what it is doing
and for how long. A dot on a tab means it is working; a red dot means it is waiting on a
permission prompt. Middle-click or × closes a tab and stops its agent.

Tab icons are the vendors' own, read at runtime from the Claude Code and
ChatGPT extensions if they are installed. perch ships no logos. It uses
each extension's glyph, tinted as the vendor tints it on its own tabs:
Claude's spark in orange, the ChatGPT blossom in the theme's text colour.
Without a glyph it uses the marketplace image, and without the extension
a letter, C or X.

Answers are drawn as Markdown: headings, lists, tables, code, links. A
link to a file opens it in the editor, at its line if it names one. Each
code block, and each tool call's command, shows a copy button when the
pointer is over it. The
transcript keeps to its end as more arrives, until you scroll away to
read; scroll back to the end and it follows again. A long tool result is
clipped and lets the wheel pass, so scrolling the transcript never
catches on one; click it to open it and scroll inside, click again to
close it.

Agents start lazily: an open tab costs nothing until you send a message.

Tabs survive a window reload. perch saves each tab's session id and the
agent resumes its own saved conversation on the next message. The earlier
transcript is read back from the agent's own record of the session: the
last thousand entries of it, with images as a count and Codex's sealed
reasoning left out.

## Names and past sessions

A tab is named from its first message until you name it yourself: run
`Perch: Rename Active Tab…`, or double-click a tab's name in the sidebar.

`Perch: Sessions…` (the clock icon in the title bar) lists the past
sessions of the workspace folder, Claude's and Codex's together, newest
first. Type to search. Choose one to open a tab on it, or go to the tab
already open on it. The pencil on a row renames that session, open or not.

perch keeps no list or names of its own. It reads each agent's records,
and writes a name where that agent keeps names: for Claude, in the
session's file under `~/.claude/projects/`, through the Agent SDK, which
is where Claude Code's own `/rename` writes; for Codex, as a line added to
`~/.codex/session_index.jsonl`. So a session named in Claude Code has that
name here, and the reverse. A tab named before its first message has no
record yet; its name is written when its first turn ends.

Tabs do not share history. **Hand off** (`Perch: Hand Off Last Answer to
Another Tab…`, in the `…` menu of the title bar and in the command
palette) pastes the active tab's
last answer into another tab's input box, or into a new tab. That is the
only bridge, on purpose: shared context would defeat each agent's caching.

## Install

From the marketplace: install **Perch**; Perch Audio, the microphone
companion, and the Claude Code and ChatGPT extensions come with it. Log
in to each vendor when Perch asks, on the first message to a tab of that
kind (see Logins below).

From a checkout:

```
make install     # npm install, syntax check, symlink into the extension dirs
```

Reload the window, then run `Perch: New Tab…` from the command palette, or
click the Perch icon in the activity bar.

## Logins

Both agents run on the logins already on the machine with the workspace:
Claude Code's (`~/.claude`) and Codex's (`~/.codex/auth.json`). Nothing
is copied from elsewhere, so a fresh remote has neither.

- **Claude, on a subscription**: the first message to a Claude tab on a
  machine with no login is held back, the text put back in the box, and
  **Log In** offered: Claude Code's own sign-in page (or `claude /login`
  in a terminal when that extension is absent). Perch notices when the
  login lands and says so; send the message again. The footer's "log in"
  does the same at any time.
- **Claude, on API / Bedrock**: the `API` switch in the footer moves
  Claude to those credentials. They are Claude Code's, not Perch's: AWS
  credentials or a profile on the workspace machine (`~/.aws`, or
  `AWS_*` variables), or `ANTHROPIC_API_KEY`; the region and model go in
  the `env` block of `~/.claude/settings.json` (`AWS_REGION`,
  `ANTHROPIC_MODEL`, and the small/fast model if you use one). With none
  of that in place the first message is held back and the offer opens
  that file, or switches back to the subscription.
- **Codex**: the first message to a Codex tab on a machine with no login is
  held back, the text put back in the box, and the login offered two ways.
  **Log In** runs `codex login` on the workspace machine and opens
  ChatGPT's sign-in page in your browser; the page returns to a local port,
  which VS Code forwards to the workspace machine when it is remote, so
  this works for anyone with a browser. **Device Code** runs
  `codex login --device-auth` in a terminal instead: a link and a one-time
  code, for a machine with no forwarding, which ChatGPT has to allow first
  (Settings → Security and login → App security → "Enable device code
  sign-in"). Either way Perch notices when the login lands and says so;
  send the message again. The same offer appears if Codex later answers
  401, a login that has expired.

## Permissions

Claude: the SDK calls back on every tool use and perch shows Allow /
Always / Deny. The default mode for new tabs is a setting
(`perch.claude.permissionMode`) and each tab can switch live.

Codex: the SDK runs `codex exec`, which is non-interactive. Approvals
resolve by policy (`perch.codex.approvalPolicy`) and the sandbox
(`perch.codex.sandboxMode`). There is no per-command prompt.

Codex's sandbox on Linux is bubblewrap, which needs unprivileged user
namespaces; a container that forbids them (a JupyterHub pod, say) fails
every command with `bwrap: No permissions to create a new namespace`, and
Codex has no other sandbox there. When that happens Perch asks whether to
run Codex without a sandbox, for that tab or for every tab on that
machine from then on; the choice is remembered by hostname, and such tabs
say so when they open.

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

**IDE context**, on both kinds of tab, is on by default for new tabs
(`perch.ideContext`) and remembered per tab. The toggle shows its state
without a hover: coloured with a filled dot when on, dim and reading
"IDE context off" when off. When on, each message carries
the active file and, if there is one, the selection with its line numbers,
as the vendors' own panels do. The transcript shows your message with a
small tag, the file's name and the lines if any, not the attachment itself. The context is read when you
write the message, so a queued message keeps the file that was open then.
A Perch tab in the editor area takes the focus while you type, so the
file attached is the one last focused, as long as it is still open on
screen; the tag on your message says which.

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

Codex: model, effort, and sandbox change from the next message too. Codex
runs each turn as a process of its own, so perch takes the thread up again
with the new choice. Codex itself notes in the transcript when a thread
recorded with one model is carried on with another. The sandbox menu also
shows the approval policy.

Defaults for new tabs: `perch.claude.model`, `perch.claude.effort`,
`perch.claude.permissionMode`, `perch.codex.model`,
`perch.codex.reasoningEffort`, `perch.codex.sandboxMode`.

## Usage, in the footer

The footer follows the active tab.

**Under a Codex tab**: "Work locally", your ChatGPT plan, and the plan's
usage: percent remaining and time to reset for the five-hour window and
the week. Codex records these in its session files after every turn, so
perch reads them from `~/.codex/sessions/` and makes no request. The
figure is as of the last Codex turn on this machine, from any Codex client,
and the tooltip says when that was. A window whose reset time has passed
is shown as full again. perch re-reads after each Codex turn it runs.

**Under a Claude tab**:

- a **backend switch**, `sub` or `API`. Click it to move Claude between
  your subscription login and API / Bedrock. It writes
  `env.CLAUDE_CODE_USE_BEDROCK` in `~/.claude/settings.json` and leaves
  the rest of the file alone. Open tabs come along: each one's process
  ends (after its current turn, if one is running) and the next message
  resumes the same conversation on the new backend, as after a window
  reload. The prompt cache starts over, being the backend's.
- a **usage gauge**. On a subscription: percent remaining and time to
  reset for the 5-hour session, the week, and any model-scoped weekly
  limit, amber or red when one runs low. On API / Bedrock: the model in
  use and today's tokens and estimated cost, from the local transcripts.
  Click to refresh. Hover for detail.

This is [AI Meter](https://github.com/seanahn/ai-meter) merged into perch.
The gauge lives in the footer of each tab; perch puts nothing in the
status bar. AI Meter can stay installed for a gauge that is visible
whatever editor is open.

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
`warnBelow`, `errorBelow`.

## Dictation

The microphone in the composer dictates into the message box. Click to
start, click again to finish, Escape to discard.

Speech-to-text is Whisper, running locally. Nothing you say leaves your
machines. The first use asks to set it up: about 4 GB, into a private
environment under `~/.local/share/perch/voice`. It needs a `python3`;
one without `venv`/`pip` support (Debian and Ubuntu before
`python3-venv` is installed) is fine, pip is fetched from
`bootstrap.pypa.io` into the private environment.

Recording is done by a second extension, **Perch Audio**, which must be
installed on the computer you sit at, because that is where the
microphone is:

| You work | Install Perch Audio on | Whisper runs on |
| --- | --- | --- |
| Directly on this machine | this machine (`make install-audio`) | this machine |
| From a computer with an NVIDIA GPU, over Remote-SSH | that computer (it comes with Perch) | that computer, in Perch Audio; only the text goes to the remote |
| From a laptop with no GPU, over Remote-SSH | the laptop | the remote machine; the audio goes there |

`perch.voice.runOn` overrides the choice (`local` or `remote`). Perch Audio
carries the same engine as Perch, so a GPU under your desk is used even
when the workspace is a CPU-only container far away.

If no microphone is connected, the button says so. `Perch Audio: Choose
Microphone` picks among several.

The model follows the machine: `large-v3-turbo` on an NVIDIA GPU, `small`
on a CPU (`perch.voice.model` names one instead). On a CPU the turbo
model's encoder alone takes seconds; `small` returns a sentence in about
one, at a little less accuracy. Setting `perch.voice.language` (`en`,
`ko`, …) halves the wait again, because detecting the language is a
second pass over the audio.

Verified end to end on 2026-09-30, dictating messages into a tab, on
this machine (GPU) and over Remote-SSH to a CPU-only container.

## Cost

Both agents run on your subscriptions through their normal logins. This
is for personal use on your own machine. Shipping it to other people
would require API-key billing under both vendors' terms.

## Packaging and publishing

`make package` builds `perch-<version>.vsix`, about 8 MB. It carries the
two SDKs but not the `claude` and `codex` programs they run: those are
hundreds of megabytes, and built for one platform. A packaged Perch runs
the programs inside the Claude Code and ChatGPT extensions, so those two
extensions must be installed where Perch is: they are in Perch's
`extensionPack`, so the marketplace installs them with it, on the
workspace side, and either can be removed if only one vendor is wanted.
`perch.claude.executable` and `perch.codex.executable` name a program of
your own instead. In this checkout, installed from npm, the SDKs bring
their own programs and those are used.

Install the file on another machine with
`code --install-extension perch-<version>.vsix`.

To publish to the marketplace, as AI Meter is: create the publisher named
in `package.json`, run `make login` once (or keep the token in
`~/.ssh/azure-dev.pat`, or put `VSCE_PAT=<token>` in `.env`), then `make publish`. `make publish-patch` and `make publish-minor`
bump the version, commit, and tag first.

Perch Audio, the microphone companion, is an extension of its own,
because it has to run on the computer you sit at while Perch runs with the
workspace. Perch names it in its `extensionPack`, so installing Perch from
the marketplace installs Perch Audio too, each on the machine it belongs
on. `make publish` publishes Perch Audio first if its version is new.
Installed from a `.vsix` file, Perch does not fetch it: build it with
`make package-audio` and install that file as well.

## Layout

- `src/extension.js` — the view, sessions, tab state, persistence, commands
- `src/claudeAgent.js` — Claude Agent SDK session, no VS Code dependency
- `src/codexAgent.js` — Codex SDK thread, no VS Code dependency
- `src/models.js` — model catalogs read from the agents, no VS Code dependency
- `src/meter.js` — Claude usage, cost, and the backend switch, no VS Code dependency
- `src/binaries.js` — where the agents' programs are: the SDK's own, or the vendor extension's
- `src/codexMeter.js` — ChatGPT plan usage, read from Codex's session files
- `src/markdown.js` — an answer's Markdown, drawn as DOM nodes; written into the page as source
- `src/sessionStore.js` — past sessions and their names, read from and written to the agents' own records
- `src/meterHost.js` — polling, the backend switch, login
- `src/voice.js`, `src/voiceHost.js` — the speech-to-text engine, and dictation
- `voice/server.py` — Whisper behind JSON lines
- `audio/` — Perch Audio, the recording companion, an extension of its own
- `src/webview.js` — the page: tab bar, per-tab panes, compose box
- `test/meter.test.js` — usage, cost, and the switch, against throwaway home directories
- `test/codexMeter.test.js` — Codex usage, against throwaway session directories
- `test/markdown.test.js` — what each construct becomes, and that nothing written becomes markup
- `test/sessionStore.test.js` — listing and naming, against throwaway directories and a fake Agent SDK
- `test/models.test.js` — catalog parsing, no model calls
- `test/voice.test.js` — the engine, against a stand-in server
- `audio/test/recorder.test.js` — the recorder, with a library that plays back frames
- `test/host.test.js` — host logic against a stubbed VS Code API, no model calls
- `test/page.test.js` — the real page script in a DOM, no model calls
- `test/harness.mjs` — one live turn through each agent, uses your logins

`make test-offline` runs everything except the live harness. `make test` runs all of it.
