'use strict';
// The tab an installer's first start opens.
const assert = require('assert');
const { chooseFirstTab } = require('../src/firstTab');

const claude = { kind: 'claude', gateway: false }, gateway = { kind: 'claude', gateway: true }, codex = { kind: 'codex', gateway: false };
for (const [o, want, why] of [
  [{ gatewayReady: true, claudeReady: true, codexReady: true }, gateway, 'a usable gateway comes first'],
  [{ gatewayReady: true }, gateway, 'the gateway needs no other sign-in'],
  [{ claudeReady: true, codexReady: true }, claude, 'Claude signed in: Claude'],
  [{ claudeReady: true }, claude, 'Claude signed in'],
  [{ codexReady: true }, codex, 'only Codex signed in: Codex'],
  [{}, claude, 'nothing signed in: Claude, which offers the sign-in'],
  [undefined, claude, 'no answers at all'],
]) assert.deepStrictEqual(chooseFirstTab(o), want, why);

console.log('firstTab tests passed');
