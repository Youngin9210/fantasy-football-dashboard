import { useState, useRef, useEffect, useCallback } from '../vendor/preact.js';
import * as St from '../state.js';
import * as Sleeper from '../sleeper.js';

// Pick numbers THIS PAGE has imported from Sleeper. Membership alone does not
// skip a pick: a number is only treated as already-imported when it is in this
// set AND still present in `state.picks` (see applyPicks). That intersection is
// deliberate and load bearing, in both directions.
//
// Why the store side: vanilla kept a long-lived `processedPickNos` set and had
// to clear it by hand in three places (CSV import, Reset Draft, Reset
// Everything). Miss any one of those call sites and the failure is silent —
// Reset Draft mid-draft would leave the set full, so every subsequent poll
// skips every pick and the board just stays empty with no error. Intersecting
// with `state.picks` makes Reset Draft and Reset Everything self-healing:
// clearing `picks` empties the intersection. Vanilla's third site, CSV import,
// is NOT self-healing — `setPlayers` deliberately leaves `picks` and
// `pickCounter` untouched — so that one is handled explicitly at its call site
// in SetupPanel.importCsv, which calls `St.resetDraft()` when sync is enabled.
//
// Why the Sleeper side: a MANUAL pick shares Sleeper's numbering space —
// `St.draftPlayer` with no override stamps `pickNo = ++pickCounter` — so a set
// derived from `state.picks` alone makes a manual pick at number N mask
// Sleeper's real pick N for the rest of the draft. That is not hypothetical:
// the documented correction for a bad `matchPickToPlayer` name match is to ✕
// the wrong player and manually draft the right one, which is precisely how a
// manual pick lands on a number Sleeper has not sent yet. The masked player
// then sits on the board as available, badged and recommended, with nothing
// anywhere saying a pick was skipped. Tracking what we actually imported keeps
// vanilla's semantics (it seeded once at startPolling and only ever added
// inside the poll callback) while keeping the reset self-healing above.
//
// Consequence, and it is the same one vanilla had: two picks in `state.picks`
// can share a number. DraftLog keys its rows on `pickNo + ':' + playerId` for
// exactly that reason.
let imported = new Set();

// The draft ID the last polling session was started against, so that switching
// drafts can drop suppression that only ever made sense for the old one.
let lastDraftId = null;

// Called by start() once per polling session, before the first tick.
//
// Suppression is keyed by bare pick number with no draft ID, so it MUST be
// dropped when the draft changes or it leaks: ✕ a pick in a mock draft while
// dry-running sync, connect to the real draft, and that pick number is silently
// skipped there too — the failure mode is a player missing from the board with
// nothing to explain it. Clearing here rather than in SetupPanel.connectSleeper
// covers every path that starts polling a different draft (the connect button,
// the resume-on-load effect, any future caller) instead of just the one button,
// and — unlike an unconditional clear on connect — it keeps corrections made
// against the CURRENT draft when polling restarts for it: a refresh or a
// re-press of Connect mid-draft must not resurrect every mis-matched pick the
// user already fixed.
export function beginPolling(draftId) {
  if (draftId !== lastDraftId) {
    clearSuppressed();
    lastDraftId = draftId;
  }
  imported = new Set(St.getState().picks.map((p) => p.pickNo));
}

//
// Pick numbers the user has explicitly undone, for the life of the page. The
// store-derived set alone cannot cover these: an undo REMOVES the pick from
// `state.picks`, so six seconds later the poller sees its pick_no as brand new
// and re-imports it — the undo silently reverts itself. That matters because
// `matchPickToPlayer` matches names with a loose bidirectional `includes` and
// does mis-match sometimes; undoing the wrong player is the natural correction,
// and without this it is impossible during a live sync short of disconnecting.
//
// Resulting behaviour: an explicitly undone pick stays undone for the session,
// even though Sleeper keeps reporting it. The escape hatch is a reset — both
// Reset Draft and Reset Everything clear this set at their call sites in
// SetupPanel (as does a CSV import while sync is on, which resets the draft),
// so nothing can get stuck suppressed the way vanilla's never-cleared
// `processedPickNos` got stuck populated.
const suppressed = new Set();

// Called by the UI right before it drops a pick from the store: DraftLog's
// "Undo Last Pick" and PlayersTable's per-row ✕.
export function suppressPick(pickNo) {
  if (pickNo != null) suppressed.add(pickNo);
}

export function clearSuppressed() {
  suppressed.clear();
}

// Exported so the reset-mid-sync behaviour can be tested without a browser.
export function applyPicks(picks) {
  const inStore = new Set(St.getState().picks.map((p) => p.pickNo));
  // Ascending pick order so draft-log order and pickCounter track the real draft.
  for (const pick of picks.slice().sort((a, b) => a.pick_no - b.pick_no)) {
    if (!pick.player_id) continue; // slot not yet picked
    if (suppressed.has(pick.pick_no)) continue;
    if (imported.has(pick.pick_no) && inStore.has(pick.pick_no)) continue;
    imported.add(pick.pick_no);
    inStore.add(pick.pick_no); // both, so a duplicate pick_no within one payload is still deduped

    const team = St.getState().teams.find((t) => t.rosterId === pick.roster_id) || null;
    let matched = Sleeper.matchPickToPlayer(pick, St.getState().players);
    if (!matched) matched = St.addManualPlayer(Sleeper.pickToManualPlayer(pick));
    St.draftPlayer(matched.id, team ? team.id : null, pick.pick_no);
  }
}

export function useSleeperSync() {
  const [status, setStatus] = useState({ ok: true, error: null });
  const stopRef = useRef(null);
  // Bumped on every start/stop. Callbacks captured by a poller carry the
  // generation they were created with, so a fetch already in flight when the
  // user hits Disconnect cannot land picks or a status update afterwards —
  // startPolling's own `stopped` flag is only checked before the fetch.
  const genRef = useRef(0);
  // useEffect is flushed after paint, so there is a window between the first
  // render and the subscription. Nothing may start an interval before mount, or
  // after unmount, or it outlives the component for the life of the page.
  const mountedRef = useRef(false);

  const stopInterval = useCallback(() => {
    genRef.current += 1;
    if (stopRef.current) stopRef.current();
    stopRef.current = null;
  }, []);

  const stop = useCallback(() => {
    stopInterval();
    St.updateSettings({ sleeperSyncEnabled: false });
  }, [stopInterval]);

  const start = useCallback(() => {
    stopInterval(); // never leave a second interval polling the same draft
    if (!mountedRef.current) return;
    const draftId = St.getState().settings.sleeperDraftId;
    if (!draftId) return;
    beginPolling(draftId);

    const gen = genRef.current;
    const alive = () => mountedRef.current && genRef.current === gen;
    stopRef.current = Sleeper.startPolling(
      draftId,
      (picks) => { if (alive()) applyPicks(picks); },
      (s) => { if (alive()) setStatus(s); }
    );
  }, [stopInterval]);

  // Resume polling on load if a previous session left sync enabled, and always
  // stop the interval on unmount.
  useEffect(() => {
    mountedRef.current = true;
    const s = St.getState().settings;
    if (s.sleeperSyncEnabled && s.sleeperDraftId) start();
    return () => {
      mountedRef.current = false;
      stopInterval();
    };
  }, [start, stopInterval]);

  return { status, start, stop };
}
