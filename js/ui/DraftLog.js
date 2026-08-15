import { html } from '../vendor/preact.js';
import * as St from '../state.js';
import { useStore } from './useStore.js';
import { suppressPlayer } from './useSleeperSync.js';

// St.undoLastPick pops the END of state.picks, so read that pick off the live
// store the same way rather than off the render-sorted copy. Recording its
// PLAYER first is what stops the next Sleeper poll from re-importing him and
// undoing the undo — and it must be the player rather than last.pickNo,
// because the last pick is often a MANUAL one whose number Sleeper will hand
// to somebody else entirely.
function undoLastPick() {
  const { picks, players } = St.getState();
  const last = picks[picks.length - 1];
  if (!last) return;
  suppressPlayer(players.find((p) => p.id === last.playerId));
  St.undoLastPick();
}

export function DraftLog() {
  const { picks, teams, players } = useStore();
  const ordered = picks.slice().sort((a, b) => b.pickNo - a.pickNo);

  return html`<div class="panel">
    <div class="panel-header">
      Draft Log
      <button class="btn small danger" id="undoBtn" onClick=${undoLastPick}>Undo Last Pick</button>
    </div>
    <ul class="draft-log" id="draftLog">
      ${ordered.map((pk) => {
        const player = players.find((p) => p.id === pk.playerId);
        const team = teams.find((t) => t.id === pk.teamId);
        // A manual pick and a Sleeper pick can legitimately share a pick
        // number (state.js stamps manual picks from the same counter), so the
        // number alone is not a unique key.
        return html`<li key=${pk.pickNo + ':' + pk.playerId}>
          <span>#${pk.pickNo} ${player ? player.name : pk.rawName}</span>
          <span class="player-meta">${team ? team.name : '—'}</span>
        </li>`;
      })}
    </ul>
  </div>`;
}
