import { html } from '../vendor/preact.js';
import { pickToSlotIndex, pickToRound, nextPickForSlot } from '../draft.js';
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
    const picksUntil = nextPickForSlot(nextPickNo, myTeam.slot, settings.numTeams) - nextPickNo;
    turnPill = picksUntil === 0
      ? html`<span class="clock-pill my-turn">YOU'RE UP</span>`
      : html`<span class="clock-pill">${picksUntil} pick${picksUntil === 1 ? '' : 's'} until your turn</span>`;
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

export function TopBar({ onToggleSetup, syncStatus, toggleTheme }) {
  return html`<header class="topbar">
    <div class="brand">🏈 Draft Dashboard</div>
    <${ClockWidget} />
    <${SyncStatus} status=${syncStatus} />
    <div class="topbar-actions">
      <button class="btn small" id="themeToggle" title="Toggle light/dark" onClick=${toggleTheme}>🌓</button>
      <button class="btn small" id="settingsBtn" onClick=${onToggleSetup}>⚙ Setup</button>
    </div>
  </header>`;
}
