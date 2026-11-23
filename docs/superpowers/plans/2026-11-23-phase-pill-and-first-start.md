# Phase pill, default backend, first-start tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trivialpowers:subagent-driven-development (recommended) or trivialpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build note 203's three changes in Perch: the workflow phase pill with its hover card, `perch.claude.defaultBackend`, and `perch.firstStart.openClaudeTab`.

**Architecture:** A pure module `src/phase.js` maps skill names and slash commands to phases and finds the phase in a list of events. The host (`src/extension.js`) keeps the phase on each Claude session — from live `Skill` calls once their result is ok, from the user's slash commands, and from the session's whole record when it is reopened — and sends it on the tab description; the page (`src/webview.js`) draws the pill and card. The two settings are read in `addSession` and at activation.

**Tech Stack:** Node (VS Code extension host), the page script in a JS template literal, plain `assert` tests run by `make test-offline`, jsdom for the page.

**Spec:** `docs/notes/203-workflow-phase-and-first-start.md`

The design holds every design decision; this plan holds build steps and code-level names only, and is deleted when the work merges. If a decision changes during the build, change the design in the same commit.

## Global Constraints

- Phases and skills, verbatim: Design = `brainstorming`, `resuming-design-work`; Plan = `writing-plans`; Build = `using-git-worktrees`, `executing-plans`, `subagent-driven-development`; Finish = `finishing-a-development-branch`. Matched on the name after the last `:`; no prefix also matches.
- Order shown in the card: Design, Plan, Build, Finish. Card title: `Workflow phase`.
- Main conversation only; sub-agent skill calls never move the phase. A failed call (`isError`) does not count. A user slash command (`/brainstorming …`, `/trivialpowers:writing-plans`) counts.
- Claude tabs only; a Codex tab has no pill. No new state is persisted.
- `perch.claude.defaultBackend`: enum `remembered` (default) | `gateway`; read only while `perch.claude.newTabsOnGateway` (globalState) is `undefined`.
- `perch.firstStart.openClaudeTab`: boolean, default `false`; write `false` first, at the scope it was read from; never remove the key; a failed write opens nothing; any open Perch tab (editor or sidebar) → open nothing.
- The page script lives in a template literal: escapes like `\n` are written `\\n`; a `//` comment on a one-line arrow body swallows the rest of the line (`CLAUDE` rules in the project memory).
- Public repo: no company names in code, tests, notes or commit messages.
- `make test-offline` passes after every task; `make test` (live) before the final commit only.
- Commits as the repo's local git identity; end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A long session reopened** whose last workflow skill is older than the shown transcript (`MAX_PAST`) — the pill still shows it. Test: `phase found beyond the shown transcript` (Task 2).
2. **A sub-agent running `…:executing-plans`** inside a Plan-phase session — the pill stays Plan, live and after reopening. Test: `sub-agent skill calls do not move the phase` (Task 2).
3. **The user changes backend by hand after a `gateway` default** — new tabs follow the user from then on. Test: `the remembered choice wins over the setting` (Task 4).
4. **The first-start write fails** (setting held at a scope Perch cannot write) — no tab opens, no error dialog. Test: `a refused write opens nothing` (Task 5).
5. **A tab moved to Codex and back** — the Codex stretch has no pill; returning to the same Claude session shows its phase again. Test: `codex stretch hides the pill, return restores it` (Task 2).

---

### Task 1: `src/phase.js`

**Files:**
- Create: `src/phase.js`
- Test: `test/phase.test.js`; add `node test/phase.test.js` to `scripts["test:offline"]` in `package.json`

**Interfaces:**
- Produces:
  - `PHASES: string[]` = `['Design', 'Plan', 'Build', 'Finish']`
  - `phaseOfSkill(name: string): string | null`
  - `skillOfSlash(text: string): string | null` — the skill named by a message that starts with `/name` or `/plugin:name` (first token only), else null
  - `phaseFromEvents(events: object[]): { phase: string, skill: string } | null` — the last workflow skill in Perch's event list: a `tool_use` named `Skill` (no `sub`) whose matching `tool_result` (by `id`) has `isError` false, or a `user` event whose text `skillOfSlash` names; `skill` is the full name as given (`trivialpowers:writing-plans`)

- [ ] **Step 1: Write the failing tests** in `test/phase.test.js` (plain `assert`, as `test/sessionStore.test.js`):
  - `phaseOfSkill`: each of the seven skills with prefixes `superpowers:`, `trivialpowers:`, `x:y:` and none → its phase; `test-driven-development`, `''`, `undefined` → null.
  - `skillOfSlash('/brainstorming the thing')` → `'brainstorming'`; `'/trivialpowers:writing-plans'` → `'trivialpowers:writing-plans'`; `'brainstorming'`, `' /x'`, `'/'` → null.
  - `phaseFromEvents`: brainstorming ok, then writing-plans ok, then test-driven-development ok → `{ phase: 'Plan', skill: '…writing-plans' }`; a writing-plans `tool_use` whose result `isError` → stays Design; a `tool_use` with `sub: true` → ignored; a later user `/finishing-a-development-branch` → Finish; empty → null.
- [ ] **Step 2: Run** `node test/phase.test.js` — Expected: fails (`Cannot find module '../src/phase'`).
- [ ] **Step 3: Implement** the four exports in `src/phase.js` (no dependencies).
- [ ] **Step 4: Run** `make test-offline` — Expected: passes.
- [ ] **Step 5: Commit** `git add src/phase.js test/phase.test.js package.json && git commit -m "phase: the workflow phase from skill calls and slash commands"`

### Task 2: The host keeps each Claude session's phase

**Files:**
- Modify: `src/claudeAgent.js` (`case 'assistant'`, the `tool_use` emit ~line 242)
- Modify: `src/sessionStore.js` (`loadTranscript` ~623)
- Modify: `src/extension.js` (`Session.post`, the user-send path, `loadPast` ~480, `toTab` ~1054, the vendor switch that starts a new thread)
- Test: `test/claudeAgent.test.js`, `test/sessionStore.test.js`, `test/host.test.js`

**Interfaces:**
- Consumes: Task 1's `phaseFromEvents`, `phaseOfSkill`, `skillOfSlash`.
- Produces:
  - `tool_use` events gain `sub: boolean` (`!!m.parent_tool_use_id`).
  - `loadTranscript` returns `{ events, earlier, phase }`, `phase` = `phaseFromEvents` over **all** events, before the `limit` cut (Claude only; Codex → null).
  - `Session.phase: { phase, skill } | null`, in memory only (not in `toState`). Set: on a main-thread `Skill` `tool_use`, remember `id → input.skill`; on its `tool_result` with `isError` false, set the phase if `phaseOfSkill` maps it; on the user sending text that `skillOfSlash` maps; from `past.phase` in `loadPast`. Cleared when the tab starts a new Claude thread (handoff into a new session) and while the tab's current stretch is Codex.
  - `toTab()` gains `phase: this.kind === 'claude' ? this.phase : null`; the existing `tabs` message carries it. Changing the phase calls the existing tab refresh, as other footer fields do.

- [ ] **Step 1: Write the failing tests:**
  - `claudeAgent.test.js`: an assistant message with `parent_tool_use_id` set emits `tool_use` with `sub: true`; without, `sub: false`.
  - `sessionStore.test.js`: `phase found beyond the shown transcript` — a fake SDK session of 1200 entries whose only workflow skill (`x:writing-plans`, ok result) is first; `loadTranscript(..., { limit: 1000 })` → `earlier > 0`, `phase.phase === 'Plan'`.
  - `host.test.js` (with the fake engine of `test/stubs.js`: make it emit a `tool_use`/`tool_result` pair on a knob):
    - `skill sets the phase once its result is ok` — tab description `phase` null, then `{ phase: 'Design' }` after an ok `brainstorming` pair; an `isError` `writing-plans` pair leaves Design.
    - `sub-agent skill calls do not move the phase` — a `sub: true` `executing-plans` pair leaves the phase as it was.
    - `a slash command sets the phase` — sending `/writing-plans` → Plan.
    - `codex stretch hides the pill, return restores it` — switch the tab to Codex → `phase` null; back to the same Claude session → the phase from its record (`past.phase`).
    - `reopened tab gets its phase from the record` — persisted tab, reload (as existing reload tests do) → `phase` from `loadTranscript`'s `phase`.
- [ ] **Step 2: Run** `make test-offline` — Expected: the new assertions fail.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `make test-offline` — Expected: passes.
- [ ] **Step 5: Commit** `git commit -m "host: each Claude tab's workflow phase, live and from its record"` (explicit paths)

### Task 3: The pill and its card

**Files:**
- Modify: `src/webview.js` (footer construction near the backend pill `$mb`, ~1375–1430; CSS block near line 98)
- Test: `test/page.test.js`

**Interfaces:**
- Consumes: `tab.phase` from Task 2.
- Produces: a footer element `.phase` placed immediately after the backend pill: text = the phase; hidden when `tab.phase` is null or the tab is not Claude. A hover card `.phasecard` (title `Workflow phase`, one row per `PHASES` entry, the current row marked `▸` and given class `now` with the skill name beside it) opened on `mouseenter` and `focus` of the pill, closed on `mouseleave`, `blur` and Escape; the pill has `tabindex="0"` and `aria-describedby` pointing at the card. No click action. `PHASES` is written into the page as a literal (the page cannot require modules).

- [ ] **Step 1: Write the failing tests** in `test/page.test.js`: a `tabs` message with `phase: { phase: 'Plan', skill: 'trivialpowers:writing-plans' }` → `.phase` visible, text `Plan`, directly after the backend pill; `mouseenter` → `.phasecard` shown with rows `Design, Plan, Build, Finish`, the `Plan` row has class `now` and contains `trivialpowers:writing-plans`; Escape hides it; `phase: null` → `.phase` hidden; a Codex tab with a phase → hidden.
- [ ] **Step 2: Run** `make test-offline` — Expected: fails.
- [ ] **Step 3: Implement** in the page script, styled like the footer's other pills and panels (theme variables, no fixed colours).
- [ ] **Step 4: Run** `make test-offline` — Expected: passes (and the template-literal parse check at the top of page.test.js).
- [ ] **Step 5: Commit** `git commit -m "page: the workflow phase pill and its hover card"`

### Task 4: `perch.claude.defaultBackend`

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`)
- Modify: `src/extension.js` (`addSession` ~2165)
- Test: `test/host.test.js`

**Interfaces:**
- Produces: setting `perch.claude.defaultBackend`, `"enum": ["remembered", "gateway"]`, `"default": "remembered"`, description: "Where new Claude tabs start before you have chosen a backend for any tab. After you choose one in a tab's backend menu, new tabs follow your choice." In `addSession`, for a new (not resumed) Claude tab with no explicit `gateway`: `remembered = globalState.get(GATEWAY_DEFAULT_KEY)`; `gateway = remembered === undefined ? cfg('claude.defaultBackend') === 'gateway' : remembered === true`.

- [ ] **Step 1: Write the failing tests:** `gateway default with nothing remembered` — setting `gateway`, memento empty → `+` makes a tab with `gateway: true`; `the remembered choice wins over the setting` — then choose subscription in that tab's backend menu (as existing tests do) → the next `+` tab has `gateway: false`; setting `remembered` with nothing remembered → `gateway: false`.
- [ ] **Step 2: Run** `make test-offline` — Expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `make test-offline` — Expected: passes.
- [ ] **Step 5: Commit** `git commit -m "perch.claude.defaultBackend: where new Claude tabs start before a choice"`

### Task 5: `perch.firstStart.openClaudeTab`

**Files:**
- Modify: `package.json` (setting)
- Modify: `src/extension.js` (`PerchView.firstStart()`, called from `activate` once sessions are restored)
- Test: `test/host.test.js` (extend `test/stubs.js`'s configuration fake with `inspect` and a failing `update` knob if missing)

**Interfaces:**
- Produces: setting `perch.firstStart.openClaudeTab`, boolean, default `false`, description: "Open one Claude tab on the right the next time Perch starts, then set this back to false. For installers." `async firstStart(): Promise<void>`:
  1. `inspect('firstStart.openClaudeTab')`; not `true` at any scope → return.
  2. `await update(..., false, <the target that held true: Global / Workspace / WorkspaceFolder>)`; a throw → return silently (log to Perch's output channel only).
  3. any session in `this.sessions` (editor or sidebar) → return.
  4. `addSession('claude', { location: 'editor' })`, its panel opened at `vscode.ViewColumn.Beside`; then, if `vscode.window.tabGroups.all.length === 1` (the left group did not survive), open an empty untitled text document in `ViewColumn.One` with `preview: false`, focus back on the Perch tab.
  It runs after the restore grace period (`PERCH_RESTORE_GRACE_MS`), so a tab VS Code brings back counts as open.

- [ ] **Step 1: Write the failing tests:** `opens one tab and writes false` — global value `true`, no sessions → one Claude session, `update` called with `false` and the global target before it opens; `a restored tab means no new tab` — one restored session → no new session, `false` written; `a refused write opens nothing` — `update` rejects → no session, no `showErrorMessage`; `workspace scope is written back at workspace scope`; `false or absent does nothing` — no `update` call.
- [ ] **Step 2: Run** `make test-offline` — Expected: fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `make test-offline` — Expected: passes.
- [ ] **Step 5: Commit** `git commit -m "perch.firstStart.openClaudeTab: one Claude tab on the right, once"`

### Task 6: Real check, then the design and docs describe what was built

**Files:**
- Modify: `docs/notes/203-workflow-phase-and-first-start.md`, `docs/notes/110-features.md` (footer section), `README.md` (settings list), `package.json` (`version` → 0.7.37), `Makefile` (`OLD_IDS` += `seanahn.perch-0.7.36`)
- Delete: `docs/superpowers/plans/2026-11-23-phase-pill-and-first-start.md`

- [ ] **Step 1: `make test`** (live turns, real logins) — Expected: passes. Tests must never exercise the real backend switch.
- [ ] **Step 2: Live check in VS Code** (`make install`, reload): a Claude tab that runs a workflow skill shows the pill and card; a reload keeps it; a fresh user-data dir (`code --user-data-dir /tmp/perch-fs --extensions-dir ~/.vscode/extensions`) with `perch.firstStart.openClaudeTab: true` and `perch.claude.defaultBackend: "gateway"` opens one gateway Claude tab on the right, the left group kept, and the setting then reads `false`. Record whether the left group survived empty or needed the untitled editor.
- [ ] **Step 3: Update the design** to what was built: status line (built, version), the left-group outcome from Step 2, any rulings from the build; record the PR or merge commit and the SHA of the last commit that still contains this plan. Note 110's footer section gains the phase pill and the two settings; note 101's index line stays.
- [ ] **Step 4: README** — the two settings in its settings list, and a link to note 203; note 203 links back to the README.
- [ ] **Step 5: Version** 0.7.37 and `OLD_IDS`, per the project's rule.
- [ ] **Step 6: Delete this plan and commit** `git rm docs/superpowers/plans/2026-11-23-phase-pill-and-first-start.md && git add docs README.md package.json Makefile && git commit -m "0.7.37: workflow phase pill; defaultBackend and firstStart settings"`. Publishing is not part of this plan.
