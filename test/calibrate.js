// Diagnostic, not a test. Prints the same mid-draft board scored at three
// STARTER_BONUS values so the weight is chosen from observed behavior.
//
// Calls the real recommendOrder() with injected weights rather than re-deriving
// the math, so what this prints is exactly what the app would show.
//
// Usage: node test/calibrate.js
import { rosterState, recommendOrder } from '../js/recommend.js';

const SPOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };

// Round 5: QB, both RBs and one WR are in. TE and one WR are still open.
const MY_TEAM = [
  { pos: 'QB', rank: 22, name: 'my QB' },
  { pos: 'RB', rank: 5, name: 'my RB1' },
  { pos: 'RB', rank: 20, name: 'my RB2' },
  { pos: 'WR', rank: 31, name: 'my WR1' },
];

const BOARD = [
  { pos: 'RB', rank: 38, name: 'Kenneth Walker' },
  { pos: 'RB', rank: 41, name: 'James Cook' },
  { pos: 'TE', rank: 45, name: 'Trey McBride' },
  { pos: 'WR', rank: 47, name: 'Jaylen Waddle' },
  { pos: 'TE', rank: 55, name: 'David Njoku' },
  { pos: 'WR', rank: 58, name: 'Rome Odunze' },
  { pos: 'QB', rank: 60, name: 'Jared Goff' },
];

const state = rosterState(SPOTS, MY_TEAM);

for (const bonus of [6, 12, 20]) {
  const flexBonus = Math.round(bonus / 2);
  const ranked = recommendOrder(BOARD, state, LIMITS, {
    starterBonus: bonus,
    flexBonus,
  });

  console.log(`\n=== STARTER_BONUS = ${bonus} (FLEX ${flexBonus}) ===`);
  for (const r of ranked) {
    console.log(
      `  ${String(r.score).padStart(4)}  #${String(r.player.rank).padStart(2)}  ` +
      `${r.player.pos.padEnd(3)}  ${r.player.name.padEnd(16)} ${r.reason}`
    );
  }
}
