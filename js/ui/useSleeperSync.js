import { useState, useRef, useEffect, useCallback } from '../vendor/preact.js';
import * as St from '../state.js';
import * as Sleeper from '../sleeper.js';

// ---------------------------------------------------------------------------
// Dedupe is keyed on PLAYER IDENTITY, not on pick number.
//
// `state.js` stamps a manual pick `pickNo = ++pickCounter` — the same numbering
// space Sleeper's `pick_no` lives in. Any scheme that asks "have I seen pick
// number N?" therefore has a number a manual pick can poison, and three
// successive attempts each found a new way to poison it: an accumulated set
// survived Reset Draft and stopped importing forever; a set rebuilt from
// `state.picks` let a manual pick at N mask Sleeper's real pick N; a
// page-lifetime set re-seeded in beginPolling brought that back after every
// reload. All three failed silently — the player who really went at that pick
// stayed on the board, badged FILLS and recommended best-available.
//
// So ask the question that is actually meaningful instead: IS THE PLAYER
// SLEEPER SAYS WAS PICKED ALREADY DRAFTED ON MY BOARD? That is answered
// entirely from `state.players`, which is the same store the UI renders, so it
// cannot drift out of sync with what the user sees:
//
//   * Reset Draft / Reset Everything clear `drafted`, so the next tick
//     re-imports — self-healing, no call site to remember.
//   * A CSV re-import swaps in fresh, undrafted player objects, so the next
//     tick refills the board against the new rankings.
//   * A manual pick can share a NUMBER with a Sleeper pick but not an IDENTITY:
//     manually drafting Real WR says nothing about whether Star QB is drafted.
//   * A reload restores `state.players` from localStorage with `drafted` intact,
//     so the answer survives the page — there is no page-lifetime bookkeeping
//     left to re-seed wrongly.
//
// The one thing identity CANNOT answer is "did the user deliberately take this
// player back off the board?", because an undo erases the very evidence the
// check reads. That is what `suppressed` below is for, and it is now keyed on
// identity too.

function isDefense(pos) {
  const p = String(pos || '').toUpperCase();
  return p === 'DEF' || p === 'DST';
}

// Does this Sleeper pick refer to this board player?
//
// Deliberately mirrors `Sleeper.matchPickToPlayer` (which we must not edit)
// predicate for predicate, just over a different subset of players: that
// function searches the UNDRAFTED players to decide who a pick lands on, this
// one is asked about players that are already drafted or suppressed. Keeping
// the predicates identical is what makes the round trip closed — whoever
// matchPickToPlayer picked for a pick, this recognises on the next tick.
//
// Defenses are special-cased there because a defense's first_name/last_name are
// unreliable (Sleeper spells them "San Francisco"/"49ers", boards spell them
// "49ers D/ST", "San Francisco", "SF DST"), so the team abbreviation is the
// real key. Miss that and every defense re-imports every six seconds, cloning
// itself into the board forever.
function pickMatchesPlayer(pick, player) {
  if (!player) return false;
  const meta = pick.metadata || {};

  if (isDefense(meta.position)) {
    if (!isDefense(player.pos)) return false;
    // Same two probes matchPickToPlayer uses, in the same order of preference —
    // ORed here because we only need existence, not which player.
    if (player.team === (meta.team || '').toUpperCase()) return true;
    return Sleeper.normalizeName(player.name).includes(Sleeper.normalizeName(meta.first_name));
  }

  const norm = Sleeper.normalizeName(`${meta.first_name || ''} ${meta.last_name || ''}`.trim());
  const pname = Sleeper.normalizeName(player.name);
  if (!norm) {
    // matchPickToPlayer bails on a nameless pick and applyPicks falls back to
    // St.addManualPlayer(Sleeper.pickToManualPlayer(pick)), which names the
    // player after its player_id. Recognise that name or the pick has no
    // identity at all and clones itself on every tick.
    const fallback = Sleeper.normalizeName(Sleeper.pickToManualPlayer(pick).name);
    return !!fallback && pname === fallback;
  }
  // The one place we are stricter than matchPickToPlayer: an empty player name
  // makes its bidirectional `includes` match EVERY pick. There it merely drafts
  // a blank row; here it would silently swallow the whole draft.
  if (!pname) return false;
  return pname === norm || pname.includes(norm) || norm.includes(pname);
}

// The identity a suppression is remembered under. Only used to keep the map
// from growing a duplicate entry per ✕ of the same player — the actual matching
// goes through pickMatchesPlayer against the stored snapshot.
function identityKey(player) {
  return isDefense(player.pos)
    ? `def|${String(player.team || '').toUpperCase()}|${Sleeper.normalizeName(player.name)}`
    : `name|${Sleeper.normalizeName(player.name)}`;
}

// Players the user has explicitly taken back off the board, for the life of the
// page. The board alone cannot cover these: an undo clears `drafted`, so six
// seconds later the poller sees the player as undrafted and re-imports him —
// the undo silently reverts itself. That matters because matchPickToPlayer
// matches names with a loose bidirectional `includes` and does mis-match
// sometimes; undoing the wrong player is the natural correction, and without
// this it is impossible during a live sync short of disconnecting.
//
// Keyed on identity for the same reason dedupe is. Keyed on pick NUMBER, ✕-ing
// a MANUAL pick at number N suppressed Sleeper's real pick N — the correction
// workflow (✕ the wrongly-matched player, manually draft the right one, later
// undo that manual pick) silently deleted a real pick from the draft.
//
// Values are snapshots rather than live player objects: a Reset Everything or a
// CSV re-import replaces the player array wholesale, and a suppression must not
// pin a dead object. Resets clear this set at their call sites in SetupPanel,
// so nothing can get stuck suppressed.
const suppressed = new Map();

// Called by the UI right before it drops a pick from the store: DraftLog's
// "Undo Last Pick" and PlayersTable's per-row ✕. Takes the PLAYER, not a pick
// number — passing a number here is now a type error rather than a silent
// cross-pick suppression.
export function suppressPlayer(player) {
  if (!player) return;
  suppressed.set(identityKey(player), {
    name: player.name,
    pos: player.pos,
    team: player.team,
  });
}

export function clearSuppressed() {
  suppressed.clear();
}

function isSuppressed(pick) {
  for (const player of suppressed.values()) {
    if (pickMatchesPlayer(pick, player)) return true;
  }
  return false;
}

// The draft ID the last polling session was started against, so that switching
// drafts can drop suppression that only ever made sense for the old one.
let lastDraftId = null;

// Called by start() once per polling session, before the first tick.
//
// Suppression carries no draft ID, so it MUST be dropped when the draft changes
// or it leaks: ✕ a pick in a mock draft while dry-running sync, connect to the
// real draft, and that player is silently skipped there too — the failure mode
// is a player missing from the board with nothing to explain it. Clearing here
// rather than in SetupPanel.connectSleeper covers every path that starts
// polling a different draft (the connect button, the resume-on-load effect, any
// future caller) instead of just the one button, and — unlike an unconditional
// clear on connect — it keeps corrections made against the CURRENT draft when
// polling restarts for it: a refresh or a re-press of Connect mid-draft must
// not resurrect every mis-matched pick the user already fixed.
//
// Note what this function no longer does: it does not seed any "already
// imported" set. There is nothing to seed. Every earlier version of this file
// primed such a set from `St.getState().picks` here, which is precisely how the
// manual-pick masking bug survived a reload.
export function beginPolling(draftId) {
  if (draftId !== lastDraftId) {
    clearSuppressed();
    lastDraftId = draftId;
  }
}

// Exported so the reset-, reload- and correction-mid-sync behaviours can be
// tested without a browser.
export function applyPicks(picks) {
  // Ascending pick order so draft-log order and pickCounter track the real draft.
  for (const pick of picks.slice().sort((a, b) => a.pick_no - b.pick_no)) {
    if (!pick.player_id) continue; // slot not yet picked
    if (isSuppressed(pick)) continue;

    // Read the board fresh each iteration: draftPlayer/addManualPlayer mutate
    // it in place, so a duplicate pick_no within one payload — or an older
    // payload replaying picks a newer one already landed — is deduped by the
    // very same check, with no per-tick bookkeeping to get out of step.
    const players = St.getState().players;
    if (players.some((p) => p.drafted && pickMatchesPlayer(pick, p))) continue;

    const team = St.getState().teams.find((t) => t.rosterId === pick.roster_id) || null;
    let matched = Sleeper.matchPickToPlayer(pick, players);
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
