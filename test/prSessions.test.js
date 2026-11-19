'use strict';
// Which Claude Code session made a PR (src/prSessions.js), against made-up records in a throwaway projects folder. No real ~/.claude.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const P = require('../src/prSessions');

const URL = 'https://github.com/seanahn/kestrel/pull/12';
const DAY = 86400000;
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perch-prsessions-'));
/** A session's record: one JSON entry a line, as Claude Code writes them; `ageDays` sets how long ago it was last written. */
function record(root, project, id, entries, ageDays = 0) {
  const dir = path.join(root, project); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const t = (Date.now() - ageDays * DAY) / 1000; fs.utimesSync(file, t, t);
  return file;
}
const at = (m) => new Date(Date.UTC(2026, 10, 19, 10, m)).toISOString();
const say = (m, text, cwd = '/w/kestrel') => ({ type: 'user', timestamp: at(m), cwd, message: { role: 'user', content: text } });
const told = (m, text, cwd = '/w/kestrel') => ({ type: 'assistant', timestamp: at(m), cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const call = (m, id, command, name = 'Bash') => ({ type: 'assistant', timestamp: at(m), cwd: '/w/kestrel', message: { content: [{ type: 'tool_use', id, name, input: { command } }] } });
const result = (m, id, content, cwd = '/w/kestrel') => ({ type: 'user', timestamp: at(m), cwd, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult: { stdout: typeof content === 'string' ? content : '' } });

(async () => {
  // ---- the URL, taken apart; nothing else is a PR
  assert.deepStrictEqual(P.parsePrUrl(URL), { url: URL, owner: 'seanahn', repo: 'kestrel', n: 12, ref: 'seanahn/kestrel#12' });
  assert.deepStrictEqual(P.parsePrUrl('https://github.com/c3-e/c3.ai-platform/pull/4501').ref, 'c3-e/c3.ai-platform#4501');
  for (const bad of [undefined, 42, '', 'http://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1/files', 'https://github.com/a/b/pull/1#x', 'https://github.com/a/b/issues/1', 'https://gitlab.com/a/b/pull/1', 'https://github.com/a/b/pull/0', ' https://github.com/a/b/pull/1', 'https://github.com/a/pull/1'])
    assert.strictEqual(P.parsePrUrl(bad), null, String(bad));
  // a mention of …/pull/12 is not one of …/pull/123
  assert.strictEqual(P.mentions('see https://github.com/seanahn/kestrel/pull/123 now', URL), false);
  assert.strictEqual(P.mentions('x https://github.com/seanahn/kestrel/pull/123 and https://github.com/seanahn/kestrel/pull/12.', URL), true);

  // ---- the session whose `gh pr create` printed it wins, though another mentioned it earlier
  {
    const root = mk();
    record(root, '-w-other', 'aaaa1111-early-mention', [say(1, 'look at ' + URL), told(2, 'ok')], 1);
    record(root, '-w-kestrel', 'bbbb2222-maker', [
      say(3, 'open a PR'),
      call(4, 'toolu_1', 'git push -u origin feat && gh pr create --title x --body y'),
      result(5, 'toolu_1', 'remote: ...\n' + URL + '\n'),
      told(6, 'Opened ' + URL),
    ], 2);
    // a Bash call that only lists PRs does not make one; nor does a tool other than Bash running the words
    record(root, '-w-kestrel', 'cccc3333-viewer', [call(0, 'toolu_2', 'gh pr list'), result(0, 'toolu_2', URL), call(0, 'toolu_3', 'gh pr create', 'Task'), result(0, 'toolu_3', [{ type: 'text', text: URL }])], 0);
    assert.deepStrictEqual(await P.findPrSession(URL, { root }), { id: 'bbbb2222-maker', cwd: '/w/kestrel', file: path.join(root, '-w-kestrel', 'bbbb2222-maker.jsonl'), created: true });
  }

  // ---- with none made by `gh pr create`, the earliest mention by its entry's time, not the file's
  {
    const root = mk();
    record(root, '-w-a', 'late', [say(30, 'merged? ' + URL, '/w/a')], 5);
    record(root, '-w-b', 'early', [say(0, 'hello', '/w/b0'), told(10, 'the PR is ' + URL, '/w/b')], 0);
    const r = await P.findPrSession(URL, { root });
    assert.deepStrictEqual([r.id, r.cwd, r.created], ['early', '/w/b', false], 'the cwd of the entry that mentions it');
    // a result given as blocks of text counts as the result, as Claude Code keeps some
    record(root, '-w-c', 'blocks', [call(40, 'toolu_9', 'gh pr create --fill'), { type: 'user', timestamp: at(41), cwd: '/w/c', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [{ type: 'text', text: URL }] }] } }], 0);
    assert.strictEqual((await P.findPrSession(URL, { root })).id, 'blocks');
  }

  // ---- records last written more than 30 days ago are passed over
  {
    const root = mk();
    record(root, '-w', 'old-maker', [call(1, 't', 'gh pr create'), result(2, 't', URL)], 31);
    assert.strictEqual(await P.findPrSession(URL, { root }), null, 'only an old record has it');
    record(root, '-w', 'recent', [say(50, URL)], 29);
    assert.strictEqual((await P.findPrSession(URL, { root })).id, 'recent');
  }

  // ---- no match; nothing to search; not a PR URL; lines that are not JSON; a sub-agent's record is not a session
  {
    const root = mk();
    record(root, '-w', 'unrelated', [say(1, 'https://github.com/seanahn/kestrel/pull/120')]);
    fs.appendFileSync(path.join(root, '-w', 'unrelated.jsonl'), 'not json ' + URL + '\n');
    fs.mkdirSync(path.join(root, '-w', 'unrelated', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, '-w', 'unrelated', 'subagents', 'agent-x.jsonl'), JSON.stringify(say(1, URL)) + '\n');
    assert.strictEqual(await P.findPrSession(URL, { root }), null);
    assert.strictEqual(await P.findPrSession(URL, { root: path.join(root, 'missing') }), null);
    assert.strictEqual(await P.findPrSession('https://example.com/x', { root }), null);
  }

  // ---- a long record is read a line at a time: the URL far down a large file is found
  {
    const root = mk(), dir = path.join(root, '-w'); fs.mkdirSync(dir);
    const filler = JSON.stringify(say(0, 'x'.repeat(4000))) + '\n';
    fs.writeFileSync(path.join(dir, 'big.jsonl'), filler.repeat(3000) + JSON.stringify(say(5, URL)) + '\n');   // ~12 MB
    assert.strictEqual((await P.findPrSession(URL, { root })).id, 'big');
  }

  console.log('PR SESSIONS OK');
})().catch((e) => { console.error(e); process.exit(1); });
