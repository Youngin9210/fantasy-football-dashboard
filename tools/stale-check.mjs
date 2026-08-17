// Proves the stale-sync warning actually renders. A unit test on the classifier
// (test/glance.test.js) is not evidence that the UI warns — the failure this
// guards against is the rendered card giving confident advice off a board that
// stopped updating.
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

// Installed before any app code runs. One picks response resolves, then all
// later ones hang — so `status.at` stops advancing exactly as a dead network
// would make it, without touching the app's own timing constants.
//
// The seed is written only when the key is ABSENT. This script runs on every
// navigation, and step 3 works by editing the saved state and reloading: an
// unconditional write would stomp that edit back to sleeperSyncEnabled: true and
// the third assertion would be testing nothing (it would just fail, or worse,
// pass for an unrelated reason).
const STUB = `
  (() => {
    const KEY = ${JSON.stringify(STORAGE_KEY)};
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, ${JSON.stringify(JSON.stringify(SEED))});
    }
    let served = 0;
    const real = window.fetch.bind(window);
    window.fetch = (url, ...rest) => {
      const u = String(url);
      if (u.includes('api.sleeper.app') && u.includes('/picks')) {
        served += 1;
        if (served > 1) return new Promise(() => {});      // hang forever
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
  await page.goto(`${server.origin}/index.html`);

  // 1. A poll must succeed FIRST. Without this, a card that never synced at all
  //    would also read stale, and the stale assertion would prove nothing.
  const rendered = await waitFor(page, `!!document.querySelector('.glance-sync')`);
  if (!rendered) console.log(`      card text: ${await page.eval(CARD_TEXT)}`);
  const fresh = await page.eval(`document.querySelector('.glance-sync')?.textContent || ''`);
  check('card reads synced after the first poll', /synced/i.test(fresh), JSON.stringify(fresh));
  check('healthy dot is present',
    await page.eval(`!!document.querySelector('.glance-sync .sync-dot.ok')`));

  // 2. Every later poll hangs, so no callback fires and `at` freezes. Wait past
  //    the real 20s threshold — do NOT shorten STALE_AFTER_MS to speed this up,
  //    that would test a different program than the one that ships.
  console.log(`      waiting ${(STALE_AFTER_MS + SETTLE_MS) / 1000}s past the real threshold...`);
  await sleep(STALE_AFTER_MS + SETTLE_MS);
  const stale = await page.eval(`document.querySelector('.glance-sync.stale')?.textContent || ''`);
  check('stale banner appears', stale.includes('NOT SYNCING'),
    `${JSON.stringify(stale)}; sync line = ${JSON.stringify(
      await page.eval(`document.querySelector('.glance-sync')?.textContent || '(none)'`))}`);

  // 3. With sync off there is nothing to be healthy, so nothing should render.
  await page.eval(`(() => {
    const s = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    s.settings.sleeperSyncEnabled = false;
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
} finally {
  if (page) page.close();
  if (chrome) chrome.proc.kill('SIGKILL');
  if (server) server.server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nstale warning verified' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
