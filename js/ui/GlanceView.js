import { html, useState, useEffect } from '../vendor/preact.js';
import { rosterState, recommendOrder } from '../recommend.js';
import { computeNeeds, assignRosterSlots, nextPickForSlot } from '../draft.js';
import { useStore } from './useStore.js';
import { syncFreshness, pickTake } from './glance.js';

// Re-renders once a second so the "synced Ns ago" text stays honest. Cleared on
// unmount so the interval cannot outlive the view.
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);
  return now;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function Notice({ children }) {
  return html`<div class="glance-card"><p class="glance-notice">${children}</p></div>`;
}

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
  </div>`;
}

export function GlanceView({ syncStatus }) {
  // getState() returns the same object every call, so nothing here may be
  // memoized on store data — recompute every render.
  const { settings, teams, players, pickCounter } = useStore();
  const syncEnabled = !!settings.sleeperSyncEnabled;
  // useNow runs above the early returns on purpose: hooks must be called
  // unconditionally, in the same order, on every render.
  const freshness = syncFreshness(syncStatus, syncEnabled, useNow(syncEnabled));

  if (players.length === 0) return html`<${Notice}>Import rankings in Setup to get recommendations.<//>`;
  if (!settings.myTeamId) return html`<${Notice}>Pick which team is yours in Setup to get recommendations.<//>`;

  const mine = players
    .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
    .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
  const state = rosterState(settings.rosterSpots, mine);

  if (state.picksRemaining === 0) return html`<${Notice}>Your roster is full.<//>`;

  const ranked = recommendOrder(
    players.filter((p) => !p.drafted), state, settings.positionLimits
  );
  const take = pickTake(ranked);
  if (!take) {
    return html`<${Notice}>
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

  const at = syncStatus && typeof syncStatus.at === 'number' ? syncStatus.at : null;
  let sync = null;
  if (freshness === 'stale') {
    sync = html`<div class="glance-sync stale">⚠ NOT SYNCING${
      at === null ? '' : ` — last update ${ago(Date.now() - at)}`
    } · advice above may be stale</div>`;
  } else if (freshness === 'fresh') {
    // 'fresh' only means a poll COMPLETED recently — it is returned for a
    // failing API too, and status.error was previously reported only by the top
    // bar's SyncStatus, which Task 3 stopped rendering in this view. Without
    // this branch a responding-but-failing Sleeper API shows a green "synced"
    // dot here and says nothing anywhere else.
    sync = syncStatus.ok
      ? html`<div class="glance-sync"><span class="sync-dot ok"></span>${' '}synced ${ago(Date.now() - at)}</div>`
      : html`<div class="glance-sync"><span class="sync-dot error"></span>${' '}Sleeper sync error: ${syncStatus.error}</div>`;
  }

  return html`<div class="glance-card">
    <${Suggestion} label="TAKE" entry=${take} />
    ${then.length ? html`<div class="glance-then">
      ${then.map((e) => html`<${Suggestion} key=${e.player.id} label="THEN" entry=${e} />`)}
    </div>` : null}
    <div class="glance-needs">
      ${needKeys.length
        ? html`STILL NEED${' '}${needKeys.map((k) => html`<span key=${k}><span class="pos-badge ${k}">${k}</span>${' '}</span>`)}`
        : 'All starting spots filled.'}
    </div>
    ${countdown}
    ${sync}
  </div>`;
}
