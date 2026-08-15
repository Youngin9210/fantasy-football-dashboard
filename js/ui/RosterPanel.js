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
    <div class="panel-header">My Team <span id="myTeamName">${myTeam ? `— ${myTeam.name}` : ''}</span></div>
    <ul class="roster-list" id="rosterList">
      ${slots.map((s) => html`<li key=${s.idx}>
        <span class="slot-label">${s.label}</span>
        ${s.player
          ? html`<span class="pos-badge ${s.player.pos}">${s.player.pos}</span> ${s.player.name}`
          : html`<span class="slot-empty">empty</span>`}
      </li>`)}
    </ul>
    <div class="needs-row" id="needsRow">
      ${needKeys.length
        // flatMap, not map-into-a-wrapper: keying each item would need an
        // element to hang the key on, and that extra <span> is a DOM
        // difference against the vanilla build for no benefit. This list is
        // homogeneous and stateless, so Preact's positional diffing is exactly
        // right and keys buy nothing.
        ? html`Needs: ${needKeys.flatMap((k) => [
            html`<span class="pos-badge ${k}">${k}</span>`, `×${needs[k]} `])}`
        : 'All starting spots filled.'}
    </div>
  </div>`;
}
