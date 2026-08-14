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

test('DEFAULT_ROSTER matches the real league: 16 spots, 7 bench, DST not DEF', () => {
  const r = St.DEFAULT_ROSTER;
  assert.equal(r.length, 16);
  assert.equal(r.filter((x) => x === 'BN').length, 7);
  assert.ok(r.includes('DST'));
  assert.ok(!r.includes('DEF'));
  assert.ok(r.includes('FLEX'));
});

test('new settings default to today\'s behavior', () => {
  const s = St.getState().settings;
  assert.deepEqual(s.positionLimits, {});
  assert.equal(s.sortMode, 'rank');
});

test('a saved state from before this feature gains the new keys', async () => {
  // load() uses Object.assign, which is shallow: a saved `settings` object
  // replaces the default one wholesale, so new keys would go missing for every
  // existing user mid-draft.
  globalThis.localStorage._v['ffDraftState.v1'] = JSON.stringify({
    settings: { numTeams: 10, myTeamId: 'r2', rosterSpots: ['QB', 'BN'] },
    players: [{ id: 'p1', name: 'Saved Player' }],
  });
  const fresh = await import('../js/state.js?reload=1');
  const s = fresh.getState().settings;

  assert.deepEqual(s.positionLimits, {}, 'new key present');
  assert.equal(s.sortMode, 'rank', 'new key present');
  assert.equal(s.myTeamId, 'r2', 'saved value preserved');
  assert.deepEqual(s.rosterSpots, ['QB', 'BN'], 'saved value preserved');
  assert.equal(fresh.getState().players.length, 1, 'saved draft preserved');
});
