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

// --- hasNoByeData ----------------------------------------------------------
import { hasNoByeData } from '../js/ui/glance.js';

// GlanceView derives `mine` by filtering `players`, so the roster is always a
// subset of the board. The cases below therefore pass the roster AS the board:
// the smallest board consistent with that invariant. Only the board is consulted
// (see hasNoByeData), so these read as board cases that happen to be rostered.
const onOwnBoard = (mine) => hasNoByeData(mine, mine);

test('an empty board is silent', () => {
  // Nothing imported yet, so there are no rankings to make a claim about. (This
  // test used to be 'a fresh install with nothing rostered is silent' and pinned a
  // ROSTER gate. The roster is a subset of the board, so that gate could only add
  // false negatives — and it added the worst one: before your first pick, with a
  // bye-less CSV already imported, the notice was suppressed in exactly the window
  // where you could still re-export the CSV. A fresh install stays silent through
  // the board gate, which is the honest reason.)
  assert.equal(onOwnBoard([]), false);
  assert.equal(onOwnBoard(undefined), false);
  assert.equal(onOwnBoard(null), false);
});

test('a bye-less board with NOTHING rostered yet still reports inert weighting', () => {
  // The bug the roster gate caused, stated as a test. A CSV with no bye column is
  // imported and the team is picked, but no pick has been made: the weighting is
  // inert for every candidate on the board and the owner can still fix it by
  // re-exporting. A roster gate returns false here.
  assert.equal(hasNoByeData([], [{ bye: null }, { bye: null }]), true);
  assert.equal(hasNoByeData(undefined, [{}, {}]), true);
  // And it is still the BOARD that decides: byes present, no claim.
  assert.equal(hasNoByeData([], [{ bye: null }, { bye: 9 }]), false);
});

test('a board whose every player lacks a bye reports inert weighting, even one that is entirely rostered', () => {
  assert.equal(onOwnBoard([{ bye: null }, { bye: null }]), true);
  assert.equal(onOwnBoard([{}, {}]), true, 'a CSV with no bye column at all');
  assert.equal(onOwnBoard([{ bye: undefined }]), true);
  assert.equal(onOwnBoard([{ bye: NaN }]), true, 'NaN is not bye data');
});

test('one rostered player WITH a bye is a hole, not an inert feature', () => {
  // The weighting IS running; that player is simply missing from the CSV. Saying
  // "bye conflicts are not being weighted" here would be a lie.
  assert.equal(onOwnBoard([{ bye: 9 }, { bye: null }]), false);
  assert.equal(onOwnBoard([{ bye: null }, { bye: 9 }]), false);
});

test('a rostered bye of 0 is real data, not missing data', () => {
  // Number.isFinite, not truthiness. `!p.bye` reads a bye-0 player as missing
  // and claims the weighting is off while it is actually running — byeShortfall
  // treats bye 0 as a real week, so the two must agree. A mutant swapping the
  // guard for truthiness survives every other assertion in this file.
  assert.equal(onOwnBoard([{ bye: 0 }]), false);
  assert.equal(onOwnBoard([{ bye: 0 }, { bye: null }]), false);
});

test('a non-finite bye is never mistaken for data', () => {
  assert.equal(onOwnBoard([{ bye: Infinity }]), true);
  assert.equal(onOwnBoard([{ bye: '7' }]), true, 'an unparsed string is not a week');
});

test('a null entry in the board array does not throw', () => {
  assert.equal(onOwnBoard([null]), true);
  assert.equal(onOwnBoard([null, { bye: 9 }]), false);
});

test('a null-bye ROSTER on a board that has byes is not inert weighting', () => {
  // The case the roster-only gate got wrong, and the reason the board argument
  // exists. An unmatched Sleeper pick becomes a manual player with bye: null, so
  // an owner one pick into a synced draft can hold nothing but null byes while
  // every candidate on the board has one. The weighting is running normally for
  // all of them; the message "No bye weeks in your rankings — bye conflicts are
  // not being weighted" would be false.
  assert.equal(hasNoByeData([{ bye: null }], [{ bye: null }, { bye: 9 }]), false);
  assert.equal(hasNoByeData(
    [{ bye: null }, { bye: null }],
    [{ bye: null }, { bye: null }, { bye: 7 }, { bye: 10 }]), false);
  // Board byes are read with the same Number.isFinite distinction as roster ones:
  // a bye-0 player on the board is real data too.
  assert.equal(hasNoByeData([{ bye: null }], [{ bye: null }, { bye: 0 }]), false);
});

test('a board with no byes anywhere is what the message actually claims', () => {
  // The honest case: a CSV with no bye column, so nothing on the board carries
  // one and the weighting really does contribute nothing.
  assert.equal(hasNoByeData([{ bye: null }], [{ bye: null }, { bye: null }]), true);
  assert.equal(hasNoByeData([{ bye: null }], [{}, { bye: undefined }, { bye: '7' }]), true);
  // A null entry in the BOARD array does not throw either, and is not bye data.
  assert.equal(hasNoByeData([{ bye: null }], [null, { bye: null }]), true);
  assert.equal(hasNoByeData([{ bye: null }], [null, { bye: 9 }]), false);
});

test('no board to judge means no claim', () => {
  // Absence of evidence is not evidence, the same rule syncFreshness follows for
  // a missing timestamp. Falling back to the roster-only answer here would put
  // the old lie back for any caller that forgot the argument.
  assert.equal(hasNoByeData([{ bye: null }]), false);
  assert.equal(hasNoByeData([{ bye: null }], undefined), false);
  assert.equal(hasNoByeData([{ bye: null }], null), false);
});
