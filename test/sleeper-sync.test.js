import test from 'node:test';
import assert from 'node:assert/strict';

// state.js reads localStorage at import time; Node has no DOM.
globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};

const St = await import('../js/state.js');
const { applyPicks, suppressPick, clearSuppressed } = await import('../js/ui/useSleeperSync.js');

function sleeperPick(pickNo, rosterId, first, last, pos, team) {
  return {
    pick_no: pickNo,
    roster_id: rosterId,
    player_id: `s${pickNo}`,
    metadata: { first_name: first, last_name: last, position: pos, team },
  };
}

function seedBoard() {
  St.resetAll();
  clearSuppressed(); // module-level and session-lived, so it outlives a test
  St.setTeams([
    { id: 'r1', name: 'Alpha', slot: 0, rosterId: 1, userId: null, isMe: false },
    { id: 'r2', name: 'Bravo', slot: 1, rosterId: 2, userId: null, isMe: false },
  ]);
  St.updateSettings({ numTeams: 2 });
  St.setPlayers([
    { id: 'p1', rank: 1, name: 'Star RB', team: 'SF', pos: 'RB', bye: null, adp: null, drafted: false, draftedByTeamId: null, pickNo: null },
    { id: 'p2', rank: 2, name: 'Star WR', team: 'MIN', pos: 'WR', bye: null, adp: null, drafted: false, draftedByTeamId: null, pickNo: null },
  ]);
}

const LIVE_PICKS = [
  sleeperPick(1, 1, 'Star', 'RB', 'RB', 'SF'),
  sleeperPick(2, 2, 'Star', 'WR', 'WR', 'MIN'),
];

// THE FINDING-1 REGRESSION. A manual pick shares state.js's pick numbering
// space with Sleeper's (`draftPlayer` with no override uses ++pickCounter), so
// deriving "already imported" from ALL store picks makes a manual pick at
// number N mask Sleeper's real pick N forever: the player who actually went
// there stays on the board as available and the recommender happily suggests
// him. The documented fix for a bad `matchPickToPlayer` name match — ✕ the
// wrong player, manually draft the right one — is exactly what triggers it.
test('a manual pick does not mask the Sleeper pick with the same number', () => {
  seedBoard();
  St.addPlayers([
    { id: 'p3', rank: 3, name: 'Star TE', team: 'KC', pos: 'TE', bye: null, adp: null, source: 'csv', drafted: false, draftedByTeamId: null, pickNo: null },
    { id: 'p4', rank: 4, name: 'Star QB', team: 'BUF', pos: 'QB', bye: null, adp: null, source: 'csv', drafted: false, draftedByTeamId: null, pickNo: null },
    { id: 'p5', rank: 5, name: 'Real WR', team: 'DET', pos: 'WR', bye: null, adp: null, source: 'csv', drafted: false, draftedByTeamId: null, pickNo: null },
  ]);

  const firstThree = LIVE_PICKS.concat([sleeperPick(3, 1, 'Star', 'TE', 'TE', 'KC')]);
  applyPicks(firstThree);
  assert.equal(St.getState().pickCounter, 3, 'precondition: three picks imported');

  // The correction workflow: pick 2 matched the wrong player, so ✕ him and
  // manually draft the player who really went there.
  suppressPick(2);
  St.undraftPlayer('p2');
  St.draftPlayer('p5', 'r2'); // no pickNo override -> takes pickCounter, i.e. 4

  // The very next 6-second tick, now carrying Sleeper's real pick 4.
  applyPicks(firstThree.concat([sleeperPick(4, 2, 'Star', 'QB', 'QB', 'BUF')]));

  const s = St.getState();
  assert.equal(s.players.find((p) => p.id === 'p4').drafted, true,
    "Sleeper's pick 4 must import even though a manual pick already took number 4");
  assert.equal(s.players.length, 5, 'imported onto the ranked player, not a manual clone');
  clearSuppressed();
});

test('applyPicks imports Sleeper picks onto the matching players and teams', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2);
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2]);
  assert.equal(s.players.find((p) => p.id === 'p1').draftedByTeamId, 'r1');
  assert.equal(s.players.find((p) => p.id === 'p2').draftedByTeamId, 'r2');
});

test('applyPicks is idempotent across polls — a re-poll adds nothing', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  applyPicks(LIVE_PICKS);
  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.equal(s.picks.length, 2, 'repeated polls of the same payload stay at two picks');
  assert.equal(s.players.length, 2, 'and never invent manual duplicates');
});

// THE REGRESSION THIS GUARDS. Vanilla kept a long-lived processedPickNos set and
// cleared it by hand on Reset Draft. If the port accumulates that set across
// polls instead of rebuilding it from the store, Reset Draft during a live draft
// leaves it populated, every later poll skips every pick, and the board silently
// stays empty for the rest of the draft with no error shown anywhere.
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
  assert.equal(s.players.find((p) => p.id === 'p1').drafted, true);
});

// THE OTHER HALF OF THE SAME TRADE-OFF. Deriving the processed set from the
// store means an undo — the only way to correct a bad `matchPickToPlayer` name
// match while sync runs — is undone again by the next tick six seconds later.
// The suppression set is what makes an undo stick without reintroducing
// vanilla's never-cleared accumulator.
test('an explicitly undone pick is not re-imported on the next tick', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);

  // Exactly what DraftLog's "Undo Last Pick" (and PlayersTable's ✕) now do:
  // record the pick number, then drop the pick from the store.
  suppressPick(2);
  St.undoLastPick();
  assert.deepEqual(St.getState().picks.map((p) => p.pickNo), [1], 'precondition: the undo landed');

  applyPicks(LIVE_PICKS); // the next 6-second tick

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1], 'the undone pick stays undone');
  assert.equal(s.players.find((p) => p.id === 'p2').drafted, false, 'and its player stays available');
  assert.equal(s.players.length, 2, 'no manual clone invented for the suppressed pick');
  clearSuppressed();
});

test('Reset Draft clears suppression: a previously-undone pick re-imports afterwards', () => {
  seedBoard();
  applyPicks(LIVE_PICKS);
  suppressPick(2);
  St.undoLastPick();

  // The Reset Draft button in SetupPanel clears the suppression set alongside
  // St.resetDraft(); without that, pick 2 would be suppressed for the rest of
  // the session and never come back — the same silent-skip class of bug as an
  // uncleared processedPickNos.
  clearSuppressed();
  St.resetDraft();

  applyPicks(LIVE_PICKS);

  const s = St.getState();
  assert.deepEqual(s.picks.map((p) => p.pickNo), [1, 2], 'both picks re-import after a reset');
  assert.equal(s.players.find((p) => p.id === 'p2').drafted, true);
});

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
