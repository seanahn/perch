'use strict';
// The price table a gateway's responses are priced with: names as the gateway spells them, a model's rates, a response's
// cost, and the file that holds the table.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/prices');

const TABLE = {
  'gpt-6-luna': { litellm_provider: 'openai', input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, cache_creation_input_token_cost: 1.25e-7, cache_read_input_token_cost: 1e-8 },
  'openai.gpt-6-luna': { litellm_provider: 'bedrock', input_cost_per_token: 1.1e-7, output_cost_per_token: 5e-7 },
  'xai/grok-4.6': { litellm_provider: 'xai', input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 5e-7 },
  'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_creation_input_token_cost: 5e-6, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost_above_1hr: 8e-6 },
  'sample_spec': { input_cost_per_token: 'n/a' },
};
const near = (a, b) => Math.abs(a - b) < 1e-12;

// ---- names: the gateway's spelling, then without region and provider
assert.deepStrictEqual(P.candidates('global.openai.gpt-6-luna'), ['global.openai.gpt-6-luna', 'openai.gpt-6-luna', 'gpt-6-luna']);
assert.deepStrictEqual(P.candidates('xai/grok-4.6'), ['xai/grok-4.6', 'grok-4.6']);
assert.deepStrictEqual(P.candidates('bedrock/us.anthropic.claude-opus-5-5'), ['bedrock/us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5-5']);
assert.deepStrictEqual(P.candidates('nexus-auto-bargain[1m]'), ['nexus-auto-bargain'], 'a context suffix is Claude Code\'s, not the model\'s');
assert.strictEqual(P.lookup(TABLE, 'global.openai.gpt-6-luna').name, 'openai.gpt-6-luna', 'the most specific name the table has wins');
assert.strictEqual(P.lookup(TABLE, 'azure/gpt-6-luna').name, 'gpt-6-luna');
assert.strictEqual(P.lookup(TABLE, 'nexus-auto-bargain'), null, 'a router\'s alias has no price');
assert.strictEqual(P.lookup(TABLE, 'sample_spec'), null, 'an entry without a numeric input price is no entry');
assert.strictEqual(P.lookup(null, 'gpt-6-luna'), null);

// ---- rates: a missing cache rate is the input rate, as LiteLLM prices it
const luna = P.lookup(TABLE, 'gpt-6-luna'), grok = P.lookup(TABLE, 'xai/grok-4.6'), opus = P.lookup(TABLE, 'claude-opus-5-5');
assert.deepStrictEqual(luna, { name: 'gpt-6-luna', input: 1e-7, output: 5e-7, cacheWrite: 1.25e-7, cacheRead: 1e-8, cacheWrite1h: null });
assert.deepStrictEqual([grok.cacheWrite, grok.cacheRead, grok.cacheWrite1h], [2e-6, 5e-7, null]);

// ---- a response's cost
assert(near(P.costOf(luna, { input: 2, cache_write: 95029, cache_read: 0, output: 14 }), 2 * 1e-7 + 95029 * 1.25e-7 + 14 * 5e-7), 'the hello that Claude Code priced at $0.594 as Opus is $0.0119 on Luna');
assert(near(P.costOf(grok, { input: 127, output: 68, cache_read: 512 }), 127 * 2e-6 + 68 * 6e-6 + 512 * 5e-7));
assert(near(P.costOf(opus, { cache_write: 1000, cache_write_1h: 1000 }), 1000 * 8e-6), 'an hour-long write at the hour\'s rate when the table has one');
assert(near(P.costOf(luna, { cache_write: 1000, cache_write_1h: 1000 }), 1000 * 1.25e-7), 'and at the plain write rate when it has none');
assert.strictEqual(P.costOf(luna, {}), 0);
assert.strictEqual(P.costOf(luna, { input: -5, output: 'x' }), 0, 'nonsense counts as nothing');

// ---- the file: fresh is read at once, stale or missing is fetched, a failed fetch leaves what there is
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-prices-'));
  const file = path.join(dir, 'prices.json');
  const realFetch = P.fetch;
  let fetches = 0, clock = Date.now();   // the file's mtime is real time, so the clock starts there
  try {
    P.fetch = async () => { fetches++; return JSON.stringify(TABLE); };
    const p = P.createPrices({ file, now: () => clock });
    assert.strictEqual(p.rateFor('gpt-6-luna'), null, 'nothing before a load');
    await p.load();
    assert.deepStrictEqual([fetches, p.loaded, fs.existsSync(file), p.rateFor('gpt-6-luna').name], [1, true, true, 'gpt-6-luna'], 'no file: fetched and kept');
    await p.load();
    assert.strictEqual(fetches, 1, 'fresh: not fetched again');
    // another host finds the file fresh and reads it without fetching
    const q = P.createPrices({ file, now: () => clock });
    const pending = q.load();
    assert.strictEqual(q.rateFor('xai/grok-4.6').name, 'xai/grok-4.6', 'a fresh file answers at once, before the promise settles');
    await pending;
    assert.strictEqual(fetches, 1);
    // stale: the old table serves while a fetch runs; a failed fetch leaves it
    clock += P.MAX_AGE_MS + 60000;   // well past the age: the file was written a little after the clock was read
    P.fetch = async () => { fetches++; throw new Error('offline'); };
    const r = P.createPrices({ file, now: () => clock });
    const w = r.load();
    assert.strictEqual(r.rateFor('gpt-6-luna').name, 'gpt-6-luna', 'the stale table serves meanwhile');
    await w;
    assert.deepStrictEqual([fetches, r.rateFor('gpt-6-luna').name], [2, 'gpt-6-luna'], 'fetched, failed, kept');
    P.fetch = async () => { fetches++; return 'not json'; };
    await r.load();
    assert.deepStrictEqual([fetches, r.loaded], [3, true], 'a bad body is not kept either');
  } finally {
    P.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('PRICES OK');
})().catch((e) => { console.error(e); process.exit(1); });
