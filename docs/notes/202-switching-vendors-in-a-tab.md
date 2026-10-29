# 202 — Switching between Claude and Codex in a tab

Proposal, 2026-10-27. Status: built the same day and released in 0.7.6: the handoff text, the
switch in the tab, and the footer's vendor menu (the pill and the card of phase 3 are not); tried
live, see *Phases*. Written against Perch 0.7.5.

Today a tab's model and effort can be changed within its vendor, but its vendor is fixed when the tab
opens. The workflow this is for: Claude Opus 5.5 does a task, then another model reviews it, fixes
it and opens the PR. Within Claude (Fable after Opus) that works now. With GPT-6 Astra on Codex it
means a new tab that knows nothing of what was discussed, and the existing handoff
(`perch.handoff`) carries only the last answer.

Goal: one tab for the whole job. A tab switches between Claude and Codex and goes on, and the new
agent has read what was said before. Forking into a new tab is a by-product, not the point.

Not the goal: one conversation shared live between two agents, or Perch building model requests.

## Why the conversation itself cannot move

- **Each vendor keeps its own record.** A tab resumes by handing the agent its own session id
  ([note 106](104-architecture.md#n106)): Claude Code's session file, Codex's rollout.
  Neither CLI reads the other's, and their formats are not Perch's.
- **Reasoning is sealed to its maker.** Codex's reasoning items are encrypted for the provider that
  made them; a ChatGPT thread resumed on Bedrock is refused (`invalid_encrypted_content`,
  [note 108](104-architecture.md#n108)). Claude's thinking blocks are signed the same way. A history rewritten
  into the other vendor's format would be refused, or would break with the next CLI version.
- **The cache starts cold.** Whatever crosses is read once, in full, at the new vendor's prices
  ([note 103](101-purpose-and-rationale.md#n103)).

So a switch is a new conversation with the other agent that is given the old one as text. The
question is which text.

## What crosses: the discussion, not the tool output

| | What the new agent gets | Cost | Verdict |
| --- | --- | --- | --- |
| A. Nothing | The old transcript stays on screen, for the user only | None | What a new tab is today. Loses why things were done |
| B. A summary by the old agent | One extra turn on the old side: "the goal, the decisions, the files touched, what is left" | One turn each side | Lossy, and the summary is written by the model being reviewed |
| C. A file the agent is pointed at | The transcript written to disk; the first message says where it is | No model call | The agent may skim it or not read it at all |
| **D. The discussion, inline** | Every message of the user's and every reply of the agent's, in full; each tool call as one line, without its output; no thinking | One cold read, usually 10–40K tokens | **Yes**, with C for what does not fit |
| E. The whole transcript | Everything, tool output included | Hundreds of thousands of tokens | No: mostly stale file reads and logs, and often too long for the other model |
| F. A forged session file of the other vendor | The history, rewritten | Endless upkeep | No: undocumented formats, sealed reasoning |

Measured on the twelve largest Claude Code sessions on the dev machine (2026-10-27; characters ÷ 4
as tokens, injected reminders and IDE context left out):

| Session | All of it | User + agent text | Share |
| --- | --- | --- | --- |
| 5f433a2e | ~2.6M | ~242K | 9 % |
| 2c4b0d4e | ~1.7M | ~142K | 8 % |
| 0b16c96c | ~1.2M | ~201K | 17 % |
| 8a478853 | ~830K | ~120K | 15 % |
| fc7f376a | ~337K | ~28K | 8 % |
| cfc07b64 | ~262K | ~34K | 13 % |
| 8c1e93ff | ~237K | ~11K | 5 % |
| 4ada602c | ~143K | ~35K | 25 % |
| 91563098 | ~114K | ~19K | 17 % |
| 01df5669 | ~84K | ~41K | 49 % |
| 8eea8675 | ~44K | ~15K | 34 % |
| 51375258 | ~35K | ~11K | 30 % |

Tool output is 75 to 95 % of a working session; thinking 0 to 3 %. What was said is small, and
dropping the output loses less than its share suggests: the agent's replies already state what the
tools found, and anything stale is re-read from the working tree, which both agents share.

A compacted session still holds its earlier turns in the session file, so the new agent can be
given turns the old one now knows only as a summary. Not through the Agent SDK's reader, though:
`getSessionMessages` starts at the latest compaction (on 5f433a2e, 102 of 448 messages). The handoff
reads the file itself and follows the thread back from its last message, `parentUuid` by
`parentUuid` and through each compaction's `logicalParentUuid`, so branches left by a rewind stay
out.

### The handoff text

```
Earlier in this tab the user worked with Claude (Opus 5.5) in /git/perch. Its conversation follows:
the user's messages and Claude's replies in full; its tool calls as one line each, without their
output. Read the files themselves for their current state. Continue from the end.

--- user, 14:02
…
--- Claude
…
    · Read src/claudeAgent.js
    · Edit src/claudeAgent.js
    · Bash: make test → exit 0
--- user, 14:31
…
--- end of the earlier conversation
```

- Built by Perch from the agent's own record, with no model call: `src/handoff.js`, over the
  events `src/sessionStore.js` makes of either record.
- A Claude compaction summary, which Claude Code writes in the user's name, is labelled as Claude's
  own summary. When the inline part is cut, the latest summary goes in ahead of the recent turns, so
  the part left out is not left out entirely.
- Pasted images are listed as `[image]`, not sent again.
- **Budget: 40K tokens inline.** Above that, the most recent turns that fit go inline, and the whole
  discussion is written to `~/.cache/perch/handoff/<session>-<n>.md` (mode 0600, in a 0700
  directory), and the text names that file and how many turns are in it only.
- The first message is the handoff followed by what the user types, so it sits after the new
  agent's cached prefix like any message. Perch still builds no request; the agent gets a message.

## Switch in the tab, or fork into a new one

Both carry the same handoff text.

- **Switch** (the same tab goes on with the other vendor). **This is the goal** (decided
  2026-10-27): one tab for the whole job, implement, review, fix and PR, read top to bottom in one
  place. The author is reached again by switching back, not by a second tab. It costs a tab with
  more than one agent record (below).
- **Fork** (a new tab on the other vendor; the original is left as it is). Kept as the card's
  second button, since it is the same handoff, for the occasional side question to the other
  vendor. Not what the workflow is built around.

## The UI

### How a switch is asked for

**Chosen, 2026-10-27; made destination-only 2026-10-28: the other vendor's mark in the footer.** A
Codex tab shows Claude's mark and a Claude tab shows Codex's: the mark says where the action goes,
while the tab icon and composer say where the tab is. It opens *Continue on Codex* (or Claude) with
that vendor's models, default first, and no unrelated vendor-home-page link. A model with effort
control has a contextual submenu of the levels it accepts. Clicking the model row switches with the
model's default effort; clicking an effort pins that level. There is no confirmation (dropped the
same day, after the first live try): nothing is sent until the user sends, and switching straight
back costs nothing, since a stretch in which nothing was said is dropped. The divider says how much
will go and carries a Preview button, which opens the text in an editor until the first message has
taken it. While the tab works the models and efforts are greyed out, and the menu says why. Built:
`switchTo` in each tab's state, the `switchVendor` message, `vendorMenu` in the page; tests in
`test/page.test.js` and `test/host.test.js`. The full tab UI and future multi-vendor shape are in
[note 401](401-perch-tab-ui.md). The pill and card below remain the plan for phase 3, if the footer
is not enough.

1. **The model pill lists both vendors.** The menu is grouped: the tab's own vendor first, with its
   models and efforts as today, then the other vendor under its name and icon, with its models on
   the backend chosen for it (ChatGPT, API key or Bedrock for Codex; subscription, API or gateway
   for Claude). Choosing a model of the tab's own vendor works as it does now.
2. **Choosing one of the other vendor opens a card in the tab**, not a modal:

   ```
   ┌──────────────────────────────────────────────────────────────────┐
   │ [Codex] Continue with GPT-6 Astra                                 │
   │ Codex starts a new conversation that reads this one:              │
   │ 41 messages, about 23K tokens; tool output left out.  Preview     │
   │                                                                   │
   │ [ Continue in this tab ]  [ In a new tab ]  [ Cancel ]            │
   └──────────────────────────────────────────────────────────────────┘
   ```

   - Preview opens the handoff text in an editor, read-only.
   - Above the budget the line says so: "the last 30 messages inline (38K tokens), all 212 in a file".
   - Nothing is sent. The card fills the composer with a marker of the handoff, and the user's own
     words go after it; the handoff is sent with the first message, as a block shown collapsed in
     the transcript. This keeps the rule of the existing handoff: Perch fills, the user sends.
3. **Only an idle tab switches.** While a turn runs or a permission prompt waits, the other vendor's
   section of the menu is greyed out, with the reason in its tooltip.
4. **Commands**, for the keyboard and the command palette: `Perch: Continue in Codex…` and
   `Perch: Continue in Claude…` (the same card), and `Perch: Hand Off Last Answer to Another Tab…`
   gains "with the discussion" beside "last answer only".

### What a switched tab looks like

- **The composer becomes the new vendor's.** It is one element with a vendor class already
  ([note 110](110-features.md#n110)): Claude's bolt and cache clock, or Codex's shield and round send
  button, follow the tab's current vendor.
- **A divider in the transcript** at the switch: the new vendor's icon and "Continued with GPT-6
  Astra on Codex · read 41 messages (23K tokens)", the handoff block collapsed under it. Above it
  the old vendor's turns as they were, read back from its own record.
- **The footer meter** follows the current vendor, as it follows the tab's vendor now.
- **Mode and effort are not translated.** Claude's permission modes (Ask, Edits, Plan, Auto, Bypass)
  and Codex's sandbox (Read only, Workspace, Full access) do not map one to one. A vendor the tab has
  not used yet starts on that vendor's defaults; one it used before gets back what it had. Never
  carried across, so a Bypass tab does not land in Full access by itself. The divider names the mode
  the tab is now in.

### The tab's icon

The icon is the **current** vendor's. The tab is talking to that agent, the composer is that
vendor's, and the icon is the cue for which composer to expect.

- Editor tabs: `panel.iconPath` is set again at the switch, from the vendor's own extension as now
  (`tabIcon(kind)`; Perch ships no logos).
- The sidebar's own tab bar, which Perch draws: the current vendor's icon, and a tab that has been
  on both gets a small dot of the other's colour in the corner. A combined icon was considered and
  left out: VS Code's tab icon is one file, and composing the vendors' SVGs would be shipping their
  logos.
- The title stays the tab's; the tooltip says "Claude → Codex".
- The sessions list shows the current vendor's icon and "Claude → Codex · 2 h ago".
- A fork, when used, is an ordinary tab of the other vendor. Its title is the source's with "(review)" or
  whatever the user renames it to, and its first block says which tab it came from.

## Persistence, for the switch

A saved session today has one `kind` and one agent session id. It becomes a list of segments:

```
segments: [
  { kind: 'claude', agentSessionId: '0b16c96c-…', model: 'claude-opus-5-5', effort: 'high', mode: 'acceptEdits' },
  { kind: 'codex',  agentSessionId: '019a…',      model: 'gpt-6-astra',     effort: 'high', mode: 'workspace-write', handoffFrom: 0 }
]
```

- The tab's `kind` is its last segment's; saved tabs with no `segments` are read as one segment.
- **Replay** reads each segment from its own vendor's record and joins them with the divider.
  History's 2000-event cap counts across all of them.
- **Switching back resumes the old segment.** Claude → Codex → Claude resumes the first Claude
  session and hands it only the Codex segment's discussion. Claude keeps its own history, and its
  cache if the detour was short. A segment's agent session is resumed, never copied.
- **Renaming** writes to every segment's record, so both vendors' own clients show the name.
- **The vendors' own clients** each see their part: the Claude session up to the switch, the Codex
  thread from the handoff on.

## A side effect: crossing providers within Codex

A ChatGPT thread cannot go on on Bedrock, so a switch of Codex backend starts a new thread with
nothing carried ([note 108](104-architecture.md#n108)). The same handoff text fixes that: it is plain text and
crosses providers. Worth doing with the first build, since it is the same code.

## Security and privacy

- A switch sends the discussion to the other vendor. That includes whatever the user pasted, logs
  and keys included. The card says how much will go, Preview shows it, and nothing goes without the
  user pressing send.
- A Bedrock or gateway tab handing off to a vendor's own API moves the text out of that account.
  The divider names both ends of every handoff ("sent from Claude on API / Bedrock to Codex on your
  ChatGPT login"), and is marked as a warning when the conversation leaves an account of the user's
  own (Bedrock, the gateway) for a vendor's service. With no confirmation, that line and Preview are
  what stand before the first message sends it.
- The handoff files under `~/.cache/perch/handoff/` are the user's alone and are removed with the
  tab.

## What not to do

- Send the whole transcript, tool output included.
- Rewrite one vendor's session file into the other's.
- Send a handoff without the user pressing send, or switch vendor as a side effect of a model change
  the user did not see.
- Carry a permission mode across vendors.
- Put the handoff anywhere but in the message: not in a system prompt, not in an instruction file.

## Phases

1. **The handoff text.** Built 2026-10-27: `src/handoff.js` (`loadDiscussion`, `handoffText`,
   `writeHandoff`, `removeHandoffs`), `test/handoff.test.js`. Not wired into the UI yet. Run on real
   sessions (tokens as characters ÷ 4, with the tool lines):

   | Session | Turns | Messages | Whole discussion | Inline | Built in |
   | --- | --- | --- | --- | --- | --- |
   | Claude 5f433a2e (20 compactions) | 389 | 1,137 | ~312K | 238 messages, ~39K, and the latest summary | 0.4 s |
   | Claude 0b16c96c | 461 | 1,404 | ~237K | 178 messages, ~39K | 0.1 s |
   | Claude 2c4b0d4e | 285 | 735 | ~155K | 208 messages, ~40K | 0.1 s |
   | Claude 91563098 | 56 | 145 | ~25K | all of it | 0.03 s |
   | Claude fc3beb6b (the one that wrote this note) | 13 | 26 | ~7K | all of it | 5 ms |
   | Codex 01a1170e | 237 | 904 | ~120K | 274 messages, ~40K | 1.0 s |

   A task-sized session fits whole. A long-running one gives its last few hours inline and the rest
   in the file (0.5 to 1.3 MB).
2. **Switch in the tab**: segments in the saved session, replay across them, the divider, the
   composer, footer and icon following the current segment, `Perch: Continue in Codex…` /
   `…in Claude…`. Built 2026-10-27, not yet tried in a live window:
   - `Perch: Continue This Tab in Codex…` and `…in Claude…` (command palette, and the view's and
     editor tab's `…` menus): a quick pick of the vendor's models, then a modal that says how much
     goes and where, with Continue and Preview. Preview opens the text and switches nothing. The
     card in the tab is phase 3.
   - `Session.switchVendor`: the vendor's settings as the tab had them, else its defaults; the mode
     never carried; the old process ended; the editor tab's icon set again (`vendorChanged`).
   - Saved per tab: `periods` (each `{kind, resume, note}`: the vendor, its agent's session, the
     divider's words), `left` (the settings and session of the vendor it left, for a switch back),
     `handoff` (the text, until a turn has used it). A stretch in which nothing was said is replaced,
     not kept.
   - The handoff goes ahead of the first message after a switch and is let go when that turn ends
     (`result`); a turn that never got going sends it again. The transcript shows the words only.
   - A record that the tab came back to holds a handoff at each return: `Handoff.stretches` cuts it
     there, so a reload rebuilds the transcript in the order the tab went, and a handoff never
     re-sends what the receiving vendor said itself (back on Claude, it is handed what Codex said,
     not its own conversation again).
   - The divider is a note with the vendor's mark between two rules.
   - Tests: `test/host.test.js` (Claude → Codex → Claude, then a reload), `test/page.test.js` (the
     divider), `test/handoff.test.js`.
   - Since built: the sidebar tab of a tab that has been on both vendors has a dot of the other's
     colour beside its mark and the way it went in its tooltip ("Claude → Codex → Claude"; VS Code
     gives an editor tab no tooltip of an extension's own); the sessions list shows that path on
     each of the tab's records, and choosing any of them opens that tab, not a second one on the
     same record; a name the user gives such a tab is written to every record, and to a record a
     later switch makes.
   - Tried live, 2026-10-27, one editor tab: Opus 5.5 added a comment (after a wrong path, put
     right), the tab went on with GPT-6-Astra on Codex (6 messages, about 1K tokens), "review that
     change" was enough for Astra to find and check that comment, and back on Claude, "what did the
     reviewer say?" was answered from 3 messages handed over. A reload rebuilt the tab in order.
     The switch back found Claude's prompt cache warm (76K tokens read from it, $0.02 for the turn),
     so the note no longer says the cache starts cold when the tab returns to a session.
   - Fixed after: a model chosen between the switch and the first message is the one the divider
     names; Codex's code-mode calls (`text(await tools.exec_command({cmd: …}))`) become `shell:`
     lines in a handoff, and in a tab's replay too (`sessionStore.codexEvents`): each command a
     script ran is a `shell` line with its own output, read from what the script printed.
   - Found live the same day: a subscription tab switched to from Codex was given Bedrock's id for
     Fable 5.1 (`us.anthropic.claude-fable-5-1`, labelled "Fable"), which the subscription refused.
     The footer's list is Perch's Claude catalog, and that had been loaded with Bedrock's names. Now
     the catalog is loaded for the window's backend, said outright (`CLAUDE_CODE_USE_BEDROCK`), only
     the latest load is kept, and a model saved under another backend's name is launched by this
     backend's name for the same model, its `[1m]` kept.
   - Reported the same day, not reproduced: a footer pick of GPT-6-Astra that came out as GPT-6.1-Sol,
     the model the tab had last used on Codex. The path was read again end to end (the menu's rows
     each carry their own model; the host takes the model as sent; the divider is written from it in
     the same call) and tested with Codex's real list: no way found for one row to yield another's
     model. Done instead: every vendor switch is traced in the Perch output channel (View › Output ›
     Perch: what the page asked, and what the tab ended on), so the next one can be read back; the
     menu's rows show the model id beside the name and are a little taller.
   - Found while looking: a switch to a vendor whose record the tab resumes, with nothing said,
     kept its stretch (the drop rule looked at `resume`, not at whether anything was said), so a tab
     switched back and forth without a word piled up empty stretches, and a reload then put the
     records' stretches under the wrong dividers. Each period now records whether anything was said
     in it (`said`), an empty one is dropped at the next switch, and a reload reads no record for one.
3. **The model pill across vendors, and the card**, with Preview; *In a new tab* comes free here.
4. **Switching back by resume**, and the Codex backend switch carrying the discussion too.

## Open questions

1. ~~Is the fork enough, or one tab per job?~~ One tab per job (2026-10-27).
2. The budget: 40K tokens, or a share of the new model's context window?
3. Should a switch to review get a review instruction ready in the composer ("Review the changes on
   this branch against main…"), or is that the user's to type?
4. On a switch back to a vendor the tab used before, resume its session (the proposal), or start
   fresh with the whole discussion?

When this is built, [note 102](101-purpose-and-rationale.md#n102) and [note 103](101-purpose-and-rationale.md#n103) need a line:
the bridge between tabs is then the last answer or the discussion, still as a message the user sends.

In one line: a vendor switch is a new conversation that is handed the old one's words without its
tool output, about a tenth of its tokens, and the tab shows the vendor it is on now.
