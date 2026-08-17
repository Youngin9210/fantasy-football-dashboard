import { html } from '../vendor/preact.js';
import { pickToSlotIndex, pickToRound, nextPickForSlot } from '../draft.js';
import * as St from '../state.js';
import { useStore } from './useStore.js';
import { useHeartbeat } from './useHeartbeat.js';
import { syncFreshness } from './glance.js';

function ClockWidget() {
  const { settings, teams, pickCounter } = useStore();
  if (teams.length === 0) {
    return html`<div class="clock-widget" id="clockWidget"><span class="clock-pill">Set up teams to see draft order</span></div>`;
  }

  const nextPickNo = pickCounter + 1;
  const slotIndex = pickToSlotIndex(nextPickNo, settings.numTeams);
  const round = pickToRound(nextPickNo, settings.numTeams);
  const onClockTeam = teams.find((t) => t.slot === slotIndex);
  const myTeam = teams.find((t) => t.id === settings.myTeamId);

  let turnPill = null;
  if (myTeam) {
    // nextPickForSlot returns null when the slot sits outside the current
    // numTeams (a stale saved roster, or a league that shrank). `null - n` is
    // -n, not NaN, so the unguarded subtraction rendered a confident
    // "-2 picks until your turn". No turn pill beats a wrong one.
    const next = nextPickForSlot(nextPickNo, myTeam.slot, settings.numTeams);
    const picksUntil = Number.isFinite(next) ? next - nextPickNo : null;
    if (picksUntil !== null) {
      turnPill = picksUntil === 0
        ? html`<span class="clock-pill my-turn">YOU'RE UP</span>`
        : html`<span class="clock-pill">${picksUntil} pick${picksUntil === 1 ? '' : 's'} until your turn</span>`;
    }
  }

  return html`<div class="clock-widget" id="clockWidget">
    <span class="clock-pill">Pick ${nextPickNo} · Rd ${round} · On the clock: <strong>${onClockTeam ? onClockTeam.name : '—'}</strong></span>
    ${turnPill}
  </div>`;
}

// The Board's sync dot. It used to read ONLY `status.ok`, which useSleeperSync
// seeds `{ ok: true, error: null }` before a single poll has been attempted — so
// this rendered a green "Sleeper synced" at t=0 with no evidence whatever, and
// still at t=30s with zero completed polls, while GlanceView on the identical
// status object correctly read "⚠ NOT SYNCING". Two views contradicting each
// other is worse than either alone: it teaches the owner that the amber banner
// is noise, in the one situation where the board has silently stopped marking
// players off and every recommendation is being computed against a stale board.
//
// `status.ok` cannot answer this question — it distinguishes "the last poll
// failed" from "the last poll succeeded" and says nothing about whether a poll
// ever COMPLETED, which is the failure a hung request produces. syncFreshness
// (js/ui/glance.js) is the one place that judgement lives; it is unit-tested,
// and routing both views through it is what makes them agree by construction
// rather than by two authors happening to word it the same way.
function SyncStatus({ status }) {
  const { settings } = useStore();
  const enabled = !!settings.sleeperSyncEnabled;
  // Above every early return, and unconditional: syncFreshness needs a `now`
  // that advances or the dot can never go stale after mount, and nothing else on
  // this page re-renders on a timer. Deliberately NOT sampled into state — the
  // clock is read at render time on the next line, for the reason spelled out in
  // useHeartbeat.js (a `now` up to a second old makes syncFreshness's
  // negative-age skew check misfire right after every successful poll).
  useHeartbeat(enabled);
  const freshness = syncFreshness(status, enabled, Date.now());

  // 'off' — sync disabled. Nothing to be healthy, so nothing is claimed. Keeping
  // the empty div preserves the flex column the top bar's layout depends on.
  if (freshness === 'off') return html`<div class="sync-status" id="syncStatus"></div>`;
  // 'stale' — no poll has completed inside STALE_AFTER_MS, or there is no
  // timestamp at all, or it is in the future. Worded and coloured to match the
  // Glance card's stale banner (⚠ plus the --status-warning amber) so the two
  // views read as one signal, but without Glance's "last update Ns ago · advice
  // above may be stale" tail: this sits in a top bar whose other text is 12px
  // nowrap, and a clause whose width changes every second would reflow the row
  // it shares. The dot is dropped rather than given a third colour — ⚠ on amber
  // is the established idiom here (.glance-sync.stale, .why-badge.bye,
  // tr.need-notice) and an 8px dot cannot carry a distinction the banner already
  // makes unmissable.
  if (freshness === 'stale') {
    return html`<div class="sync-status stale" id="syncStatus">⚠ NOT SYNCING</div>`;
  }
  // 'fresh' — a poll completed recently. That includes a responding-but-FAILING
  // API, which is a different problem and still has to be named, hence the
  // status.ok arm.
  return html`<div class="sync-status" id="syncStatus">
    <span class="sync-dot ${status.ok ? 'ok' : 'error'}"></span>
    <span>${status.ok ? 'Sleeper synced' : `Sleeper sync error: ${status.error}`}</span>
  </div>`;
}

export function TopBar({ onToggleSetup, syncStatus, toggleTheme, view }) {
  return html`<header class="topbar">
    <div class="brand">🏈 Draft Dashboard</div>
    ${view === 'board'
      ? html`<${ClockWidget} />`
      // .topbar is a flex row and .clock-widget is its only flex:1 child, so
      // dropping it entirely pulls the sync dot and the action buttons left
      // against the brand — the buttons visibly jump on every toggle. The
      // empty placeholder keeps that one growing column.
      : html`<div class="clock-widget"></div>`}
    ${view === 'board'
      ? html`<${SyncStatus} status=${syncStatus} />`
      : html`<div class="sync-status"></div>`}
    <div class="topbar-actions">
      <div class="sort-toggle" id="viewToggle">
        <button class="btn small ${view === 'glance' ? 'active' : ''}"
          onClick=${() => St.updateSettings({ view: 'glance' })}>Glance</button>
        <button class="btn small ${view === 'board' ? 'active' : ''}"
          onClick=${() => St.updateSettings({ view: 'board' })}>Board</button>
      </div>
      <button class="btn small" id="themeToggle" title="Toggle light/dark" onClick=${toggleTheme}>🌓</button>
      <button class="btn small" id="settingsBtn" onClick=${onToggleSetup}>⚙ Setup</button>
    </div>
  </header>`;
}
