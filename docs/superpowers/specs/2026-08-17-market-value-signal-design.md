# Market Value Signal (ECR vs ADP) — Design

Date: 2026-08-17
Status: Approved, ready for implementation planning

## Problem

The recommender answers one question well: *who is the best pick for my roster
right now*, weighting talent against open starting slots, position limits, and
bye concentration.

It cannot answer the other half of a draft decision: *do I need to take him now,
or will he still be here next round?* Without that, the only way to act on
scarcity is intuition.

The data to answer it is already in the file the owner imports and is currently
discarded.

## What the CSV actually contains

Measured against the owner's real export
(`FantasyPros_2026_Draft_ALL_Rankings`, 946 players):

| Column | Fill | Status |
| --- | --- | --- |
| `RK`, `TIERS`, `PLAYER NAME`, `TEAM`, `POS`, `BYE WEEK` | 946/946 | already imported |
| `ECR VS. ADP` | 100% of the top 300; `-` below | **the subject of this spec** |
| `SOS SEASON` | 946/946 (54 are `-`) | rejected, see Non-goals |
| `UPSIDE`, `BUST` | **20/946 (2%)** | unusable |

There is **no ADP column** — FantasyPros supplies the difference, not the raw
figure. So the Board's existing `ADP` column renders empty on every row today.

## Goals

- Surface, per player, whether the market drafts him earlier or later than his
  rank — so scarcity becomes visible instead of guessed at.
- Flag only gaps large enough to change a decision.
- Change no scoring behavior.

## Non-goals

- **No scoring weight.** See Decisions.
- **`SOS SEASON`.** Fully populated, but it is a season aggregate: it says
  nothing about which weeks a player is startable, which is the only thing a
  strength-of-schedule number could usefully inform. Thin draft-day value.
- **`UPSIDE` / `BUST`.** 2% filled. Nothing can be built on that.
- No attempt to source ADP from anywhere else.

## Decisions

### Display only, not a scoring weight

Measured gap magnitudes in the range where drafting happens are ±5–12 (median
~5–6 within the first 60 picks). `STARTER_BONUS` — the strongest signal in the
entire system — is **12**.

So feeding the raw gap into the score would let market drift rival "this fills
an empty starting slot." A scaled version (a third of the gap, clamped to ±4) was
considered and rejected: it would be a **fourth** interacting weight, and the
third one — bye weighting — required two separate design reversals that only a
purpose-built calibration script caught. The evidence does not support spending
that risk on a signal the owner can read directly.

### Reframed direction, not the raw sign

The raw sign is backwards from intuition: **negative means urgency** (drafted
earlier than ranked, so he will be gone) and positive means the opposite. A cell
reading `−10` invites being read as "bad player."

The UI therefore states the direction in words — `10 early` / `11 late` — rather
than requiring the reader to hold the convention in mind under a pick clock.

### Flag threshold: |gap| ≥ 8

Chosen from the owner's own file rather than picked:

| Threshold | flagged in top 60 | top 100 | top 150 |
| --- | --- | --- | --- |
| ≥ 5 | 23 | 45 | 82 |
| **≥ 8** | **8** | **19** | **48** |
| ≥ 10 | 6 | 14 | 38 |
| ≥ 12 | 1 | 6 | 25 |

At 8 the top 60 — the owner's first six rounds — carries roughly one flag per
round. At 5 it becomes wallpaper; at 12 it nearly vanishes.

### The `ADP` column is relabeled, not supplemented

The Board already has nine columns and a phone viewport that was overflowing
until recently. `ADP` is empty for this CSV, so the column is reused rather than
a tenth added. Raw ADP stops being displayed; it is still parsed and stored, so a
CSV that carries it loses nothing but the display.

## Parsing

`p.ecrVsAdp: number | null`, from an alias list of `['ecr vs. adp', 'ecr vs adp']`
(the existing header normalizer already trims and lowercases, which matters —
this export ships headers with trailing spaces, e.g. `"UPSIDE "`).

**The values in the file are only signed integers or a bare `-`.** The parser must
test the shape rather than trust coercion:

```js
/^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null
```

`Number("")` returns **0**, not `NaN` — so an empty cell would silently parse as
"drafted exactly on rank," a confident wrong answer. This is the same trap as the
bye-`0` case already documented in `byeShortfall`: a falsy-but-valid number and a
missing value must not be conflated.

Verified against the real file: 946/946 rows parse; 612 yield `null`, all of them
below rank ~300.

## Surfacing

Both surfaces read a single derived field so the threshold lives in one place.

**Board** — the relabeled `VALUE` column:

```
 RANK  PLAYER            POS  VALUE     WHY
   39  Josh Jacobs       RB   10 early  FILLS RB
   45  Terry McLaurin    WR   11 late   BENCH
   72  Some Player       RB   3 early
```

Badged at |gap| ≥ 8; below the threshold the same wording renders unstyled.

**One column, one convention.** An earlier draft of this spec showed words when
flagged (`10 early`) and a raw signed number when not (`−3`), which puts two
readings of the same quantity in one column — and the raw one carries exactly the
backwards sign this design set out to avoid. The direction word is used at every
magnitude; only the emphasis changes. `null` renders empty.

**Glance** — one line beneath TAKE, only when flagged:

```
TAKE
  Josh Jacobs      RB   #39
  fills your empty RB
  usually gone ~10 picks before this
```

Consistent with how `byeWarning` already behaves: `null` when there is nothing to
say, so neither surface renders anything in the common case.

## What the signal actually shows in this file

Worth recording, because it is the pattern rather than the per-player noise, and
it is what makes the feature worth building. Within the first 60 picks:

```
RBs skew NEGATIVE (go earlier than ranked)   WRs skew POSITIVE (last longer)
  Skattebo −12   Judkins −10                   McLaurin +11   Adams  +10
  Jacobs   −10   Irving  −10                   Watson    +8   Brown   +7
  Love      −8   Montgomery −7                 McMillan  +7   London  +6
```

That is the familiar RB-overdraft bias appearing in the owner's own data. The
actionable reading is positional, not per-player: **if you want an RB, take him
before his rank; the WRs will still be there.**

A per-position aggregate line was considered and deferred — it is a second
feature on a card whose whole value is brevity, and the per-player figure already
carries the information.

## Error handling

| Situation | Behavior |
| --- | --- |
| CSV has no `ECR VS. ADP` column | every `ecrVsAdp` is `null`; column empty, no Glance line, no notice |
| Value is `-` or empty | `null` |
| Value is `0` | a real value — "drafted exactly on rank" — not missing |
| Sleeper-synced player absent from the CSV | `null`, like `bye` |
| Gap below threshold | same wording on the Board but unstyled, nothing on Glance |

Deliberately no "this CSV has no market data" notice, unlike the bye case. The
bye notice exists because bye weighting silently affects the *score*; this
feature affects only what is displayed, so its absence is self-evident from an
empty column rather than being invisible machinery.

## Testing

A pure helper carries the only logic worth testing:

```
marketNote(ecrVsAdp) -> { short: string, long: string, flagged: boolean } | null
```

Two strings, not one: the Board cell needs a compact form (`10 early`) and the
Glance line needs a sentence (`usually gone ~10 picks before this`). A single
`text` field would force one surface to rebuild the other's wording from the raw
number, which is how a threshold or a direction ends up encoded in two places and
drifting — the divergent-guard failure this project has already had.

Cases: `null` in → `null` out; `0` → present, not flagged; ±7 → not flagged;
±8 → flagged at the boundary in both directions; ±31 (the file's real maximum in
the top 150) → flagged; the wording states the correct direction for each sign.

Plus a parser test over the real shapes — `"+152"`, `"-16"`, `"0"`, `"-"`, `""` —
asserting that the last two are `null` and `"0"` is `0`.

The existing browser check pattern (`tools/bye-ui-check.mjs`) covers the
rendering: the badge appears at the threshold and not below it, on both surfaces,
legible in both themes.
