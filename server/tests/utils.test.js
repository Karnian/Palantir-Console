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

test('utils.add handles decimal values', () => {
  assert.equal(utils.add(1.5, 2.25), 3.75);
});

test('utils.add handles negative results', () => {
  assert.equal(utils.add(-8, 3), -5);
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
