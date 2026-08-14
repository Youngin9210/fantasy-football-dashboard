import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLimitsInput } from '../js/limits.js';

test('parses simple POS:MAX pairs', () => {
  assert.deepEqual(parseLimitsInput('QB:3,RB:6'), { QB: 3, RB: 6 });
});

// The bug being fixed: DEF must canonicalize to DST like everywhere else in
// the app, or the limit becomes a silent no-op against players whose pos is
// always DST.
test('canonicalizes DEF to DST', () => {
  assert.deepEqual(parseLimitsInput('DEF:1'), { DST: 1 });
});

test('canonicalizes D/ST to DST and PK to K', () => {
  assert.deepEqual(parseLimitsInput('D/ST:3'), { DST: 3 });
  assert.deepEqual(parseLimitsInput('PK:2'), { K: 2 });
});

test('tolerates whitespace and trailing commas', () => {
  assert.deepEqual(parseLimitsInput(' qb : 3 , rb:6, '), { QB: 3, RB: 6 });
});

test('rejects junk entries', () => {
  assert.deepEqual(parseLimitsInput(''), {});
  assert.deepEqual(parseLimitsInput('QB'), {});
  assert.deepEqual(parseLimitsInput('QB:0'), {});
  assert.deepEqual(parseLimitsInput('QB:-1'), {});
  assert.deepEqual(parseLimitsInput('QB:abc'), {});
});
