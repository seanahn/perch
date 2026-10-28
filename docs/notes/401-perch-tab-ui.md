# 401 — The Perch tab UI

Proposal, 2026-10-28. Written against Perch 0.7.10. The destination-vendor control, including its
model-specific effort menus, was built the same day but is not released yet. The common usage panel
is proposed, not built.

A Perch tab is one conversation, presented either in an editor tab or in the sidebar. The page is
deliberately thin: the vendor's agent owns the conversation and its prompt, while Perch owns the
surrounding controls, transcript rendering, and readings taken from local records. This note gives
the whole tab a single UI map, then changes two controls in the footer:

1. a vendor icon means only **continue this tab on that vendor**, and therefore shows the other
   vendor rather than the current one; and
2. a common **usage** button replaces the Codex-only plan badge as the way to inspect account and
   backend usage, for Claude and Codex alike.

The handoff mechanism itself is in [note 202](202-switching-vendors-in-a-tab.md), usage sources and
their accounting are in [note 111](111-usage-meters.md), and the page-to-host messages are in
[note 107](107-page-protocol.md). The destination control supersedes only note 202's mixed-purpose
footer icon; its handoff contents, persistence, and current-vendor tab icon stay as designed.

## The tab as a whole

The same parts appear in an editor surface and in the sidebar; only the tab strip belongs to VS
Code in an editor surface.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ tab strip:  [+]  [vendor mark] conversation title                    [×]     │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│ transcript                                                                  │
│   user messages                                                             │
│   answers, thinking, tool calls and results                                 │
│   permission and question cards                                             │
│   vendor-handoff dividers                                                   │
│                                                                              │
│ current work / permission-waiting line                                      │
│ optional panels: session threads, codebase index                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ message box                                                                 │
│ composer tools: files · slash commands · context/cache · model/effort ·      │
│                 IDE context · permission mode/sandbox · dictation · send     │
├──────────────────────────────────────────────────────────────────────────────┤
│ footer: vendor/backend/account state · auxiliary panels · usage              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Tab strip

- The tab's icon is the **current** vendor. It answers who will receive the next message.
- The title belongs to the conversation, not to a vendor. A switched tab remains one tab.
- Working and attention states appear in the tab title or its dot, depending on the surface.
- **+** creates a Claude or Codex tab; closing a tab stops its agent.

This current-vendor icon is different from the destination icon in the footer. In the tab strip the
mark is identity; in the footer a mark is an action and names its destination.

### Transcript

The transcript is an ordered view of the vendors' own records. It contains user and assistant
messages, compact tool calls and results, permission requests, questions, notes, errors, and the
result line for each turn. A vendor switch inserts a divider and the tab then continues from the
other vendor's record. Perch does not rewrite the prompt or manufacture a shared agent record.

The bottom of the transcript holds transient work state and panels that need more vertical space:

- what the active agent or its sub-agents are doing;
- **sub-agents**, the whole session's threads and their token/cost breakdown; and
- **index**, codebase-search state and its workspace/folder switches.

### Composer

One composer follows the active tab. Its layout and terminology change with the vendor, but the
message and attachments stay in place when the active tab changes.

| Concern | Claude | Codex |
| --- | --- | --- |
| Files | `@` file picker | `@` file picker |
| Commands | Claude Code slash commands | Codex commands when available |
| Context | context ring and prompt-cache clock | IDE-context switch |
| Model | model and effort pill | model and effort menu |
| Authority | Ask, Edits, Plan, Auto, Bypass | Read only, Workspace, Full access |
| Input | dictation, send/stop | dictation, send/stop |

The composer says how the next message will run. Account limits and navigation to another vendor
do not belong in it.

## The footer today

In 0.7.10 the footer is approximately:

```text
Claude: [Claude icon] [sub/API/gw]       [index] [sub-agents]  …  [5h 91%] [week 20%]
Codex:  [ChatGPT icon] [ChatGPT/API/…] [pro] [index] [sub-agents]  …  [5h 96%] [week 99%]
```

Its controls currently have four different jobs:

| Control | Current job |
| --- | --- |
| Vendor icon | Shows the current vendor, opens models for continuing on the other vendor, and links to the current vendor's home page |
| Backend pill | Selects subscription/login, API/Bedrock, or the Claude gateway |
| Codex plan badge (`plus`, `pro`, …) | Shows a ChatGPT plan name and opens ChatGPT's usage page; Claude has no matching badge |
| Usage figures | Show the current backend's remaining windows or cost reading; clicking refreshes them |
| `index` | Opens codebase-search state and switches |
| `sub-agents` | Opens this session's thread-by-thread use |

Two asymmetries make this harder to read than it needs to be.

First, the vendor icon looks like identity but acts partly as a destination. On a Codex tab a
ChatGPT icon is clicked to continue on Claude. The same menu also contains **Open chatgpt.com**, an
unrelated action. Second, `pro` looks like the Codex equivalent of a usage button, but it is only
plan metadata and an external link. Claude has the same kind of limit readings without that
control, so the footer changes shape by vendor for no functional reason.

## Destination-vendor icons

The footer's vendor icon is a handoff control only. It displays the vendor the tab would continue
on, never the one it is on.

```text
Current tab       Footer handoff control
-----------       ----------------------
Codex             [Claude icon]  Continue on Claude
Claude            [Codex icon]   Continue on Codex
```

Clicking the icon opens only that destination's models under **Continue on Claude** or **Continue
on Codex**. Each model with effort control has a chevron and a contextual submenu containing the
levels that model accepts:

```text
Continue on Codex
  default · GPT-5.6-Sol       ›    ┌ GPT-5.6-Sol effort ─┐
  GPT-6-Sol                   ›    │ Low                 │
  GPT-6-Luna                  ›    │ Medium              │
  GPT-5.5                     ›    │ High                │
                                  │ Ultra               │
                                  └─────────────────────┘
```

Clicking the **model row itself** performs the handoff with effort `""`: the destination agent or
model chooses its default. The contextual submenu pins an explicit level. Thus `default · ultra`
describes what the model currently resolves its default to; Perch still sends no `ultra` override
unless the user clicks **Ultra**. A model with no effort control has no chevron and its row goes
straight to its default.

Pointer hover, the chevron, focus plus Right Arrow, or the model row's contextual affordance opens
the effort menu. Left Arrow or Escape returns to the model list. While a turn or permission prompt
is active the models and their effort menus remain disabled and the menu says when they become
available.

The generic **Open claude.ai** and **Open chatgpt.com** rows leave this menu. Perch does not need a
home-page launcher, and a control should not perform an unrelated second job. Purpose-specific
external links remain where they belong: login actions in the backend flow, and **Manage usage** in
the proposed usage panel.

The current vendor is still visible in stronger places: the editor/sidebar tab icon, composer
shape and accent, model name, backend pill, transcript divider, and the tab's path tooltip. The
handoff icon can therefore answer the useful question: "where will this click take the tab?"

### More than two vendors

The data model is a list of destinations, not a hard-coded opposite:

```text
on Codex:  [Claude] [future vendor A] [future vendor B]
on Claude: [Codex]  [future vendor A] [future vendor B]
```

- Exclude the current vendor.
- Keep a stable configured order so the icons do not move between turns.
- Give every icon its vendor mark, `aria-label="Continue on <vendor>"`, the same tooltip, and its
  own model menu.
- Keep the control visible but disabled while a switch cannot occur, so its location is stable.
- If the row eventually cannot fit, put destinations after the first two in one overflow button;
  do not turn the current vendor's icon back into a generic menu.

Perch continues to read marks from the vendors' extensions and ships no vendor logo of its own.

## Proposal: one usage control

Replace the Codex-only plan badge with a small **usage** toggle on every tab. The label describes
the action; plan names such as `plus`, `pro`, or `max` are data shown inside its panel.

The proposed footer is:

```text
Codex tab:
[Claude icon] [ChatGPT] [usage] [index] [sub-agents]  …  [5h 96%] [week 99%]

Claude tab:
[Codex icon]  [sub]     [usage] [index] [sub-agents]  …  [5h 91%] [week 20%]

With more vendors:
[destination icons…] [backend] [usage] [index] [sub-agents]  …  [compact reading]
```

The button and the compact reading open and close the same panel. Refresh moves into the panel,
instead of a click on the numbers silently meaning refresh. The button is present even when a
reading is unavailable, stale, needs a login, or the backend has no subscription limits; those are
useful states to explain rather than reasons to remove the control.

### Panel

For a subscription tab:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Claude usage                                      [refresh] [×]    │
│ Backend  subscription (login)                                     │
│ Plan     not reported                                             │
│ 5-hour session       91% remaining     resets in 1h               │
│ Weekly               20% remaining     resets in 6d               │
│ Updated 10:42:13                              Manage Claude usage ↗ │
└────────────────────────────────────────────────────────────────────┘
```

```text
┌────────────────────────────────────────────────────────────────────┐
│ Codex usage                                       [refresh] [×]    │
│ Backend  ChatGPT                                                   │
│ Plan     Pro                                                       │
│ 5-hour session       96% remaining     resets in 2h               │
│ Weekly               99% remaining     resets in 6d               │
│ As of the last Codex turn                    Manage ChatGPT usage ↗ │
└────────────────────────────────────────────────────────────────────┘
```

Do not invent a Claude plan name when Anthropic's usage response does not report one. Symmetry
means the same control and structure, not pretending the vendors expose the same fields.

For API, Bedrock, or a gateway, the panel keeps the same shell but states the different accounting:

- Claude API/Bedrock: tokens and the existing list-price estimate, marked as an estimate where the
  provider's bill can differ;
- Codex API: tokens/cost available from the session records, without ChatGPT plan limits;
- Codex Bedrock: local token/cost information only where Perch can support it honestly, with the
  provider account named as the source of the real bill; and
- Claude gateway: no account-wide reading; point to the per-turn token/cost line and say that the
  gateway does not report its quota here.

The panel must identify freshness. Claude subscription readings are polled and cached; Codex plan
limits are as of the last Codex turn on this machine. A stale reading remains visible and marked
stale. Login, rate-limit, network, and unsupported-backend states use the same panel rather than a
different footer layout.

### What “usage” means, and what it does not

There are three related readings, and the UI should keep them distinct:

| Reading | Scope | Place |
| --- | --- | --- |
| Plan/quota or backend cost | Account/backend, across sessions as the vendor reports it | **usage** panel and compact footer reading |
| Main thread and sub-agent tokens/cost | This Perch session, reconstructed from its local records | **sub-agents** panel |
| Tokens and cost for one answer | One turn | Result line under that answer |

The **usage** panel may link to **Open session breakdown**, which opens the existing sub-agents
panel, but it should not duplicate that table. The `index` panel remains unrelated.

## Interaction and accessibility

- Each icon-only handoff control has an accessible name and tooltip naming the destination and the
  action. The image alone is not the label.
- **usage**, **index**, and **sub-agents** are toggle buttons with `aria-pressed`; only one need not
  be open at a time, but opening one should close the others to preserve transcript space.
- Panel close and refresh actions are keyboard reachable. Escape closes the open panel before it
  affects the composer.
- Warnings use text and the theme's warning colour, never colour alone.
- Changing the active tab redraws the footer from that tab's vendor and backend. No account reading
  from one vendor remains visible under the other.
- A vendor switch updates the destination icons, backend, usage panel, composer, and tab mark as
  one state change. An open usage panel changes to the new vendor rather than showing old data.

## State ownership

The page should render a list of supported vendor destinations and one usage object for the active
vendor. It should not infer "the other vendor" from a two-value conditional once a list is
available.

Conceptually:

```text
tab.vendor                    current agent; owns composer and tab identity
tab.switchTo[]                destinations; each model carries efforts and defaultEffort
tab.backend                   route/account used by the current vendor
meters[tab.vendor]            quota/cost reading and freshness
usagePanelOpen                presentation state only
```

No vendor switch, login, refresh, or external page opens merely because the panel was rendered.
The host still performs every state-changing or external action after an explicit page message.

## Acceptance criteria

1. On a Codex tab, the footer shows a Claude handoff icon and no ChatGPT handoff icon; its menu has
   Claude models and no **Open chatgpt.com** row.
2. On a Claude tab, the footer shows a Codex handoff icon and no Claude handoff icon; its menu has
   Codex models and no **Open claude.ai** row.
3. Clicking a destination model chooses that model's default effort; opening its contextual menu
   and clicking an effort sends that explicit level. Models expose only levels they accept, and a
   model without effort control has no submenu.
4. With three or more vendors, the footer shows one destination control for every supported vendor
   except the current one, in stable order.
5. Claude and Codex both show **usage** in the same location. A ChatGPT `pro` value appears inside
   the Codex panel; the footer has no Codex-only plan badge.
6. The compact quota/cost reading remains visible, and it and **usage** toggle the same panel.
7. Subscription, API, Bedrock, gateway, unavailable, stale, and login-required states explain what
   is known without inventing a plan or provider bill.
8. The current vendor remains clear from the tab, composer, backend, and panel heading.
9. Page tests cover both vendors, a busy handoff, more than two destinations, missing icons, every
   usage state, keyboard use, and a vendor switch while the panel is open.

## Implementation boundary

The destination control changed `src/webview.js`, the `switchTo` tab payload and `switchVendor`
message in `src/extension.js`, and their page and host tests. It did not change either agent or the
handoff contents.

The usage proposal remains a page and protocol change. It would reuse the existing meter readers,
session-usage reader, backend switches, and handoff machinery as its sources of truth, then update
notes 107 and 111 plus the README when built.
