import test from 'node:test';
import assert from 'node:assert/strict';
import { syncFreshness, pickTake, STALE_AFTER_MS } from '../js/ui/glance.js';

test('STALE_AFTER_MS is 20 seconds', () => {
  assert.equal(STALE_AFTER_MS, 20000);
});

test('sync disabled reports off, whatever the status says', () => {
  assert.equal(syncFreshness({ ok: true, at: 1000 }, false, 1000), 'off');
  assert.equal(syncFreshness({ ok: false, at: 1 }, false, 999999), 'off');
  assert.equal(syncFreshness(null, false, 1000), 'off');
});

test('a recent completed poll is fresh', () => {
  assert.equal(syncFreshness({ ok: true, at: 10000 }, true, 10000), 'fresh');
  assert.equal(syncFreshness({ ok: true, at: 10000 }, true, 19999), 'fresh');
});

test('the staleness boundary is exact in both directions', () => {
  // 20000ms elapsed is NOT yet stale; 20001 is.
  assert.equal(syncFreshness({ ok: true, at: 0 }, true, 20000), 'fresh');
  assert.equal(syncFreshness({ ok: true, at: 0 }, true, 20001), 'stale');
});

test('an age of exactly zero is fresh', () => {
  // The poll that just completed. now === at is the normal case immediately
  // after a successful poll and must never read as skew.
  assert.equal(syncFreshness({ ok: true, at: 1000 }, true, 1000), 'fresh');
  assert.equal(syncFreshness({ ok: false, error: 'boom', at: 1000 }, true, 1000), 'fresh');
});

test('a negative age is stale, not fresh', () => {
  // A backward system clock jump mid-draft makes `now - at` negative. A plain
  // `> STALE_AFTER_MS` comparison is false for every negative number, so the
  // card reported 'fresh' — and ago() clamped the negative elapsed time to
  // "0s ago" — while sync was completely dead. A jump of Δ suppressed the
  // warning for Δ + STALE_AFTER_MS. We cannot tell a skewed clock from a
  // healthy one, so the only safe reading of "the last poll is in the future"
  // is that we have no trustworthy evidence of freshness.
  assert.equal(syncFreshness({ ok: true, at: 1000 }, true, 999), 'stale');
  assert.equal(syncFreshness({ ok: true, at: 61000 }, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: false, error: 'boom', at: 1000 }, true, 0), 'stale');
});

test('a failed poll still counts as a completed poll for freshness', () => {
  // sleeper.js stamps `at` on failure too. A failing-but-responding API is a
  // different problem from a hung one, and the error text is shown separately.
  assert.equal(syncFreshness({ ok: false, error: 'boom', at: 0 }, true, 1000), 'fresh');
});

test('a missing or unstamped status is stale, not fresh', () => {
  // Never claim freshness we cannot substantiate.
  assert.equal(syncFreshness(null, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true }, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true, at: null }, true, 1000), 'stale');
});

test('a non-finite timestamp is stale, not fresh', () => {
  // NaN and Infinity are typeof 'number', and NaN > X is false, so a naive
  // guard would let them through and report 'fresh'.
  assert.equal(syncFreshness({ ok: true, at: NaN }, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true, at: Infinity }, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true, at: '1000' }, true, 1000), 'stale');
});

test('pickTake returns the first non-excluded entry', () => {
  const ranked = [
    { player: { name: 'A' }, excluded: true },
    { player: { name: 'B' }, excluded: false },
    { player: { name: 'C' }, excluded: false },
  ];
  assert.equal(pickTake(ranked).player.name, 'B');
});

test('pickTake returns null when everything is excluded or the list is empty', () => {
  assert.equal(pickTake([{ player: { name: 'A' }, excluded: true }]), null);
  assert.equal(pickTake([]), null);
  assert.equal(pickTake(undefined), null);
});
