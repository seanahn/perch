# perch

Claude Code and Codex as tabs in VS Code, in the editor area or the sidebar.
Any number of sessions, with usage and backend switching built in.

## Why: the vendors' own agents, so their caching

perch runs the **Claude Code CLI** and the **Codex CLI** themselves, one
process per tab, through the vendors' own SDKs. It is a shell around
them, not an agent of its own. That is the whole design, and the reason
is tokens.

### The principle

An agent's token use is a function of prompt caching, and prompt caching
is a function of a byte-identical prompt prefix.

An agent sends the whole conversation to the model at every step of a
turn: system prompt, tool definitions, every message and tool result so
far, then the new step. What keeps that affordable is prompt caching: the
part of a call's prefix that matches a recent call is billed at a tenth of
the input rate (writing the cache costs a quarter more). On a 100k-token
conversation a cached step bills the equivalent of about 10k input
tokens; a cold one about 125k. A cache hit needs the prefix byte-identical
from step to step, and only the program that lays out the prompt can
guarantee that. Claude Code and Codex do. A harness that replaces them
with its own loop and its own prompt gets its own caching, its own
compaction, and API billing instead of your subscription.

```
PERCH TAB   (the vendor's agent lays out the prompt; perch never touches it)

  turn 1   [system · tools · conversation so far] [new message]  → cache written
  turn 2   [same bytes, unchanged ................] [new message]  → cache hit, 0.1×
  turn 3   [same bytes, unchanged ................] [new message]  → cache hit, 0.1×

HARNESS   (its own loop rebuilds the prompt every turn)

  turn 1   [system · editor state A · @context · history] [message]  → cache written
  turn 2   [system · editor state B · @context' · history] [message] → prefix changed: cache miss, 1×
  turn 3   [system · editor state C · @context'' · history] [message] → cache miss, 1×
```

### Where the difference comes from

1. **Prompt assembly.** A harness such as Continue, or an IDE such as
   Cursor, runs its own agent loop over the vendor's model. To be useful
   it writes the editor's state into the prompt (the open file, the
   selection, @-mentioned files, the workspace tree), and that state
   changes between turns, near the front of the prompt, where a change
   invalidates everything after it. perch never builds a request. The
   prompt an agent sends from a perch tab is the one it would send from a
   terminal, so a tab's cache hits are the terminal's cache hits, and a
   tab costs what a terminal session costs. IDE context in perch is
   appended to the message, at the end, where it changes nothing that
   came before.

2. **Compaction and sub-agents.** A harness that keeps one growing chat
   buffer re-sends every raw tool output on every turn until the window
   is full. The vendors' agents compact on their own judgement, keep
   `CLAUDE.md`, memory, skills, hooks, and MCP servers in play, and
   (Claude Code especially) run searches and other side work in
   sub-agents whose transcripts never enter the main conversation. A
   perch tab inherits all of that unchanged, because it is that agent.

3. **Sessions across reloads.** perch keeps no transcript of its own. A
   tab remembers the agent's session id and, after a window reload or a
   backend switch, resumes that session from the agent's own record
   (`~/.claude/projects/`, `~/.codex/sessions/`), so the prompt prefix is
   the same bytes as before. Within the cache's life (an hour on a
   subscription, five minutes on the API) the earlier turns are still
   cached; beyond it, the next turn re-warms the same prefix once, rather
   than a reconstructed one. The sessions list, names, transcripts, and
   usage gauges are all read from those files and ask nothing of a model.

### Side by side

| | perch | Cursor | Continue |
| --- | --- | --- | --- |
| Agent | the vendor's own: Claude Code, Codex, through their SDKs | Cursor's own loop and middleware, in a forked editor | Continue's own harness, in an extension |
| Prompt | laid out by the vendor's agent; perch adds nothing | rebuilt by the IDE each turn, with editor state | rebuilt each turn from @-context providers |
| Cache behaviour | the terminal's: a stable prefix, hits turn after turn | editor state and selections in the prefix break the match | dynamic context in the prefix breaks the match |
| Cost basis | your existing subscriptions and logins; API / Bedrock when you switch | Cursor's plans and request credits, or an API key | your own API key |
| Compaction, memory, MCP | the vendor's: `CLAUDE.md`, hooks, skills, MCP, sub-agents | Cursor's own indexing and context filters | Continue's client-side providers |
| Cost of a long session | that of a terminal session | several times a terminal session, by the reports of people who have measured it | several times a terminal session |

The multiples for harnesses are others' measurements, not perch's: what
perch can show is that a tab's cache reads and costs are a terminal's,
turn by turn, in its own footer. The full reasoning, with what has and
has not been verified, is in [design.md](design.md), section 3.

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
many as you like of either kind. When a gateway file exists (see
[Logins](#logins)), a Claude tab can be put on an **LLM gateway**: a
tab whose Claude Code reaches an Anthropic-compatible endpoint of your
own, such as a company's LLM proxy, while the other tabs stay on your
login. Paste an image into the message box to
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

Reload the window, then press **Ctrl+Alt+P** (Cmd+Alt+P on a Mac):
`Perch: Open` brings back the tab you last used, or, with none open, the
sessions list, which starts a new tab of either kind at the top. The same
is behind the Perch icon in the activity bar and `Perch: New Tab…` in the
command palette.

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
- **LLM gateway**: a Claude tab can be put on a gateway, an
  Anthropic-compatible endpoint reached with `ANTHROPIC_BASE_URL` and a
  token, as a company's LLM proxy is. The variables live in a file of
  yours, `~/.config/gateway-claude/env` by default
  (`perch.claude.gatewayEnv`), written as a shell reads it: `export
  ANTHROPIC_BASE_URL=…`, `export ANTHROPIC_AUTH_TOKEN=…` (or
  `ANTHROPIC_API_KEY`), and any model names (`ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, …). The same file can drive a terminal
  launcher. A tab on the gateway runs its Claude Code process with those
  variables added to its environment, and that is all: nothing is
  written to `~/.claude/settings.json`, the token is never in a file of
  Perch's, and the session, its record, your `CLAUDE.md`, memory, and MCP
  servers are the same as any other tab's. Put a tab on it from the
  footer's backend menu under any Claude tab, where the entry reads
  **LLM gateway** (or with `Perch: New Claude Tab on the Gateway`);
  once chosen, new Claude tabs start there until a tab is put back on the
  subscription or API / Bedrock. The template also sets
  `ENABLE_PROMPT_CACHING_1H=1`: on a token Claude Code would keep the
  prompt cache for five minutes, after which a turn re-sends the whole
  conversation at the cache-write rate; the hour costs more per write and
  less by the first pause over five minutes. Remove the line if the gateway
  rejects the request. The first message to a tab whose file is
  missing or incomplete is held back, and the offer opens the file (made
  from a template, readable by you alone) or takes the tab off the
  gateway. A window on API / Bedrock has to be switched to the
  subscription first: Claude Code applies its settings over a process's
  environment, so the gateway's URL would not be used; the tab says so.
  A tab on the gateway runs its process through a small relay of
  Perch's on the loopback interface, which forwards each request to the
  gateway unchanged and reads the header in which a LiteLLM gateway
  names the model that answered (`x-litellm-model-name`); a routed name
  such as `nexus-auto` may send each request anywhere. The line under
  each answer then says what answered the turn's requests, `via
  gpt-6-luna ×3, grok-4.6`, and what the gateway charged for them,
  `$0.0021 this turn`, its own figure (`x-litellm-response-cost`,
  summed) in place of Claude Code's estimate at Anthropic list prices,
  which does not apply to a gateway's names; the tooltip has the
  session's total by the same reckoning. A streamed response carries no price from the gateway, so a
  turn is priced at list rates for the model that answered each request
  (LiteLLM's public price table, fetched weekly) and shown with `≈`; the
  tooltip says so, and gives the token's running total as the gateway
  counts it. The model button's tooltip
  names the last model. The agent is still Claude Code; the model is
  whatever the gateway chose.
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
  On the gateway the model menu is the file's names, not Claude Code's
  catalog: the default is `ANTHROPIC_MODEL`, and opus, sonnet and haiku
  are what `ANTHROPIC_DEFAULT_*_MODEL` map them to, which is what the
  gateway receives. A tab moved onto the gateway with another model
  chosen starts from the file's default. The choice sticks: once a tab
  is put on the gateway, new Claude tabs start there, until a tab is put
  back on the subscription or API / Bedrock.

## Permissions

Claude: the SDK calls back on every tool use and perch shows Allow /
Always / Deny. The request reads as what it is: for an edit, the file
and the change as a diff, removed lines then added; for a new file, the
file and what goes in it; for a command, the command and what it is for.
The default mode for new tabs is a setting
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
and a round send button. Codex runs on this machine through the SDK;
Codex Cloud tasks are not offered (the SDK has no way to run a thread
there), so there is no "Work locally" chooser as in the Codex extension.

**IDE context**, on both kinds of tab, is on by default for new tabs
(`perch.ideContext`) and remembered per tab. The toggle is green when on
and grey when off. When on, each message carries
the active file and, if there is one, the selection with its line numbers,
as the vendors' own panels do. The transcript shows your message with a
small tag, the file's name and the lines if any, not the attachment itself. The context is read when you
write the message, so a queued message keeps the file that was open then.
A Perch tab in the editor area takes the focus while you type, so the
file attached is the one last focused, as long as it is still open on
screen; the tag on your message says which.

**Earlier messages.** The arrow keys walk the tab's earlier messages,
as a shell does: Up from the first line of the box goes back, Down from
the last line comes forward, and past the newest the draft you were
writing returns.

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

**Under a Codex tab**: a **backend switch** (`ChatGPT` or
`API`), your ChatGPT plan, and the plan's usage: percent remaining and
time to reset for the five-hour window and the week. The switch moves
Codex between your ChatGPT login and an OpenAI API key: the first switch
asks for the key and keeps it in VS Code's secret storage, never in a
file of perch's; Codex gets it in its environment, per turn, so open tabs
move on their next message with nothing restarted. On the key there is no
plan and no limit to show, only per-token billing on your OpenAI account.
`Perch: Set OpenAI API Key for Codex…` and `Perch: Forget the OpenAI API
Key for Codex` manage the key. Codex records these in its session files after every turn, so
perch reads them from `~/.codex/sessions/` and makes no request. The
figure is as of the last Codex turn on this machine, from any Codex client,
and the tooltip says when that was. A window whose reset time has passed
is shown as full again. perch re-reads after each Codex turn it runs.

**Under a Claude tab**:

- a **backend button**, `sub`, `API`, or `gw`. Click it for a menu of
  three: **subscription (login)** and **API / Bedrock** are the window's
  choice, for every Claude tab, and switching writes
  `env.CLAUDE_CODE_USE_BEDROCK` in `~/.claude/settings.json`, leaving the
  rest of the file alone; **LLM gateway** is this tab's alone (see
  [Logins](#logins)). Open tabs come along with the window's switch,
  tabs on the gateway excepted: each one's process ends (after its
  current turn, if one is running) and the next message resumes the same
  conversation on the new backend, as after a window reload. Moving one
  tab onto or off the gateway does the same for that tab. The prompt
  cache starts over, being the backend's. Under a tab on the gateway the
  button reads `gw`, with a warning while its file is missing or
  incomplete, and the gauge shows nothing: the gateway's usage is not
  reported here, and the line under each answer shows its tokens and
  which models answered.
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

Bluetooth ear buds and headsets work too. In their music profile (A2DP)
they have no microphone at all, so Perch Audio lists them from the sound
server's card list, switches them to the headset profile for the
recording (mSBC, 16 kHz, when the device offers it) and back to music
when it ends. Music through them pauses for the length of the dictation.
A plugged-in microphone is preferred when there is one; pick the headset
by name to dictate into it regardless.

The model follows the machine: `large-v3-turbo` on an NVIDIA GPU, `small`
on a CPU (`perch.voice.model` names one instead). On a CPU the turbo
model's encoder alone takes seconds; `small` returns a sentence in about
one, at a little less accuracy. Setting `perch.voice.language` (`en`,
`ko`, …) halves the wait again, because detecting the language is a
second pass over the audio.

Verified end to end on 2026-09-30, dictating messages into a tab, on
this machine (GPU) and over Remote-SSH to a CPU-only container.

A web address in an error or a note is a link. The vendor's mark at the
left of the footer opens the vendor's site, claude.ai or chatgpt.com; the
plan badge under a Codex tab (Plus, Pro) opens your ChatGPT usage page,
where limits and credits are managed.

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
- `src/gateway.js` — the gateway file: reading it, what makes it usable, the environment a tab gets; no VS Code dependency
- `src/relay.js` — the loopback relay a gateway tab's process goes through, which reads which model answered; no VS Code dependency
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
