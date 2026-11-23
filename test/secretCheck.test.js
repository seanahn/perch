'use strict';
// The composer's secret check (note 110): which rules match what, what is left alone, and the ignore list. The samples
// are put together here from pieces, so the source holds no whole key a scanner would stop.
const assert = require('assert');
const { RULES, findSecrets, entropy, sha256Hex } = require('../src/secretCheck');
const nodeSha = (x) => require('crypto').createHash('sha256').update(x, 'utf8').digest('hex');

const j = (...parts) => parts.join('');
const RANDOM40 = j('Zq8vN2kLp4Rt', 'X7wYb1Hc9Ue3', 'Jm5Gd0Fs6Ka8', 'Qx2T');   // 40 mixed characters, no structure
const names = (text, o) => findSecrets(text, o).map((h) => h.name);

// ---- the rule list itself
assert.deepStrictEqual(RULES.map((r) => r.name), ['Anthropic / OpenAI key', 'GitHub token', 'AWS access key', 'Slack token', 'Google API key', 'JSON Web Token', 'Private key', 'Password in a URL', 'Secret assignment', 'Random-looking string'], 'the design\'s rules, by name, in its order');
for (const r of RULES) assert(r.id && typeof r.id === 'string' && r.description && typeof r.description === 'string', 'each rule has an id and a description: ' + r.name);
assert.strictEqual(new Set(RULES.map((r) => r.id)).size, RULES.length, 'ids are unique');

// ---- each rule matches a realistic sample, and says which it is
const samples = [
  ['Anthropic / OpenAI key', j('sk-ant-api03-', 'Ab3dEf6hIj9kLm2nOp5q', 'Rs8tUv1wXy4z')],
  ['Anthropic / OpenAI key', j('sk-proj-', 'T3BlbkFJ9xQ2mN7vR4kL', '8pZ1wE6sY0aC')],
  ['GitHub token', j('ghp_', 'a1B2c3D4e5F6g7H8i9J0', 'k1L2m3N4o5P6q7R8')],
  ['GitHub token', j('gho_', 'Z9y8X7w6V5u4T3s2R1q0', 'P9o8N7m6L5k4J3i2')],
  ['GitHub token', j('github_pat_', '11ABCDEFG0123456789_', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV')],
  ['AWS access key', j('AKIA', 'IOSFODNN7', 'EXAMPLE')],
  ['AWS access key', j('ASIA', 'Y34FZKBOK', 'MUTVV7A')],
  ['Slack token', j('xoxb-', '2048163527-', '4096327154-', 'aBcDeFgHiJkLmNoPqRsTuVwX')],
  ['Slack token', j('xoxp-', '1234567890-', '0987654321-', '1122334455-', 'abcdef0123456789abcdef0123456789')],
  ['Google API key', j('AIza', 'SyD-9tSrke72PouQMnMX', '-a7eZSW0jkFMBWY')],
  ['JSON Web Token', j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')],
  ['Private key', j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x', RANDOM40, '\n-----END RSA ', 'PRIVATE KEY-----')],
  ['Private key', j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU')],
  ['Password in a URL', 'postgres://admin:' + j('hunter', '2Secret') + '@db.internal:5432/app'],
  ['Password in a URL', 'redis://:' + j('r3dis', 'Pa55') + '@cache.internal:6379/0'],
  ['Private key', j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----\n\nlQOYBF', RANDOM40, '\n-----END PGP ', 'PRIVATE KEY BLOCK-----')],
  ['Secret assignment', 'password=' + j('correct', 'horse')],
  ['Secret assignment', 'export GITHUB_TOKEN="' + j('abc', 'def123') + '"'],
  ['Secret assignment', '{ "api_key": "' + j('k3y-', 'value-99') + '" }'],
  ['Secret assignment', 'pwd: ' + j('s3cr', 'et!')],
  ['Random-looking string', 'the value is ' + RANDOM40 + ' as given'],
];
for (const [name, text] of samples) {
  const hits = findSecrets('before ' + text + ' after');
  assert.deepStrictEqual(hits.map((h) => h.name), [name], 'one hit, ' + name + ': ' + text);
  const h = hits[0], src = 'before ' + text + ' after';
  assert.strictEqual(src.slice(h.start, h.end), h.value, 'start and end mark the value in the text: ' + name);
  assert.strictEqual(RULES.find((r) => r.id === h.rule).name, name, 'the hit names its rule by id: ' + name);
}
// where the value is part of a larger match, the value is what is marked: the password, the assigned value
assert.strictEqual(findSecrets(samples[13][1])[0].value, j('hunter', '2Secret'), 'the password in a URL, not the whole URL');
assert.strictEqual(findSecrets(samples[18][1])[0].value, j('k3y-', 'value-99'), 'the assigned value, without its quotes');
assert.strictEqual(findSecrets(samples[14][1])[0].value, j('r3dis', 'Pa55'), 'a password with no user name');
// a token in an assignment is named for what it is, once
assert.deepStrictEqual(names('GITHUB_TOKEN=' + samples[2][1]), ['GitHub token'], 'the specific rule wins, and the assignment does not repeat it');
// two different secrets: both, in order
assert.deepStrictEqual(names(samples[5][1] + ' and ' + samples[2][1]), ['AWS access key', 'GitHub token']);

// ---- left alone
const clean = [
  ['a UUID', 'request 123e4567-e89b-12d3-a456-426614174000 failed'],
  ['a UUID in capitals', 'ID 9F1C2B7A-44D0-4E3B-9C7D-0A1B2C3D4E5F'],
  ['a 40-hex hash', 'commit 3f786850e387550fdab836ed7e6dc881de23001b'],
  ['a 64-hex hash', 'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['a URL without credentials', 'see https://github.com/seanahn/perch/blob/main/docs/notes/110-features.md#n110 and https://example.com/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'],
  ['a file path', 'open /home/someone/projects/perch/src/secretCheck.js and C:\\Users\\someone\\AppData\\Roaming\\Code\\User\\settings.json'],
  ['a long path without dots', 'cd /var/lib/containers/storage/overlay/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'],
  ['a macOS path', 'ls /Users/someone/Library/Caches/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'],
  ['a home path', 'cat ~/projects/perch/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'],
  // folders with inner capitals, ids, dots, dashes and ~, and no extension at the end
  ['an Azure resource id', '/subscriptions/0b1f6471-1bf0-4dda-aec3-111122223333/resourceGroups/rg-prod/providers/Microsoft.Web/sites/myApp'],
  ['an az --scope', 'az role assignment create --scope /subscriptions/3c9b1e2a-4f5d-4e6a-9b8c-7d6e5f4a3b2c/resourceGroups/rg-prod'],
  ['a simulator path', '/Users/JohnSmith/Library/Developer/CoreSimulator/Devices/5A2C3E4F-1B2D-4C5E-8F9A-0B1C2D3E4F5A/data'],
  ['a kubelet path', '/var/lib/kubelet/pods/7d9f2c1e-3b4a-4c5d-9e8f-1a2b3c4d5e6f/volumes/kubernetes.io~secret/default-token'],
  ['a dot folder', '/home/sahn/.local/share/code-server/extensions'],
  ['a macOS path with a capital inside a name', 'ls /Users/SeanAhn/Library/Caches/com/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'],
  ['an Azure id with an upper-case group', '/subscriptions/3c9b1e2a-4f5d-4e6a-9b8c-7d6e5f4a3b2c/resourceGroups/RG-Prod2/providers'],
  ['ordinary prose', 'Please refactor the token handling in the parser so the password prompt appears once, and explain the secret of its speed.'],
  ['password with nothing after it', 'password: \nnext line'],
  ['password: and nothing at all', 'password:'],
  ['a short token', 'token=abc'],
  ['a long identifier', 'ComponentDidUpdateLifecycleHandlerFactoryProvider'],
  // everyday code that names a secret without holding one
  ['a type annotation', 'password: string;'],
  ['a token type', 'token: string'],
  ['a boolean flag', 'secret: boolean,'],
  ['an environment read', 'const password = process.env.DB_PASSWORD;'],
  ['a shell variable', 'curl -H token=${GITHUB_TOKEN} https://api.example.com'],
  ['a Python Optional', 'def login(user: str, password: Optional[str] = None):'],
  ['a Python os.environ', 'secret = os.environ["APP_SECRET"]'],
  ['an env. read', 'api_key: env.OPENAI_API_KEY'],
  ['a template value', 'token: {{ secrets.DEPLOY_TOKEN }}'],
  ['a path value', 'pwd: /home/someone/projects'],
  ['a redacted value', '{ "token": "<redacted>" }'],
  ['a None value', 'token = None'],
  ['a List type', 'tokens: List[str]; token: List[str]'],
  // identifiers and paths that hold a digit
  ['a camelCase identifier with a digit', 'handleOAuth2CallbackRedirectForProvider'],
  ['another', 's3BucketNameForArtifactStorageV2'],
  ['a relative file path', 'see src/components/Dashboard/WidgetContainer2.tsx for it'],
  ['a node_modules path', 'node_modules/@anthropic-ai/claude-agent-sdk/dist/esm/index2.js'],
  ['a host and path', 'github.com/seanahn/perch/blob/main/docs/notes/110-features.md'],
  ['a Kubernetes label', 'app.kubernetes.io/instance=perch-7f9c8d6b5a-x2k4zq9wr7tlm3'],
  ['a date slug', '2026-11-23-secret-check-review-notes-v2'],
  ['a snake_case name', 'test_secret_check_handles_snake_case_names_v2'],
  ['an npm integrity value', '"integrity": "sha512-' + j('Zq8vN2kLp4RtX7wYb1Hc9Ue3Jm5Gd0Fs6Ka8Qx2T', 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF') + '=="'],
  ['a sha384 integrity value', 'integrity="sha384-' + RANDOM40 + '"'],
  ['a data: URI', 'src="data:image/png;base64,' + RANDOM40 + RANDOM40 + '"'],
  ['sk- in a package name', 'sk-learn-preprocessing-pipeline-docs'],
  ['a long identifier with no digit', 'useEffectCleanupSubscriptionManagerHook'],
  ['a long snake_case name with no digit', 'test_secret_check_handles_long_snake_case_names'],
  ['an upper-case constant', 'MAX_RETRY_COUNT_FOR_ARTIFACT_STORAGE_UPLOAD_V2'],
  ['a kebab-case slug with digits', 'release-notes-for-version-12-of-the-dashboard-widget'],
];
for (const [what, text] of clean) assert.deepStrictEqual(names(text), [], 'not flagged: ' + what);

// ---- ignore: an expression that matches the value in full suppresses it
const trace = 'trace ' + j('TRC', '0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6');
assert.deepStrictEqual(names(trace), ['Random-looking string'], 'a trace id looks random');
assert.deepStrictEqual(names(trace, { ignore: ['TRC[0-9A-Za-z]{33}'] }), [], 'matched in full: not flagged');
assert.deepStrictEqual(names(trace, { ignore: ['TRC'] }), ['Random-looking string'], 'matched only in part: still flagged');
assert.deepStrictEqual(names(trace, { ignore: ['(unclosed', 'TRC.*'] }), [], 'an invalid expression is skipped, the others still apply');
assert.deepStrictEqual(names(samples[2][1], { ignore: ['nothing'] }), ['GitHub token'], 'an ignore that does not match changes nothing');
assert.deepStrictEqual(names('token=' + RANDOM40, { ignore: [RANDOM40] }), [], 'an ignored value keeps its place: the random rule does not flag it again');
const long = j('Zq8vN2kLp4Rt', 'X7wYb1Hc9Ue3').repeat(50);   // 1200 characters
assert.deepStrictEqual(names('x ' + long + ' y', { ignore: ['[A-Za-z0-9]+'] }), ['Random-looking string'], 'a value over 512 characters is not matched against the ignore list');
// a type is skipped only when the value is the type expression, not when it merely starts with a type's name
for (const [text, value] of [['password: String!Pass1', 'String!Pass1'], ['secret: Null#Pass99', 'Null#Pass99'], ['api_key: any-thing-goes-9', 'any-thing-goes-9'], ['password=True2024!', 'True2024!'], ['pwd: integer7Secret', 'integer7Secret']])
  assert.deepStrictEqual(findSecrets(text).map((h) => [h.name, h.value]), [['Secret assignment', value]], 'flagged: ' + text);
for (const text of ['password: string[]', 'token: string | null', 'secret: boolean?', 'api_key: str)', 'password: object;', 'token: Map<string, string>', 'token: undefined'])
  assert.deepStrictEqual(names(text), [], 'a type expression is not flagged: ' + text);

// random keys, made by a seeded generator so the counts do not change from run to run: the words-run-together skip
// must not swallow them. Misses allowed: 1% (2% where a key may by chance have no digit, or words in a prefix)
{
  let seed = 0x5eed1e55;
  const next = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };   // mulberry32
  const rnd = (alpha, n) => { let o = ''; for (let i = 0; i < n; i++) o += alpha[Math.floor(next() * alpha.length)]; return o; };
  const LOWER = 'abcdefghijklmnopqrstuvwxyz', UPPER = LOWER.toUpperCase(), DIGITS = '0123456789', A62 = UPPER + LOWER + DIGITS;
  const shuffle = (s) => { const a = [...s]; for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(next() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; } return a.join(''); };
  const kinds = [
    ['32 lower+digit', () => rnd(LOWER + DIGITS, 32), 0.01],
    ['40 lower+digit', () => rnd(LOWER + DIGITS, 40), 0.01],
    ['40 upper+digit', () => rnd(UPPER + DIGITS, 40), 0.01],
    ['38 letters + 2 digits', () => shuffle(rnd(UPPER + LOWER, 38) + rnd(DIGITS, 2)), 0.01],
    ['40 letters + 2 digits at the end', () => rnd(UPPER + LOWER, 38) + rnd(DIGITS, 2), 0.01],
    ['AWS-style 40 mixed', () => rnd(A62 + '+/', 40), 0.02],
    ['sk_live_ + 24', () => 'sk_live_' + rnd(A62, 24), 0.02],
  ];
  const N = 400;
  for (const [what, gen, allowed] of kinds) {
    let missed = 0, example = '';
    for (let i = 0; i < N; i++) { const v = gen(); if (!findSecrets('the key is ' + v + ' here').length) { missed++; example = example || v; } }
    assert(missed <= N * allowed, what + ': ' + missed + ' of ' + N + ' missed (at most ' + N * allowed + '), e.g. ' + example);
  }
}

assert.deepStrictEqual(names('key /rm0zWSY8ybNdytvjH/4R9E4hJKcYCuC7n/iAvI6 here'), ['Random-looking string'], 'a key that starts with / is not taken for a path');
// base64 keys that start with // or /x/: an empty or one-character folder does not read as a name
{
  let seed = 0x0b5e55ed;
  const next = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const rnd = (n) => { let o = ''; for (let i = 0; i < n; i++) o += B64[Math.floor(next() * 64)]; return o; };
  for (const [what, gen] of [['//', () => '//' + rnd(38)], ['/x/', () => '/' + B64[Math.floor(next() * 62)] + '/' + rnd(37)], ['/ and base64', () => '/' + rnd(39)]]) {
    let missed = 0, example = ''; const N = 400;
    for (let i = 0; i < N; i++) { const v = gen(); if (!findSecrets('key ' + v + ' here').length) { missed++; example = example || v; } }
    assert(missed <= N * 0.005, what + ': ' + missed + ' of ' + N + ' missed (at most 2), e.g. ' + example);
  }
}
// sk- needs a digit or mixed case after it
assert.deepStrictEqual(names('sk-' + j('abcdefghij', 'klmnopqrst', 'uv1')), ['Anthropic / OpenAI key'], 'with a digit');

// ---- entropy
assert.strictEqual(entropy(''), 0);
assert.strictEqual(entropy('aaaaaaaa'), 0);
assert.strictEqual(entropy('abababab'), 1);
assert(Math.abs(entropy('0123456789abcdef') - 4) < 1e-9, '16 different characters, once each: 4 bits');
const lowButLong = 'ab12'.repeat(10);   // 40 characters, 2 bits each
assert.deepStrictEqual(names('x ' + lowButLong + ' y'), [], 'long but repetitive: below the threshold');
assert(entropy(RANDOM40) >= 4, 'the random sample is above it');
// the rule adds the Miller-Madow correction, (distinct - 1) / (2 n ln 2): a 32-character sample of a 36-letter alphabet
// shows about 4.4 bits where the source has 5.2, and 4% of random 32-character lower-case-and-digit keys fall under 4.0
const atThreshold = 'aZ3kQ9xW1mR7pL5t'.repeat(2);    // 32 characters, 16 different, evenly: 4 bits, 4.34 corrected
assert(Math.abs(entropy(atThreshold) - 4) < 1e-9, 'entropy() itself is plain Shannon entropy');
assert.deepStrictEqual(names('x ' + atThreshold + ' y'), ['Random-looking string'], '4.0 bits per character is enough');
const correctedOver = 'aZ3kQ9xW1mR7pL5'.repeat(3);   // 45 characters, 15 different: 3.91 bits, 4.13 corrected
assert(entropy(correctedOver) < 4);
assert.deepStrictEqual(names('x ' + correctedOver + ' y'), ['Random-looking string'], 'under 4.0 plain, over it corrected: flagged');
const underThreshold = 'aZ3kQ9xW1mR7p'.repeat(3);   // 39 characters, 13 different: 3.70 bits, 3.92 corrected
assert.deepStrictEqual(names('x ' + underThreshold + ' y'), [], 'under 4.0 corrected: not flagged');
assert.deepStrictEqual(names('x ' + atThreshold.slice(0, 31) + ' y'), [], 'and 31 characters are too short');

// ---- SHA-256, in plain JavaScript, so the page needs no crypto.subtle (code-server over http has none)
for (const x of ['\ud800', 'a\udc00b', '\ud83d', 'x\udc00\ud800y', '', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓ 🔑', RANDOM40]) assert.strictEqual(sha256Hex(x), nodeSha(x), 'sha256Hex agrees with node for ' + JSON.stringify(x.slice(0, 20)) + ' (' + x.length + ')');

// ---- no slow inputs: long runs of the characters the rules repeat over
for (const [what, big] of [['dots', 'a.'.repeat(50000)], ['hyphens and pluses', 'a-b+'.repeat(25000)], ['one long word', 'x'.repeat(100000)], ['mixed', 'Ab1-'.repeat(25000)], ['spaces and colons', 'a: '.repeat(33334)]]) {
  const t0 = Date.now(); findSecrets(big); const ms = Date.now() - t0;
  assert(ms < 1000, '100K characters of ' + what + ' in under a second (it took 1.9 s when the URL rule was quadratic): ' + ms + ' ms');
}

console.log('SECRET CHECK OK');
