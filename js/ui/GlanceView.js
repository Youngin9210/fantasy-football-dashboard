import { html, useState, useEffect } from '../vendor/preact.js';
import { rosterState, recommendOrder } from '../recommend.js';
import { computeNeeds, assignRosterSlots, nextPickForSlot } from '../draft.js';
import { useStore } from './useStore.js';
import { syncFreshness, syncAt, pickTake, hasNoByeData } from './glance.js';

// A once-a-second re-render heartbeat, nothing more: it exists so the "synced Ns
// ago" text and the staleness threshold are re-evaluated while the user sits
// still. Its stored value is deliberately NOT used as the clock — freshness is
// judged against a Date.now() read during render, because a sampled `now` is up
// to a second behind by construction and syncFreshness now treats a future
// timestamp as skew. Cleared on unmount so the interval cannot outlive the view.
function useHeartbeat(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [active]);
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

// The sync line, built once per render and threaded through Card so that EVERY
// return path carries it. It used to be built at the bottom of GlanceView, below
// four early `return html`<${Notice}>...`` statements, so a dead sync was
// completely invisible — no .glance-sync, no sync-error text anywhere on the
// page (Task 3 also stopped rendering the top bar's SyncStatus in this view) —
// in exactly the states a draft actually starts in. Connecting Sleeper before
// the commissioner posts the draft order leaves myTeamId unset, and the card
// would sit on "Pick which team is yours in Setup" while sync was dead.
//
// Returns null only for 'off': with sync disabled there is nothing to be
// healthy, so nothing is claimed.
function syncLine(status, freshness, now) {
  const at = syncAt(status);
  if (freshness === 'stale') {
    // No "last update" clause when the stamp is in the future: ago() clamps a
    // negative elapsed time to "0s", so under a backward clock jump the banner
    // would read "NOT SYNCING — last update 0s ago", contradicting itself.
    return html`<div class="glance-sync stale">⚠ NOT SYNCING${
      at === null || now < at ? '' : ` — last update ${ago(now - at)}`
    } · advice above may be stale</div>`;
  }
  if (freshness === 'fresh') {
    // 'fresh' only means a poll COMPLETED recently — it is returned for a
    // failing API too, and status.error was previously reported only by the top
    // bar's SyncStatus, which Task 3 stopped rendering in this view. Without
    // this branch a responding-but-failing Sleeper API shows a green "synced"
    // dot here and says nothing anywhere else.
    return status.ok
      ? html`<div class="glance-sync"><span class="sync-dot ok"></span>${' '}synced ${ago(now - at)}</div>`
      : html`<div class="glance-sync"><span class="sync-dot error"></span>${' '}Sleeper sync error: ${status.error}</div>`;
  }
  return null;
}

// The single wrapper every Glance render goes through: whatever the body is, the
// sync line is emitted after it. New early returns get the sync signal for free
// instead of silently dropping it.
function Card({ sync, children }) {
  return html`<div class="glance-card">${children}${sync}</div>`;
}

function Notice({ sync, children }) {
  return html`<${Card} sync=${sync}><p class="glance-notice">${children}</p><//>`;
}

// The bye warning gets its OWN element below .glance-pick-why rather than being
// appended to the reason text: the reason describes which slot this pick fills,
// and the warning is a separate consideration about the weeks it leaves thin.
// Rendered verbatim from the scorer (its separator is U+00D7, not the letter x)
// so the Board's badge and this line can never disagree about the same conflict.
function Suggestion({ label, entry }) {
  const p = entry.player;
  return html`<div class="glance-pick">
    <div class="glance-pick-label">${label}</div>
    <div class="glance-pick-name">
      ${p.name}${' '}
      ${p.pos ? html`<span class="pos-badge ${p.pos}">${p.pos}</span>` : null}${' '}
      <span class="player-meta">#${p.rank ?? '—'}</span>
    </div>
    <div class="glance-pick-why">${entry.reason}</div>
    ${entry.byeWarning ? html`<div class="glance-pick-bye">${entry.byeWarning}</div>` : null}
  </div>`;
}

export function GlanceView({ syncStatus }) {
  // getState() returns the same object every call, so nothing here may be
  // memoized on store data — recompute every render.
  const { settings, teams, players, pickCounter } = useStore();
  const syncEnabled = !!settings.sleeperSyncEnabled;
  // useHeartbeat runs above the early returns on purpose: hooks must be called
  // unconditionally, in the same order, on every render. It only schedules
  // re-renders; the clock the sync line is judged against is read here, at
  // render time, so `now` can never lag a just-completed poll.
  useHeartbeat(syncEnabled);
  const now = Date.now();
  const freshness = syncFreshness(syncStatus, syncEnabled, now);
  // Built before the first early return, so no return path below can omit it.
  const sync = syncLine(syncStatus, freshness, now);

  if (players.length === 0) return html`<${Notice} sync=${sync}>Import rankings in Setup to get recommendations.<//>`;
  if (!settings.myTeamId) return html`<${Notice} sync=${sync}>Pick which team is yours in Setup to get recommendations.<//>`;

  const mine = players
    .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
    .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
  const state = rosterState(settings.rosterSpots, mine);

  // A CSV with no bye column yields bye: null for everyone, so the weighting
  // contributes nothing and the card must say so. Both gates (a non-empty
  // roster, and ALL of it lacking a bye) plus the Number.isFinite/bye-0
  // distinction live in glance.js so they are unit-tested rather than trapped in
  // this component — see hasNoByeData.
  const noByeData = hasNoByeData(mine);

  if (state.picksRemaining === 0) return html`<${Notice} sync=${sync}>Your roster is full.<//>`;

  const ranked = recommendOrder(
    players.filter((p) => !p.drafted), state, settings.positionLimits
  );
  const take = pickTake(ranked);
  if (!take) {
    return html`<${Notice} sync=${sync}>
      No draftable player left — every remaining player is at one of your position limits.
      Check Position limits in Setup, or switch to the Board to override.
    <//>`;
  }
  const then = ranked.filter((e) => !e.excluded && e !== take).slice(0, 2);

  const needs = computeNeeds(assignRosterSlots(settings.rosterSpots, mine).slots);
  const needKeys = Object.keys(needs);

  const myTeam = teams.find((t) => t.id === settings.myTeamId);
  let countdown = null;
  if (myTeam) {
    const nextPickNo = pickCounter + 1;
    const mySlot = nextPickForSlot(nextPickNo, myTeam.slot, settings.numTeams);
    // nextPickForSlot returns null when the slot is outside the current
    // numTeams (a Sleeper league resized after teams were imported, say).
    // Subtracting straight from that coerces null to 0, so the brief's
    // arithmetic rendered "-2 picks until your turn" — a plausible-looking
    // number that is simply wrong. No countdown is better than a wrong one.
    const until = mySlot === null ? null : mySlot - nextPickNo;
    if (until !== null) {
      countdown = until === 0
        ? html`<div class="glance-turn my-turn">YOU'RE UP</div>`
        : html`<div class="glance-turn">${until} pick${until === 1 ? '' : 's'} until your turn</div>`;
    }
  }

  return html`<${Card} sync=${sync}>
    <${Suggestion} label="TAKE" entry=${take} />
    ${then.length ? html`<div class="glance-then">
      ${then.map((e) => html`<${Suggestion} key=${e.player.id} label="THEN" entry=${e} />`)}
    </div>` : null}
    <div class="glance-needs">
      ${needKeys.length
        ? html`STILL NEED${' '}${needKeys.map((k) => html`<span key=${k}><span class="pos-badge ${k}">${k}</span>${' '}</span>`)}`
        : 'All starting spots filled.'}
    </div>
    ${noByeData ? html`<div class="glance-needs">No bye weeks in your rankings — bye conflicts are not being weighted.</div>` : null}
    ${countdown}
  <//>`;
}
