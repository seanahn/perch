'use strict';
// The workflow phase from skill names, slash commands and Perch's agent events.
const assert = require('assert');
const { PHASES, phaseOfSkill, skillOfSlash, resolveSkill, phaseFromEvents, workflowOf, ledgerOfInput, ledgerFromEvents, parseLedger, planTasks, planOfArgs, taskProgress } = require('../src/phase');
const fs = require('fs'), os = require('os'), path = require('path');

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
assert.strictEqual(skillOfSlash('/writing-plans'), 'writing-plans');
// a path is not a command name
assert.strictEqual(skillOfSlash('/writing-plans/notes.md please'), null);
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
// a Skill call with no result yet does not count (live waits for the ok result too)
assert.deepStrictEqual(phaseFromEvents([...ok('a', 'brainstorming'), use('b', 'writing-plans')]), { phase: 'Design', skill: 'brainstorming' });
assert.strictEqual(phaseFromEvents([]), null);
// ---- resolveSkill
const L = (...n) => n.map((name) => ({ name }));
assert.strictEqual(resolveSkill('brainstorming', L('x:brainstorming')), 'x:brainstorming');
assert.strictEqual(resolveSkill('brainstorming', L('x:brainstorming', 'y:brainstorming')), 'brainstorming');
assert.strictEqual(resolveSkill('brainstorming', L('brainstorming', 'x:plan-brainstorming')), 'brainstorming');
assert.strictEqual(resolveSkill('x:brainstorming', L('y:x:brainstorming')), 'x:brainstorming');
assert.strictEqual(resolveSkill(null, L('x:a')), null);
assert.strictEqual(resolveSkill('a', undefined), 'a');
// ---- workflowOf: the workflow plugin Claude Code has loaded, and the command that starts it
assert.deepStrictEqual(workflowOf(L('clear', 'trivialpowers:brainstorming', 'trivialpowers:writing-plans')), { plugin: 'trivialpowers', command: '/brainstorming' }, 'one plugin offers it: the short command');
assert.deepStrictEqual(workflowOf(L('x:y:brainstorming')), { plugin: 'x:y', command: '/brainstorming' }, 'the plugin is the part before the last colon');
assert.deepStrictEqual(workflowOf(L('a:brainstorming', 'b:brainstorming')), { plugin: 'a', command: '/a:brainstorming' }, 'two plugins offer it: the first, in full');
for (const none of [L('clear', 'brainstorming', 'x:plan-brainstorming', 'x:brainstorming-more'), [], undefined, [null, {}]]) assert.strictEqual(workflowOf(none), null, JSON.stringify(none));

// ---- Build's task count (Sean, 2026-11-24): the SDD ledger and the plan
const LEDGER = [
  '# SDD ledger — plan: docs/superpowers/plans/2026-11-24-x.md', 'Worktree /w, branch feat/x.', '', '## Rulings', '- Ruling: R1 — Task 4: complete is not at the line start',
  'Task 1: dispatched (BASE eca6df3)', 'Task 1: complete (commits eca6df3..8db6c71, review clean)', 'Task 2: complete', 'Task 2: complete (again, after a fix round)',
  'Task 3: review: spec ✅', 'Task 10: complete (commits a..b)', 'Task 5: completed (anything may follow "complete")', '  Task 6: complete (indented: not a ledger line)',
].join('\n');
assert.deepStrictEqual(parseLedger(LEDGER), { plan: 'docs/superpowers/plans/2026-11-24-x.md', done: 4 }, 'distinct task numbers, counted once each');
assert.deepStrictEqual(parseLedger(LEDGER.split('\n').slice(1).join('\n')), { plan: null, done: 4 }, 'no first line: the count, but no plan');
assert.deepStrictEqual(parseLedger('# SDD ledger - plan: /abs/plan.md\r\nTask 1: complete\r\n'), { plan: '/abs/plan.md', done: 1 }, 'an absolute plan, CRLF, a plain hyphen');
assert.deepStrictEqual(parseLedger(''), { plan: null, done: 0 });
const PLAN = ['# Plan', '### Task 1: one', 'text ### Task 9: not a heading', '### Task 2: two', '#### Task 3: too deep', '### Task 3: three', '### Tasks: no number'].join('\n');
assert.strictEqual(planTasks(PLAN), 3, "'### Task <N>:' headings");
assert.strictEqual(planTasks(''), 0);
// the ledger a tool call names: a command, a file path, a prompt; the last one in it
assert.strictEqual(ledgerOfInput({ command: 'cat /git/r.wt/.superpowers/sdd/2026-x/progress.md && echo ok' }), '/git/r.wt/.superpowers/sdd/2026-x/progress.md');
assert.strictEqual(ledgerOfInput({ file_path: '/git/r/.superpowers/sdd/p/progress.md' }), '/git/r/.superpowers/sdd/p/progress.md');
assert.strictEqual(ledgerOfInput({ prompt: 'Append to "/a/.superpowers/sdd/one/progress.md", then read `/b/.superpowers/sdd/two/progress.md`.' }), '/b/.superpowers/sdd/two/progress.md', 'the last one');
assert.strictEqual(ledgerOfInput('echo x >> .superpowers/sdd/p/progress.md'), '.superpowers/sdd/p/progress.md', 'relative, as written');
for (const none of [{ command: 'ls .superpowers/sdd/' }, { file_path: '/a/.superpowers/sdd/p/notes.md' }, { file_path: '/a/.superpowers/sdd/p/q/progress.md' }, null, undefined]) assert.strictEqual(ledgerOfInput(none), null, JSON.stringify(none));
const bash = (id, command, extra) => Object.assign({ kind: 'tool_use', id, name: 'Bash', input: { command } }, extra);
assert.strictEqual(ledgerFromEvents([bash('1', 'cat /a/.superpowers/sdd/p/progress.md'), { kind: 'tool_use', id: '2', name: 'Read', input: { file_path: '/b/.superpowers/sdd/q/progress.md' } }, bash('3', 'ls')]), '/b/.superpowers/sdd/q/progress.md', 'the most recent');
assert.strictEqual(ledgerFromEvents([{ kind: 'text', text: '/a/.superpowers/sdd/p/progress.md' }]), null, 'tool calls only');
// phaseFromEvents: in Build, the ledger and the skill's args as hints; never in another phase, and none when there are none
const useA = (id, skill, args) => ({ kind: 'tool_use', id, name: 'Skill', input: { skill, args } });
assert.deepStrictEqual(phaseFromEvents([useA('a', 'trivialpowers:subagent-driven-development', 'docs/plans/x.md'), res('a'), bash('b', 'cat /w/.superpowers/sdd/x/progress.md', { sub: true })]),
  { phase: 'Build', skill: 'trivialpowers:subagent-driven-development', args: 'docs/plans/x.md', ledger: '/w/.superpowers/sdd/x/progress.md' }, 'a sub-agent\'s call names it too');
assert.deepStrictEqual(phaseFromEvents([bash('b', 'cat /w/.superpowers/sdd/x/progress.md'), ...ok('a', 'writing-plans')]), { phase: 'Plan', skill: 'writing-plans' }, 'not in Plan');
assert.deepStrictEqual(phaseFromEvents([{ kind: 'user', text: '/subagent-driven-development docs/plans/x.md' }]), { phase: 'Build', skill: 'subagent-driven-development', args: 'docs/plans/x.md' }, 'a slash command\'s args');
assert.strictEqual(planOfArgs('run "docs/superpowers/plans/2026-x.md" please'), 'docs/superpowers/plans/2026-x.md');
assert.strictEqual(planOfArgs('no plan here'), null);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-phase-')), repo = path.join(root, 'repo.wt'), plans = path.join(repo, 'docs', 'plans');
  fs.mkdirSync(plans, { recursive: true }); fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere\n');   // a worktree's .git is a file
  fs.writeFileSync(path.join(plans, 'x.md'), Array.from({ length: 9 }, (_, i) => `### Task ${i + 1}: t\n`).join(''));
  const dir = path.join(repo, '.superpowers', 'sdd', 'x'), ledger = path.join(dir, 'progress.md'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledger, '# SDD ledger — plan: docs/plans/x.md\n' + [1, 2, 3, 4, 5].map((n) => `Task ${n}: complete (commits a..b)\n`).join('') + 'Task 6: dispatched\n');
  const B = (o) => Object.assign({ phase: 'Build', skill: 'subagent-driven-development' }, o);
  assert.deepStrictEqual(await taskProgress(B({ ledger })), { done: 5, total: 9 }, 'the plan relative to the ledger\'s repo, whatever the tab\'s folder');
  assert.deepStrictEqual(await taskProgress(B({ ledger: '.superpowers/sdd/x/progress.md' }), { cwd: repo }), { done: 5, total: 9 }, 'a relative ledger: the tab\'s folder\'s');
  assert.deepStrictEqual(await taskProgress(B({ args: 'docs/plans/x.md' }), { cwd: repo }), { done: 5, total: 9 }, 'no ledger named: the one at the git root of the plan in its args');
  assert.deepStrictEqual(await taskProgress(B({ args: path.join(plans, 'x.md') }), { cwd: '/' }), { done: 5, total: 9 }, 'an absolute plan');
  fs.writeFileSync(path.join(plans, 'abs.md'), '### Task 1: a\n### Task 2: b\n');
  fs.writeFileSync(ledger, `# SDD ledger — plan: ${path.join(plans, 'abs.md')}\nTask 1: complete\n`);
  assert.deepStrictEqual(await taskProgress(B({ ledger })), { done: 1, total: 2 }, 'an absolute plan path in the ledger; read again each time');
  fs.writeFileSync(ledger, 'Task 1: complete\nTask 2: complete\n');
  assert.strictEqual(await taskProgress(B({ ledger })), null, 'no first line and no plan in the args: no count');
  assert.deepStrictEqual(await taskProgress(B({ ledger, args: path.join(plans, 'x.md') })), { done: 2, total: 9 }, 'no first line: the plan in the args');
  for (const [hint, why] of [[B({}), 'no ledger, no plan'], [B({ ledger: path.join(root, 'none', '.superpowers', 'sdd', 'x', 'progress.md') }), 'no such ledger'], [B({ args: path.join(root, 'nowhere.md') }), 'a plan outside any repo'],
    [{ phase: 'Plan', skill: 'writing-plans', ledger }, 'not Build'], [null, 'no phase']]) assert.strictEqual(await taskProgress(hint), null, why);
  fs.writeFileSync(ledger, '# SDD ledger — plan: docs/plans/empty.md\nTask 1: complete\n'); fs.writeFileSync(path.join(plans, 'empty.md'), '# no tasks\n');
  assert.strictEqual(await taskProgress(B({ ledger })), null, 'a plan with no tasks');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('phase ok');
})().catch((e) => { console.error(e); process.exit(1); });
