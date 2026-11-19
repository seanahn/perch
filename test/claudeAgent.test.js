'use strict';
// What Perch answers Claude Code's permission callback (canUseTool), for each choice the user makes in a tab.
const assert = require('assert');
const { permissionResult } = require('../src/claudeAgent.js');

const ask = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
const cmd = { command: 'ls' };

// A "no" from the user ends the turn, as it does in Claude Code's own terminal: without interrupt the model goes on
// working on its own after the refusal, and the tab spins until Stop.
assert.deepStrictEqual(permissionResult('Bash', cmd, { decision: 'deny' }), { behavior: 'deny', message: 'Denied by user in perch', interrupt: true }, 'Deny ends the turn');
assert.deepStrictEqual(permissionResult('AskUserQuestion', ask, { decision: 'deny' }), { behavior: 'deny', message: 'The user did not answer.', interrupt: true }, 'Skip ends the turn');

// A refusal Perch makes itself, not the user (the tab restarted or closed), says why and does not interrupt:
// the process is going away anyway.
assert.deepStrictEqual(permissionResult('Bash', cmd, { decision: 'deny', message: 'session closed' }), { behavior: 'deny', message: 'session closed' }, 'a refusal of Perch\'s own does not interrupt');

// Answers and allows carry on, an answer of "No" included: the model is meant to act on it.
assert.deepStrictEqual(permissionResult('AskUserQuestion', ask, { decision: 'answer', answers: { 'Proceed?': 'No' } }),
  { behavior: 'allow', updatedInput: { questions: ask.questions, answers: { 'Proceed?': 'No' } } }, 'an answer goes back in the tool\'s input');
assert.deepStrictEqual(permissionResult('Bash', cmd, { decision: 'allow' }), { behavior: 'allow', updatedInput: cmd });
assert.deepStrictEqual(permissionResult('Bash', cmd, { decision: 'always' }, [{ type: 'addRules' }]), { behavior: 'allow', updatedInput: cmd, updatedPermissions: [{ type: 'addRules' }] });

// ---- The working indicator. Claude Code can go straight from one turn into another without going idle: a background task's
// notification, queued during the turn, runs as soon as the turn's result is out (seen 2026-11-19 on seclab: a background
// command finished while the user's message was being answered). Its own word, running or idle, decides; a result alone
// does not end the work while it says running.
{
  const { ClaudeAgent } = require('../src/claudeAgent.js');
  const P = ClaudeAgent.prototype;
  const make = () => { const out = []; const a = { live: '', waiting: [], running: false, pending: 0, lastCost: null, emit: (e) => out.push(e), _context() {}, _taken: P._taken, _answered: P._answered, _retract: P._retract, _fellBack: P._fellBack, _settle: P._settle, _state: P._state }; return { a, out, say: (m) => P._onMessage.call(a, m) }; };
  const busy = (out) => out.filter((e) => e.kind === 'busy').map((e) => e.busy);
  const state = (s) => ({ type: 'system', subtype: 'session_state_changed', state: s });
  const result = { type: 'result', subtype: 'success' };

  // the user's message is answered, and the notification's turn follows without a pause: working throughout, then idle
  let t = make(); t.a.running = true; t.a.pending = 1;
  t.say(state('running')); t.say(result);
  assert.deepStrictEqual(busy(t.out), [], 'the result of one turn, with Claude Code still running: still working');
  t.say(result); t.say(state('idle'));
  assert.deepStrictEqual(busy(t.out), [false], 'idle when Claude Code says idle');

  // the usual case: idle follows the result, once
  t = make(); t.a.running = true; t.a.pending = 1;
  t.say(state('running')); t.say(result); t.say(state('idle'));
  assert.deepStrictEqual(busy(t.out), [false]);

  // an older CLI that says nothing of its state: the result ends the turn, as before
  t = make(); t.a.running = true; t.a.pending = 1;
  t.say(result);
  assert.deepStrictEqual(busy(t.out), [false], 'without the state words, the result decides');
}

console.log('CLAUDE AGENT OK');
