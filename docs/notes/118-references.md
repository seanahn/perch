# 118 — References

## VS Code

- [Webview API](https://code.visualstudio.com/api/extension-guides/webview):
  panels, message passing, Content Security Policy, state and
  serialization.
- [Views guidelines](https://code.visualstudio.com/api/ux-guidelines/views):
  view containers and their chrome.
- [Supporting remote development](https://code.visualstudio.com/api/advanced-topics/remote-extensions):
  extension kinds, where `ui` and `workspace` extensions run, and
  commands across hosts.
- [Extension host](https://code.visualstudio.com/api/advanced-topics/extension-host).
- [API reference](https://code.visualstudio.com/api/references/vscode-api):
  `WebviewViewProvider`, `WebviewPanelSerializer`, `Memento`.
- [Contribution points](https://code.visualstudio.com/api/references/contribution-points):
  `views`, `menus`, `editor/title`.

## Claude

- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
  and [TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  breakpoints, lifetimes, pricing.
- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort).
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`: the authority
  for every SDK call perch makes. Where these notes and that file
  disagree, the file is right.

## Codex

- [openai/codex](https://github.com/openai/codex), and its
  [TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript).
- `codex app-server generate-ts`: prints the app-server protocol as
  TypeScript. Used to confirm that realtime voice exists only there.
- `~/.codex/models_cache.json`, `~/.codex/config.toml`,
  `~/.codex/sessions/`: formats observed on disk, not documented.

## Speech

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and
  [CTranslate2](https://github.com/OpenNMT/CTranslate2).
- [whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo).
- [PvRecorder](https://github.com/Picovoice/pvrecorder).

## Compared and related

- [AI Meter](https://github.com/seanahn/ai-meter): the origin of
  [note 111](111-usage-meters.md).
- [OpenCode](https://github.com/sst/opencode):
  `packages/opencode/src/provider/transform.ts`, `applyCaching`.
- [Continue](https://github.com/continuedev/continue).
- [LiteLLM prompt caching](https://docs.litellm.ai/docs/completion/prompt_caching).
- [Claude Code vs Cursor: token efficiency, 2026](https://www.futureproofing.dev/resources/ai-native-team/claude-code-vs-cursor-token-efficiency-2026)
  (futureproofing.dev): the public 5.5× figure, one run on mixed models,
  no cache analysis; read in [note 102](102-why-a-shell.md) for what it does and does not
  support.
- The user's controlled bench (2026-10-06): Claude Code and Cursor on Opus
  5.5 through Bedrock, same prompts, one price basis; the source of
  [note 102](102-why-a-shell.md)'s Cursor row.

## Observed, not documented

These are behaviours perch depends on that come from inspection rather
than from published documentation. Each may change without notice.

| Behaviour | Source |
| --- | --- |
| The Claude usage endpoint and its response | AI Meter; a live response |
| That endpoint returns 429 under load | Observed |
| Codex's rollout file format | Files on disk |
| Codex's model cache format | File on disk |
| Settings win over environment for `CLAUDE_CODE_USE_BEDROCK` | Verified empirically by AI Meter |
| ChatGPT dictation uploads to `/transcribe` | The ChatGPT extension's code |
| `workbench.action.unlockEditorGroup` given a file unlocks the first group, most recently used first, that has an editor of it, and otherwise the active group; before 1.92 it matched only a group's active editor, and passed the group's position where its id was wanted | VS Code's source (`resolveCommandsContext`, 1.92 to 1.129; `getCommandsContext`, 1.90 and 1.91) |
| A tab moved to another group is told as an open there, then a close whose tab's `group` is the group it left | VS Code's source (`extHostEditorTabs.ts`, 1.129) |
| The SDK's `default` model entry is Claude Code's built-in default, whatever `ANTHROPIC_MODEL` or the settings' `model` say | Probed, SDK 0.3.284 (2026-10-15) |
| On an idle CLI, `getContextUsage({ detail: 'summary' }).model` is the model a new session starts on, and makes no request; after `setModel(undefined)` it is the built-in default, which then answers | Probed, SDK 0.3.284 (2026-10-15) |
