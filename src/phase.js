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
function phaseFromEvents(events) {
  const calls = new Map();   // Skill calls waiting for their result, by tool_use id
  let found = null;
  for (const e of events || []) {
    if (!e) continue;
    let skill = null;
    if (e.kind === 'tool_use' && e.name === 'Skill' && !e.sub) calls.set(e.id, e.input && e.input.skill);
    else if (e.kind === 'tool_result' && calls.has(e.id)) { const s = calls.get(e.id); calls.delete(e.id); if (!e.isError) skill = s; }
    else if (e.kind === 'user') skill = skillOfSlash(e.text);
    const phase = phaseOfSkill(skill);
    if (phase) found = { phase, skill };
  }
  return found;
}

module.exports = { PHASES, phaseOfSkill, skillOfSlash, resolveSkill, phaseFromEvents };
