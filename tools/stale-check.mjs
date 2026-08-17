// Proves the stale-sync warning actually renders, in BOTH views. A unit test on
// the classifier (test/glance.test.js) is not evidence that the UI warns — the
// failure this guards against is a rendered view giving confident advice off a
// board that stopped updating.
//
// The Board half was added after the Board's top bar was found asserting a green
// "Sleeper synced" with zero evidence: SyncStatus read only `status.ok`, which
// useSleeperSync seeds `true` before the first poll is even attempted, so the
// Board reassured the user at t=0 and still at t=30s with no poll ever having
// completed, while Glance on the identical status object read "NOT SYNCING".
// Checking one view was never enough — the two views must agree, and the only way
// to know they do is to ask both about the same page state.
//
// Deliberately in tools/, not test/: `node --test` collects every .js file under
// a directory named `test`, and this check costs ~30s of wall clock by design.
//
// Usage: node tools/stale-check.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launchChrome, Page, STORAGE_KEY, SCENARIOS } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real values in js/ui/glance.js and js/sleeper.js. Read, never written:
// shortening STALE_AFTER_MS to speed this up would verify a different program
// than the one that ships.
const STALE_AFTER_MS = 20000;
const SETTLE_MS = 5000; // slack over the threshold for the 1s re-render tick

// Rankings, ten teams, my team chosen, sync on, Glance selected. Built from the
// harness scenario that already has a board and a selected team so the two files
// cannot drift apart; only the sync/view settings are layered on.
const SCENARIO = SCENARIOS.find((s) => s.name === 'rankings, team selected, need mode');
if (!SCENARIO) throw new Error('harness.mjs no longer exports the expected scenario');
const SEED = {
  ...SCENARIO.state,
  settings: {
    ...SCENARIO.state.settings,
    myTeamId: 't0',
    sleeperSyncEnabled: true,
    sleeperDraftId: 'd1',
    view: 'glance',
  },
};

// Set in localStorage to make EVERY picks request hang, including the first, so
// no poll ever completes. That is the "asserted with zero evidence" state — the
// one the Board used to render green — and it needs no waiting at all, because
// there is no timestamp to age out.
const HANG_ALL_KEY = '__staleCheckHangAllPolls';

// Installed before any app code runs. One picks response resolves, then all
// later ones hang — so `status.at` stops advancing exactly as a dead network
// would make it, without touching the app's own timing constants. With
// HANG_ALL_KEY set, even the first one hangs.
//
// The seed is written only when the key is ABSENT. This script runs on every
// navigation, and later steps work by editing the saved state and reloading: an
// unconditional write would stomp those edits back to the seed and the
// assertions would be testing nothing (they would just fail, or worse, pass for
// an unrelated reason).
const STUB = `
  (() => {
    const KEY = ${JSON.stringify(STORAGE_KEY)};
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, ${JSON.stringify(JSON.stringify(SEED))});
    }
    const hangAll = localStorage.getItem(${JSON.stringify(HANG_ALL_KEY)}) === '1';
    let served = 0;
    const real = window.fetch.bind(window);
    window.fetch = (url, ...rest) => {
      const u = String(url);
      if (u.includes('api.sleeper.app') && u.includes('/picks')) {
        served += 1;
        if (hangAll || served > 1) return new Promise(() => {});   // hang forever
        return Promise.resolve(new Response('[]', { status: 200 }));
      }
      if (u.includes('api.sleeper.app')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return real(url, ...rest);
    };
  })();
`;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures += 1;
}

// Polls the page rather than sleeping a guessed amount. Never used to get under
// a threshold — only to avoid depending on how fast a machine paints.
async function waitFor(page, expression, { timeout = 15000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.eval(expression)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(every);
  }
}

const CARD_TEXT = `document.querySelector('.glance-card')?.textContent || '(no .glance-card)'`;
// The Board's top-bar sync indicator, read the way a user reads it.
const BAR = `(() => {
  const el = document.getElementById('syncStatus');
  if (!el) return { present: false };
  return {
    present: true,
    text: el.textContent.trim(),
    stale: el.classList.contains('stale'),
    okDot: !!el.querySelector('.sync-dot.ok'),
    errorDot: !!el.querySelector('.sync-dot.error'),
    // Proof we are looking at the Board and not at Glance's empty placeholder.
    isBoard: !!document.querySelector('main.layout'),
  };
})()`;

// Both views are seeded through settings.view rather than by clicking, except
// where the point is that the two views agree about ONE page state — there the
// real #viewToggle button is driven, because a reload would restart the poller
// and hand the second view a different status object.
async function showView(page, want) {
  await page.eval(`(() => {
    const toggle = document.getElementById('viewToggle');
    if (!toggle) throw new Error('#viewToggle is missing');
    const want = ${JSON.stringify(want)};
    const btn = [...toggle.querySelectorAll('button')]
      .find((b) => b.textContent.trim().toLowerCase() === want);
    if (!btn) throw new Error('#viewToggle has no "' + want + '" button');
    btn.click();
  })()`);
  await sleep(300);
}

const profile = mkdtempSync(join(tmpdir(), 'stale-chrome-'));
let server, chrome, page;
try {
  server = await serve(ROOT);
  chrome = await launchChrome(profile, [
    // A hidden target still clamps timers to 1s, which our 1s re-render and 6s
    // poll would survive — but not being throttled at all removes the question.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]);
  page = await Page.open(chrome.host, 'about:blank');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

  // 0. THE BOARD, WITH NO EVIDENCE AT ALL. Every picks request hangs, including
  //    the first, so no poll ever completes and `status.at` is never set — while
  //    useSleeperSync's seeded `{ ok: true }` says "fine". This is the exact state
  //    the Board rendered as a green "Sleeper synced" for, and it needs no
  //    waiting: absence of a timestamp is stale immediately, by definition.
  //    Navigating to the 404 first lets the stub seed localStorage before the app
  //    ever runs, so this phase can layer the view and the hang-all flag on top.
  await page.goto(`${server.origin}/__seed__`);
  await page.eval(`(() => {
    localStorage.setItem(${JSON.stringify(HANG_ALL_KEY)}, '1');
    const s = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    s.settings.view = 'board';
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(s));
  })()`);
  await page.goto(`${server.origin}/index.html`);
  await waitFor(page, `!!document.querySelector('main.layout')`);
  const noEvidence = await page.eval(BAR);
  check('the board renders its sync indicator at all', noEvidence.present,
    JSON.stringify(noEvidence));
  check('the board is the view under test', noEvidence.isBoard, JSON.stringify(noEvidence));
  check('the board does NOT claim "Sleeper synced" before any poll completes',
    !/synced/i.test(noEvidence.text), JSON.stringify(noEvidence));
  check('the board shows no healthy dot before any poll completes',
    !noEvidence.okDot, JSON.stringify(noEvidence));
  check('the board warns instead, on the .stale idiom',
    noEvidence.stale && noEvidence.text.includes('NOT SYNCING'), JSON.stringify(noEvidence));

  // Back to a first-poll-succeeds world, and to Glance, for the original checks.
  await page.eval(`(() => {
    localStorage.removeItem(${JSON.stringify(HANG_ALL_KEY)});
    const s = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    s.settings.view = 'glance';
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(s));
  })()`);
  await page.goto(`${server.origin}/index.html`);

  // 1. A poll must succeed FIRST. Without this, a card that never synced at all
  //    would also read stale, and the stale assertion would prove nothing.
  //    Waits for the HEALTHY DOT, not merely for .glance-sync to exist: with no
  //    completed poll the card already renders a .glance-sync — the stale banner —
  //    so the looser condition was satisfied at t=0 and this step raced the very
  //    first fetch, passing only when the stub's response happened to land inside
  //    one round trip. Waiting for the thing the step is actually about removes
  //    the race without weakening anything.
  const rendered = await waitFor(page, `!!document.querySelector('.glance-sync .sync-dot.ok')`);
  if (!rendered) console.log(`      card text: ${await page.eval(CARD_TEXT)}`);
  const fresh = await page.eval(`document.querySelector('.glance-sync')?.textContent || ''`);
  check('card reads synced after the first poll', /synced/i.test(fresh), JSON.stringify(fresh));
  check('healthy dot is present',
    await page.eval(`!!document.querySelector('.glance-sync .sync-dot.ok')`));

  // 1b. And the BOARD must go green in this state. Without this assertion the
  //     whole Board half above would be satisfied by a top bar that warns
  //     unconditionally — which is a different lie, not a fix. Toggled rather
  //     than reloaded, again, so both views are judging one status object.
  await showView(page, 'board');
  const barFresh = await page.eval(BAR);
  check('the board is showing after the toggle (fresh)', barFresh.isBoard, JSON.stringify(barFresh));
  check('the board reads healthy after a poll actually completed',
    /synced/i.test(barFresh.text) && barFresh.okDot && !barFresh.stale, JSON.stringify(barFresh));
  await showView(page, 'glance');

  // 2. Every later poll hangs, so no callback fires and `at` freezes. Wait past
  //    the real 20s threshold — do NOT shorten STALE_AFTER_MS to speed this up,
  //    that would test a different program than the one that ships.
  console.log(`      waiting ${(STALE_AFTER_MS + SETTLE_MS) / 1000}s past the real threshold...`);
  await sleep(STALE_AFTER_MS + SETTLE_MS);
  const stale = await page.eval(`document.querySelector('.glance-sync.stale')?.textContent || ''`);
  check('stale banner appears', stale.includes('NOT SYNCING'),
    `${JSON.stringify(stale)}; sync line = ${JSON.stringify(
      await page.eval(`document.querySelector('.glance-sync')?.textContent || '(none)'`))}`);

  // 2b. THE TWO VIEWS MUST AGREE ABOUT THE SAME PAGE STATE. Toggled, not
  //     reloaded: a reload restarts the poller and would hand the Board a fresh
  //     status object, which is a different question. This is the contradiction
  //     that motivated the fix — at this exact moment the Board used to read a
  //     green "Sleeper synced" while the card above read "NOT SYNCING".
  await showView(page, 'board');
  const barStale = await page.eval(BAR);
  check('the board is showing after the toggle', barStale.isBoard, JSON.stringify(barStale));
  check('the board agrees the sync is stale', barStale.stale
    && barStale.text.includes('NOT SYNCING') && !barStale.okDot, JSON.stringify(barStale));
  check('the board does not contradict the card', !/synced/i.test(barStale.text),
    JSON.stringify(barStale));

  // 3. With sync off there is nothing to be healthy, so nothing should render.
  //    view is forced back to glance because 2b clicked the Board button and that
  //    choice persists; without this the card assertions below would be looking
  //    at a page that renders no card at all.
  await page.eval(`(() => {
    const s = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    s.settings.sleeperSyncEnabled = false;
    s.settings.view = 'glance';
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(s));
  })()`);
  await page.goto(`${server.origin}/index.html`);
  // The card itself must be there, or "no sync line" would pass for the wrong
  // reason — a broken seed renders a .glance-notice with no sync line either.
  const cardBack = await waitFor(page,
    `/TAKE/.test(document.querySelector('.glance-card')?.textContent || '')`);
  check('the recommendation card still renders with sync disabled', cardBack,
    await page.eval(CARD_TEXT));
  check('no sync line at all when sync is disabled',
    (await page.eval(`document.querySelectorAll('.glance-sync').length`)) === 0,
    await page.eval(CARD_TEXT));

  // 4. Same question of the Board: with sync off it must claim nothing either.
  //    The placeholder element still has to exist — the top bar's flex layout
  //    depends on that column — so this asserts empty text, not absence.
  await showView(page, 'board');
  const barOff = await page.eval(BAR);
  check('the board is showing after the toggle (sync off)', barOff.isBoard, JSON.stringify(barOff));
  check('the board claims nothing when sync is disabled',
    barOff.present && barOff.text === '' && !barOff.stale && !barOff.okDot && !barOff.errorDot,
    JSON.stringify(barOff));
} finally {
  if (page) page.close();
  if (chrome) chrome.proc.kill('SIGKILL');
  if (server) server.server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nstale warning verified' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
