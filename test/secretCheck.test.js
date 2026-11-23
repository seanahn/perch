'use strict';
// The composer's secret check (note 110): which rules match what, what is left alone, and the ignore list. The samples
// are put together here from pieces, so the source holds no whole key a scanner would stop.
const assert = require('assert');
const { RULES, findSecrets, entropy } = require('../src/secretCheck');

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
assert.strictEqual(findSecrets(samples[16][1])[0].value, j('k3y-', 'value-99'), 'the assigned value, without its quotes');
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
  ['ordinary prose', 'Please refactor the token handling in the parser so the password prompt appears once, and explain the secret of its speed.'],
  ['password with nothing after it', 'password: \nnext line'],
  ['password: and nothing at all', 'password:'],
  ['a short token', 'token=abc'],
  ['a long identifier', 'ComponentDidUpdateLifecycleHandlerFactoryProvider'],
];
for (const [what, text] of clean) assert.deepStrictEqual(names(text), [], 'not flagged: ' + what);

// ---- ignore: an expression that matches the value in full suppresses it
const trace = 'trace ' + j('TRC', '0a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6');
assert.deepStrictEqual(names(trace), ['Random-looking string'], 'a trace id looks random');
assert.deepStrictEqual(names(trace, { ignore: ['TRC[0-9A-Za-z]{33}'] }), [], 'matched in full: not flagged');
assert.deepStrictEqual(names(trace, { ignore: ['TRC'] }), ['Random-looking string'], 'matched only in part: still flagged');
assert.deepStrictEqual(names(trace, { ignore: ['(unclosed', 'TRC.*'] }), [], 'an invalid expression is skipped, the others still apply');
assert.deepStrictEqual(names(samples[2][1], { ignore: ['nothing'] }), ['GitHub token'], 'an ignore that does not match changes nothing');

// ---- entropy
assert.strictEqual(entropy(''), 0);
assert.strictEqual(entropy('aaaaaaaa'), 0);
assert.strictEqual(entropy('abababab'), 1);
assert(Math.abs(entropy('0123456789abcdef') - 4) < 1e-9, '16 different characters, once each: 4 bits');
const lowButLong = 'ab12'.repeat(10);   // 40 characters, 2 bits each
assert.deepStrictEqual(names('x ' + lowButLong + ' y'), [], 'long but repetitive: below the threshold');
assert(entropy(RANDOM40) >= 4, 'the random sample is above it');
const atThreshold = 'abcdefghijklmn01'.repeat(2);    // 32 characters, 16 different, evenly: 4 bits exactly
assert(Math.abs(entropy(atThreshold) - 4) < 1e-9);
assert.deepStrictEqual(names('x ' + atThreshold + ' y'), ['Random-looking string'], '4.0 bits per character is enough');
const underThreshold = 'abcdefghijklmn0'.repeat(3);   // 45 characters, 15 different: about 3.91 bits
assert(entropy(underThreshold) < 4);
assert.deepStrictEqual(names('x ' + underThreshold + ' y'), [], 'just under 4.0 is not');
assert.deepStrictEqual(names('x ' + atThreshold.slice(0, 31) + ' y'), [], 'and 31 characters are too short');

console.log('SECRET CHECK OK');
