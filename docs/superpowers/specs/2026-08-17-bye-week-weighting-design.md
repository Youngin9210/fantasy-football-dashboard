# Bye-Week Weighting — Design

Date: 2026-08-17
Status: Approved, ready for implementation planning

## Problem

The recommender scores a pick on talent and roster need. It ignores bye weeks
entirely — `bye` is parsed from the CSV and rendered in the Board's table, but no
scoring path reads it.

That produces a specific, avoidable failure: a roster whose starters at one
position share a bye week. If both starting RBs are out in week 7, that week you
start two bench players. For a single-starter position it is worse — if your QB
and your only backup QB share a bye, that week you have no quarterback at all.

This was listed as a non-goal in both the pick-recommendations and Glance specs.
It is being reversed deliberately: the owner identified it as a real draft-day
factor, and the data is already present.

## Goals

- Penalize a pick that concentrates byes at a position, in the same
  ranking-places currency the rest of the scoring uses.
- Stay quiet once the roster has enough depth to cover a bye — the penalty
  should measure real harm, not merely count coincidences.
- Be visible about the weighting being inactive when the data cannot support it.

## Non-goals

- No per-week full-lineup solve (see Decisions).
- No projections, matchup strength, or strength-of-schedule.
- No change to `STARTER_BONUS`, `FLEX_BONUS`, or the K/DST hold-back rule.
- No attempt to source bye weeks from anywhere other than the imported CSV.

## Decisions

### Shortfall, not same-bye counting

Rejected: penalizing a pick once per already-rostered player at the same position
with the same bye. That over-penalizes depth. With RB1 (bye 7), RB2 (bye 7),
RB3 (bye 10) and RB4 (bye 12), week 7 is genuinely fine — you start RB3 and RB4 —
but a same-bye counter keeps flagging every week-7 RB and would push you off
better players for no reason.

Rejected: a full per-week lineup solve matching the whole roster against every
starting slot including FLEX. Most accurate, but it is a matching problem per
week across 14+ weeks recomputed on every render, and its output is the hardest
to explain on a card being read under a pick clock.

Chosen: per-position shortfall. For each distinct bye week `W` among the
candidate plus everyone already rostered at that position:

```
total        = rosteredAtPosition + 1        (including the candidate)
available(W) = total − (how many of them have bye W)
required     = min(startersNeeded, total)
shortfall(W) = max(0, required − available(W))
byeShortfall = Σ shortfall(W) over all distinct W
```

### `required` is capped at what is actually rostered

Without `min(startersNeeded, total)` the metric fires constantly early in the
draft: one RB against two RB slots is "short" in every week regardless of byes.
The cap makes it measure *bye-caused* shortfall only. Verified behavior:

| Rostered at RB (2 starters needed) | Candidate | Shortfall-weeks |
| --- | --- | --- |
| none | RB bye 7 | 1 — unavoidable; no bye differentiates a first RB |
| bye 7, bye 10 | RB bye 12 | 0 — fully covered |
| bye 7, bye 10 | RB bye 7 | 1 — doubling up costs |
| bye 7 | RB bye 7 | 2 — both starters out together |

So it prefers spreading byes and goes quiet once depth exists.

### Weight: `BYE_PENALTY = 6`

Half of `STARTER_BONUS`. A bye costs one week out of roughly fourteen; an
unfilled starting slot costs the season. Rejected 12 (a 10-rank talent gap losing
to one bad week is too strong) and 3 (too weak to steer away from a shared K/DST
bye, where there is no backup at all).

`score = rank − needBonus + BYE_PENALTY × byeShortfall`, lower still winning.

### FLEX is excluded from `startersNeeded`

Shortfall is computed against a position's *dedicated* slots only: RB 2, WR 2,
QB/TE/K/DST 1 each. FLEX is fillable by any of RB/WR/TE, so making it binding
requires the per-week matching that was rejected above.

This remains correct for a FLEX-bound pick: a third RB is still measured against
RB's two dedicated slots, so a fresh bye yields 0 and a doubled one yields 1.
The simplification's cost is that a genuine FLEX-only bye hole is not detected —
accepted, and recorded here rather than discovered later.

### K and DST carry a permanent `+6`

You roster one of each, so `min(1, 1) = 1` and their own bye week is always a
shortfall of 1. This is uniform across every kicker and every defense, so it
never differentiates between them; its only effect is to slightly deepen the
burial the K/DST hold-back rule already applies. Documented rather than
special-cased, because suppressing it would mean treating those positions
inconsistently with the rest of the model.

## Missing bye data

`bye` is `null` in two situations that mean different things, and only one of
them is benign:

1. **A Sleeper-synced player not present in the imported CSV.**
   `pickToManualPlayer` sets `bye: null`. If such a player lands on the owner's
   roster, the bye picture has a genuine hole for them.
2. **The imported CSV has no bye column at all.** `cleanBye` yields `null` for
   every player, so the entire weighting silently contributes nothing.

Handling:

- Null byes are excluded from the shortfall math — an unknown week cannot be
  reasoned about.
- A candidate whose own bye is null takes no penalty.
- **Case 2 must be visible.** When the owner has rostered players and not one of
  them has a bye, the Glance card says so explicitly. Silently running a
  weighting the user believes is active is the same failure class as the sync
  indicator this project already had to build: confident output from data that
  isn't there.

## Surfacing

`scorePlayer` gains a `byeWarning` field alongside the existing `reason`. They
answer different questions — `reason` is "why this position", `byeWarning` is
"what this costs you in week 7" — and merging them into one string would muddy
both, since the Board renders `reason` as a single badge today.

- **Board:** a second badge in the WHY column, e.g. `BYE 7 ×2`.
- **Glance:** a line beneath TAKE. This is the more valuable placement, since
  Glance is where a decision gets made under a clock.

`byeWarning` is `null` when there is no shortfall, so neither surface renders
anything in the common case.

## Architecture

All of it lands in `js/recommend.js`, which is already pure and fully tested:

```
byeShortfall(candidateBye, rosteredByes, startersNeeded) -> number
BYE_PENALTY = 6                                             (named export, tunable)
scorePlayer(...)  -> gains byeWarning, and byeShortfall folded into score
rosterState(...)  -> gains per-position rostered byes so scorePlayer can see them
```

`rosterState` already walks the owner's drafted players to build `posCounts`; it
gains a parallel `posByes` map (`{POS: [byes]}`) built in the same pass. No new
traversal, and no other module changes.

### `startersNeeded` is the TOTAL dedicated slots, not the open ones

An important trap: `rosterState` already exposes `openStarters`, which counts
*empty* slots and therefore shrinks as the roster fills. Passing that as
`startersNeeded` would be wrong — once both RB slots are filled it reads 0, so
`required` collapses to 0 and every shortfall silently becomes 0, disabling the
feature at exactly the point it matters most.

`startersNeeded` must be the count of slots in `settings.rosterSpots` labeled
with that position, which is constant for the league. `rosterState` therefore
gains a second map, `posSlots` (`{POS: totalDedicatedSlots}`), built from
`rosterSpots` rather than from drafted players. `FLEX` and `BN` are excluded, per
the FLEX decision above.

### The weight is injectable

`scorePlayer` already accepts a `weights` object so the `STARTER_BONUS`
calibration script can exercise the real scorer at several values. `byePenalty`
joins it, defaulting to `BYE_PENALTY`, so the bye calibration script does the
same rather than reimplementing the arithmetic.

`js/ui/PlayersTable.js` and `js/ui/GlanceView.js` render the new field. Nothing
else is touched.

## Testing

`byeShortfall` is pure arithmetic and gets direct coverage:

1. The four rows of the table above.
2. A null candidate bye → 0, no penalty.
3. An all-null rostered set → 0 (nothing knowable to conflict with).
4. A mixed set where some rostered byes are null → nulls excluded, others count.
5. Single-slot positions (K, DST) → own bye always yields 1.
6. **One RB against two slots yields 1, not 2** — the case a naive
   implementation without the `min` cap gets wrong.
7. Three rostered at a two-slot position, all sharing a bye → 2, not 3, because
   `required` caps at the slots, not the roster.

Plus an integration assertion that `scorePlayer`'s returned `score` actually
includes `BYE_PENALTY × shortfall`, since a pure function can be correct while
being wired in wrong.

A calibration script printing one mid-draft board at bye penalties 3, 6, and 12
— the same approach used to settle `STARTER_BONUS` — so the weight is confirmed
against observed ordering rather than assumed. It calls the real scorer with an
injected weight, never a reimplementation of the math.
