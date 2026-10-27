'use strict';
// The handoff text of note 202, against made-up transcripts and a throwaway Claude config dir. No real ~/.claude.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const H = require('../src/handoff');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-handoff-'));

(async () => {
  // ---- a tool call as one line
  assert.strictEqual(H.toolLine('Read', { file_path: '/w/src/a.js' }, '/w'), 'Read src/a.js');
  assert.strictEqual(H.toolLine('Edit', { file_path: '/elsewhere/b.js', old_string: 'x' }, '/w'), 'Edit /elsewhere/b.js');
  assert.strictEqual(H.toolLine('Bash', { command: 'make test\n&& echo ok', description: 'run' }), 'Bash: make test && echo ok');
  assert.strictEqual(H.toolLine('Grep', { pattern: 'foo', path: '/w/src' }, '/w'), 'Grep "foo" in src');
  assert.strictEqual(H.toolLine('mcp__codebase__codebase_search', { query: 'where is flush' }), 'codebase.codebase_search where is flush');
  assert.strictEqual(H.toolLine('shell', { command: ['bash', '-lc', 'git status'] }), 'shell: git status');
  assert.strictEqual(H.toolLine('exec_command', { cmd: 'ls -la' }), 'shell: ls -la');
  assert.strictEqual(H.toolLine('apply_patch', '*** Begin Patch\n*** Update File: /w/a.js\n@@\n*** Add File: /w/b.js\n*** End Patch', '/w'), 'apply_patch a.js, b.js');
  // a long input arrives cut short, as JSON that does not parse: its leading fields still name it
  assert.strictEqual(H.toolLine('Write', '{\n "file_path": "/w/n.md",\n "content": "# 202 — Switching betw', '/w'), 'Write n.md');
  assert.ok(H.toolLine('Bash', { command: 'x'.repeat(500) }).length <= 140);
  // Codex's code mode: a script calling its tools
  assert.strictEqual(H.toolLine('exec', 'text((await tools.exec_command({cmd:"sed -n \'1,240p\' /git/perch/src/handoff.js","max_output_tokens":9000})).output);\n'), "shell: sed -n '1,240p' /git/perch/src/handoff.js");
  assert.strictEqual(H.toolLine('exec', 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output); await tools.exec_command({cmd:"ls"});'), 'shell: pwd (and 1 more call)');

  // ---- turns: thinking and tool output left out, a failed call marked, repeats folded
  const ev = [
    { kind: 'user', text: 'fix the flush bug', images: 1 },
    { kind: 'thinking', text: 'secret reasoning' },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.js' } },
    { kind: 'tool_result', id: 't1', text: 'FILE BODY', isError: false },
    { kind: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/a.js' } },
    { kind: 'tool_use', id: 't3', name: 'Bash', input: { command: 'make test' } },
    { kind: 'tool_result', id: 't3', text: 'boom', isError: true },
    { kind: 'text', text: 'The payload exceeded 1 MB.' },
    { kind: 'note', level: 'warn', text: 'a notice' },
    { kind: 'user', text: 'ok, ship it' },
    { kind: 'text', text: 'Done.' },
  ];
  const r = H.handoffText(ev, { agent: 'Claude', model: 'Opus 5.5', cwd: '/w' });
  assert.ok(r.fits);
  assert.strictEqual(r.messages, 4);
  assert.ok(r.text.startsWith('Earlier in this tab the user worked with Claude (Opus 5.5) in /w.'));
  assert.ok(r.text.includes('--- user (1 image, not included)\nfix the flush bug'));
  assert.ok(r.text.includes('    · Read a.js (×2)'));
  assert.ok(r.text.includes('    · Bash: make test → failed'));
  assert.ok(r.text.includes('--- Claude\n    · Read'));            // one header for what the agent said and did
  assert.ok(!/FILE BODY|boom|secret reasoning|a notice/.test(r.text));
  assert.ok(r.text.trimEnd().endsWith('--- end of the earlier conversation'));
  assert.strictEqual(r.text, r.full);

  // ---- over the budget: the most recent turns, the latest summary, and the file named
  const long = [];
  for (let i = 0; i < 40; i++) {
    if (i === 10) long.push({ kind: 'user', text: 'This session is being continued from a previous conversation that ran out of context. SUMMARY-ONE' });
    if (i === 20) long.push({ kind: 'user', text: 'This session is being continued from a previous conversation that ran out of context. SUMMARY-TWO' });
    long.push({ kind: 'user', text: `question ${i} ` + 'q'.repeat(400) }, { kind: 'text', text: `answer ${i} ` + 'a'.repeat(1600) });
  }
  const c = H.handoffText(long, { budget: 3000, file: '/tmp/x-1.md' });
  assert.ok(!c.fits);
  assert.ok(c.tokens <= 3000, `inline ${c.tokens}`);
  assert.ok(c.text.includes('answer 39'));
  assert.ok(!c.text.includes('answer 0 '));
  assert.ok(c.text.includes('SUMMARY-TWO') && !c.text.includes('SUMMARY-ONE'));
  assert.ok(c.text.includes("Claude's own summary of the conversation before this point"));
  assert.ok(/\[\d+ earlier messages \(\d+ turns\) are left out here; Claude's latest summary of them follows\. The whole conversation, all 80 messages, is in \/tmp\/x-1\.md/.test(c.text));
  assert.strictEqual(c.messages, 80);                               // the summaries are not the user's messages
  assert.ok(c.full.includes('answer 0 ') && c.full.includes('SUMMARY-ONE'));
  // the last turn goes in even when it alone is over the budget
  const big = H.handoffText([{ kind: 'user', text: 'x'.repeat(40000) }], { budget: 1000 });
  assert.strictEqual(big.inlineTurns, 1);

  // ---- a Claude session across its compactions, without a rewound branch
  const dir = mk(), proj = path.join(dir, 'projects', '-w'); fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o);
  const u = (uuid, parent, text, o) => line(Object.assign({ type: 'user', uuid, parentUuid: parent, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text }] } }, o));
  const a = (uuid, parent, text) => line({ type: 'assistant', uuid, parentUuid: parent, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), [
    u('u1', null, 'first question'), a('a1', 'u1', 'first answer'),
    u('u2', 'a1', 'abandoned question'), a('a2', 'u2', 'abandoned answer'),        // rewound: not on the thread
    u('u2b', 'a1', 'second question'), a('a2b', 'u2b', 'second answer'),
    line({ type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'a2b' }),
    u('s1', 'cb', 'This session is being continued from a previous conversation. SUM', { isCompactSummary: true }),
    u('m1', 's1', '<local-command-caveat>x</local-command-caveat>', { isMeta: true }),
    u('u3', 'm1', 'third question'), a('a3', 'u3', 'third answer'),
    line({ type: 'user', uuid: 'side', parentUuid: 'a3', isSidechain: true, message: { role: 'user', content: 'sub-agent' } }),
    'not json',
  ].join('\n') + '\n');
  const thread = await H.claudeThread('sess-1', { claudeDir: dir });
  assert.deepStrictEqual(thread.map((m) => m.uuid), ['u1', 'a1', 'u2b', 'a2b', 's1', 'u3', 'a3']);
  const events = await H.loadDiscussion('claude', 'sess-1', { claudeDir: dir });
  const t = H.handoffText(events).text;
  assert.ok(t.indexOf('first question') < t.indexOf('second answer') && t.indexOf('second answer') < t.indexOf('SUM') && t.indexOf('SUM') < t.indexOf('third answer'));
  assert.ok(!t.includes('abandoned') && !t.includes('sub-agent'));
  assert.strictEqual(await H.claudeThread('../etc', { claudeDir: dir }), null);
  assert.strictEqual(await H.claudeThread('nope', { claudeDir: dir }), null);

  // ---- a record the tab came back to: cut at each handoff, which is never said again
  const ho = H.handoffText([{ kind: 'user', text: 'q1' }, { kind: 'text', text: 'a1' }], { agent: 'Codex' }).text;
  assert.ok(H.isHandoff(ho + '\n\nmy words') && !H.isHandoff('Earlier in this tab the user worked with nobody'));
  assert.strictEqual(H.ownWords(ho + '\n\nmy words'), 'my words');
  assert.strictEqual(H.ownWords('plain'), 'plain');
  const rec = [{ kind: 'user', text: 'first' }, { kind: 'text', text: 'one' }, { kind: 'user', text: ho + '\n\nback again' }, { kind: 'text', text: 'two' }, { kind: 'user', text: ho }, { kind: 'text', text: 'three' }];
  const st = H.stretches(rec);
  assert.deepStrictEqual(st.map((x) => x.map((e) => e.text)), [['first', 'one'], ['back again', 'two'], ['three']]);
  assert.deepStrictEqual(H.stretches([{ kind: 'user', text: ho + '\n\nhi' }]).map((x) => x.map((e) => e.text)), [['hi']], 'a record that began with a switch');
  const again = H.handoffText(rec).text;
  assert.ok(!again.includes('q1') && again.includes('back again') && again.includes('three'), 'a handoff the record holds is not handed on');

  // ---- the file: the user's alone, and removed with the tab
  const hd = path.join(mk(), 'handoff');
  const f = H.handoffFile('tab/1', 2, hd);
  assert.strictEqual(path.basename(f), 'tab_1-2.md');
  H.writeHandoff(f, 'whole');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'whole');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(hd).mode & 0o777, 0o700);
  }
  H.writeHandoff(H.handoffFile('other', 1, hd), 'x');
  assert.strictEqual(H.removeHandoffs('tab/1', hd), 1);
  assert.deepStrictEqual(fs.readdirSync(hd), ['other-1.md']);

  console.log('HANDOFF OK');
})().catch((e) => { console.error(e); process.exit(1); });
