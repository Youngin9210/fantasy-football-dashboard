import { html, useState } from '../vendor/preact.js';
import { pickToSlotIndex } from '../draft.js';
import { useStore } from './useStore.js';
import { TopBar } from './TopBar.js';
import { PlayersTable } from './PlayersTable.js';

export function App({ toggleTheme }) {
  const { players, teams, settings, pickCounter } = useStore();
  // Setup opens by itself only on a truly empty install, matching the old init().
  const [setupOpen, setSetupOpen] = useState(() => players.length === 0 && teams.length === 0);
  const [syncStatus] = useState({ ok: true, error: null });

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
    ${setupOpen ? html`<section class="setup-panel"><div class="setup-grid"></div></section>` : null}
    <main class="layout">
      <${PlayersTable} filter=${filter} search=${search}
        onFilter=${setFilter} onSearch=${setSearch}
        draftForId=${draftForId} onDraftFor=${(id) => setDraftForOverride({ pick: pickCounter, id })} />
      <aside class="sidebar"></aside>
    </main>
  `;
}
