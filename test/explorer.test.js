'use strict';
// The skills Claude Code loads, as the Perch view lists them: where each comes from, what it is for, and its file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSkills, skillHead, listMcp, listAgents, listCommands } = require('../src/explorer.js');

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
  write(path.join(dir, '.claude', 'skills', 'c3-acls', 'references', 'reference.md'), 'more');
  write(path.join(dir, '.claude', 'skills', 'c3-acls', 'scripts', 'check.py'), 'print(1)');
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
    { name: 'c3-acls', source: 'this folder', description: 'ACLs on C3.', file: proj, files: ['SKILL.md', 'references/reference.md', 'scripts/check.py'] },
    { name: 'notes', source: 'yours', description: 'My notes.', file: mine, files: ['SKILL.md'] },
    { name: 'anthropic-skills:pptx', source: 'claude.ai', description: 'Slides.', file: synced, files: ['SKILL.md'] },
    { name: 'trivialpowers:brainstorming', source: 'trivialpowers', description: 'Before creative work.', file: plug, files: ['SKILL.md'] },
  ], 'this folder\'s, then yours, each with the files of its folder, SKILL.md first, then claude.ai\'s, then each enabled plugin\'s; a folder with no SKILL.md, and a plugin turned off, left out');
  assert.deepStrictEqual(listSkills({ dir: path.join(tmp, 'nowhere'), home: path.join(tmp, 'no-home') }), [], 'nothing there: none, and no error');

  // ---- MCP servers: each config Claude Code reads, and Codex's; by name, what it runs or where it is, never its env
  const codexHome = path.join(tmp, 'codex');
  const mcpJson = write(path.join(dir, '.mcp.json'), '{\n  "mcpServers": {\n    "browser": {\n      "command": "node",\n      "args": ["/w/mcp/screenshot.js"],\n      "env": { "COOKIE_SECRET": "s3cret" }\n    },\n    "jira": { "command": "/bin/jira-mcp" }\n  }\n}\n');
  const userJson = write(path.join(tmp, 'claude.json'), JSON.stringify({ mcpServers: { ms365: { type: 'http', url: 'https://ms.example/mcp', headers: { Authorization: 'Bearer t0ken' } } }, projects: { [dir]: { mcpServers: { local1: { command: 'local-mcp' } } } } }, null, 2));
  write(path.join(install, '.mcp.json'), JSON.stringify({ mcpServers: { tp: { command: '${CLAUDE_PLUGIN_ROOT}/bin/tp' } } }));
  const toml = write(path.join(codexHome, 'config.toml'), 'model = "x"\n\n[mcp_servers.codebase]\ncommand = "python3"\nargs = ["/srv/server.py"]\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\nbearer_token_env_var = "TOKEN"\n');
  const mcp = listMcp({ dir, home, userFile: userJson, codexHome });
  assert.deepStrictEqual(mcp.map((x) => [x.name, x.source, x.description, path.basename(x.file), x.line]), [
    ['browser', 'this folder', 'node /w/mcp/screenshot.js', '.mcp.json', 3],
    ['jira', 'this folder', '/bin/jira-mcp', '.mcp.json', 8],
    ['local1', 'this folder (yours)', 'local-mcp', 'claude.json', 0],
    ['ms365', 'yours', 'http https://ms.example/mcp', 'claude.json', 0],
    ['tp', 'trivialpowers', '${CLAUDE_PLUGIN_ROOT}/bin/tp', '.mcp.json', 0],
    ['codebase', 'codex', 'python3 /srv/server.py', 'config.toml', 3],
    ['docs', 'codex', 'https://docs.example/mcp', 'config.toml', 7],
  ], 'this folder\'s, yours for this folder, yours everywhere, each plugin\'s, then Codex\'s; with the line its entry starts on where the file can say');
  assert(!JSON.stringify(mcp).includes('s3cret') && !JSON.stringify(mcp).includes('t0ken'), 'no env value or header is carried');
  assert.strictEqual(mcp[0].file, mcpJson); assert.strictEqual(mcp[5].file, toml);

  // ---- agents and commands: their own Markdown files, the folder's, yours and each plugin's
  const agent = write(path.join(dir, '.claude', 'agents', 'reviewer.md'), md('reviewer', 'Reviews a diff.'));
  write(path.join(home, 'agents', 'helper.md'), '---\ndescription: Helps.\n---\nbody');
  const cmd = write(path.join(dir, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it.\n---\nDo it');
  write(path.join(dir, '.claude', 'commands', 'git', 'sync.md'), 'Sync with origin.\nMore.');
  write(path.join(install, 'commands', 'plan.md'), '---\ndescription: Plan.\n---\n');
  assert.deepStrictEqual(listAgents({ dir, home }).map((x) => [x.name, x.source, x.description]), [['reviewer', 'this folder', 'Reviews a diff.'], ['helper', 'yours', 'Helps.']]);
  assert.strictEqual(listAgents({ dir, home })[0].file, agent);
  assert.deepStrictEqual(listCommands({ dir, home }).map((x) => [x.name, x.source, x.description]), [['/git:sync', 'this folder', 'Sync with origin.'], ['/ship', 'this folder', 'Ship it.'], ['/trivialpowers:plan', 'trivialpowers', 'Plan.']], 'a folder under commands/ is a namespace; with no description, the first line');
  assert.strictEqual(listCommands({ dir, home })[1].file, cmd);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log('EXPLORER OK');
