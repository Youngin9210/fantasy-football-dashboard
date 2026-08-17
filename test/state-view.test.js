import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};

const St = await import('../js/state.js');

test('view defaults to glance', () => {
  assert.equal(St.getState().settings.view, 'glance');
});

test('a saved state from before this feature gains the key', async () => {
  globalThis.localStorage._v['ffDraftState.v1'] = JSON.stringify({
    settings: { numTeams: 10, myTeamId: 't1', sortMode: 'need' },
    players: [{ id: 'p1', name: 'Saved' }],
  });
  const fresh = await import('../js/state.js?viewreload=1');
  const s = fresh.getState().settings;
  assert.equal(s.view, 'glance', 'new key present for an existing draft');
  assert.equal(s.sortMode, 'need', 'saved value preserved');
  assert.equal(fresh.getState().players.length, 1, 'saved draft preserved');
});
