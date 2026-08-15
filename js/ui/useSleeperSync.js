import { useState, useRef, useEffect, useCallback } from '../vendor/preact.js';
import * as St from '../state.js';
import * as Sleeper from '../sleeper.js';

// Imports one poll's worth of Sleeper picks into the store.
//
// The set of already-imported pick numbers is rebuilt FROM THE STORE on every
// call rather than accumulated across calls. That is deliberate and load
// bearing: vanilla kept a long-lived `processedPickNos` set and had to clear it
// by hand in three places (CSV import, Reset Draft, Reset Everything). Miss any
// one of those call sites and the failure is silent — Reset Draft mid-draft
// would leave the set full, so every subsequent poll skips every pick and the
// board just stays empty with no error. Deriving the set from `state.picks`
// each tick makes Reset Draft and Reset Everything self-healing: clearing
// `picks` clears the set. Vanilla's third site, CSV import, is NOT self-healing
// — `setPlayers` deliberately leaves `picks` and `pickCounter` untouched — so
// that one is handled explicitly at its call site in SetupPanel.importCsv,
// which calls `St.resetDraft()` when sync is enabled.
//
// Exported so the reset-mid-sync behaviour can be tested without a browser.
export function applyPicks(picks) {
  const processed = new Set(St.getState().picks.map((p) => p.pickNo));
  // Ascending pick order so draft-log order and pickCounter track the real draft.
  for (const pick of picks.slice().sort((a, b) => a.pick_no - b.pick_no)) {
    if (!pick.player_id) continue; // slot not yet picked
    if (processed.has(pick.pick_no)) continue;
    processed.add(pick.pick_no); // guards against a duplicate pick_no in one payload

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
