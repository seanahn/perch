'use strict';
// The skills Claude Code loads, as the Perch view lists them: where each comes from, what it is for, and its file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSkills, skillHead } = require('../src/skills.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-skills-'));
try {
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const md = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

  // what a SKILL.md says of itself: its name and description, a folded or literal block too
  assert.deepStrictEqual(skillHead('---\nname: c3-acls\ndescription: |\n  Implements ACLs.\n  Use this skill when:\n    (1) adding\nversion: 2\n---\nbody'), { name: 'c3-acls', description: 'Implements ACLs. Use this skill when: (1) adding' });
  assert.deepStrictEqual(skillHead('---\nname: "quoted"\ndescription: >\n  One\n  line.\n---\n'), { name: 'quoted', description: 'One line.' });
  assert.deepStrictEqual(skillHead('# no front matter'), { name: '', description: '' });

  const dir = path.join(tmp, 'work'), home = path.join(tmp, 'claude');
  const proj = write(path.join(dir, '.claude', 'skills', 'c3-acls', 'SKILL.md'), md('c3-acls', 'ACLs on C3.'));
  write(path.join(dir, '.claude', 'skills', 'no-file-here', 'README.md'), 'not a skill');
  const mine = write(path.join(home, 'skills', 'notes', 'SKILL.md'), md('notes', 'My notes.'));
  const synced = write(path.join(home, 'skills', 'synced', 'abc_123', 'pptx', 'SKILL.md'), md('pptx', 'Slides.'));
  const install = path.join(home, 'plugins', 'cache', 'dev', 'trivialpowers', '7.0.0');
  const plug = write(path.join(install, 'skills', 'brainstorming', 'SKILL.md'), md('brainstorming', 'Before creative work.'));
  write(path.join(home, 'plugins', 'cache', 'dev', 'off', '1.0', 'skills', 'hidden', 'SKILL.md'), md('hidden', 'From a plugin that is not enabled.'));
  write(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'trivialpowers@dev': [{ scope: 'user', installPath: install, version: '7.0.0' }],
    'off@dev': [{ scope: 'user', installPath: path.join(home, 'plugins', 'cache', 'dev', 'off', '1.0'), version: '1.0' }] } }));
  write(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'trivialpowers@dev': true, 'off@dev': false } }));

  assert.deepStrictEqual(listSkills({ dir, home }), [
    { name: 'c3-acls', source: 'folder', description: 'ACLs on C3.', file: proj },
    { name: 'notes', source: 'yours', description: 'My notes.', file: mine },
    { name: 'anthropic-skills:pptx', source: 'claude.ai', description: 'Slides.', file: synced },
    { name: 'trivialpowers:brainstorming', source: 'trivialpowers', description: 'Before creative work.', file: plug },
  ], 'this folder\'s, then yours, then claude.ai\'s, then each enabled plugin\'s; a folder with no SKILL.md, and a plugin turned off, left out');
  assert.deepStrictEqual(listSkills({ dir: path.join(tmp, 'nowhere'), home: path.join(tmp, 'no-home') }), [], 'nothing there: none, and no error');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log('SKILLS OK');
