# Bye-Week Weighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Penalize a pick that concentrates bye weeks at a position, so a roster never ends up with its starters at one position all out in the same week.

**Architecture:** A pure `byeShortfall()` in `js/recommend.js` measures bye-caused starter shortfall per position. `rosterState` gains the two maps it needs. `scorePlayer` folds `BYE_PENALTY × shortfall` into the score and returns a `byeWarning` the UI renders. No other module's logic changes.

**Tech Stack:** Vanilla ES modules, Preact + htm for the UI, no build step, no npm. Tests on Node 22's built-in runner.

## Global Constraints

- **No build step, no runtime dependencies, no `node_modules`, no CI.** `package.json` must never gain a `dependencies` block.
- **Never import from a URL.** Every import a relative path ending in `.js`.
- **Never edit `js/vendor/preact.js`.**
- **`score = rank − bonus + penalty`, lower wins.** Every weight is expressed in ranking places. Do not introduce a second unit.
- **Do NOT change `STARTER_BONUS`, `FLEX_BONUS`, `KDEF_PENALTY`, or `KDEF_BUFFER`**, and do not alter the K/DST hold-back rule's *trigger*. Its scores gain the bye penalty like every other branch, but when it fires must not change.
- **`js/state.js`, `js/draft.js`, `js/positions.js`, `js/limits.js`, `js/csv.js`, `js/sleeper.js` must stay byte-identical.** Bye data is already parsed; nothing upstream needs touching.
- **In `css/styles.css`, APPEND only.** Existing rules are shared with the Board.
- **No JSX.** htm tagged templates only. `class=` not `className`. htm drops whitespace-only text nodes (use `${' '}` between adjacent inline elements) and does NOT decode HTML entities (write plain `&`).
- **`getState()` returns the same object reference every call** — the store mutates in place. No `useMemo`/`useCallback` keyed on store data, no lazy `useState` initializer over store data.
- **The 85 existing tests must keep passing unmodified.**
- Commit after every task.

---

### Task 1: `byeShortfall`

The whole model, as one pure function. Built and fully covered before anything consumes it.

**Files:**
- Modify: `js/recommend.js` (add the function and `BYE_PENALTY`, extend exports)
- Modify: `test/recommend.test.js` (append tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `byeShortfall(candidateBye: number|null, rosteredByes: Array<number|null>, startersNeeded: number) -> number` and `BYE_PENALTY = 6`. Tasks 3 and 5 consume both.

- [ ] **Step 1: Write the failing tests**

Append to `test/recommend.test.js`:

```js
import { byeShortfall, BYE_PENALTY } from '../js/recommend.js';

test('BYE_PENALTY is half a starter bonus', () => {
  assert.equal(BYE_PENALTY, 6);
  assert.equal(BYE_PENALTY * 2, STARTER_BONUS);
});

test('a first player at a position costs one shortfall week', () => {
  // Nothing to spread against yet; every candidate costs the same, so no bye
  // differentiates a first RB. required caps at 1, not the 2 slots.
  assert.equal(byeShortfall(7, [], 2), 1);
});

test('a fresh bye against covered slots costs nothing', () => {
  assert.equal(byeShortfall(12, [7, 10], 2), 0);
});

test('doubling up on an existing bye costs one week', () => {
  assert.equal(byeShortfall(7, [7, 10], 2), 1);
});

test('both starters sharing a bye costs two weeks', () => {
  assert.equal(byeShortfall(7, [7], 2), 2);
});

test('required caps at the slots, not the roster', () => {
  // Three RBs all on bye 7 against two slots: you lose two starter-weeks, not
  // three, because you were only ever starting two.
  assert.equal(byeShortfall(7, [7, 7], 2), 2);
});

test('a null candidate bye takes no penalty', () => {
  // An unknown week cannot be reasoned about, so it cannot be shown to conflict.
  assert.equal(byeShortfall(null, [7, 7], 2), 0);
  assert.equal(byeShortfall(undefined, [7, 7], 2), 0);
});

test('null rostered byes count toward depth but never toward a conflict', () => {
  // A Sleeper-synced player missing from the CSV has bye null. They are a real
  // body at the position, so they raise `total` and are treated as available in
  // every week — optimistic, but we do not know otherwise.
  assert.equal(byeShortfall(7, [null], 2), 1);   // total 2, wk7 available 1, required 2
  assert.equal(byeShortfall(7, [null, null], 2), 0); // total 3, wk7 available 2, required 2
});

test('an all-null roster with a null candidate is zero', () => {
  assert.equal(byeShortfall(null, [null, null], 2), 0);
});

test('single-slot positions always cost their own bye week', () => {
  // K and DST: one slot, one rostered, so their own bye is always a shortfall.
  assert.equal(byeShortfall(7, [], 1), 1);
  // A second one with a different bye covers it.
  assert.equal(byeShortfall(10, [7], 1), 0);
});

test('degenerate inputs do not throw', () => {
  assert.equal(byeShortfall(7, [], 0), 0);
  assert.equal(byeShortfall(7, undefined, 2), 1);
  assert.equal(byeShortfall(7, [], undefined), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `byeShortfall is not a function`.

- [ ] **Step 3: Implement**

Add to `js/recommend.js`, after the existing constants:

```js
// A bye costs one week out of roughly fourteen; an unfilled starting slot costs
// the season. Half of STARTER_BONUS, so a bye conflict breaks a close call but
// never overrides a clearly better player. Tune here.
const BYE_PENALTY = 6;
```

And the function, near `rosterState`:

```js
// How many starter-weeks this pick would leave unfillable at its own position,
// because of bye overlap.
//
// `required` is capped at what is actually rostered. Without that cap the metric
// fires constantly early in the draft — one RB against two RB slots is "short"
// in every week regardless of byes — and would measure missing depth rather than
// bye concentration.
//
// Null byes (a Sleeper-synced player absent from the CSV) count toward `total`
// because they are real bodies at the position, but never match a week, so they
// read as available everywhere. Optimistic, and the only honest option given we
// do not know their bye.
function byeShortfall(candidateBye, rosteredByes = [], startersNeeded = 0) {
  if (!Number.isFinite(candidateBye)) return 0;
  const roster = Array.isArray(rosteredByes) ? rosteredByes : [];
  const needed = Number.isFinite(startersNeeded) ? startersNeeded : 0;
  if (needed <= 0) return 0;

  const all = [...roster, candidateBye];
  const total = all.length;
  const required = Math.min(needed, total);

  const weeks = new Set(all.filter(Number.isFinite));
  let shortfall = 0;
  for (const week of weeks) {
    const onBye = all.filter((b) => b === week).length;
    shortfall += Math.max(0, required - (total - onBye));
  }
  return shortfall;
}
```

Add `byeShortfall` and `BYE_PENALTY` to the export list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass — the 85 pre-existing plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Add byeShortfall: bye-caused starter shortfall per position

Measures how many starter-weeks a pick would leave unfillable at its own
position through bye overlap. required caps at what is actually rostered, so
it measures bye concentration rather than missing depth — without that cap a
single RB against two slots reads short in every week."
```

---

### Task 2: `rosterState` gains the two maps

**Files:**
- Modify: `js/recommend.js` (`rosterState`)
- Modify: `test/recommend.test.js` (append tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `rosterState(...)` return value gains `posByes: {POS: Array<number|null>}` and `posSlots: {POS: number}`. Task 3 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `test/recommend.test.js`:

```js
test('posByes lists every rostered bye at a position, nulls included', () => {
  const s = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 },
    { pos: 'RB', rank: 20, bye: 10 },
    { pos: 'RB', rank: 40, bye: null },
    { pos: 'WR', rank: 8, bye: 7 },
  ]);
  assert.deepEqual(s.posByes.RB, [7, 10, null]);
  assert.deepEqual(s.posByes.WR, [7]);
  assert.equal(s.posByes.QB, undefined);
});

test('posSlots counts dedicated starting slots and excludes FLEX and BN', () => {
  // SPOTS is QB,RB,RB,WR,WR,TE,FLEX,K,DST + 7 BN
  const s = rosterState(SPOTS, []);
  assert.equal(s.posSlots.RB, 2);
  assert.equal(s.posSlots.WR, 2);
  assert.equal(s.posSlots.QB, 1);
  assert.equal(s.posSlots.TE, 1);
  assert.equal(s.posSlots.K, 1);
  assert.equal(s.posSlots.DST, 1);
  assert.equal(s.posSlots.FLEX, undefined, 'FLEX is not a dedicated slot');
  assert.equal(s.posSlots.BN, undefined, 'BN is not a starting slot');
});

test('posSlots is constant as the roster fills, unlike openStarters', () => {
  // This is the trap: openStarters shrinks to 0 once both RB slots are filled.
  // If posSlots did the same, every bye shortfall would collapse to 0 at exactly
  // the point byes start mattering.
  const empty = rosterState(SPOTS, []);
  const full = rosterState(SPOTS, [
    { pos: 'RB', rank: 5, bye: 7 },
    { pos: 'RB', rank: 20, bye: 10 },
  ]);
  assert.equal(empty.posSlots.RB, 2);
  assert.equal(full.posSlots.RB, 2, 'posSlots must not shrink');
  assert.equal(full.openStarters.RB, undefined, 'openStarters does shrink');
});

test('posSlots reflects a custom roster shape', () => {
  const s = rosterState(['QB', 'QB', 'RB', 'FLEX', 'BN'], []);
  assert.equal(s.posSlots.QB, 2);
  assert.equal(s.posSlots.RB, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `posByes`/`posSlots` are `undefined`.

- [ ] **Step 3: Implement**

In `rosterState`, extend the existing player loop and add a slots loop. Note
`posByes` is built in the SAME pass as `posCounts` — no extra traversal:

```js
  const posCounts = {};
  const posByes = {};
  for (const player of myPlayers) {
    if (!player.pos) continue;
    posCounts[player.pos] = (posCounts[player.pos] || 0) + 1;
    // Nulls are kept: a Sleeper-synced player with no bye is still a body at the
    // position, so byeShortfall needs them in `total`.
    (posByes[player.pos] = posByes[player.pos] || []).push(
      Number.isFinite(player.bye) ? player.bye : null
    );
  }

  // Total dedicated starting slots per position, from the league's roster shape.
  // Deliberately NOT derived from openStarters, which counts EMPTY slots and
  // shrinks as the roster fills — using that would collapse every bye shortfall
  // to 0 once a position's starters were filled.
  const posSlots = {};
  for (const label of rosterSpots) {
    if (label === 'FLEX' || label === 'BN') continue;
    posSlots[label] = (posSlots[label] || 0) + 1;
  }
```

Add `posByes` and `posSlots` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Add posByes and posSlots to rosterState

posSlots counts dedicated starting slots from the league's roster shape and is
constant as the roster fills. openStarters counts EMPTY slots and shrinks, so
deriving the bye requirement from it would silently disable the weighting once
a position's starters were filled."
```

---

### Task 3: Fold the penalty into `scorePlayer`

**Files:**
- Modify: `js/recommend.js` (`scorePlayer`)
- Modify: `test/recommend.test.js` (append tests)

**Interfaces:**
- Consumes: `byeShortfall`, `BYE_PENALTY`, `state.posByes`, `state.posSlots`.
- Produces: `scorePlayer` return value gains `byeWarning: string|null`; `score` includes `BYE_PENALTY × shortfall`; `weights.byePenalty` overrides the constant. Tasks 4 and 5 consume all three.

**The structural risk in this task.** `scorePlayer` currently has FIVE return points:
the position-limit exclusion, urgent K/DST, `FILLS <POS>`, `FILLS FLEX`, and
`BENCH`. Adding the penalty at each site invites missing one. **Restructure to a
single exit** for the non-excluded branches instead: let each branch compute
`{score, reason}` into a local, then apply the bye penalty once before returning.
The exclusion branch keeps its own early return, since `Infinity + 6` is still
`Infinity` and a forbidden player needs no bye commentary.

- [ ] **Step 1: Write the failing tests**

Append to `test/recommend.test.js`:

```js
test('the bye penalty is added to a BENCH score', () => {
  // Three RBs, two of them sharing bye 7, against 2 RB slots. A fourth RB on
  // bye 7 leaves only 1 available that week against a required 2 -> shortfall 1.
  // NOTE the fixture: with 3 RBs on byes 7/10/12 a fourth on bye 7 yields ZERO,
  // because 2 remain available. Depth genuinely covers it. Fixtures here were
  // verified arithmetically, not by eye.
  const mine = [{ pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 7 },
                { pos: 'RB', rank: 25, bye: 10 }];
  const s = rosterState(SPOTS, mine);
  const doubled = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  const fresh = scorePlayer({ pos: 'RB', rank: 50, bye: 14 }, s, {});
  assert.equal(doubled.reason, 'BENCH', 'the reason still describes the slot');
  assert.equal(fresh.score, 50, 'a fresh bye adds nothing');
  assert.equal(doubled.score, 50 + BYE_PENALTY, 'stacking a third on bye 7 costs 1 week');
});

test('the bye penalty reaches the FILLS branch, not only BENCH', () => {
  // The regression this guards: applying the penalty at one return site and
  // forgetting the other three.
  //
  // In the FILLS branch a position's slots are by definition not yet full, so
  // total <= slots and EVERY bye causes a shortfall — there is no clean-FILLS
  // fixture to compare against. Isolate the penalty with byePenalty: 0 instead.
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const p = { pos: 'WR', rank: 40, bye: 7 };
  const withPenalty = scorePlayer(p, s, {}, {});
  const without = scorePlayer(p, s, {}, { byePenalty: 0 });
  assert.equal(withPenalty.reason, 'FILLS WR');
  assert.equal(without.score, 40 - STARTER_BONUS);
  assert.equal(withPenalty.score - without.score, BYE_PENALTY * 2,
    'two players for two slots means both bye weeks are short');
});

test('the bye penalty reaches the FLEX branch', () => {
  const mine = [{ pos: 'RB', rank: 5, bye: 7 }, { pos: 'RB', rank: 20, bye: 10 }];
  const s = rosterState(SPOTS, mine);
  const doubled = scorePlayer({ pos: 'RB', rank: 50, bye: 7 }, s, {});
  assert.equal(doubled.reason, 'FILLS FLEX');
  assert.equal(doubled.score, 50 - FLEX_BONUS + BYE_PENALTY);
});

test('the bye penalty reaches the K/DST WAIT branch', () => {
  const s = rosterState(SPOTS, []);
  const k = scorePlayer({ pos: 'K', rank: 150, bye: 7 }, s, {});
  assert.equal(k.reason, 'WAIT');
  // One slot, one body: its own bye is always a shortfall of 1.
  assert.equal(k.score, 150 + KDEF_PENALTY + BYE_PENALTY);
});

test('byeWarning names the week and count, and is null when covered', () => {
  // Needs real depth for a clean case to exist: 3 WRs on 7/7/10 against 2 slots.
  const s = rosterState(SPOTS, [
    { pos: 'WR', rank: 8, bye: 7 }, { pos: 'WR', rank: 30, bye: 7 },
    { pos: 'WR', rank: 44, bye: 10 },
  ]);
  assert.equal(scorePlayer({ pos: 'WR', rank: 60, bye: 14 }, s, {}).byeWarning, null,
    'a fresh bye against covered slots warns about nothing');
  const w = scorePlayer({ pos: 'WR', rank: 60, bye: 7 }, s, {}).byeWarning;
  assert.match(w, /7/, 'names the week');
  assert.match(w, /1/, 'names the count');
});

test('an excluded player gets no bye commentary and stays Infinity', () => {
  const s = rosterState(SPOTS, [
    { pos: 'QB', rank: 1, bye: 7 }, { pos: 'QB', rank: 2, bye: 7 },
    { pos: 'QB', rank: 3, bye: 7 },
  ]);
  const r = scorePlayer({ pos: 'QB', rank: 10, bye: 7 }, s, { QB: 3 });
  assert.equal(r.excluded, true);
  assert.equal(r.score, Infinity);
  assert.equal(r.byeWarning, null);
});

test('weights.byePenalty overrides the constant', () => {
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const p = { pos: 'WR', rank: 40, bye: 7 };
  const base = scorePlayer(p, s, {}, { byePenalty: 0 }).score;
  assert.equal(scorePlayer(p, s, {}, { byePenalty: 30 }).score - base, 30 * 2);
});

test('a player with no bye data is never penalized', () => {
  const s = rosterState(SPOTS, [{ pos: 'WR', rank: 8, bye: 7 }]);
  const r = scorePlayer({ pos: 'WR', rank: 40, bye: null }, s, {});
  assert.equal(r.score, 40 - STARTER_BONUS);
  assert.equal(r.byeWarning, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recommend.test.js`
Expected: FAIL — `byeWarning` is `undefined` and scores lack the penalty.

- [ ] **Step 3: Restructure `scorePlayer` to a single exit and apply the penalty**

Keep the exclusion early return exactly as it is. Convert the other four returns
to assignments, then apply the penalty once:

```js
function scorePlayer(player, state, limits = {}, weights = {}) {
  const starterBonus = weights.starterBonus ?? STARTER_BONUS;
  const flexBonus = weights.flexBonus ?? FLEX_BONUS;
  const byePenalty = weights.byePenalty ?? BYE_PENALTY;
  const pos = player.pos || '';
  const rank = Number.isFinite(player.rank) ? player.rank : UNRANKED;

  // Roster rules come first: an open slot cannot be filled by a player the
  // league forbids, so exclusion is checked before any bonus. A forbidden
  // player needs no bye commentary, and Infinity + 6 is still Infinity.
  const limit = limits[pos];
  if (limit !== undefined && (state.posCounts[pos] || 0) >= limit) {
    return { score: Infinity, reason: `${pos} LIMIT (${limit})`, excluded: true, byeWarning: null };
  }

  // Each branch decides the slot story; the bye penalty is applied once, below,
  // so it cannot be forgotten at one of the four return sites.
  let score;
  let reason;
  if (KDEF_POSITIONS.includes(pos)) {
    if (state.kdefUrgent && (state.openStarters[pos] || 0) > 0) {
      score = rank - starterBonus; reason = `FILLS ${pos}`;
    } else {
      score = rank + KDEF_PENALTY; reason = 'WAIT';
    }
  } else if ((state.openStarters[pos] || 0) > 0) {
    score = rank - starterBonus; reason = `FILLS ${pos}`;
  } else if (state.openFlex > 0 && FLEX_ELIGIBLE.includes(pos)) {
    score = rank - flexBonus; reason = 'FILLS FLEX';
  } else {
    score = rank; reason = 'BENCH';
  }

  const shortfall = byeShortfall(
    player.bye,
    (state.posByes || {})[pos],
    (state.posSlots || {})[pos]
  );

  return {
    score: score + byePenalty * shortfall,
    reason,
    excluded: false,
    byeWarning: shortfall > 0 ? `BYE ${player.bye} ×${shortfall}` : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass. **The 85 pre-existing tests must be unmodified** — if one now
fails, a bye penalty is leaking into a fixture that did not expect it. Fix by
giving that fixture a non-conflicting bye, never by weakening the assertion, and
report which fixture and why.

- [ ] **Step 5: Commit**

```bash
git add js/recommend.js test/recommend.test.js
git commit -m "Fold the bye penalty into scorePlayer

Restructured to a single exit for the non-excluded branches so the penalty
cannot be applied to one return site and forgotten at the other three. Adds
byeWarning for the UI and weights.byePenalty for calibration."
```

---

### Task 4: Surface it

**Files:**
- Modify: `js/ui/PlayersTable.js`, `js/ui/GlanceView.js`
- Modify: `css/styles.css` (append only)

**Interfaces:**
- Consumes: `byeWarning` from each `recommendOrder` entry.
- Produces: no exports.

- [ ] **Step 0: Badge only an AVOIDABLE shortfall**

Found in Task 3's review, and verified: on an empty roster **8 of 8 candidates**
carry a non-null `byeWarning`, because the first player at any position is always
short in his own bye week. Badging all of them is noise, and a warning that
always fires teaches the user to ignore it — the same failure this project
already had to design around for the amber sync banner.

A shortfall is only worth showing when a *different bye* would have reduced it.
That is computable by comparing against a bye nobody holds:

```js
// In js/recommend.js, exported alongside the others.
//
// Shortfall a different bye could have avoided. The first player at a position
// is always short in his own bye week, and every candidate at that position
// shares that — so it is not a choice and must not be badged. Two bodies against
// two slots is likewise unavoidable whatever their byes.
const NO_SUCH_WEEK = -1; // finite, so it counts as a real week, but one no player holds
function avoidableByeShortfall(candidateBye, rosteredByes, startersNeeded) {
  const actual = byeShortfall(candidateBye, rosteredByes, startersNeeded);
  if (actual === 0) return 0;
  const floor = byeShortfall(NO_SUCH_WEEK, rosteredByes, startersNeeded);
  return Math.max(0, actual - floor);
}
```

`scorePlayer` sets `byeWarning` from **`avoidableByeShortfall`**, while `score`
keeps using the raw `byeShortfall`. That split is deliberate: the penalty is what
the pick actually costs you, which is true even when unavoidable; the badge is
"you could have done better here", which is only true sometimes. The raw penalty
is uniform across candidates at a position, so it never distorts their ordering.

Verified behavior — the badge appears in exactly the third row:

| Rostered at RB (2 slots) | Candidate | actual / floor | Badge |
| --- | --- | --- | --- |
| none | RB bye 7 | 1 / 1 | no |
| bye 7, bye 10 | RB bye 12 | 0 / 0 | no |
| bye 7, bye 10 | RB bye 7 | 1 / 0 | **yes** |
| bye 7 | WR bye 11 | 2 / 2 | no |

Add tests for each row, plus one asserting `score` still carries the RAW
penalty when the badge is suppressed — that is the pairing a naive
implementation gets wrong by switching both to avoidable.

- [ ] **Step 1: Board — a second badge in the WHY column**

In `js/ui/PlayersTable.js`, `PlayerRow` destructures `{ player: p, reason, excluded }`.
Add `byeWarning`, and render it after the existing badge. Note the explicit
`${' '}` — htm drops whitespace-only text nodes, so the badges would otherwise
render flush:

```js
    <td>${reason ? html`<span class="why-badge ${whyClass(reason)}">${reason}</span>` : null}${
      byeWarning ? html`${' '}<span class="why-badge bye">${byeWarning}</span>` : null}</td>
```

- [ ] **Step 2: Glance — a line beneath TAKE**

In `js/ui/GlanceView.js`, `Suggestion` renders `entry.reason` in
`.glance-pick-why`. Add the warning as its own element below it, so it reads as a
separate consideration rather than part of the slot reason:

```js
    <div class="glance-pick-why">${entry.reason}</div>
    ${entry.byeWarning ? html`<div class="glance-pick-bye">${entry.byeWarning}</div>` : null}
```

- [ ] **Step 3: Warn when bye data is missing entirely**

From the spec: a CSV with no bye column makes the weighting silently inert, which
is the same failure class as the sync dot — confident output from data that is not
there. In `js/ui/GlanceView.js`, after `mine` is computed:

```js
  // A CSV with no bye column yields bye: null for everyone, so the weighting
  // contributes nothing. Say so rather than letting a clean board imply byes
  // were considered. Gated on having rostered players, so a fresh install is
  // silent, and on ALL of them lacking a bye — a single synced player without
  // one is a hole, not an inert feature.
  const noByeData = mine.length > 0 && !mine.some((p) => Number.isFinite(p.bye));
```

Render it alongside the other status lines — after `.glance-needs`, before the
countdown — not inside the TAKE card:

```js
    ${noByeData ? html`<div class="glance-needs">No bye weeks in your rankings — bye conflicts are not being weighted.</div>` : null}
```

Reusing `.glance-needs` deliberately: it is the established idiom for a
secondary status line on this card, and inventing a class would mean new CSS to
verify in both themes for no gain.

- [ ] **Step 4: Append the styles**

```css
.why-badge.bye { background: var(--status-warning); color: #0b0b0b; }

.glance-pick-bye {
  font-size: 13px;
  font-weight: 600;
  color: var(--status-warning);
  margin-top: 2px;
}
```

`--status-warning` is defined in both the `:root` and `:root[data-theme="light"]`
blocks — verify that before committing. The badge foreground is a fixed dark ink
rather than a token because that amber is identical in both themes, so a
theme-flipping token would fail one of them. This exact mistake has already
shipped invisible text in this file once.

- [ ] **Step 5: Verify in a browser**

Serve with `python3 -m http.server 8080`. Confirm:

1. With a CSV that has byes, drafting two same-bye players at a position makes a
   third same-bye candidate show the `BYE n ×k` badge on the Board and the line
   on Glance.
2. A fresh-bye candidate shows neither.
3. Both themes: the badge and the Glance line are legible, and nothing else moved.
4. A CSV with no bye column shows the "not being weighted" line once you have
   rostered players, and shows nothing on a fresh install.
5. Console clean.

`chrome-headless-shell` is under `~/.cache/puppeteer` and `tools/harness.mjs` has
dependency-free CDP plumbing. No browser-automation package is installed and
adding one is forbidden. If you cannot drive a browser, say so explicitly rather
than claiming checks you did not run.

- [ ] **Step 6: Commit**

```bash
git add js/ui/PlayersTable.js js/ui/GlanceView.js css/styles.css
git commit -m "Surface bye conflicts on the Board and Glance

A second WHY badge on the Board, a line beneath TAKE on Glance, and an
explicit notice when the imported rankings carry no bye weeks at all — so an
inert weighting is never mistaken for a clean board."
```

---

### Task 5: Calibrate the weight

**Files:**
- Create: `tools/calibrate-bye.mjs`

**Interfaces:**
- Consumes: `rosterState`, `recommendOrder` from `js/recommend.js`, using the `weights.byePenalty` added in Task 3.
- Produces: nothing — a diagnostic.

It lives in `tools/`, NOT `test/`: Node's runner collects every `.js` file inside
a directory named `test`.

- [ ] **Step 1: Write it**

Model it on the existing `tools/calibrate.mjs` (or `tools/calibrate.js` — check
which name is present). Requirements:

- A mid-draft roster with a **deliberate bye cluster**: two RBs sharing a bye and
  two WRs sharing a different one, so the penalty has something to act on.
- A board mixing candidates that double up on those weeks with equivalent-rank
  candidates that do not.
- Print the board ordered at `byePenalty` of 3, 6, and 12, showing each entry's
  score, rank, position, reason, and `byeWarning`.
- **Call the real `recommendOrder` with an injected weight.** Do not reimplement
  the scoring — a calibration that drifts from the shipped scorer tells you
  about a program you are not running. This is why `weights.byePenalty` exists.

- [ ] **Step 1b: Make the FLEX_BONUS interaction visible**

Found during Task 4's fixes and verified: `FLEX_BONUS` and `BYE_PENALTY` are both
**6**, so one shortfall week *exactly* erases the FLEX bonus. A FLEX-filling
candidate with a bye conflict scores its raw rank — identical to bench depth at
the same rank:

```
2 RBs rostered on byes 7 and 10 (RB slots full, FLEX open), candidate RB rank 40:
  bye 14 (fresh)     -> 34   FILLS FLEX
  bye 7  (conflict)  -> 40   FILLS FLEX   BYE 7 ×1     <- the -6 is fully cancelled
```

That is an accident of two independently chosen constants, not a decision, and it
has a visible consequence: a badged FLEX candidate can never outscore a
better-ranked unbadged one, so the badge tends to land on a backup suggestion
rather than the headline pick.

The calibration must make this legible rather than bury it. Include in the board a
FLEX-eligible candidate with a bye conflict alongside an equal-rank one without,
and print each row's `reason` and `byeWarning` next to the score so the
cancellation is readable at `byePenalty` 6 and visibly not at 3 or 12.

Add a line to the output naming the relationship explicitly — something like
`note: byePenalty 6 == FLEX_BONUS 6, so one shortfall week cancels the FLEX bonus
exactly`. The owner is choosing a weight; this interaction is part of what they
are choosing and should not have to be rediscovered.

- [ ] **Step 2: Run it and sanity-check by hand**

Run: `node tools/calibrate-bye.mjs`

Confirm by hand for at least two rows that the printed score equals
`rank − needBonus + byePenalty × shortfall`. If it does not, the wiring is wrong,
not the script — report it.

- [ ] **Step 3: Confirm the suite ignores it**

Run: `node --test`
Expected: `calibrate-bye` does not appear, and the test count is unchanged.

- [ ] **Step 4: Report the three boards**

Paste the output. Do not change `BYE_PENALTY` — that decision belongs to the
owner, who will read the three boards and choose.

- [ ] **Step 5: Commit**

```bash
git add tools/calibrate-bye.mjs
git commit -m "Add a bye-penalty calibration script

Prints one mid-draft board with a deliberate bye cluster at penalties 3, 6 and
12, calling the real scorer with an injected weight so the output describes the
shipped program."
```

---

## Verification

After every task:

- [ ] `node --test` — all pass, the 85 pre-existing ones unmodified
- [ ] `node --check` clean on `js/*.js`, `js/ui/*.js`, `tools/*.mjs`
- [ ] `node tools/stale-check.mjs` — still exits 0 (Glance was touched)
- [ ] Untouched and byte-identical to `main`: `js/state.js`, `js/draft.js`,
      `js/positions.js`, `js/limits.js`, `js/csv.js`, `js/sleeper.js`
- [ ] `css/styles.css` shows zero deleted lines against `main`
- [ ] `package.json` still has no `dependencies`
- [ ] Browser: the Task 4 Step 5 checklist, both themes, clean console
