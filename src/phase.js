'use strict';
// The workflow phase a conversation is in, from the workflow skills it has called.
const PHASES = ['Design', 'Plan', 'Build', 'Finish'];
const PHASE_OF = {
  brainstorming: 'Design', 'resuming-design-work': 'Design',
  'writing-plans': 'Plan',
  'using-git-worktrees': 'Build', 'executing-plans': 'Build', 'subagent-driven-development': 'Build',
  'finishing-a-development-branch': 'Finish',
};

// Matched on the name after the last ':'; a bare name matches too.
function phaseOfSkill(name) {
  if (typeof name !== 'string') return null;
  const base = name.slice(name.lastIndexOf(':') + 1);
  return Object.prototype.hasOwnProperty.call(PHASE_OF, base) ? PHASE_OF[base] : null;
}

// The skill a message names by starting with /name or /plugin:name (first token only; /name/path is a path, not a command).
function skillOfSlash(text) {
  const m = typeof text === 'string' ? /^\/([^\s/]+)(?=\s|$)/.exec(text) : null;
  return m ? m[1] : null;
}

// A bare name, in full when exactly one command of Claude Code's list is named <plugin>:<name> (Claude Code runs that one); else as it is.
function resolveSkill(name, commands) {
  if (typeof name !== 'string' || !name || name.includes(':')) return name;
  const full = (commands || []).map((c) => c && c.name).filter((n) => typeof n === 'string' && n.length > name.length + 1 && n.endsWith(':' + name));
  return full.length === 1 ? full[0] : name;
}

// The last workflow skill in the main conversation: a Skill call once its result has come back ok, or a user slash command.
// In Build, the hints for its task count (taskProgress): `ledger`, the last SDD ledger any tool call named, and `args`, what
// the skill was given; each only when there is one.
function phaseFromEvents(events) {
  const calls = new Map();   // Skill calls waiting for their result, by tool_use id
  let found = null, ledger = null;
  for (const e of events || []) {
    if (!e) continue;
    let skill = null, args = null;
    if (e.kind === 'tool_use') { const l = ledgerOfInput(e.input); if (l) ledger = l; }
    if (e.kind === 'tool_use' && e.name === 'Skill' && !e.sub) calls.set(e.id, e.input);
    else if (e.kind === 'tool_result' && calls.has(e.id)) { const i = calls.get(e.id); calls.delete(e.id); if (!e.isError && i) { skill = i.skill; args = i.args; } }
    else if (e.kind === 'user') { skill = skillOfSlash(e.text); if (skill) args = String(e.text).slice(skill.length + 1).trim(); }
    const phase = phaseOfSkill(skill);
    if (phase) found = Object.assign({ phase, skill }, typeof args === 'string' && args ? { args } : {});
  }
  if (found && found.phase === 'Build' && ledger) found.ledger = ledger;
  return found;
}

// ---- Build's task count (Sean, 2026-11-24): from subagent-driven-development's ledger, <repo>/.superpowers/sdd/<plan>/progress.md

// The last SDD ledger a tool call's input names (a command, a file path, a prompt), as written there; null if none.
const LEDGER_RE = /[^\s"'`()<>|;&=\\]*\.superpowers\/sdd\/[^\s"'`()<>|;&=\\/]+\/progress\.md/g;
function ledgerOfInput(input) {
  let s; try { s = typeof input === 'string' ? input : JSON.stringify(input); } catch (_) { return null; }
  const all = typeof s === 'string' ? s.match(LEDGER_RE) : null;
  return all ? all[all.length - 1] : null;
}
function ledgerFromEvents(events) {
  let ledger = null;
  for (const e of events || []) if (e && e.kind === 'tool_use') { const l = ledgerOfInput(e.input); if (l) ledger = l; }
  return ledger;
}

// A ledger's text: the plan its first line names ('# SDD ledger — plan: <path>', else null), and how many distinct tasks are complete.
function parseLedger(text) {
  const lines = String(text || '').split(/\r?\n/);
  const head = /^# SDD ledger\s*[—–-]+\s*plan:\s*(.+?)\s*$/.exec(lines[0] || '');
  const done = new Set();
  for (const l of lines) { const m = /^Task (\d+): complete/.exec(l); if (m) done.add(Number(m[1])); }
  return { plan: head ? head[1] : null, done: done.size };
}

// How many tasks a plan has: its '### Task <N>:' headings.
function planTasks(text) { return (String(text || '').match(/^### Task \d+:/gm) || []).length; }

// The plan file a skill's args name: the first token ending .md.
function planOfArgs(args) {
  const m = typeof args === 'string' ? /(?:^|\s)["']?([^\s"']+\.md)\b/.exec(args) : null;
  return m ? m[1] : null;
}

/**
 * Build's progress, { done, total }, from the phase's hints: its ledger, else the one the plan in its args has, at
 * <git root of the plan>/.superpowers/sdd/<plan's name>/progress.md. Relative paths are the tab's folder's. Null when there
 * is no ledger, no plan, a plan with no tasks, or anything cannot be read.
 */
async function taskProgress(hint, { cwd, fs = require('fs') } = {}) {
  const path = require('path');
  if (!hint || hint.phase !== 'Build') return null;
  const base = cwd || process.cwd();
  try {
    let ledger = hint.ledger ? path.resolve(base, hint.ledger.replace(/^~(?=\/)/, require('os').homedir())) : null;
    const argPlan = planOfArgs(hint.args) ? path.resolve(base, planOfArgs(hint.args)) : null;
    if (!ledger && argPlan) {
      let root = path.dirname(argPlan);
      while (!(await exists(fs, path.join(root, '.git')))) { const up = path.dirname(root); if (up === root) return null; root = up; }
      ledger = path.join(root, '.superpowers', 'sdd', path.basename(argPlan, '.md'), 'progress.md');
    }
    if (!ledger) return null;
    const parsed = parseLedger(await fs.promises.readFile(ledger, 'utf8'));
    const root = ledger.slice(0, ledger.lastIndexOf(path.sep + '.superpowers' + path.sep + 'sdd' + path.sep));
    const plan = parsed.plan ? path.resolve(root, parsed.plan) : argPlan;
    if (!plan) return null;
    const total = planTasks(await fs.promises.readFile(plan, 'utf8'));
    return total ? { done: Math.min(parsed.done, total), total } : null;
  } catch (_) { return null; }
}
async function exists(fs, p) { try { await fs.promises.stat(p); return true; } catch (_) { return false; } }

// The workflow plugin Claude Code has loaded, from its command list: the first command named <plugin>:brainstorming gives the
// plugin and the command that starts a workflow, short when it is the only one by that name. Null when no plugin offers it.
function workflowOf(commands) {
  const names = (commands || []).map((c) => c && c.name).filter((n) => typeof n === 'string' && n.lastIndexOf(':') > 0 && n.slice(n.lastIndexOf(':') + 1) === 'brainstorming');
  if (!names.length) return null;
  const first = names[0];
  return { plugin: first.slice(0, first.lastIndexOf(':')), command: names.length === 1 ? '/brainstorming' : '/' + first };
}

module.exports = { PHASES, phaseOfSkill, skillOfSlash, resolveSkill, phaseFromEvents, workflowOf, ledgerOfInput, ledgerFromEvents, parseLedger, planTasks, planOfArgs, taskProgress };
