import { html, useState } from '../vendor/preact.js';
import * as St from '../state.js';
import { parseRankingsCsv } from '../csv.js';
import * as Sleeper from '../sleeper.js';
import { normalizePos } from '../positions.js';
import { parseLimitsInput, formatLimits } from '../limits.js';
import { useStore } from './useStore.js';
import { clearSuppressed } from './useSleeperSync.js';

// htm is a template parser, not an HTML parser: it does NO entity decoding, so
// an inline `&amp;` renders as the literal characters "&amp;". Plain `&` is
// safe in template text, but a bare `<` would start a tag — so the one string
// containing angle brackets is interpolated instead of written inline.
const SLEEPER_URL_HINT = 'sleeper.com/leagues/<LEAGUE_ID>/...';

export function SetupPanel({ setupOpen, onConnected, onDisconnect }) {
  const { settings, teams } = useStore();
  const [sleeperMsg, setSleeperMsg] = useState('');
  const [csvMsg, setCsvMsg] = useState('');
  const [teamNames, setTeamNames] = useState('');
  const [csvPaste, setCsvPaste] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [leagueId, setLeagueId] = useState(settings.sleeperLeagueId);

  async function connectSleeper() {
    if (!leagueId.trim()) return setSleeperMsg('Enter a Sleeper league ID first.');
    setSleeperMsg('Connecting…');
    try {
      const { draft, teams: synced, orderKnown, rosterPositions, positionLimits } =
        await Sleeper.connectLeague(leagueId.trim());
      St.setTeams(synced);
      St.updateSettings({
        numTeams: synced.length,
        sleeperLeagueId: leagueId.trim(),
        sleeperDraftId: draft.draft_id,
        sleeperSyncEnabled: true,
        // Only overwrite when Sleeper actually returned something, so a sparse
        // league response never wipes a hand-entered roster.
        ...(rosterPositions.length ? { rosterSpots: rosterPositions } : {}),
        ...(Object.keys(positionLimits).length ? { positionLimits } : {}),
      });
      setSleeperMsg(orderKnown
        ? `Connected: ${synced.length} teams found, in draft order. Pick "which team is mine" below, then start syncing picks.`
        : `Connected: ${synced.length} teams found. Your commissioner hasn't set the draft order yet, so these are listed in league order, NOT draft order — "on the clock" and snake order will be wrong until you reconnect after the order is posted. Team names and pick syncing work either way.`);
      onConnected();
    } catch (e) {
      setSleeperMsg(`Could not connect: ${e.message}. You can still use the dashboard manually.`);
    }
  }

  async function importCsv() {
    const text = csvFile ? await csvFile.text() : csvPaste;
    if (!text || !text.trim()) return setCsvMsg('Nothing to import — upload a file or paste CSV text.');
    const { players, warnings } = parseRankingsCsv(text);
    if (players.length === 0) return setCsvMsg(warnings.join(' ') || 'No players found in CSV.');
    St.setPlayers(players.map((p) => Object.assign({}, p, { id: St.nextId('p') })));
    // setPlayers swaps the whole board for freshly-created player objects, none
    // of them drafted — but it leaves `picks` and `pickCounter` alone. Dedupe
    // itself is fine with that: it's keyed on player IDENTITY read off
    // `state.players`, so the next poll would refill the new rankings correctly
    // either way. What's left corrupted is the draft LOG: the old `picks`
    // entries still point at player IDs from the array that just got replaced —
    // orphaned, unrenderable — and pickCounter still holds the old count, so
    // freshly re-imported picks would stack on top of that stale history instead
    // of starting clean. resetDraft clears picks/pickCounter while keeping the
    // rankings just imported and the teams, so the very next poll refills the
    // board against the new player list with a clean log. Sync off = no repair
    // mechanism, so leave the manual draft alone and let the user reset if they
    // want to.
    //
    // Read from the store rather than the destructured `settings`: updateSettings
    // replaces the settings object, so a render-time copy can be one tick stale.
    if (St.getState().settings.sleeperSyncEnabled) {
      clearSuppressed();
      St.resetDraft();
    }
    setCsvMsg(warnings.length
      ? `Imported ${players.length} players. ${warnings.join(' ')}`
      : `Imported ${players.length} players.`);
  }

  function saveTeams() {
    const names = teamNames.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    St.setTeams(names.map((name, idx) => ({
      id: `t${idx}`, name, slot: idx, rosterId: null, userId: null, isMe: false,
    })));
    St.updateSettings({ numTeams: names.length });
  }

  return html`<section class="setup-panel${setupOpen ? '' : ' hidden'}" id="setupPanel">
    <div class="setup-grid">
      <div class="setup-card">
        <h3>League Settings</h3>
        <div class="field">
          <label for="numTeams"># of Teams</label>
          <input type="number" id="numTeams" min="2" max="20" defaultValue=${settings.numTeams}
            onChange=${(e) => St.updateSettings({ numTeams: parseInt(e.target.value, 10) || 10 })} />
        </div>
        <div class="field">
          <label for="rosterSpots">Roster Spots (comma separated, in draft slot order for BN doesn't matter)</label>
          <input type="text" id="rosterSpots" key=${settings.rosterSpots.join(',')}
            defaultValue=${settings.rosterSpots.join(',')}
            placeholder="QB,RB,RB,WR,WR,TE,FLEX,K,DST,BN,BN,BN,BN,BN,BN,BN"
            onChange=${(e) => {
              // normalizePos, not toUpperCase: a hand-typed "DEF" must become
              // DST here because slot matching is exact.
              const spots = e.target.value.split(',').map(normalizePos).filter(Boolean);
              if (spots.length) St.updateSettings({ rosterSpots: spots });
            }} />
          <div class="hint">FLEX = RB/WR/TE. BN = bench (any position).</div>
        </div>
        <div class="field">
          <label for="positionLimits">Position limits (max per position)</label>
          <input type="text" id="positionLimits" key=${formatLimits(settings.positionLimits)}
            defaultValue=${formatLimits(settings.positionLimits)}
            placeholder="QB:3,RB:6,WR:6,TE:3,K:2,DST:3"
            onChange=${(e) => St.updateSettings({ positionLimits: parseLimitsInput(e.target.value) })} />
          <div class="hint">Blank means no limit. Filled in automatically when you sync Sleeper.</div>
        </div>
        <div class="field">
          <label for="scoringNotes">Scoring notes (reference only)</label>
          <input type="text" id="scoringNotes" defaultValue=${settings.scoringNotes}
            onChange=${(e) => St.updateSettings({ scoringNotes: e.target.value })} />
        </div>
      </div>

      <div class="setup-card">
        <h3>Teams & My Slot (manual mode)</h3>
        <div class="field">
          <label for="teamNames">Team names, in draft-slot order (comma separated)</label>
          <textarea id="teamNames" placeholder="Team 1, Team 2, Team 3, ..."
            value=${teamNames} onInput=${(e) => setTeamNames(e.target.value)}></textarea>
        </div>
        <div class="field">
          <label for="myTeamSelect">Which team is mine?</label>
          <select id="myTeamSelect" value=${settings.myTeamId || ''}
            onChange=${(e) => St.updateSettings({ myTeamId: e.target.value })}>
            <option value="">— choose —</option>
            ${teams.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}
          </select>
        </div>
        <button class="btn" id="applyTeamsBtn" onClick=${saveTeams}>Save Teams</button>
      </div>

      <div class="setup-card">
        <h3>Sleeper Live Sync (optional)</h3>
        <div class="field">
          <label for="sleeperLeagueId">Sleeper League ID</label>
          <input type="text" id="sleeperLeagueId" placeholder="e.g. 918856021456789012"
            value=${leagueId} onInput=${(e) => setLeagueId(e.target.value)} />
          <div class="hint">Found in your league's Sleeper URL: ${SLEEPER_URL_HINT}</div>
        </div>
        <button class="btn" id="connectSleeperBtn" onClick=${connectSleeper}>Connect & Sync Teams</button>${' '}
        <button class="btn small" id="disconnectSleeperBtn" onClick=${() => { onDisconnect(); setSleeperMsg('Disconnected. Live sync paused.'); }}>Disconnect</button>
        <div class="hint" id="sleeperConnectMsg">${sleeperMsg}</div>
      </div>

      <div class="setup-card">
        <h3>Import Rankings (CSV)</h3>
        <div class="field">
          <label for="csvFile">Upload a CSV (e.g. FantasyPros export)</label>
          <input type="file" id="csvFile" accept=".csv,text/csv"
            onChange=${(e) => setCsvFile(e.target.files?.[0] || null)} />
        </div>
        <div class="field">
          <label for="csvPaste">...or paste CSV text</label>
          <textarea id="csvPaste" placeholder="Rank,Player Name,Team,Pos,Bye Week,Tier"
            value=${csvPaste} onInput=${(e) => setCsvPaste(e.target.value)}></textarea>
        </div>
        <button class="btn primary" id="importCsvBtn" onClick=${importCsv}>Import Rankings</button>
        <div class="warning-list" id="csvWarnings">${csvMsg}</div>
      </div>

      <div class="setup-card">
        <h3>Danger Zone</h3>
        <button class="btn danger" id="resetDraftBtn" onClick=${() => {
          // clearSuppressed before every reset: an undone pick must not stay
          // suppressed across a reset, or it would never re-import and the board
          // would come back one pick short with nothing to explain it.
          if (confirm('Reset the draft? This clears drafted status and pick history but keeps your rankings and teams.')) {
            clearSuppressed();
            St.resetDraft();
          }
        }}>Reset Draft (keep rankings & teams)</button>
        <br /><br />
        <button class="btn danger" id="resetAllBtn" onClick=${() => {
          if (confirm('Reset EVERYTHING (teams, rankings, draft progress, Sleeper connection)? This cannot be undone.')) {
            onDisconnect();
            clearSuppressed();
            St.resetAll();
          }
        }}>Reset Everything</button>
      </div>
    </div>
  </section>`;
}
