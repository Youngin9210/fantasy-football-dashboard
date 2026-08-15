import { html } from '../vendor/preact.js';
import * as St from '../state.js';
import { useStore } from './useStore.js';

export function DraftLog() {
  const { picks, teams, players } = useStore();
  const ordered = picks.slice().sort((a, b) => b.pickNo - a.pickNo);

  return html`<div class="panel">
    <div class="panel-header">
      Draft Log
      <button class="btn small danger" onClick=${() => St.undoLastPick()}>Undo Last Pick</button>
    </div>
    <ul class="draft-log">
      ${ordered.map((pk) => {
        const player = players.find((p) => p.id === pk.playerId);
        const team = teams.find((t) => t.id === pk.teamId);
        return html`<li key=${pk.pickNo}>
          <span>#${pk.pickNo} ${player ? player.name : pk.rawName}</span>
          <span class="player-meta">${team ? team.name : '—'}</span>
        </li>`;
      })}
    </ul>
  </div>`;
}
