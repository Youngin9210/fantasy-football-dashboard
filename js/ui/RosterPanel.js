import { html } from '../vendor/preact.js';
import { assignRosterSlots, computeNeeds } from '../draft.js';
import { useStore } from './useStore.js';

export function RosterPanel() {
  const { settings, teams, players } = useStore();
  const myTeam = teams.find((t) => t.id === settings.myTeamId);

  const myPlayers = players
    .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
    .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));

  const { slots } = assignRosterSlots(settings.rosterSpots, myPlayers);
  const needs = computeNeeds(slots);
  const needKeys = Object.keys(needs);

  return html`<div class="panel">
    <div class="panel-header">My Team <span>${myTeam ? `— ${myTeam.name}` : ''}</span></div>
    <ul class="roster-list">
      ${slots.map((s) => html`<li key=${s.idx}>
        <span class="slot-label">${s.label}</span>
        ${s.player
          ? html`<span class="pos-badge ${s.player.pos}">${s.player.pos}</span> ${s.player.name}`
          : html`<span class="slot-empty">empty</span>`}
      </li>`)}
    </ul>
    <div class="needs-row">
      ${needKeys.length
        ? html`Needs: ${needKeys.map((k) => html`<span key=${k}><span class="pos-badge ${k}">${k}</span>×${needs[k]} </span>`)}`
        : 'All starting spots filled.'}
    </div>
  </div>`;
}
