# 113 — Security and privacy

## The page

| Measure | Detail |
| --- | --- |
| Content Security Policy | `default-src 'none'`. Scripts and styles by nonce. Images from the webview origin only |
| Resource roots | perch's directory and the two vendor extensions' directories, for their icons |
| No markup from data | Text from the host is set with `textContent`. `innerHTML` is used for static artwork only |
| Escaping | Icon URIs are escaped for the stylesheet and the script. Tests inject hostile strings on every surface |

## Credentials

| Secret | Read by | Sent to |
| --- | --- | --- |
| Claude OAuth token | `src/meter.js` | `api.anthropic.com/api/oauth/usage` only |
| Gateway token | `src/gateway.js`, from the user's env file into a gateway tab's process environment | the gateway, by Claude Code, through `src/relay.js`, which forwards the request's headers as they are and keeps nothing. The relay listens on `127.0.0.1` only, on a port of its own per process, and is gone with the process |
| Codex login | the Codex binary | OpenAI, by Codex. perch does not read it |

## Files perch writes outside its repository

| File | When | Safeguards |
| --- | --- | --- |
| `~/.claude/settings.json` | The backend switch | One key. Atomic. Refuses unparseable files |
| `~/.claude.json` | Terminal login fallback | Marks onboarding complete. Keeps an existing theme |
| The gateway file, `~/.config/gateway-claude/env` by default | "Open the File", when there is none | From a template with empty values. Mode 600. Never over an existing file |
| `~/.local/share/perch/voice/` | Voice setup | With consent |

## What leaves the machine

| Data | Destination |
| --- | --- |
| Conversations | Each vendor, through its own agent |
| Usage query | Anthropic |
| Audio | Nowhere. From the UI machine to the workspace machine over VS Code's connection, and no further |
| Codex usage, cost-mode figures | Nowhere |

## Vendor icons

perch ships no logos. Icons are read at runtime from the installed vendor
extensions, so no trademarked artwork is redistributed and the icons
track vendor updates. Without an extension, a tab shows a letter.
