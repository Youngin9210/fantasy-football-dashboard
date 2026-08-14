import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePos, FLEX_ELIGIBLE } from '../js/positions.js';
import { assignRosterSlots } from '../js/draft.js';

test('canonicalizes every defense spelling to DST', () => {
  assert.equal(normalizePos('DEF'), 'DST');
  assert.equal(normalizePos('DST'), 'DST');
  assert.equal(normalizePos('D/ST'), 'DST');
  assert.equal(normalizePos('def'), 'DST');
  assert.equal(normalizePos(' DEF '), 'DST');
});

test('canonicalizes PK to K', () => {
  assert.equal(normalizePos('PK'), 'K');
  assert.equal(normalizePos('K'), 'K');
});

test('strips FantasyPros positional ranks', () => {
  assert.equal(normalizePos('RB1'), 'RB');
  assert.equal(normalizePos('WR12'), 'WR');
  assert.equal(normalizePos('QB'), 'QB');
});

test('returns empty string for missing input', () => {
  assert.equal(normalizePos(''), '');
  assert.equal(normalizePos(null), '');
  assert.equal(normalizePos(undefined), '');
});

test('FLEX_ELIGIBLE is RB/WR/TE', () => {
  assert.deepEqual(FLEX_ELIGIBLE, ['RB', 'WR', 'TE']);
});

// The whole point of the module: a defense from a CSV must fill a defense slot
// synced from Sleeper, regardless of which spelling each side used.
test('a defense fills a defense slot from either spelling', () => {
  const slotLabel = normalizePos('DEF'); // Sleeper's roster_positions
  const playerPos = normalizePos('D/ST'); // a FantasyPros CSV
  assert.equal(slotLabel, playerPos);

  const { slots } = assignRosterSlots([slotLabel], [{ pos: playerPos, name: 'Ravens' }]);
  assert.equal(slots[0].player.name, 'Ravens', 'the defense slot actually fills');
});

test('a Sleeper DEF pick normalizes to DST for roster and limit matching', () => {
  // app.js previously stored Sleeper's raw 'DEF' via addManualPlayer, which
  // silently broke both DST slot-filling and the DST position limit.
  assert.equal(normalizePos('DEF'), 'DST');
  const { slots } = assignRosterSlots(['DST'], [{ pos: normalizePos('DEF'), name: 'Ravens D/ST' }]);
  assert.equal(slots[0].player.name, 'Ravens D/ST');
});
