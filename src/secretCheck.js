'use strict';
// The composer's secret check (note 110): does a message about to be sent hold a password or key? It runs in the page,
// on the text alone: `findSecrets` and `entropy` below are written into the page's script as source, and RULES as data,
// so they must stand alone (no require, nothing from outside themselves but each other and RULES) and must not contain
// the text that closes a script.

/** The rules, in the order the design lists them: what the user is told, by name, and on Why?, by description. */
const RULES = [
  { id: 'vendor-key', name: 'Anthropic / OpenAI key', description: 'sk- followed by 20 or more key characters, as in sk-ant-… and sk-proj-… keys.' },
  { id: 'github-token', name: 'GitHub token', description: 'ghp_, gho_, ghu_, ghs_ or ghr_ followed by 36 characters, or a github_pat_… token.' },
  { id: 'aws-key', name: 'AWS access key', description: 'AKIA or ASIA followed by 16 upper-case letters or digits.' },
  { id: 'slack-token', name: 'Slack token', description: 'xoxb-, xoxp-, xoxa- or xoxr- followed by the rest of a Slack token.' },
  { id: 'google-key', name: 'Google API key', description: 'AIza followed by 35 characters.' },
  { id: 'jwt', name: 'JSON Web Token', description: 'Three dot-separated parts, the first two starting eyJ: a signed token.' },
  { id: 'private-key', name: 'Private key', description: 'A -----BEGIN … PRIVATE KEY----- block.' },
  { id: 'url-password', name: 'Password in a URL', description: 'A password written into an address, as in scheme://user:password@host.' },
  { id: 'assignment', name: 'Secret assignment', description: 'password, passwd, pwd, secret, api_key, apikey, token or access_token, then = or :, then a value of 6 or more characters.' },
  { id: 'random', name: 'Random-looking string', description: 'One run of 32 or more letters, digits and +/_-= with a digit in it and at least 4 bits of entropy per character; not a UUID, a 40- or 64-hex hash, an address or a file path.' },
];

/** Shannon entropy of `s`, in bits per character. */
function entropy(s) {
  if (!s) return 0;
  const counts = {};
  for (const c of s) counts[c] = (counts[c] || 0) + 1;
  let h = 0;
  for (const k in counts) { const p = counts[k] / s.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * The values in `text` that look like passwords or keys, in order of where they start, none overlapping.
 * @param {string} text
 * @param {{ ignore?: string[] }} [opts]  regular expressions; a value one of them matches in full is not reported. An
 *   invalid one is skipped.
 * @returns {Array<{ rule: string, name: string, start: number, end: number, value: string }>}
 */
function findSecrets(text, { ignore = [] } = {}) {
  text = String(text || '');
  const ignores = [];
  for (const src of Array.isArray(ignore) ? ignore : []) { if (typeof src !== 'string' || !src) continue; try { ignores.push(new RegExp('^(?:' + src + ')$')); } catch (_) { /* invalid: skipped */ } }
  const name = (id) => { for (const r of RULES) if (r.id === id) return r.name; return id; };
  const found = [];
  const overlaps = (a, b) => found.some((h) => a < h.end && h.start < b);
  const take = (rule, start, value) => {
    const end = start + value.length;
    if (!value || overlaps(start, end) || ignores.some((re) => re.test(value))) return;
    found.push({ rule, name: name(rule), start, end, value });
  };
  // the specific rules first, so a key in an assignment is named for what it is. `group`: the part of the match that is
  // the value (a URL's password, an assignment's value); 0 is the whole match
  const SPECIFIC = [
    ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/g, 0],
    ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g, 0],
    ['github-token', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g, 0],
    ['vendor-key', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, 0],
    ['aws-key', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, 0],
    ['slack-token', /(?<![A-Za-z0-9])xox[bpar]-[A-Za-z0-9-]{10,}/g, 0],
    ['google-key', /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, 0],
    ['url-password', /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@[^\s/@]+/dg, 1],
    ['assignment', /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api_key|apikey|access_token|token)["']?[ \t]*[=:][ \t]*["'`]?([^\s"'`]{6,})/dgi, 1],
  ];
  for (const [rule, re, group] of SPECIFIC) {
    let m;
    while ((m = re.exec(text))) {
      const value = m[group], start = group ? m.indices[group][0] : m.index;
      take(rule, start, value);
    }
  }
  // random-looking strings: within one whitespace-separated word that is not an address or a file path
  const word = /\S+/g;
  let w;
  while ((w = word.exec(text))) {
    const s = w[0].replace(/^[("'`[{<]+/, '');
    const lead = w[0].length - s.length;
    if (/:\/\//.test(s) || /^www\./i.test(s)) continue;                                  // an address; one with a password is the URL rule's
    if (/^(?:[/~]|\.{1,2}[/\\]|[A-Za-z]:[\\/])/.test(s) || s.includes('\\')) continue;   // a file path
    const run = /[A-Za-z0-9+/_=-]{32,}/g;
    let r;
    while ((r = run.exec(s))) {
      const v = r[0];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) continue;   // a UUID
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)) continue;                              // a git or SHA-256 hash
      if (!/[0-9]/.test(v)) continue;                                                        // a long identifier, not a key
      if (entropy(v) < 4) continue;
      take('random', w.index + lead + r.index, v);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

module.exports = { RULES, findSecrets, entropy };
