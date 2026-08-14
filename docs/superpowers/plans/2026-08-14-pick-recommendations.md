# Roster-Aware Pick Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sort the Best Available table by fit with the roster being drafted — empty starters first, then bench, then K/DEF — while hard-excluding players at a position limit.

**Architecture:** A new pure module `js/recommend.js` computes a score per player (`score = rank - bonus`, lower wins) from a roster snapshot. `js/app.js` stays a rendering layer and only reads that score. A tiny `js/positions.js` canonicalizes `DEF`/`DST` across the CSV importer, the Sleeper boundary, and roster-slot matching.

**Tech Stack:** Vanilla ES modules, no framework, no build step. Tests run on the Node 22 built-in runner (`node --test`) with `node:assert/strict` — zero dependencies.

## Global Constraints

- **No build step and no runtime dependencies.** The site is served as static files from GitHub Pages. `package.json` exists only to mark `type: module` for Node's test runner; it must never gain a `dependencies` block.
- **All source stays browser-loadable as plain ES modules.** No bundler syntax, no bare-specifier imports — every import is a relative path ending in `.js`.
- **Canonical defense position is `DST`.** Sleeper's `DEF` is translated at the boundary. Never introduce `DEF` into state, rankings, or roster spots.
- **Scoring constants live at the top of `js/recommend.js`** as named exports so they can be tuned in one line: `STARTER_BONUS = 12`, `FLEX_BONUS = 6`, `KDEF_PENALTY = 999`, `KDEF_BUFFER = 1`.
- **Lower score sorts first.** Excluded players sort after all non-excluded players regardless of score.
- **Backward compatibility:** new settings keys must default to today's behavior so existing `localStorage` states load unchanged through the `Object.assign` merge in `state.js:load()`.
- Commit after every task.

---

### Task 1: Test infrastructure and position canonicalization

Creates the test harness the rest of the plan depends on, and fixes the latent
`DEF`/`DST` mismatch that syncing `roster_positions` would otherwise expose in
`assignRosterSlots`.

**Files:**
- Create: `package.json`
- Create: `js/positions.js`
- Create: `test/positions.test.js`
- Modify: `js/csv.js` (replace `cleanPos` at lines 74-79, add import at top)
- Modify: `js/draft.js` (line 25 — source `FLEX_ELIGIBLE` from the new module)

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizePos(raw: string) -> string` and `FLEX_ELIGIBLE: string[]` from `js/positions.js`. Every later task imports one or both.

- [ ] **Step 1: Create `package.json`**

This exists solely so Node treats `.js` files as ES modules when running tests.
It adds no dependencies and GitHub Pages ignores it.

```json
{
  "name": "fantasy-football-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/positions.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePos, FLEX_ELIGIBLE } from '../js/positions.js';

test('canonicalizes every defense spelling to DST', () => {
  assert.equal(normalizePos('DEF'), 'DST');
  assert.equal(normalizePos('DST'), 'DST');
  assert.equal(normalizePos('D/ST'), 'DST');
  assert.equal(normalizePos('def'), 'DST');
  assert.equal(normalizePos(' DEF '), 'DST');
});

test('canonicalizes PK to K', () => {
  assert.equal(normalizePos('PK'), 'K');
  assert.equal(normalizePos('K'), 'K');
});

test('strips FantasyPros positional ranks', () => {
  assert.equal(normalizePos('RB1'), 'RB');
  assert.equal(normalizePos('WR12'), 'WR');
  assert.equal(normalizePos('QB'), 'QB');
});

test('returns empty string for missing input', () => {
  assert.equal(normalizePos(''), '');
  assert.equal(normalizePos(null), '');
  assert.equal(normalizePos(undefined), '');
});

test('FLEX_ELIGIBLE is RB/WR/TE', () => {
  assert.deepEqual(FLEX_ELIGIBLE, ['RB', 'WR', 'TE']);
});

// The whole point of the module: a defense from a CSV must fill a defense slot
// synced from Sleeper, regardless of which spelling each side used.
test('a defense fills a defense slot from either spelling', () => {
  const slotLabel = normalizePos('DEF'); // Sleeper's roster_positions
  const playerPos = normalizePos('D/ST'); // a FantasyPros CSV
  assert.equal(slotLabel, playerPos);

  const { slots } = assignRosterSlots([slotLabel], [{ pos: playerPos, name: 'Ravens' }]);
  assert.equal(slots[0].player.name, 'Ravens', 'the defense slot actually fills');
});
```

Add the `assignRosterSlots` import at the top of the test file:

```js
import { assignRosterSlots } from '../js/draft.js';
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/positions.test.js`
Expected: FAIL — `Cannot find module '.../js/positions.js'`

- [ ] **Step 4: Create `js/positions.js`**

```js
// Canonical position handling, shared by the rankings importer, the Sleeper
// boundary, and roster/recommendation logic.
//
// Sleeper reports team defenses as DEF; FantasyPros CSVs report DST or D/ST.
// assignRosterSlots() matches slots with `p.pos === slot.label`, so a mismatch
// means the defense slot silently never fills. Everything canonicalizes to DST,
// which is what DEFAULT_ROSTER and the .pos-badge CSS already use.
function normalizePos(raw) {
  if (!raw) return '';
  const upper = String(raw).trim().toUpperCase();
  if (upper === 'DEF' || upper === 'DST' || upper === 'D/ST') return 'DST';
  if (upper === 'PK') return 'K';
  // FantasyPros formats positions as "RB1", "WR12" — keep the leading letters.
  const m = upper.match(/^([A-Z]+)/);
  return m ? m[1] : upper;
}

const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export { normalizePos, FLEX_ELIGIBLE };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/positions.test.js`
Expected: PASS — `# pass 6`, `# fail 0`

- [ ] **Step 6: Route `csv.js` through the shared normalizer**

In `js/csv.js`, add to the very top of the file:

```js
import { normalizePos } from './positions.js';
```

Then delete the `cleanPos` function (lines 74-79):

```js
function cleanPos(raw) {
  if (!raw) return '';
  // FantasyPros sometimes formats position as "RB1", "WR12" etc.
  const m = raw.trim().toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : raw.trim().toUpperCase();
}
```

and change its one call site (line 114) from `cleanPos(...)` to `normalizePos(...)`:

```js
      pos: colMap.pos !== undefined ? normalizePos(r[colMap.pos]) : '',
```

- [ ] **Step 7: Route `draft.js` through the shared normalizer**

In `js/draft.js`, replace line 25:

```js
const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];
```

with an import at the top of the file:

```js
import { FLEX_ELIGIBLE } from './positions.js';
```

Leave `FLEX_ELIGIBLE` in the existing `export { ... }` list on line 69 so any
current importer keeps working.

- [ ] **Step 8: Verify nothing broke**

Run: `node --test`
Expected: PASS — all tests pass.

Run: `node --check js/csv.js && node --check js/draft.js && node --check js/positions.js`
Expected: no output (syntax OK).

- [ ] **Step 9: Commit**

```bash
git add package.json js/positions.js js/csv.js js/draft.js test/positions.test.js
git commit -m "Canonicalize DEF/DST positions in one shared module

Sleeper reports DEF, FantasyPros CSVs report DST, and assignRosterSlots
matches slot labels exactly — so syncing roster_positions would leave the
defense slot permanently unfillable. Adds js/positions.js as the single
normalizer and routes csv.js and draft.js through it.

Also adds package.json (type: module, no dependencies) so the Node 22
built-in test runner can import the browser modules directly."
```

---

### Task 2: Roster state snapshot

**Files:**
- Create: `js/recommend.js`
- Create: `test/recommend.test.js`

**Interfaces:**
- Consumes: `assignRosterSlots` from `js/draft.js`; `FLEX_ELIGIBLE` from `js/positions.js`.
- Produces: `rosterState(rosterSpots: string[], myPlayers: object[]) -> {openStarters: {POS: number}, openFlex: number, posCounts: {POS: number}, picksRemaining: number, kdefNeeded: number, kdefUrgent: boolean}`. Tasks 3 and 4 consume this object.

- [ ] **Step 1: Write the failing test**

Create `test/recommend.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterState } from '../js/recommend.js';

const SPOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
               'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

const p = (pos, rank) => ({ pos, rank, name: `${pos}${rank}` });

test('empty roster reports every starting slot open', () => {
  const s = rosterState(SPOTS, []);
  assert.equal(s.openStarters.QB, 1);
  assert.equal(s.openStarters.RB, 2);
  assert.equal(s.openStarters.WR, 2);
  assert.equal(s.openStarters.TE, 1);
  assert.equal(s.openFlex, 1);
  assert.equal(s.picksRemaining, 16);
});

test('drafted players close their starting slots', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('QB', 30)]);
  assert.equal(s.openStarters.RB, undefined);
  assert.equal(s.openStarters.QB, undefined);
  assert.equal(s.openStarters.WR, 2);
  assert.equal(s.posCounts.RB, 2);
  assert.equal(s.picksRemaining, 13);
});

test('a third RB overflows into FLEX, not a starting slot', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 40)]);
  assert.equal(s.openFlex, 0);
  assert.equal(s.posCounts.RB, 3);
});

test('K/DEF urgency is false early and true inside the buffer', () => {
  const early = rosterState(SPOTS, []);
  assert.equal(early.kdefNeeded, 2);
  assert.equal(early.kdefUrgent, false);

  // 13 players drafted, none of them K or DST -> 3 picks left, 2 slots needed.
  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const late = rosterState(SPOTS, thirteen);
  assert.equal(late.picksRemaining, 3);
  assert.equal(late.kdefUrgent, true);
});

test('urgency stays false once K and DST are filled', () => {
  const players = [...Array.from({ length: 12 }, (_, i) => p('WR', i + 1)),
                   p('K', 200), p('DST', 210)];
  const s = rosterState(SPOTS, players);
  assert.equal(s.kdefNeeded, 0);
  assert.equal(s.kdefUrgent, false);
});

test('over-full roster floors picksRemaining at zero', () => {
  const many = Array.from({ length: 20 }, (_, i) => p('WR', i + 1));
  assert.equal(rosterState(SPOTS, many).picksRemaining, 0);
});

test('missing arguments do not throw', () => {
  const s = rosterState();
  assert.equal(s.picksRemaining, 0);
  assert.equal(s.openFlex, 0);
  assert.deepEqual(s.openStarters, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `Cannot find module '.../js/recommend.js'`

- [ ] **Step 3: Create `js/recommend.js` with `rosterState`**

```js
// Roster-aware pick scoring. Pure functions only — no DOM access, so the
// judgment calls here are testable in isolation.

import { assignRosterSlots } from './draft.js';
import { FLEX_ELIGIBLE } from './positions.js';

// How much an open roster need is worth, measured in ranking places.
// STARTER_BONUS = 12 means "an empty starting slot is worth about one round":
// a clearly better player at a filled position still wins, but a close call
// breaks toward filling the roster. Tune these two numbers here.
const STARTER_BONUS = 12;
const FLEX_BONUS = 6;

// K and DST sink below everyone until waiting gets risky. KDEF_BUFFER = 1 keeps
// one pick of slack so a sniped defense doesn't leave the slot empty.
const KDEF_PENALTY = 999;
const KDEF_BUFFER = 1;
const KDEF_POSITIONS = ['K', 'DST'];

// Snapshot of the roster being built: what's still open, what's already stacked,
// and how much draft is left.
function rosterState(rosterSpots = [], myPlayers = []) {
  const { slots } = assignRosterSlots(rosterSpots, myPlayers);

  const openStarters = {};
  let openFlex = 0;
  for (const slot of slots) {
    if (slot.player || slot.label === 'BN') continue;
    if (slot.label === 'FLEX') openFlex++;
    else openStarters[slot.label] = (openStarters[slot.label] || 0) + 1;
  }

  const posCounts = {};
  for (const player of myPlayers) {
    if (!player.pos) continue;
    posCounts[player.pos] = (posCounts[player.pos] || 0) + 1;
  }

  const picksRemaining = Math.max(0, rosterSpots.length - myPlayers.length);
  const kdefNeeded = KDEF_POSITIONS.reduce((n, pos) => n + (openStarters[pos] || 0), 0);

  return {
    openStarters,
    openFlex,
    posCounts,
    picksRemaining,
    kdefNeeded,
    kdefUrgent: kdefNeeded > 0 && picksRemaining <= kdefNeeded + KDEF_BUFFER,
  };
}

export {
  rosterState,
  STARTER_BONUS,
  FLEX_BONUS,
  KDEF_PENALTY,
  KDEF_BUFFER,
  KDEF_POSITIONS,
  FLEX_ELIGIBLE,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/recommend.test.js`
Expected: PASS — `# pass 7`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Add rosterState() snapshot for pick scoring

Reports open starting slots, open FLEX, per-position counts, picks
remaining, and whether K/DST have become urgent (picksRemaining <=
kdefNeeded + 1)."
```

---

### Task 3: Player scoring

**Files:**
- Modify: `js/recommend.js` (add `scorePlayer`, extend the export list)
- Modify: `test/recommend.test.js` (append tests)

**Interfaces:**
- Consumes: `rosterState()` output from Task 2.
- Produces: `scorePlayer(player: object, state: object, limits: {POS: number}) -> {score: number, reason: string, excluded: boolean}`. Task 4 consumes this.

- [ ] **Step 1: Write the failing test**

Append to `test/recommend.test.js`:

```js
import { scorePlayer, STARTER_BONUS, FLEX_BONUS } from '../js/recommend.js';

const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };

test('an empty starting slot earns the starter bonus', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer(p('TE', 55), s, LIMITS);
  assert.equal(r.score, 55 - STARTER_BONUS);
  assert.equal(r.reason, 'FILLS TE');
  assert.equal(r.excluded, false);
});

test('a large talent gap beats the need bonus', () => {
  // Both RB slots full, TE slot empty. RB 38 should still outrank TE 55.
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20)]);
  const rb = scorePlayer(p('RB', 38), s, LIMITS);
  const te = scorePlayer(p('TE', 55), s, LIMITS);
  assert.equal(rb.score, 38);
  assert.equal(te.score, 43);
  assert.ok(rb.score < te.score, 'the better player wins a 17-rank gap');
});

test('a small talent gap loses to the need bonus', () => {
  const s = rosterState(SPOTS, [p('RB', 5), p('RB', 20)]);
  const rb = scorePlayer(p('RB', 38), s, LIMITS);
  const te = scorePlayer(p('TE', 45), s, LIMITS);
  assert.ok(te.score < rb.score, 'need breaks a 7-rank gap');
});

test('FLEX bonus applies only once own-position slots are full', () => {
  const empty = rosterState(SPOTS, []);
  assert.equal(scorePlayer(p('RB', 50), empty, LIMITS).reason, 'FILLS RB');

  const rbFull = rosterState(SPOTS, [p('RB', 5), p('RB', 20)]);
  const r = scorePlayer(p('RB', 50), rbFull, LIMITS);
  assert.equal(r.reason, 'FILLS FLEX');
  assert.equal(r.score, 50 - FLEX_BONUS);
});

test('a filled roster spot scores as bench depth', () => {
  const full = rosterState(SPOTS, [p('RB', 5), p('RB', 20), p('RB', 25)]);
  const r = scorePlayer(p('RB', 50), full, LIMITS);
  assert.equal(r.reason, 'BENCH');
  assert.equal(r.score, 50);
});

test('position limit excludes and labels', () => {
  const s = rosterState(SPOTS, [p('QB', 5), p('QB', 60), p('QB', 90)]);
  const r = scorePlayer(p('QB', 10), s, LIMITS);
  assert.equal(r.excluded, true);
  assert.equal(r.reason, 'QB LIMIT (3)');
  assert.equal(r.score, Infinity);
});

test('exclusion wins over an open starting slot', () => {
  // TE limit of 1 reached, but the TE starting slot is somehow still open.
  const s = rosterState(SPOTS, [p('TE', 5)]);
  const r = scorePlayer(p('TE', 10), s, { TE: 1 });
  assert.equal(r.excluded, true);
});

test('K and DST are buried until urgent, then jump', () => {
  const early = rosterState(SPOTS, []);
  const earlyK = scorePlayer(p('K', 150), early, LIMITS);
  assert.equal(earlyK.reason, 'WAIT');
  assert.ok(earlyK.score > 1000, 'buried below every real player');

  const thirteen = Array.from({ length: 13 }, (_, i) => p('WR', i + 1));
  const late = rosterState(SPOTS, thirteen);
  const lateK = scorePlayer(p('K', 150), late, LIMITS);
  assert.equal(lateK.reason, 'FILLS K');
  assert.equal(lateK.score, 150 - STARTER_BONUS);
});

test('positions absent from the limits map are unlimited', () => {
  const s = rosterState(SPOTS, [p('RB', 1), p('RB', 2), p('RB', 3)]);
  assert.equal(scorePlayer(p('RB', 50), s, {}).excluded, false);
});

test('a player with no rank sorts last without throwing', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer({ pos: 'WR', name: 'Unranked' }, s, LIMITS);
  assert.ok(Number.isFinite(r.score));
  assert.ok(r.score > 1000);
});

test('a player with no position is bench depth, never excluded', () => {
  const s = rosterState(SPOTS, []);
  const r = scorePlayer({ pos: '', rank: 40, name: 'Mystery' }, s, LIMITS);
  assert.equal(r.excluded, false);
  assert.equal(r.reason, 'BENCH');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `scorePlayer is not a function` / import error.

- [ ] **Step 3: Add `scorePlayer` to `js/recommend.js`**

Insert after `rosterState`, before the export block:

```js
// Rank of an unranked player: sorts below every ranked one but stays finite so
// arithmetic and comparisons never produce NaN.
const UNRANKED = 9999;

// Scores one available player against the roster snapshot.
// Lower score is a better pick. Excluded players are never draftable.
function scorePlayer(player, state, limits = {}) {
  const pos = player.pos || '';
  const rank = Number.isFinite(player.rank) ? player.rank : UNRANKED;

  // Roster rules come first: an open slot cannot be filled by a player the
  // league forbids, so exclusion is checked before any bonus.
  const limit = limits[pos];
  if (limit !== undefined && (state.posCounts[pos] || 0) >= limit) {
    return { score: Infinity, reason: `${pos} LIMIT (${limit})`, excluded: true };
  }

  if (KDEF_POSITIONS.includes(pos)) {
    if (state.kdefUrgent && (state.openStarters[pos] || 0) > 0) {
      return { score: rank - STARTER_BONUS, reason: `FILLS ${pos}`, excluded: false };
    }
    return { score: rank + KDEF_PENALTY, reason: 'WAIT', excluded: false };
  }

  if ((state.openStarters[pos] || 0) > 0) {
    return { score: rank - STARTER_BONUS, reason: `FILLS ${pos}`, excluded: false };
  }

  if (state.openFlex > 0 && FLEX_ELIGIBLE.includes(pos)) {
    return { score: rank - FLEX_BONUS, reason: 'FILLS FLEX', excluded: false };
  }

  return { score: rank, reason: 'BENCH', excluded: false };
}
```

Add `scorePlayer` and `UNRANKED` to the export list.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/recommend.test.js`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Add scorePlayer() need-weighted scoring

score = rank - bonus, so an empty starting slot breaks close calls without
overriding a real talent gap. Position limits exclude before any bonus
applies; K/DST carry a burying penalty until urgent."
```

---

### Task 4: Ordering

**Files:**
- Modify: `js/recommend.js` (add `recommendOrder`, extend exports)
- Modify: `test/recommend.test.js` (append tests)

**Interfaces:**
- Consumes: `scorePlayer` from Task 3.
- Produces: `recommendOrder(players: object[], state: object, limits: object) -> Array<{player, score, reason, excluded}>`. Task 7 renders this array directly.

- [ ] **Step 1: Write the failing test**

Append to `test/recommend.test.js`:

```js
import { recommendOrder } from '../js/recommend.js';

test('orders by score, excluded players last', () => {
  const state = rosterState(SPOTS, [p('QB', 1), p('QB', 2), p('QB', 3)]);
  const board = [p('QB', 4), p('WR', 60), p('K', 150), p('TE', 55)];
  const ranked = recommendOrder(board, state, LIMITS);

  assert.equal(ranked[0].player.pos, 'TE', 'TE 55 - 12 = 43 wins');
  assert.equal(ranked[1].player.pos, 'WR', 'WR 60 - 12 = 48');
  assert.equal(ranked[2].player.pos, 'K', 'K is buried but not excluded');
  assert.equal(ranked[3].player.pos, 'QB', 'QB is at its limit, so dead last');
  assert.equal(ranked[3].excluded, true);
});

test('ties break toward the better rank', () => {
  const state = rosterState(SPOTS, []);
  const ranked = recommendOrder([p('WR', 30), p('RB', 30)], state, LIMITS);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[0].player.rank, 30);
});

test('two excluded players still sort by rank without NaN', () => {
  const state = rosterState(SPOTS, [p('QB', 1), p('QB', 2), p('QB', 3)]);
  const ranked = recommendOrder([p('QB', 80), p('QB', 20)], state, LIMITS);
  assert.equal(ranked[0].player.rank, 20);
  assert.equal(ranked[1].player.rank, 80);
});

test('an empty board returns an empty array', () => {
  assert.deepEqual(recommendOrder([], rosterState(SPOTS, []), LIMITS), []);
});

test('does not mutate the input array', () => {
  const board = [p('WR', 60), p('TE', 55)];
  const copy = [...board];
  recommendOrder(board, rosterState(SPOTS, []), LIMITS);
  assert.deepEqual(board, copy);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `recommendOrder is not a function`

- [ ] **Step 3: Add `recommendOrder` to `js/recommend.js`**

Insert after `scorePlayer`, before the export block:

```js
// Scores an entire board and returns it sorted, best pick first.
// Excluded players stay in the list — being told a top QB is sitting there
// while you're at your QB limit is useful information about the board.
function recommendOrder(players, state, limits = {}) {
  return players
    .map((player) => ({ player, ...scorePlayer(player, state, limits) }))
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
      if (a.score !== b.score) return a.score - b.score;
      const ar = Number.isFinite(a.player.rank) ? a.player.rank : UNRANKED;
      const br = Number.isFinite(b.player.rank) ? b.player.rank : UNRANKED;
      return ar - br;
    });
}
```

Add `recommendOrder` to the export list.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS — every test file green, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Add recommendOrder() board sorting

Excluded players sort last but stay visible. Guards the Infinity - Infinity
NaN case when two excluded players are compared."
```

---

### Task 5: Settings for limits and sort mode

**Files:**
- Modify: `js/state.js` (line 5 `DEFAULT_ROSTER`, lines 9-18 `defaultState`)
- Create: `test/state-defaults.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `settings.positionLimits: {POS: number}` (default `{}`) and `settings.sortMode: 'rank' | 'need'` (default `'rank'`). Tasks 6 and 7 read and write both.

- [ ] **Step 1: Write the failing test**

`js/state.js` touches `localStorage` at module load, which Node does not have.
Stub it before importing.

Create `test/state-defaults.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// state.js reads localStorage at import time; Node has no DOM.
globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = String(v); },
  removeItem(k) { delete this._v[k]; },
};

const St = await import('../js/state.js');

test('DEFAULT_ROSTER matches the real league: 16 spots, 7 bench, DST not DEF', () => {
  const r = St.DEFAULT_ROSTER;
  assert.equal(r.length, 16);
  assert.equal(r.filter((x) => x === 'BN').length, 7);
  assert.ok(r.includes('DST'));
  assert.ok(!r.includes('DEF'));
  assert.ok(r.includes('FLEX'));
});

test('new settings default to today\'s behavior', () => {
  const s = St.getState().settings;
  assert.deepEqual(s.positionLimits, {});
  assert.equal(s.sortMode, 'rank');
});

test('a saved state from before this feature gains the new keys', async () => {
  // load() uses Object.assign, which is shallow: a saved `settings` object
  // replaces the default one wholesale, so new keys would go missing for every
  // existing user mid-draft.
  globalThis.localStorage._v['ffDraftState.v1'] = JSON.stringify({
    settings: { numTeams: 10, myTeamId: 'r2', rosterSpots: ['QB', 'BN'] },
    players: [{ id: 'p1', name: 'Saved Player' }],
  });
  const fresh = await import('../js/state.js?reload=1');
  const s = fresh.getState().settings;

  assert.deepEqual(s.positionLimits, {}, 'new key present');
  assert.equal(s.sortMode, 'rank', 'new key present');
  assert.equal(s.myTeamId, 'r2', 'saved value preserved');
  assert.deepEqual(s.rosterSpots, ['QB', 'BN'], 'saved value preserved');
  assert.equal(fresh.getState().players.length, 1, 'saved draft preserved');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state-defaults.test.js`
Expected: FAIL — roster length is 15, `positionLimits` is `undefined`, and the
saved-state test reports the new keys missing.

- [ ] **Step 3: Update `js/state.js`**

Replace line 5:

```js
const DEFAULT_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'DST', 'K', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
```

with the real league shape (K before DST, 7 bench, 16 total):

```js
const DEFAULT_ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
```

In `defaultState()`, add two keys to `settings` after `rosterSpots`:

```js
      rosterSpots: DEFAULT_ROSTER.slice(),
      positionLimits: {}, // {POS: max}; empty means no limits
      sortMode: 'rank', // 'rank' | 'need'
```

Then fix `load()` (lines 29-39) to merge settings one level deeper. The existing
`Object.assign` is shallow, so a saved `settings` object replaces the default
wholesale — every new settings key would be missing for anyone with a draft
already in progress. Replace:

```js
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
```

with:

```js
    const parsed = JSON.parse(raw);
    const base = defaultState();
    // Merge settings explicitly: a shallow Object.assign would drop any key
    // added after this state was saved, mid-draft.
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state-defaults.test.js`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/state.js test/state-defaults.test.js
git commit -m "Add positionLimits and sortMode settings

Both default to current behavior. Also deepens the settings merge in load():
the old shallow Object.assign let a saved settings object replace the default
wholesale, so any newly added key went missing for anyone with a draft already
in progress. Corrects DEFAULT_ROSTER to the real league shape too: 16 spots,
7 bench, DST rather than DEF."
```

---

### Task 6: Sync league config from Sleeper

**Files:**
- Modify: `js/sleeper.js` (`connectLeague`, lines 24-58 as rewritten in the earlier fix)
- Create: `test/sleeper-config.test.js`

**Interfaces:**
- Consumes: `normalizePos` from `js/positions.js`.
- Produces: `connectLeague()` return value gains `rosterPositions: string[]` and `positionLimits: {POS: number}`, alongside the existing `{league, draft, teams, orderKnown}`. Task 7 reads both.

- [ ] **Step 1: Write the failing test**

Create `test/sleeper-config.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLeague } from '../js/sleeper.js';

// Shapes captured from the live Sleeper API for league 1389708373728964608.
const LEAGUE = {
  total_rosters: 2,
  roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'],
  settings: {
    position_limit_qb: 3, position_limit_rb: 6, position_limit_wr: 6,
    position_limit_te: 3, position_limit_k: 2, position_limit_def: 3,
    max_keepers: 1, reserve_slots: 1,
  },
};
const USERS = [
  { user_id: 'u1', display_name: 'A', metadata: { team_name: 'Team A' } },
  { user_id: 'u2', display_name: 'B', metadata: {} },
];
const ROSTERS = [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }];
const DRAFTS = [{ draft_id: 'd1', status: 'pre_draft', draft_order: null, settings: { teams: 2 } }];

function stubFetch() {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : LEAGUE;
    return { ok: true, status: 200, json: async () => body };
  };
}

test('returns roster positions with DEF canonicalized to DST', async () => {
  stubFetch();
  const { rosterPositions } = await connectLeague('L');
  assert.equal(rosterPositions.length, 16);
  assert.ok(rosterPositions.includes('DST'));
  assert.ok(!rosterPositions.includes('DEF'));
  assert.equal(rosterPositions.filter((x) => x === 'BN').length, 7);
});

test('parses position limits and keys defense as DST', async () => {
  stubFetch();
  const { positionLimits } = await connectLeague('L');
  assert.deepEqual(positionLimits, { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 });
});

test('a league with no limits configured returns an empty map', async () => {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : { total_rosters: 2, roster_positions: ['QB', 'BN'], settings: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  const { positionLimits, rosterPositions } = await connectLeague('L');
  assert.deepEqual(positionLimits, {});
  assert.deepEqual(rosterPositions, ['QB', 'BN']);
});

test('a league missing roster_positions returns an empty array', async () => {
  globalThis.fetch = async (url) => {
    const body = url.endsWith('/users') ? USERS
      : url.endsWith('/rosters') ? ROSTERS
      : url.endsWith('/drafts') ? DRAFTS
      : { total_rosters: 2, settings: {} };
    return { ok: true, status: 200, json: async () => body };
  };
  const { rosterPositions } = await connectLeague('L');
  assert.deepEqual(rosterPositions, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sleeper-config.test.js`
Expected: FAIL — `rosterPositions` is `undefined`.

- [ ] **Step 3: Add config parsing to `js/sleeper.js`**

Add the import at the top of the file:

```js
import { normalizePos } from './positions.js';
```

Add above `connectLeague`:

```js
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
```

Change the final line of `connectLeague` from:

```js
  return { league, draft, teams, orderKnown };
```

to:

```js
  const rosterPositions = (league.roster_positions || []).map(normalizePos);
  const positionLimits = parsePositionLimits(league.settings);

  return { league, draft, teams, orderKnown, rosterPositions, positionLimits };
```

Add `parsePositionLimits` to the export list so it can be tested directly later
if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sleeper-config.test.js`
Expected: PASS — `# fail 0`

- [ ] **Step 5: Verify the real league still parses**

Run:

```bash
node -e "
import('./js/sleeper.js').then(async (m) => {
  const r = await m.connectLeague('1389708373728964608');
  console.log('positions:', r.rosterPositions.join(','));
  console.log('limits:', JSON.stringify(r.positionLimits));
});
"
```

Expected output:

```
positions: QB,RB,RB,WR,WR,TE,FLEX,K,DST,BN,BN,BN,BN,BN,BN,BN
limits: {"QB":3,"RB":6,"WR":6,"TE":3,"K":2,"DST":3}
```

- [ ] **Step 6: Commit**

```bash
git add js/sleeper.js test/sleeper-config.test.js
git commit -m "Return roster positions and position limits from connectLeague

Sleeper publishes roster_positions and position_limit_* per league, so the
app can stop asking users to retype what the API already knows. Defense is
canonicalized from DEF to DST at this boundary."
```

---

### Task 7: Wire the UI

**Files:**
- Modify: `index.html` (setup panel ~lines 25-38, controls ~lines 90-97, table head ~lines 100-111)
- Modify: `js/app.js` (imports line 4, `initSetupPanel` ~lines 33-46, Sleeper connect handler ~lines 71-93, `renderPlayersBody` ~lines 270-309, `render` ~line 379)
- Modify: `css/styles.css` (append)

**Interfaces:**
- Consumes: `recommendOrder`, `rosterState` from `js/recommend.js`; `settings.positionLimits`, `settings.sortMode` from Task 5; `rosterPositions`, `positionLimits` from Task 6.
- Produces: no exports — this is the rendering layer.

- [ ] **Step 1: Add the Position Limits field to `index.html`**

In the "League Settings" card, after the `rosterSpots` field block, insert:

```html
        <div class="field">
          <label for="positionLimits">Position limits (max per position)</label>
          <input type="text" id="positionLimits" placeholder="QB:3,RB:6,WR:6,TE:3,K:2,DST:3" />
          <div class="hint">Blank means no limit. Filled in automatically when you sync Sleeper.</div>
        </div>
```

- [ ] **Step 2: Add the sort toggle to `index.html`**

In the `.controls` div, immediately after the `searchBox` input, insert:

```html
        <div class="sort-toggle" id="sortToggle">
          <button class="btn small" data-sort="rank">By rank</button>
          <button class="btn small" data-sort="need">Best for my roster</button>
        </div>
```

- [ ] **Step 3: Add the WHY column header to `index.html`**

In the players table `<thead>`, insert a header between `<th>ADP</th>` and
`<th>Status</th>`:

```html
              <th>Why</th>
```

- [ ] **Step 4: Style the new pieces in `css/styles.css`**

Append:

```css
/* --- Recommendation sort --- */
.sort-toggle { display: flex; gap: 4px; flex: none; }
.sort-toggle .btn.active { background: var(--accent); color: #fff; }

.why-badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  background: var(--panel-2, rgba(127, 127, 127, 0.15));
}
.why-badge.fills { background: var(--accent); color: #fff; }
.why-badge.wait { opacity: 0.55; }
.why-badge.limit { background: var(--danger, #b3261e); color: #fff; }

tr.limit-excluded { opacity: 0.45; }
tr.limit-divider td {
  padding: 4px 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.6;
  border-top: 2px solid var(--border, rgba(127, 127, 127, 0.3));
}
```

- [ ] **Step 5: Import the recommender in `js/app.js`**

Change line 4 from:

```js
import { pickToSlotIndex, pickToRound, nextPickForSlot, assignRosterSlots, computeNeeds } from './draft.js';
```

to add a second import line beneath it:

```js
import { pickToSlotIndex, pickToRound, nextPickForSlot, assignRosterSlots, computeNeeds } from './draft.js';
import { rosterState, recommendOrder } from './recommend.js';
```

- [ ] **Step 6: Add position-limit parsing and wire the Setup field**

Add near the top of `js/app.js`, after the `FLEX_POS` constant:

```js
// "QB:3,RB:6" -> {QB: 3, RB: 6}. Tolerates spaces and trailing commas.
function parseLimitsInput(text) {
  const limits = {};
  for (const part of String(text || '').split(',')) {
    const [pos, max] = part.split(':').map((x) => (x || '').trim().toUpperCase());
    const n = parseInt(max, 10);
    if (pos && Number.isFinite(n) && n > 0) limits[pos] = n;
  }
  return limits;
}

function formatLimits(limits) {
  return Object.entries(limits || {}).map(([pos, max]) => `${pos}:${max}`).join(',');
}
```

In `initSetupPanel`, after the `rosterSpots` value assignment, add:

```js
  document.getElementById('positionLimits').value = formatLimits(s.positionLimits);
```

and after the `rosterSpots` change listener, add:

```js
  document.getElementById('positionLimits').addEventListener('change', (e) => {
    St.updateSettings({ positionLimits: parseLimitsInput(e.target.value) });
  });
```

- [ ] **Step 7: Populate the fields on Sleeper connect**

In the `connectSleeperBtn` handler, change the destructuring line from:

```js
      const { draft, teams, orderKnown } = await Sleeper.connectLeague(leagueId);
```

to:

```js
      const { draft, teams, orderKnown, rosterPositions, positionLimits } =
        await Sleeper.connectLeague(leagueId);
```

and inside the `St.updateSettings({...})` call, add these two lines before the
closing brace — only overwriting when Sleeper actually returned something, so a
sparse league response never wipes a hand-entered roster:

```js
        ...(rosterPositions.length ? { rosterSpots: rosterPositions } : {}),
        ...(Object.keys(positionLimits).length ? { positionLimits } : {}),
```

Immediately after `St.updateSettings(...)`, refresh the two Setup inputs so the
synced values are visible without reopening the panel:

```js
      document.getElementById('rosterSpots').value = St.getState().settings.rosterSpots.join(',');
      document.getElementById('positionLimits').value = formatLimits(St.getState().settings.positionLimits);
```

- [ ] **Step 8: Add the sort toggle handler**

Add a new function to `js/app.js` and call it from wherever `initSetupPanel()` is
called during startup:

```js
function initSortToggle() {
  document.getElementById('sortToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    St.updateSettings({ sortMode: btn.getAttribute('data-sort') });
  });
}
```

- [ ] **Step 9: Sort and render the WHY column in `renderPlayersBody`**

Replace the opening of `renderPlayersBody` (down to and including the
`tbody.innerHTML = list` line) with:

```js
function renderPlayersBody() {
  const tbody = document.getElementById('playersBody');
  const { settings, teams, players } = St.getState();
  const list = filteredPlayers();

  const useNeed = settings.sortMode === 'need';
  document.querySelectorAll('#sortToggle [data-sort]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sort') === (useNeed ? 'need' : 'rank'));
  });

  let scored;
  if (useNeed && settings.myTeamId) {
    const mine = players
      .filter((p) => p.drafted && p.draftedByTeamId === settings.myTeamId)
      .sort((a, b) => (a.pickNo || 0) - (b.pickNo || 0));
    const state = rosterState(settings.rosterSpots, mine);
    scored = recommendOrder(list.filter((p) => !p.drafted), state, settings.positionLimits)
      .concat(list.filter((p) => p.drafted).map((player) => ({ player, reason: '', excluded: false })));
  } else {
    scored = list.map((player) => ({ player, reason: '', excluded: false }));
  }

  let lastTier = undefined;
  let dividerShown = false;

  tbody.innerHTML = scored
    .map(({ player: p, reason, excluded }) => {
```

Then inside the map body, replace the `return` template with one that adds the
WHY cell and the excluded-row treatment. Note `tierStart` is suppressed in need
mode, because tier dividers only make sense in rank order:

```js
      const tierStart = !useNeed && p.tier !== undefined && p.tier !== null && p.tier !== lastTier;
      lastTier = p.tier;
      const teamName = p.draftedByTeamId ? (teams.find((t) => t.id === p.draftedByTeamId)?.name || 'Unknown') : '';
      const rowClasses = [
        tierStart ? 'tier-start' : '',
        p.drafted ? 'drafted' : '',
        excluded ? 'limit-excluded' : '',
      ].filter(Boolean).join(' ');
      const actionCell = p.drafted
        ? `<button class="btn small danger" data-undraft="${p.id}">✕</button>`
        : `<button class="btn small primary" data-draft="${p.id}">Draft</button>`;

      let divider = '';
      if (excluded && !dividerShown) {
        dividerShown = true;
        divider = '<tr class="limit-divider"><td colspan="9">At position limit</td></tr>';
      }

      const whyClass = reason.includes('LIMIT') ? 'limit'
        : reason === 'WAIT' ? 'wait'
        : reason.startsWith('FILLS') ? 'fills' : '';
      const whyCell = reason ? `<span class="why-badge ${whyClass}">${escapeHtml(reason)}</span>` : '';

      return `${divider}<tr class="${rowClasses}">
        <td>${p.rank ?? '—'}${p.tier ? `<span class="badge-unranked">T${p.tier}</span>` : ''}</td>
        <td><span class="player-name">${escapeHtml(p.name)}</span>${p.source === 'manual' ? '<span class="badge-unranked">unranked</span>' : ''}</td>
        <td>${p.pos ? `<span class="pos-badge ${p.pos}">${p.pos}</span>` : ''}</td>
        <td class="player-meta">${escapeHtml(p.team || '')}</td>
        <td class="player-meta">${p.bye ?? ''}</td>
        <td class="player-meta">${p.adp ?? ''}</td>
        <td>${whyCell}</td>
        <td class="drafted-by">${p.drafted ? `#${p.pickNo} · ${escapeHtml(teamName)}` : ''}</td>
        <td>${actionCell}</td>
      </tr>`;
    })
    .join('');
```

The `data-draft` / `data-undraft` listener block below is unchanged.

- [ ] **Step 10: Verify in a browser**

Run: `python3 -m http.server 8080`

Then open `http://localhost:8080` and confirm, in order:

1. Setup shows a **Position limits** field.
2. **Connect & Sync Teams** with league `1389708373728964608` fills Roster Spots
   with 16 entries ending in 7 `BN`, and Position limits with `QB:3,RB:6,...`.
3. Import any rankings CSV, pick your team, and toggle **Best for my roster** —
   the order changes and WHY badges appear.
4. Kickers and defenses sink to the bottom with a greyed `WAIT` badge.
5. Toggling back to **By rank** restores pure rank order and tier dividers.
6. The console shows no errors.

- [ ] **Step 11: Run the full suite and syntax check**

Run: `node --test`
Expected: PASS — `# fail 0`

Run: `for f in js/*.js; do node --check "$f" || echo "FAILED $f"; done`
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add index.html js/app.js css/styles.css
git commit -m "Add Best for my roster sort mode and WHY column

Sort toggle above the players table plus a reason badge per row. Sleeper
sync now fills the roster spots and position limits fields, which stay
editable. Players at a position limit sort last below a divider rather than
disappearing."
```

---

### Task 8: Calibrate STARTER_BONUS

Kyle was unsure whether 12 is the right weight. This produces the evidence to
decide, rather than leaving it a guess.

**Files:**
- Create: `test/calibrate.js`

**Interfaces:**
- Consumes: `rosterState`, `scorePlayer` from `js/recommend.js`.
- Produces: nothing — a throwaway diagnostic script, not part of the suite. It is named `.js` rather than `.test.js` so `node --test` does not pick it up.

- [ ] **Step 1: Write the calibration script**

Create `test/calibrate.js`:

```js
// Diagnostic, not a test. Prints the same mid-draft board scored at three
// STARTER_BONUS values so the weight is chosen from observed behavior.
//
// Usage: node test/calibrate.js
import { rosterState } from '../js/recommend.js';

const SPOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];
const LIMITS = { QB: 3, RB: 6, WR: 6, TE: 3, K: 2, DST: 3 };

// Round 5: QB, both RBs and one WR are in. TE and one WR are still open.
const MY_TEAM = [
  { pos: 'QB', rank: 22, name: 'my QB' },
  { pos: 'RB', rank: 5, name: 'my RB1' },
  { pos: 'RB', rank: 20, name: 'my RB2' },
  { pos: 'WR', rank: 31, name: 'my WR1' },
];

const BOARD = [
  { pos: 'RB', rank: 38, name: 'Kenneth Walker' },
  { pos: 'RB', rank: 41, name: 'James Cook' },
  { pos: 'TE', rank: 45, name: 'Trey McBride' },
  { pos: 'WR', rank: 47, name: 'Jaylen Waddle' },
  { pos: 'TE', rank: 55, name: 'David Njoku' },
  { pos: 'WR', rank: 58, name: 'Rome Odunze' },
  { pos: 'QB', rank: 60, name: 'Jared Goff' },
];

const state = rosterState(SPOTS, MY_TEAM);
const FLEX = ['RB', 'WR', 'TE'];

for (const bonus of [6, 12, 20]) {
  // Inline re-score so the module constant does not have to be edited.
  const flexBonus = Math.round(bonus / 2);
  const ranked = BOARD.map((p) => {
    let adj = 0;
    let why = 'BENCH';
    if ((state.openStarters[p.pos] || 0) > 0) { adj = bonus; why = `FILLS ${p.pos}`; }
    else if (state.openFlex > 0 && FLEX.includes(p.pos)) { adj = flexBonus; why = 'FILLS FLEX'; }
    return { ...p, score: p.rank - adj, why };
  }).sort((a, b) => a.score - b.score);

  console.log(`\n=== STARTER_BONUS = ${bonus} (FLEX ${flexBonus}) ===`);
  for (const r of ranked) {
    console.log(`  ${String(r.score).padStart(3)}  #${String(r.rank).padStart(2)}  ${r.pos.padEnd(3)}  ${r.name.padEnd(16)} ${r.why}`);
  }
}
```

- [ ] **Step 2: Run it**

Run: `node test/calibrate.js`
Expected: three ranked boards. Confirm that at 12 the open-TE and open-WR slots
pull McBride and Waddle above the two RBs, while the RBs still beat Njoku at 55.

- [ ] **Step 3: Confirm the suite still ignores it**

Run: `node --test`
Expected: `calibrate.js` does not appear in the output.

- [ ] **Step 4: Report the three boards to Kyle and confirm the weight**

Paste the output. If he wants a different weight, change `STARTER_BONUS` in
`js/recommend.js` and update the two arithmetic assertions in
`test/recommend.test.js` that hardcode `55 - STARTER_BONUS` and `50 - FLEX_BONUS`
— they reference the constants, so they follow automatically; only the
`assert.equal(te.score, 43)` literal in the large-gap test needs editing.

- [ ] **Step 5: Commit**

```bash
git add test/calibrate.js
git commit -m "Add STARTER_BONUS calibration script

Prints one mid-draft board scored at bonus 6, 12, and 20 so the need weight
is chosen from observed ordering rather than assumed."
```

---

### Task 9: Update the README

**Files:**
- Modify: `README.md` ("What it does" section, "What it deliberately doesn't do" section)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Document the feature**

In "What it does", add after the **Best Available** bullet:

```markdown
- **Best for my roster** — a sort mode that reorders the board by fit with the
  team you're building: unfilled starters first, then bench depth, then K/DEF.
  A WHY badge on each row shows the reasoning. Players at one of your league's
  position limits sort to the bottom, greyed out, rather than disappearing.
  Scoring is `rank − bonus`, so an empty starting slot breaks close calls but
  never overrides a genuinely better player.
- **K and DEF held back** — they stay at the bottom of the recommended order
  until you have only enough picks left to fill them, so you never spend an
  early pick on a kicker or finish the draft without a defense.
```

In "What it deliberately doesn't do", add:

```markdown
- No bye-week conflict detection, tier-cliff bonuses, or modeling of other
  teams' needs. The recommendation reflects your roster and your league's
  position limits, nothing more.
```

- [ ] **Step 2: Document config sync**

In the "Sleeper live sync" section, after step 2, insert:

```markdown
   Connecting also pulls your league's roster shape and position limits
   (e.g. QB 3, RB 6, WR 6, TE 3, K 2, DEF 3) into Setup, so the
   recommendations match your actual league rules. Both fields stay editable.
```

- [ ] **Step 3: Document how to run tests**

Add a paragraph to the "Local development" section:

```markdown
Tests use the Node 22 built-in runner — no dependencies, no install step:

```
node --test
```

`package.json` exists only to mark the source as ES modules for Node. The site
itself still has no build step and no runtime dependencies.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document roster-aware recommendations and league config sync"
```

---

## Verification

After every task is complete:

- [ ] `node --test` — all files pass, `# fail 0`
- [ ] `for f in js/*.js; do node --check "$f" || echo "FAILED $f"; done` — silent
- [ ] `python3 -m http.server 8080` and walk the Task 7 Step 10 checklist
- [ ] `git log --oneline` shows one commit per task
- [ ] Push, then confirm the live Pages files match local:
      `curl -s https://youngin9210.github.io/fantasy-football-dashboard/js/recommend.js | shasum -a 256`
      against `shasum -a 256 js/recommend.js`
