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
