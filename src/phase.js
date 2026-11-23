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

// The skill a message names by starting with /name or /plugin:name (first token only).
function skillOfSlash(text) {
  const m = typeof text === 'string' ? /^\/([^\s/]+)/.exec(text) : null;
  return m ? m[1] : null;
}

// The last workflow skill in the main conversation: a Skill call whose result succeeded, or a user slash command.
function phaseFromEvents(events) {
  const failed = new Set();
  for (const e of events || []) if (e && e.kind === 'tool_result' && e.isError) failed.add(e.id);
  let found = null;
  for (const e of events || []) {
    if (!e) continue;
    let skill = null;
    if (e.kind === 'tool_use' && e.name === 'Skill' && !e.sub && !failed.has(e.id)) skill = e.input && e.input.skill;
    else if (e.kind === 'user') skill = skillOfSlash(e.text);
    const phase = phaseOfSkill(skill);
    if (phase) found = { phase, skill };
  }
  return found;
}

module.exports = { PHASES, phaseOfSkill, skillOfSlash, phaseFromEvents };
