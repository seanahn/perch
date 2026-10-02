'use strict';
// List prices for the models a gateway's responses name, so a turn through the gateway can be priced when the gateway
// itself gives no figure: LiteLLM puts `x-litellm-response-cost` only on a response it has finished pricing, which a
// streamed one (and Claude Code streams every request) never is at header time. The table is LiteLLM's own public one,
// the same one the gateway prices with (short of a deployment's own overrides), fetched once a week into a file of the
// host's. A name is looked up as the gateway spells it (`global.openai.gpt-6-luna`, `xai/grok-4.6`), then with its region
// and provider prefixes taken off. No VS Code dependency.

const fs = require('fs');
const https = require('https');
const path = require('path');

const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** GET a URL as text, following a few redirects. Replaceable for tests. */
function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'perch' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) { res.resume(); resolve(fetchText(new URL(res.headers.location, url).href, hops + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** The names a gateway's spelling of a model is tried under, most specific first. */
function candidates(model) {
  const out = [];
  const add = (s) => { if (s && !out.includes(s)) out.push(s); };
  let s = String(model || '').trim().replace(/\[\w+\]$/, '');   // a `[1m]` context suffix is Claude Code's, not the model's
  add(s);
  const noRegion = s.replace(/^(global|us|eu|apac|au|jp|ca|us-gov)\./, '');
  add(noRegion);
  const noProvider = noRegion.replace(/^[a-z_]+\//, '');
  add(noProvider);
  add(noProvider.replace(/^(global|us|eu|apac|au|jp|ca|us-gov)\./, ''));
  add(noProvider.replace(/^(openai|anthropic|xai|meta|amazon|mistral|cohere|google)\./, ''));
  add(noProvider.replace(/^(global|us|eu|apac|au|jp|ca|us-gov)\./, '').replace(/^(openai|anthropic|xai|meta|amazon|mistral|cohere|google)\./, ''));
  return out;
}

/**
 * The rates for a model, per token, from a LiteLLM table: null when the table has no entry under any of its names.
 * A missing cache-write or cache-read rate falls back to the input rate, as LiteLLM's own pricing does.
 * @returns {{ name: string, input: number, output: number, cacheWrite: number, cacheRead: number, cacheWrite1h: number|null }|null}
 */
function lookup(table, model) {
  if (!table || typeof table !== 'object') return null;
  for (const name of candidates(model)) {
    const e = table[name];
    if (!e || typeof e !== 'object' || typeof e.input_cost_per_token !== 'number') continue;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const input = e.input_cost_per_token;
    return {
      name,
      input,
      output: num(e.output_cost_per_token) !== null ? e.output_cost_per_token : 0,
      cacheWrite: num(e.cache_creation_input_token_cost) !== null ? e.cache_creation_input_token_cost : input,
      cacheRead: num(e.cache_read_input_token_cost) !== null ? e.cache_read_input_token_cost : input,
      cacheWrite1h: num(e.cache_creation_input_token_cost_above_1hr),
    };
  }
  return null;
}

/** What one response cost at a model's rates. `usage` is { input, cache_write, cache_read, output, cache_write_1h }. */
function costOf(rate, usage) {
  const u = usage || {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const w1h = rate.cacheWrite1h !== null ? n(u.cache_write_1h) : 0;   // written for an hour, at that rate, when the response says so and the table prices it
  return n(u.input) * rate.input + (n(u.cache_write) - w1h) * rate.cacheWrite + w1h * (rate.cacheWrite1h || 0) + n(u.cache_read) * rate.cacheRead + n(u.output) * rate.output;
}

/**
 * The table, kept in a file: read at once when the file is fresh, fetched in the background otherwise (a stale file
 * serves until the fetch lands; a failed fetch leaves it). `rateFor` answers from whatever is loaded, null before that.
 */
function createPrices({ file, maxAgeMs = MAX_AGE_MS, now = Date.now } = {}) {
  let table = null, loading = null, loadedAt = 0;
  const read = () => { try { table = JSON.parse(fs.readFileSync(file, 'utf8')); loadedAt = fs.statSync(file).mtimeMs; return true; } catch (_) { return false; } };
  const fresh = () => loadedAt && now() - loadedAt < maxAgeMs;
  function load() {
    if (!table) read();
    if (fresh() || loading) return loading || Promise.resolve();
    loading = (async () => {
      try {
        const text = await module.exports.fetch(PRICES_URL);
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') throw new Error('not a table');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.perch-' + process.pid + '.tmp';
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
        table = parsed; loadedAt = now();
      } catch (_) { /* the old table, or none, serves */ }
      finally { loading = null; }
    })();
    return loading;
  }
  return { load, rateFor: (model) => lookup(table, model), get loaded() { return !!table; }, get file() { return file; } };
}

module.exports = { PRICES_URL, MAX_AGE_MS, fetch: fetchText, candidates, lookup, costOf, createPrices };
