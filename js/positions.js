// Canonical position handling, shared by the rankings importer, the Sleeper
// boundary, and roster/recommendation logic.
//
// Sleeper reports team defenses as DEF; FantasyPros CSVs report DST or D/ST.
// assignRosterSlots() matches slots with `p.pos === slot.label`, so a mismatch
// means the defense slot silently never fills. Everything canonicalizes to DST,
// which is what DEFAULT_ROSTER and the .pos-badge CSS already use.
function normalizePos(raw) {
  if (!raw) return '';
  const upper = String(raw).trim().toUpperCase();
  if (upper === 'DEF' || upper === 'DST' || upper === 'D/ST') return 'DST';
  if (upper === 'PK') return 'K';
  // FantasyPros formats positions as "RB1", "WR12" — keep the leading letters.
  const m = upper.match(/^([A-Z]+)/);
  return m ? m[1] : upper;
}

const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export { normalizePos, FLEX_ELIGIBLE };
