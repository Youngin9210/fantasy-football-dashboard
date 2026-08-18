import test from 'node:test';
import assert from 'node:assert/strict';
import { marketNote, MARKET_FLAG_AT } from '../js/ui/market.js';

test('the flag threshold is 8', () => {
  // Chosen from the owner's file: 8 flags ~1 player per round in his first six.
  assert.equal(MARKET_FLAG_AT, 8);
});

test('a missing gap has nothing to say', () => {
  assert.equal(marketNote(null), null);
  assert.equal(marketNote(undefined), null);
  assert.equal(marketNote(NaN), null);
  assert.equal(marketNote('  '), null);
});

test('negative means the market takes him EARLY', () => {
  const n = marketNote(-10);
  assert.match(n.short, /10/);
  assert.match(n.short, /early/i);
  assert.match(n.long, /before/i, 'the sentence must say before, not after');
  assert.equal(n.flagged, true);
});

test('positive means he LASTS longer than his rank', () => {
  const n = marketNote(11);
  assert.match(n.short, /11/);
  assert.match(n.short, /late/i);
  assert.match(n.long, /longer|after|later/i);
  assert.equal(n.flagged, true);
});

test('the short form never shows a raw sign', () => {
  // One column, one convention: the direction is a word, never a minus sign,
  // because negative-means-urgent is backwards from intuition.
  for (const v of [-31, -8, -3, 0, 3, 8, 31]) {
    const n = marketNote(v);
    assert.ok(!/[-−+]/.test(n.short), `${v} produced "${n.short}"`);
  }
});

test('zero is present but says neither direction', () => {
  const n = marketNote(0);
  assert.notEqual(n, null, 'zero is a real value');
  assert.equal(n.flagged, false);
  assert.ok(!/early|late/i.test(n.short), `zero should not claim a direction: "${n.short}"`);
});

test('the threshold is exact in both directions', () => {
  assert.equal(marketNote(-7).flagged, false);
  assert.equal(marketNote(-8).flagged, true);
  assert.equal(marketNote(7).flagged, false);
  assert.equal(marketNote(8).flagged, true);
});

test('a below-threshold gap still reports, just unflagged', () => {
  // The Board shows it unstyled; it is real data and costs nothing.
  const n = marketNote(3);
  assert.equal(n.flagged, false);
  assert.match(n.short, /3/);
  assert.match(n.short, /late/i);
});

test('the real file\'s extremes produce sane text', () => {
  assert.equal(marketNote(152).flagged, true);
  assert.equal(marketNote(-464).flagged, true);
  assert.match(marketNote(152).short, /152/);
});
