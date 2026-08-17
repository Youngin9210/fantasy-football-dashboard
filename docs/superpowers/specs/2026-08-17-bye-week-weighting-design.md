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
byeShortfall = MAX shortfall(W) over all distinct W
```

**Revised 2026-08-17: the aggregate is the MAX, not the sum.** The original `Σ`
is why the failure in the Problem section above survived the feature built to
prevent it — see "What the peak measures" below. `byeShortfall` answers "in your
worst bye week, how many starters at this position can you not field?", not "how
many starter-weeks do you lose across the season".

**Accepted limitation, recorded rather than fixed: the peak ignores frequency at
3+ dedicated slots.** The sum's blind spot was shared-vs-spread: at N bodies
against N slots it could not tell one doubled week from N spread ones, because
each finite bye costs exactly one either way. The peak fixes that, but trades it
for a different blind spot at deeper positions: once two DIFFERENT weeks already
tie for the worst one, a pick that doubles up a THIRD week is charged nothing,
because the max was already there. Verified: 3 WR slots, rostered byes
`[5, 5, 9]`, a candidate on bye 9 — peak 1, floor 1, avoidable 0, no badge — and
it outranks the next fresh-bye WR on pure rank (14 vs 15), identically unbadged.
The sum missed a shared bye while bodies ≤ slots; the peak misses a second
concentration once depth exists. Neither measure alone is complete — a complete
one would take the peak as the primary figure and the sum as a tiebreak between
candidates that tie on it — but that is more machinery than one line in
`scorePlayer` justifies for a case that cannot even arise on this owner's
default roster shape (RB 2, WR 2): with only 2 dedicated slots there is no
"third week" to hide behind, since two weeks are already all a two-body position
can produce. Strictly better than `main`, which weighs byes not at all. Left
as-is.

### `required` is capped at what is actually rostered

Without `min(startersNeeded, total)` the metric fires constantly early in the
draft: one RB against two RB slots is "short" in every week regardless of byes.
The cap makes it measure *bye-caused* shortfall only. Verified behavior:

| Rostered at RB (2 starters needed) | Candidate | Peak shortfall |
| --- | --- | --- |
| none | RB bye 7 | 1 — unavoidable; no bye differentiates a first RB |
| bye 7, bye 10 | RB bye 12 | 0 — fully covered |
| bye 7, bye 10 | RB bye 7 | 1 — doubling up costs |
| bye 7 | RB bye 11 | 1 — no depth; the worst week still loses a starter |
| bye 7 | RB bye 7 | 2 — both starters out together, and 1 above the row above |

So it prefers spreading byes and goes quiet once depth exists. The last two rows
are the pair that matters and the pair a summed shortfall could not tell apart:
both summed to 2, and both therefore cancelled against the same floor.

### Weight: `BYE_PENALTY = 6`

Half of `STARTER_BONUS`. A bye costs one week out of roughly fourteen; an
unfilled starting slot costs the season. Rejected 12 (a 10-rank talent gap losing
to one bad week is too strong) and 3 (too weak to steer away from a shared K/DST
bye, where there is no backup at all).

`score = rank − needBonus + BYE_PENALTY × avoidableByeShortfall`, lower still
winning.

### Revised 2026-08-17: the score charges only an AVOIDABLE shortfall

The original design charged the RAW shortfall, arguing the cost of a bye hole is
real whether or not it could have been avoided, and that since the penalty is
uniform across candidates at a position it could not distort their ordering.

The uniformity argument was right *within* a position and wrong *across* them.
`tools/calibrate-bye.mjs` made it visible: with an empty TE slot and RB depth, the
only candidate filling a starting slot — the highest-value pick available — was
demoted below third-RB FLEX depth, because as the first body at TE it carried a
shortfall no TE candidate could avoid.

| Weight | First TE (fills a starter) | Fresh RB (FLEX depth) |
| --- | --- | --- |
| raw @ 3 | 33 — 1st | 34 |
| raw @ 6 | 36 — 2nd | 34 |
| raw @ 12 | 42 — 3rd | 34 |
| **avoidable @ 6** | **30 — 1st** | 34 |

So the score now uses `avoidableByeShortfall`, the same measure the badge already
used. Consequences, accepted:

- An unavoidable bye hole is free. It is still a real hole, but no candidate at
  that position can do anything about it, so pricing it only moved picks between
  positions — which is the one thing it should not have done.
- Score and badge now agree, which also removes a class of confusion where a
  player was penalized with no visible explanation.
- `FLEX_BONUS` (6) and `BYE_PENALTY` (6) still cancel exactly for an *avoidable*
  conflict, so a badged FLEX candidate cannot outscore a better-ranked unbadged
  one. That is now a genuine judgement about avoidable conflicts rather than an
  accident applying to every pick.

### FLEX is excluded from `startersNeeded`

Shortfall is computed against a position's *dedicated* slots only: RB 2, WR 2,
QB/TE/K/DST 1 each. FLEX is fillable by any of RB/WR/TE, so making it binding
requires the per-week matching that was rejected above.

This remains correct for a FLEX-bound pick: a third RB is still measured against
RB's two dedicated slots, so a fresh bye yields 0 and a doubled one yields 1.
The simplification's cost is that a genuine FLEX-only bye hole is not detected —
accepted, and recorded here rather than discovered later.

### What the peak measures, and what the sum missed

**Revised 2026-08-17.** This section previously stated that with exactly as many
bodies as slots "spreading the byes does not help", that two WRs against two WR
slots score a shortfall of 2 "whether they share a bye or not", and that the
penalty is therefore *uniform* across candidates at an unfilled position. The
first two were true only of the summed shortfall; the third is now wrong in a
different way — at an unfilled position the penalty is **zero** unless the pick
stacks a bye the position already holds. That blind spot is where the Problem
section's own failure hid, so the section is rewritten rather than deleted.

`byeShortfall` is the **peak weekly** shortfall: in the worst single bye week, how
many of this position's starters can you not field? So with N slots and N bodies:

- Byes **spread** (WR1 bye 7, WR2 bye 11): each of those weeks leaves one slot
  uncovered. Peak 1.
- Byes **shared** (both on bye 7): week 7 leaves *both* uncovered. Peak 2.

The `avoidableByeShortfall` floor — the same measure against a week nobody holds —
is 1 in both cases, so the spread pick is charged 0 and the shared pick is charged
1. That difference is the entire feature: with one RB rostered on bye 9 and the
second RB slot still open, an RB on bye 9 is charged and badged and an RB on bye 6
is not, so the dashboard no longer recommends the pick that puts your whole
starting RB group out in the same week.

It is still true that with no depth *some* shortfall is unavoidable — every N-body
position loses a starter in every bye week its players hold. That residue is
structural, it is identical for every candidate at the position, and the avoidable
measure prices it at nothing. What is NOT structural, and is now priced, is
*concentrating* those weeks on one date.

Under the old `Σ` this section's claim was self-fulfilling: `[7,7]` and `[7,11]`
both summed to 2, so shared and spread were literally the same number and
detection could not begin until an N+1th body existed — after the position group
was already stacked. Verified arithmetically both times; the first time, three
test fixtures drafted by eye were wrong about it, and the second time the suite
pinned the blind spot as an invariant.

### K and DST carry nothing for their own bye week

**Revised 2026-08-17.** This section said they carry a permanent `+6`. They do
not, and the code is right: you roster one of each, so `min(1, 1) = 1` and a lone
kicker's own bye week is a RAW shortfall of 1 — but the no-such-week floor is 1
too, so the AVOIDABLE shortfall is 0 and a lone K is charged nothing and badged
nothing. Pricing it would have been exactly the across-position distortion that
"Revised 2026-08-17: the score charges only an AVOIDABLE shortfall" above
describes: uniform among kickers, but a systematic tax on kickers relative to
everyone else.

Where a K or DST IS charged is a **second** body sharing the first one's bye: one
slot, two bodies, one of them redundant in that week — raw 1, floor 0, avoidable 1.
That is a genuine choice (any other bye covers the week), and it is the case the
Problem section calls worst, since there is no third kicker to start.

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
- **Case 2 must be visible.** When nothing in the imported rankings carries a bye,
  the Glance card says so explicitly. Silently running a weighting the user
  believes is active is the same failure class as the sync indicator this project
  already had to build: confident output from data that isn't there.

  **Revised 2026-08-17: the condition is about the BOARD, and ONLY the board.** It
  originally read "when the owner has rostered players and not one of them has a
  bye", and `hasNoByeData` gated on the roster to match. That was wrong in both
  directions. Case 1 above is the lie: an owner whose roster is nothing but
  unmatched Sleeper picks (all `bye: null`) — entirely ordinary one pick into a
  synced draft — was told the weighting was off while it ran normally for every
  candidate on the board. And the roster gate made the notice *silent* exactly when
  it is most useful: with a bye-less CSV imported and the team picked but no pick
  made yet, `myPlayers.length === 0` suppressed it, in the one window where
  re-exporting the CSV is still free.

  The shipped condition is: a non-empty board, none of whose players carries a
  finite bye. The roster is a subset of the board (`GlanceView` derives it by
  filtering `players`), so a roster clause is implied where it is true and adds only
  false negatives where it is not. A fresh install stays silent because `GlanceView`
  early-returns before the check when `players` is empty.

## Surfacing

`scorePlayer` gains a `byeWarning` field alongside the existing `reason`. They
answer different questions — `reason` is "why this position", `byeWarning` is
"what this costs you in week 7" — and merging them into one string would muddy
both, since the Board renders `reason` as a single badge today.

- **Board:** a second badge in the WHY column, e.g. `BYE 7 ×2`.
- **Glance:** a line beneath TAKE. This is the more valuable placement, since
  Glance is where a decision gets made under a clock.

`byeWarning` is `null` when there is no AVOIDABLE shortfall, so neither surface
renders anything in the common case — and, since the score charges the same
number, a badge is present on exactly the picks that are charged.

## Architecture

All of it lands in `js/recommend.js`, which is already pure and fully tested:

```
byeShortfall(candidateBye, rosteredByes, startersNeeded) -> number
BYE_PENALTY = 6                                             (named export, tunable)
avoidableByeShortfall(candidateBye, rosteredByes, startersNeeded) -> number
                     (actual peak minus the no-such-week floor, clamped at 0)
scorePlayer(...)  -> gains byeWarning, and avoidableByeShortfall folded into score
                     -- ONE local drives both, so they cannot disagree
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

1. Every row of the table above, including the stacked/spread pair that a summed
   shortfall could not distinguish.
2. A null candidate bye → 0, no penalty.
3. An all-null rostered set → 0 (nothing knowable to conflict with).
4. A mixed set where some rostered byes are null → nulls excluded, others count.
5. Single-slot positions (K, DST) → own bye always yields a RAW 1, and an
   AVOIDABLE 0; a second body sharing that bye is avoidable 1.
6. **One RB against two slots yields 1, not 2** — the case a naive
   implementation without the `min` cap gets wrong.
7. Three rostered at a two-slot position, all sharing a bye → 2, not 3, because
   `required` caps at the slots, not the roster.

Plus an integration assertion that `scorePlayer`'s returned `score` actually
includes `BYE_PENALTY × avoidableByeShortfall` — the same count the badge prints —
since a pure function can be correct while being wired in wrong. And one on the
headline case end to end: with one RB rostered on bye 9 and the second RB slot
open, the RB who stacks bye 9 must be charged, badged, and sorted BELOW an RB a
rank worse who spreads it. That case had no test, which is how it stayed silent.

A calibration script printing one mid-draft board at bye penalties 3, 6, and 12
— the same approach used to settle `STARTER_BONUS` — so the weight is confirmed
against observed ordering rather than assumed. It calls the real scorer with an
injected weight, never a reimplementation of the math.
