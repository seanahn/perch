'use strict';
// The composer's secret check (note 110): does a message about to be sent hold a password or key? It runs in the page,
// on the text alone: `findSecrets` and `entropy` below are written into the page's script as source, and RULES as data,
// so they must stand alone (no require, nothing from outside themselves but each other and RULES) and must not contain
// the text that closes a script. `sha256Hex` is plain JavaScript so the page needs no crypto.subtle, which a page served
// over plain http (code-server, say) does not have, and so the check stays synchronous.

/** The rules, in the order the design lists them: what the user is told, by name, and on Why?, by description. */
const RULES = [
  { id: 'vendor-key', name: 'Anthropic / OpenAI key', description: 'sk- followed by 20 or more key characters with a digit or mixed case among them, as in sk-ant-… and sk-proj-… keys.' },
  { id: 'github-token', name: 'GitHub token', description: 'ghp_, gho_, ghu_, ghs_ or ghr_ followed by 36 characters, or a github_pat_… token.' },
  { id: 'aws-key', name: 'AWS access key', description: 'AKIA or ASIA followed by 16 upper-case letters or digits.' },
  { id: 'slack-token', name: 'Slack token', description: 'xoxb-, xoxp-, xoxa- or xoxr- followed by the rest of a Slack token.' },
  { id: 'google-key', name: 'Google API key', description: 'AIza followed by 35 characters.' },
  { id: 'jwt', name: 'JSON Web Token', description: 'Three dot-separated parts, the first two starting eyJ: a signed token.' },
  { id: 'private-key', name: 'Private key', description: 'A -----BEGIN … PRIVATE KEY----- block.' },
  { id: 'url-password', name: 'Password in a URL', description: 'A password written into an address, as in scheme://user:password@host.' },
  { id: 'assignment', name: 'Secret assignment', description: 'password, passwd, pwd, secret, api_key, apikey, token or access_token, then = or :, then a value of 6 or more characters that is not a type name, a variable, an environment read, a path or a placeholder.' },
  { id: 'random', name: 'Random-looking string', description: 'One run of 32 or more letters, digits and +/_-= with a digit in it and at least 4 bits of entropy per character (corrected for a short sample); not words run together, a UUID, a hex hash, an integrity value, an address, a data: URI or a file path.' },
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

/** SHA-256 of `s` (as UTF-8), in lower-case hex. */
function sha256Hex(s) {
  s = String(s);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } }
    if (c >= 0xd800 && c < 0xe000) c = 0xfffd;   // a lone surrogate: U+FFFD, as TextEncoder and node write it
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? Math.floor(bits / 2 ** (8 * i)) & 255 : (bits >>> (8 * i)) & 255);
  const K = [];
  const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
  for (let n = 2; K.length < 64; n++) { let prime = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; } if (prime) K.push(frac(Math.cbrt(n))); }
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const W = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = ((bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) | (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3]) >>> 0;
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * The values in `text` that look like passwords or keys, in order of where they start, none overlapping.
 * @param {string} text
 * @param {{ ignore?: string[] }} [opts]  regular expressions; a value one of them matches in full is not reported. An
 *   invalid one is skipped, and a value over 512 characters is not tried against them.
 * @returns {Array<{ rule: string, name: string, start: number, end: number, value: string }>}
 */
function findSecrets(text, { ignore = [] } = {}) {
  text = String(text || '');
  const ignores = [];
  for (const src of Array.isArray(ignore) ? ignore : []) { if (typeof src !== 'string' || !src) continue; try { ignores.push(new RegExp('^(?:' + src + ')$')); } catch (_) { /* invalid: skipped */ } }
  const name = (id) => { for (const r of RULES) if (r.id === id) return r.name; return id; };
  const found = [], taken = [];   // taken: every span a rule matched, ignored ones too, so no later rule flags it again
  const overlaps = (a, b) => taken.some((h) => a < h.end && h.start < b);
  const take = (rule, start, value) => {
    const end = start + value.length;
    if (!value || overlaps(start, end)) return;
    taken.push({ start, end });
    if (value.length <= 512 && ignores.some((re) => re.test(value))) return;
    found.push({ rule, name: name(rule), start, end, value });
  };
  // what an assignment's value is when it is code, not a secret: a type, a variable, an environment read, a path, a
  // placeholder or a template
  const TYPE = /^(?:string|number|boolean|bool|str|int|integer|float|double|bigint|any|object|unknown|void|undefined|null|none|nil|bytes|char|true|false)(?:[[<|?,;)]|$)/i;   // the type itself, or the start of a type expression
  const GENERIC = /^(?:Optional|List|Dict|Set|Tuple|Union|Array|Record|Map|Promise|Sequence|Iterable|Mapping|Literal|ReadonlyArray)[[<]/;
  const NOT_A_VALUE = /^(?:[$<\/~]|\{\{|process\.env|os\.environ|env\.)/;
  const codeValue = (v) => TYPE.test(v) || GENERIC.test(v) || NOT_A_VALUE.test(v);
  // the specific rules first, so a key in an assignment is named for what it is. `group`: the part of the match that is
  // the value (a URL's password, an assignment's value); 0 is the whole match
  const SPECIFIC = [
    ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)?/g, 0],
    ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g, 0],
    ['github-token', /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g, 0],
    ['vendor-key', /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, 0],
    ['aws-key', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, 0],
    ['slack-token', /(?<![A-Za-z0-9])xox[bpar]-[A-Za-z0-9-]{10,}/g, 0],
    ['google-key', /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, 0],
    ['url-password', /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]*:([^\s/@]+)@[^\s/@]+/dg, 1],
    ['assignment', /(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|api_key|apikey|access_token|token)["']?[ \t]*[=:][ \t]*["'`]?([^\s"'`]{6,})/dgi, 1],
  ];
  for (const [rule, re, group] of SPECIFIC) {
    let m;
    while ((m = re.exec(text))) {
      const value = m[group], start = group ? m.indices[group][0] : m.index;
      if (rule === 'vendor-key' && !(/[0-9]/.test(value.slice(3)) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))) continue;   // sk-learn-…: words, not a key
      if (rule === 'assignment' && codeValue(value)) continue;
      take(rule, start, value);
    }
  }
  // words run together, as names are: camelCase, snake_case, kebab-case, a/b. It takes (a) real separators or
  // lower-to-upper word boundaries, and (b) pieces that read as words: 3 or more letters each on average, most with a
  // vowel, none with five consonants in a row. A random key fails (a) when it has one case and no separators, and (b)
  // otherwise: its letter runs mostly lack vowels.
  const VOWEL = /[aeiouy]/i, CLUSTER = /[^aeiouy]{5}/i;
  const wordy = (v) => {
    if (!/[/_-]/.test(v) && !/[a-z][A-Z]/.test(v)) return false;
    const pieces = v.split(/[^A-Za-z]+/).flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter(Boolean);
    if (!pieces.length || pieces.reduce((n, p) => n + p.length, 0) / pieces.length < 3) return false;
    const long = pieces.filter((p) => p.length >= 2);
    if (long.length < 2 || long.some((p) => CLUSTER.test(p))) return false;
    return long.filter((p) => VOWEL.test(p)).length >= 0.8 * long.length;
  };
  // /a/b/c or ~/a/b: most of the folders before the last part read as names, as a random key that happens to
  // hold a / does not. A name: a UUID, a hex or numeric id, or words (lower case, PascalCase, camelCase, with dots,
  // dashes, _, @ and ~; in mixed case, no digit followed by a letter), pieces of 3+ letters on average, mostly with a vowel (a, e, i, o, u), none with five consonants in a row. An empty or one-character
  // folder (//, /x/) is not a name.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const folderName = (d) => {
    if (d.length < 2 || !/^[A-Za-z0-9._~@+-]+$/.test(d)) return false;
    if (UUID.test(d) || /^[0-9a-f]{6,}$/i.test(d) || /^[0-9][0-9._-]*$/.test(d)) return true;
    const pieces = d.split(/[^A-Za-z]+/).flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)).filter(Boolean);
    if (!pieces.length || pieces.reduce((n, p) => n + p.length, 0) / pieces.length < 3 || pieces.some((p) => CLUSTER.test(p))) return false;
    if (!/[A-Z]/.test(d) || pieces.length === 1) return true;   // lib, usr, code-server, kubernetes.io~secret
    if (/[a-z]/.test(d) && /[0-9][A-Za-z]/.test(d)) return false;   // mixed case with digits inside: a key, not a name (IntelliJIdea2023 is)
    const long = pieces.filter((p) => p.length >= 2);
    return long.filter((p) => /[aeiou]/i.test(p)).length >= 0.6 * long.length;
  };
  const absolutePath = (s) => {
    const dirs = s.replace(/^~/, '').split('/').slice(1, -1);
    return dirs.length > 0 && dirs.filter(folderName).length * 2 > dirs.length;
  };
  // random-looking strings: within one whitespace-separated word that is not an address, a data: URI or a file path
  const word = /\S+/g;
  let w;
  while ((w = word.exec(text))) {
    const s = w[0].replace(/^[("'`[{<]+/, '');
    const lead = w[0].length - s.length;
    const bare = s.replace(/[)\]}>"'`.,;:!?]+$/, '');
    if (/:\/\//.test(s) || /^www\./i.test(s)) continue;                                  // an address; one with a password is the URL rule's
    if (/^(?:\.{1,2}[/\\]|[A-Za-z]:[\\/])/.test(s) || s.includes('\\')) continue;   // a relative or Windows path
    if (/^~?\//.test(s) && absolutePath(s)) continue;                                      // an absolute path
    if (bare.includes('/') && (/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(bare) || /[A-Za-z0-9-]\.[A-Za-z]{2,}\//.test(bare))) continue;   // a/b/c.ext, host.tld/path
    if (/(?:^|[^A-Za-z0-9])data:[A-Za-z]+\/[A-Za-z0-9.+-]+[;,]/.test(s)) continue;         // a data: URI
    const run = /[A-Za-z0-9+/_=-]{32,}/g;
    let r;
    while ((r = run.exec(s))) {
      const v = r[0];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) continue;   // a UUID
      if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)) continue;                              // a git or SHA-256 hash
      if (/^sha(?:256|384|512)-/.test(v)) continue;                                          // a subresource or npm integrity value
      if (!/[0-9]/.test(v)) continue;                                                        // a long identifier, not a key
      if (wordy(v)) continue;                                                                // words run together: a name
      if (entropy(v) + (new Set(v).size - 1) / (2 * v.length * Math.LN2) < 4) continue;   // Miller-Madow: a short sample understates entropy
      take('random', w.index + lead + r.index, v);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

module.exports = { RULES, findSecrets, entropy, sha256Hex };
