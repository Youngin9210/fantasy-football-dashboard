// Snake draft order math + roster slot assignment / needs calculation.

import { FLEX_ELIGIBLE } from './positions.js';

// slotIndex is 0-based (0 = draft slot 1). Round is 1-based.
function pickToSlotIndex(pickNo, numTeams) {
  const round = Math.ceil(pickNo / numTeams);
  const posInRound = pickNo - (round - 1) * numTeams; // 1-based
  if (round % 2 === 1) {
    return posInRound - 1;
  }
  return numTeams - posInRound;
}

function pickToRound(pickNo, numTeams) {
  return Math.ceil(pickNo / numTeams);
}

// Next pick number (>= fromPickNo) that belongs to the given slot index.
function nextPickForSlot(fromPickNo, slotIndex, numTeams) {
  for (let p = fromPickNo; p < fromPickNo + numTeams * 2; p++) {
    if (pickToSlotIndex(p, numTeams) === slotIndex) return p;
  }
  return null;
}

// Assigns a team's drafted players (in draft order) to roster slots.
// rosterSpots: array of labels like ['QB','RB','RB','WR','WR','TE','FLEX','DST','K','BN',...]
// players: array of {pos, ...}, ideally sorted by pickNo ascending.
function assignRosterSlots(rosterSpots, players) {
  const slots = rosterSpots.map((label, idx) => ({ idx, label, player: null }));
  const remaining = players.slice();

  for (const slot of slots) {
    if (slot.label === 'FLEX' || slot.label === 'BN') continue;
    const i = remaining.findIndex((p) => p.pos === slot.label);
    if (i !== -1) {
      slot.player = remaining[i];
      remaining.splice(i, 1);
    }
  }
  for (const slot of slots) {
    if (slot.label !== 'FLEX') continue;
    const i = remaining.findIndex((p) => FLEX_ELIGIBLE.includes(p.pos));
    if (i !== -1) {
      slot.player = remaining[i];
      remaining.splice(i, 1);
    }
  }
  for (const slot of slots) {
    if (slot.label !== 'BN') continue;
    if (remaining.length > 0) {
      slot.player = remaining.shift();
    }
  }
  return { slots, overflow: remaining };
}

// Returns { POS: count } of empty starting (non-bench) slots.
function computeNeeds(slots) {
  const needs = {};
  for (const s of slots) {
    if (s.label === 'BN' || s.player) continue;
    needs[s.label] = (needs[s.label] || 0) + 1;
  }
  return needs;
}

export { pickToSlotIndex, pickToRound, nextPickForSlot, assignRosterSlots, computeNeeds, FLEX_ELIGIBLE };
