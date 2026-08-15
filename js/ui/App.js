import { html, useState, useErrorBoundary } from '../vendor/preact.js';
import { useStore } from './useStore.js';
import { TopBar } from './TopBar.js';

export function App() {
  const { players, teams } = useStore();
  // Setup opens by itself only on a truly empty install, matching the old init().
  const [setupOpen, setSetupOpen] = useState(() => players.length === 0 && teams.length === 0);
  const [syncStatus] = useState({ ok: true, error: null });
  const [error, resetError] = useErrorBoundary();

  if (error) {
    return html`<div class="panel" style="margin:16px;padding:16px;">
      <div class="panel-header">Something broke</div>
      <p class="hint">${error.message}</p>
      <button class="btn primary" onClick=${resetError}>Try again</button>
      <button class="btn" onClick=${() => location.reload()}>Reload page</button>
    </div>`;
  }

  return html`
    <${TopBar} onToggleSetup=${() => setSetupOpen((v) => !v)} syncStatus=${syncStatus} />
    ${setupOpen ? html`<section class="setup-panel"><div class="setup-grid"></div></section>` : null}
    <main class="layout">
      <section class="panel"></section>
      <aside class="sidebar"></aside>
    </main>
  `;
}
