# Draft Pick Recommendations — Design

Date: 2026-08-14
Status: Approved, ready for implementation planning

## Problem

The Best Available table is sorted purely by imported CSV rank. It knows nothing
about the roster you're actually building, so during a live draft you have to
hold your open slots, your positional counts, and your league's position limits
in your head while a pick clock runs.

Three things it should account for and currently doesn't:

1. **Starting slots come first** — an unfilled starter (excluding K/DEF) matters
   more than bench depth.
2. **K and DEF come last** — they should not compete for early picks, but you
   must not finish the draft without them.
3. **Position limits are hard caps** — this league allows at most QB 3, RB 6,
   WR 6, TE 3, K 2, DEF 3. Drafting past a cap is illegal, not merely unwise.

## Goals

- Rank available players by fit with the roster being built, without abandoning
  player quality.
- Make the reasoning visible at a glance, so a recommendation can be overridden
  with judgment rather than followed blindly.
- Pull league configuration from Sleeper instead of asking the user to re-enter
  what the API already publishes.

## Non-goals

Explicitly out of scope. Each is defensible on its own; none is needed to make
draft-day picks better, and each adds inputs that can be wrong.

- Custom points-per-player projections for this league's exact scoring.
- Bye-week conflict detection.
- Tier-cliff / "last player before a dropoff" bonuses (a VOR-style refinement
  that was considered and deferred).
- Modeling other teams' needs or predicting positional runs.

## Architecture

A new pure module, `js/recommend.js`, with no DOM access — the same shape as the
existing `js/draft.js`. Scoring is easy to get subtly wrong and hard to verify by
eye mid-draft, so it must be testable in isolation.

```
js/recommend.js   (new, pure)
  rosterState(rosterSpots, myPlayers)      -> open starters, FLEX, bench, per-pos counts
  scorePlayer(player, state, limits)       -> {score, reason, excluded}
  recommendOrder(players, state, limits)   -> sorted array

js/draft.js       assignRosterSlots() feeds rosterState()
js/app.js         sort toggle + WHY column; no scoring logic
js/sleeper.js     connectLeague() also returns rosterPositions + positionLimits
js/state.js       new positionLimits setting; corrected DEFAULT_ROSTER
```

`app.js` remains a rendering layer. All judgment lives in `recommend.js`.

## Scoring

`score = rank - bonus`. Lower score sorts first. Rank is the imported CSV rank.

| Situation                                        | Bonus      | Badge          |
| ------------------------------------------------ | ---------- | -------------- |
| Fills an empty starting slot at their position    | `-12`      | `FILLS TE`     |
| RB/WR/TE, own slots full, FLEX slot open          | `-6`       | `FILLS FLEX`   |
| Bench depth                                       | `0`        | `BENCH`        |
| K/DEF, not yet urgent                             | `+999`     | `WAIT`         |
| K/DEF, urgent (see below)                         | `-12`      | `FILLS K`      |
| At position limit                                 | *excluded* | `QB LIMIT (3)` |

`STARTER_BONUS = 12` and `FLEX_BONUS = 6` are named constants at the top of the
module. `-12` is calibrated so an empty starting slot is worth roughly one round
of draft value: a clearly better player at a filled position still wins, but a
close call breaks toward filling the roster.

Worked example — round 5, TE slot empty, both RB slots full:

```
RB rank 38  ->  38 - 0  = 38   <- recommended
TE rank 55  ->  55 - 12 = 43
```

The RB wins because a 17-rank edge exceeds the 12-point need bonus. A TE at rank
45 would have won instead. This is the intended behavior: need breaks ties, it
does not override talent.

### K/DEF urgency

A flat penalty was rejected as arbitrary. Instead K and DEF surface exactly when
waiting longer becomes risky:

```
picksRemaining = rosterSpots.length - (players drafted by my team)
kdefNeeded     = empty K starting slots + empty DEF starting slots
urgent         = picksRemaining <= kdefNeeded + 1
```

The `+ 1` is a deliberate one-pick buffer: without it you draft a kicker with
your literal last pick and have no room to recover if the defense you wanted is
taken. With a 16-spot roster and both slots empty, K/DEF sit at the bottom all
draft and jump to the top with 3 picks remaining.

This derives entirely from roster size and picks made — no draft-order data
required, so it works whether or not `draft_order` is set. It also self-corrects
if a defense is drafted early for any reason.

### Position limits

A player whose position is already at its configured limit is **excluded from
scoring** and rendered below a divider, greyed, with a `QB LIMIT (3)` badge.

Excluded players stay visible rather than being filtered out. If you are at your
QB limit you still want to see that a top quarterback is sitting there — it is
information about the board, and about whether the limit setting is wrong.

Positions absent from the limits map are treated as unlimited.

**Precedence:** exclusion is evaluated before any bonus. A position can be both
at its limit and have an empty starting slot — for example if a QB is benched
into an injured-reserve situation. In that case the player is excluded; the
empty slot cannot be filled by someone the roster rules forbid.

## Configuration sync

`connectLeague` additionally returns `rosterPositions` (from `roster_positions`)
and `positionLimits` (parsed from the `position_limit_*` settings keys). These
populate the Setup fields on connect and **remain editable** — manual entry
continues to work for anyone not using Sleeper.

Two new settings keys are added, both with defaults that preserve today's
behavior so existing saved states load unchanged through the `Object.assign`
merge in `state.js:load()`:

- `positionLimits: {}` — empty means no limits.
- `sortMode: 'rank'` — the players-table sort, persisted so it survives a
  refresh mid-draft. Valid values are `'rank'` and `'need'`; an unrecognized
  value falls back to `'rank'`.

### DST/DEF normalization (latent bug)

Sleeper reports `DEF`; FantasyPros CSVs report `DST`. `assignRosterSlots` matches
with `p.pos === slot.label`, so once `roster_positions` is synced into roster
spots, the defense slot would silently never fill.

Fix: canonicalize `DEF -> DST` at both ingest boundaries — `cleanPos()` in
`csv.js` and the Sleeper boundary in `sleeper.js`. `DST` is chosen as canonical
because the existing `DEFAULT_ROSTER` and CSS badge classes already use it.
`matchPickToPlayer` and the CSS already tolerate both; only slot assignment is
brittle.

This is a targeted fix in code the feature touches, not unrelated refactoring —
the sync feature would otherwise ship a silent failure.

### Corrected defaults

`DEFAULT_ROSTER` in `state.js` currently has 6 bench spots and orders `DST,K`.
The real league has 7 bench spots and 16 total. Updated to match.

## UI

A sort toggle above the players table: **By rank** (current behavior, default)
and **Best for my roster**. A `WHY` column shows the reason badge in both modes.

```
[ BY RANK ]  [ BEST FOR MY ROSTER * ]

 RANK  PLAYER          POS  WHY
  38   Kenneth Walker  RB   BENCH
  45   Trey McBride    TE   FILLS TE
  52   Jaylen Waddle   WR   FILLS FLEX
  ----------- at position limit -----------
  33   Josh Allen      QB   QB LIMIT (3)
```

One table, one place to look under time pressure. The toggle persists in
settings so it survives a refresh mid-draft.

## Error handling

Every degraded input falls back to pure rank order rather than failing:

- No team selected (`myTeamId` null) — no roster to reason about.
- No rankings imported — empty table, unchanged.
- No position limits configured — all positions unlimited.
- Player with no `rank` — sorts last, as it does today.
- Player with no `pos` — treated as bench depth, never excluded.
- `rosterSpots` shorter than the number of players drafted — `picksRemaining`
  floors at 0; K/DEF read as urgent.

## Testing

Extends the existing harness pattern: a `node` script that loads the real source
from disk, no framework, no repo dependencies.

Cases:

1. Empty starter beats bench on a small rank gap.
2. Large talent gap beats the need bonus (RB 38 vs TE 55 resolves to the RB).
3. Position limit excludes the player and produces the right badge.
4. K/DEF suppressed at pick 1; urgent at exactly `kdefNeeded + 1` picks left.
5. FLEX bonus applies only when own-position slots are full.
6. Each degraded input above returns rank order without throwing.
7. `DST`/`DEF` players fill a defense slot from either spelling.

Additionally, a one-off calibration run printing the same board scored at
`STARTER_BONUS` of 6, 12, and 20, so the weight is chosen from observed behavior
rather than assumed.
