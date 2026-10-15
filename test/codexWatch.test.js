'use strict';
// The watch on a running Codex turn's rollout file: what it reads, from where, and what it says.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RolloutWatch } = require('../src/codexWatch');

const act = (kind, agent_path) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'root', item: { type: 'SubAgentActivity', id: 'c', kind, agent_thread_id: 'x', agent_path } } });
const said = (author, type) => JSON.stringify({ type: 'response_item', payload: { type: 'agent_message', author, recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: ' + type + '\n' }] } });
const ask = (id, title) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [{ title, options: ['Yes', 'No'] }] }), call_id: id } });
const other = (n) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { n } } });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-watch-'));
try {
  // ---- a resumed thread: what the file holds already is earlier turns'; only what it gains is read
  {
    const file = path.join(dir, 'rollout-a.jsonl');
    fs.writeFileSync(file, [act('started', '/root/old'), other(1)].join('\n') + '\n');
    const got = [];
    const w = new RolloutWatch({ id: 'a', home: dir, emit: (e) => got.push(e), find: (id) => (id === 'a' ? file : null), pollMs: 60000 });
    w.start(); w.poll();
    assert.deepStrictEqual(got, [], 'an earlier turn\'s sub-agent is not said again');
    fs.appendFileSync(file, [other(2), act('started', '/root/desk_audio'), said('/root/desk_audio', 'MESSAGE'), ask('call_q', 'Where should replies play?')].join('\n') + '\n');
    w.poll();
    assert.deepStrictEqual(got, [
      { kind: 'subagent', name: 'desk_audio', state: 'started', thread: 'x' },
      { kind: 'subagent', name: 'desk_audio', state: 'reported' },
      { kind: 'question', id: 'call_q', async: true, questions: [{ question: 'Where should replies play?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false }] },
    ], 'what the turn added: the sub-agent, its report, the question; the token counts are nothing');
    // a line still being written is read once it is whole
    const line = act('completed', '/root/desk_audio');
    fs.appendFileSync(file, line.slice(0, 40)); w.poll();
    assert.strictEqual(got.length, 3, 'half a line says nothing');
    fs.appendFileSync(file, line.slice(40) + '\n' + said('/root/desk_audio', 'FINAL_ANSWER')); w.poll();
    assert.deepStrictEqual(got.slice(3), [{ kind: 'subagent', name: 'desk_audio', state: 'finished', thread: 'x' }], 'whole now; the next line has no end yet');
    // the turn ends: a last read, and the watch stops
    fs.appendFileSync(file, '\n'); w.stop();
    assert.deepStrictEqual(got.slice(4), [{ kind: 'subagent', name: 'desk_audio', state: 'answered' }]);
    assert.strictEqual(w.timer, null);
    // a file written over from the start is read again from its start
    const w2 = new RolloutWatch({ id: 'a', home: dir, emit: (e) => got.push(e), find: () => file, pollMs: 60000 });
    w2.start(); fs.writeFileSync(file, act('interrupted', '/root/x') + '\n'); w2.stop();
    assert.deepStrictEqual(got.pop(), { kind: 'subagent', name: 'x', state: 'interrupted', thread: 'x' });
  }

  // ---- a new thread: its file appears after the watch began, and all of it is this turn's
  {
    const file = path.join(dir, 'rollout-b.jsonl');
    const got = [];
    let there = false;
    const w = new RolloutWatch({ id: 'b', home: dir, emit: (e) => got.push(e), find: (id) => (there && id === 'b' ? file : null), pollMs: 60000 });
    w.start(); w.poll();
    assert.deepStrictEqual([w.file, got], [null, []], 'nothing yet');
    fs.writeFileSync(file, [act('started', '/root/first'), other(1)].join('\n') + '\n'); there = true;
    w.lastFind = 0;                  // looked for again at once, not after the usual pause
    w.poll();
    assert.deepStrictEqual(got, [{ kind: 'subagent', name: 'first', state: 'started', thread: 'x' }], 'found, and read whole');
    w.stop();
  }

  // ---- a sub-agent's own file: which model answers it and what its turns cost, said as its usage as the file grows
  {
    const root = path.join(dir, 'rollout-r.jsonl'), child = path.join(dir, 'rollout-c1.jsonl');
    const actT = (kind, thread, agent_path) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'r', item: { type: 'SubAgentActivity', id: 'c', kind, agent_thread_id: thread, agent_path } } });
    const start = (thread, agent_path) => actT('started', thread, agent_path);
    const meta = (nick) => JSON.stringify({ type: 'session_meta', payload: { id: 'c1', parent_thread_id: 'r', agent_path: '/root/mic_research', agent_nickname: nick } });
    let turnNo = 0; const turn = (model, effort) => JSON.stringify({ type: 'turn_context', payload: { turn_id: 't' + (++turnNo), model, effort } });   // each its own turn, as in a thread
    const cost = (i, c, o) => JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } });
    fs.writeFileSync(root, '');
    fs.writeFileSync(child, [meta('Linnaeus'), turn('gpt-6.1-sol', 'ultra'), cost(1000, 900, 50)].join('\n') + '\n');
    const got = [];
    const files = { r: root, c1: child };
    const w = new RolloutWatch({ id: 'r', home: dir, emit: (e) => got.push(e), find: (id) => files[id] || null, pollMs: 60000 });
    w.start();
    fs.appendFileSync(root, start('c1', '/root/mic_research') + '\n'); w.poll();
    assert.deepStrictEqual(got, [
      { kind: 'subagent', name: 'mic_research', state: 'started', thread: 'c1' },
      { kind: 'subagent', name: 'mic_research', state: 'usage', model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 1000, cached: 900, output: 50 }, nickname: 'Linnaeus' },
    ], 'its start, then what its file already held: read whole, after the start');
    w.poll();
    assert.strictEqual(got.length, 2, 'nothing new: nothing said');
    // another turn, on another model: the totals, and every model used
    fs.appendFileSync(child, [turn('gpt-5.6-sol', 'low'), cost(500, 0, 25)].join('\n') + '\n');
    fs.appendFileSync(root, actT('completed', 'c1', '/root/mic_research') + '\n');
    w.poll();
    assert.deepStrictEqual(got.slice(2), [
      { kind: 'subagent', name: 'mic_research', state: 'usage', model: 'gpt-5.6-sol', effort: 'low', turns: 2, tokens: { input: 1500, cached: 900, output: 75 }, nickname: 'Linnaeus', models: [{ model: 'gpt-6.1-sol', turns: 1 }, { model: 'gpt-5.6-sol', turns: 1 }] },
      { kind: 'subagent', name: 'mic_research', state: 'finished', thread: 'c1' },
    ], 'the sub-agent\'s file is read before the root\'s: its end finds its usage known');
    // a sub-agent whose file is not there yet is looked for again; a line of its file still being written waits
    fs.appendFileSync(root, start('c2', '/root/late') + '\n'); w.poll();
    assert.deepStrictEqual(got.slice(4), [{ kind: 'subagent', name: 'late', state: 'started', thread: 'c2' }], 'started, its file not found');
    const late = path.join(dir, 'rollout-c2.jsonl'); files.c2 = late;
    fs.writeFileSync(late, turn('gpt-6.1-sol', 'ultra') + '\n' + cost(10, 0, 1).slice(0, 30));
    w.poll();
    assert.strictEqual(got.length, 5, 'not looked for again so soon');
    w.children.get('c2').lastFind = 0; w.poll();
    assert.deepStrictEqual(got.slice(5), [{ kind: 'subagent', name: 'late', state: 'usage', model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 0, cached: 0, output: 0 } }], 'found: the turn, not yet its half-written cost');
    fs.appendFileSync(late, cost(10, 0, 1).slice(30) + '\n'); w.stop();
    assert.deepStrictEqual(got.slice(6), [{ kind: 'subagent', name: 'late', state: 'usage', model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 10, cached: 0, output: 1 } }], 'the last read, on stop, takes the whole line');
    assert.strictEqual(w.timer, null);
  }

  // ---- a sub-agent started in an earlier turn, heard of in this one only by a follow-up (seen on 2026-10-12: the table
  // said "…" for capture_failure_diagnosis, started three days before): its file is found from the `interacted` record,
  // its model is said at once, and only this turn's turns and tokens are counted
  {
    const root = path.join(dir, 'rollout-r2.jsonl'), child = path.join(dir, 'rollout-old.jsonl');
    const at = (iso, rec) => JSON.stringify(Object.assign({ timestamp: iso }, JSON.parse(rec)));
    const actT = (kind, thread, agent_path) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'c', kind, agent_thread_id: thread, agent_path } } });
    let turnNo = 0; const turn = (model, effort) => JSON.stringify({ type: 'turn_context', payload: { turn_id: 't' + (++turnNo), model, effort } });   // each its own turn, as in a thread
    const cost = (i, c, o) => JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } });
    fs.writeFileSync(root, actT('started', 'old', '/root/capture') + '\n');           // an earlier turn's start: before the watch
    fs.writeFileSync(child, [at('2026-10-09T20:53:31Z', JSON.stringify({ type: 'session_meta', payload: { agent_nickname: 'Lagrange' } })),
      at('2026-10-09T20:53:32Z', turn('gpt-5.6-sol', 'low')), at('2026-10-09T20:54:00Z', cost(9000, 8000, 900))].join('\n') + '\n');
    const got = [];
    const files = { r2: root, old: child };
    const w = new RolloutWatch({ id: 'r2', home: dir, emit: (e) => got.push(e), find: (id) => files[id] || null, pollMs: 60000 });
    w.start(); w.since = Date.parse('2026-10-12T16:30:08Z');                       // the turn began then
    fs.appendFileSync(root, [JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'followup_task', arguments: '{"target":"capture"}' } }), actT('interacted', 'old', '/root/capture')].join('\n') + '\n');
    w.poll();
    assert.deepStrictEqual(got, [
      { kind: 'subagent', name: 'capture', state: 'tasked' },
      { kind: 'subagent', name: 'capture', state: 'active', thread: 'old' },
      { kind: 'subagent', name: 'capture', state: 'usage', model: 'gpt-5.6-sol', effort: 'low', turns: 0, tokens: { input: 0, cached: 0, output: 0 }, nickname: 'Lagrange' },
    ], 'found by its follow-up: the model it was last on, and nothing of its earlier turns\' cost');
    fs.appendFileSync(child, [at('2026-10-12T16:33:19Z', turn('gpt-6.1-sol', 'ultra')), at('2026-10-12T16:33:25Z', cost(241131, 240000, 300))].join('\n') + '\n');
    w.stop();
    assert.deepStrictEqual(got.slice(3), [{ kind: 'subagent', name: 'capture', state: 'usage', model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 241131, cached: 240000, output: 300 }, nickname: 'Lagrange' }],
      'this turn\'s turn and tokens; the earlier model is no turn of this one');
  }

  // ---- a sub-agent forked from the root's conversation: its file begins with the root's history, copied, stamped inside
  // this turn. Only its own turn counts (seen on 2026-10-12: each forked one showed a turn more, on the root's model)
  {
    const root = path.join(dir, 'rollout-r3.jsonl'), child = path.join(dir, 'rollout-fk.jsonl');
    const rec = (ordinal, type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type, payload });
    fs.writeFileSync(root, '');
    fs.writeFileSync(child, [rec(0, 'session_meta', { id: 'fk', forked_from_id: 'r3', subagent_history_start_ordinal: 3, agent_nickname: 'Noether' }), rec(1, 'session_meta', { id: 'r3' }),
      rec(2, 'turn_context', { turn_id: 'root-turn', model: 'gpt-5.6-sol', effort: 'max' }),
      rec(3, 'turn_context', { turn_id: 'own', model: 'gpt-6.1-sol', effort: 'ultra' }), rec(4, 'token_usage_record', { usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 1 } })].join('\n') + '\n');
    const got = [], files = { r3: root, fk: child };
    const w = new RolloutWatch({ id: 'r3', home: dir, emit: (e) => got.push(e), find: (id) => files[id] || null, pollMs: 60000 });
    w.start(); w.since = Date.now() - 60000;
    fs.appendFileSync(root, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'c', kind: 'started', agent_thread_id: 'fk', agent_path: '/root/fork' } } }) + '\n');
    w.stop();
    assert.deepStrictEqual(got, [{ kind: 'subagent', name: 'fork', state: 'started', thread: 'fk' },
      { kind: 'subagent', name: 'fork', state: 'usage', model: 'gpt-6.1-sol', effort: 'ultra', turns: 1, tokens: { input: 10, cached: 5, output: 1 }, nickname: 'Noether' }],
      'its own turn on its own model; the root\'s copied turn is none of its');
  }

  // ---- a listener that throws, or a file that cannot be read, stops nothing
  {
    const file = path.join(dir, 'rollout-c.jsonl');
    fs.writeFileSync(file, '');
    let calls = 0;
    const w = new RolloutWatch({ id: 'c', home: dir, emit: () => { calls++; throw new Error('listener'); }, find: () => file, pollMs: 60000 });
    w.start();
    fs.appendFileSync(file, [act('started', '/root/a'), act('started', '/root/b')].join('\n') + '\n'); w.poll();
    assert.strictEqual(calls, 2, 'each event is said, though the listener threw');
    fs.rmSync(file); w.poll(); w.stop();
    const nowhere = new RolloutWatch({ id: 'd', home: dir, emit: () => {}, find: () => { throw new Error('no sessions'); }, pollMs: 60000 });
    nowhere.start(); nowhere.poll(); nowhere.stop();
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('CODEX WATCH OK');
