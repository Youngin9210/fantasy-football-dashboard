import { html } from '../vendor/preact.js';
import { pickToSlotIndex, pickToRound, nextPickForSlot } from '../draft.js';
import * as St from '../state.js';
import { useStore } from './useStore.js';

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

function SyncStatus({ status }) {
  const { settings } = useStore();
  if (!settings.sleeperSyncEnabled) return html`<div class="sync-status" id="syncStatus"></div>`;
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
