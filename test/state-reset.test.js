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

// The confirm dialog promises "keeps your rankings and teams". This app ships
// with no built-in rankings, so dropping players on reset means one mis-click
// mid-draft wipes the entire imported board.
test('resetDraft keeps rankings and teams, clearing only draft progress', () => {
  St.setTeams([{ id: 't0', name: 'Me', slot: 0 }, { id: 't1', name: 'Them', slot: 1 }]);
  St.updateSettings({ myTeamId: 't0', numTeams: 2 });
  St.setPlayers([
    { id: 'p1', rank: 1, name: 'Star RB', pos: 'RB', drafted: false, draftedByTeamId: null, pickNo: null },
    { id: 'p2', rank: 2, name: 'Star WR', pos: 'WR', drafted: false, draftedByTeamId: null, pickNo: null },
    { id: 'p3', rank: 3, name: 'Star QB', pos: 'QB', drafted: false, draftedByTeamId: null, pickNo: null },
  ]);
  St.draftPlayer('p1', 't0');
  St.draftPlayer('p2', 't1');
  assert.equal(St.getState().picks.length, 2, 'precondition: two picks made');

  St.resetDraft();
  const s = St.getState();

  assert.equal(s.players.length, 3, 'rankings survive the reset');
  assert.deepEqual(s.players.map((p) => p.name), ['Star RB', 'Star WR', 'Star QB']);
  for (const p of s.players) {
    assert.equal(p.drafted, false, `${p.name} draft flag cleared`);
    assert.equal(p.draftedByTeamId, null, `${p.name} team cleared`);
    assert.equal(p.pickNo, null, `${p.name} pick number cleared`);
  }
  assert.equal(s.teams.length, 2, 'teams survive');
  assert.equal(s.settings.myTeamId, 't0', 'settings survive');

  // The point of the function: draft progress really is gone.
  assert.deepEqual(s.picks, [], 'pick history cleared');
  assert.equal(s.pickCounter, 0, 'pick counter cleared');
});

test('resetDraft leaves the board draftable again', () => {
  St.draftPlayer('p1', 't0');
  const s = St.getState();
  assert.equal(s.picks.length, 1, 'a fresh pick registers after a reset');
  assert.equal(s.players.find((p) => p.id === 'p1').pickNo, 1, 'numbering restarts at 1');
});

test('resetAll still clears everything, including players', () => {
  St.resetAll();
  const s = St.getState();
  assert.deepEqual(s.players, []);
  assert.deepEqual(s.teams, []);
  assert.deepEqual(s.picks, []);
  assert.equal(s.pickCounter, 0);
  assert.equal(s.settings.myTeamId, null);
});
