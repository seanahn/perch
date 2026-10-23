'use strict';
// Past sessions and their names, against throwaway directories and a fake Agent SDK. No real ~/.claude or ~/.codex.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const S = require('../src/sessionStore');

const NOW = Date.parse('2026-09-29T19:40:00Z');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-sessions-'));
const meta = (id, cwd, o) => JSON.stringify({ timestamp: '2026-09-29T12:00:00Z', ordinal: 0, type: 'session_meta', payload: Object.assign({ id, session_id: id, cwd, source: 'exec', thread_source: 'user', base_instructions: { text: 'x'.repeat(4000) } }, o) });
const msg = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
const ENV = '<environment_context>\n  <cwd>/w</cwd>\n</environment_context>';
function rollout(home, day, id, lines, mtime) {
  const dir = path.join(home, 'sessions', ...day.split('-')); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-${day}T12-00-00-${id}.jsonl`); fs.writeFileSync(f, lines.join('\n') + '\n');
  fs.utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

(async () => {
  // ---- names and times
  assert.deepStrictEqual([S.cleanTitle('  fix   the\n flush\tbug '), S.cleanTitle(''), S.cleanTitle(null), S.cleanTitle(undefined), S.cleanTitle(' \n ')], ['fix the flush bug', '', '', '', '']);
  assert.strictEqual(S.cleanTitle('a'.repeat(200)).length, S.MAX_TITLE);
  assert.strictEqual(S.cleanTitle('a'.repeat(S.MAX_TITLE - 1) + ' b'), 'a'.repeat(S.MAX_TITLE - 1), 'a cut that lands on a space does not leave it behind');
  const M = 60000, H = 60 * M, D = 24 * H;
  assert.deepStrictEqual([0, 59000, M, 59 * M, H, 23 * H, D, 29 * D, 30 * D, 364 * D, 365 * D, 800 * D, -5000].map((d) => S.ago(NOW - d, NOW)), ['now', 'now', '1m', '59m', '1h', '23h', '1d', '29d', '1mo', '12mo', '1y', '2y', 'now']);

  // ---- the start of a Codex rollout
  assert.deepStrictEqual(S.parseRolloutHead([meta('t1', '/w'), msg('developer', 'rules'), msg('user', ENV), msg('user', 'hello  there'), msg('assistant', 'hi'), msg('user', 'second')].join('\n')), { id: 't1', cwd: '/w', first: 'hello  there' }, 'the first thing the user wrote, not the environment block Codex writes in the user\'s role');
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w'), msg('user', 'fix this\n\n<ide_context>\nActive file: a.js\n</ide_context>')].join('\n')).first, 'fix this', 'the IDE context Perch attaches is not part of the name');
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w'), msg('user', ENV)].join('\n')).first, '', 'a thread in which nothing was said');
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w', { source: { subagent: { thread_spawn: { parent_thread_id: 't0' } } } }), msg('user', 'go')].join('\n')), null, 'a sub-agent\'s thread is not the user\'s');
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w', { thread_source: 'agent' }), msg('user', 'go')].join('\n')), null);
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w', { thread_source: undefined }), msg('user', 'go')].join('\n')).first, 'go', 'an older rollout does not say whose it is');
  for (const bad of ['', 'not json', msg('user', 'hello'), '{"type":"session_meta"}']) assert.strictEqual(S.parseRolloutHead(bad), null);
  assert.strictEqual(S.parseRolloutHead([meta('t1', '/w'), '{"torn', msg('user', 'ok')].join('\n')).first, 'ok', 'a torn line is skipped');

  // ---- Codex threads of a directory
  const home = mk();
  assert.deepStrictEqual(S.listCodex({ dir: '/w', home }), [], 'no Codex records at all');
  rollout(home, '2026-09-27', 'aaa', [meta('aaa', '/w'), msg('user', ENV), msg('user', 'oldest one')], NOW - 2 * D);
  rollout(home, '2026-09-29', 'bbb', [meta('bbb', '/w'), msg('user', ENV), msg('user', 'newest one')], NOW - M);
  rollout(home, '2026-09-28', 'ccc', [meta('ccc', '/elsewhere'), msg('user', 'another project')], NOW - D);
  rollout(home, '2026-09-28', 'ddd', [meta('ddd', '/w', { source: { subagent: {} } }), msg('user', 'spawned')], NOW - D);
  rollout(home, '2026-09-28', 'eee', [meta('eee', '/w'), msg('user', ENV)], NOW - D);
  rollout(home, '2026-09-28', 'fff', [meta('fff', '/w'), msg('user', 'x'.repeat(300))], NOW - 3 * H);
  fs.writeFileSync(path.join(home, 'sessions', '2026', '09', '28', 'rollout-broken.jsonl'), 'garbage\n');
  let got = S.listCodex({ dir: '/w', home });
  assert.deepStrictEqual(got.map((s) => [s.kind, s.id, s.title, s.named, s.updatedAt]), [['codex', 'bbb', 'newest one', false, NOW - M], ['codex', 'fff', 'x'.repeat(S.MAX_TITLE), false, NOW - 3 * H], ['codex', 'aaa', 'oldest one', false, NOW - 2 * D]], 'this directory\'s own threads, newest first');
  assert.deepStrictEqual(S.listCodex({ dir: '/w', home, limit: 2 }).map((s) => s.id), ['bbb', 'fff']);
  assert.deepStrictEqual(S.listCodex({ home }).map((s) => s.id), ['bbb', 'fff', 'ccc', 'aaa'], 'every directory, when none is given');

  // a first message further in than the instructions are long is still found
  rollout(home, '2026-09-26', 'ggg', [meta('ggg', '/w', { base_instructions: { text: 'y'.repeat(100000) } }), msg('user', 'after long instructions')], NOW - 5 * D);
  assert.strictEqual(S.listCodex({ dir: '/w', home }).pop().title, 'after long instructions');

  // ---- Codex names: one line per naming, the last one wins
  assert.strictEqual(S.codexNames(home).size, 0);
  assert.strictEqual(await S.renameSession('codex', 'aaa', '  Flush   bug ', { home, now: NOW }), 'Flush bug');
  const index = path.join(home, 'session_index.jsonl');
  assert.strictEqual(fs.readFileSync(index, 'utf8'), '{"id":"aaa","thread_name":"Flush bug","updated_at":"2026-09-29T19:40:00.000Z"}\n', 'written the way Codex writes it');
  fs.appendFileSync(index, '{"id":"bbb","thread_name":"Named by Codex","updated_at":"2026-09-29T19:41:00Z"}');    // no line break after it
  await S.renameSession('codex', 'aaa', 'Flush bug, again', { home, now: NOW });
  assert.deepStrictEqual(fs.readFileSync(index, 'utf8').split('\n').map((l) => l && JSON.parse(l).thread_name), ['Flush bug', 'Named by Codex', 'Flush bug, again', ''], 'appended on a line of its own; nothing is rewritten');
  fs.appendFileSync(index, '{"torn\n{"id":"zzz","thread_name":"   "}\n{"thread_name":"no id"}\n');
  assert.deepStrictEqual([...S.codexNames(home)], [['aaa', 'Flush bug, again'], ['bbb', 'Named by Codex']]);
  got = S.listCodex({ dir: '/w', home });
  assert.deepStrictEqual(got.map((s) => [s.id, s.title, s.named]), [['bbb', 'Named by Codex', true], ['fff', 'x'.repeat(S.MAX_TITLE), false], ['aaa', 'Flush bug, again', true], ['ggg', 'after long instructions', false]], 'a name replaces the first message, and does not change the order');
  const fresh = path.join(mk(), 'not-there-yet');
  await S.renameSession('codex', 'aaa', 'first name', { home: fresh, now: NOW });
  assert.deepStrictEqual([...S.codexNames(fresh)], [['aaa', 'first name']], 'the index is made if it is missing');

  // ---- Claude, through the Agent SDK
  const calls = [];
  const sdk = {
    listSessions: async (o) => { calls.push(['list', o]); return [
      { sessionId: 'c-1', summary: 'Perch session name and loading', customTitle: 'Perch session name and loading', lastModified: NOW - 2 * M, firstPrompt: 'how do i change the session name' },
      { sessionId: 'c-2', summary: 'continue', lastModified: NOW - 4 * H },
      { sessionId: 'c-3', summary: '', firstPrompt: ' only a \n first prompt ', lastModified: NOW - 9 * D },
      { sessionId: 'c-4', summary: '', lastModified: NOW },
      { summary: 'no id', lastModified: NOW },
    ]; },
    renameSession: async (...a) => { calls.push(['rename', ...a]); },
  };
  assert.deepStrictEqual(await S.listClaude({ dir: '/w', limit: 7, sdk }), [
    { kind: 'claude', id: 'c-1', title: 'Perch session name and loading', named: true, updatedAt: NOW - 2 * M },
    { kind: 'claude', id: 'c-2', title: 'continue', named: false, updatedAt: NOW - 4 * H },
    { kind: 'claude', id: 'c-3', title: 'only a first prompt', named: false, updatedAt: NOW - 9 * D },
  ], 'a session with nothing to call it is left out');
  assert.deepStrictEqual(calls.pop(), ['list', { dir: '/w', limit: 7 }]);
  assert.strictEqual(await S.renameSession('claude', 'c-2', ' TLT  flush ', { dir: '/w', sdk }), 'TLT flush');
  assert.deepStrictEqual(calls.pop(), ['rename', 'c-2', 'TLT flush', { dir: '/w' }]);

  // ---- both together
  const both = await S.listSessions({ dir: '/w', home, sdk });
  assert.deepStrictEqual(both.sessions.map((s) => s.kind + ':' + s.id), ['codex:bbb', 'claude:c-1', 'codex:fff', 'claude:c-2', 'codex:aaa', 'codex:ggg', 'claude:c-3'], 'one list, newest first');
  assert.deepStrictEqual(both.failed, []);
  const half = await S.listSessions({ dir: '/w', home, sdk: { listSessions: async () => { throw new Error('no claude'); } } });
  assert.deepStrictEqual([half.sessions.map((s) => s.id), half.failed], [['bbb', 'fff', 'aaa', 'ggg'], ['claude']], 'one agent\'s records failing does not hide the other\'s');

  // ---- what cannot be named
  calls.length = 0;
  await assert.rejects(S.renameSession('claude', 'c-1', '  \n ', { sdk }), /cannot be empty/);
  await assert.rejects(S.renameSession('codex', '', 'x', { home }), /has not started/);
  await assert.rejects(S.renameSession('gemini', 'g', 'x', { home }), /Unknown agent/);
  await assert.rejects(S.renameSession('claude', 'c-1', 'x', { sdk: { renameSession: async () => { throw new Error('Session c-1 not found'); } } }), /not found/, 'a failure to write is the caller\'s to report');
  assert.deepStrictEqual(calls, [], 'nothing is written for a name that is refused');

  // ---- the transcript of a past session, as the events a live one produces
  const U = (content, o) => Object.assign({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }, o);
  const A = (content, o) => Object.assign({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null }, o);
  const long = 'z'.repeat(5000);
  assert.deepStrictEqual(S.claudeEvents([
    U('plain words'),
    U([{ type: 'text', text: '<system-reminder>\nnot the user\n</system-reminder>' }, { type: 'image', source: {} }, { type: 'text', text: ' look at this ' }]),
    A([{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 't2', name: 'Write', input: { content: long } }]),
    U([{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }, { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: long }, { type: 'image' }] }]),
    U([{ type: 'text', text: 'inside a sub-agent' }], { parent_tool_use_id: 't9' }),
    U('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>'),
    U('<local-command-stdout>Compacted</local-command-stdout>'),
    U([{ type: 'image', source: {} }]),
    A([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
    { type: 'system', message: { content: 'boundary' } }, null, { type: 'user' },
  ]), [
    { kind: 'user', text: 'plain words', queued: false },
    { kind: 'user', text: 'look at this', queued: false, images: 1 },
    { kind: 'thinking', text: 'hm' }, { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { kind: 'tool_use', id: 't2', name: 'Write', input: JSON.stringify({ content: long }, null, 1).slice(0, 2000) + '…' }, { kind: 'text', text: 'Checking.' },
    { kind: 'tool_result', id: 't1', isError: false, text: 'a\nb', truncated: false }, { kind: 'tool_result', id: 't2', isError: true, text: long.slice(0, 4000), truncated: true },
    { kind: 'user', text: '/compact keep the plan', queued: false },
    { kind: 'user', text: '', queued: false, images: 1 },
    { kind: 'text', text: 'one\ntwo' },
  ], 'what Claude Code wrote in the user\'s name is not shown as the user\'s; sealed thinking is not shown as empty');

  const item = (payload) => JSON.stringify({ type: 'response_item', payload });
  const roll = [meta('hhh', '/w'), msg('developer', 'rules'), msg('user', ENV), msg('user', 'fix this\n\n<ide_context>\nActive file: a.js\n</ide_context>'),
    item({ type: 'reasoning', summary: [], encrypted_content: 'sealed' }), item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking aloud' }] }),
    item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"command":["ls"]}' }), item({ type: 'function_call_output', call_id: 'c1', output: 'a.js' }),
    item({ type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: 'text(1)' }), item({ type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'Output:\n' }, { type: 'input_text', text: long }] }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }), '{"torn',
    item({ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }), msg('assistant', 'Done.')];
  const expected = [
    { kind: 'user', text: 'fix this', queued: false, tag: 'a.js' }, { kind: 'thinking', text: 'thinking aloud' },
    { kind: 'tool_use', id: 'c1', name: 'shell', input: { command: ['ls'] } }, { kind: 'tool_result', id: 'c1', isError: false, text: 'a.js', truncated: false },
    { kind: 'tool_use', id: 'c2', name: 'exec', input: 'text(1)' }, { kind: 'tool_result', id: 'c2', isError: false, text: ('Output:\n' + long).slice(0, 4000), truncated: true },
    { kind: 'user', text: '', queued: false, images: 1 }, { kind: 'text', text: 'Done.' },
  ];
  assert.deepStrictEqual(S.codexEvents(roll.join('\n')), expected, 'each thing once: Codex records a message both as an item and as an event');
  assert.deepStrictEqual([S.codexEvents(''), S.codexEvents(null), S.claudeEvents(null)], [[], [], []]);

  rollout(home, '2026-09-25', 'hhh', roll, NOW - 6 * D);
  assert.deepStrictEqual(await S.loadTranscript('codex', 'hhh', { home }), { events: expected, earlier: 0 });
  assert.deepStrictEqual(await S.loadTranscript('codex', 'hhh', { home, limit: 3 }), { events: expected.slice(5), earlier: 5 }, 'the most recent, and how many came before');
  assert.deepStrictEqual(await S.loadTranscript('codex', 'hh', { home }), { events: [], earlier: 0 }, 'an id is matched whole');
  assert.deepStrictEqual(await S.loadTranscript('codex', 'gone', { home: path.join(home, 'nowhere') }), { events: [], earlier: 0 });
  const asked = [];
  const reader = { getSessionMessages: async (...a) => { asked.push(a); return [U('hi'), A([{ type: 'text', text: 'hello' }])]; } };
  assert.deepStrictEqual(await S.loadTranscript('claude', 'c-1', { dir: '/w', sdk: reader }), { events: [{ kind: 'user', text: 'hi', queued: false }, { kind: 'text', text: 'hello' }], earlier: 0 });
  assert.deepStrictEqual(asked, [['c-1', { dir: '/w', includeSystemMessages: true }]], 'with the system records too: where Claude Code\'s notices were said');
  assert.deepStrictEqual(await S.loadTranscript('claude', '', { sdk: reader }), { events: [], earlier: 0 });
  await assert.rejects(S.loadTranscript('claude', 'c-1', { sdk: { getSessionMessages: async () => { throw new Error('unreadable'); } } }), /unreadable/);

  // ---- Claude Code's notice that the model's safeguards refused a response and another model answered (Opus 5.5 to Opus 4.8,
  // cyber, as on 2026-10-20). The SDK gives a system record's place without its words, so they are read from the session's file
  {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-claude-dir-'));
    try {
      const proj = path.join(claudeDir, 'projects', '-w'); fs.mkdirSync(proj, { recursive: true });
      fs.mkdirSync(path.join(claudeDir, 'projects', '-other'));
      const NOTICE = "Opus 5.5's safeguards flagged this session. Opus 4.8 is answering instead, or you can edit and retry with Opus 5.5.\n\nDetails: `[cyber]`";
      const rec = (o) => JSON.stringify(Object.assign({ parentUuid: 'p', isSidechain: false, sessionId: 'c-2', timestamp: '2026-10-20T17:25:39.000Z' }, o));
      fs.writeFileSync(path.join(proj, 'c-2.jsonl'), [
        rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'scan this' } }),
        rec({ type: 'system', subtype: 'informational', level: 'notice', uuid: 's1', content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted" }),
        rec({ type: 'system', subtype: 'model_refusal_fallback', level: 'warning', uuid: 's2', trigger: 'refusal', direction: 'retry', scope: 'session', originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8', apiRefusalCategory: 'cyber', content: NOTICE }),
        rec({ type: 'system', subtype: 'model_refusal_fallback', uuid: 's3', scope: 'local', originalModel: 'claude-opus-5-5', fallbackModel: 'claude-opus-4-8', content: '' }),
        rec({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'what is a "model_refusal_fallback"?' } }),
        '{"torn":"model_refusal_fallback"', '',
      ].join('\n'));
      assert.deepStrictEqual([...await S.claudeNotices('c-2', { claudeDir })], [['s2', NOTICE], ['s3', "claude-opus-5-5's safeguards stopped a response, and claude-opus-4-8 answered it instead."]],
        'the fallback notices only, in Claude Code\'s words, else in perch\'s; a torn line, and the name said in text, are passed over');
      assert.deepStrictEqual([(await S.claudeNotices('c-9', { claudeDir })).size, (await S.claudeNotices('../-w/c-2', { claudeDir })).size, (await S.claudeNotices('c-2', { claudeDir: path.join(claudeDir, 'nowhere') })).size], [0, 0, 0],
        'no such session, a name that is not an id, no projects');
      // as the SDK gives a system record: its place, not its words. The refused response itself is not in the conversation it gives
      const Sys = (uuid) => ({ type: 'system', uuid, session_id: 'c-2', parent_tool_use_id: null, parent_agent_id: null });
      const reader2 = { getSessionMessages: async () => [U('scan this'), Sys('s1'), Sys('s2'), A([{ type: 'text', text: 'Done.' }]), Sys('s9')] };
      assert.deepStrictEqual(await S.loadTranscript('claude', 'c-2', { dir: '/w', sdk: reader2, claudeDir }), { events: [
        { kind: 'user', text: 'scan this', queued: false }, { kind: 'note', level: 'warn', text: NOTICE }, { kind: 'text', text: 'Done.' },
      ], earlier: 0 }, 'the notice where it was said; any other system record says nothing');
    } finally { fs.rmSync(claudeDir, { recursive: true, force: true }); }
  }

    // the IDE context perch attaches is shown as a tag, as on a live message, never as text
  assert.deepStrictEqual(S.splitIde('what model am i using?\n\n<ide_context>\nActive file: docs/notes/821.md (markdown)\nCursor: line 167\n</ide_context>'), { text: 'what model am i using?', tag: '821.md' });
  assert.deepStrictEqual(S.splitIde('why?\n\n<ide_context>\nActive file: src/a.js (javascript)\nSelection: lines 3-4\n```javascript\nconst a = 1;\n```\n</ide_context>'), { text: 'why?', tag: 'a.js:3-4' });
  assert.deepStrictEqual(S.splitIde('one line\n\n<ide_context>\nActive file: /tmp/x.py\nSelection: lines 7-7 (first 12000 characters)\n</ide_context>'), { text: 'one line', tag: 'x.py:7' });
  assert.deepStrictEqual([S.splitIde('plain'), S.splitIde(''), S.splitIde(undefined)], [{ text: 'plain' }, { text: '' }, { text: '' }]);
  assert.deepStrictEqual(S.claudeEvents([{ type: 'user', message: { role: 'user', content: 'hangs\n\n<ide_context>\nActive file: docs/notes/658.md (markdown)\nCursor: line 7\n</ide_context>' } }]), [{ kind: 'user', text: 'hangs', queued: false, tag: '658.md' }], 'a Claude record too');

  // ---- what a Codex thread does that its SDK does not stream: sub-agents and questions asked without waiting, as the rollout records them
  {
    const ev = (payload) => ({ type: 'event_msg', payload });
    const it = (payload) => ({ type: 'response_item', payload });
    const act = (kind, agent_path) => ev({ type: 'item_completed', thread_id: 'root', item: { type: 'SubAgentActivity', id: 'c', kind, agent_thread_id: 'x', agent_path } });
    const said = (author, type) => it({ type: 'agent_message', author, recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: ' + type + '\nTask name: /root\nSender: ' + author + '\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAA' }] });
    const call = (name, args, call_id = 'k') => it({ type: 'function_call', name, namespace: 'collaboration', arguments: JSON.stringify(args), call_id });
    const sub = (name, state, thread) => Object.assign({ kind: 'subagent', name, state }, thread ? { thread } : {});
    assert.deepStrictEqual(S.collabEvent(act('started', '/root/desk_audio')), sub('desk_audio', 'started', 'x'), 'a sub-agent by its path under the root, with its own thread');
    assert.deepStrictEqual(S.collabEvent(ev({ type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'started', agent_path: '/root/a' } })), sub('a', 'started'), 'a start that names no thread');
    assert.deepStrictEqual([act('interacted', '/root/a'), act('completed', '/root/a'), act('interrupted', '/root/a/b'), act('started', '/root'), act('bogus', '/root/a')].map(S.collabEvent),
      [sub('a', 'active', 'x'), sub('a', 'finished', 'x'), sub('a/b', 'interrupted', 'x'), null, null], 'each kind names its thread (one started earlier is first heard of by a follow-up); the root itself, and kinds not known, are nothing');
    assert.deepStrictEqual([said('/root/a', 'MESSAGE'), said('/root/a', 'FINAL_ANSWER')].map(S.collabEvent), [sub('a', 'reported'), sub('a', 'answered')], 'its reports: their words are sealed, only that they came');
    assert.strictEqual(S.collabEvent(it({ type: 'agent_message', author: '/root', recipient: '/root/a', content: [] })), null, 'the root\'s own messages to it are not its reports');
    assert.deepStrictEqual([S.collabEvent(call('followup_task', { target: 'a', message: 'gAAAA' })), S.collabEvent(call('wait_agent', { timeout_ms: 10000 }))], [sub('a', 'tasked'), sub('', 'waiting')]);
    assert.deepStrictEqual([call('spawn_agent', { task_name: 'a' }), call('send_message', { target: 'a' }), call('list_agents', {}), call('followup_task', {})].map(S.collabEvent), [null, null, null, null], 'said by the activity that follows, or nothing to say');
    const q = call('request_user_input_async', { questions: [{ title: 'Where should replies play?', options: ['Default output', 'I will say'] }, { title: 'Anything else?' }, { title: '  ' }, null, { title: 'Mixed?', options: [{ label: 'One', description: 'the first' }, { label: ' ' }, 7] }] }, 'call_q');
    assert.deepStrictEqual(S.collabEvent(q), { kind: 'question', id: 'call_q', async: true, questions: [
      { question: 'Where should replies play?', options: [{ label: 'Default output' }, { label: 'I will say' }], multiSelect: false },
      { question: 'Anything else?', options: [], multiSelect: false },
      { question: 'Mixed?', options: [{ label: 'One', description: 'the first' }], multiSelect: false },
    ] }, 'Codex\'s questions as the card takes them; a question with no text is none');
    assert.deepStrictEqual([S.collabEvent(call('request_user_input_async', { questions: [] })), S.collabEvent(null), S.collabEvent({}), S.collabEvent(it({ type: 'function_call', name: 'followup_task', arguments: 'not json' }))], [null, null, null, null]);
    // read back later: the lifecycle in place, the collaboration calls and their outputs not as tool calls, a question as it was asked
    const lines = [meta('mmm', '/w'), msg('user', 'go'),
      call('spawn_agent', { task_name: 'a' }, 's1'), act('started', '/root/a'), it({ type: 'function_call_output', call_id: 's1', output: '{"task_name":"/root/a"}' }),
      q, it({ type: 'function_call_output', call_id: 'call_q', output: '{"accepted":true}' }),
      said('/root/a', 'MESSAGE'), call('send_message', { target: 'a' }, 's2'), act('interacted', '/root/a'), it({ type: 'function_call_output', call_id: 's2', output: '' }),
      call('wait_agent', { timeout_ms: 10000 }, 'w1'), it({ type: 'function_call_output', call_id: 'w1', output: '{"message":"Wait completed.","timed_out":false}' }),
      act('completed', '/root/a'), said('/root/a', 'FINAL_ANSWER'), it({ type: 'function_call', name: 'shell', call_id: 'c9', arguments: '{"command":["ls"]}' }), msg('assistant', 'All done.')].map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    assert.deepStrictEqual(S.codexEvents(lines.join('\n')), [
      { kind: 'user', text: 'go', queued: false },
      sub('a', 'started', 'x'),
      { kind: 'answered', questions: S.collabEvent(q).questions, answers: null },
      sub('a', 'reported'),
      sub('a', 'finished', 'x'),
      { kind: 'tool_use', id: 'c9', name: 'shell', input: { command: ['ls'] } },
      { kind: 'text', text: 'All done.' },
    ], 'the root\'s messages to it, its waits, and its final answer (which follows its end) are not lines of the transcript');
  }

  // ---- what a sub-agent's own file says of it: the model and effort of each turn, and what the turns cost
  {
    let turnNo = 0; const turn = (model, effort) => JSON.stringify({ type: 'turn_context', payload: { turn_id: 't' + (++turnNo), model, effort } });   // each its own turn, as in a thread
    const cost = (i, c, o) => JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } });
    const nick = (n) => JSON.stringify({ type: 'session_meta', payload: { id: 'c1', parent_thread_id: 'r', agent_nickname: n } });
    const t = new S.UsageTally();
    assert.deepStrictEqual([t.feed(''), t.feed('{"type":"event_msg","payload":{"type":"token_count"}}'), t.feed('not json turn_context'), t.feed(JSON.stringify({ type: 'turn_context', payload: {} })), t.feed(JSON.stringify({ type: 'token_usage_record', payload: {} }))], [false, false, false, false, false], 'lines that say nothing of it');
    assert.deepStrictEqual(t.summary(), { model: '', effort: '', turns: 0, tokens: { input: 0, cached: 0, output: 0 } });
    assert.deepStrictEqual([t.feed(nick('Popper')), t.feed(nick('Popper')), t.feed(turn('gpt-6.1-sol', 'ultra')), t.feed(cost(1000, 900, 50))], [true, false, true, true]);
    assert.deepStrictEqual(t.summary(), { model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 1000, cached: 900, output: 50 }, nickname: 'Popper' });
    t.feed(turn('gpt-5.6-sol', 'low')); t.feed(cost(500, 0, 25)); t.feed(cost(-5, 'x', null));
    assert.deepStrictEqual(t.summary(), { model: 'gpt-5.6-sol', effort: 'low', turns: 2, tokens: { input: 1500, cached: 900, output: 75 }, nickname: 'Popper', models: [{ model: 'gpt-6.1-sol', turns: 1 }, { model: 'gpt-5.6-sol', turns: 1 }] },
      'moved to another model: the latest, and each with its turns; a count that is not a number is nothing');
    assert.deepStrictEqual(S.rolloutUsage([nick('A'), turn('m', 'high'), cost(1, 2, 3)].join('\n')), { model: 'm', effort: 'high', turns: 1, tokens: { input: 1, cached: 2, output: 3 }, nickname: 'A' });
    assert.deepStrictEqual([S.rolloutUsage(''), S.rolloutUsage(null)], [{ model: '', effort: '', turns: 0, tokens: { input: 0, cached: 0, output: 0 } }, { model: '', effort: '', turns: 0, tokens: { input: 0, cached: 0, output: 0 } }]);
    // read back later: each sub-agent's end line is given what its thread's file says, the thread named by the start before it
    const act = (kind, agent_path, agent_thread_id) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'c', kind, agent_thread_id, agent_path } } });
    const root = [act('started', '/root/a', 'c1'), act('completed', '/root/a'), act('started', '/root/b', 'c2'), act('interrupted', '/root/b'), act('started', '/root/a', 'c3'), act('completed', '/root/a'), act('started', '/root/d', 'c4'), act('completed', '/root/d'), act('completed', '/root/never')].join('\n');
    const files = { c1: 'f1', c2: 'f2', c3: 'f3' };
    const texts = { f1: [nick('One'), turn('gpt-6.1-sol', 'ultra'), cost(10, 0, 1)].join('\n'), f2: [turn('gpt-5.6-sol', 'low'), cost(20, 0, 2)].join('\n'), f3: 'nothing of it' };
    const reads = [];
    const events = S.addSubagentUsage(S.codexEvents(root), '/h', { find: (th) => files[th] || null, read: (f) => { reads.push(f); if (!(f in texts)) throw new Error('gone'); return texts[f]; } });
    assert.deepStrictEqual(events.map((e) => [e.name, e.state, e.info || null]), [
      ['a', 'started', null], ['a', 'finished', { model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 10, cached: 0, output: 1 }, nickname: 'One' }],
      ['b', 'started', null], ['b', 'interrupted', { model: 'gpt-5.6-sol', effort: 'low', turns: 1, tokens: { input: 20, cached: 0, output: 2 } }],
      ['a', 'started', null], ['a', 'finished', null],
      ['d', 'started', null], ['d', 'finished', null],
      ['never', 'finished', null],
    ], 'a name used again takes the later thread; a file that says nothing, or is not found, or an end with no start, gives nothing');
    assert.deepStrictEqual(reads, ['f1', 'f2', 'f3'], 'each file once');
    assert.deepStrictEqual(S.addSubagentUsage([], '/h'), [], 'nothing to give');

    // a window: turns and tokens inside it; a turn before it still names the model, a record after it says nothing
    const stamp = (iso, rec) => JSON.stringify(Object.assign({ timestamp: iso }, JSON.parse(rec)));
    const life = [stamp('2026-10-09T10:00:00Z', turn('gpt-5.6-sol', 'low')), stamp('2026-10-09T10:01:00Z', cost(900, 800, 90)),
      stamp('2026-10-12T16:33:19Z', turn('gpt-6.1-sol', 'ultra')), stamp('2026-10-12T16:33:25Z', cost(241, 240, 3)),
      stamp('2026-10-13T09:00:00Z', turn('gpt-7-sol', 'high')), stamp('2026-10-13T09:00:05Z', cost(5, 0, 1))].join('\n');
    const loose = life + '\n' + cost(1, 0, 0);       // and a record with no stamp
    assert.deepStrictEqual(S.rolloutUsage(loose, { since: Date.parse('2026-10-12T16:30:08Z'), until: Date.parse('2026-10-12T16:34:16Z') }),
      { model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 242, cached: 240, output: 3 } }, 'its turn in the window; an unstamped record counts; a later model is not this one');
    assert.deepStrictEqual(S.rolloutUsage(loose, { since: Date.parse('2026-10-12T00:00:00Z'), until: Date.parse('2026-10-12T01:00:00Z') }),
      { model: 'gpt-5.6-sol', effort: 'low', turns: 0, tokens: { input: 1, cached: 0, output: 0 } }, 'nothing in the window but an unstamped count: the model it was on then');

    // read back with the root's file: each end counts the turn it ended in, up to itself, as the live line did
    const at = (iso, rec) => stamp(iso, typeof rec === 'string' ? rec : JSON.stringify(rec));
    const task = (iso) => at(iso, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'k' } });
    const rootLines = [
      task('2026-10-09T09:59:00Z'), at('2026-10-09T09:59:30Z', act('started', '/root/cap', 'old')), at('2026-10-09T10:02:00Z', act('completed', '/root/cap', 'old')),
      task('2026-10-12T16:30:08Z'), at('2026-10-12T16:33:18Z', act('interacted', '/root/cap', 'old')), at('2026-10-12T16:34:10Z', act('completed', '/root/cap', 'old')),
      at('2026-10-12T16:34:12Z', act('completed', '/root/gone', 'missing')),
    ].join('\n');
    assert.deepStrictEqual(S.subagentEnds(rootLines), [
      { name: 'cap', thread: 'old', since: Date.parse('2026-10-09T09:59:00Z'), until: Date.parse('2026-10-09T10:02:00Z') },
      { name: 'cap', thread: 'old', since: Date.parse('2026-10-12T16:30:08Z'), until: Date.parse('2026-10-12T16:34:10Z') },
      { name: 'gone', thread: 'missing', since: Date.parse('2026-10-12T16:30:08Z'), until: Date.parse('2026-10-12T16:34:12Z') },
    ]);
    const back = S.addSubagentUsage(S.codexEvents(rootLines), '/h', { text: rootLines, find: (th) => (th === 'old' ? 'fo' : null), read: () => life });
    assert.deepStrictEqual(back.filter((e) => e.state === 'finished').map((e) => [e.name, e.info || null]), [
      ['cap', { model: 'gpt-5.6-sol', effort: 'low', turns: 1, tokens: { input: 900, cached: 800, output: 90 } }],
      ['cap', { model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 241, cached: 240, output: 3 } }],
      ['gone', null],
    ], 'the same sub-agent ending in two turns: each end its own turn\'s model and cost, not the thread\'s whole life');
    // an end the root's file does not have where the events do is given nothing, rather than another end's figures
    const odd = [{ kind: 'subagent', name: 'other', state: 'finished', thread: 'old' }];
    assert.deepStrictEqual(S.addSubagentUsage(odd, '/h', { text: rootLines, find: () => 'fo', read: () => life })[0].info, undefined);
  }

  // ---- a turn is counted once, a fork's copy of its parent's history is not its own, and the tokens are kept by model.
  // Seen on 2026-10-12: one thread's 74 sub-agents held 390 copied contexts against 161 of their own (every forked one
  // showed a turn more than it had, on its parent's model), and 21 of the thread's 205 turns recorded their context twice.
  {
    const rec = (ordinal, type, payload) => JSON.stringify({ ordinal, type, payload });
    const ctx = (ordinal, turn_id, model, effort) => rec(ordinal, 'turn_context', { turn_id, model, effort });
    const use = (ordinal, i, c, w, o) => rec(ordinal, 'token_usage_record', { usage: { input_tokens: i, cached_input_tokens: c, cache_write_input_tokens: w, output_tokens: o } });
    const fork = [
      rec(0, 'session_meta', { id: 'kid', forked_from_id: 'root', subagent_history_start_ordinal: 5, agent_path: '/root/kid', agent_nickname: 'Zeno' }),
      rec(1, 'session_meta', { id: 'root', agent_nickname: 'not this one' }),   // the parent's, copied
      ctx(3, 'parent-turn', 'gpt-5.6-sol', 'max'),                               // the parent's turn, copied
      ctx(6, 'k1', 'gpt-6.1-sol', 'ultra'), use(7, 1000, 800, 100, 50),
      ctx(8, 'k1', 'gpt-6.1-sol', 'ultra'), use(9, 500, 400, 0, 20),            // the same turn's context again, after a compaction
      ctx(10, 'k2', 'gpt-6.1-sol', 'ultra'), use(11, 100, 0, 0, 5),
    ];
    const t = new S.UsageTally(); for (const l of fork) t.feed(l);
    assert.deepStrictEqual(t.summary(), { model: 'gpt-6.1-sol', effort: 'ultra', turns: 2, tokens: { input: 1600, cached: 1200, output: 75 }, nickname: 'Zeno' },
      'its own two turns on its own model: not its parent\'s copied turn, not a turn twice, not its parent\'s name');
    assert.deepStrictEqual(t.spent(), [{ model: 'gpt-6.1-sol', input: 1600, cached: 1200, write: 100, output: 75 }], 'the cache writes too, for pricing');
    // a main thread: nothing copied; a request before any turn named a model; a move to another model
    const main = new S.UsageTally();
    for (const l of [rec(0, 'session_meta', { id: 'root' }), use(1, 10, 0, 0, 1), ctx(2, 'r1', 'gpt-5.6-sol', 'max'), use(3, 100, 50, 0, 10), ctx(4, 'r2', 'gpt-6.1-sol', 'max'), use(5, 200, 100, 20, 20)]) main.feed(l);
    assert.deepStrictEqual(main.spent(), [{ model: '', input: 10, cached: 0, write: 0, output: 1 }, { model: 'gpt-5.6-sol', input: 100, cached: 50, write: 0, output: 10 }, { model: 'gpt-6.1-sol', input: 200, cached: 100, write: 20, output: 20 }],
      'each request under the model of the turn it is in');
    assert.deepStrictEqual([main.summary().turns, main.summary().models], [2, [{ model: 'gpt-5.6-sol', turns: 1 }, { model: 'gpt-6.1-sol', turns: 1 }]]);
  }

  // ---- a session's usage, thread by thread, read from a sessions tree: what the footer's table shows
  {
    const home = mk(), T = Date.parse('2026-10-12T10:00:00Z');
    const at = (iso, o) => JSON.stringify(Object.assign({ timestamp: iso }, o));
    const act = (iso, kind, agent_path, agent_thread_id, ordinal) => at(iso, Object.assign(ordinal === undefined ? {} : { ordinal }, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'x', kind, agent_path, agent_thread_id } } }));
    const ctx = (turn_id, model, effort, ordinal) => JSON.stringify(Object.assign(ordinal === undefined ? {} : { ordinal }, { type: 'turn_context', payload: { turn_id, model, effort } }));
    const use = (i, c, o, ordinal) => JSON.stringify(Object.assign(ordinal === undefined ? {} : { ordinal }, { type: 'token_usage_record', payload: { usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } }));
    rollout(home, '2026-10-12', 'root-1', [meta('root-1', '/w'), ctx('r1', 'gpt-6.1-sol', 'max'), use(1000, 900, 10),
      act('2026-10-12T10:01:00Z', 'started', '/root/alpha', 'kid-a'), act('2026-10-12T10:02:00Z', 'started', '/root/beta', 'kid-b'), act('2026-10-12T10:03:00Z', 'started', '/root/gone', 'kid-gone'),
      act('2026-10-12T10:05:00Z', 'completed', '/root/alpha', 'kid-a'), act('2026-10-12T11:00:00Z', 'interacted', '/root/alpha', 'kid-a')], T);
    rollout(home, '2026-10-12', 'kid-a', [JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: 'kid-a', subagent_history_start_ordinal: 3, agent_nickname: 'Euler' } }),
      act('2026-10-12T09:00:00Z', 'started', '/root/old', 'kid-old', 1),          // the parent's history, copied: not a sub-agent of this one
      ctx('r0', 'gpt-5.6-sol', 'max', 2),
      ctx('a1', 'gpt-6.1-sol', 'ultra', 3), use(300, 200, 30, 4),
      act('2026-10-12T10:04:00Z', 'started', '/root/alpha/deep', 'kid-deep', 5)], T);
    rollout(home, '2026-10-12', 'kid-b', [ctx('b1', 'gpt-6-luna', 'medium'), use(50, 0, 5)], T);
    rollout(home, '2026-10-11', 'kid-deep', [ctx('d1', 'gpt-6-luna', 'low'), use(7, 0, 1)], T - 86400000);   // another day's folder
    rollout(home, '2026-10-12', 'kid-old', [ctx('o1', 'gpt-6-luna', 'low'), use(999, 0, 99)], T);
    const u = await S.sessionUsage('root-1', { home });
    assert.deepStrictEqual(u.main, { thread: 'root-1', model: 'gpt-6.1-sol', effort: 'max', turns: 1, tokens: { input: 1000, cached: 900, output: 10 }, spent: [{ model: 'gpt-6.1-sol', input: 1000, cached: 900, write: 0, output: 10 }] });
    const hm = (iso) => Date.parse(iso);
    assert.deepStrictEqual(u.subagents.map((s) => [s.name, s.thread, s.state, s.first, s.last, s.model, s.turns, s.tokens.input, s.nickname || '', !!s.missing]), [
      ['alpha', 'kid-a', 'active', hm('2026-10-12T10:01:00Z'), hm('2026-10-12T11:00:00Z'), 'gpt-6.1-sol', 1, 300, 'Euler', false],
      ['beta', 'kid-b', 'started', hm('2026-10-12T10:02:00Z'), hm('2026-10-12T10:02:00Z'), 'gpt-6-luna', 1, 50, '', false],
      ['gone', 'kid-gone', 'started', hm('2026-10-12T10:03:00Z'), hm('2026-10-12T10:03:00Z'), '', 0, 0, '', true],
      ['alpha/deep', 'kid-deep', 'started', hm('2026-10-12T10:04:00Z'), hm('2026-10-12T10:04:00Z'), 'gpt-6-luna', 1, 7, '', false],
    ], 'in the order first heard of, each as it last was; one a sub-agent started, after; a file not found said so; a fork\'s copied history names no sub-agent of its own');
    assert.deepStrictEqual(u.subagents[0].spent, [{ model: 'gpt-6.1-sol', input: 300, cached: 200, write: 0, output: 30 }]);
    assert.strictEqual(await S.sessionUsage('nobody', { home }), null, 'a session whose file is not found');
    const reads = [];
    const v = await S.sessionUsage('root-1', { home, read: async (f) => { reads.push(path.basename(f)); if (/kid-b/.test(f)) throw new Error('gone'); return fs.readFileSync(f, 'utf8'); } });
    assert.deepStrictEqual([v.subagents.find((s) => s.name === 'beta').missing, reads], [true, ['rollout-2026-10-12T12-00-00-root-1.jsonl', 'rollout-2026-10-12T12-00-00-kid-a.jsonl', 'rollout-2026-10-12T12-00-00-kid-b.jsonl', 'rollout-2026-10-11T12-00-00-kid-deep.jsonl']],
      'a file that cannot be read is as one not found; each file read once, and only the files of the session\'s threads');
  }
console.log('SESSIONS OK');
})().catch((e) => { console.error('SESSIONS FAILED:', e.stack || e.message); process.exit(1); });
