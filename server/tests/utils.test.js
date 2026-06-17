const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../utils');

test('utils.add returns the sum of two numbers', () => {
  assert.equal(utils.add(2, 3), 5);
  assert.equal(utils.add(-2, 5), 3);
});

test('utils.add handles zero values', () => {
  assert.equal(utils.add(0, 4), 4);
  assert.equal(utils.add(7, 0), 7);
});

test('utils.add returns zero when both operands are zero', () => {
  assert.equal(utils.add(0, 0), 0);
});

test('utils.add handles decimal values', () => {
  assert.equal(utils.add(1.5, 2.25), 3.75);
});

test('utils.add handles fractional values that sum to an integer', () => {
  assert.equal(utils.add(2.5, 2.5), 5);
});

test('utils.add handles negative results', () => {
  assert.equal(utils.add(-8, 3), -5);
});

test('utils.add handles a negative second operand', () => {
  assert.equal(utils.add(12, -5), 7);
});

test('utils.add handles two negative operands', () => {
  assert.equal(utils.add(-4, -6), -10);
});

test('utils.add returns zero for additive inverses', () => {
  assert.equal(utils.add(-9, 9), 0);
});

test('utils.add handles large safe integers', () => {
  assert.equal(utils.add(900000000000000, 100000000000000), 1000000000000000);
});

test('utils.add handles safe integer boundaries', () => {
  assert.equal(utils.add(Number.MAX_SAFE_INTEGER, -1), Number.MAX_SAFE_INTEGER - 1);
});

test('utils.add preserves operand order for string inputs', () => {
  assert.equal(utils.add('left', 'right'), 'leftright');
});

test('utils.add supports bigint operands', () => {
  assert.equal(utils.add(12n, 30n), 42n);
});

test('utils.add propagates NaN operands', () => {
  assert.ok(Number.isNaN(utils.add(Number.NaN, 4)));
});

test('utils.add preserves floating-point precision behavior', () => {
  assert.equal(utils.add(0.1, 0.2), 0.30000000000000004);
});

test('utils.add throws when mixing number and bigint operands', () => {
  assert.throws(() => utils.add(1, 2n), TypeError);
});

test('utils.add handles positive and negative decimal operands', () => {
  assert.equal(utils.add(10.5, -4.25), 6.25);
});

test('utils.add concatenates string and number operands using JavaScript addition semantics', () => {
  assert.equal(utils.add('count:', 3), 'count:3');
});

test('utils.add coerces boolean operands using JavaScript addition semantics', () => {
  assert.equal(utils.add(true, false), 1);
});

test('utils.add treats null as zero using JavaScript addition semantics', () => {
  assert.equal(utils.add(null, 5), 5);
});

test('utils.add handles two negative decimal operands', () => {
  assert.equal(utils.add(-1.25, -2.5), -3.75);
});

test('utils.add handles Infinity operands', () => {
  assert.equal(utils.add(Number.POSITIVE_INFINITY, 5), Number.POSITIVE_INFINITY);
});

test('utils.add handles mixed sign decimal operands crossing zero', () => {
  assert.equal(utils.add(-3.5, 4.25), 0.75);
});

test('utils.add preserves negative zero when both operands are negative zero', () => {
  assert.ok(Object.is(utils.add(-0, -0), -0));
});

test('utils.add concatenates numeric string operands using JavaScript addition semantics', () => {
  assert.equal(utils.add('2', '3'), '23');
});

test('utils.add handles numeric strings with numbers using JavaScript addition semantics', () => {
  assert.equal(utils.add(4, '5'), '45');
});
