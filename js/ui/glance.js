// Pure helpers for the Glance view. No DOM, no store access — the only genuinely
// new logic in the feature, kept here so it is testable under Node.

// Roughly three missed six-second polls. Deliberately measured from the last
// COMPLETED poll: a hung request never fires its callback, so `at` stops
// advancing, which is exactly the condition worth surfacing.
export const STALE_AFTER_MS = 20000;

// 'off'   — sync is disabled; there is nothing to be healthy, so show nothing.
// 'fresh' — a poll completed recently (success or failure; a responding-but-
//           failing API is a different problem, reported via status.error).
// 'stale' — no poll has completed recently, OR we have no timestamp at all.
//           Absence of evidence is never reported as freshness.
export function syncFreshness(status, syncEnabled, now) {
  if (!syncEnabled) return 'off';
  // Number.isFinite, not `typeof === 'number'`: NaN is a number, and NaN > X is
  // false, so a NaN timestamp would fall through and report 'fresh' — the exact
  // opposite of this function's contract.
  const at = status && Number.isFinite(status.at) ? status.at : null;
  if (at === null) return 'stale';
  return now - at > STALE_AFTER_MS ? 'stale' : 'fresh';
}

// recommendOrder sorts excluded entries last, but a board can be entirely
// excluded (e.g. every remaining player is at a position limit), so the first
// element is not necessarily draftable.
export function pickTake(ranked) {
  if (!Array.isArray(ranked)) return null;
  return ranked.find((e) => !e.excluded) || null;
}
