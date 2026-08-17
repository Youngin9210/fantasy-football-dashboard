// Shared plumbing for the verification harnesses — currently just
// tools/screenshot-diff.mjs, after tools/dom-diff.mjs was retired.
//
// Extracted from the original dom-diff.mjs, so any harness built on it drives
// the same browser, the same static server, and the same seeded scenarios. Each
// scenario names the view it describes; a harness must prove the page rendered
// that view before its measurements mean anything.
// No dependencies: a hand-rolled static file server, and CDP driven over
// Node's built-in global WebSocket against chrome-headless-shell.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, normalize, sep } from 'node:path';

// ---------------------------------------------------------------- scenarios

const SPOTS = ['QB','RB','RB','WR','WR','TE','FLEX','K','DST','BN','BN','BN','BN','BN','BN','BN'];
const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };
const TEAMS = Array.from({ length: 10 }, (_, i) => ({
  id: `t${i}`, name: `Team ${i + 1}`, slot: i, rosterId: i + 1, userId: null, isMe: false,
}));

// A board with every branch represented: tiers, a kicker and a defense (for
// WAIT), a manual/unranked entry, and enough QBs to hit a limit.
const BOARD = [
  { id: 'p1', rank: 1, tier: 1, name: 'Ja\'Marr Chase', team: 'CIN', pos: 'WR', bye: 10, adp: 1.2 },
  { id: 'p2', rank: 2, tier: 1, name: 'Bijan Robinson', team: 'ATL', pos: 'RB', bye: 5, adp: 2.1 },
  { id: 'p3', rank: 12, tier: 2, name: 'Brock Bowers', team: 'LV', pos: 'TE', bye: 8, adp: 12.4 },
  { id: 'p4', rank: 20, tier: 3, name: 'Josh Allen', team: 'BUF', pos: 'QB', bye: 7, adp: 21.0 },
  { id: 'p5', rank: 21, tier: 3, name: 'Jayden Daniels', team: 'WAS', pos: 'QB', bye: 14, adp: 24.0 },
  { id: 'p6', rank: 22, tier: 3, name: 'Joe Burrow', team: 'CIN', pos: 'QB', bye: 10, adp: 26.0 },
  { id: 'p7', rank: 23, tier: 3, name: 'Patrick Mahomes', team: 'KC', pos: 'QB', bye: 6, adp: 30.0 },
  { id: 'p8', rank: 150, tier: 9, name: 'Brandon Aubrey', team: 'DAL', pos: 'K', bye: 10, adp: 150.0 },
  { id: 'p9', rank: 160, tier: 9, name: 'Ravens', team: 'BAL', pos: 'DST', bye: 14, adp: 160.0 },
  { id: 'p10', rank: null, name: 'Some Backup', team: 'NYJ', pos: 'RB', bye: null, adp: null, source: 'manual' },
];

const draft = (id, teamId, pickNo, from = BOARD) => ({ ...from.find((p) => p.id === id), drafted: true, draftedByTeamId: teamId, pickNo });
const base = (over = {}) => ({
  // view is seeded EXPLICITLY. settings.view defaults to 'glance' in the app, so
  // a scenario that leaves it out renders the Glance card -- which meant every
  // scenario below, all of which describe the Board, was being compared against
  // a baseline rendering the Board while the head build rendered Glance. The
  // tool reported enormous differences for a reason unrelated to any regression.
  settings: { numTeams: 10, rosterSpots: SPOTS, positionLimits: LIMITS, sortMode: 'rank',
    view: 'board',
    myTeamId: null, scoringNotes: '', sleeperLeagueId: '', sleeperDraftId: '',
    sleeperUserId: '', sleeperSyncEnabled: false, ...(over.settings || {}) },
  teams: over.teams === undefined ? TEAMS : over.teams,
  players: over.players === undefined ? BOARD : over.players,
  picks: over.picks || [],
  pickCounter: over.pickCounter || 0,
});

// Rankings, ten teams, my team chosen, one pick of mine on the board. Used
// twice -- once as a Board scenario and once as a Glance scenario -- so the two
// views are exercised over identical data.
//
// sleeperSyncEnabled stays false on purpose: the Glance card's sync line renders
// "synced 3s ago" from a live clock and re-renders every second, which would
// make its screenshot differ from itself between two captures.
const teamSelected = (view) => base({
  settings: { sortMode: 'need', myTeamId: 't0', view },
  players: BOARD.map((p) => (p.id === 'p2' ? draft('p2', 't0', 1) : p)),
  picks: [{ pickNo: 1, round: 1, teamId: 't0', playerId: 'p2', rawName: 'Bijan Robinson' }],
  pickCounter: 1,
});

// ------------------------------------------------------- stacked bye fixture
//
// BOARD alone CANNOT render a bye badge, and that is not an accident of the data
// -- it is structural. avoidableByeShortfall badges only the shortfall a
// different bye would have avoided, and BOARD's QB byes are all distinct
// (7/14/10/6) while every other position holds exactly one player. The first
// player at a position is short in his own bye week whatever he is, and two
// bodies against two slots are unavoidable however their byes fall, so no
// candidate anywhere on BOARD has a non-zero avoidable shortfall in any scenario
// above.
//
// Consequence, measured: screenshot-diff.mjs passed 16/16 at ZERO differing
// pixels against a pre-feature baseline. The entire bye UI could have been
// deleted and it would still have passed. This fixture exists so the tool can see
// the feature at all.
//
// The shape that badges needs a THIRD body at a position with two starting slots,
// on a bye one of the first two already holds: two RBs on byes 7 and 10 rostered,
// a third RB on bye 7 available. Do not simplify it to two RBs.
const STACKED_RBS = [
  { id: 'sr1', rank: 3, tier: 1, name: 'Saquon Barkley', team: 'PHI', pos: 'RB', bye: 7, adp: 3.0 },
  { id: 'sr2', rank: 4, tier: 1, name: 'Jahmyr Gibbs', team: 'DET', pos: 'RB', bye: 10, adp: 4.0 },
  { id: 'sr3', rank: 5, tier: 1, name: 'Derrick Henry', team: 'BAL', pos: 'RB', bye: 7, adp: 5.0 },
];
const STACKED_BOARD = [...BOARD, ...STACKED_RBS];
// sr1 and sr2 are MINE; sr3 stays on the board as the badged candidate.
const STACKED_MINE = { sr1: 1, sr2: 2 };

// What this fixture is FOR, exported so tools/bye-ui-check.mjs asserts against the
// facts it was built to produce instead of keeping a second copy of the
// arithmetic that could drift out of agreement with it. Both numbers are pinned by
// unit tests on avoidableByeShortfall (see test/recommend.test.js): a third RB on
// bye 7 behind byes 7 and 10 against two RB slots is avoidable 1; bye 5 is 0.
export const STACKED_BYE = {
  scenario: 'stacked bye, team selected',
  badged: { name: 'Derrick Henry', badge: 'BYE 7 ×1' },
  unbadged: { name: 'Bijan Robinson' },
  expectedBadges: 1, // exactly one badged candidate on the whole board
};

// Every scenario declares the `view` it is describing, and a harness must prove
// the page actually rendered that view before comparing anything -- see
// ENSURE_VIEW_SOURCE. Where the seeded state cannot say (no state at all, or a
// settings object saved before settings.view existed) the harness clicks the
// real toggle instead.
export const SCENARIOS = [
  { name: 'fresh install', state: null, view: 'board', expectRows: false },
  // main's DEFAULT_ROSTER was 15 slots with 6 BN and DST before K; a raw 'DEF'
  // player is what main's old cleanPos produced from a D/ST column. No
  // settings.view either, which is the point: this is a save from before the
  // key existed, so the harness has to reach the Board through the toggle.
  { name: 'pre-branch save', expectRows: true, view: 'board', state: {
      settings: { numTeams: 10, myTeamId: 't1',
        rosterSpots: ['QB','RB','RB','WR','WR','TE','FLEX','DST','K','BN','BN','BN','BN','BN','BN'] },
      teams: TEAMS,
      players: [...BOARD, { id: 'pd', rank: 170, name: 'Eagles', team: 'PHI', pos: 'DEF', bye: 9 }],
      picks: [], pickCounter: 0 } },
  { name: 'rankings, no team, need mode', expectRows: true, view: 'board',
    state: base({ settings: { sortMode: 'need', myTeamId: null } }) },
  { name: 'rankings, team selected, need mode', expectRows: true, view: 'board',
    state: teamSelected('board') },
  // The default view: the one users actually land on, and the only one that was
  // never compared before this scenario existed.
  { name: 'glance, team selected', expectRows: false, view: 'glance',
    state: teamSelected('glance') },
  // Three QBs on my roster hits the QB:3 limit, so the divider must render.
  // Approved behavior change #2 lives here: the excluded group now renders
  // after the drafted rows instead of before, which reorders table rows.
  // Only meaningful against a baseline that predates the Preact rewrite;
  // screenshot-diff.mjs ignores the flag for any later baseline.
  { name: 'at position limit', expectRows: true, view: 'board', reordersRows: true,
    state: base({ settings: { sortMode: 'need', myTeamId: 't0' },
      players: BOARD.map((p) => (['p4','p5','p6'].includes(p.id)
        ? draft(p.id, 't0', ['p4','p5','p6'].indexOf(p.id) + 1) : p)),
      picks: [1,2,3].map((n) => ({ pickNo: n, round: 1, teamId: 't0',
        playerId: ['p4','p5','p6'][n - 1], rawName: 'QB' })),
      pickCounter: 3 }) },
  // More drafted players than roster spots: picksRemaining must floor at 0.
  { name: 'over-full roster', expectRows: true, view: 'board',
    state: base({ settings: { sortMode: 'need', myTeamId: 't0', rosterSpots: ['QB','BN'] },
      players: BOARD.map((p, i) => (i < 5 ? draft(p.id, 't0', i + 1) : p)),
      pickCounter: 5 }) },
  { name: 'empty rankings', expectRows: false, view: 'board', state: base({ players: [] }) },
  // The only scenario in which a bye badge renders at all -- see STACKED_BYE.
  // Against a baseline predating the bye UI this scenario MUST report a
  // difference; if it ever reports 0 differing pixels, either the fixture stopped
  // producing an avoidable shortfall or the badge stopped rendering.
  { name: STACKED_BYE.scenario, expectRows: true, view: 'board', state: base({
      settings: { sortMode: 'need', myTeamId: 't0' },
      players: STACKED_BOARD.map((p) => (STACKED_MINE[p.id]
        ? draft(p.id, 't0', STACKED_MINE[p.id], STACKED_BOARD) : p)),
      picks: Object.entries(STACKED_MINE).map(([playerId, pickNo]) => ({
        pickNo, round: 1, teamId: 't0', playerId,
        rawName: STACKED_BOARD.find((p) => p.id === playerId).name,
      })),
      pickCounter: 2 }) },
];

export const STORAGE_KEY = 'ffDraftState.v1';
export const THEME_KEY = 'ffTheme';

// ------------------------------------------------------------ in-page code

// The vanilla build shows Setup open on every load (index.html never carried
// the "hidden" class, so app.js's classList.remove was a no-op). The Preact
// build opens it only on an empty install -- an approved behavior change -- so
// both harnesses force the SAME panel state before measuring, or the panel's
// presence rather than its appearance would be what gets compared.
export const ENSURE_SETUP_OPEN_SOURCE = String.raw`
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function ensureSetupOpen() {
  const panel = document.getElementById('setupPanel');
  if (!panel || !panel.classList.contains('hidden')) return false;
  const btns = document.querySelectorAll('.topbar-actions button');
  if (!btns.length) throw new Error('setup panel is hidden and no topbar button exists to open it');
  btns[btns.length - 1].click();
  await nextFrame();
  if (document.getElementById('setupPanel').classList.contains('hidden')) {
    throw new Error('clicking the Setup button did not open the setup panel');
  }
  return true;
}

function countRows() {
  return {
    rows: document.querySelectorAll('table.players tbody tr').length,
    playerRows: document.querySelectorAll(
      'table.players tbody tr:not(.need-notice):not(.limit-divider)').length,
  };
}
`;

// Concatenate AFTER ENSURE_SETUP_OPEN_SOURCE, which defines nextFrame; two
// `const nextFrame` declarations in one evaluated scope is a syntax error.
//
// The scenarios that seed settings.view get their view for free, but two of them
// cannot: 'fresh install' has no saved state at all, and 'pre-branch save'
// carries a settings object from before settings.view existed. Both fall back to
// the app's default (Glance), so the harness clicks the real Board button, the
// same way ensureSetupOpen drives the real Setup button.
export const ENSURE_VIEW_SOURCE = String.raw`
// Read from the DOM, never trusted from what was seeded: Glance renders a single
// .glance-card and no table, the Board renders main.layout. A build predating
// the split renders the board layout and has no #viewToggle, so it reports
// 'board' -- which is why the caller compares this against the scenario's
// declared view rather than assuming the click worked.
function currentView() {
  if (document.querySelector('.glance-card')) return 'glance';
  if (document.querySelector('main.layout')) return 'board';
  return null;
}

async function ensureView(want) {
  if (!want || currentView() === want) return false;
  const toggle = document.getElementById('viewToggle');
  if (!toggle) return false;
  const btn = [...toggle.querySelectorAll('button')]
    .find((b) => b.textContent.trim().toLowerCase() === want);
  if (!btn) throw new Error('#viewToggle has no "' + want + '" button');
  btn.click();
  await nextFrame();
  return true;
}
`;

// --------------------------------------------------------------- utilities

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// `transform` optionally rewrites a served text file. screenshot-diff.mjs uses
// it only for its own sensitivity self-test; both harnesses serve the trees
// byte for byte otherwise.
export function serve(rootDir, transform = null) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(rootDir, rel));
      // Refuse to escape the served root.
      if (!file.startsWith(rootDir.endsWith(sep) ? rootDir : rootDir + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        const type = MIME[extname(file)] || 'application/octet-stream';
        const body = transform ? transform(rel, buf) : buf;
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, origin: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

export function findChrome() {
  const base = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (!existsSync(base)) throw new Error(`chrome-headless-shell not found under ${base}`);
  for (const build of readdirSync(base).sort().reverse()) {
    for (const dir of readdirSync(join(base, build))) {
      const bin = join(base, build, dir, 'chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error(`no chrome-headless-shell binary under ${base}`);
}

export function launchChrome(userDataDir, extraArgs = []) {
  const proc = spawn(findChrome(), [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    ...extraArgs,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`chrome did not report a debugging port:\n${buf}`)), 30000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/ws:\/\/(127\.0\.0\.1:\d+)\/devtools\/browser\/\S+/);
      if (m) { clearTimeout(timer); resolve({ proc, host: m[1] }); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chrome exited early (${code}):\n${buf}`)); });
  });
}

// A minimal CDP client over one page target's WebSocket.
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.method || ''})`)) : p.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async open(host, url) {
    const res = await fetch(`http://${host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`could not create a browser tab: ${res.status} ${await res.text()}`);
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true });
    });
    const page = new Page(ws);
    page.targetId = target.id;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method);
      arr.splice(arr.indexOf(fn), 1);
    };
  }

  once(method, { timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeout);
      const off = this.on(method, (params) => { clearTimeout(timer); off(); resolve(params); });
    });
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }

  async goto(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}
