# Glance View — Design

Date: 2026-08-17
Status: Approved, ready for implementation planning

## Problem

The dashboard duplicates most of what Sleeper's own draft room already shows:
the available-player board with search and position filters, the draft log,
on-the-clock and pick countdown, the roster view. On Sleeper draft day a user
ends up with two screens showing largely the same information.

Only two things here are genuinely unavailable elsewhere:

1. Ranking from the user's own CSV rather than the platform's rankings.
2. Re-sorting by the user's open starting slots weighted against talent — the
   `STARTER_BONUS` scoring — including holding K/DST back until the math says
   otherwise.

Those live buried in a screen full of duplicated furniture. The value is a
sentence long, and it is presented as a spreadsheet.

## Why not export instead

The original plan was to precompute a need-weighted order and export it for
upload into the platform, so the user drafts on Sleeper's own board. That was
researched and abandoned. Findings:

- **Sleeper has no rankings import.** Per Sleeper's own support documentation:
  "Unfortunately, there is no direct method or feature to allow you to upload or
  create pre-draft rankings."
- **No major platform accepts a file.** ESPN, Yahoo, and NFL.com all have custom
  pre-rank features; every one is manual drag-to-reorder in a web UI with no
  ingest path.
- **Pre-ranking mostly drives autopick, not the live board.** Per ESPN's
  documentation, rankings "are only used when a team manager doesn't pick a
  player within the allotted time and has no players on the pending pick queue."
  So even where pre-ranking exists it does not reorder the board the user is
  looking at, which was the entire premise.

Caveat on confidence: Sleeper's negative rests on a 2021 support article plus
absence of contrary evidence, not a dated 2026 statement. Sleeper publishes no
changelog and the live 2026 draft room was not inspected.

A second screen reading Sleeper's read-only API is therefore the only approach
that requires no cooperation from any platform — and it is what already exists.
The work is to shrink it to what only it can do.

## Goals

- Make the unique value readable in about two seconds.
- Keep the tool working for in-person, ESPN, and Yahoo drafts, where nothing
  syncs and picks must be marked by hand.
- Never present stale advice as current.

## Non-goals

- No new scoring. `js/recommend.js` is unchanged; this is a new presentation of
  the existing engine.
- No auto-drafting.
- No recent-picks feed and no draft button on the Glance card. Both were
  considered and cut: the feed costs the most vertical space of the candidates,
  and the draft button is redundant under Sleeper sync and duplicates the Board
  otherwise.

## Architecture

Two views, toggled from the top bar:

- **Glance** — new, and the default.
- **Board** — today's UI, unchanged: player table, search, position filters,
  sort toggle, Draft buttons, roster panel, draft log.

The Board is retained rather than deleted because it is what makes the tool
league-agnostic. Under Sleeper sync, picks arrive on their own and a user need
never leave Glance. In a manual league someone must mark every pick as it
happens, which requires the table and its Draft buttons.

### The top bar persists across both views

`TopBar` is chrome, not part of either view: it always carries the brand, the
theme toggle, the Setup button, and the new view toggle. Without it, Glance
would have no route to Setup — where rankings are imported and the user's team
is chosen — and no way back to the Board.

One consequence to resolve rather than leave duplicated: the top bar's clock
widget already renders pick number, round, who is on the clock, and picks until
your turn. The Glance card shows the countdown too, because the card must stand
alone as the thing you look at. **The clock widget therefore renders only in
Board view**, and the sync status dot moves onto the Glance card in Glance view
so the top bar does not carry two freshness signals.

```
js/ui/GlanceView.js    new — the Glance card
js/ui/glance.js        new — pure helpers (staleness, TAKE selection)
js/ui/App.js           modified — view toggle + routing
js/ui/TopBar.js        modified — the toggle control
js/state.js            modified — settings.view
```

Unchanged and still covering this work through the existing suite:
`js/recommend.js`, `js/draft.js`, `js/positions.js`, `js/limits.js`,
`js/csv.js`, `js/sleeper.js`, `js/ui/useSleeperSync.js`, `css/styles.css`
(new classes are added; existing rules are not edited).

### `settings.view`

`'glance' | 'board'`, default `'glance'`. Placed in settings so it persists
across a mid-draft refresh, exactly as `sortMode` does, and rides the existing
`load()` settings merge. An unrecognized value falls back to `'glance'`.

Note this makes Glance the default for existing users, including anyone already
testing the deployed build. That is intended — it is the point of the change —
but it is a visible break from what is currently live.

## The Glance card

```
TAKE
  Trey McBride       TE   #45
  fills your empty TE

THEN
  Kenneth Walker     RB   #38   bench
  Jaylen Waddle      WR   #47   FILLS FLEX

STILL NEED   TE · WR · FLEX · K · DST
2 picks until your turn
● synced 4s ago
```

Every element derives from existing tested code:

| Element | Source |
| --- | --- |
| TAKE, THEN | `recommendOrder` from `js/recommend.js` |
| The reason lines | `scorePlayer`'s `reason`, same strings the Board badges use |
| STILL NEED | `computeNeeds` from `js/draft.js` |
| Picks until your turn | `nextPickForSlot` from `js/draft.js` |
| Sync freshness | `status.at` from `useSleeperSync` |

THEN shows two entries. TAKE is the first non-excluded entry of
`recommendOrder`, not simply `[0]` — position-limit exclusions sort last but a
board could in principle be entirely excluded.

## Sync freshness

The failure this exists to prevent: polling dies, the card keeps rendering
confident advice computed from a board that stopped updating, and the user
drafts against it. This project has already shipped three separate silent
sync failures, so the indicator is not optional decoration.

`js/sleeper.js` already stamps every poll result with `at: Date.now()` on both
success and failure, so no change is needed there.

| State | Rendering |
| --- | --- |
| Fresh | `● synced 4s ago` |
| Stale (>20s since last completed poll) | `⚠ NOT SYNCING — last update 3m ago · advice below may be stale` |
| `sleeperSyncEnabled` false | Nothing — no indicator at all |

The disabled case renders nothing rather than a green dot, because in a manual
league there is no sync to be healthy.

20 seconds is roughly three missed six-second polls. It is deliberately based on
the last *completed* poll: a hung request never fires its callback, so `at` stops
advancing, which is precisely the condition to surface. A one-second interval
re-renders the elapsed text; it is cleared on unmount.

## Degraded states

Each renders an explicit message rather than an empty card or a confident wrong
one:

| Situation | Glance shows |
| --- | --- |
| No team selected | "Pick your team in Setup to get recommendations" |
| No rankings imported | "Import rankings to get recommendations" |
| Every remaining player at a position limit | The limit explanation, not a blank TAKE |
| Roster full (`picksRemaining` 0) | "Your roster is full" |
| Fewer than three players available | TAKE only, or TAKE plus one; no empty rows |
| Board view, any of the above | Unchanged from today — the Board already has its own handling and this work must not alter it |

## Testing

The card is a rendering layer over functions that are already covered, so new
automated coverage is deliberately narrow and lives in `js/ui/glance.js` as pure
functions:

1. `syncFreshness(status, syncEnabled, now)` → `'fresh' | 'stale' | 'off'`,
   including exactly at the 20-second boundary in both directions.
2. `pickTake(ranked)` → the first non-excluded entry; `null` when all are
   excluded or the list is empty.

Everything else is verified in a browser: each degraded state, the view toggle
persisting across a reload, and the stale indicator actually appearing when
polling is interrupted.

`tools/screenshot-diff.mjs` needs its baseline repointed to current `main`.
Glance is DOM the pre-rewrite commit does not contain, so comparing against it
would be meaningless; repointed, the harness catches future visual drift
instead of re-litigating the port.
