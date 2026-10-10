const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const current = require('../services/memorySanitize');
const oracle = require('./fixtures/memorySanitize.oracle.cjs');

function equivalent(input, label) {
  if (typeof input === 'string') assert.ok(input.length <= 4096, 'oracle inputs must stay small');
  assert.deepEqual(current.redactSecrets(input), oracle.redactSecrets(input), label ?? JSON.stringify(input));
}

test('linear redaction preserves API, version, and the reflowed injection expressions', () => {
  assert.deepEqual(Object.keys(current), Object.keys(oracle));
  assert.equal(current.REDACTION_VERSION, 2);
  function expressions(filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const record = { exports: {} };
    const extract = '\nmodule.exports = INJECTION_PATTERNS.map(re => [re.source, re.flags]);';
    vm.runInNewContext(source + extract, { module: record });
    return JSON.parse(JSON.stringify(record.exports));
  }
  assert.deepEqual(expressions(require.resolve('../services/memorySanitize')),
    expressions(require.resolve('./fixtures/memorySanitize.oracle.cjs')));
});

test('oracle: leading letter, nested values, quoting, boundaries, and normalization regressions', () => {
  const unchanged = [
    'KEY=wxyz', 'CREDENTIAL=wxyz', 'CREDENTIALS=wxyz', 'SECRETARY=wxyz',
    'FOO="x=y"', 'FOO="AKEY=abc"', 'AKEY="unclosed', "AKEY='unclosed",
    'xAKEY=wxyz', '1AKEY=wxyz', 'Akey=wxyz', 'aKEY=wxyz',
    'FOO\u200B="x=y"', 'CRED\u200BENTIAL=wxyz', 'ＫＥＹ=wxyz',
  ];
  for (const input of unchanged) {
    equivalent(input);
    assert.deepEqual(current.redactSecrets(input), { text: input, redacted: false });
  }
  const masked = [
    ['FOO="AKEY=wxyz"', 'FOO="[REDACTED]"'],
    ['FOO="AKEY=\'wxyz\'"', 'FOO="[REDACTED]"'],
    ['AKEY="" tail', '[REDACTED] tail'],
    ["AKEY='' tail", '[REDACTED] tail'],
    ['AKEY="line\nline" tail', '[REDACTED] tail'],
    ['KEYKEY=wxyz', '[REDACTED]'],
    ['ACREDENTIALS_EXTRA=wxyz', '[REDACTED]'],
    ['FOO\u200B="AKEY=wxyz"', 'FOO\u200B="[REDACTED]"'],
    ['FOO="A\u200BKEY=wxyz"', '[REDACTED]'],
    ['ＡＫＥＹ=wxyz', '[REDACTED]'],
  ];
  for (const [input, text] of masked) {
    equivalent(input);
    assert.deepEqual(current.redactSecrets(input), { text, redacted: true });
  }
  const cases = [
    null, undefined, 42, false, { toString: () => 'AKEY=wxyz' },
    'AKEY'.repeat(256), 'eyJ-'.repeat(256), 'a-'.repeat(256),
    '-----BEGIN PRIVATE KEY-----'.repeat(32),
    '-----BEGIN PRIVATE KEY-----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY----------END PRIVATE KEY----- tail',
    '-----BEGIN BAD PRIVATE KEY----- inner -----BEGIN PRIVATE KEY----- body ' +
      '-----END OTHER PRIVATE KEY----- -----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY----- x -----END PRIVATE KEY-----\n' +
      '-----BEGIN PRIVATE KEY----- y -----END PRIVATE KEY-----',
    '-----BEGIN private KEY----- x -----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY----- x -----END private KEY-----',
    '-----BE\u200BGIN PRIVATE KEY----- x -----END PRIVATE KEY-----',
    'eyJ12345678.abcdefgh.abcdefgh-suffix',
    'x-eyJ12345678.abcdefgh.abcdefgh',
    'x_eyJ12345678.abcdefgh.abcdefgh',
    'eyJ1234567-eyJ12345678.abcdefgh.abcdefgh',
    'eyJ12345678.eyJ12345678.abc.abcdefgh.abcdefgh',
    'eyJ12345678/eyJ12345678.abcdefgh.abcdefgh',
    '_abc://u:p@ x_abc://u:p@ 9-abc://u:p@',
    'a-b://u:p@tail a+b.c://u:p@host',
    'a://b://u:p@host a://u:a-'.repeat(8),
    'a://u:p-a://u:p@host',
    'éAKEY=wxyz 한AKEY=wxyz 😀AKEY=wxyz',
    'AKEY=wxyz AKEY="AKEY=secret" CREDENTIAL\u200BS=x',
    'AKEY="[REDACTED]" [REDACTED]',
    'AKEY\t:\r\n\u00A0wxyz tail',
    'AKEY=\"other\' AKEY=wxyz',
    'AKEY=\'other\" AKEY=wxyz',
    'AKEY="inner AKEY=abc" AKEY=""',
    'AKEY="ghp_abcdefghijklmnopqrst" trailing',
    'FOO="token=wxyz" FOO="AKEY=wxyz"',
    'AKEY=wxyz FOO="A\u200BKEY=wxyz"',
    'Basic Og Basic Og==== Basic responsibilities2 Ba\u200Bsic Og',
  ];
  for (const input of cases) equivalent(input);
});

test('oracle: token floors, alphabets, fixed lengths, and both sides of word boundaries', () => {
  const tokens = [
    ['AKIA', 'A', 16], ['ghp_', 'z', 20], ['xoxb-', '-', 10], ['sk-', '_', 20],
    ['sk-proj-', 'g', 20], ['AIza', '-', 35], ['ya29.', '_', 20],
    ['sk_live_', 'g', 16], ['rk_test_', 'g', 16], ['npm_', 'g', 36], ['glpat-', '-', 20],
    ['', 'a', 32],
  ];
  const boundaries = ['', ' ', '\n', '_', 'x', '9', '-', '.', 'é', '\u200B', '\uFF21'];
  for (const [prefix, character, floor] of tokens) {
    for (const length of [0, 1, floor - 1, floor, floor + 1, floor * 2]) {
      for (const before of boundaries) {
        for (const after of boundaries) equivalent(before + prefix + character.repeat(length) + after);
      }
    }
  }
  for (const a of [0, 7, 8, 9]) {
    for (const b of [0, 7, 8, 9]) {
      for (const c of [0, 7, 8, 9]) {
        for (const delimiter of ['.', '..', '/', '']) {
          equivalent(`eyJ${'x'.repeat(a)}${delimiter}${'y'.repeat(b)}.${'z'.repeat(c)}-eyJ`);
        }
      }
    }
  }
});

function generator(seed) {
  let state = seed >>> 0;
  function integer(maximum) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % maximum;
  }
  const pick = values => values[integer(values.length)];
  const spaces = ['', ' ', '\t', '\n', '\r\n', '\u00A0', '\u2003', '\u200B'];
  const names = [
    'FOO', 'BAR', 'KEY', 'CREDENTIAL', 'CREDENTIALS', 'AKEY', 'KEYKEY', 'SECRETARY',
    'AWS_SECRET_ACCESS_KEY', 'XTOKEN', 'XPASSWORD_SUFFIX', 'ACREDENTIALS_EXTRA', 'Akey',
    'api_key', 'api-key', 'secret', 'access_token', 'auth-token', 'token', 'password', 'pwd',
    '1AKEY', '_AKEY', 'éAKEY', 'AKEYx', 'FOO-AKEY', 'ACREDENTIAL',
  ];
  function assignment(depth = 0) {
    const name = pick(names);
    const value = depth < 2 && integer(3) === 0 ? assignment(depth + 1)
      : pick(['', 'a', 'abc', 'wxyz', 'two words', '\n', 'AKEY=wxyz', '[REDACTED]', '"', "'"]);
    const quote = pick(['', '"', "'"]);
    const close = integer(4) === 0 ? '' : quote;
    return name + pick(spaces) + pick(['=', ':', '', '==', '::']) + pick(spaces) + quote + value + close;
  }
  function jwt() {
    const segment = () => pick(['x', '-', '_', 'eyJ-']).repeat(pick([0, 1, 7, 8, 9, 11, 24]));
    return 'eyJ' + segment() + pick(['.', '', '..', '/']) + segment() + pick(['.', '', '/']) + segment();
  }
  function pem() {
    const header = kind => '-----' + kind + pick(['', ' ', ' RSA ', ' BAD ', ' lower ', '\n']) +
      'PRIVATE KEY' + pick(['-----', '----', '------', '']);
    return header('BEGIN').repeat(1 + integer(5)) + pick(['body', '\n', 'AKEY=wxyz', '']) +
      (integer(2) ? header('END') : '');
  }
  function connection() {
    const user = pick(['u', '', 'u-a', 'AKEY=wxyz', 'a://b', 'u\np', 'é']);
    const password = pick(['p', '', 'p-a', 'a://b', 'p@extra', 'p/q', 'p:p', '한']);
    return pick(['a', 'a-b', 'a+b.c', '9-a', '_a', 'postgres', 'HTTP', 'a-'.repeat(25)]) +
      pick(['://', ':/', '//', ':']) + user + pick([':', '', '::']) + password + pick(['@', '', '@@']);
  }
  function provider() {
    return pick(['AKIA', 'ghp_', 'xoxb-', 'sk-', 'sk-proj-', 'AIza', 'ya29.',
      'sk_live_', 'rk_test_', 'npm_', 'glpat-', '']) +
      pick(['g', 'A', 'a', '-', '_']).repeat(pick([0, 7, 8, 9, 15, 16, 19, 20, 21, 31, 32, 35, 36, 40]));
  }
  function basic() {
    return pick(['Basic', 'basic', 'BASIC', 'Ba\u200Bsic']) + pick(spaces) +
      pick(['Og', 'Og==', 'Og====', 'YWJjZGVmOmFkbWlu', 'YWJj', 'responsibilities2', '/', '']);
  }
  function obfuscate(text) {
    const mode = integer(6);
    if (mode === 0) return text.toLowerCase();
    if (mode === 1) return text.toUpperCase();
    if (mode === 2) return text.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
    if (mode === 3 && text.length) {
      const position = integer(text.length);
      return text.slice(0, position) + pick(['\u200B', '\uFEFF', '\x00', '\u00AD']) + text.slice(position);
    }
    return text;
  }
  const makers = [assignment, jwt, pem, connection, provider, basic];
  return () => {
    let text = pick(['', '_', 'x', 'é', '한', '\u200B']);
    const count = 1 + integer(8);
    for (let i = 0; i < count; i++) {
      text += pick(['', ' ', '\n', '-', '/', ';', '.', ':', '"', "'"]) + obfuscate(pick(makers)());
    }
    return text + pick(['', 'x', '_', '\n', '\u200B']);
  };
}

test('oracle: 12000 fixed-seed structured mixtures and nested assignments', () => {
  const seed = 0x4d53414e;
  const next = generator(seed);
  for (let i = 0; i < 12000; i++) {
    const input = next();
    equivalent(input, `seed=${seed}, case=${i}, input=${JSON.stringify(input)}`);
  }
});

// Measure only the new implementation. A regressed scanner cannot hang the test
// runner: each family has its own killable process with a finite wall-clock limit.
const benchmark = `
  const assert = require('node:assert/strict');
  const { performance } = require('node:perf_hooks');
  const { redactSecrets } = require(process.argv[1]);
  const unit = process.argv[2];
  const tail = process.argv[3];
  function input(size) { return unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail; }
  function measure(text) {
    const start = performance.now();
    const result = redactSecrets(text);
    const elapsed = performance.now() - start;
    assert.deepEqual(result, { text, redacted: false });
    return elapsed;
  }
  for (let i = 0; i < 5; i++) measure(input(50000));
  const samples = [[], [], []];
  const sizes = [200000, 400000, 800000];
  const texts = sizes.map(input);
  // Interleave sizes to reduce warmup, scheduling, and thermal order effects.
  for (let round = 0; round < 7; round++) {
    for (let offset = 0; offset < 3; offset++) {
      const index = (round + offset) % 3;
      samples[index].push(measure(texts[index]));
    }
  }
  const milliseconds = samples.map(values => values.sort((a, b) => a - b)[3]);
  assert.ok(milliseconds[2] <= milliseconds[0] * 6, JSON.stringify({ sizes, milliseconds }));
  assert.ok(Math.max(...samples[2]) < 2000, JSON.stringify({ sizes, milliseconds, samples }));
  process.stdout.write(JSON.stringify({ sizes, milliseconds, ratio: milliseconds[2] / milliseconds[0] }));
`;

for (const [family, unit] of [
  ['UPPER_SNAKE', 'AKEY'],
  ['PEM without END', '-----BEGIN PRIVATE KEY-----'],
  ['JWT', 'eyJ-'],
  ['connection scheme', 'a-'],
]) {
  for (const [mode, tail] of [['raw', ''], ['normalized backstop', '\u200B']]) {
    test(`linear performance: ${family}, ${mode}, 200K/400K/800K`, { timeout: 15000 }, t => {
      const child = spawnSync(process.execPath,
        ['-e', benchmark, require.resolve('../services/memorySanitize'), unit, tail],
        { encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 65536 });
      assert.ifError(child.error);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, 0, child.stderr);
      t.diagnostic(child.stdout);
    });
  }
}
