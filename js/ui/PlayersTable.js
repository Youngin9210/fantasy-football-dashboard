import { html } from '../vendor/preact.js';
import * as St from '../state.js';
import { rosterState, recommendOrder } from '../recommend.js';
import { FLEX_ELIGIBLE } from '../positions.js';
import { useStore } from './useStore.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'DST', 'K'];

function filteredPlayers(players, filter, search) {
  let list = players.slice().sort((a, b) => {
    const ra = a.rank == null ? Infinity : a.rank;
    const rb = b.rank == null ? Infinity : b.rank;
    return ra - rb;
  });
  if (filter !== 'ALL') {
    list = filter === 'FLEX'
      ? list.filter((p) => FLEX_ELIGIBLE.includes(p.pos))
      // The 'DEF' arm is back-compat: boards imported before DST
      // canonicalization still carry raw DEF in saved state.
      : list.filter((p) => p.pos === filter || (filter === 'DST' && p.pos === 'DEF'));
  }
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase().includes(q));
  }
  return list;
}

function whyClass(reason) {
  if (reason.includes('LIMIT')) return 'limit';
  if (reason === 'WAIT') return 'wait';
  if (reason.startsWith('FILLS')) return 'fills';
  return '';
}

function PlayerRow({ entry, teams, draftForId, tierStart }) {
  const { player: p, reason, excluded } = entry;
  const teamName = p.draftedByTeamId
    ? (teams.find((t) => t.id === p.draftedByTeamId)?.name || 'Unknown')
    : '';
  const cls = [tierStart ? 'tier-start' : '', p.drafted ? 'drafted' : '', excluded ? 'limit-excluded' : '']
    .filter(Boolean).join(' ');

  return html`<tr class=${cls}>
    <td>${p.rank ?? '—'}${p.tier ? html`<span class="badge-unranked">T${p.tier}</span>` : null}</td>
    <td><span class="player-name">${p.name}</span>${p.source === 'manual' ? html`<span class="badge-unranked">unranked</span>` : null}</td>
    <td>${p.pos ? html`<span class="pos-badge ${p.pos}">${p.pos}</span>` : null}</td>
    <td class="player-meta">${p.team || ''}</td>
    <td class="player-meta">${p.bye ?? ''}</td>
    <td class="player-meta">${p.adp ?? ''}</td>
    <td>${reason ? html`<span class="why-badge ${whyClass(reason)}">${reason}</span>` : null}</td>
    <td class="drafted-by">${p.drafted ? `#${p.pickNo} · ${teamName}` : ''}</td>
    <td>${p.drafted
      ? html`<button class="btn small danger" onClick=${() => St.undraftPlayer(p.id)}>✕</button>`
      : html`<button class="btn small primary" onClick=${() => St.draftPlayer(p.id, draftForId || null)}>Draft</button>`}</td>
  </tr>`;
}

export function PlayersTable({ filter, search, onFilter, onSearch, draftForId, onDraftFor }) {
  const { settings, teams, players } = useStore();
  const list = filteredPlayers(players, filter, search);

  const useNeed = settings.sortMode === 'need';
  // Recommendations need a roster to reason about; without a chosen team this
  // falls back to plain rank order.
  const recommending = useNeed && settings.myTeamId;

  let scored;
  if (recommending) {
    const mine = players
      .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
      .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
    const state = rosterState(settings.rosterSpots, mine);
    const ranked = recommendOrder(list.filter((p) => !p.drafted), state, settings.positionLimits);
    const drafted = list.filter((p) => p.drafted).map((player) => ({ player, reason: '', excluded: false }));
    // Drafted rows go BEFORE the excluded group so they never appear under the
    // "At position limit" divider, which would imply they are at a limit.
    scored = ranked.filter((e) => !e.excluded).concat(drafted, ranked.filter((e) => e.excluded));
  } else {
    scored = list.map((player) => ({ player, reason: '', excluded: false }));
  }

  let lastTier;
  let dividerShown = false;
  const rows = [];
  for (const entry of scored) {
    if (entry.excluded && !dividerShown) {
      dividerShown = true;
      rows.push(html`<tr key="limit-divider" class="limit-divider"><td colspan="9">At position limit</td></tr>`);
    }
    // Tier dividers only mean something in plain rank order.
    const tierStart = !recommending && entry.player.tier != null && entry.player.tier !== lastTier;
    lastTier = entry.player.tier;
    rows.push(html`<${PlayerRow} key=${entry.player.id} entry=${entry} teams=${teams}
      draftForId=${draftForId} tierStart=${tierStart} />`);
  }

  return html`<section class="panel">
    <div class="controls">
      <input id="searchBox" placeholder="Search players…" value=${search}
        onInput=${(e) => onSearch(e.target.value)} />
      <div class="sort-toggle">
        <button class="btn small ${!useNeed ? 'active' : ''}"
          onClick=${() => St.updateSettings({ sortMode: 'rank' })}>By rank</button>
        <button class="btn small ${useNeed ? 'active' : ''}"
          onClick=${() => St.updateSettings({ sortMode: 'need' })}>Best for my roster</button>
      </div>
      <div class="pos-filters">
        ${POSITIONS.map((pos) => html`<button class="pos-filter-btn ${pos === filter ? 'active' : ''}"
          onClick=${() => onFilter(pos)}>${pos}</button>`)}
      </div>
      <span style="flex:none; display:flex; align-items:center; gap:6px;">
        <label class="hint" style="margin:0;">Draft pick for:</label>
        <select class="team-select" value=${draftForId} onChange=${(e) => onDraftFor(e.target.value)}>
          ${teams.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}
        </select>
      </span>
    </div>
    <div class="table-wrap">
      <table class="players">
        <thead><tr>
          <th>Rank</th><th>Player</th><th>Pos</th><th>Team</th>
          <th>Bye</th><th>ADP</th><th>Why</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${useNeed && !settings.myTeamId
            ? html`<tr class="need-notice"><td colspan="9">Pick which team is yours in Setup to enable recommendations — showing plain rank order.</td></tr>`
            : null}
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}
