// Pure helpers for the Glance view. No DOM, no store access — the only genuinely
// new logic in the feature, kept here so it is testable under Node.

// Roughly three missed six-second polls. Deliberately measured from the last
// COMPLETED poll: a hung request never fires its callback, so `at` stops
// advancing, which is exactly the condition worth surfacing.
export const STALE_AFTER_MS = 20000;

// The one place that decides whether a sync status carries a usable timestamp.
// Number.isFinite, not `typeof === 'number'`: NaN is a number, and NaN > X is
// false, so a NaN timestamp would fall through and report 'fresh' — the exact
// opposite of syncFreshness's contract.
//
// Exported because GlanceView needs the identical decision to render "last
// update Ns ago". It had its own `typeof at === 'number'` copy, so the
// hardening above landed in one of two copies of the same extraction — the
// duplicated-logic-with-divergent-guards shape behind this feature's earlier
// silent-sync bugs. One helper, two call sites, no way to drift.
export function syncAt(status) {
  return status && Number.isFinite(status.at) ? status.at : null;
}

// 'off'   — sync is disabled; there is nothing to be healthy, so show nothing.
// 'fresh' — a poll completed recently (success or failure; a responding-but-
//           failing API is a different problem, reported via status.error).
// 'stale' — no poll has completed recently, OR we have no timestamp at all,
//           OR the timestamp is in the future. Absence of evidence — and
//           nonsense evidence — is never reported as freshness.
export function syncFreshness(status, syncEnabled, now) {
  if (!syncEnabled) return 'off';
  const at = syncAt(status);
  if (at === null) return 'stale';
  // `age < 0` as well as `age > STALE_AFTER_MS`. If the system clock jumps
  // backward mid-draft, a bare `> STALE_AFTER_MS` test is false for every
  // negative age, so a completely dead sync rendered a green dot and — ago()
  // clamping the negative elapsed time — "synced 0s ago", for the size of the
  // jump plus STALE_AFTER_MS. A future timestamp is not evidence of freshness.
  //
  // This requires the caller to read the clock at render time (see GlanceView):
  // against a `now` sampled up to a second ago, every successful poll would
  // land slightly in the "future" and flash the amber banner.
  const age = now - at;
  return (age < 0 || age > STALE_AFTER_MS) ? 'stale' : 'fresh';
}

// recommendOrder sorts excluded entries last, but a board can be entirely
// excluded (e.g. every remaining player is at a position limit), so the first
// element is not necessarily draftable.
export function pickTake(ranked) {
  if (!Array.isArray(ranked)) return null;
  return ranked.find((e) => !e.excluded) || null;
}
