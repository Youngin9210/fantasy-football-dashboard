// Proves the market signal (the Board's Value column and the Glance line) really
// renders, in both themes, against the owner's REAL rankings CSV.
//
// Why this file exists: `node --test` covers no component on this project — the
// Preact/htm views are not rendered by any unit test. Task 3's implementer
// mutation-tested its own work and found all five mutations it tried INVISIBLE to
// the whole 155-test suite: rendering raw `p.ecrVsAdp` instead of the word form,
// hardcoding the badge class, reverting the header to `ADP`, badging unflagged
// rows, and adding a tenth column. Every one of them passes `node --test`. The
// browser checks that caught them lived in a session scratchpad and are gone.
// This file is the durable replacement, and it is also the first verification of
// commit 9be31bf (the fix wave: `.market-plain`, and the Glance line gated to
// TAKE), which was committed without a browser run because that scratchpad check
// had died.
//
// The design claim it pins: the raw sign is BACKWARDS from intuition (negative
// means drafted EARLIER than ranked, i.e. he will be gone), so the Value column
// states direction as a WORD ("10 early" / "11 late") and never shows a raw sign
// at any magnitude. Flagged and unflagged use identical wording; only emphasis
// differs. A null gap renders an empty cell.
//
// Deliberately in tools/, not test/: `node --test` collects every .js file under
// a directory named `test`, and this drives a real browser. Same shape, plumbing
// and exit-code convention as tools/bye-ui-check.mjs — serve, launchChrome, Page,
// STORAGE_KEY, THEME_KEY and the WCAG contrast helper all come from
// tools/harness.mjs, so this cannot drift away from what the other harnesses
// render. No automation package: CDP over Node's global WebSocket.
//
// Usage: node tools/market-ui-check.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serve, launchChrome, Page, STORAGE_KEY, THEME_KEY, CONTRAST_SOURCE,
  SPOTS, TEAMS as BASE_TEAMS,
} from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const J = JSON.stringify;
const THEMES = ['dark', 'light'];

// WCAG AA for normal text. Four things are measured against it, and one of them
// is why this floor is not decorative: the unflagged Value text used to be a bare
// string inheriting .player-meta's --text-muted, which lands at 3.50:1 on the
// light panel — ~78% of the column below AA. `.market-plain` was appended to fix
// exactly that, so removing it must fail here.
const MIN_CONTRAST = 4.5;

// --status-critical is #d03b3b in BOTH :root and :root[data-theme="light"]
// (css/styles.css:17,46), i.e. rgb(208, 59, 59) in both themes -- checked, not
// assumed, since a token that only existed in one theme would make this a
// theme-specific assertion by accident. This is the design's other central
// claim, distinct from the wording sweep: only `early` is coloured, and it is
// coloured THIS red. Deleting `.market-badge.early { background: ... }`
// (css/styles.css:777) leaves the badge on the base `.market-badge` rule --
// grey, same padding, same size, and actually HIGHER contrast than the red --
// so nothing else in this file notices. See the two checks right after #2
// below.
const CRITICAL_RED = 'rgb(208, 59, 59)';

// The owner's real export, handed to the app's own #csvFile through CDP
// DOM.setFileInputFiles and imported with the app's own button. Not a synthetic
// fixture: the historical failure mode on this project is a harness whose fixture
// cannot express the thing being checked, and only the real file has 946 rows, a
// literal "-" gap, and both flag directions at once.
const CSV = process.env.MARKET_CSV
  || '/Users/kyleyoung/Downloads/FantasyPros_2026_Draft_ALL_Rankings (1).csv';

// The 155 unit tests already pin marketNote's arithmetic. These strings are
// hardcoded rather than imported from js/ui/market.js ON PURPOSE: an expectation
// computed by the module under test moves with the module, so a mutated
// marketNote would still "match". Same for FLAG_AT — a change to MARKET_FLAG_AT
// should trip this file, not slide through it.
const FLAG_AT = 8;
const EXPECT_PLAYERS = 946;

// Rank, gap and rendered text for the rows this file locates by name. Each gap is
// re-read from the imported board below, so a different CSV fails loudly here
// instead of quietly making the assertions vacuous.
const EARLY = { name: 'Josh Jacobs', rank: 39, gap: -10, text: '10 early' };
const LATE = { name: 'Terry McLaurin', rank: 45, gap: 11, text: '11 late' };
const PLAIN_EARLY = { name: 'Breece Hall', rank: 35, gap: -2, text: '2 early' };
const PLAIN_LATE = { name: 'Ladd McConkey', rank: 40, gap: 3, text: '3 late' };
// The CSV's first literal "-" in the ECR VS. ADP column (rank 224).
const NO_DATA = { name: 'Oscar Delp', rank: 224, gap: null };

// Glance. The flagged fixture drafts away everything ranked above McLaurin, so
// the TAKE is a FLAGGED player and both THEN entries come from directly behind
// him — one of which (Cam Skattebo, gap -12) is flagged too. That second fact is
// the whole point of the THEN check: "no market line on THEN" is vacuous unless a
// THEN entry actually has a flagged gap.
const TAKE_FLAGGED = { name: 'Terry McLaurin', long: 'usually still there ~11 picks later' };
const TAKE_UNFLAGGED = { name: 'Jahmyr Gibbs', gap: 0 };

// Phone. The Board only just stopped overflowing a phone, and the historical
// failure was the horizontal scroll landing on the DOCUMENT instead of inside
// .table-wrap. The two widths are pinned (not merely "no overflow") so the next
// column change cannot quietly reintroduce it: if they move, that is a real
// layout change and someone must look.
const PHONE = { width: 390, height: 844, table: 615, wrapScroll: 251, tol: 4 };

const DESKTOP = { width: 1440, height: 900 };

// League shape, shared with the other harnesses via harness.mjs (SPOTS, TEAMS)
// rather than a second copy that could drift. This file's fixtures need a
// team of MINE to seed sortMode: 'need', so isMe is remapped onto index 0 here
// -- harness.mjs's own TEAMS export stays isMe: false, which is what
// bye-ui-check.mjs and screenshot-diff.mjs already get through it.
const TEAMS = BASE_TEAMS.map((t, i) => ({ ...t, isMe: i === 0 }));

// ---------------------------------------------------------------- test harness

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures += 1;
}

// Raised when the CSV-fixture assertions (the ones that run BEFORE anything is
// rendered) find the imported board does not match what this file is pinned
// against. Caught once, outside the try/finally below, so the browser and temp
// profile still get cleaned up before the process exits.
class CsvFixtureMismatch extends Error {}

// Wraps check() for exactly the CSV-fixture assertions: same PASS/FAIL line,
// but failures are also collected so the run can stop with one actionable
// message instead of cascading into ~50 downstream failures whose real cause
// (a re-exported CSV) is buried at the top of a long FAIL list.
const fixtureFailures = [];
function checkFixture(label, ok, detail) {
  check(label, ok, detail);
  if (!ok) fixtureFailures.push(detail ? `${label} -> ${detail}` : label);
}

// ------------------------------------------------------------- in-page helpers

const PAGE_HELPERS = CONTRAST_SOURCE + String.raw`
// The Value column is located by its HEADER TEXT, not by a hardcoded index: that
// is what makes a reverted "ADP" header fail loudly everywhere downstream instead
// of silently measuring the Bye column. When the header is gone this returns -1
// and every cell lookup below reports null rather than throwing, so the checks
// FAIL (with the header text printed) instead of crashing the run.
function headerCells() {
  return [...document.querySelectorAll('table.players thead th')].map((th) => th.textContent.trim());
}
function valueIndex() { return headerCells().indexOf('Value'); }

// Player rows only: the two colspan rows carry no Value cell and would otherwise
// be swept as if they did.
function playerRows() {
  return [...document.querySelectorAll(
    'table.players tbody tr:not(.need-notice):not(.limit-divider)')];
}

function rowFor(name) {
  return playerRows().find((tr) => {
    const cell = tr.querySelector('.player-name');
    return cell && cell.textContent.trim() === name;
  }) || null;
}

function cellInfo(name) {
  const row = rowFor(name);
  const i = valueIndex();
  const td = row && i >= 0 ? row.children[i] || null : null;
  const badge = td ? td.querySelector('.market-badge') : null;
  const plain = td ? td.querySelector('.market-plain') : null;
  return {
    found: !!row,
    located: !!td,
    text: td ? td.textContent.trim() : null,
    kids: td ? td.childElementCount : null,
    badge: badge ? badge.className : null,
    badgeContrast: badge ? contrast(badge) : null,
    badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
    plain: !!plain,
    plainContrast: plain ? contrast(plain) : null,
  };
}

// The design's central claim, swept over EVERY row of the real board. Returns the
// number of cells actually looked at as well as the offenders, because a sweep
// that found nothing to look at must not pass.
function signSweep() {
  const i = valueIndex();
  let swept = 0;
  const hits = [];
  for (const row of playerRows()) {
    const td = i >= 0 ? row.children[i] : null;
    if (!td) continue;
    swept += 1;
    const text = td.textContent.trim();
    if (/[-+−]/.test(text)) {
      hits.push({ name: (row.querySelector('.player-name') || {}).textContent, text });
    }
  }
  return { swept, hits: hits.slice(0, 8), hitCount: hits.length };
}

// A colspan row must span the whole table, so its own <td> is measured against a
// real player row rather than trusted from the attribute alone.
function colspanRow(selector) {
  const tr = document.querySelector('table.players tbody tr' + selector);
  const sample = playerRows()[0];
  if (!tr || !sample) return { present: false, colspan: null, width: null, rowWidth: null };
  const td = tr.querySelector('td');
  return {
    present: true,
    colspan: td ? td.getAttribute('colspan') : null,
    width: td ? td.getBoundingClientRect().width : null,
    rowWidth: sample.getBoundingClientRect().width,
    text: tr.textContent.trim().slice(0, 40),
  };
}

function glanceInfo() {
  const picks = [...document.querySelectorAll('.glance-pick')];
  // The name is the FIRST TEXT NODE of .glance-pick-name: the element also holds
  // a .pos-badge and a "#45" .player-meta, so textContent would read
  // "Terry McLaurin WR #45" and never match a name.
  const nameOf = (p) => {
    const el = p.querySelector('.glance-pick-name');
    if (!el) return null;
    const first = el.firstChild;
    return first && first.nodeType === 3 ? first.textContent.trim() : el.textContent.trim();
  };
  // entry.byeWarning deliberately still renders on both TAKE and THEN -- that
  // is NOT this file's concern, so .glance-pick-bye is intentionally not
  // collected here; nothing pins it absent.
  const read = (p) => ({
    label: (p.querySelector('.glance-pick-label') || {}).textContent,
    name: nameOf(p),
    market: [...p.querySelectorAll('.glance-pick-market')].map((el) => el.textContent.trim()),
  });
  const all = [...document.querySelectorAll('.glance-pick-market')];
  const card = document.querySelector('.glance-card');
  return {
    hasCard: !!card,
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
    pickCount: picks.length,
    picks: picks.map(read),
    thenMarket: document.querySelectorAll('.glance-then .glance-pick-market').length,
    thenPicks: [...document.querySelectorAll('.glance-then .glance-pick')].map(read),
    marketCount: all.length,
    marketText: all.map((el) => el.textContent.trim()),
    marketContrast: all.length ? contrast(all[0]) : null,
    // Last of the three lines on purpose (fills / byes / market), so the card
    // reads in that order.
    marketIsLast: all.length ? all[0] === all[0].parentElement.lastElementChild : null,
  };
}
`;

const probe = (page, body) => page.eval(`(() => { ${PAGE_HELPERS}\n${body} })()`);
const nextFrames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

// ----------------------------------------------------------- console collection

const consoleNoise = [];
let where = 'startup';
function watchConsole(page) {
  const args = (params) => (params.args || [])
    .map((a) => a.value ?? a.description ?? a.type).join(' ');
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      consoleNoise.push(`[${where}] console.${p.type}: ${args(p)}`);
    }
  });
  page.on('Runtime.exceptionThrown', (p) => {
    consoleNoise.push(`[${where}] exception: ${p.exceptionDetails?.exception?.description
      || p.exceptionDetails?.text}`);
  });
  page.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' || p.entry.level === 'warning') {
      consoleNoise.push(`[${where}] log(${p.entry.source}/${p.entry.level}): ${p.entry.text} ${p.entry.url || ''}`);
    }
  });
  return page.send('Log.enable');
}

// ------------------------------------------------------------------ page loads

// Seeded from a real 200 on the SAME origin (a static file that runs no app code)
// rather than from the app itself: useTheme reads ffTheme at mount and writes it
// back in an effect, so a seed written underneath a running app is silently
// clobbered and the next load renders the PREVIOUS theme. Same reasoning as
// bye-ui-check.mjs's load(), except that this file also asserts a clean console,
// and bye-ui-check's 404 seed URL would itself log a network error.
const SEED_URL = '/css/styles.css';

async function load(page, origin, state, theme) {
  await page.goto(`${origin}${SEED_URL}`);
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem(${J(STORAGE_KEY)}, ${J(JSON.stringify(state))});
    localStorage.setItem(${J(THEME_KEY)}, ${J(theme)});
  })()`);
  await page.goto(`${origin}/`);
  await page.eval(nextFrames, { awaitPromise: true });
}

// The real import, through the real UI. A fresh install opens the Setup panel, so
// #csvFile is on screen; CDP hands it the file the way a user's file picker
// would, and the app's own #importCsvBtn runs js/csv.js. The parsed board is then
// read back out of the store's own localStorage so the rest of the run can seed
// fixtures from it without re-importing 946 players nine times.
async function importRealCsv(page, origin) {
  await page.goto(`${origin}${SEED_URL}`);
  await page.eval('localStorage.clear()');
  await page.goto(`${origin}/`);
  await page.eval(nextFrames, { awaitPromise: true });

  const hasInput = await page.eval("!!document.querySelector('#csvFile')");
  if (!hasInput) throw new Error('#csvFile is not on screen: the Setup panel did not open on a fresh install');

  const doc = await page.send('DOM.getDocument');
  const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#csvFile' });
  await page.send('DOM.setFileInputFiles', { files: [CSV], nodeId: node.nodeId });
  await page.eval("document.querySelector('#importCsvBtn').click()");

  const state = await page.eval(`(async () => {
    for (let i = 0; i < 200; i++) {
      const raw = localStorage.getItem(${J(STORAGE_KEY)});
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && (parsed.players || []).length) return parsed;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  })()`, { awaitPromise: true });
  if (!state) throw new Error('the CSV import never put players in the store');
  return state;
}

// ------------------------------------------------------------------------ main

if (!existsSync(CSV)) {
  console.error(`the owner's rankings CSV is not at ${CSV}\n` +
    'set MARKET_CSV to its path; this check refuses to run on a synthetic fixture');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'market-ui-chrome-'));
let server;
let chrome;
let page;
// Outer try/catch is only for CsvFixtureMismatch: it lets the inner
// try/finally close the browser and the temp profile before exiting, instead
// of process.exit() cutting the run off mid-cleanup.
try {
try {
  server = await serve(ROOT);
  chrome = await launchChrome(profile);
  page = await Page.open(chrome.host, 'about:blank');
  await watchConsole(page);
  await page.send('Emulation.setDeviceMetricsOverride', {
    ...DESKTOP, deviceScaleFactor: 1, mobile: false,
  });

  // ---------------------------------------------------------- the real import
  where = 'csv import';
  const imported = await importRealCsv(page, server.origin);
  const PLAYERS = imported.players;
  const byName = (n) => PLAYERS.find((p) => p.name === n);

  checkFixture(`the owner's CSV imported through the app's own #csvFile (${EXPECT_PLAYERS} players)`,
    PLAYERS.length === EXPECT_PLAYERS, `saw ${PLAYERS.length}`);

  // Fixture sanity BEFORE anything is rendered: every row this file locates by
  // name must exist in the imported board with the gap the assertions assume.
  // Without this, a re-exported CSV would leave the checks below quietly
  // measuring the wrong thing. These, plus the QB count and "players above
  // McLaurin" count below, are the 8 CSV-fixture assertions the gate right
  // after them depends on.
  for (const e of [EARLY, LATE, PLAIN_EARLY, PLAIN_LATE, NO_DATA]) {
    const p = byName(e.name);
    checkFixture(`fixture: ${e.name} is rank ${e.rank} with gap ${J(e.gap)} in the imported board`,
      !!p && p.rank === e.rank && (p.ecrVsAdp ?? null) === e.gap,
      p ? `rank=${p.rank}, ecrVsAdp=${J(p.ecrVsAdp ?? null)}` : 'not in the board');
  }

  // ------------------------------------------------------------------ fixtures
  const settings = (over) => ({
    ...imported.settings,
    numTeams: 10,
    rosterSpots: SPOTS,
    positionLimits: {},
    sleeperSyncEnabled: false,
    sortMode: 'rank',
    myTeamId: null,
    view: 'board',
    ...over,
  });
  const fixture = (over) => ({
    ...imported,
    settings: settings(over.settings || {}),
    teams: TEAMS,
    // `!== undefined`, not `||`: an explicitly-empty `players: []` must stay
    // empty rather than silently falling back to the full 946-row board. No
    // caller passes `[]` today, but a future fixture that does should not land
    // in a vacuity trap.
    players: over.players !== undefined ? over.players : PLAYERS,
    picks: over.picks || [],
    pickCounter: over.pickCounter || 0,
  });

  const byId = (id) => PLAYERS.find((p) => p.id === id);
  const drafted = (p, teamId, pickNo) => ({
    ...p, drafted: true, draftedByTeamId: teamId, pickNo,
  });
  // Draft a set of players away, to teams other than mine, so my roster stays
  // empty and every position is still open.
  function draftAwayIds(ids) {
    const order = [...ids];
    const players = PLAYERS.map((p) => {
      const i = order.indexOf(p.id);
      return i < 0 ? p : drafted(p, `t${(i % 9) + 1}`, i + 1);
    });
    const missing = [];
    const picks = order.map((id, i) => {
      const p = byId(id);
      if (!p) missing.push(id);
      return {
        pickNo: i + 1, round: Math.floor(i / 10) + 1, teamId: `t${(i % 9) + 1}`,
        playerId: id, rawName: p ? p.name : null,
      };
    });
    // A missing id here is a fixture bug, not a CSV difference -- but a named
    // failure beats a thrown TypeError from `.name` on undefined. One
    // aggregate check rather than one per id, so a clean run stays quiet.
    check(`fixture: draftAwayIds found a player for every one of its ${order.length} ids`,
      missing.length === 0, `${missing.length} missing: ${J(missing)}`);
    return { players, picks, pickCounter: order.length };
  }

  // The whole real board, in rank order, no team chosen: 946 Value cells for the
  // sign sweep and every named row on screen at once.
  const BOARD = fixture({});

  // colspan="9" row #1: need mode with NO team chosen.
  const NEED_NOTICE = fixture({ settings: { sortMode: 'need', myTeamId: null } });

  // colspan="9" row #2, and THE TRAP. The position-limit divider renders only
  // when sortMode is 'need' AND myTeamId is set AND three QBs are drafted TO THAT
  // TEAM (recommend.js excludes on state.posCounts, which rosterState builds from
  // `mine`, not from all picks) AND positionLimits.QB is 3 AND an undrafted QB
  // remains. Miss any one and the divider never renders — and a sweep over that
  // empty list passes vacuously, which is the same trap bye-ui-check.mjs records
  // in its own header comment. The undrafted-QB count is asserted here rather
  // than assumed.
  const QBS = PLAYERS.filter((p) => p.pos === 'QB')
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const MINE_QB = QBS.slice(0, 3);
  checkFixture(`fixture: the board has ${MINE_QB.length + 1}+ QBs, so 3 drafted still leaves one undrafted`,
    QBS.length > 3, `${QBS.length} QB(s)`);
  const LIMIT = fixture({
    settings: { sortMode: 'need', myTeamId: 't0', positionLimits: { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 } },
    players: PLAYERS.map((p) => {
      const i = MINE_QB.findIndex((q) => q.id === p.id);
      return i < 0 ? p : drafted(p, 't0', i + 1);
    }),
    picks: MINE_QB.map((q, i) => ({
      pickNo: i + 1, round: i + 1, teamId: 't0', playerId: q.id, rawName: q.name,
    })),
    pickCounter: 3,
  });

  // Glance, flagged TAKE: everything ranked above McLaurin is gone, so he is the
  // best remaining player at an open starting slot and the two THEN entries are
  // the ranks right behind him.
  const above = PLAYERS.filter((p) => p.rank != null && p.rank < LATE.rank);
  checkFixture(`fixture: ${above.length} players rank above ${LATE.name} and are drafted away`,
    above.length === LATE.rank - 1, `saw ${above.length}, want ${LATE.rank - 1}`);

  // The gate: these 8 checks (the import count, the 5 named-row lookups, the
  // QB count, and this one) run BEFORE anything is rendered. A different CSV
  // export trips several of them at once and then cascades into ~50 more
  // failures downstream (row counts, sweep counts, phone width pins) that all
  // have the same root cause. Stop here instead, with one message that names
  // exactly what diverged and what was found, so the fix is "re-derive these
  // constants from the new export" rather than "read 50 FAIL lines".
  if (fixtureFailures.length) {
    throw new CsvFixtureMismatch(
      `\n${fixtureFailures.length} CSV-fixture assertion(s) failed before any rendering was measured -- ` +
      `the pinned constants in tools/market-ui-check.mjs (EXPECT_PLAYERS, EARLY/LATE/PLAIN_EARLY/` +
      `PLAIN_LATE/NO_DATA, and the QB and "above ${LATE.name}" counts) need to be re-derived for:\n` +
      `  ${CSV}\n\n` +
      fixtureFailures.map((f) => `  - ${f}`).join('\n') + '\n');
  }

  const GLANCE_FLAGGED = fixture({
    settings: { sortMode: 'need', myTeamId: 't0', view: 'glance' },
    ...draftAwayIds(above.map((p) => p.id)),
  });

  // Glance, unflagged TAKE: the untouched board, where the best pick is the
  // overall #1 and his gap is 0 ("on rank", not flagged).
  const GLANCE_UNFLAGGED = fixture({
    settings: { sortMode: 'need', myTeamId: 't0', view: 'glance' },
  });

  // ---------------------------------------------------------- 1-5, 9: the Board
  async function boardChecks(theme) {
    where = `board/${theme}`;
    await load(page, server.origin, BOARD, theme);
    const r = await probe(page, `
      const heads = headerCells();
      const badges = [...document.querySelectorAll('table.players .market-badge')];
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        onBoard: !!document.querySelector('main.layout'),
        rows: playerRows().length,
        heads,
        headCount: heads.length,
        valueIndex: valueIndex(),
        early: cellInfo(${J(EARLY.name)}),
        late: cellInfo(${J(LATE.name)}),
        plainEarly: cellInfo(${J(PLAIN_EARLY.name)}),
        plainLate: cellInfo(${J(PLAIN_LATE.name)}),
        noData: cellInfo(${J(NO_DATA.name)}),
        sweep: signSweep(),
        badgeTotal: badges.length,
        earlyBadges: badges.filter((b) => b.classList.contains('early')).length,
        lateBadges: badges.filter((b) => b.classList.contains('late')).length,
        panelBg: getComputedStyle(document.querySelector('.panel')).backgroundColor,
      };
    `);

    // Vacuity first: nothing below means anything if the Board did not render the
    // whole imported board in the theme that was seeded.
    check(`[${theme}] the Board rendered all ${EXPECT_PLAYERS} imported rows`,
      r.onBoard && r.rows === EXPECT_PLAYERS, `main.layout=${r.onBoard}, rows=${r.rows}`);
    check(`[${theme}] data-theme is "${theme}"`, r.theme === theme, `saw ${J(r.theme)}`);

    // 1. The header.
    check(`[${theme}] the Board header count is exactly 9`, r.headCount === 9,
      `${r.headCount}: ${J(r.heads)}`);
    check(`[${theme}] the 6th header reads "Value", and no header reads "ADP"`,
      r.heads[5] === 'Value' && !r.heads.includes('ADP'), J(r.heads));

    // 2. Flagged, both directions.
    check(`[${theme}] ${EARLY.name} (gap ${EARLY.gap}) renders .market-badge.early "${EARLY.text}"`,
      r.early.text === EARLY.text && r.early.badge === 'market-badge early', J(r.early));
    check(`[${theme}] ${LATE.name} (gap +${LATE.gap}) renders .market-badge.late "${LATE.text}"`,
      r.late.text === LATE.text && /\blate\b/.test(r.late.badge || '')
        && !/\bearly\b/.test(r.late.badge || ''), J(r.late));

    // 2b. The colour claim itself. Class assertions above pass on the base
    //     `.market-badge` rule alone -- className is unaffected by CSS -- so
    //     deleting `.market-badge.early`'s background slips through check 2
    //     entirely and through the contrast floor too (the grey fallback is
    //     MORE legible than the red). Assert both the specific colour AND the
    //     inequality: the inequality alone would still pass if early were
    //     recoloured to match late instead of being deleted.
    check(`[${theme}] ${EARLY.name}'s .market-badge.early is filled with the critical red (${CRITICAL_RED})`,
      r.early.badgeBg === CRITICAL_RED, `saw ${J(r.early.badgeBg)}`);
    check(`[${theme}] the early and late badges have DIFFERENT backgrounds`,
      r.early.badgeBg !== null && r.late.badgeBg !== null && r.early.badgeBg !== r.late.badgeBg,
      `early ${J(r.early.badgeBg)} vs late ${J(r.late.badgeBg)}`);

    // 3. Below the flag threshold: SAME wording, no badge. Both directions, since
    //    a badge-everything regression and a wording regression are different
    //    defects.
    for (const e of [PLAIN_EARLY, PLAIN_LATE]) {
      const info = e === PLAIN_EARLY ? r.plainEarly : r.plainLate;
      check(`[${theme}] ${e.name} (gap ${e.gap}, below the flag at ${FLAG_AT}) reads "${e.text}" with NO badge`,
        info.text === e.text && info.badge === null && info.plain === true, J(info));
    }

    // 4. The CSV's literal "-".
    check(`[${theme}] ${NO_DATA.name} (CSV gap "-") renders a completely empty cell`,
      r.noData.located && r.noData.text === '' && r.noData.kids === 0, J(r.noData));

    // 5. The sign sweep, with its own non-vacuity guard.
    check(`[${theme}] the sweep looked at all ${EXPECT_PLAYERS} Value cells`,
      r.sweep.swept === EXPECT_PLAYERS, `swept ${r.sweep.swept}`);
    check(`[${theme}] no raw sign ([-+−]) anywhere in any Value cell`,
      r.sweep.hitCount === 0, `${r.sweep.hitCount} hit(s): ${J(r.sweep.hits)}`);
    check(`[${theme}] both flag directions are actually on this board`,
      r.earlyBadges > 0 && r.lateBadges > 0,
      `${r.earlyBadges} early, ${r.lateBadges} late`);

    // 9. Contrast, on the real painted backgrounds. Labelled by the class
    //    actually found on the row rather than by an assumed selector: under
    //    a mutation that moves a badge's class (e.g. #3, hardcoded to
    //    `late`), the element sitting in "the early row" is not necessarily
    //    `.market-badge.early`, and a hardcoded label would keep reporting
    //    the old name over the wrong element's number.
    const contrastTargets = [
      { name: `${EARLY.name}'s badge`, cls: r.early.badge, value: r.early.badgeContrast },
      { name: `${LATE.name}'s badge`, cls: r.late.badge, value: r.late.badgeContrast },
      { name: '.market-plain (unflagged text)', cls: null, value: r.plainEarly.plainContrast },
    ];
    for (const t of contrastTargets) {
      check(`[${theme}] ${t.name}${t.cls ? ` (${t.cls})` : ''} is legible (>= ${MIN_CONTRAST}:1)`,
        t.value !== null && t.value >= MIN_CONTRAST,
        t.value === null ? 'nothing to measure' : `${t.value.toFixed(2)}:1`);
    }
    console.log(`      measured: early ${fmt(contrastTargets[0].value)},` +
      ` late ${fmt(contrastTargets[1].value)},` +
      ` plain ${fmt(contrastTargets[2].value)};` +
      ` badges ${r.badgeTotal} (${r.earlyBadges} early / ${r.lateBadges} late) of ${r.rows} rows;` +
      ` early bg ${r.early.badgeBg}, late bg ${r.late.badgeBg}`);
    return {
      panelBg: r.panelBg,
      contrast: { early: contrastTargets[0].value, late: contrastTargets[1].value, plain: contrastTargets[2].value },
    };
  }

  // --------------------------------------------------- 6: the colspan="9" rows
  async function colspanChecks(theme) {
    for (const [label, state, selector] of [
      ['need notice', NEED_NOTICE, '.need-notice'],
      ['position-limit divider', LIMIT, '.limit-divider'],
    ]) {
      where = `colspan ${label}/${theme}`;
      await load(page, server.origin, state, theme);
      const r = await probe(page, `
        const row = colspanRow(${J(selector)});
        return {
          row,
          excluded: document.querySelectorAll('table.players tbody tr.limit-excluded').length,
          rows: playerRows().length,
        };
      `);
      // Non-vacuity: the row has to be ON SCREEN. A "every colspan is 9" sweep
      // over a board that renders neither row passes over an empty list.
      check(`[${theme}] the ${label} row actually renders`, r.row.present,
        `no tr${selector}; ${r.rows} player row(s), ${r.excluded} excluded`);
      check(`[${theme}] the ${label} still spans 9 columns`, r.row.colspan === '9',
        `colspan=${J(r.row.colspan)}`);
      check(`[${theme}] the ${label} spans the full table width`,
        r.row.width !== null && Math.abs(r.row.width - r.row.rowWidth) < 1.5,
        `td ${r.row.width}px vs row ${r.row.rowWidth}px`);
      if (selector === '.limit-divider') {
        check(`[${theme}] the divider has excluded rows beneath it to divide`,
          r.excluded > 0, `${r.excluded} .limit-excluded row(s)`);
      }
    }
  }

  // ------------------------------------------------- 7, 8, 9: the Glance line
  async function glanceChecks(theme) {
    where = `glance flagged/${theme}`;
    await load(page, server.origin, GLANCE_FLAGGED, theme);
    const f = await probe(page, 'return glanceInfo();');

    check(`[${theme}] the Glance card rendered real advice (TAKE + two THEN)`,
      f.hasCard && f.pickCount === 3, `card=${f.hasCard}, .glance-pick=${f.pickCount}`);
    check(`[${theme}] the flagged fixture's TAKE is ${TAKE_FLAGGED.name}`,
      (f.picks[0] || {}).name === TAKE_FLAGGED.name, J((f.picks[0] || {}).name));
    // 7. The long form, on TAKE, when flagged.
    check(`[${theme}] a flagged TAKE renders exactly one .glance-pick-market, in the TAKE`,
      f.marketCount === 1 && (f.picks[0] || {}).market?.length === 1, J(f.marketText));
    check(`[${theme}] its text is marketNote's long form, verbatim`,
      f.marketText[0] === TAKE_FLAGGED.long,
      `${J(f.marketText[0])} != ${J(TAKE_FLAGGED.long)}`);
    check(`[${theme}] it is the last line of the card's TAKE block`, f.marketIsLast === true,
      `marketIsLast=${f.marketIsLast}`);

    // 8. NO market line on THEN, however large the gap — and the guard that makes
    //    that claim mean something. entry.byeWarning deliberately still renders on
    //    THEN, so nothing here asserts THEN is line-free in general.
    const thenGaps = f.thenPicks.map((p) => ({
      name: p.name, gap: (byName(p.name) || {}).ecrVsAdp ?? null,
    }));
    const flaggedThen = thenGaps.filter((t) => Number.isFinite(t.gap) && Math.abs(t.gap) >= FLAG_AT);
    check(`[${theme}] at least one THEN entry has a FLAGGED gap (else check 8 is vacuous)`,
      flaggedThen.length > 0, J(thenGaps));
    check(`[${theme}] no .glance-pick-market on any THEN entry, however large the gap`,
      f.thenMarket === 0, `${f.thenMarket} line(s) on THEN ${J(thenGaps)}`);

    // 9. Contrast of the Glance line.
    check(`[${theme}] .glance-pick-market is legible on the card (>= ${MIN_CONTRAST}:1)`,
      f.marketContrast !== null && f.marketContrast >= MIN_CONTRAST, fmt(f.marketContrast));
    console.log(`      measured: .glance-pick-market ${fmt(f.marketContrast)} on card ${f.cardBg};` +
      ` THEN gaps ${J(thenGaps)}`);

    // 7 (the other half). An UNFLAGGED TAKE gets no line at all.
    where = `glance unflagged/${theme}`;
    await load(page, server.origin, GLANCE_UNFLAGGED, theme);
    const u = await probe(page, 'return glanceInfo();');
    check(`[${theme}] the unflagged fixture's TAKE is ${TAKE_UNFLAGGED.name} (gap ${TAKE_UNFLAGGED.gap})`,
      (u.picks[0] || {}).name === TAKE_UNFLAGGED.name
        && ((byName(TAKE_UNFLAGGED.name) || {}).ecrVsAdp ?? null) === TAKE_UNFLAGGED.gap,
      J((u.picks[0] || {}).name));
    check(`[${theme}] the Glance card still rendered advice for the unflagged fixture`,
      u.hasCard && u.pickCount === 3, `card=${u.hasCard}, .glance-pick=${u.pickCount}`);
    check(`[${theme}] an unflagged TAKE renders NO .glance-pick-market anywhere`,
      u.marketCount === 0, J(u.marketText));
    return { cardBg: f.cardBg, contrast: f.marketContrast };
  }

  // ------------------------------------------------------- 10: phone viewport
  async function phoneChecks(theme) {
    where = `phone/${theme}`;
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: PHONE.width, height: PHONE.height, deviceScaleFactor: 1, mobile: false,
    });
    await load(page, server.origin, BOARD, theme);
    const r = await probe(page, `
      const table = document.querySelector('table.players');
      const wrap = document.querySelector('.table-wrap');
      const de = document.documentElement;
      return {
        innerWidth: window.innerWidth,
        rows: playerRows().length,
        table: table ? Math.round(table.getBoundingClientRect().width) : null,
        wrapScroll: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
        docOverflow: de.scrollWidth - de.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      };
    `);
    check(`[${theme}] the phone viewport is ${PHONE.width}px wide with the board rendered`,
      r.innerWidth === PHONE.width && r.rows === EXPECT_PLAYERS,
      `innerWidth=${r.innerWidth}, rows=${r.rows}`);
    check(`[${theme}] the table is ${PHONE.table}px wide (+/-${PHONE.tol})`,
      r.table !== null && Math.abs(r.table - PHONE.table) <= PHONE.tol, `${r.table}px`);
    check(`[${theme}] the overflow is INSIDE .table-wrap: ${PHONE.wrapScroll}px of hidden scroll (+/-${PHONE.tol})`,
      r.wrapScroll !== null && Math.abs(r.wrapScroll - PHONE.wrapScroll) <= PHONE.tol,
      `${r.wrapScroll}px`);
    // "0px of overflow" passes vacuously on a blank page: with rendering
    // broken, rows=0 and both of these would still be 0. Gated on the board
    // actually having rendered, so a broken render fails HERE too rather than
    // only on the row-count check above.
    const rendered = r.rows === EXPECT_PLAYERS;
    check(`[${theme}] documentElement has 0px of horizontal overflow`,
      rendered && r.docOverflow === 0, `rows=${r.rows}, overflow=${r.docOverflow}px`);
    check(`[${theme}] body has 0px of horizontal overflow`,
      rendered && r.bodyOverflow === 0, `rows=${r.rows}, overflow=${r.bodyOverflow}px`);
    console.log(`      measured: table ${r.table}px, .table-wrap hidden scroll ${r.wrapScroll}px,` +
      ` page overflow ${r.docOverflow}/${r.bodyOverflow}px at ${r.innerWidth}x${PHONE.height}`);
    await page.send('Emulation.setDeviceMetricsOverride', {
      ...DESKTOP, deviceScaleFactor: 1, mobile: false,
    });
  }

  console.log('');
  const paint = {};
  for (const theme of THEMES) {
    const board = await boardChecks(theme);
    paint[theme] = board.panelBg;
    await colspanChecks(theme);
    await glanceChecks(theme);
    await phoneChecks(theme);
    console.log('');
  }

  // Without this, "both themes" could be one theme measured twice: a silently
  // failed theme seed would render dark both times and every contrast figure
  // above would be the same number.
  check(`the two themes really rendered differently (panel ${paint.dark} vs ${paint.light})`,
    !!paint.dark && !!paint.light && paint.dark !== paint.light,
    `${paint.dark} == ${paint.light}`);

  // 11. Console, collected from the first load onward across every fixture and
  //     both themes.
  check(`the console stayed clean across every fixture in both themes`,
    consoleNoise.length === 0, `${consoleNoise.length} entr(ies):\n      ${consoleNoise.join('\n      ')}`);
} finally {
  if (page) page.close();
  if (chrome) chrome.proc.kill('SIGKILL');
  if (server) server.server.close();
  rmSync(profile, { recursive: true, force: true });
}
} catch (err) {
  if (err instanceof CsvFixtureMismatch) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}

function fmt(v) { return v === null || v === undefined ? 'n/a' : `${v.toFixed(2)}:1`; }

console.log(failures === 0 ? '\nmarket signal UI verified' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
