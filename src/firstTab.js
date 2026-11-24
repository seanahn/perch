'use strict';
// Which tab an installer's first start opens (perch.firstStart.openClaudeTab): the agent that can answer at once.
// No VS Code dependency. (Sean, 2026-11-24)

/**
 * A gateway set up and usable: a Claude tab on it. Else Claude signed in (a login or an API key): a Claude tab. Else
 * Codex signed in (its ChatGPT login or an API key): a Codex tab. Else a Claude tab, which offers the sign-in.
 * @param {{ gatewayReady?: boolean, claudeReady?: boolean, codexReady?: boolean }} o
 * @returns {{ kind: 'claude'|'codex', gateway: boolean }}
 */
function chooseFirstTab({ gatewayReady, claudeReady, codexReady } = {}) {
  if (gatewayReady) return { kind: 'claude', gateway: true };
  if (claudeReady) return { kind: 'claude', gateway: false };
  if (codexReady) return { kind: 'codex', gateway: false };
  return { kind: 'claude', gateway: false };
}

module.exports = { chooseFirstTab };
