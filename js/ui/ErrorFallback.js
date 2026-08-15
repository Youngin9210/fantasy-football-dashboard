import { html } from '../vendor/preact.js';

// Must stay in sync with STORAGE_KEY in ../state.js (which does not export it).
const STORAGE_KEY = 'ffDraftState.v1';

export function ErrorFallback({ error, reset }) {
  return html`<div class="panel" style="margin:16px;padding:16px;">
    <div class="panel-header">Something broke</div>
    <p class="hint">${error.message}</p>
    <button class="btn primary" onClick=${reset}>Try again</button>
    <button class="btn" onClick=${() => location.reload()}>Reload page</button>
    <button class="btn danger" onClick=${clearSavedDraft}>Clear saved draft and reload</button>
    <p class="hint">
      "Try again" and "Reload page" both re-run the same render, so if the saved
      draft itself is what breaks it they will keep landing back here. Clearing
      it always gets the dashboard back — it wipes rankings, teams and picks
      from this browser, so it is the last resort, not the first.
    </p>
  </div>`;
}

// The whole UI — setup panel and both reset buttons included — lives inside the
// error boundary, so a render throw takes the escape hatches down with it. In
// vanilla the setup panel was static markup in index.html with its listeners
// bound before the first render, so Reset Everything still worked. This button
// is the port's replacement, and it does the reset the hard way, without
// rendering or importing state.js, so it works no matter what state.js chokes
// on. It is reachable in practice: PlayersTable calls `p.name.toLowerCase()`,
// so a single ranking row with no name throws the moment he types in the search
// box — and the search box he would clear to recover is gone with everything
// else.
//
// confirm() first, matching every other `btn danger` in the app: this is the
// one button here that destroys data, and on draft day a stray click on it
// costs the whole board.
function clearSavedDraft() {
  if (!confirm('Clear the saved draft from this browser and reload? Rankings, teams and pick history are lost. Use this only if the dashboard will not load.')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}
