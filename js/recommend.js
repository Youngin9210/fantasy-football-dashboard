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
  const posByes = {};
  for (const player of myPlayers) {
    if (!player.pos) continue;
    posCounts[player.pos] = (posCounts[player.pos] || 0) + 1;
    // Nulls are kept: a Sleeper-synced player with no bye is still a body at the
    // position, so byeShortfall needs them in `total`.
    (posByes[player.pos] = posByes[player.pos] || []).push(
      Number.isFinite(player.bye) ? player.bye : null
    );
  }

  // Total dedicated starting slots per position, from the league's roster shape.
  // Deliberately NOT derived from openStarters, which counts EMPTY slots and
  // shrinks as the roster fills — using that would collapse every bye shortfall
  // to 0 once a position's starters were filled.
  const posSlots = {};
  for (const label of rosterSpots) {
    if (label === 'FLEX' || label === 'BN') continue;
    posSlots[label] = (posSlots[label] || 0) + 1;
  }

  const picksRemaining = Math.max(0, rosterSpots.length - myPlayers.length);
  const kdefNeeded = KDEF_POSITIONS.reduce((n, pos) => n + (openStarters[pos] || 0), 0);

  return {
    openStarters,
    openFlex,
    posCounts,
    posByes,
    posSlots,
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

// Shortfall a different bye could have avoided. The first player at a position
// is always short in his own bye week, and every candidate at that position
// shares that — so it is not a choice and must not be badged. Two bodies against
// two slots is likewise unavoidable whatever their byes.
//
// Measured against a bye nobody holds: whatever shortfall survives THAT is
// structural (missing depth), not a bye clash the user picked. Only the excess
// over that floor is something a different pick would have fixed.
//
// This drives BOTH the badge and the score. An earlier design charged the score
// the RAW byeShortfall, on the argument that an unavoidable cost is uniform
// across candidates at a position and so cannot reorder them. True within a
// position, false ACROSS positions: tools/calibrate-bye.mjs showed the first TE
// filling an EMPTY STARTING SLOT (rank 42 -> 30 with no penalty) demoted below
// bench/FLEX depth at byePenalty 6 and 12 by a penalty no TE candidate could
// avoid. Charging only the avoidable part keeps the real stacked-bye cost (a
// third RB on an already-doubled week is still +6) while never taxing a pick for
// a week nothing on the board could have covered.
//
// Consequence worth knowing: byeShortfall's `required` caps at what is rostered,
// and assignRosterSlots fills every dedicated slot before FLEX/BN, so an open
// starting slot at a position means bodies <= slots, every finite bye there
// counts once, and the floor cancels it exactly. A FILLS-own-position score
// therefore never carries a bye penalty by construction -- which is the demotion
// above, fixed. Depth (FLEX/BENCH) is where the penalty bites.
const NO_SUCH_WEEK = -1; // finite, so it counts as a real week, but one no player holds
function avoidableByeShortfall(candidateBye, rosteredByes, startersNeeded) {
  const actual = byeShortfall(candidateBye, rosteredByes, startersNeeded);
  if (actual === 0) return 0;
  const floor = byeShortfall(NO_SUCH_WEEK, rosteredByes, startersNeeded);
  return Math.max(0, actual - floor);
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
  const byePenalty = weights.byePenalty ?? BYE_PENALTY;
  const pos = player.pos || '';
  const rank = Number.isFinite(player.rank) ? player.rank : UNRANKED;

  // Roster rules come first: an open slot cannot be filled by a player the
  // league forbids, so exclusion is checked before any bonus. A forbidden
  // player needs no bye commentary, and Infinity + 6 is still Infinity.
  const limit = limits[pos];
  if (limit !== undefined && (state.posCounts[pos] || 0) >= limit) {
    return { score: Infinity, reason: `${pos} LIMIT (${limit})`, excluded: true, byeWarning: null };
  }

  // Each branch decides the slot story; the bye penalty is applied once, below,
  // so it cannot be forgotten at one of the five score-assignment sites (the
  // K/DST arm splits into urgent-FILLS and WAIT -- an earlier draft of this
  // comment said four, and a mutant zeroing the penalty on the fifth passed the
  // entire suite until a test was added for it).
  let score;
  let reason;
  if (KDEF_POSITIONS.includes(pos)) {
    if (state.kdefUrgent && (state.openStarters[pos] || 0) > 0) {
      score = rank - starterBonus; reason = `FILLS ${pos}`;
    } else {
      score = rank + KDEF_PENALTY; reason = 'WAIT';
    }
  } else if ((state.openStarters[pos] || 0) > 0) {
    score = rank - starterBonus; reason = `FILLS ${pos}`;
  } else if (state.openFlex > 0 && FLEX_ELIGIBLE.includes(pos)) {
    score = rank - flexBonus; reason = 'FILLS FLEX';
  } else {
    score = rank; reason = 'BENCH';
  }

  const rosteredByes = (state.posByes || {})[pos];
  const startersNeeded = (state.posSlots || {})[pos];

  // ONE number, driving both the score and the badge on purpose: we only charge
  // for a shortfall a different pick would have avoided, and we only badge what
  // we charge. Reintroducing the raw byeShortfall here would tax candidates for a
  // week no pick at their position could cover, which demoted an empty starting
  // slot below bench depth (see avoidableByeShortfall's comment).
  const avoidable = avoidableByeShortfall(player.bye, rosteredByes, startersNeeded);

  return {
    score: score + byePenalty * avoidable,
    reason,
    excluded: false,
    byeWarning: avoidable > 0 ? `BYE ${player.bye} ×${avoidable}` : null,
  };
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
  avoidableByeShortfall,
  UNRANKED,
  STARTER_BONUS,
  FLEX_BONUS,
  BYE_PENALTY,
  KDEF_PENALTY,
  KDEF_BUFFER,
  KDEF_POSITIONS,
};
