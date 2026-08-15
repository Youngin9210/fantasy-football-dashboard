import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// state.js reads localStorage at import time; Node has no DOM.
globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};

const St = await import('../js/state.js');
const { applyPicks, suppressPlayer, clearSuppressed, beginPolling } =
  await import('../js/ui/useSleeperSync.js');

function sleeperPick(pickNo, rosterId, first, last, pos, team) {
  return {
    pick_no: pickNo,
    roster_id: rosterId,
    player_id: `s${pickNo}`,
    metadata: { first_name: first, last_name: last, position: pos, team },
  };
}

const player = (id, rank, name, team, pos) => ({
  id, rank, name, team, pos, bye: null, adp: null, source: 'csv',
  drafted: false, draftedByTeamId: null, pickNo: null,
});

// useSleeperSync keeps two pieces of module-level, page-lifetime state: the
// suppression set and the draft ID beginPolling last saw. Both outlive an
// individual test, so without this the suite could pass purely by the order the
// tests happen to run in — and a test that never calls beginPolling would be
// silently running against whatever draft ID its predecessor left behind.
// beginPolling(null) puts the remembered ID back to its module-load value; the
// unconditional clearSuppressed afterwards covers the case where it was already
// null and beginPolling therefore cleared nothing.
function resetSyncState() {
  beginPolling(null);
  clearSuppressed();
}

beforeEach(resetSyncState);

function seedBoard() {
  St.resetAll();
  St.setTeams([
    { id: 'r1', name: 'Alpha', slot: 0, rosterId: 1, userId: null, isMe: false },
    { id: 'r2', name: 'Bravo', slot: 1, rosterId: 2, userId: null, isMe: false },
  ]);
  St.updateSettings({ numTeams: 2 });
  St.setPlayers([
    player('p1', 1, 'Star RB', 'SF', 'RB'),
    player('p2', 2, 'Star WR', 'MIN', 'WR'),
  ]);
}

// The wider board the correction scenarios need: the two above plus three more
// so a manual pick and a later Sleeper pick can collide on a number.
function seedWideBoard() {
  seedBoard();
  St.addPlayers([
    player('p3', 3, 'Star TE', 'KC', 'TE'),
    player('p4', 4, 'Star QB', 'BUF', 'QB'),
    player('p5', 5, 'Real WR', 'DET', 'WR'),
  ]);
}

const LIVE_PICKS = [
  sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
  sleeperPick(2, 2, 'Star', 'WR', 'WR', 'MIN'),
];

const FIRST_THREE = LIVE_PICKS.concat([sleeperPick(3, 1, 'Star', 'TE', 'TE', 'KC')]);
const PICK_4_QB = sleeperPick(4, 2, 'Star', 'QB', 'QB', 'BUF');

const byId = (id) => St.getState().players.find((p) => p.id === id);

test('applyPicks imports Sleeper picks onto the matching players and teams', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2);
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2]);
  assert.equal(byId('p1').draftedByTeamId, 'r1');
  assert.equal(byId('p2').draftedByTeamId, 'r2');
});

// ---------------------------------------------------------------- 1. Reset Draft
//
// THE ORIGINAL GUARANTEE. Vanilla kept a long-lived processedPickNos set and
// cleared it by hand on Reset Draft. Accumulate that set across polls instead
// and Reset Draft during a live draft leaves it populated, every later poll
// skips every pick, and the board silently stays empty for the rest of the
// draft with no error shown anywhere.
test('Reset Draft mid-sync: the next poll re-imports the picks', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  assert.equal(St.getState().picks.length, 2, 'precondition: picks were imported');

  St.resetDraft();
  assert.equal(St.getState().picks.length, 0, 'precondition: reset cleared the board');

  applyPicks(LIVE_PICKS); // exactly what the next 6-second tick delivers

  const s = St.getState();
  assert.equal(s.picks.length, 2, 'picks come back after Reset Draft');
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2]);
  assert.equal(s.players.length, 2, 're-imported onto the same players, not manual clones');
  assert.equal(byId('p1').drafted, true);
});

// ------------------------------------ 2. Reset Everything and a CSV re-import
test('Reset Everything mid-sync: the next poll rebuilds the board as manual players', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  St.resetAll();

  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2, 'polling still imports after a full reset');
  // No rankings and no teams survive resetAll, so each pick becomes a manual
  // player with no team attached.
  assert.equal(s.players.length, 2);
  assert.equal(s.players[0].source, 'manual');
  assert.equal(s.picks[0].teamId, null);
});

// setPlayers swaps the whole board for freshly-created, undrafted objects but
// deliberately leaves `picks` and `pickCounter` alone, so SetupPanel.importCsv
// calls clearSuppressed + resetDraft when sync is live. Identity dedupe is what
// makes the repair actually land: the new player objects are undrafted, so the
// very next tick refills the board against the rankings just imported.
test('CSV re-import mid-sync: the next poll refills the board onto the new players', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  assert.equal(byId('p1').drafted, true, 'precondition: picks were imported');

  // What importCsv does with sleeperSyncEnabled on.
  St.setPlayers([
    player('n1', 1, 'Star RB', 'SF', 'RB'),
    player('n2', 2, 'Star WR', 'MIN', 'WR'),
    player('n3', 3, 'Star TE', 'KC', 'TE'),
  ]);
  clearSuppressed();
  St.resetDraft();

  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2, 'polling still imports after a CSV re-import');
  assert.equal(s.players.length, 3, 'onto the newly imported players, no manual clones');
  assert.equal(byId('n1').drafted, true);
  assert.equal(byId('n2').draftedByTeamId, 'r2');
});

// ------------------------------------------------- 3. manual pick vs. its twin
//
// A manual pick shares state.js's pick numbering space with Sleeper's
// (`draftPlayer` with no override uses ++pickCounter), so deriving "already
// imported" from store pick NUMBERS makes a manual pick at number N mask
// Sleeper's real pick N: the player who actually went there stays on the board
// as available and the recommender happily suggests him. The documented fix for
// a bad `matchPickToPlayer` name match — ✕ the wrong player, manually draft the
// right one — is exactly what triggers it.
test('a manual pick does not mask the Sleeper pick with the same number', () => {
  seedWideBoard();
  applyPicks(FIRST_THREE);
  assert.equal(St.getState().pickCounter, 3, 'precondition: three picks imported');

  // The correction workflow: pick 2 matched the wrong player, so ✕ him and
  // manually draft the player who really went there.
  suppressPlayer(byId('p2'));
  St.undraftPlayer('p2');
  St.draftPlayer('p5', 'r2'); // no pickNo override -> takes pickCounter, i.e. 4

  // The very next 6-second tick, now carrying Sleeper's real pick 4.
  applyPicks(FIRST_THREE.concat([PICK_4_QB]));

  const s = St.getState();
  assert.equal(byId('p4').drafted, true,
    "Sleeper's pick 4 must import even though a manual pick already took number 4");
  assert.equal(s.players.length, 5, 'imported onto the ranked player, not a manual clone');
});

// ------------------------------------------------------- 4. reload / reconnect
//
// THE CASE EVERY EARLIER FIX MISSED. Suppression and any "already imported" set
// are page-lifetime; `state.picks` is not — it comes back from localStorage.
// So every scheme that re-seeded an imported set from the store at the start of
// a polling session reintroduced the masking bug above the moment the user hit
// refresh or Connect again, after the correction had already been made.
// Identity dedupe has nothing to re-seed: the question it asks is answered by
// `state.players`, which restores with the correct answer already in it.
test('reload mid-draft: Sleeper still imports its pick of a number a manual pick took', () => {
  seedWideBoard();
  beginPolling('draft-A');
  applyPicks(FIRST_THREE);

  suppressPlayer(byId('p2'));
  St.undraftPlayer('p2');
  St.draftPlayer('p5', 'r2'); // manual pick #4
  assert.equal(byId('p5').pickNo, 4, 'precondition: the manual pick took number 4');

  // RELOAD. Page-lifetime module state is gone; the store comes back from
  // localStorage with the correction intact. start() then calls beginPolling.
  resetSyncState();
  beginPolling('draft-A');

  applyPicks(FIRST_THREE.concat([PICK_4_QB]));

  assert.equal(byId('p4').drafted, true,
    "Sleeper's pick 4 must import after a reload, not be masked by the manual pick 4");
  assert.equal(St.getState().players.length, 5, 'no manual clones invented');
  // Documented consequence of suppression being page-lifetime by design: the
  // ✕-ed mis-match does come back after a reload. Corrections outlive a reload
  // only where the user replaced them with a manual pick.
  assert.equal(byId('p2').drafted, true, 'suppression does not survive a reload, as designed');
});

// ------------------------------------------------------------ 5. explicit undo
//
// The other half of the trade-off. Identity dedupe reads `drafted` off the
// board, and an undo clears exactly that — so without suppression the next tick
// six seconds later undoes the undo. Suppression is what makes an undo stick
// while sync runs, which matters because `matchPickToPlayer` matches names with
// a loose bidirectional `includes` and does mis-match sometimes.
test('an explicitly undone pick is not re-imported on the next tick', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);

  // Exactly what DraftLog's "Undo Last Pick" (and PlayersTable's ✕) now do:
  // record the PLAYER, then drop the pick from the store.
  suppressPlayer(byId('p2'));
  St.undoLastPick();
  assert.deepEqual(St.getState().picks.map((p) => p.pickNo), [1], 'precondition: the undo landed');

  applyPicks(LIVE_PICKS); // the next 6-second tick

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1], 'the undone pick stays undone');
  assert.equal(byId('p2').drafted, false, 'and its player stays available');
  assert.equal(s.players.length, 2, 'no manual clone invented for the suppressed pick');
});

test('Reset Draft clears suppression: a previously-undone pick re-imports afterwards', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  suppressPlayer(byId('p2'));
  St.undoLastPick();

  // The Reset Draft button in SetupPanel clears the suppression set alongside
  // St.resetDraft(); without that, Star WR would be suppressed for the rest of
  // the session and never come back — the same silent-skip class of bug as an
  // uncleared processedPickNos.
  clearSuppressed();
  St.resetDraft();

  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2], 'both picks re-import after a reset');
  assert.equal(byId('p2').drafted, true);
});

// --------------------------------------------- 6. undoing a MANUAL pick
//
// The suppression half of the same root cause. Keyed by bare pick number,
// undoing a MANUAL pick at number N suppressed Sleeper's real pick N — and
// undoing a manual pick is the tail end of the documented correction workflow,
// so this fired in exactly the situation the correction was meant to fix. The
// player Sleeper really took at N then never appeared on the board at all.
test('undoing a manual pick does not suppress the Sleeper pick with the same number', () => {
  seedWideBoard();
  applyPicks([LIVE_PICKS[0]]); // Sleeper pick 1
  St.draftPlayer('p5', 'r2'); // manual pick 2
  assert.equal(byId('p5').pickNo, 2, 'precondition: the manual pick took number 2');

  // DraftLog's "Undo Last Pick" on that manual pick.
  suppressPlayer(byId('p5'));
  St.undoLastPick();

  applyPicks(LIVE_PICKS); // the tick carrying Sleeper's real pick 2

  assert.equal(byId('p2').drafted, true,
    "Sleeper's pick 2 must import: undoing a manual pick suppresses a PLAYER, not a number");
  assert.equal(byId('p5').drafted, false, 'and the undone manual pick stays undone');
  assert.equal(St.getState().players.length, 5, 'no manual clone invented');
});

// ------------------------------------------------------- 7. never imported twice
test('applyPicks is idempotent across polls — a re-poll adds nothing', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  applyPicks(LIVE_PICKS);
  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2, 'repeated polls of the same payload stay at two picks');
  assert.equal(s.players.length, 2, 'and never invent manual duplicates');
});

test('a pick_no repeated inside one payload is imported once', () => {
  seedBoard();
  applyPicks([
    sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
    sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
    sleeperPick(2, 2, 'Star', 'WR', 'WR', 'MIN'),
  ]);

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2], 'the duplicate entry adds nothing');
  assert.equal(s.players.length, 2, 'and no manual clone of Star RB');
});

test('the same player under two pick numbers in one payload is imported once', () => {
  seedBoard();
  applyPicks([
    sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
    sleeperPick(9, 2, 'Star', 'RB', 'RB', 'SF'),
  ]);

  const s = St.getState();
  assert.equal(s.picks.length, 1, 'a player already on the board is not drafted twice');
  assert.equal(s.players.length, 2, 'and is not cloned as a manual player');
});

test('an older payload arriving after a newer one imports nothing', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  applyPicks([LIVE_PICKS[0]]); // a stale response landing late

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2], 'the stale payload changes nothing');
  assert.equal(s.players.length, 2);
});

// ------------------------------------------------------------- 8. team defenses
//
// A defense's first_name/last_name are unreliable — Sleeper spells the Ravens
// "Baltimore"/"Ravens" while a FantasyPros board just says "Ravens" — which is
// why matchPickToPlayer keys defenses off the team abbreviation instead. An
// identity check that only compared full names would answer "no, not on the
// board" for a defense it had just imported, and re-import it every six
// seconds: matchPickToPlayer finds no UNDRAFTED defense the second time, so
// each tick adds another manual "Baltimore Ravens" clone, forever.
test('a team defense is imported once and not re-imported on later ticks', () => {
  seedBoard();
  St.addPlayers([player('d1', 6, 'Ravens', 'BAL', 'DST')]);
  const defPick = sleeperPick(1, 1, 'Baltimore', 'Ravens', 'DEF', 'BAL');

  applyPicks([defPick]);
  assert.equal(byId('d1').drafted, true, 'the defense imported onto the ranked DST');
  assert.equal(St.getState().players.length, 3);

  applyPicks([defPick]);
  applyPicks([defPick]);

  const s = St.getState();
  assert.equal(s.picks.length, 1, 'later ticks do not re-import the defense');
  assert.equal(s.players.length, 3, 'and do not clone it as a manual player');
});

test('a defense undrafted by ✕ stays undrafted while sync runs', () => {
  seedBoard();
  St.addPlayers([player('d1', 6, 'Ravens', 'BAL', 'DST')]);
  const defPick = sleeperPick(1, 1, 'Baltimore', 'Ravens', 'DEF', 'BAL');
  applyPicks([defPick]);

  suppressPlayer(byId('d1'));
  St.undraftPlayer('d1');

  applyPicks([defPick]);

  assert.equal(byId('d1').drafted, false, 'suppression matches defenses by team, like the import does');
  assert.equal(St.getState().players.length, 3, 'no manual clone');
});

// ------------------------------------------------------- suppression scoping
//
// Suppression carries no draft ID, so without beginPolling dropping it on a
// change it leaks across drafts: he will very likely dry-run against a mock
// draft to prove sync works, and any ✕ during that dry run silently drops the
// same player from the real draft an hour later.
test('starting a different draft clears suppression carried over from the last one', () => {
  seedBoard();
  beginPolling('draft-A');
  applyPicks(LIVE_PICKS);

  // The dry run: ✕ a pick (PlayersTable's per-row ✕ suppresses, then undrafts).
  suppressPlayer(byId('p1'));
  St.undraftPlayer('p1');
  assert.deepEqual(St.getState().picks.map((p) => p.pickNo), [2], 'precondition: the ✕ landed');

  // Now connect to the real draft. connectSleeper stores the new draft ID and
  // calls start(), which calls beginPolling with it.
  beginPolling('draft-B');
  applyPicks(LIVE_PICKS);

  assert.equal(byId('p1').drafted, true,
    "the new draft's pick 1 must import, not inherit the old draft's suppression");
});

// The other side of that choice: reconnecting to the SAME draft (a re-press of
// Connect, a network hiccup) must keep the corrections already made, or every
// mis-matched pick the user fixed comes straight back.
test('restarting the same draft keeps suppression', () => {
  seedBoard();
  beginPolling('draft-A');
  applyPicks(LIVE_PICKS);
  suppressPlayer(byId('p2'));
  St.undoLastPick();

  beginPolling('draft-A');
  applyPicks(LIVE_PICKS);

  assert.deepEqual(St.getState().picks.map((p) => p.pickNo), [1], 'the undone pick stays undone');
});

// ------------------------------------------------------------------ misc
test('applyPicks skips slots that have no player yet and sorts by pick number', () => {
  seedBoard();
  applyPicks([
    sleeperPick(2, 2, 'Star', 'WR', 'WR', 'MIN'),
    { pick_no: 3, roster_id: 1, player_id: null, metadata: {} },
    sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
  ]);

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2], 'imported in draft order, empty slot skipped');
});

test('a pick with no match in the rankings becomes a manual player', () => {
  seedBoard();
  applyPicks([sleeperPick(1, 1, 'Unknown', 'Rookie', 'TE', 'DAL')]);

  const s = St.getState();
  assert.equal(s.players.length, 3);
  const added = s.players[2];
  assert.equal(added.name, 'Unknown Rookie');
  assert.equal(added.pos, 'TE');
  assert.equal(added.drafted, true);
  assert.equal(added.draftedByTeamId, 'r1');
});

// The manual player a nameless pick creates is named after its player_id, so
// the identity check has to recognise THAT name or the pick has no identity at
// all and clones itself on every tick.
test('a pick Sleeper sends with no name is imported once, not cloned every tick', () => {
  seedBoard();
  const nameless = { pick_no: 1, roster_id: 1, player_id: 'x9', metadata: { player_id: 'x9' } };

  applyPicks([nameless]);
  applyPicks([nameless]);
  applyPicks([nameless]);

  const s = St.getState();
  assert.equal(s.picks.length, 1, 'imported exactly once');
  assert.equal(s.players.length, 3, 'one manual player, not one per tick');
});
