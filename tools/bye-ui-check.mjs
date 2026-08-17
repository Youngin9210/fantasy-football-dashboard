// Proves the bye-conflict UI actually renders, in both themes, and that it does
// NOT render where there is nothing to warn about.
//
// Why this file exists: `node tools/screenshot-diff.mjs --ref 5e598a8` passed
// 16/16 scenarios at ZERO differing pixels across the commit that added this
// entire feature. That read as strong evidence and was not — harness.mjs's BOARD
// fixture had no stacked bye at any position (QB byes 7/14/10/6, exactly one RB,
// WR, TE, K and DST), so no candidate ever had a non-zero AVOIDABLE shortfall,
// no badge ever rendered, and the whole bye UI could have been deleted without
// moving a pixel. That was the fifth verification tool on this project to pass
// while blind to what it claimed to cover. harness.mjs now carries a stacked-bye
// scenario (see STACKED_BYE) so the pixel diff can see the feature; this file
// asserts the things a pixel diff cannot state in words.
//
// Unit tests on avoidableByeShortfall are not evidence that anything is on
// screen. The failures this guards against are: the badge not rendering; the
// ${' '} separator between the two Board badges being dropped (htm discards
// whitespace-only text nodes, so they render flush against each other and read as
// one word); the Glance line being illegible in one of the two themes (its first
// version measured 9.49:1 dark and 1.79:1 light, caught only by measuring both);
// and the missing-bye notice firing when the weighting is in fact running.
//
// Deliberately in tools/, not test/: `node --test` collects every .js file under
// a directory named `test`, and this drives a real browser. Same shape and same
// plumbing as tools/stale-check.mjs — serve, launchChrome, Page and the scenarios
// all come from tools/harness.mjs, so this cannot drift away from what
// screenshot-diff.mjs renders.
//
// Usage: node tools/bye-ui-check.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serve, launchChrome, Page, STORAGE_KEY, THEME_KEY, SCENARIOS, STACKED_BYE,
} from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const J = JSON.stringify;
const THEMES = ['dark', 'light'];

// WCAG AA for normal text. Both badges measure ~10.7:1 by construction (fixed
// #0b0b0b ink on --status-warning, which is the same amber in both :root blocks),
// so this threshold is nowhere near the real value — it is here to catch the
// no-background regression, which lands at 1.79:1 on the light card.
const MIN_CONTRAST = 4.5;

// The ${' '} separator between the two Board badges measures ~3.8px at the
// table's font size and EXACTLY 0 without it, since htm drops whitespace-only
// text nodes. The window is wide on both sides: the point is "a real space is
// there", not a pixel-perfect width, and a margin/padding change that happened to
// separate them would be a different (acceptable) implementation.
const MIN_GAP = 1.5;
const MAX_GAP = 12;

// ------------------------------------------------------------------- fixtures

const SCENARIO = SCENARIOS.find((s) => s.name === STACKED_BYE.scenario);
if (!SCENARIO) {
  throw new Error(`harness.mjs no longer exports the "${STACKED_BYE.scenario}" scenario`);
}
const BOARD_STATE = SCENARIO.state;
const glance = (state) => ({ ...state, settings: { ...state.settings, view: 'glance' } });
const GLANCE_STATE = glance(BOARD_STATE);

// The honest case for the missing-bye notice: a CSV with no bye column at all, so
// nothing anywhere carries a bye and the weighting really does contribute nothing.
const NO_BYES_ANYWHERE = glance({
  ...BOARD_STATE, players: BOARD_STATE.players.map((p) => ({ ...p, bye: null })),
});

// The case the notice used to get WRONG: only the OWNER's players lack byes, which
// is what an unmatched Sleeper pick produces (pickToManualPlayer sets bye: null).
// The board is untouched, so the weighting is running normally for every candidate
// on it and the notice must stay silent. Only drafted players are mine here — the
// stacked scenario drafts sr1 and sr2 to t0 and nothing to anyone else.
const NULL_BYE_ROSTER = glance({
  ...BOARD_STATE,
  players: BOARD_STATE.players.map((p) => (p.drafted ? { ...p, bye: null } : p)),
});

// ------------------------------------------------------------- in-page helpers

const PAGE_HELPERS = String.raw`
function _chan(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _lum(rgb) { return 0.2126 * _chan(rgb[0]) + 0.7152 * _chan(rgb[1]) + 0.0722 * _chan(rgb[2]); }
function _rgba(str) {
  const m = String(str).match(/-?[\d.]+/g);
  if (!m) return null;
  const n = m.map(Number);
  return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 };
}

// The first box that actually PAINTS, starting with the element itself: an opaque
// badge is measured against its own background, and a badge with no background of
// its own is measured against whatever shows through it — which is how the
// original background-less .glance-pick-bye (amber text on the near-white light
// card, 1.79:1) gets caught here rather than passing at its dark-theme 9.49:1.
function _bg(el) {
  for (let n = el; n; n = n.parentElement) {
    const p = _rgba(getComputedStyle(n).backgroundColor);
    if (p && p.a > 0) return p.rgb;
  }
  return [255, 255, 255];
}

function contrast(el) {
  const fg = _rgba(getComputedStyle(el).color);
  if (!fg) return null;
  const a = _lum(fg.rgb);
  const b = _lum(_bg(el));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rowFor(name) {
  return [...document.querySelectorAll('table.players tbody tr')]
    .find((tr) => {
      const cell = tr.querySelector('.player-name');
      return cell && cell.textContent.trim() === name;
    }) || null;
}

function badgesIn(row) { return row ? [...row.querySelectorAll('.why-badge')] : []; }

// The notice has no class of its own — it is a .glance-needs like the STILL NEED
// line — so it is identified by the words it claims, the same way stale-check.mjs
// identifies the stale banner by "NOT SYNCING".
function byeNotice() {
  return [...document.querySelectorAll('.glance-needs')]
    .map((el) => el.textContent)
    .find((t) => /not being weighted/i.test(t)) || null;
}
`;

// ---------------------------------------------------------------- test harness

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures += 1;
}

const nextFrames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

// Seeded from a 404 on the SAME origin rather than from the app itself: useTheme
// reads ffTheme at mount and writes it back in an effect, so a seed written
// underneath a running app is silently clobbered and the next load renders the
// PREVIOUS theme. Identical reasoning to screenshot-diff.mjs's shoot().
async function load(page, origin, state, theme) {
  await page.goto(`${origin}/__seed__`);
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem(${J(STORAGE_KEY)}, ${J(JSON.stringify(state))});
    localStorage.setItem(${J(THEME_KEY)}, ${J(theme)});
  })()`);
  await page.goto(`${origin}/`);
  await page.eval(nextFrames, { awaitPromise: true });
}

const probe = (page, body) => page.eval(`(() => { ${PAGE_HELPERS}\n${body} })()`);

// ---------------------------------------------------------------------- checks

async function boardChecks(page, origin, theme) {
  await load(page, origin, BOARD_STATE, theme);
  const r = await probe(page, `
    const badgedRow = rowFor(${J(STACKED_BYE.badged.name)});
    const plainRow = rowFor(${J(STACKED_BYE.unbadged.name)});
    const badges = badgesIn(badgedRow);
    const bye = badges.filter((el) => el.classList.contains('bye'));
    let gap = null;
    let sameLine = null;
    if (badges.length >= 2) {
      const a = badges[0].getBoundingClientRect();
      const b = badges[1].getBoundingClientRect();
      gap = b.left - a.right;
      sameLine = Math.abs(b.top - a.top) < 1;
    }
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      rows: document.querySelectorAll('table.players tbody tr').length,
      onBoard: !!document.querySelector('main.layout'),
      foundBadged: !!badgedRow,
      foundPlain: !!plainRow,
      badgeCount: badges.length,
      badgeText: badges.map((el) => el.textContent),
      byeCount: bye.length,
      byeText: bye.length ? bye[0].textContent : null,
      byeContrast: bye.length ? contrast(bye[0]) : null,
      gap,
      sameLine,
      plainBadges: badgesIn(plainRow).length,
      plainByes: badgesIn(plainRow).filter((el) => el.classList.contains('bye')).length,
      boardByes: document.querySelectorAll('table.players .why-badge.bye').length,
    };
  `);

  // Vacuity first: none of the assertions below mean anything if the Board did
  // not render, if the theme seed did not take, or if the fixture's two rows are
  // not on screen.
  check(`[${theme}] the Board rendered with rows`, r.onBoard && r.rows > 0,
    `main.layout=${r.onBoard}, rows=${r.rows}`);
  check(`[${theme}] data-theme is "${theme}"`, r.theme === theme, `saw ${J(r.theme)}`);
  check(`[${theme}] the badged candidate's row is on screen`, r.foundBadged,
    `no row named ${J(STACKED_BYE.badged.name)}`);
  check(`[${theme}] the zero-shortfall candidate's row is on screen`, r.foundPlain,
    `no row named ${J(STACKED_BYE.unbadged.name)}`);

  check(`[${theme}] a .why-badge.bye renders for a non-zero avoidable shortfall`,
    r.byeCount === 1, `${r.byeCount} bye badge(s) in the row; badges=${J(r.badgeText)}`);
  check(`[${theme}] its text is the scorer's, verbatim`,
    r.byeText === STACKED_BYE.badged.badge,
    `${J(r.byeText)} != ${J(STACKED_BYE.badged.badge)}`);
  check(`[${theme}] no .why-badge.bye for a candidate whose avoidable shortfall is 0`,
    r.plainBadges >= 1 && r.plainByes === 0,
    `${r.plainBadges} badge(s), ${r.plainByes} of them bye`);
  check(`[${theme}] exactly ${STACKED_BYE.expectedBadges} bye badge on the whole board`,
    r.boardByes === STACKED_BYE.expectedBadges, `saw ${r.boardByes}`);

  // The ${' '} separator. Measured, not read: it is invisible in source review and
  // its absence is invisible in a screenshot diff of a board that never badges.
  check(`[${theme}] the two badges share one line`, r.sameLine === true, `sameLine=${r.sameLine}`);
  check(`[${theme}] the two badges are separated by a real space`,
    r.gap !== null && r.gap >= MIN_GAP && r.gap <= MAX_GAP,
    `gap=${r.gap === null ? 'n/a (fewer than two badges)' : `${r.gap.toFixed(2)}px`}` +
    `, want ${MIN_GAP}..${MAX_GAP}px` +
    ` (0px means the \${' '} separator is gone)`);

  check(`[${theme}] the bye badge is legible`,
    r.byeContrast !== null && r.byeContrast >= MIN_CONTRAST,
    `${r.byeContrast === null ? 'no badge to measure' : `${r.byeContrast.toFixed(2)}:1`}`);

  // Printed on PASS as well as FAIL: a check whose measurements are invisible is
  // hard to distinguish from one that measured nothing.
  console.log(`      measured: badge gap ${r.gap === null ? 'n/a' : `${r.gap.toFixed(2)}px`},` +
    ` bye badge contrast ${r.byeContrast === null ? 'n/a' : `${r.byeContrast.toFixed(2)}:1`}`);
}

async function glanceChecks(page, origin, theme) {
  await load(page, origin, GLANCE_STATE, theme);
  const r = await probe(page, `
    const line = document.querySelectorAll('.glance-pick-bye');
    const card = document.querySelector('.glance-card');
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      hasCard: !!card,
      picks: document.querySelectorAll('.glance-pick').length,
      count: line.length,
      text: line.length ? line[0].textContent : null,
      contrast: line.length ? contrast(line[0]) : null,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      notice: byeNotice(),
    };
  `);

  // A Glance card with no .glance-pick in it is a notice ("import rankings"),
  // which would satisfy "no bye line" for entirely the wrong reason.
  check(`[${theme}] the Glance card rendered actual advice`, r.hasCard && r.picks > 0,
    `card=${r.hasCard}, .glance-pick=${r.picks}`);
  check(`[${theme}] data-theme is "${theme}"`, r.theme === theme, `saw ${J(r.theme)}`);
  check(`[${theme}] a .glance-pick-bye line renders`, r.count === 1, `saw ${r.count}`);
  check(`[${theme}] its text matches the Board badge, verbatim`,
    r.text === STACKED_BYE.badged.badge, `${J(r.text)} != ${J(STACKED_BYE.badged.badge)}`);
  check(`[${theme}] the Glance bye line is legible on the card`,
    r.contrast !== null && r.contrast >= MIN_CONTRAST,
    `${r.contrast === null ? 'no line to measure' : `${r.contrast.toFixed(2)}:1`}` +
    `, want >= ${MIN_CONTRAST}:1`);
  check(`[${theme}] no missing-bye notice on a board that has byes`, r.notice === null,
    J(r.notice));
  console.log(`      measured: glance bye line contrast ` +
    `${r.contrast === null ? 'n/a' : `${r.contrast.toFixed(2)}:1`} on card ${r.cardBg}`);
  return r.cardBg;
}

async function noticeChecks(page, origin) {
  // 1. The claim the message actually makes: nothing anywhere carries a bye.
  await load(page, origin, NO_BYES_ANYWHERE, 'dark');
  const inert = await probe(page, `return {
    picks: document.querySelectorAll('.glance-pick').length,
    notice: byeNotice(),
    byeLines: document.querySelectorAll('.glance-pick-bye').length,
  };`);
  check('a board with no byes at all still gives advice', inert.picks > 0, `picks=${inert.picks}`);
  check('the missing-bye notice appears when no bye exists anywhere',
    inert.notice !== null && /not being weighted/.test(inert.notice || ''), J(inert.notice));
  check('nothing is badged when there are no byes to clash',
    inert.byeLines === 0, `${inert.byeLines} bye line(s)`);

  // 2. The case the roster-only gate got WRONG. Every player the owner holds has
  //    bye: null — exactly what unmatched Sleeper picks produce, and completely
  //    ordinary one pick into a synced draft — while the board is full of byes and
  //    the weighting is running normally for every candidate on it. Claiming
  //    "bye conflicts are not being weighted" here is a lie.
  await load(page, origin, NULL_BYE_ROSTER, 'dark');
  const lying = await probe(page, `return {
    picks: document.querySelectorAll('.glance-pick').length,
    notice: byeNotice(),
  };`);
  check('a null-bye roster on a board WITH byes still gives advice',
    lying.picks > 0, `picks=${lying.picks}`);
  check('no missing-bye notice for a null-bye roster on a board that has byes',
    lying.notice === null, J(lying.notice));
}

// ------------------------------------------------------------------------ main

const profile = mkdtempSync(join(tmpdir(), 'bye-ui-chrome-'));
let server;
let chrome;
let page;
try {
  server = await serve(ROOT);
  chrome = await launchChrome(profile);
  page = await Page.open(chrome.host, 'about:blank');
  // Both themes get laid out at the same width, so the badge-gap measurement is
  // not a measurement of the default window size.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  const cardBg = {};
  for (const theme of THEMES) {
    await boardChecks(page, server.origin, theme);
    cardBg[theme] = await glanceChecks(page, server.origin, theme);
    console.log('');
  }

  // Without this, "legible in BOTH themes" could be one theme measured twice: if
  // the theme seed silently failed, both passes would render dark and both
  // contrast numbers would be the same number.
  check(`the two themes really rendered differently (card ${cardBg.dark} vs ${cardBg.light})`,
    !!cardBg.dark && !!cardBg.light && cardBg.dark !== cardBg.light,
    `${cardBg.dark} == ${cardBg.light}`);
  console.log('');

  await noticeChecks(page, server.origin);
} finally {
  if (page) page.close();
  if (chrome) chrome.proc.kill('SIGKILL');
  if (server) server.server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nbye-conflict UI verified' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
