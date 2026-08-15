// Verifies the Preact rewrite renders the same DOM as the vanilla version.
//
// Serves this working tree and a git worktree of `main` on two ports, loads
// both in headless Chrome with identical seeded localStorage, and diffs a
// normalized structural extraction of the rendered page.
//
// No dependencies: a hand-rolled static file server, and CDP driven over
// Node's built-in global WebSocket against chrome-headless-shell.
//
// Usage: node tools/dom-diff.mjs [--verbose]
import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFile, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

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

const draft = (id, teamId, pickNo) => ({ ...BOARD.find((p) => p.id === id), drafted: true, draftedByTeamId: teamId, pickNo });
const base = (over = {}) => ({
  settings: { numTeams: 10, rosterSpots: SPOTS, positionLimits: LIMITS, sortMode: 'rank',
    myTeamId: null, scoringNotes: '', sleeperLeagueId: '', sleeperDraftId: '',
    sleeperUserId: '', sleeperSyncEnabled: false, ...(over.settings || {}) },
  teams: over.teams === undefined ? TEAMS : over.teams,
  players: over.players === undefined ? BOARD : over.players,
  picks: over.picks || [],
  pickCounter: over.pickCounter || 0,
});

const SCENARIOS = [
  { name: 'fresh install', state: null, expectRows: false },
  // main's DEFAULT_ROSTER was 15 slots with 6 BN and DST before K; a raw 'DEF'
  // player is what main's old cleanPos produced from a D/ST column.
  { name: 'pre-branch save', expectRows: true, state: {
      settings: { numTeams: 10, myTeamId: 't1',
        rosterSpots: ['QB','RB','RB','WR','WR','TE','FLEX','DST','K','BN','BN','BN','BN','BN','BN'] },
      teams: TEAMS,
      players: [...BOARD, { id: 'pd', rank: 170, name: 'Eagles', team: 'PHI', pos: 'DEF', bye: 9 }],
      picks: [], pickCounter: 0 } },
  { name: 'rankings, no team, need mode', expectRows: true,
    state: base({ settings: { sortMode: 'need', myTeamId: null } }) },
  { name: 'rankings, team selected, need mode', expectRows: true,
    state: base({ settings: { sortMode: 'need', myTeamId: 't0' },
      players: BOARD.map((p) => (p.id === 'p2' ? draft('p2', 't0', 1) : p)),
      picks: [{ pickNo: 1, round: 1, teamId: 't0', playerId: 'p2', rawName: 'Bijan Robinson' }],
      pickCounter: 1 }) },
  // Three QBs on my roster hits the QB:3 limit, so the divider must render.
  { name: 'at position limit', expectRows: true,
    state: base({ settings: { sortMode: 'need', myTeamId: 't0' },
      players: BOARD.map((p) => (['p4','p5','p6'].includes(p.id)
        ? draft(p.id, 't0', ['p4','p5','p6'].indexOf(p.id) + 1) : p)),
      picks: [1,2,3].map((n) => ({ pickNo: n, round: 1, teamId: 't0',
        playerId: ['p4','p5','p6'][n - 1], rawName: 'QB' })),
      pickCounter: 3 }) },
  // More drafted players than roster spots: picksRemaining must floor at 0.
  { name: 'over-full roster', expectRows: true,
    state: base({ settings: { sortMode: 'need', myTeamId: 't0', rosterSpots: ['QB','BN'] },
      players: BOARD.map((p, i) => (i < 5 ? draft(p.id, 't0', i + 1) : p)),
      pickCounter: 5 }) },
  { name: 'empty rankings', expectRows: false, state: base({ players: [] }) },
];

// ------------------------------------------------------------ in-page code
//
// Everything below the `PAGE_SOURCE` marker runs inside the browser, injected
// as a string. Kept as source text (not a function reference) so the shape of
// the normalizer is obvious and reviewable.

const PAGE_SOURCE = String.raw`
// Walk the DOM emitting tag + sorted attributes + trimmed text. A raw
// innerHTML diff would be pure noise: the vanilla build emits template-literal
// indentation and Preact does not.
//
// Normalizations, each deliberate and documented in the task report:
//  * attribute values collapse runs of whitespace and trim, which absorbs the
//    trailing space an empty interpolation leaves behind (class="btn small ").
//  * the style attribute is compared by COMPUTED value of each property, since
//    Preact re-serializes the shorthand (flex:none -> flex: 0 0 auto).
//  * form controls are compared by their value/selected/checked PROPERTY, not
//    attribute: Preact's defaultValue reflects into the value attribute and
//    vanilla assigned the property only. What the user sees is the property.
//  * ADJACENT TEXT NODES ARE MERGED before comparison. htm gives every
//    interpolation its own text node, so "Pick (n) - Rd (r)" is three nodes
//    where the template literal produced one. The character sequence is
//    compared unchanged, so a genuinely missing space ("T 1" vs "T1") still
//    diffs -- only the invisible node boundary is normalized away.
function extract(root) {
  const out = [];
  const FORM_VALUE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  const styleSig = (node) => {
    const decl = node.style;
    if (!decl || decl.length === 0) return null;
    const cs = getComputedStyle(node);
    const parts = [];
    for (let i = 0; i < decl.length; i++) {
      const prop = decl[i];
      parts.push(prop + ':' + cs.getPropertyValue(prop));
    }
    return parts.sort().join('; ');
  };

  const emitText = (raw, depth) => {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push('  '.repeat(depth) + '"' + t + '"');
  };

  const walkChildren = (parent, depth) => {
    let text = '';
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) { text += child.textContent; continue; }
      if (child.nodeType === 8) continue; // comments are invisible
      emitText(text, depth);
      text = '';
      walk(child, depth);
    }
    emitText(text, depth);
  };

  const walk = (node, depth) => {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT') return;

    const skip = new Set(['style']);
    if (FORM_VALUE.has(node.tagName)) skip.add('value');
    if (node.tagName === 'OPTION') { skip.add('selected'); }
    if (node.tagName === 'INPUT') { skip.add('checked'); }

    const attrs = [...node.attributes]
      .filter((a) => !skip.has(a.name))
      .map((a) => a.name + '=' + JSON.stringify(a.value.replace(/\s+/g, ' ').trim()));

    const sig = styleSig(node);
    if (sig !== null) attrs.push('style=' + JSON.stringify(sig));
    if (FORM_VALUE.has(node.tagName)) attrs.push('value=' + JSON.stringify(node.value));
    if (node.tagName === 'OPTION') attrs.push('selected=' + node.selected);
    if (node.tagName === 'INPUT') attrs.push('checked=' + node.checked);

    attrs.sort();
    out.push('  '.repeat(depth) + '<' + node.tagName.toLowerCase() +
      (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
    walkChildren(node, depth + 1);
  };

  // The rewrite mounts into <div id="root">; vanilla writes its markup
  // straight into <body>. Compare the CONTENTS of whichever container the
  // build uses so the wrapper itself is not a spurious difference.
  walkChildren(document.getElementById('root') || document.body, 0);
  return out.join('\n');
}

async function capture() {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // The vanilla build shows Setup open on every load (index.html never carried
  // the "hidden" class, so app.js's classList.remove was a no-op). The Preact
  // build opens it only on an empty install -- an approved behavior change --
  // so open it here, or the panel's contents would never be compared.
  const panel = document.getElementById('setupPanel');
  let toggled = false;
  if (panel && panel.classList.contains('hidden')) {
    const btns = document.querySelectorAll('.topbar-actions button');
    if (!btns.length) throw new Error('setup panel is hidden and no topbar button exists to open it');
    btns[btns.length - 1].click();
    toggled = true;
    await frame();
    if (document.getElementById('setupPanel').classList.contains('hidden')) {
      throw new Error('clicking the Setup button did not open the setup panel');
    }
  }

  const rows = document.querySelectorAll('table.players tbody tr').length;
  const playerRows = document.querySelectorAll(
    'table.players tbody tr:not(.need-notice):not(.limit-divider)').length;
  const keyed = document.querySelectorAll('[key]').length;
  return { dom: extract(document), rows, playerRows, keyed, toggled };
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

function serve(rootDir) {
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
        res.writeHead(200, {
          'content-type': MIME[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, origin: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function findChrome() {
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

function launchChrome(userDataDir) {
  const proc = spawn(findChrome(), [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
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
class Page {
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

const STORAGE_KEY = 'ffDraftState.v1';

async function captureScenario(page, origin, state) {
  await page.goto(`${origin}/`);
  await page.eval(`(() => {
    localStorage.clear();
    const s = ${JSON.stringify(JSON.stringify(state))};
    if (s !== 'null') localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, s);
  })()`);
  await page.reload();
  const errors = [];
  const off = page.on('Runtime.exceptionThrown', (p) => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  const result = await page.eval(`(async () => { ${PAGE_SOURCE}\nreturn await capture(); })()`, { awaitPromise: true });
  off();
  result.errors = errors;
  return result;
}

// --------------------------------------------------------------------- diff

// Plain LCS line diff. The extractions are a few hundred lines, so the
// quadratic table is irrelevant and the output is easy to read.
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(['-', a[i++]]); }
    else { out.push(['+', b[j++]]); }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

function unified(ops, context = 2) {
  if (!ops.some(([k]) => k !== '=')) return null;
  const keep = new Set();
  ops.forEach(([kind], idx) => {
    if (kind === '=') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
  });
  const lines = [];
  let gap = false;
  ops.forEach(([kind, text], idx) => {
    if (!keep.has(idx)) { gap = true; return; }
    if (gap) { lines.push('   ...'); gap = false; }
    lines.push(`${kind === '=' ? ' ' : kind}  ${text}`);
  });
  return lines.join('\n');
}

// The one signed-off behavior change that shows up as a DOM difference: in
// need mode the excluded ("At position limit") group now renders AFTER the
// drafted rows instead of before, so drafted players never sit under a divider
// claiming they are at a limit. It appears in the diff as a block of table
// rows removed from one position and re-inserted, byte for byte, at another.
//
// Accepting it is deliberately narrow: the removed and inserted blocks must be
// line-for-line identical, and the block must start at a <tr>. Anything else,
// including any block whose CONTENT changed, is reported as unexpected.
function classify(ops) {
  const blocks = [];
  let run = null;
  ops.forEach(([kind, text], idx) => {
    if (kind === '=') { run = null; return; }
    if (!run || run.kind !== kind) { run = { kind, start: idx, lines: [] }; blocks.push(run); }
    run.lines.push(text);
  });

  const moves = [];
  const removed = blocks.filter((b) => b.kind === '-');
  const added = blocks.filter((b) => b.kind === '+');
  const isRowBlock = (b) => /^\s*<tr\b/.test(b.lines[0]);
  for (const r of removed) {
    if (r.paired || !isRowBlock(r)) continue;
    const match = added.find((a) => !a.paired && a.lines.length === r.lines.length
      && a.lines.every((line, i) => line === r.lines[i]));
    if (!match) continue;
    r.paired = match.paired = true;
    moves.push(r);
  }

  const unexpected = [];
  for (const b of blocks) {
    if (b.paired) continue;
    for (const line of b.lines) unexpected.push(`${b.kind}  ${line}`);
  }
  return { unexpected, moves };
}

// --------------------------------------------------------------------- main

async function main() {
  const wt = mkdtempSync(join(tmpdir(), 'ffdash-main-'));
  const profile = mkdtempSync(join(tmpdir(), 'ffdash-chrome-'));
  let chrome = null;
  let servers = [];
  let pages = [];
  let failures = 0;

  // A run killed by a signal (SIGPIPE from `| head`, Ctrl-C) never reaches the
  // finally, so clear any registration whose directory is already gone.
  execSync('git worktree prune', { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  execSync(`git worktree add --detach ${wt} main`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  try {
    const oldSrv = await serve(wt);
    const newSrv = await serve(ROOT.replace(/\/$/, ''));
    servers = [oldSrv.server, newSrv.server];
    console.log(`vanilla (main): ${oldSrv.origin}  ->  ${wt}`);
    console.log(`preact  (head): ${newSrv.origin}  ->  ${ROOT}`);

    chrome = await launchChrome(profile);
    const oldPage = await Page.open(chrome.host, 'about:blank');
    const newPage = await Page.open(chrome.host, 'about:blank');
    pages = [oldPage, newPage];

    const summary = [];
    for (const sc of SCENARIOS) {
      const before = await captureScenario(oldPage, oldSrv.origin, sc.state);
      const after = await captureScenario(newPage, newSrv.origin, sc.state);

      const problems = [];
      for (const [label, cap] of [['vanilla', before], ['preact', after]]) {
        if (cap.errors.length) problems.push(`${label} threw: ${cap.errors.join(' | ')}`);
        if (cap.keyed) problems.push(`${label} rendered ${cap.keyed} element(s) with a literal key attribute`);
      }
      // A harness that diffs two empty tables and reports success is worse
      // than no harness.
      if (sc.expectRows && (before.rows === 0 || after.rows === 0)) {
        problems.push(`expected rows but got vanilla=${before.rows} preact=${after.rows}`);
      }
      if (!sc.expectRows && (before.playerRows !== 0 || after.playerRows !== 0)) {
        problems.push(`expected no player rows but got vanilla=${before.playerRows} preact=${after.playerRows}`);
      }

      const ops = diffLines(before.dom.split('\n'), after.dom.split('\n'));
      const diff = unified(ops);
      const { unexpected, moves } = classify(ops);

      const ok = problems.length === 0 && unexpected.length === 0;
      if (!ok) failures++;
      summary.push({ name: sc.name, ok, rows: [before.rows, after.rows],
        playerRows: [before.playerRows, after.playerRows], moves: moves.length });

      console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${sc.name}`);
      console.log(`      rows: vanilla=${before.rows} preact=${after.rows}` +
        ` (player rows ${before.playerRows}/${after.playerRows})` +
        `  setup toggled: vanilla=${before.toggled} preact=${after.toggled}`);
      for (const m of moves) {
        console.log(`      accepted move (approved need-mode row order): ` +
          `${m.lines.length} lines starting ${m.lines[0].trim()}`);
      }
      for (const p of problems) console.log(`      PROBLEM: ${p}`);
      if (unexpected.length) {
        console.log('      UNEXPECTED DIFFERENCES (- vanilla, + preact):');
        for (const line of unexpected) console.log(`      ${line}`);
      }
      if (VERBOSE && diff) console.log(`\n--- full diff: ${sc.name} ---\n${diff}`);
    }

    console.log('\n================ summary ================');
    for (const s of summary) {
      console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(34)} rows ${s.rows[0]}/${s.rows[1]}` +
        ` (player rows ${s.playerRows[0]}/${s.playerRows[1]})` +
        (s.moves ? `  accepted moves: ${s.moves}` : ''));
    }
    console.log(failures === 0
      ? '\nAll scenarios match (modulo the documented accepted differences).'
      : `\n${failures} scenario(s) differ.`);
  } finally {
    for (const p of pages) p.close();
    if (chrome) chrome.proc.kill('SIGKILL');
    for (const s of servers) s.close();
    execSync(`git worktree remove --force ${wt}`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
