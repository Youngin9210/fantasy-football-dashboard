// CSV parsing + flexible rankings import (FantasyPros export or custom CSV).

import { normalizePos } from './positions.js';

// Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/quotes/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_ALIASES = {
  rank: ['rk', 'rank', 'overall rank', 'ecr'],
  tier: ['tiers', 'tier'],
  name: ['player name', 'name', 'player', 'player_name'],
  team: ['team', 'tm'],
  pos: ['pos', 'position'],
  bye: ['bye week', 'bye'],
  adp: ['adp', 'avg pick', 'average pick'],
  ecrVsAdp: ['ecr vs. adp', 'ecr vs adp'],
};

function normalizeHeader(h) {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchColumn(headers) {
  const map = {};
  const normalized = headers.map(normalizeHeader);
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.findIndex((h) => h === alias);
      if (idx !== -1) {
        map[key] = idx;
        break;
      }
    }
  }
  return map;
}

function cleanBye(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// The market gap: how far a player's expert consensus rank sits from where he is
// actually drafted. Negative means drafted EARLIER than ranked.
//
// Shape-tested rather than coerced, deliberately. Number("") is 0, not NaN, so
// coercion cannot distinguish an empty cell from a genuine zero -- and 0 is a
// real value here ("drafted exactly on rank"). The neighbouring `adp` field uses
// `parseFloat(...) || null`, which destroys a zero; that is harmless for a pick
// number and would be a silent wrong answer for this one.
function cleanMarketGap(raw) {
  const s = String(raw ?? '').trim();
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

// Parses rankings CSV text into an array of player objects (unassigned ids/drafted state).
// Returns { players, warnings }.
function parseRankingsCsv(text) {
  const rows = parseCsv(text);
  const warnings = [];
  if (rows.length === 0) return { players: [], warnings: ['CSV appears empty.'] };

  const headers = rows[0];
  const colMap = matchColumn(headers);

  if (colMap.name === undefined) {
    warnings.push('Could not find a player name column — expected a header like "Player Name" or "Name".');
    return { players: [], warnings };
  }

  const players = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[colMap.name] || '').trim();
    if (!name) continue;

    const rank = colMap.rank !== undefined ? parseInt(r[colMap.rank], 10) : i;
    players.push({
      rank: Number.isFinite(rank) ? rank : i,
      tier: colMap.tier !== undefined ? (parseInt(r[colMap.tier], 10) || r[colMap.tier] || null) : null,
      name,
      team: colMap.team !== undefined ? (r[colMap.team] || '').trim().toUpperCase() : '',
      pos: colMap.pos !== undefined ? normalizePos(r[colMap.pos]) : '',
      bye: colMap.bye !== undefined ? cleanBye(r[colMap.bye]) : null,
      adp: colMap.adp !== undefined ? parseFloat(r[colMap.adp]) || null : null,
      ecrVsAdp: colMap.ecrVsAdp !== undefined ? cleanMarketGap(r[colMap.ecrVsAdp]) : null,
      drafted: false,
      draftedByTeamId: null,
      pickNo: null,
      source: 'csv',
    });
  }

  if (colMap.pos === undefined) {
    warnings.push('No position column found — filtering by position (QB/RB/WR/TE/etc.) will not work until you add one.');
  }

  if (colMap.ecrVsAdp === undefined) {
    warnings.push('No market column found — the Value column and the Glance market line will stay blank until you add an "ECR VS. ADP" column.');
  }

  // Re-rank sequentially if rank column was missing or unreliable, preserving CSV order.
  if (colMap.rank === undefined) {
    players.forEach((p, idx) => (p.rank = idx + 1));
  }

  return { players, warnings };
}

export { parseCsv, parseRankingsCsv };
