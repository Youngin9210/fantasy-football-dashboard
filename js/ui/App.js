import { html, useState } from '../vendor/preact.js';
import { useStore } from './useStore.js';
import { TopBar } from './TopBar.js';

export function App({ toggleTheme }) {
  const { players, teams } = useStore();
  // Setup opens by itself only on a truly empty install, matching the old init().
  const [setupOpen, setSetupOpen] = useState(() => players.length === 0 && teams.length === 0);
  const [syncStatus] = useState({ ok: true, error: null });

  return html`
    <${TopBar} onToggleSetup=${() => setSetupOpen((v) => !v)} syncStatus=${syncStatus} toggleTheme=${toggleTheme} />
    ${setupOpen ? html`<section class="setup-panel"><div class="setup-grid"></div></section>` : null}
    <main class="layout">
      <section class="panel"></section>
      <aside class="sidebar"></aside>
    </main>
  `;
}
