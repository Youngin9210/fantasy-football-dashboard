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

export {
  rosterState,
  scorePlayer,
  UNRANKED,
  STARTER_BONUS,
  FLEX_BONUS,
  KDEF_PENALTY,
  KDEF_BUFFER,
  KDEF_POSITIONS,
  FLEX_ELIGIBLE,
};
