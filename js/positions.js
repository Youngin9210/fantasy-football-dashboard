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
  // Prefix matches, not exact ones: FantasyPros writes positional ranks as
  // "DST1" / "DEF1" / "D/ST1" / "PK1", and an exact check lets those leak
  // through raw — such a player never fills the DST/K slot, never counts
  // toward its limit, and slips past the K/DST hold-back as bench depth.
  // Anchored so IDP's D/DL/DB and superflex's SUPER_FLEX are untouched.
  if (/^D\/?ST/.test(upper) || /^DEF/.test(upper)) return 'DST';
  if (/^PK/.test(upper)) return 'K';
  // FantasyPros formats positions as "RB1", "WR12" — keep the leading letters.
  const m = upper.match(/^([A-Z]+)/);
  return m ? m[1] : upper;
}

const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export { normalizePos, FLEX_ELIGIBLE };
