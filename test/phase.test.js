'use strict';
// The workflow phase from skill names, slash commands and Perch's agent events.
const assert = require('assert');
const { PHASES, phaseOfSkill, skillOfSlash, phaseFromEvents } = require('../src/phase');

assert.deepStrictEqual(PHASES, ['Design', 'Plan', 'Build', 'Finish']);

// ---- phaseOfSkill
const BY_PHASE = {
  brainstorming: 'Design', 'resuming-design-work': 'Design', 'writing-plans': 'Plan',
  'using-git-worktrees': 'Build', 'executing-plans': 'Build', 'subagent-driven-development': 'Build',
  'finishing-a-development-branch': 'Finish',
};
for (const [skill, phase] of Object.entries(BY_PHASE)) {
  for (const prefix of ['', 'superpowers:', 'trivialpowers:', 'x:y:']) assert.strictEqual(phaseOfSkill(prefix + skill), phase, prefix + skill);
}
for (const bad of ['test-driven-development', '', undefined]) assert.strictEqual(phaseOfSkill(bad), null, String(bad));

// ---- skillOfSlash
assert.strictEqual(skillOfSlash('/brainstorming the thing'), 'brainstorming');
assert.strictEqual(skillOfSlash('/trivialpowers:writing-plans'), 'trivialpowers:writing-plans');
for (const bad of ['brainstorming', ' /x', '/', undefined]) assert.strictEqual(skillOfSlash(bad), null, String(bad));

// ---- phaseFromEvents
const use = (id, skill, extra) => Object.assign({ kind: 'tool_use', id, name: 'Skill', input: { skill } }, extra);
const res = (id, isError) => ({ kind: 'tool_result', id, isError: !!isError });
const ok = (id, skill) => [use(id, skill), res(id, false)];
const base = [...ok('a', 'trivialpowers:brainstorming'), ...ok('b', 'trivialpowers:writing-plans'), ...ok('c', 'test-driven-development')];
assert.deepStrictEqual(phaseFromEvents(base), { phase: 'Plan', skill: 'trivialpowers:writing-plans' });
assert.deepStrictEqual(phaseFromEvents([...ok('a', 'brainstorming'), use('b', 'writing-plans'), res('b', true)]), { phase: 'Design', skill: 'brainstorming' });
assert.deepStrictEqual(phaseFromEvents([...ok('a', 'brainstorming'), use('b', 'writing-plans', { sub: true }), res('b', false)]), { phase: 'Design', skill: 'brainstorming' });
assert.deepStrictEqual(phaseFromEvents([...base, { kind: 'user', text: '/finishing-a-development-branch' }]), { phase: 'Finish', skill: 'finishing-a-development-branch' });
assert.strictEqual(phaseFromEvents([]), null);
console.log('phase ok');
