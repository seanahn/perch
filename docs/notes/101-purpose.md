# 101 — Purpose

Version 0.6.0, 2026-09-30. These notes describe perch as built, the
reasons behind its shape, and what has and has not been verified. Setup
and everyday use are in [README.md](../../README.md).

perch puts Claude Code and Codex in one VS Code extension: any number of
sessions of either kind, each in its own tab, each looking and behaving
like its vendor's own panel.

It exists because running two vendor extensions means two panels, two
sets of habits, and no way to pass work between them, while the tools
that do unify models do it by replacing the agent.

The reason it is written this way, rather than adopting Continue or
another harness that already unifies models, is token usage. perch reuses
the vendors' own agents, the Claude Code CLI and the Codex CLI, whole:
their prompt layout, their caching, their compaction, their logins. It
adds no request of its own. [Note 102](102-why-a-shell.md) argues the choice; [note 103](103-token-economy.md) sets
out how the reuse is achieved and what it was measured to cost.

## The notes

- [101 — Purpose](101-purpose.md)
- [102 — Why a shell and not an agent](102-why-a-shell.md)
- [103 — Token economy: how the reuse is achieved](103-token-economy.md)
- [104 — Architecture](104-architecture.md)
- [105 — Sessions and surfaces](105-sessions-and-surfaces.md)
- [106 — State, replay, and persistence](106-state-replay-and-persistence.md)
- [107 — The page protocol](107-page-protocol.md)
- [108 — The agents](108-agents.md)
- [109 — Model catalogs](109-model-catalogs.md)
- [110 — The composer](110-composer.md)
- [111 — Usage meters](111-usage-meters.md)
- [112 — Dictation](112-dictation.md)
- [113 — Security and privacy](113-security-and-privacy.md)
- [114 — Testing](114-testing.md)
- [115 — Verified and not verified](115-verified-and-not-verified.md)
- [116 — Limitations and open work](116-limitations-and-open-work.md)
- [117 — Decision log](117-decision-log.md)
- [118 — References](118-references.md)

Proposals:

- [201 — Codebase indexing for Perch tabs](201-codebase-indexing.md)
