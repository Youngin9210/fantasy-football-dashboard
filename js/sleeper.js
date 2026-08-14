// Sleeper API integration (public, read-only, no auth required).
// Docs: https://docs.sleeper.com/

const BASE = 'https://api.sleeper.app/v1';

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

  const teams = [];
  for (let slot = 1; slot <= numTeams; slot++) {
    const userId = Object.keys(draftOrder).find((uid) => draftOrder[uid] === slot);
    const user = userId ? userById.get(userId) : null;
    const roster = userId ? rosterByOwner.get(userId) : null;
    teams.push({
      id: roster ? `r${roster.roster_id}` : `slot${slot}`,
      name: user ? (user.metadata?.team_name || user.display_name || `Team ${slot}`) : `Team ${slot}`,
      slot: slot - 1, // 0-based
      rosterId: roster ? roster.roster_id : null,
      userId: userId || null,
      isMe: false,
    });
  }

  return { league, draft, teams };
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

export { connectLeague, fetchDraftPicks, matchPickToPlayer, normalizeName, startPolling };
