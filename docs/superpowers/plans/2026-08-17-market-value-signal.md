# Market Value Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the imported CSV's `ECR VS. ADP` column so the board shows whether the market drafts a player earlier or later than his rank.

**Architecture:** `js/csv.js` parses the column into `p.ecrVsAdp`. A pure `marketNote()` in `js/ui/market.js` turns that number into display strings and a flag. The Board's dead `ADP` column is relabeled `VALUE` and renders it; Glance adds a line beneath TAKE. **No scoring code is touched.**

**Tech Stack:** Vanilla ES modules, Preact + htm, no build step, no npm. Tests on Node 22's built-in runner.

## Global Constraints

- **No build step, no runtime dependencies, no `node_modules`.** `package.json` must never gain a `dependencies` block.
- **Never import from a URL.** Every import a relative path ending in `.js`.
- **Never edit `js/vendor/preact.js`.**
- **This feature changes NO scoring.** `js/recommend.js` must stay byte-identical: no new weight, no change to `scorePlayer`, `rosterState`, `byeShortfall`, `avoidableByeShortfall`, `recommendOrder`, or any constant. If a task appears to require it, stop and report.
- Also byte-identical: `js/state.js`, `js/draft.js`, `js/positions.js`, `js/limits.js`, `js/sleeper.js`.
- **`css/styles.css` is APPEND-ONLY.** Existing rules are shared with the Board.
- Every CSS custom property used must be defined in BOTH the `:root` and `:root[data-theme="light"]` blocks. A `var()` with no fallback that resolves to nothing computes as `unset`, which has shipped invisible text in this file twice.
- **No JSX.** htm tagged templates only. `class=` not `className`. htm drops whitespace-only text nodes (use `${' '}` between adjacent inline elements) and does NOT decode HTML entities (write plain `&`).
- **`getState()` returns the same object reference every call** — the store mutates in place. No `useMemo`/`useCallback` keyed on store data, no lazy `useState` initializer over store data.
- The 136 existing tests must keep passing unmodified.
- Commit after every task.

**The owner's real CSV** is at `/Users/kyleyoung/Downloads/FantasyPros_2026_Draft_ALL_Rankings (1).csv` — 946 players, header `"RK",TIERS,"PLAYER NAME",TEAM,"POS","BYE WEEK","UPSIDE ","BUST ","SOS SEASON","ECR VS. ADP"`. Use it; do not invent fixtures where the real file will do.

---

### Task 1: Parse `ecrVsAdp`

**Files:**
- Modify: `js/csv.js` (the `HEADER_ALIASES` table and the row builder)
- Create: `test/csv-market.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `p.ecrVsAdp: number | null` on every player from `parseRankingsCsv`. Tasks 2 and 3 consume it.

**THE TRAP, and it is sitting three lines from where you will type.** The existing `adp` line reads:

```js
      adp: colMap.adp !== undefined ? parseFloat(r[colMap.adp]) || null : null,
```

`|| null` turns a parsed `0` into `null`. That is harmless for ADP (pick 0 does not exist) and **fatal here**: `0` means "drafted exactly on rank" and is a real value in the owner's file. Do not copy that pattern. Note also that `Number("")` is `0`, not `NaN`, so coercion alone cannot distinguish an empty cell from a genuine zero.

- [ ] **Step 1: Write the failing tests**

Create `test/csv-market.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRankingsCsv } from '../js/csv.js';

const H = 'RK,TIERS,PLAYER NAME,TEAM,POS,ECR VS. ADP';
const row = (v) => `${H}\n1,1,Some Player,CIN,WR1,${v}`;
const first = (csv) => parseRankingsCsv(csv).players[0];

test('a positive gap parses, plus sign and all', () => {
  assert.equal(first(row('+152')).ecrVsAdp, 152);
});

test('a negative gap parses', () => {
  assert.equal(first(row('-16')).ecrVsAdp, -16);
});

test('zero is a real value, not missing', () => {
  // "drafted exactly on rank". The neighbouring adp line's `|| null` would
  // destroy this, and Number("") === 0 means coercion alone cannot tell a zero
  // from an empty cell.
  assert.equal(first(row('0')).ecrVsAdp, 0);
});

test('a bare dash is missing, not zero', () => {
  // 612 of the owner's 946 rows are exactly this.
  assert.equal(first(row('-')).ecrVsAdp, null);
});

test('an empty cell is missing, not zero', () => {
  assert.equal(first(row('')).ecrVsAdp, null);
});

test('junk is missing, not zero', () => {
  assert.equal(first(row('n/a')).ecrVsAdp, null);
  assert.equal(first(row('1.5')).ecrVsAdp, null, 'the column is integers; a decimal is unexpected');
});

test('a CSV with no such column yields null, with no warning', () => {
  const { players, warnings } = parseRankingsCsv('RK,PLAYER NAME,POS\n1,Some Player,WR1');
  assert.equal(players[0].ecrVsAdp, null);
  assert.equal(warnings.length, 0, 'an absent market column is not worth warning about');
});

test('the header alias tolerates spacing and case', () => {
  for (const h of ['ECR VS. ADP', 'ecr vs. adp', '  ECR   VS. ADP  ', 'ECR VS ADP']) {
    const csv = `RK,PLAYER NAME,POS,${h}\n1,Some Player,WR1,-16`;
    assert.equal(parseRankingsCsv(csv).players[0].ecrVsAdp, -16, `failed on ${JSON.stringify(h)}`);
  }
});

test("the owner's real export parses as measured", async () => {
  const text = await readFile('/Users/kyleyoung/Downloads/FantasyPros_2026_Draft_ALL_Rankings (1).csv', 'utf8');
  const { players } = parseRankingsCsv(text);
  assert.equal(players.length, 946);
  const withValue = players.filter((p) => Number.isFinite(p.ecrVsAdp));
  assert.equal(withValue.length, 334, '334 rows carry a number; the other 612 are "-"');
  // Fully populated exactly where drafting happens.
  const top150 = players.filter((p) => p.rank <= 150);
  assert.equal(top150.filter((p) => Number.isFinite(p.ecrVsAdp)).length, 150);
  // Spot-check both extremes and a bye, so a column-order regression is caught.
  const noel = players.find((p) => p.name === 'Jaylin Noel');
  assert.equal(noel.ecrVsAdp, 152);
  const jacobs = players.find((p) => p.name === 'Josh Jacobs');
  assert.equal(jacobs.ecrVsAdp, -10);
  // 11, verified against the file. An earlier draft of this plan asserted 8 --
  // fabricated, not measured: only Jacobs' rank and gap were ever checked. Task
  // 1's implementer hit the failure and generously attributed it to a refreshed
  // download; the file's mtime proves it never changed.
  assert.equal(jacobs.bye, 11, 'bye still parses -- the new column must not shift the map');
});
```

If the real-file test cannot read the CSV (the owner may move it), **do not delete it** — report that it was skipped and why.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/csv-market.test.js`
Expected: FAIL — `ecrVsAdp` is `undefined`.

- [ ] **Step 3: Implement**

Add to `HEADER_ALIASES`, after `adp`:

```js
  ecrVsAdp: ['ecr vs. adp', 'ecr vs adp'],
```

Add a parser beside `cleanBye`:

```js
// The market gap: how far a player's expert consensus rank sits from where he is
// actually drafted. Negative means drafted EARLIER than ranked.
//
// Shape-tested rather than coerced, deliberately. Number("") is 0, not NaN, so
// coercion cannot distinguish an empty cell from a genuine zero -- and 0 is a
// real value here ("drafted exactly on rank"). The neighbouring `adp` field uses
// `parseFloat(...) || null`, which destroys a zero; that is harmless for a pick
// number and would be a silent wrong answer for this one.
function cleanMarketGap(raw) {
  const s = String(raw ?? '').trim();
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}
```

And in the row builder, after `adp`:

```js
      ecrVsAdp: colMap.ecrVsAdp !== undefined ? cleanMarketGap(r[colMap.ecrVsAdp]) : null,
```

- [ ] **Step 4: Verify**

Run: `node --test`
Expected: all pass, the 136 pre-existing ones unmodified.

- [ ] **Step 5: Commit**

```bash
git add js/csv.js test/csv-market.test.js
git commit -m "Parse ECR VS. ADP from the rankings CSV

Shape-tested rather than coerced: Number(\"\") is 0, so coercion cannot tell an
empty cell from a genuine zero, and zero is a real value here. Verified against
the owner's 946-player export -- 334 rows carry a number, 150/150 in the top
150, the rest are a bare dash."
```

---

### Task 2: `marketNote`

**Files:**
- Create: `js/ui/market.js`, `test/market.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `marketNote(ecrVsAdp) -> { short, long, flagged } | null` and `MARKET_FLAG_AT = 8`. Task 3 consumes both.

Two strings because the two surfaces need different lengths, and rebuilding one from the raw number at a call site is how a threshold ends up encoded twice and drifting.

- [ ] **Step 1: Write the failing tests**

Create `test/market.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketNote, MARKET_FLAG_AT } from '../js/ui/market.js';

test('the flag threshold is 8', () => {
  // Chosen from the owner's file: 8 flags ~1 player per round in his first six.
  assert.equal(MARKET_FLAG_AT, 8);
});

test('a missing gap has nothing to say', () => {
  assert.equal(marketNote(null), null);
  assert.equal(marketNote(undefined), null);
  assert.equal(marketNote(NaN), null);
  assert.equal(marketNote('  '), null);
});

test('negative means the market takes him EARLY', () => {
  const n = marketNote(-10);
  assert.match(n.short, /10/);
  assert.match(n.short, /early/i);
  assert.match(n.long, /before/i, 'the sentence must say before, not after');
  assert.equal(n.flagged, true);
});

test('positive means he LASTS longer than his rank', () => {
  const n = marketNote(11);
  assert.match(n.short, /11/);
  assert.match(n.short, /late/i);
  assert.match(n.long, /longer|after|later/i);
  assert.equal(n.flagged, true);
});

test('the short form never shows a raw sign', () => {
  // One column, one convention: the direction is a word, never a minus sign,
  // because negative-means-urgent is backwards from intuition.
  for (const v of [-31, -8, -3, 0, 3, 8, 31]) {
    const n = marketNote(v);
    assert.ok(!/[-−+]/.test(n.short), `${v} produced "${n.short}"`);
  }
});

test('zero is present but says neither direction', () => {
  const n = marketNote(0);
  assert.notEqual(n, null, 'zero is a real value');
  assert.equal(n.flagged, false);
  assert.ok(!/early|late/i.test(n.short), `zero should not claim a direction: "${n.short}"`);
});

test('the threshold is exact in both directions', () => {
  assert.equal(marketNote(-7).flagged, false);
  assert.equal(marketNote(-8).flagged, true);
  assert.equal(marketNote(7).flagged, false);
  assert.equal(marketNote(8).flagged, true);
});

test('a below-threshold gap still reports, just unflagged', () => {
  // The Board shows it unstyled; it is real data and costs nothing.
  const n = marketNote(3);
  assert.equal(n.flagged, false);
  assert.match(n.short, /3/);
  assert.match(n.short, /late/i);
});

test('the real file\'s extremes produce sane text', () => {
  assert.equal(marketNote(152).flagged, true);
  assert.equal(marketNote(-464).flagged, true);
  assert.match(marketNote(152).short, /152/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/market.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `js/ui/market.js`:

```js
// The market-value signal: how far a player's expert consensus rank sits from
// where he is actually drafted. Pure -- no DOM, no store.
//
// Sign convention, stated once here so no call site has to remember it:
//   NEGATIVE -> drafted EARLIER than ranked -> he will be gone, take him now
//   POSITIVE -> drafted LATER  than ranked -> he lasts, you can wait
//
// That is backwards from intuition (a minus sign reads as "worse player"), so
// the rendered strings always name the direction in words and never show a raw
// sign. One column, one convention.

// Flags roughly one player per round across the owner's first six rounds. At 5
// it becomes wallpaper (23 in the top 60); at 12 it nearly vanishes (1).
export const MARKET_FLAG_AT = 8;

export function marketNote(gap) {
  if (!Number.isFinite(gap)) return null;
  const n = Math.abs(gap);
  const flagged = n >= MARKET_FLAG_AT;

  if (gap === 0) {
    return { short: 'on rank', long: 'drafted right about at his rank', flagged: false };
  }
  if (gap < 0) {
    return {
      short: `${n} early`,
      long: `usually gone ~${n} picks before this`,
      flagged,
    };
  }
  return {
    short: `${n} late`,
    long: `usually still there ~${n} picks later`,
    flagged,
  };
}
```

- [ ] **Step 4: Verify**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add js/ui/market.js test/market.test.js
git commit -m "Add marketNote: the ECR-vs-ADP signal as display strings

Two strings because the Board cell and the Glance line need different lengths;
rebuilding one from the raw number at a call site is how a threshold ends up
encoded twice. The short form never shows a raw sign -- negative-means-urgent is
backwards from intuition, so the direction is always a word."
```

---

### Task 3: Surface it

**Files:**
- Modify: `js/ui/PlayersTable.js`, `js/ui/GlanceView.js`, `css/styles.css` (append only)

**Interfaces:**
- Consumes: `marketNote` from `js/ui/market.js`.
- Produces: no exports.

- [ ] **Step 1: Relabel the Board column**

`js/ui/PlayersTable.js:137` currently reads:

```js
          <th>Bye</th><th>ADP</th><th>Why</th><th>Status</th><th></th>
```

Change `ADP` to `Value`. The column count stays at 9, so the `colspan="9"` on the
limit divider and the need-notice rows stays correct — **verify that rather than
assuming it**.

- [ ] **Step 2: Render it in the cell**

`js/ui/PlayersTable.js:56` currently reads:

```js
    <td class="player-meta">${p.adp ?? ''}</td>
```

Replace with the market note. Compute it once above the template:

```js
  const market = marketNote(p.ecrVsAdp);
```

and render:

```js
    <td class="player-meta">${market
      ? (market.flagged
          ? html`<span class="market-badge ${p.ecrVsAdp < 0 ? 'early' : 'late'}">${market.short}</span>`
          : market.short)
      : ''}</td>
```

`p.adp` stops being displayed. It is still parsed and stored — do not remove it
from `js/csv.js`.

- [ ] **Step 3: Add the Glance line**

In `js/ui/GlanceView.js`, `Suggestion` already renders `entry.reason` and
`entry.byeWarning`. Add the market line **only when flagged** — Glance is a
two-second read and an unflagged gap is not worth a line there:

```js
    ${(() => {
      const m = marketNote(p.ecrVsAdp);
      return m && m.flagged
        ? html`<div class="glance-pick-market">${m.long}</div>`
        : null;
    })()}
```

Place it after the bye line so the ordering reads: what he fills, what it costs
you in byes, what the market does.

- [ ] **Step 4: Append the styles**

```css
/* The market signal. Emphasis only -- direction is carried by the words
   ("10 early" / "11 late"), never by colour alone, so this stays legible to a
   colour-blind reader and in a screenshot. */
.market-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  white-space: nowrap;
  background: var(--surface-3);
  color: var(--text-primary);
}
.market-badge.early { background: var(--status-critical); color: #fff; }

.glance-pick-market {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 2px;
}
```

`--surface-3`, `--text-primary`, `--status-critical`, `--text-secondary` must all
exist in BOTH theme blocks — check, do not assume. Only `early` gets a colour:
it is the urgent direction, and colouring both would make the column a stripe of
noise. Measure the `.early` contrast in both themes and report it; if white on
`--status-critical` falls below 4.5:1, use a fixed dark ink as the bye badge
does, since that token is identical in both themes.

- [ ] **Step 5: Verify in a browser**

Serve with `python3 -m http.server 8080`. Import the owner's real CSV. Confirm:

1. The Board header reads `Value`, not `ADP`.
2. Josh Jacobs (rank 39) shows a flagged `10 early`; Terry McLaurin (45) shows `11 late`.
3. A below-threshold player shows unstyled text with no badge and **no raw minus sign anywhere in the column**.
4. A player whose gap is `-` (rank 400+) shows an empty cell.
5. Glance shows the long line for a flagged TAKE and nothing for an unflagged one.
6. Both themes: badge and line legible; nothing else moved.
7. `colspan="9"` rows still span the full table.
8. Console clean.

`chrome-headless-shell` is under `~/.cache/puppeteer`; `tools/harness.mjs` has the
CDP plumbing. No automation package is installed and adding one is forbidden. If
you cannot drive a browser, say so explicitly rather than claiming these.

- [ ] **Step 6: Commit**

```bash
git add js/ui/PlayersTable.js js/ui/GlanceView.js css/styles.css
git commit -m "Surface the market signal on the Board and Glance

Reuses the ADP column, which is empty for this CSV -- FantasyPros ships the
difference, not the raw figure -- rather than adding a tenth column to a table
that only just stopped overflowing a phone viewport."
```

---

### Task 4: Prove the rendering, and check the real file end to end

**Files:**
- Create: `tools/market-ui-check.mjs`

**Interfaces:** none.

`tools/bye-ui-check.mjs` is the precedent — read it and follow its shape. In
`tools/`, not `test/`: Node's runner collects every `.js` file under a directory
named `test`.

- [ ] **Step 1: Write the check**

Reuse `tools/harness.mjs` (`serve`, `launchChrome`, `Page`, its seeded scenarios).
Assert, in both themes:

- a flagged-early player renders `.market-badge.early` with the expected text;
- a flagged-late player renders a badge without the `early` class;
- a below-threshold player renders text with **no** `.market-badge` element;
- a `null`-gap player renders an empty cell;
- **no raw `-` or `−` appears anywhere in the Value column** — this is the design's
  central claim and the easiest thing to regress;
- the `.early` badge's computed contrast is ≥ 4.5:1 in both themes;
- the Glance long line appears for a flagged TAKE and is absent for an unflagged one;
- the header cell reads `Value`.

Seed from the real values in the owner's file (Jacobs −10, McLaurin +11) so the
fixture matches production data rather than invented numbers.

The shape — wire the plumbing from `bye-ui-check.mjs` rather than from this
skeleton, since its exact API is what that file demonstrates. **Confirm
`serve`/`launchChrome`'s return values against the source**: a previous plan on
this project got them wrong (`serve` returns `{server, origin}`, and
`launchChrome` returns a Promise, so an un-awaited assignment passes a Promise as
the host).

```js
// Proves the market signal renders. In tools/, not test/: node --test collects
// every .js under a directory named test.
import { serve, launchChrome, Page, STORAGE_KEY, THEME_KEY } from './harness.mjs';

// Real gaps from the owner's export, so the fixture is production data.
const BOARD = [
  { id: 'p1', rank: 39, name: 'Josh Jacobs',    team: 'GB',  pos: 'RB', bye: 8,  ecrVsAdp: -10 },
  { id: 'p2', rank: 45, name: 'Terry McLaurin', team: 'WAS', pos: 'WR', bye: 12, ecrVsAdp: 11 },
  { id: 'p3', rank: 60, name: 'Small Gap',      team: 'CIN', pos: 'WR', bye: 10, ecrVsAdp: -3 },
  { id: 'p4', rank: 80, name: 'No Data',        team: 'NYJ', pos: 'RB', bye: 6,  ecrVsAdp: null },
];

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures += 1;
}

// Per theme, after seeding BOARD and switching to the board view:
async function checkTheme(page, theme) {
  const cells = await page.eval(`
    [...document.querySelectorAll('table.players tbody tr')].map((tr) => {
      const td = tr.children[5];               // the Value column
      const badge = td.querySelector('.market-badge');
      return {
        name: tr.children[1].innerText.trim(),
        text: td.innerText.trim(),
        badge: badge ? badge.className : null,
      };
    })
  `);

  const by = (n) => cells.find((c) => c.name.startsWith(n)) || {};
  check(`[${theme}] an early gap is badged early`,
    /early/.test(by('Josh Jacobs').badge || ''), JSON.stringify(by('Josh Jacobs')));
  check(`[${theme}] a late gap is badged, but not early`,
    by('Terry McLaurin').badge && !/early/.test(by('Terry McLaurin').badge),
    JSON.stringify(by('Terry McLaurin')));
  check(`[${theme}] a below-threshold gap has text but no badge`,
    by('Small Gap').badge === null && /3/.test(by('Small Gap').text || ''),
    JSON.stringify(by('Small Gap')));
  check(`[${theme}] a null gap renders an empty cell`,
    by('No Data').text === '', JSON.stringify(by('No Data')));

  // The design's central claim, and the easiest thing to regress.
  const signs = cells.filter((c) => /[-\u2212]/.test(c.text));
  check(`[${theme}] no raw sign anywhere in the Value column`,
    signs.length === 0, JSON.stringify(signs));

  check(`[${theme}] the header reads Value`,
    (await page.eval(`document.querySelectorAll('table.players thead th')[5].innerText.trim()`)) === 'Value');
}
```

Measure the `.early` badge's contrast with `getComputedStyle` and a WCAG helper —
`bye-ui-check.mjs` already has one; reuse it rather than writing a second.

- [ ] **Step 2: Prove it can fail**

Break each of these in turn, confirm the check exits non-zero, restore, and
**report the actual failure output**:

1. Make `marketNote`'s short form return the raw signed number.
2. Drop the `.market-badge.early` rule.
3. Lower `MARKET_FLAG_AT` to 1 (so everything flags).
4. Render `p.adp` in the cell again instead of the note.

Four tools on this project have passed while blind to what they claimed to cover.
A check never observed failing is not evidence.

- [ ] **Step 3: Confirm the suite ignores it and nothing regressed**

Run: `node --test` — all pass, and `market-ui-check` does not appear.
Run: `node tools/bye-ui-check.mjs` and `node tools/stale-check.mjs` — both exit 0.
Run: `node tools/screenshot-diff.mjs --ref <the commit before Task 1>` — the Value
column is an intended difference; confirm **nothing outside it** changed, and
report the per-scenario numbers. Never pipe it to `head`; SIGPIPE defeats its
cleanup. Clean a leaked worktree with `git worktree remove --force`.

- [ ] **Step 4: Commit**

```bash
git add tools/market-ui-check.mjs
git commit -m "Add a browser check for the market signal

Asserts no raw sign reaches the Value column -- the design's central claim and
the easiest thing to regress -- plus badge presence at the threshold and
contrast in both themes. Observed failing four ways before being trusted."
```

---

## Verification

After every task:

- [ ] `node --test` — all pass, the 136 pre-existing ones unmodified
- [ ] `node --check` clean on `js/*.js`, `js/ui/*.js`, `tools/*.mjs`
- [ ] `js/recommend.js` byte-identical to `main` — **this feature changes no scoring**:
      `git diff --stat main -- js/recommend.js` is empty
- [ ] Also byte-identical: `js/state.js`, `js/draft.js`, `js/positions.js`, `js/limits.js`, `js/sleeper.js`
- [ ] `css/styles.css` shows zero deleted lines against `main`
- [ ] `package.json` still has no `dependencies`
- [ ] `node tools/market-ui-check.mjs`, `tools/bye-ui-check.mjs`, `tools/stale-check.mjs` all exit 0
- [ ] Browser: the Task 3 Step 5 checklist against the owner's real CSV, both themes, clean console
