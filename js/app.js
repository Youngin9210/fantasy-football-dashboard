import * as St from './state.js';
import { parseRankingsCsv } from './csv.js';
import * as Sleeper from './sleeper.js';
import { pickToSlotIndex, pickToRound, nextPickForSlot, assignRosterSlots, computeNeeds } from './draft.js';
import { rosterState, recommendOrder } from './recommend.js';
import { normalizePos } from './positions.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'DST', 'K'];
const FLEX_POS = ['RB', 'WR', 'TE'];

// "QB:3,RB:6" -> {QB: 3, RB: 6}. Tolerates spaces and trailing commas.
function parseLimitsInput(text) {
  const limits = {};
  for (const part of String(text || '').split(',')) {
    const [pos, max] = part.split(':').map((x) => (x || '').trim().toUpperCase());
    const n = parseInt(max, 10);
    if (pos && Number.isFinite(n) && n > 0) limits[pos] = n;
  }
  return limits;
}

function formatLimits(limits) {
  return Object.entries(limits || {}).map(([pos, max]) => `${pos}:${max}`).join(',');
}

let currentFilter = 'ALL';
let currentSearch = '';
let stopPolling = null;
let processedPickNos = new Set();

// ---------- Theme ----------
function initTheme() {
  const saved = localStorage.getItem('ffTheme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ffTheme', next);
  });
}

// ---------- Setup panel ----------
function initSetupPanel() {
  const panel = document.getElementById('setupPanel');
  document.getElementById('settingsBtn').addEventListener('click', () => {
    panel.classList.toggle('hidden');
  });

  const s = St.getState().settings;
  document.getElementById('numTeams').value = s.numTeams;
  document.getElementById('rosterSpots').value = s.rosterSpots.join(',');
  document.getElementById('positionLimits').value = formatLimits(s.positionLimits);
  document.getElementById('scoringNotes').value = s.scoringNotes;
  document.getElementById('sleeperLeagueId').value = s.sleeperLeagueId;

  document.getElementById('numTeams').addEventListener('change', (e) => {
    St.updateSettings({ numTeams: parseInt(e.target.value, 10) || 10 });
  });
  document.getElementById('rosterSpots').addEventListener('change', (e) => {
    // normalizePos, not toUpperCase: a hand-typed "DEF" or "D/ST" must become
    // DST here for the same reason Sleeper's roster_positions does — slot
    // matching is exact, so a DEF slot would silently never fill.
    const spots = e.target.value.split(',').map(normalizePos).filter(Boolean);
    if (spots.length) St.updateSettings({ rosterSpots: spots });
  });
  document.getElementById('positionLimits').addEventListener('change', (e) => {
    St.updateSettings({ positionLimits: parseLimitsInput(e.target.value) });
  });
  document.getElementById('scoringNotes').addEventListener('change', (e) => {
    St.updateSettings({ scoringNotes: e.target.value });
  });

  document.getElementById('applyTeamsBtn').addEventListener('click', () => {
    const names = document.getElementById('teamNames').value.split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    const teams = names.map((name, idx) => ({
      id: `t${idx}`,
      name,
      slot: idx,
      rosterId: null,
      userId: null,
      isMe: false,
    }));
    St.setTeams(teams);
    St.updateSettings({ numTeams: teams.length });
    const myId = document.getElementById('myTeamSelect').value;
    if (myId) St.updateSettings({ myTeamId: myId });
  });

  document.getElementById('myTeamSelect').addEventListener('change', (e) => {
    St.updateSettings({ myTeamId: e.target.value });
  });

  document.getElementById('connectSleeperBtn').addEventListener('click', async () => {
    const leagueId = document.getElementById('sleeperLeagueId').value.trim();
    const msg = document.getElementById('sleeperConnectMsg');
    if (!leagueId) {
      msg.textContent = 'Enter a Sleeper league ID first.';
      return;
    }
    msg.textContent = 'Connecting…';
    try {
      const { draft, teams, orderKnown, rosterPositions, positionLimits } =
        await Sleeper.connectLeague(leagueId);
      St.setTeams(teams);
      St.updateSettings({
        numTeams: teams.length,
        sleeperLeagueId: leagueId,
        sleeperDraftId: draft.draft_id,
        sleeperSyncEnabled: true,
        // Only overwrite when Sleeper actually returned something, so a sparse
        // league response never wipes a hand-entered roster.
        ...(rosterPositions.length ? { rosterSpots: rosterPositions } : {}),
        ...(Object.keys(positionLimits).length ? { positionLimits } : {}),
      });
      document.getElementById('rosterSpots').value = St.getState().settings.rosterSpots.join(',');
      document.getElementById('positionLimits').value = formatLimits(St.getState().settings.positionLimits);
      msg.textContent = orderKnown
        ? `Connected: ${teams.length} teams found, in draft order. Pick "which team is mine" below, then start syncing picks.`
        : `Connected: ${teams.length} teams found. Your commissioner hasn't set the draft order yet, so these are listed in league order, NOT draft order — "on the clock" and snake order will be wrong until you reconnect after the order is posted. Team names and pick syncing work either way.`;
      startSleeperPolling();
    } catch (e) {
      msg.textContent = `Could not connect: ${e.message}. You can still use the dashboard manually.`;
    }
  });

  document.getElementById('disconnectSleeperBtn').addEventListener('click', () => {
    if (stopPolling) stopPolling();
    stopPolling = null;
    St.updateSettings({ sleeperSyncEnabled: false });
    document.getElementById('sleeperConnectMsg').textContent = 'Disconnected. Live sync paused.';
  });

  document.getElementById('importCsvBtn').addEventListener('click', async () => {
    const fileInput = document.getElementById('csvFile');
    const warningsEl = document.getElementById('csvWarnings');
    let text = document.getElementById('csvPaste').value;
    if (fileInput.files && fileInput.files[0]) {
      text = await fileInput.files[0].text();
    }
    if (!text || !text.trim()) {
      warningsEl.textContent = 'Nothing to import — upload a file or paste CSV text.';
      return;
    }
    const { players, warnings } = parseRankingsCsv(text);
    if (players.length === 0) {
      warningsEl.textContent = warnings.join(' ') || 'No players found in CSV.';
      return;
    }
    const withIds = players.map((p) => Object.assign({}, p, { id: St.nextId('p') }));
    St.setPlayers(withIds);
    processedPickNos = new Set();
    warningsEl.textContent = warnings.length
      ? `Imported ${players.length} players. ${warnings.join(' ')}`
      : `Imported ${players.length} players.`;
  });

  document.getElementById('resetDraftBtn').addEventListener('click', () => {
    if (confirm('Reset the draft? This clears drafted status and pick history but keeps your rankings and teams.')) {
      processedPickNos = new Set();
      St.getState().players.forEach((p) => {
        p.drafted = false;
        p.draftedByTeamId = null;
        p.pickNo = null;
      });
      St.resetDraft();
    }
  });

  document.getElementById('resetAllBtn').addEventListener('click', () => {
    if (confirm('Reset EVERYTHING (teams, rankings, draft progress, Sleeper connection)? This cannot be undone.')) {
      if (stopPolling) stopPolling();
      stopPolling = null;
      processedPickNos = new Set();
      St.resetAll();
    }
  });
}

function initSortToggle() {
  document.getElementById('sortToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    St.updateSettings({ sortMode: btn.getAttribute('data-sort') });
  });
}

// ---------- Sleeper sync ----------
function startSleeperPolling() {
  if (stopPolling) stopPolling();
  const draftId = St.getState().settings.sleeperDraftId;
  if (!draftId) return;
  processedPickNos = new Set(St.getState().picks.map((p) => p.pickNo));

  stopPolling = Sleeper.startPolling(
    draftId,
    (picks) => {
      const sorted = picks.slice().sort((a, b) => a.pick_no - b.pick_no);
      for (const pick of sorted) {
        if (!pick.player_id) continue; // empty slot not yet picked
        if (processedPickNos.has(pick.pick_no)) continue;
        processedPickNos.add(pick.pick_no);

        const teams = St.getState().teams;
        const team = teams.find((t) => t.rosterId === pick.roster_id) || null;
        const teamId = team ? team.id : null;

        const players = St.getState().players;
        let matched = Sleeper.matchPickToPlayer(pick, players);
        if (!matched) {
          matched = St.addManualPlayer(Sleeper.pickToManualPlayer(pick));
        }
        St.draftPlayer(matched.id, teamId, pick.pick_no);
      }
    },
    (status) => renderSyncStatus(status)
  );
}

function renderSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  const enabled = St.getState().settings.sleeperSyncEnabled;
  if (!enabled) {
    el.innerHTML = '';
    return;
  }
  const dotClass = status.ok ? 'ok' : 'error';
  const label = status.ok ? 'Sleeper synced' : `Sleeper sync error: ${status.error}`;
  el.innerHTML = `<span class="sync-dot ${dotClass}"></span><span>${label}</span>`;
}

// ---------- Rendering ----------
function populatePosFilters() {
  const el = document.getElementById('posFilters');
  el.innerHTML = '';
  for (const pos of POSITIONS) {
    const btn = document.createElement('button');
    btn.className = 'pos-filter-btn' + (pos === currentFilter ? ' active' : '');
    btn.textContent = pos;
    btn.addEventListener('click', () => {
      currentFilter = pos;
      render();
    });
    el.appendChild(btn);
  }
}

function onClockTeamId() {
  const { settings, teams, pickCounter } = St.getState();
  if (teams.length === 0) return null;
  const slotIndex = pickToSlotIndex(pickCounter + 1, settings.numTeams);
  const team = teams.find((t) => t.slot === slotIndex);
  return team ? team.id : null;
}

// The "Draft pick for" selector always defaults to whoever is actually on the
// clock (recomputed after every pick), so clicking Draft repeatedly walks
// through the real draft order instead of silently assigning every pick to
// the same team. Users can still override it for a single out-of-order pick.
function populateTeamSelects() {
  const teams = St.getState().teams;
  const myTeamId = St.getState().settings.myTeamId;
  const onClock = onClockTeamId();

  const myTeamSelect = document.getElementById('myTeamSelect');
  const draftForSelect = document.getElementById('draftForSelect');

  myTeamSelect.innerHTML = '<option value="">— choose —</option>' +
    teams.map((t) => `<option value="${t.id}" ${t.id === myTeamId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('');

  draftForSelect.innerHTML = teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (onClock) draftForSelect.value = onClock;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function filteredPlayers() {
  const { players } = St.getState();
  let list = players.slice().sort((a, b) => {
    const ra = a.rank == null ? Infinity : a.rank;
    const rb = b.rank == null ? Infinity : b.rank;
    return ra - rb;
  });
  if (currentFilter !== 'ALL') {
    if (currentFilter === 'FLEX') {
      list = list.filter((p) => FLEX_POS.includes(p.pos));
    } else {
      list = list.filter((p) => p.pos === currentFilter || (currentFilter === 'DST' && p.pos === 'DEF'));
    }
  }
  if (currentSearch.trim()) {
    const q = currentSearch.trim().toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q));
  }
  return list;
}

function renderPlayersBody() {
  const tbody = document.getElementById('playersBody');
  const { settings, teams, players } = St.getState();
  const list = filteredPlayers();

  const useNeed = settings.sortMode === 'need';
  document.querySelectorAll('#sortToggle [data-sort]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sort') === (useNeed ? 'need' : 'rank'));
  });

  // Recommendations only make sense once we know whose roster to build, so
  // without a chosen team this falls back to plain rank order.
  let scored;
  if (useNeed && settings.myTeamId) {
    const mine = players
      .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
      .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
    const state = rosterState(settings.rosterSpots, mine);
    scored = recommendOrder(list.filter((p) => !p.drafted), state, settings.positionLimits)
      .concat(list.filter((p) => p.drafted).map((player) => ({ player, reason: '', excluded: false })));
  } else {
    scored = list.map((player) => ({ player, reason: '', excluded: false }));
  }

  let lastTier = undefined;
  let dividerShown = false;

  tbody.innerHTML = scored
    .map(({ player: p, reason, excluded }) => {
      // Tier dividers are suppressed in need mode: they only mean something
      // when the board is in rank order.
      const tierStart = !useNeed && p.tier !== undefined && p.tier !== null && p.tier !== lastTier;
      lastTier = p.tier;
      const teamName = p.draftedByTeamId ? (teams.find((t) => t.id === p.draftedByTeamId)?.name || 'Unknown') : '';
      const rowClasses = [
        tierStart ? 'tier-start' : '',
        p.drafted ? 'drafted' : '',
        excluded ? 'limit-excluded' : '',
      ].filter(Boolean).join(' ');
      const actionCell = p.drafted
        ? `<button class="btn small danger" data-undraft="${p.id}">✕</button>`
        : `<button class="btn small primary" data-draft="${p.id}">Draft</button>`;

      let divider = '';
      if (excluded && !dividerShown) {
        dividerShown = true;
        divider = '<tr class="limit-divider"><td colspan="9">At position limit</td></tr>';
      }

      const whyClass = reason.includes('LIMIT') ? 'limit'
        : reason === 'WAIT' ? 'wait'
        : reason.startsWith('FILLS') ? 'fills' : '';
      const whyCell = reason ? `<span class="why-badge ${whyClass}">${escapeHtml(reason)}</span>` : '';

      return `${divider}<tr class="${rowClasses}">
        <td>${p.rank ?? '—'}${p.tier ? `<span class="badge-unranked">T${p.tier}</span>` : ''}</td>
        <td><span class="player-name">${escapeHtml(p.name)}</span>${p.source === 'manual' ? '<span class="badge-unranked">unranked</span>' : ''}</td>
        <td>${p.pos ? `<span class="pos-badge ${p.pos}">${p.pos}</span>` : ''}</td>
        <td class="player-meta">${escapeHtml(p.team || '')}</td>
        <td class="player-meta">${p.bye ?? ''}</td>
        <td class="player-meta">${p.adp ?? ''}</td>
        <td>${whyCell}</td>
        <td class="drafted-by">${p.drafted ? `#${p.pickNo} · ${escapeHtml(teamName)}` : ''}</td>
        <td>${actionCell}</td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-draft]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const teamId = document.getElementById('draftForSelect').value || null;
      St.draftPlayer(btn.getAttribute('data-draft'), teamId);
    });
  });
  tbody.querySelectorAll('[data-undraft]').forEach((btn) => {
    btn.addEventListener('click', () => {
      St.undraftPlayer(btn.getAttribute('data-undraft'));
    });
  });
}

function renderClockWidget() {
  const el = document.getElementById('clockWidget');
  const { settings, teams, pickCounter } = St.getState();
  if (teams.length === 0) {
    el.innerHTML = '<span class="clock-pill">Set up teams to see draft order</span>';
    return;
  }
  const nextPickNo = pickCounter + 1;
  const slotIndex = pickToSlotIndex(nextPickNo, settings.numTeams);
  const round = pickToRound(nextPickNo, settings.numTeams);
  const onClockTeam = teams.find((t) => t.slot === slotIndex);
  const myTeam = teams.find((t) => t.id === settings.myTeamId);

  let turnPill = '';
  if (myTeam) {
    const nextMine = nextPickForSlot(nextPickNo, myTeam.slot, settings.numTeams);
    const picksUntil = nextMine - nextPickNo;
    turnPill = picksUntil === 0
      ? `<span class="clock-pill my-turn">YOU'RE UP</span>`
      : `<span class="clock-pill">${picksUntil} pick${picksUntil === 1 ? '' : 's'} until your turn</span>`;
  }

  el.innerHTML = `<span class="clock-pill">Pick ${nextPickNo} · Rd ${round} · On the clock: <strong>${escapeHtml(onClockTeam ? onClockTeam.name : '—')}</strong></span>${turnPill}`;
}

function renderRosterPanel() {
  const { settings, teams, players } = St.getState();
  const myTeam = teams.find((t) => t.id === settings.myTeamId);
  document.getElementById('myTeamName').textContent = myTeam ? `— ${myTeam.name}` : '';

  const myPlayers = players
    .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
    .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));

  const { slots } = assignRosterSlots(settings.rosterSpots, myPlayers);
  const list = document.getElementById('rosterList');
  list.innerHTML = slots
    .map((s) => `<li><span class="slot-label">${s.label}</span>${
      s.player
        ? `<span class="pos-badge ${s.player.pos}">${s.player.pos}</span> ${escapeHtml(s.player.name)}`
        : '<span class="slot-empty">empty</span>'
    }</li>`)
    .join('');

  const needs = computeNeeds(slots);
  const needsRow = document.getElementById('needsRow');
  const needKeys = Object.keys(needs);
  needsRow.innerHTML = needKeys.length
    ? 'Needs: ' + needKeys.map((k) => `<span class="pos-badge ${k}">${k}</span>×${needs[k]}`).join(' ')
    : 'All starting spots filled.';
}

function renderDraftLog() {
  const { picks, teams, players } = St.getState();
  const el = document.getElementById('draftLog');
  const ordered = picks.slice().sort((a, b) => b.pickNo - a.pickNo);
  el.innerHTML = ordered
    .map((pk) => {
      const player = players.find((p) => p.id === pk.playerId);
      const team = teams.find((t) => t.id === pk.teamId);
      return `<li><span>#${pk.pickNo} ${escapeHtml(player ? player.name : pk.rawName)}</span><span class="player-meta">${escapeHtml(team ? team.name : '—')}</span></li>`;
    })
    .join('');
}

function render() {
  populatePosFilters();
  populateTeamSelects();
  renderPlayersBody();
  renderClockWidget();
  renderRosterPanel();
  renderDraftLog();
  renderSyncStatus({ ok: true });
}

// ---------- Init ----------
function init() {
  initTheme();
  initSetupPanel();
  initSortToggle();

  document.getElementById('searchBox').addEventListener('input', (e) => {
    currentSearch = e.target.value;
    render();
  });
  document.getElementById('undoBtn').addEventListener('click', () => St.undoLastPick());

  St.onChange(render);

  const s = St.getState().settings;
  if (s.sleeperSyncEnabled && s.sleeperDraftId) {
    startSleeperPolling();
  }
  if (St.getState().players.length === 0 && St.getState().teams.length === 0) {
    document.getElementById('setupPanel').classList.remove('hidden');
  }

  processedPickNos = new Set(St.getState().picks.map((p) => p.pickNo));
  render();
}

init();
