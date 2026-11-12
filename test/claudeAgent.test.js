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

console.log('CLAUDE AGENT OK');
