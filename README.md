# Fantasy Football Draft Day Dashboard

A single-page, no-build-step dashboard for tracking a live fantasy draft: one
card telling you who to take next and why, plus the full board — best player
available, your roster and needs, snake draft order — and (optionally) automatic
pick syncing from a live Sleeper draft. Everything runs client-side — your draft
state lives in your browser's `localStorage`, nothing is sent to any server
except live polling of the public Sleeper API if you connect it.

## What this is for

Your league's site already has a draft board, a queue, a draft log, and a
roster view. This does two things they don't: it ranks from *your* CSV, and it
re-sorts by *your* open starting slots weighted against talent — including
holding K and DEF back until you can no longer afford to wait.

Glance exists so that fits on a phone beside whatever you're actually drafting
in. Sleeper's API is read-only, and the big platforms' draft boards rank off
their own consensus rather than a rankings file you hand them, so a second
screen is the only way to get this without the platform's cooperation.

## Quick start

1. Open the site (see **Hosting on GitHub Pages** below), or just open
   `index.html` directly in a browser / run a local static server.
2. Click **⚙ Setup**.
3. Under **League Settings**, set your number of teams and roster spots
   (defaults match a standard 10-team, half-PPR league: `QB,RB,RB,WR,WR,TE,
   FLEX,K,DST` + 7 bench, 16 spots total).
4. Set up your teams — either:
   - **Manual**: type team names in draft-slot order under "Teams & My Slot",
     click **Save Teams**, then pick which one is yours, or
   - **Sleeper sync**: paste your league ID and click **Connect & Sync
     Teams** (see below).
5. Import your rankings under **Import Rankings (CSV)** — paste or upload a
   CSV (a FantasyPros "Player Rankings" export works out of the box; any CSV
   with `Rank`/`Player Name`/`Team`/`Pos`/`Bye Week` columns works too).
6. Close Setup. You land on **Glance**: the single card with the pick to make
   and the reasoning behind it. Switch to **Board** (top right) any time you
   need the full table.
7. Mark picks. If Sleeper sync is on, that happens by itself. Otherwise switch
   to **Board** and click **Draft** next to a player to mark them taken for
   whoever is on the clock (the "Draft pick for" dropdown auto-advances through
   the snake order); click **✕** on a drafted row to undo a specific pick, or
   **Undo Last Pick** to undo the most recent one.

Rankings intentionally aren't preloaded — fantasy rankings shift constantly,
so pull a fresh CSV right before your draft rather than trusting anything
baked into the app ahead of time.

## Sleeper live sync

Sleeper (https://docs.sleeper.com) exposes a free, public, read-only API with
no login required, so the dashboard can poll your actual draft and
auto-mark picks as they happen — no manual clicking needed once it's
running.

1. Find your league ID: open your league on sleeper.com or in the app; the
   URL looks like `sleeper.com/leagues/<LEAGUE_ID>/...` — copy that number.
2. Paste it into **Sleeper League ID** and click **Connect & Sync Teams**.
   This pulls your league's teams into the dashboard in the correct draft
   order automatically (no need to type team names by hand).
   Connecting also pulls your league's roster shape and position limits
   (e.g. QB 3, RB 6, WR 6, TE 3, K 2, DST 3) into Setup, so the
   recommendations match your actual league rules. Both fields stay editable.
3. Pick which synced team is yours from the **Which team is mine?** dropdown.
4. Once your league's draft is live, the dashboard polls picks every ~6
   seconds and marks players off automatically, matching by name (and by
   team for defenses). Any pick it can't confidently match to your imported
   rankings is added as an "unranked" entry so your roster/team tracking
   stays accurate — check the Board's best-available list afterward if a name
   looks off.

You can still use the Board's manual **Draft** button at any time (e.g. for
corrections, or if you'd rather not connect Sleeper at all).

**Correcting a bad name match while sync is running.** On the **Board**, click
the ✕ on the wrongly-matched row, then **Draft** the player who really went
there. The ✕
tells the poller to leave that *player* alone for the rest of the session, so
the next poll six seconds later won't put him straight back — and because it
is keyed to the player rather than to the pick number, it never suppresses
somebody else's pick. Both **Reset Draft** and **Reset Everything** clear
those corrections, as does reloading the page (the manual pick you made
survives the reload; the ✕ does not, so a mis-matched player can reappear
after a refresh — ✕ him again if so).

If your network blocks requests to `api.sleeper.app` (rare, but some
locked-down corporate/school networks do), sync will fail gracefully and
you can just use the dashboard manually.

## Hosting on GitHub Pages

This repo has no build step — GitHub Pages can serve it directly:

1. On GitHub, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Pick the branch you want live (e.g. `main`) and folder `/ (root)`, then
   **Save**.
4. GitHub will publish it at `https://<your-username>.github.io/fantasy-football-dashboard/`
   within a minute or two.

Bookmark that URL for draft day. Since state is saved to `localStorage`,
using the same browser (and not clearing site data) keeps your draft
progress if you close the tab mid-draft.

## What it does

- **Glance** — the default view. One card: the player to take and why, two
  backups, which starting slots are still open, how many picks until your turn,
  and whether live sync is actually current. A recommended pick that clashes on
  byes carries the same `BYE n ×k` line as the Board badge, and if your CSV has
  no bye column at all the card says so outright ("No bye weeks in your
  rankings — bye conflicts are not being weighted") rather than letting a clean
  card imply byes were considered. Built for a phone next to your laptop while
  you draft on your league's own site.
- **Board** — one tap away, and what you want for an in-person or non-Sleeper
  draft: the full table with search, filters, and Draft buttons for marking
  every pick by hand.
- **Best Available** — full rankings table, filterable by position
  (including a combined FLEX filter) and searchable by name/team, with tier
  dividers when your CSV includes a tier column.
- **Best for my roster** — a sort mode that reorders the board by fit with the
  team you're building: unfilled starters first, then bench depth, then K/DST.
  A WHY badge on each row shows the reasoning, plus a second amber `BYE n ×k`
  badge when the pick would leave you short at that position in week *n*.
  Players at one of your league's position limits sort to the bottom, greyed
  out, rather than disappearing. Scoring is `rank − bonus + 6 × avoidable bye
  weeks`, so an empty starting slot breaks close calls but never overrides a
  genuinely better player, and a bye clash costs about six ranking places.
- **Bye-week weighting** — the recommendation counts the worst single week each
  pick would leave you unable to field that position, so you never end up with
  a whole position group off in the same week (both starting RBs on bye 9, say).
  Only a clash a *different* available player would have avoided is charged and
  badged: the first tight end you draft is short in his own bye week whatever
  you do, so he is not penalized for it, but a second RB doubling up on your
  first RB's bye is. Needs a bye column in your CSV (FantasyPros' `Bye Week`
  works); without one the weighting contributes nothing and Glance says so.
- **K and DST held back** — they stay at the bottom of the recommended order
  until you have only enough picks left to fill them, so you never spend an
  early pick on a kicker or finish the draft without a defense.
- **My Team** — your roster slots filled in as you draft, with starting
  lineup needs called out (bench slots accept anyone). Lives in the Board's
  sidebar; Glance boils it down to the STILL NEED line.
- **On the clock** — the Board's top bar shows whose pick it is and how many
  picks until your next turn, computed from a standard snake order; Glance shows
  the same countdown on its card.
- **Draft Log** — running list of every pick, newest first (Board).
- **Light/dark theme** toggle (🌓, top right).

## What it deliberately doesn't do

- No baked-in player rankings/ADP or live stat projections — you supply
  current rankings via CSV so you're never drafting off stale data.
- No custom points-per-player value engine for your league's exact scoring
  (e.g. 6pt passing TDs) — half-PPR consensus rankings from FantasyPros or
  similar are close enough for draft-day purposes; treat QB value as
  slightly underrated by generic rankings since your league pays out 6 for
  passing TDs instead of the more common 4.
- No tier-cliff bonuses and no modeling of other teams' needs. The
  recommendation reflects your roster, your league's position limits, and bye
  overlap at each position — nothing more.
- No bye-week planning beyond that overlap: it weighs whether you can field a
  position in a given week, not full week-by-week lineup projections, and it
  never looks across positions (a QB and a TE sharing a bye is not a conflict
  it counts).

## Local development

No build step — just serve the folder statically, e.g.:

```
python3 -m http.server 8080
```

then open `http://localhost:8080`.

Tests use the Node 22 built-in runner — no dependencies, no install step:

```
node --test
```

Anything that needs a real browser lives in `tools/`, not `test/`, so `node
--test` stays fast and offline:

```
node tools/stale-check.mjs
```

drives headless Chrome against a Sleeper API stub whose second poll never
returns, then waits out the real 20-second staleness threshold to prove the
Glance card actually replaces "synced" with the NOT SYNCING warning. It takes
about half a minute by design.

`package.json` exists only to mark the source as ES modules for Node. The site
itself still has no build step and no runtime dependencies.

`node tools/calibrate.js` prints the same board scored at three different
need-weights, for tuning `STARTER_BONUS`.

The UI is built with Preact + htm, vendored at `js/vendor/preact.js` (13KB,
self-contained). There is still no build step and no runtime dependency on any
external host — the file is committed, not fetched from a CDN. Markup uses htm
tagged templates rather than JSX, since JSX would require a compiler.

To check a UI change for unintended visual drift:

```
node tools/screenshot-diff.mjs                 # working tree vs HEAD
node tools/screenshot-diff.mjs --ref main      # or any commit-ish
SCREENSHOT_DIFF_REF=main node tools/screenshot-diff.mjs
```

It screenshots this working tree and a `git worktree` of the baseline ref at a
fixed viewport in both themes, then diffs them pixel by pixel — reporting how
many pixels differ, where the largest differing regions are, and, separately,
which element boxes actually moved. Run it before committing a UI change: the
default baseline is `HEAD`, so it shows exactly what your edits moved. If the
baseline serves the same `js/`, `css/` and `index.html` as the working tree —
whether because it *is* this commit or because the commits in between touched
only files a browser never loads — the run says so instead of letting a screen
of `0.0000%` look like proof.

Each scenario declares which view it renders, and both sides must prove they
rendered it before their pixels are compared. Every run also ends with a
sensitivity self-test: two deliberate CSS overrides are injected, and the
harness must catch one as a paint-only change and the other as a layout change.
A comparison tool that has not just demonstrated it can see something is not
evidence of anything.

A DOM-structure harness (`tools/dom-diff.mjs`) existed alongside it during the
Preact rewrite and was retired once that port merged: its baseline was `main`,
which by then *was* the rewrite, so it had been diffing the new build against
itself and reporting a vacuous pass.
