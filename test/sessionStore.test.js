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
    { kind: 'user', text: 'fix this', queued: false, tag: 'IDE context' }, { kind: 'thinking', text: 'thinking aloud' },
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
  assert.deepStrictEqual(asked, [['c-1', { dir: '/w' }]]);
  assert.deepStrictEqual(await S.loadTranscript('claude', '', { sdk: reader }), { events: [], earlier: 0 });
  await assert.rejects(S.loadTranscript('claude', 'c-1', { sdk: { getSessionMessages: async () => { throw new Error('unreadable'); } } }), /unreadable/);

  console.log('SESSIONS OK');
})().catch((e) => { console.error('SESSIONS FAILED:', e.stack || e.message); process.exit(1); });
