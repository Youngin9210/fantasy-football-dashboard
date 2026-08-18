import { html } from '../vendor/preact.js';
import * as St from '../state.js';
import { rosterState, recommendOrder } from '../recommend.js';
import { FLEX_ELIGIBLE } from '../positions.js';
import { useStore } from './useStore.js';
import { suppressPlayer } from './useSleeperSync.js';
import { marketNote } from './market.js';

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
  const { player: p, reason, excluded, byeWarning } = entry;
  const teamName = p.draftedByTeamId
    ? (teams.find((t) => t.id === p.draftedByTeamId)?.name || 'Unknown')
    : '';
  const cls = [tierStart ? 'tier-start' : '', p.drafted ? 'drafted' : '', excluded ? 'limit-excluded' : '']
    .filter(Boolean).join(' ');
  // The Value column. marketNote owns the wording AND the direction: it returns
  // null when there is no gap to report (rank 400+ ships a literal "-"), and its
  // `short` already names the direction in words ("10 early" / "11 late"), so the
  // raw sign of p.ecrVsAdp is never printed. One column, one convention —
  // flagged and unflagged rows read identically and only the emphasis differs.
  const market = marketNote(p.ecrVsAdp);

  // The WHY cell carries up to two badges. The explicit ${' '} between them is
  // load-bearing: htm drops whitespace-only text nodes, so they would otherwise
  // render flush against each other. byeWarning is printed verbatim (its
  // separator is U+00D7, not the letter x) rather than rebuilt here, so the
  // Board and Glance can never word the same conflict differently.
  return html`<tr class=${cls}>
    <td>${p.rank ?? '—'}${p.tier ? html`<span class="badge-unranked">T${p.tier}</span>` : null}</td>
    <td><span class="player-name">${p.name}</span>${p.source === 'manual' ? html`<span class="badge-unranked">unranked</span>` : null}</td>
    <td>${p.pos ? html`<span class="pos-badge ${p.pos}">${p.pos}</span>` : null}</td>
    <td class="player-meta">${p.team || ''}</td>
    <td class="player-meta">${p.bye ?? ''}</td>
    <td class="player-meta">${market
      // The class picks the emphasis, never the wording. It is only ever reached
      // when market.flagged, i.e. |gap| >= 8, so the signed-zero hole in this
      // comparison (`-0 < 0` is false, so a -0 would land in 'late') is
      // unreachable: marketNote returns 'on rank', flagged:false, for -0. A
      // future change that badges unflagged values must take the direction from
      // marketNote rather than re-deriving it here.
      //
      // Unflagged text is wrapped in .market-plain rather than left as a bare
      // string: .player-meta's own color (--text-muted) measures 3.50:1 on the
      // light panel (--surface-1), below the 4.5:1 AA floor -- and unflagged is
      // the common case (~78% of rows on the owner's own board), so most of the
      // column would fail. .market-plain overrides to --text-secondary
      // (7.73:1 light, 9.72:1 dark; recomputed via WCAG relative luminance, not
      // assumed). Board-owner decision: fix this column only, not
      // --text-muted/.player-meta stylesheet-wide, so Value now reads slightly
      // darker than Team/Bye beside it -- intentional, it carries the new
      // meaning.
      ? (market.flagged
          ? html`<span class="market-badge ${p.ecrVsAdp < 0 ? 'early' : 'late'}">${market.short}</span>`
          : html`<span class="market-plain">${market.short}</span>`)
      : ''}</td>
    <td>${reason ? html`<span class="why-badge ${whyClass(reason)}">${reason}</span>` : null}${
      byeWarning ? html`${' '}<span class="why-badge bye">${byeWarning}</span>` : null}</td>
    <td class="drafted-by">${p.drafted ? `#${p.pickNo} · ${teamName}` : ''}</td>
    <td>${p.drafted
      ? html`<button class="btn small danger" data-undraft=${p.id} onClick=${() => {
          // Record who is coming off the board before undrafting, or a live
          // Sleeper sync re-imports him on its next tick. Suppression is keyed
          // on the player, not on p.pickNo: this row may be a MANUAL pick, and
          // its number is one Sleeper is free to use for somebody else.
          suppressPlayer(p);
          St.undraftPlayer(p.id);
        }}>✕</button>`
      : html`<button class="btn small primary" data-draft=${p.id} onClick=${() => St.draftPlayer(p.id, draftForId || null)}>Draft</button>`}</td>
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

  // The table is 9 columns and must stay 9: the limit divider above and the
  // need notice below both use colspan="9". The market signal therefore REPLACES
  // the old ADP header rather than adding a tenth column -- ADP is empty on every
  // row of this CSV (FantasyPros ships the difference, not the raw figure), and
  // this table only just stopped overflowing a phone viewport.
  return html`<section class="panel">
    <div class="controls">
      <input id="searchBox" placeholder="Search players…" value=${search}
        onInput=${(e) => onSearch(e.target.value)} />
      <div class="sort-toggle" id="sortToggle">
        <button class="btn small ${!useNeed ? 'active' : ''}" data-sort="rank"
          onClick=${() => St.updateSettings({ sortMode: 'rank' })}>By rank</button>
        <button class="btn small ${useNeed ? 'active' : ''}" data-sort="need"
          onClick=${() => St.updateSettings({ sortMode: 'need' })}>Best for my roster</button>
      </div>
      <div class="pos-filters" id="posFilters">
        ${POSITIONS.map((pos) => html`<button class="pos-filter-btn ${pos === filter ? 'active' : ''}"
          onClick=${() => onFilter(pos)}>${pos}</button>`)}
      </div>
      <span style="flex:none; display:flex; align-items:center; gap:6px;">
        <label class="hint" style="margin:0;">Draft pick for:</label>
        <select class="team-select" id="draftForSelect" value=${draftForId} onChange=${(e) => onDraftFor(e.target.value)}>
          ${teams.map((t) => html`<option key=${t.id} value=${t.id}>${t.name}</option>`)}
        </select>
      </span>
    </div>
    <div class="table-wrap">
      <table class="players">
        <thead><tr>
          <th>Rank</th><th>Player</th><th>Pos</th><th>Team</th>
          <th>Bye</th><th>Value</th><th>Why</th><th>Status</th><th></th>
        </tr></thead>
        <tbody id="playersBody">
          ${useNeed && !settings.myTeamId
            ? html`<tr class="need-notice"><td colspan="9">Pick which team is yours in Setup to enable recommendations — showing plain rank order.</td></tr>`
            : null}
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}
