import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLeague, pickToManualPlayer } from '../js/sleeper.js';
import { assignRosterSlots } from '../js/draft.js';

// Shapes captured from the live Sleeper API for league 1389708373728964608.
const LEAGUE = {
  total_rosters: 2,
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  settings: {
    position_limit_qb: 3, position_limit_rb: 6, position_limit_wr: 6,
    position_limit_te: 3, position_limit_k: 2, position_limit_def: 3,
    max_keepers: 1, reserve_slots: 1,
  },
};
const USERS = [
  { user_id: 'u1', display_name: 'A', metadata: { team_name: 'Team A' } },
  { user_id: 'u2', display_name: 'B', metadata: {} },
];
const ROSTERS = [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }];
const DRAFTS = [{ draft_id: 'd1', status: 'pre_draft', draft_order: null, settings: { teams: 2 } }];

function stubFetch() {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : LEAGUE;
    return { ok: true, status: 200, json: async () => body };
  };
}

test('returns roster positions with DEF canonicalized to DST', async () => {
  stubFetch();
  const { rosterPositions } = await connectLeague('L');
  assert.equal(rosterPositions.length, 16);
  assert.ok(rosterPositions.includes('DST'));
  assert.ok(!rosterPositions.includes('DEF'));
  assert.equal(rosterPositions.filter((x) => x === 'BN').length, 7);
});

test('parses position limits and keys defense as DST', async () => {
  stubFetch();
  const { positionLimits } = await connectLeague('L');
  assert.deepEqual(positionLimits, { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 });
});

test('a league with no limits configured returns an empty map', async () => {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : { total_rosters: 2, roster_positions: ['QB', 'BN'], settings: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  const { positionLimits, rosterPositions } = await connectLeague('L');
  assert.deepEqual(positionLimits, {});
  assert.deepEqual(rosterPositions, ['QB', 'BN']);
});

// A pick with no match in the imported rankings gets added to state as a manual
// player. It previously kept Sleeper's raw 'DEF', so the synced defense never
// filled the DST slot and never counted toward the DST position limit.
test('an unmatched defense pick becomes a DST player, not DEF', () => {
  const pick = {
    pick_no: 40,
    metadata: { first_name: 'Baltimore', last_name: 'Ravens', team: 'bal', position: 'DEF' },
  };
  const player = pickToManualPlayer(pick);
  assert.equal(player.pos, 'DST');
  assert.equal(player.team, 'BAL');
  assert.equal(player.name, 'Baltimore Ravens');

  const { slots } = assignRosterSlots(['DST'], [player]);
  assert.equal(slots[0].player.name, 'Baltimore Ravens', 'the DST slot actually fills');
});

test('an unmatched pick with no name at all still gets a label', () => {
  const player = pickToManualPlayer({ pick_no: 7, metadata: {} });
  assert.equal(player.name, 'Pick #7');
  assert.equal(player.pos, '');
});

test('a league missing roster_positions returns an empty array', async () => {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : { total_rosters: 2, settings: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  const { rosterPositions } = await connectLeague('L');
  assert.deepEqual(rosterPositions, []);
});
