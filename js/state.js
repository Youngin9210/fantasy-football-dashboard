// Central state management + localStorage persistence.

const STORAGE_KEY = 'ffDraftState.v1';

const DEFAULT_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DST', 'K', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

function defaultState() {
  return {
    settings: {
      numTeams: 10,
      myTeamId: null,
      rosterSpots: DEFAULT_ROSTER.slice(),
      scoringNotes: 'Half-PPR (0.5/rec), 6pt passing TD, -3 INT',
      sleeperLeagueId: '',
      sleeperDraftId: '',
      sleeperUserId: '',
      sleeperSyncEnabled: false,
    },
    teams: [], // {id, name, slot, rosterId, isMe}
    players: [], // {id, rank, tier, name, team, pos, bye, adp, drafted, draftedByTeamId, pickNo}
    picks: [], // {pickNo, round, teamId, playerId, rawName}
    pickCounter: 0, // for manual mode
    lastSleeperSync: null,
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    console.warn('Failed to load saved state, starting fresh', e);
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save state', e);
  }
}

const listeners = new Set();
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  save();
  for (const fn of listeners) fn(state);
}

function getState() {
  return state;
}

function resetDraft() {
  const settings = state.settings;
  const teams = state.teams;
  state = defaultState();
  state.settings = settings;
  state.teams = teams;
  notify();
}

function resetAll() {
  state = defaultState();
  notify();
}

function updateSettings(patch) {
  state.settings = Object.assign({}, state.settings, patch);
  notify();
}

function setTeams(teams) {
  state.teams = teams;
  notify();
}

function setPlayers(players) {
  state.players = players;
  notify();
}

function addPlayers(newPlayers) {
  state.players = state.players.concat(newPlayers);
  notify();
}

let idCounter = 1;
function nextId(prefix) {
  return `${prefix}_${Date.now()}_${idCounter++}`;
}

function draftPlayer(playerId, teamId, pickNoOverride) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.drafted) return;
  state.pickCounter += 1;
  const pickNo = pickNoOverride || state.pickCounter;
  player.drafted = true;
  player.draftedByTeamId = teamId;
  player.pickNo = pickNo;
  state.picks.push({ pickNo, teamId, playerId, rawName: player.name });
  notify();
}

function undoLastPick() {
  const last = state.picks.pop();
  if (!last) return;
  const player = state.players.find((p) => p.id === last.playerId);
  if (player) {
    player.drafted = false;
    player.draftedByTeamId = null;
    player.pickNo = null;
  }
  state.pickCounter = Math.max(0, state.pickCounter - 1);
  notify();
}

function undraftPlayer(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.drafted) return;
  state.picks = state.picks.filter((p) => p.playerId !== playerId);
  player.drafted = false;
  player.draftedByTeamId = null;
  player.pickNo = null;
  notify();
}

function addManualPlayer(playerData) {
  const player = Object.assign(
    {
      id: nextId('p'),
      rank: state.players.length + 1,
      tier: null,
      name: '',
      team: '',
      pos: '',
      bye: null,
      adp: null,
      drafted: false,
      draftedByTeamId: null,
      pickNo: null,
      source: 'manual',
    },
    playerData
  );
  state.players.push(player);
  notify();
  return player;
}

export {
  DEFAULT_ROSTER,
  getState,
  onChange,
  notify,
  resetDraft,
  resetAll,
  updateSettings,
  setTeams,
  setPlayers,
  addPlayers,
  addManualPlayer,
  draftPlayer,
  undoLastPick,
  undraftPlayer,
  nextId,
};
