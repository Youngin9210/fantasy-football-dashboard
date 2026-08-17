# Glance View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Glance view — a two-second read of the need-weighted recommendation — as the default, keeping today's full Board behind a toggle.

**Architecture:** A new `js/ui/GlanceView.js` renders a card built entirely from existing tested functions (`recommendOrder`, `computeNeeds`, `nextPickForSlot`). The one piece of genuinely new logic — staleness classification and TAKE selection — lives in a pure `js/ui/glance.js` covered by Node tests. `settings.view` selects which view `App` renders.

**Tech Stack:** Preact + htm, vendored at `js/vendor/preact.js`. No build step, no npm. Tests on Node 22's built-in runner.

## Global Constraints

- **No build step, no runtime dependencies, no `node_modules`, no CI.** `package.json` must never gain a `dependencies` block.
- **No JSX.** htm tagged templates only: `` html`<div class="x">${y}</div>` ``, `` html`<${Component} prop=${v} />` ``. `class=` not `className`, `onClick=` not `onclick`.
- **htm does NO HTML-entity decoding.** An inline `&amp;` renders as the literal text "&amp;". Write plain `&`, and interpolate any string containing `<` or `>` rather than writing it inline.
- **htm drops whitespace-only text nodes.** Two adjacent inline elements that need a space between them require an explicit `${' '}`, or they render flush. This shipped a 3.8px bug once already.
- **Never edit `js/vendor/preact.js`.**
- **Never import from a URL.** Every import a relative path ending in `.js`.
- **Do NOT modify the scoring or domain modules:** `js/recommend.js`, `js/draft.js`, `js/positions.js`, `js/limits.js`, `js/csv.js`, `js/sleeper.js`. This work adds a presentation of the existing engine, not new scoring. If a task appears to require changing one, stop and report.
- **Do NOT edit existing rules in `css/styles.css`.** Appending new rules is expected. Existing rules are shared with the Board.
- **`getState()` returns the same object reference every call** — `state.js` mutates in place. Never use `useMemo`/`useCallback` keyed on store data, and never a lazy `useState` initializer over store data. Neither would re-evaluate; both would serve stale data through a live draft.
- **The Board must behave exactly as it does today.** Every existing test must keep passing unmodified.
- Commit after every task.

---

### Task 1: Pure glance helpers

Two functions carrying the only new logic in this feature, built first so the component is a thin renderer over tested code.

**Files:**
- Create: `js/ui/glance.js`
- Create: `test/glance.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `syncFreshness(status, syncEnabled, now) -> 'fresh' | 'stale' | 'off'` and `pickTake(ranked) -> entry | null`. Task 2 consumes both.

- [ ] **Step 1: Write the failing tests**

Create `test/glance.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncFreshness, pickTake, STALE_AFTER_MS } from '../js/ui/glance.js';

test('STALE_AFTER_MS is 20 seconds', () => {
  assert.equal(STALE_AFTER_MS, 20000);
});

test('sync disabled reports off, whatever the status says', () => {
  assert.equal(syncFreshness({ ok: true, at: 1000 }, false, 1000), 'off');
  assert.equal(syncFreshness({ ok: false, at: 1 }, false, 999999), 'off');
  assert.equal(syncFreshness(null, false, 1000), 'off');
});

test('a recent completed poll is fresh', () => {
  assert.equal(syncFreshness({ ok: true, at: 10000 }, true, 10000), 'fresh');
  assert.equal(syncFreshness({ ok: true, at: 10000 }, true, 19999), 'fresh');
});

test('the staleness boundary is exact in both directions', () => {
  // 20000ms elapsed is NOT yet stale; 20001 is.
  assert.equal(syncFreshness({ ok: true, at: 0 }, true, 20000), 'fresh');
  assert.equal(syncFreshness({ ok: true, at: 0 }, true, 20001), 'stale');
});

test('a failed poll still counts as a completed poll for freshness', () => {
  // sleeper.js stamps `at` on failure too. A failing-but-responding API is a
  // different problem from a hung one, and the error text is shown separately.
  assert.equal(syncFreshness({ ok: false, error: 'boom', at: 0 }, true, 1000), 'fresh');
});

test('a missing or unstamped status is stale, not fresh', () => {
  // Never claim freshness we cannot substantiate.
  assert.equal(syncFreshness(null, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true }, true, 1000), 'stale');
  assert.equal(syncFreshness({ ok: true, at: null }, true, 1000), 'stale');
});

test('pickTake returns the first non-excluded entry', () => {
  const ranked = [
    { player: { name: 'A' }, excluded: true },
    { player: { name: 'B' }, excluded: false },
    { player: { name: 'C' }, excluded: false },
  ];
  assert.equal(pickTake(ranked).player.name, 'B');
});

test('pickTake returns null when everything is excluded or the list is empty', () => {
  assert.equal(pickTake([{ player: { name: 'A' }, excluded: true }]), null);
  assert.equal(pickTake([]), null);
  assert.equal(pickTake(undefined), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/glance.test.js`
Expected: FAIL — `Cannot find module '.../js/ui/glance.js'`

- [ ] **Step 3: Create `js/ui/glance.js`**

```js
// Pure helpers for the Glance view. No DOM, no store access — the only genuinely
// new logic in the feature, kept here so it is testable under Node.

// Roughly three missed six-second polls. Deliberately measured from the last
// COMPLETED poll: a hung request never fires its callback, so `at` stops
// advancing, which is exactly the condition worth surfacing.
export const STALE_AFTER_MS = 20000;

// 'off'   — sync is disabled; there is nothing to be healthy, so show nothing.
// 'fresh' — a poll completed recently (success or failure; a responding-but-
//           failing API is a different problem, reported via status.error).
// 'stale' — no poll has completed recently, OR we have no timestamp at all.
//           Absence of evidence is never reported as freshness.
export function syncFreshness(status, syncEnabled, now) {
  if (!syncEnabled) return 'off';
  const at = status && typeof status.at === 'number' ? status.at : null;
  if (at === null) return 'stale';
  return now - at > STALE_AFTER_MS ? 'stale' : 'fresh';
}

// recommendOrder sorts excluded entries last, but a board can be entirely
// excluded (e.g. every remaining player is at a position limit), so the first
// element is not necessarily draftable.
export function pickTake(ranked) {
  if (!Array.isArray(ranked)) return null;
  return ranked.find((e) => !e.excluded) || null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/glance.test.js`
Expected: PASS — `# fail 0`

Run: `node --test`
Expected: every pre-existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add js/ui/glance.js test/glance.test.js
git commit -m "Add pure helpers for the Glance view

syncFreshness classifies poll staleness from the last COMPLETED poll, so a
hung request surfaces rather than showing a stale green dot. An absent or
unstamped status reports stale, never fresh. pickTake skips position-limit
exclusions, which recommendOrder sorts last but does not remove."
```

---

### Task 2: The Glance card

**Files:**
- Create: `js/ui/GlanceView.js`
- Modify: `css/styles.css` (append only)

**Interfaces:**
- Consumes: `useStore`; `rosterState`, `recommendOrder` from `js/recommend.js`; `computeNeeds`, `assignRosterSlots`, `nextPickForSlot` from `js/draft.js`; `syncFreshness`, `pickTake` from `js/ui/glance.js`.
- Produces: `<GlanceView>` taking `{ syncStatus }`.

- [ ] **Step 1: Create `js/ui/GlanceView.js`**

```js
import { html, useState, useEffect } from '../vendor/preact.js';
import { rosterState, recommendOrder } from '../recommend.js';
import { computeNeeds, assignRosterSlots, nextPickForSlot } from '../draft.js';
import { useStore } from './useStore.js';
import { syncFreshness, pickTake } from './glance.js';

// Re-renders once a second so the "synced Ns ago" text stays honest. Cleared on
// unmount so the interval cannot outlive the view.
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);
  return now;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function Notice({ children }) {
  return html`<div class="glance-card"><p class="glance-notice">${children}</p></div>`;
}

function Suggestion({ label, entry }) {
  const p = entry.player;
  return html`<div class="glance-pick">
    <div class="glance-pick-label">${label}</div>
    <div class="glance-pick-name">
      ${p.name}${' '}
      ${p.pos ? html`<span class="pos-badge ${p.pos}">${p.pos}</span>` : null}${' '}
      <span class="player-meta">#${p.rank ?? '—'}</span>
    </div>
    <div class="glance-pick-why">${entry.reason}</div>
  </div>`;
}

export function GlanceView({ syncStatus }) {
  const { settings, teams, players, pickCounter } = useStore();
  const syncEnabled = !!settings.sleeperSyncEnabled;
  const freshness = syncFreshness(syncStatus, syncEnabled, useNow(syncEnabled));

  if (players.length === 0) return html`<${Notice}>Import rankings in Setup to get recommendations.<//>`;
  if (!settings.myTeamId) return html`<${Notice}>Pick which team is yours in Setup to get recommendations.<//>`;

  const mine = players
    .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
    .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
  const state = rosterState(settings.rosterSpots, mine);

  if (state.picksRemaining === 0) return html`<${Notice}>Your roster is full.<//>`;

  const ranked = recommendOrder(
    players.filter((p) => !p.drafted), state, settings.positionLimits
  );
  const take = pickTake(ranked);
  if (!take) {
    return html`<${Notice}>
      No draftable player left — every remaining player is at one of your position limits.
      Check Position limits in Setup, or switch to the Board to override.
    <//>`;
  }
  const then = ranked.filter((e) => !e.excluded && e !== take).slice(0, 2);

  const needs = computeNeeds(assignRosterSlots(settings.rosterSpots, mine).slots);
  const needKeys = Object.keys(needs);

  const myTeam = teams.find((t) => t.id === settings.myTeamId);
  let countdown = null;
  if (myTeam) {
    const nextPickNo = pickCounter + 1;
    // nextPickForSlot returns null when the slot falls outside numTeams (a stale
    // saved roster, a shrunk league). `null - n` is -n, NOT NaN, so an unguarded
    // subtraction renders a plausible-looking negative countdown.
    const next = nextPickForSlot(nextPickNo, myTeam.slot, settings.numTeams);
    const until = Number.isFinite(next) ? next - nextPickNo : null;
    countdown = until === null ? null : until === 0
      ? html`<div class="glance-turn my-turn">YOU'RE UP</div>`
      : html`<div class="glance-turn">${until} pick${until === 1 ? '' : 's'} until your turn</div>`;
  }

  const at = syncStatus && typeof syncStatus.at === 'number' ? syncStatus.at : null;
  let sync = null;
  if (freshness === 'stale') {
    sync = html`<div class="glance-sync stale">⚠ NOT SYNCING${
      at === null ? '' : ` — last update ${ago(Date.now() - at)}`
    } · advice above may be stale</div>`;
  } else if (freshness === 'fresh') {
    sync = html`<div class="glance-sync"><span class="sync-dot ok"></span>${' '}synced ${ago(Date.now() - at)}</div>`;
  }

  return html`<div class="glance-card">
    <${Suggestion} label="TAKE" entry=${take} />
    ${then.length ? html`<div class="glance-then">
      ${then.map((e) => html`<${Suggestion} key=${e.player.id} label="THEN" entry=${e} />`)}
    </div>` : null}
    <div class="glance-needs">
      ${needKeys.length
        ? html`STILL NEED${' '}${needKeys.map((k) => html`<span key=${k}><span class="pos-badge ${k}">${k}</span>${' '}</span>`)}`
        : 'All starting spots filled.'}
    </div>
    ${countdown}
    ${sync}
  </div>`;
}
```

Note the explicit `${' '}` separators — htm drops whitespace-only text nodes, so
adjacent inline elements render flush without them.

- [ ] **Step 2: Append the styles to `css/styles.css`**

Do not edit existing rules. Append:

```css
/* --- Glance view --- */
.glance-card {
  max-width: 560px;
  margin: 24px auto;
  padding: 20px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.glance-notice { color: var(--text-secondary); margin: 0; }

.glance-pick { padding: 10px 0; }
.glance-pick-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.glance-pick-name { font-size: 22px; font-weight: 600; margin: 2px 0; }
.glance-pick-why { font-size: 13px; color: var(--text-secondary); }

.glance-then { border-top: 1px solid var(--gridline); margin-top: 8px; }
.glance-then .glance-pick-name { font-size: 16px; }

.glance-needs {
  border-top: 1px solid var(--gridline);
  margin-top: 12px;
  padding-top: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
/* .pos-badge sets color:#fff but only backgrounds the six real positions, so a
   FLEX slot (in the DEFAULT roster) or any custom label typed into Setup renders
   white-on-card and is invisible in light mode. :where() keeps specificity at
   zero so the per-position colours still win, and scoping under .glance-needs
   leaves the board's own .needs-row badges untouched. */
.glance-needs :where(.pos-badge) {
  background: var(--surface-3);
  color: var(--text-primary);
}

.glance-turn { margin-top: 10px; font-size: 13px; color: var(--text-secondary); }
.glance-turn.my-turn { color: var(--status-good); font-weight: 700; }

.glance-sync {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.glance-sync.stale {
  color: #0b0b0b;
  background: var(--status-warning);
  padding: 6px 8px;
  border-radius: 4px;
  font-weight: 600;
}
```

Every token used here (`--surface-1`, `--border`, `--text-secondary`,
`--text-muted`, `--gridline`, `--status-good`, `--status-warning`) is defined in
BOTH the `:root` and `:root[data-theme="light"]` blocks — verify that before
committing. A `var()` with no fallback that resolves to nothing computes as
`unset`, which has already produced invisible text in this file once.

The `.glance-sync.stale` foreground is a fixed dark ink rather than a token
because `--status-warning` is the same amber in both themes, so a theme-flipping
token would fail one of them.

- [ ] **Step 3: Verify tokens and syntax**

Run: `for t in surface-1 border text-secondary text-muted gridline status-good status-warning; do echo -n "$t: "; grep -c -- "--$t:" css/styles.css; done`
Expected: each count is 2 or more (defined in both theme blocks).

Run: `node --check js/ui/GlanceView.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add js/ui/GlanceView.js css/styles.css
git commit -m "Add the Glance card

A two-second read of the recommendation: TAKE with its reason, two backups,
the open starting slots, the pick countdown, and a sync freshness line that
warns loudly rather than showing a stale green dot."
```

---

### Task 3: Wire the view toggle

**Files:**
- Modify: `js/state.js` (`defaultState`)
- Modify: `js/ui/TopBar.js`
- Modify: `js/ui/App.js`
- Create: `test/state-view.test.js`

**Interfaces:**
- Consumes: `<GlanceView>` from Task 2.
- Produces: `settings.view` (`'glance' | 'board'`, default `'glance'`); `<TopBar>` gains `{ view }`.

- [ ] **Step 1: Write the failing test**

`js/state.js` touches `localStorage` at import time, so stub it before importing.

Create `test/state-view.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};

const St = await import('../js/state.js');

test('view defaults to glance', () => {
  assert.equal(St.getState().settings.view, 'glance');
});

test('a saved state from before this feature gains the key', async () => {
  globalThis.localStorage._v['ffDraftState.v1'] = JSON.stringify({
    settings: { numTeams: 10, myTeamId: 't1', sortMode: 'need' },
    players: [{ id: 'p1', name: 'Saved' }],
  });
  const fresh = await import('../js/state.js?viewreload=1');
  const s = fresh.getState().settings;
  assert.equal(s.view, 'glance', 'new key present for an existing draft');
  assert.equal(s.sortMode, 'need', 'saved value preserved');
  assert.equal(fresh.getState().players.length, 1, 'saved draft preserved');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state-view.test.js`
Expected: FAIL — `view` is `undefined`.

- [ ] **Step 3: Add the setting**

In `js/state.js`, in `defaultState()`'s `settings`, after `sortMode`:

```js
      sortMode: 'rank', // 'rank' | 'need'
      view: 'glance', // 'glance' | 'board'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/state-view.test.js`
Expected: PASS.

- [ ] **Step 5: Add the toggle to `js/ui/TopBar.js`**

Change the signature to accept `view`:

```js
export function TopBar({ onToggleSetup, syncStatus, toggleTheme, view }) {
```

The clock widget renders only in Board view, and the sync dot only in Board view
— in Glance the card carries both, and two freshness signals in different places
is worse than one. Replace the `<${ClockWidget} />` and `<${SyncStatus} ... />`
lines with:

```js
    ${view === 'board' ? html`<${ClockWidget} />` : null}
    ${view === 'board' ? html`<${SyncStatus} status=${syncStatus} />` : html`<div class="sync-status"></div>`}
```

The empty `div.sync-status` placeholder preserves the header's grid layout, which
`css/styles.css` sizes by column. Verify in a browser that removing the clock
does not reflow the brand or the action buttons; if it does, keep an empty
`div.clock-widget` placeholder too.

Add the view toggle inside `.topbar-actions`, before the theme button, using the
existing `sort-toggle` idiom so it inherits the active-button styling:

```js
      <div class="sort-toggle" id="viewToggle">
        <button class="btn small ${view === 'glance' ? 'active' : ''}"
          onClick=${() => St.updateSettings({ view: 'glance' })}>Glance</button>
        <button class="btn small ${view === 'board' ? 'active' : ''}"
          onClick=${() => St.updateSettings({ view: 'board' })}>Board</button>
      </div>
```

This requires `import * as St from '../state.js';` at the top of `TopBar.js`.

- [ ] **Step 6: Route the views in `js/ui/App.js`**

Add the import:

```js
import { GlanceView } from './GlanceView.js';
```

`settings` is already destructured from `useStore()`. Compute the view,
defaulting anything unrecognized to Glance:

```js
  const view = settings.view === 'board' ? 'board' : 'glance';
```

Pass `view` to `TopBar`, then render one of the two bodies. `SetupPanel` stays
outside the switch — it is reachable from both views:

```js
    <${TopBar} onToggleSetup=${() => setSetupOpen((v) => !v)} syncStatus=${syncStatus}
      toggleTheme=${toggleTheme} view=${view} />
    <${SetupPanel} setupOpen=${setupOpen} onConnected=${startPolling} onDisconnect=${stopPolling} />
    ${view === 'glance'
      ? html`<${GlanceView} syncStatus=${syncStatus} />`
      : html`<main class="layout">
          <${PlayersTable} filter=${filter} search=${search}
            onFilter=${setFilter} onSearch=${setSearch}
            draftForId=${draftForId} onDraftFor=${(id) => setDraftForOverride({ pick: pickCounter, id })} />
          <aside class="sidebar">
            <${RosterPanel} />
            <${DraftLog} />
          </aside>
        </main>`}
```

Leave the `.footer-note` element exactly where it is — it renders under both views.

- [ ] **Step 7: Verify the whole suite and syntax**

Run: `node --test`
Expected: every test passes, including the two new files.

Run: `for f in js/*.js js/ui/*.js; do node --check "$f" || echo "FAILED $f"; done`
Expected: no output.

- [ ] **Step 8: Verify in a browser**

Serve with `python3 -m http.server 8080` and confirm, in order:

1. A fresh install lands on Glance with the "Import rankings" notice, and Setup
   is open (the empty-install behavior must be unchanged).
2. Import a CSV, save teams, pick your team — Glance shows TAKE, THEN×2, the
   needs strip, and the countdown.
3. Toggle to Board — the full table, roster panel, and draft log all work, and
   the clock widget reappears in the header.
4. Reload — the view you were on persists.
5. Draft a player from the Board, toggle back to Glance — the recommendation has
   changed accordingly.
6. Set a position limit that excludes everything remaining and confirm the
   "No draftable player left" notice rather than a blank card.
7. Both themes: no invisible text anywhere on the card, and the stale banner is
   legible in each.
8. Console clean throughout.

- [ ] **Step 9: Commit**

```bash
git add js/state.js js/ui/TopBar.js js/ui/App.js test/state-view.test.js
git commit -m "Route between Glance and Board from the top bar

settings.view persists the choice across a mid-draft reload and defaults to
glance. The clock widget and sync dot render only in Board view; in Glance
the card carries both, so there is one freshness signal rather than two."
```

---

### Task 4: Prove the stale warning actually fires

The freshness indicator exists to prevent a specific silent failure. A unit test
on the classifier is not evidence that the rendered UI warns.

**Files:**
- Create: `tools/stale-check.mjs`

**Interfaces:**
- Consumes: `serve`, `launchChrome`, `Page`, `STORAGE_KEY`, `THEME_KEY` from `tools/harness.mjs`.
- Produces: nothing — a verification tool.

It lives in `tools/`, not `test/`: Node's runner collects every `.js` file inside
a directory named `test`.

- [ ] **Step 1: Write the check**

Reuse `tools/harness.mjs`. Its API, confirmed by reading it:
`serve(rootDir)` → `{port, close}`; `launchChrome(userDataDir)` → `{proc, host}`;
`Page.open(host, url)` → a page with `goto(url)`, `eval(expr, {awaitPromise})`,
and `send(method, params)`.

```js
// Proves the stale-sync warning actually renders. A unit test on the classifier
// is not evidence that the UI warns.
//
// Usage: node tools/stale-check.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launchChrome, Page, STORAGE_KEY } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rankings, teams, my team chosen, sync on, Glance selected.
const SEED = { /* fill from tools/harness.mjs SCENARIOS, plus:
  settings: { ..., myTeamId: 't0', sleeperSyncEnabled: true,
              sleeperDraftId: 'd1', view: 'glance' } */ };

// Installed before any app code runs. One picks response resolves, then all
// later ones hang — so `status.at` stops advancing exactly as a dead network
// would make it, without touching the app's own timing constants.
const STUB = `
  (() => {
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(SEED))});
    let served = 0;
    const real = window.fetch;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('api.sleeper.app') && u.includes('/picks')) {
        served += 1;
        if (served > 1) return new Promise(() => {});      // hang forever
        return Promise.resolve(new Response('[]', { status: 200 }));
      }
      if (u.includes('api.sleeper.app')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return real(url, opts);
    };
  })();
`;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures += 1;
}

const profile = mkdtempSync(join(tmpdir(), 'stale-chrome-'));
let server, chrome, page;
try {
  server = await serve(ROOT);
  chrome = launchChrome(profile);
  page = await Page.open(chrome.host, 'about:blank');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await page.goto(`http://localhost:${server.port}/index.html`);

  // 1. A poll must succeed FIRST. Without this, a card that never synced at all
  //    would also read stale, and the stale assertion would prove nothing.
  await sleep(3000);
  const fresh = await page.eval(`document.querySelector('.glance-sync')?.textContent || ''`);
  check('card reads synced after the first poll', /synced/i.test(fresh), JSON.stringify(fresh));
  check('healthy dot is present',
    await page.eval(`!!document.querySelector('.glance-sync .sync-dot.ok')`));

  // 2. Every later poll hangs, so no callback fires and `at` freezes. Wait past
  //    the real 20s threshold — do NOT shorten STALE_AFTER_MS to speed this up,
  //    that would test a different program than the one that ships.
  await sleep(25000);
  const stale = await page.eval(`document.querySelector('.glance-sync.stale')?.textContent || ''`);
  check('stale banner appears', stale.includes('NOT SYNCING'), JSON.stringify(stale));

  // 3. With sync off there is nothing to be healthy, so nothing should render.
  await page.eval(`(() => {
    const s = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));
    s.settings.sleeperSyncEnabled = false;
    localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify(s));
  })()`);
  await page.goto(`http://localhost:${server.port}/index.html`);
  await sleep(2000);
  check('no sync line at all when sync is disabled',
    (await page.eval(`document.querySelectorAll('.glance-sync').length`)) === 0);
} finally {
  if (page) page.ws.close();
  if (chrome) chrome.proc.kill('SIGKILL');
  if (server) server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nstale warning verified' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
```

Fill `SEED` from the scenario shapes already in `tools/harness.mjs` — it needs
rankings, ten teams, `myTeamId` set, and enough undrafted players that TAKE
renders. Confirm the property names on `serve`/`launchChrome`'s return values
against the source before relying on them; adjust if they differ.

- [ ] **Step 2: Run it**

Run: `node tools/stale-check.mjs`
Expected: exits 0, printing the fresh assertion, then the stale assertion, then
the sync-disabled assertion.

- [ ] **Step 3: Prove the check can fail**

Temporarily raise `STALE_AFTER_MS` in `js/ui/glance.js` to something the check
cannot reach (e.g. `600000`), re-run, and confirm the stale assertion FAILS.
Then `git checkout js/ui/glance.js` and confirm it passes again. Report the
failure output you saw.

A check that has never been observed failing is not evidence.

- [ ] **Step 4: Commit**

```bash
git add tools/stale-check.mjs
git commit -m "Add a browser check that the stale-sync warning actually fires

Lets one poll succeed, asserts the card reads synced, then hangs the picks
request and asserts the NOT SYNCING banner appears after the threshold —
against the real 20s value, not a shortened test-only one."
```

---

### Task 5: Repoint the screenshot harness and update the README

**Files:**
- Modify: `tools/screenshot-diff.mjs`
- Modify: `tools/harness.mjs` (only if the baseline ref lives there)
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Repoint the screenshot baseline**

`tools/screenshot-diff.mjs` compares against the pre-rewrite commit `998d3ad`.
Glance is DOM that commit does not contain, so the comparison is now
meaningless. Change the baseline to a ref that makes it a forward-looking drift
detector — read the file to find where the ref is set (it may be in
`tools/harness.mjs`), and make it configurable via an argument or environment
variable with a sensible default, so the baseline does not have to be edited in
source every time.

Its seeded scenarios all render the Board, so also add a Glance scenario — set
`view: 'glance'` with rankings and a selected team — or the new default view
goes entirely uncompared.

- [ ] **Step 2: Verify the harness still runs**

Run: `node tools/screenshot-diff.mjs`
Expected: completes and reports per-scenario numbers. A leaked git worktree from
a killed run is cleaned with `git worktree remove --force <path>`.

- [ ] **Step 3: Update `README.md`**

In "What it does", add before the Best Available bullet:

```markdown
- **Glance** — the default view. One card: the player to take and why, two
  backups, which starting slots are still open, how many picks until your turn,
  and whether live sync is actually current. Built for a phone next to your
  laptop while you draft on your league's own site.
- **Board** — one tap away, and what you want for an in-person or non-Sleeper
  draft: the full table with search, filters, and Draft buttons for marking
  every pick by hand.
```

Then add a short section explaining the tool's scope honestly, since a first-time
reader will otherwise wonder why it duplicates their platform:

```markdown
## What this is for

Your league's site already has a draft board, a queue, a draft log, and a
roster view. This does two things they don't: it ranks from *your* CSV, and it
re-sorts by *your* open starting slots weighted against talent — including
holding K and DEF back until you can no longer afford to wait.

Glance exists so that fits on a phone beside whatever you're actually drafting
in. Sleeper's API is read-only and no major platform accepts a rankings file, so
a second screen is the only way to get this without the platform's cooperation.
```

- [ ] **Step 4: Final sweep**

Run: `node --test`
Expected: all tests pass.

Run: `for f in js/*.js js/ui/*.js tools/*.mjs; do node --check "$f" || echo "FAILED $f"; done`
Expected: no output.

Run: `grep -rn "from ['\"]http" js/`
Expected: no matches.

Run: `grep -c '"dependencies"' package.json`
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add tools/ README.md
git commit -m "Repoint the screenshot baseline and document Glance

The baseline was the pre-rewrite commit, which contains no Glance DOM. Now
configurable and defaulting to a ref that makes the harness a forward drift
detector, with a Glance scenario added so the default view is covered."
```

---

## Verification

After every task:

- [ ] `node --test` — all tests pass, pre-existing ones unmodified
- [ ] `node --check` clean on `js/*.js`, `js/ui/*.js`, `tools/*.mjs`
- [ ] `node tools/stale-check.mjs` — exits 0
- [ ] `node tools/screenshot-diff.mjs` — completes, differences triaged
- [ ] No URL imports; `package.json` still has no `dependencies`
- [ ] Browser: the full Task 3 Step 8 checklist, both themes, clean console
- [ ] The scoring and domain modules are untouched:
      `git diff --stat main -- js/recommend.js js/draft.js js/positions.js js/limits.js js/csv.js js/sleeper.js`
      is empty
