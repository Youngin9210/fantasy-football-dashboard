// Sleeper API integration (public, read-only, no auth required).
// Docs: https://docs.sleeper.com/

import { normalizePos } from './positions.js';

const BASE = 'https://api.sleeper.app/v1';

// Sleeper exposes per-position roster caps as flat settings keys. Defense is
// keyed as `def` there but canonicalized to DST everywhere in this app.
const POSITION_LIMIT_KEYS = {
  position_limit_qb: 'QB',
  position_limit_rb: 'RB',
  position_limit_wr: 'WR',
  position_limit_te: 'TE',
  position_limit_k: 'K',
  position_limit_def: 'DST',
};

function parsePositionLimits(settings = {}) {
  const limits = {};
  for (const [key, pos] of Object.entries(POSITION_LIMIT_KEYS)) {
    const value = settings[key];
    if (typeof value === 'number' && value > 0) limits[pos] = value;
  }
  return limits;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API ${res.status} for ${url}`);
  return res.json();
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetches league + users + rosters + the current draft, and builds a
// slot-ordered team list compatible with state.teams.
async function connectLeague(leagueId) {
  const [league, users, rosters, drafts] = await Promise.all([
    getJson(`${BASE}/league/${leagueId}`),
    getJson(`${BASE}/league/${leagueId}/users`),
    getJson(`${BASE}/league/${leagueId}/rosters`),
    getJson(`${BASE}/league/${leagueId}/drafts`),
  ]);

  if (!drafts || drafts.length === 0) {
    throw new Error('No draft found for this league yet.');
  }
  const draft = drafts[0];

  const userById = new Map(users.map((u) => [u.user_id, u]));
  const rosterByOwner = new Map(rosters.map((r) => [r.owner_id, r]));

  const draftOrder = draft.draft_order || {}; // { user_id: slot(1-based) }
  const numTeams = draft.settings?.teams || league.total_rosters || users.length;

  // Sleeper leaves draft_order null until the commissioner sets/randomizes the
  // order — often not until shortly before the draft. Without it we can't know
  // who picks where, but we can still show real team names (in roster order) so
  // you can identify your team. Callers should re-sync once the order is set.
  const orderKnown = Object.keys(draftOrder).length > 0;

  const teamName = (user, slot) =>
    user?.metadata?.team_name || user?.display_name || `Team ${slot}`;

  const teams = [];
  if (orderKnown) {
    for (let slot = 1; slot <= numTeams; slot++) {
      const userId = Object.keys(draftOrder).find((uid) => draftOrder[uid] === slot);
      const user = userId ? userById.get(userId) : null;
      const roster = userId ? rosterByOwner.get(userId) : null;
      teams.push({
        id: roster ? `r${roster.roster_id}` : `slot${slot}`,
        name: teamName(user, slot),
        slot: slot - 1, // 0-based
        rosterId: roster ? roster.roster_id : null,
        userId: userId || null,
        isMe: false,
      });
    }
  } else {
    // Provisional: real names, ordered by roster_id (stable and matches how
    // Sleeper lists the league), with slots filled in once the order exists.
    const byRosterId = [...rosters].sort((a, b) => a.roster_id - b.roster_id);
    byRosterId.forEach((roster, i) => {
      const user = userById.get(roster.owner_id);
      teams.push({
        id: `r${roster.roster_id}`,
        name: teamName(user, i + 1),
        slot: i, // provisional — real slot unknown until draft_order is set
        rosterId: roster.roster_id,
        userId: roster.owner_id || null,
        isMe: false,
      });
    });
  }

  const rosterPositions = (league.roster_positions || []).map(normalizePos);
  const positionLimits = parsePositionLimits(league.settings);

  return { league, draft, teams, orderKnown, rosterPositions, positionLimits };
}

async function fetchDraftPicks(draftId) {
  return getJson(`${BASE}/draft/${draftId}/picks`);
}

// Matches a Sleeper pick to an existing (undrafted) rankings player.
function matchPickToPlayer(pick, players) {
  const meta = pick.metadata || {};
  const pos = (meta.position || '').toUpperCase();
  const undrafted = players.filter((p) => !p.drafted);

  if (pos === 'DEF' || pos === 'DST') {
    const teamAbbr = (meta.team || '').toUpperCase();
    return (
      undrafted.find((p) => (p.pos === 'DST' || p.pos === 'DEF') && p.team === teamAbbr) ||
      undrafted.find((p) => (p.pos === 'DST' || p.pos === 'DEF') && normalizeName(p.name).includes(normalizeName(meta.first_name)))
    );
  }

  const fullName = `${meta.first_name || ''} ${meta.last_name || ''}`.trim();
  const norm = normalizeName(fullName);
  if (!norm) return null;

  return (
    undrafted.find((p) => normalizeName(p.name) === norm) ||
    undrafted.find((p) => normalizeName(p.name).includes(norm) || norm.includes(normalizeName(p.name)))
  );
}

// Starts polling a draft's picks every `intervalMs`. Calls onPicks(picks) each
// successful fetch, and onStatus({ok, error}) on every attempt (success or failure).
function startPolling(draftId, onPicks, onStatus, intervalMs = 6000) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const picks = await fetchDraftPicks(draftId);
      onStatus({ ok: true, error: null, at: Date.now() });
      onPicks(picks);
    } catch (e) {
      onStatus({ ok: false, error: e.message, at: Date.now() });
    }
  }

  tick();
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

export { connectLeague, fetchDraftPicks, matchPickToPlayer, normalizeName, startPolling, parsePositionLimits };
