// Roster-aware pick scoring. Pure functions only — no DOM access, so the
// judgment calls here are testable in isolation.

import { assignRosterSlots } from './draft.js';
import { FLEX_ELIGIBLE } from './positions.js';

// How much an open roster need is worth, measured in ranking places.
// STARTER_BONUS = 12 means "an empty starting slot is worth about one round":
// a clearly better player at a filled position still wins, but a close call
// breaks toward filling the roster. Tune these two numbers here.
const STARTER_BONUS = 12;
const FLEX_BONUS = 6;

// K and DST sink below everyone until waiting gets risky. KDEF_BUFFER = 1 keeps
// one pick of slack so a sniped defense doesn't leave the slot empty.
const KDEF_PENALTY = 999;
const KDEF_BUFFER = 1;
const KDEF_POSITIONS = ['K', 'DST'];

// A bye costs one week out of roughly fourteen; an unfilled starting slot costs
// the season. Half of STARTER_BONUS, so a bye conflict breaks a close call but
// never overrides a clearly better player. Tune here.
const BYE_PENALTY = 6;

// Snapshot of the roster being built: what's still open, what's already stacked,
// and how much draft is left.
function rosterState(rosterSpots = [], myPlayers = []) {
  const { slots } = assignRosterSlots(rosterSpots, myPlayers);

  const openStarters = {};
  let openFlex = 0;
  for (const slot of slots) {
    if (slot.player || slot.label === 'BN') continue;
    if (slot.label === 'FLEX') openFlex++;
    else openStarters[slot.label] = (openStarters[slot.label] || 0) + 1;
  }

  const posCounts = {};
  for (const player of myPlayers) {
    if (!player.pos) continue;
    posCounts[player.pos] = (posCounts[player.pos] || 0) + 1;
  }

  const picksRemaining = Math.max(0, rosterSpots.length - myPlayers.length);
  const kdefNeeded = KDEF_POSITIONS.reduce((n, pos) => n + (openStarters[pos] || 0), 0);

  return {
    openStarters,
    openFlex,
    posCounts,
    picksRemaining,
    kdefNeeded,
    kdefUrgent: kdefNeeded > 0 && picksRemaining <= kdefNeeded + KDEF_BUFFER,
  };
}

// How many starter-weeks this pick would leave unfillable at its own position,
// because of bye overlap.
//
// `required` is capped at what is actually rostered. Without that cap the metric
// fires constantly early in the draft — one RB against two RB slots is "short"
// in every week regardless of byes — and would measure missing depth rather than
// bye concentration.
//
// Null byes (a Sleeper-synced player absent from the CSV) count toward `total`
// because they are real bodies at the position, but never match a week, so they
// read as available everywhere. Optimistic, and the only honest option given we
// do not know their bye.
function byeShortfall(candidateBye, rosteredByes = [], startersNeeded = 0) {
  if (!Number.isFinite(candidateBye)) return 0;
  const roster = Array.isArray(rosteredByes) ? rosteredByes : [];
  const needed = Number.isFinite(startersNeeded) ? startersNeeded : 0;
  if (needed <= 0) return 0;

  const all = [...roster, candidateBye];
  const total = all.length;
  const required = Math.min(needed, total);

  const weeks = new Set(all.filter(Number.isFinite));
  let shortfall = 0;
  for (const week of weeks) {
    const onBye = all.filter((b) => b === week).length;
    shortfall += Math.max(0, required - (total - onBye));
  }
  return shortfall;
}

// Rank of an unranked player: sorts below every ranked one but stays finite so
// arithmetic and comparisons never produce NaN.
const UNRANKED = 9999;

// Scores one available player against the roster snapshot.
// Lower score is a better pick. Excluded players are never draftable.
// `weights` overrides the tuning constants. It exists so the calibration script
// can exercise this exact function at several bonus values instead of keeping a
// second copy of the math that could drift out of agreement with it.
function scorePlayer(player, state, limits = {}, weights = {}) {
  const starterBonus = weights.starterBonus ?? STARTER_BONUS;
  const flexBonus = weights.flexBonus ?? FLEX_BONUS;
  const pos = player.pos || '';
  const rank = Number.isFinite(player.rank) ? player.rank : UNRANKED;

  // Roster rules come first: an open slot cannot be filled by a player the
  // league forbids, so exclusion is checked before any bonus.
  const limit = limits[pos];
  if (limit !== undefined && (state.posCounts[pos] || 0) >= limit) {
    return { score: Infinity, reason: `${pos} LIMIT (${limit})`, excluded: true };
  }

  if (KDEF_POSITIONS.includes(pos)) {
    if (state.kdefUrgent && (state.openStarters[pos] || 0) > 0) {
      return { score: rank - starterBonus, reason: `FILLS ${pos}`, excluded: false };
    }
    return { score: rank + KDEF_PENALTY, reason: 'WAIT', excluded: false };
  }

  if ((state.openStarters[pos] || 0) > 0) {
    return { score: rank - starterBonus, reason: `FILLS ${pos}`, excluded: false };
  }

  if (state.openFlex > 0 && FLEX_ELIGIBLE.includes(pos)) {
    return { score: rank - flexBonus, reason: 'FILLS FLEX', excluded: false };
  }

  return { score: rank, reason: 'BENCH', excluded: false };
}

// Scores an entire board and returns it sorted, best pick first.
// Excluded players stay in the list — being told a top QB is sitting there
// while you're at your QB limit is useful information about the board.
function recommendOrder(players, state, limits = {}, weights = {}) {
  return players
    .map((player) => ({ player, ...scorePlayer(player, state, limits, weights) }))
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      if (a.score !== b.score) return a.score - b.score;
      const ar = Number.isFinite(a.player.rank) ? a.player.rank : UNRANKED;
      const br = Number.isFinite(b.player.rank) ? b.player.rank : UNRANKED;
      return ar - br;
    });
}

export {
  rosterState,
  scorePlayer,
  recommendOrder,
  byeShortfall,
  UNRANKED,
  STARTER_BONUS,
  FLEX_BONUS,
  BYE_PENALTY,
  KDEF_PENALTY,
  KDEF_BUFFER,
  KDEF_POSITIONS,
};
