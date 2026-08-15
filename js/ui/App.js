import { html, useState } from '../vendor/preact.js';
import { pickToSlotIndex } from '../draft.js';
import { useStore } from './useStore.js';
import { TopBar } from './TopBar.js';
import { PlayersTable } from './PlayersTable.js';
import { RosterPanel } from './RosterPanel.js';
import { DraftLog } from './DraftLog.js';
import { SetupPanel } from './SetupPanel.js';

export function App({ toggleTheme }) {
  const { players, teams, settings, pickCounter } = useStore();
  // Setup opens by itself only on a truly empty install, matching the old init().
  const [setupOpen, setSetupOpen] = useState(() => players.length === 0 && teams.length === 0);
  const [syncStatus] = useState({ ok: true, error: null });
  // TRANSITIONAL SCAFFOLDING (Task 4 → Task 5): the Sleeper polling hook does
  // not exist yet, so connect/disconnect have nothing to start or stop. Task 5
  // replaces both of these with useSleeperSync()'s real start/stop — which is
  // also where `updateSettings({ sleeperSyncEnabled: false })` on disconnect
  // lives, so until then Disconnect only reports itself in the panel.
  const startPolling = () => {};
  const stopPolling = () => {};

  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  // The "Draft pick for" selector always defaults to whoever is on the clock,
  // recomputed after every pick, so clicking Draft repeatedly walks the real
  // draft order. An override is scoped to the pick it was made for — vanilla's
  // populateTeamSelects() reset the select on every render, so an override
  // covered a single out-of-order pick and never silently stuck.
  const [draftForOverride, setDraftForOverride] = useState(null);

  const onClockSlot = pickToSlotIndex(pickCounter + 1, settings.numTeams);
  const onClockId = teams.find((t) => t.slot === onClockSlot)?.id ?? '';
  const draftForId = draftForOverride && draftForOverride.pick === pickCounter
    ? draftForOverride.id
    : onClockId;

  return html`
    <${TopBar} onToggleSetup=${() => setSetupOpen((v) => !v)} syncStatus=${syncStatus} toggleTheme=${toggleTheme} />
    <${SetupPanel} setupOpen=${setupOpen} onConnected=${startPolling} onDisconnect=${stopPolling} />
    <main class="layout">
      <${PlayersTable} filter=${filter} search=${search}
        onFilter=${setFilter} onSearch=${setSearch}
        draftForId=${draftForId} onDraftFor=${(id) => setDraftForOverride({ pick: pickCounter, id })} />
      <aside class="sidebar">
        <${RosterPanel} />
        <${DraftLog} />
      </aside>
    </main>
    <div class="footer-note">Draft data stays in your browser (localStorage). Nothing is sent anywhere except live pick polling to the public Sleeper API, if connected.</div>
  `;
}
