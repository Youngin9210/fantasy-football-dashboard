// Diagnostic, not a test. Prints the same mid-draft board scored at three
// BYE_PENALTY values so the weight is chosen from observed behavior, the same
// way tools/calibrate.js settled STARTER_BONUS.
//
// Calls the real recommendOrder() with an injected weights.byePenalty rather
// than re-deriving the math, so what this prints is exactly what the app would
// show. STARTER_BONUS and FLEX_BONUS are imported, not redefined, so this
// script cannot silently drift from the shipped constants it isn't tuning.
//
// Usage: node tools/calibrate-bye.mjs
import { rosterState, recommendOrder, STARTER_BONUS, FLEX_BONUS } from '../js/recommend.js';

const SPOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };

// Round 5ish: QB, both RB slots and both WR slots are full; TE and FLEX are
// still open. RB and WR are each rostered on TWO DIFFERENT byes (not the same
// one) -- that is deliberate, not a shortcut. If the two rostered bodies at a
// position shared one bye, a third body sharing that SAME bye would already be
// short via the pair alone, and a "fresh" bye elsewhere would show shortfall 0
// only by accident of which third bye was picked, muddying the very contrast
// this fixture exists to show. Two DIFFERENT rostered byes plus a third body
// that either matches one of them (conflict) or matches neither (fresh) is what
// isolates the effect: fresh -> shortfall 0, conflict -> shortfall 1. This is
// also exactly the shape of the STACKED_RBS fixture in tools/harness.mjs
// (bye 7 + bye 10 rostered, a third RB on bye 7), which the real UI ships with.
//
// Depth matters too: RB and WR both have 2 starting slots and exactly 2 bodies
// rostered. On their own that is the "bodies == slots" trap noted in the task
// brief -- every bye would be a shortfall and nothing would differentiate. What
// unlocks it here is that each BOARD candidate below is evaluated as a
// hypothetical THIRD body at that position (2 slots, 3 total incl. the
// candidate), which is exactly the depth needed for a fresh bye to land at 0
// and a stacked one not to.
const MY_TEAM = [
  { pos: 'QB', rank: 22, name: 'my QB', bye: 11 },
  { pos: 'RB', rank: 6, name: 'my RB1', bye: 7 },
  { pos: 'RB', rank: 9, name: 'my RB2', bye: 10 },
  { pos: 'WR', rank: 15, name: 'my WR1', bye: 9 },
  { pos: 'WR', rank: 33, name: 'my WR2', bye: 12 },
];

// Both RB slots and both WR slots are full (see MY_TEAM), so every RB/WR
// candidate below routes to FLEX, not to its own position -- which is exactly
// the branch where the FLEX_BONUS/BYE_PENALTY interaction described in Step 1b
// lives. TE has no rostered bodies yet, so it still routes to FILLS TE: the
// starter-slot (not FLEX) contrast, and the row that made the score switch from
// the raw shortfall to the avoidable one. See the closing note.
const BOARD = [
  { pos: 'RB', rank: 40, name: 'Fresh-bye RB', bye: 14 },
  { pos: 'RB', rank: 40, name: 'Bye7-conflict RB', bye: 7 },
  { pos: 'WR', rank: 45, name: 'Fresh-bye WR', bye: 16 },
  { pos: 'WR', rank: 45, name: 'Bye9-conflict WR', bye: 9 },
  { pos: 'TE', rank: 42, name: 'First TE pick', bye: 8 },
  { pos: 'QB', rank: 60, name: 'Clean-bye QB (bench)', bye: 6 },
  { pos: 'QB', rank: 65, name: 'Bye11-conflict QB (bench)', bye: 11 },
];

// ------------------------------------------------ second board: STACKED STARTERS
//
// The first board above is depth-only: every RB/WR candidate is a third body, so
// it is blind to the case the feature was actually asked for -- "can't have an
// entire position group with the same bye week". Measured: this file's output was
// byte-identical before and after byeShortfall changed from a season SUM to the
// weekly PEAK, because a summed shortfall could not see a stacked pair at all
// while bodies <= slots. A diagnostic used to choose BYE_PENALTY must be able to
// see the class of picks the penalty now charges, so here it is.
//
// One RB rostered on bye 9 with the SECOND RB SLOT STILL OPEN. Every candidate
// below is 'FILLS RB'; the ones on bye 9 would put both starting RBs out in the
// same week and are charged, the ones on other byes are not. The two rank gaps are
// the point: at penalty p a stacking candidate must be more than p ranks better
// than a spreading one to still win, so p is exactly the rank gap the penalty
// overturns.
const STACK_TEAM = [{ pos: 'RB', rank: 6, name: 'my RB1', bye: 9 }];
const STACK_BOARD = [
  { pos: 'RB', rank: 14, name: 'Better RB, stacks bye9', bye: 9 },
  { pos: 'RB', rank: 20, name: 'Even RB, stacks bye9', bye: 9 },
  { pos: 'RB', rank: 21, name: 'Even RB, spreads (bye6)', bye: 6 },
];

const state = rosterState(SPOTS, MY_TEAM);
const stackState = rosterState(SPOTS, STACK_TEAM);

function printBoard(board, st, byePenalty) {
  for (const r of recommendOrder(board, st, LIMITS, { byePenalty })) {
    const warn = r.byeWarning ? `  ${r.byeWarning}` : '';
    console.log(
      `  ${String(r.score).padStart(4)}  #${String(r.player.rank).padStart(2)}  ` +
      `${r.player.pos.padEnd(3)}  ${r.player.name.padEnd(26)} ${r.reason}${warn}`
    );
  }
}

console.log('Mid-draft roster: QB/RB/RB/WR/WR filled, TE and FLEX open.');
console.log('RB rostered on byes 7 and 10; WR rostered on byes 9 and 12 (two');
console.log('DIFFERENT byes each, not a shared one -- see comment in the source');
console.log('for why). Every RB/WR candidate below is a hypothetical 3rd body');
console.log('at a position with 2 starting slots, which is what lets a fresh');
console.log('bye score 0 and a stacked one not.');
console.log(`STARTER_BONUS = ${STARTER_BONUS} (unchanged), FLEX_BONUS = ${FLEX_BONUS} (unchanged).\n`);

for (const byePenalty of [3, 6, 12]) {
  console.log(`=== BYE_PENALTY = ${byePenalty} ===`);
  printBoard(BOARD, state, byePenalty);
  console.log('');
}

console.log('Second roster: ONE RB rostered on bye 9, the second RB slot still');
console.log('OPEN. Every candidate is FILLS RB. A bye-9 candidate puts both');
console.log('starting RBs on the same bye week and is charged; the bye-6 one is');
console.log('not. This is the case the feature was asked for, and the case a');
console.log('summed shortfall could not see at all.\n');

for (const byePenalty of [3, 6, 12]) {
  console.log(`=== STACKED STARTERS, BYE_PENALTY = ${byePenalty} ===`);
  printBoard(STACK_BOARD, stackState, byePenalty);
  console.log('');
}

console.log(
  `note: byePenalty 6 == FLEX_BONUS 6, so one shortfall week cancels the FLEX\n` +
  `bonus exactly. Compare "Fresh-bye RB" vs "Bye7-conflict RB" above (same rank,\n` +
  `#40): at byePenalty 6 the conflict candidate's score (40) equals its raw rank\n` +
  `-- the -6 FLEX bonus and the +6 bye penalty cancel, so a badged FLEX pick can\n` +
  `never outscore a better-ranked unbadged one. At 3 the conflict candidate still\n` +
  `beats its own raw rank (37 < 40); at 12 it scores worse than raw rank (46 > 40).\n` +
  `Same pattern on "Fresh-bye WR" vs "Bye9-conflict WR" (#45, cancels to 45 at 6).\n` +
  `This is an accident of two independently chosen constants, not a decision.\n` +
  `\n` +
  `note: "First TE pick" scores 30 at EVERY weight above, because the score now\n` +
  `charges only the AVOIDABLE shortfall. His raw shortfall is 1 -- he is the first\n` +
  `body at TE, so he is short in his own bye week -- but every TE on the board\n` +
  `faces exactly that, so no different pick avoids it and it is charged to neither\n` +
  `the score nor the badge. This row is why: charging the RAW shortfall scored him\n` +
  `33 / 36 / 42 at penalty 3 / 6 / 12, against the fresh-bye RB's 34, so at 6 and\n` +
  `12 a FLEX/bench body outranked the only pick that fills an EMPTY STARTING SLOT.\n` +
  `The penalty was uniform across TE candidates but not across positions. With the\n` +
  `avoidable measure the starter stays first at every weight, while a genuinely\n` +
  `stacked bye is still charged in full (the two badged FLEX rows above).\n` +
  `\n` +
  `note: the STACKED STARTERS board is where BYE_PENALTY should now be judged, and\n` +
  `it is new. The first board's output is byte-identical before and after\n` +
  `byeShortfall switched from a season SUM to the weekly PEAK, so the weight 6 was\n` +
  `chosen without ever seeing the picks peak charges. On that second board every\n` +
  `candidate FILLS an open starting slot, so nothing cancels the penalty the way\n` +
  `FLEX_BONUS does above: the penalty is the entire difference between a stacked\n` +
  `and a spread pick at the same rank. At penalty p a stacking candidate must be\n` +
  `more than p ranks better to still win, so p IS the rank gap the penalty\n` +
  `overturns: at 3 the #14 stacker beats the #21 spreader and the #20 stacker does\n` +
  `not; at 6 the #14 stacker still wins by one point; at 12 even he loses. Read the\n` +
  `weight as "how many ranking places a same-week bye clash is worth" and pick it\n` +
  `from those rows. BYE_PENALTY is left at 6 here -- this is a diagnostic.`
);
