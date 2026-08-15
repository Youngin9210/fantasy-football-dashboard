# Fantasy Football Draft Day Dashboard

A single-page, no-build-step dashboard for tracking a live fantasy draft: best
player available, your roster and needs, snake draft order, and (optionally)
automatic pick syncing from a live Sleeper draft. Everything runs client-side
— your draft state lives in your browser's `localStorage`, nothing is sent to
any server except live polling of the public Sleeper API if you connect it.

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
6. Close Setup and draft. Click **Draft** next to a player to mark them
   taken for whoever is on the clock (the "Draft pick for" dropdown
   auto-advances through the snake order); click **✕** on a drafted row to
   undo a specific pick, or **Undo Last Pick** to undo the most recent one.

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
   stays accurate — check the best-available list afterward if a name looks
   off.

You can still use the manual **Draft** button at any time (e.g. for
corrections, or if you'd rather not connect Sleeper at all).

**Correcting a bad name match while sync is running.** Click the ✕ on the
wrongly-matched row, then **Draft** the player who really went there. The ✕
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

- **Best Available** — full rankings table, filterable by position
  (including a combined FLEX filter) and searchable by name/team, with tier
  dividers when your CSV includes a tier column.
- **Best for my roster** — a sort mode that reorders the board by fit with the
  team you're building: unfilled starters first, then bench depth, then K/DST.
  A WHY badge on each row shows the reasoning. Players at one of your league's
  position limits sort to the bottom, greyed out, rather than disappearing.
  Scoring is `rank − bonus`, so an empty starting slot breaks close calls but
  never overrides a genuinely better player.
- **K and DST held back** — they stay at the bottom of the recommended order
  until you have only enough picks left to fill them, so you never spend an
  early pick on a kicker or finish the draft without a defense.
- **My Team** — your roster slots filled in as you draft, with starting
  lineup needs called out (bench slots accept anyone).
- **On the clock** — shows whose pick it is and how many picks until your
  next turn, computed from a standard snake order.
- **Draft Log** — running list of every pick, newest first.
- **Light/dark theme** toggle (🌓, top right).

## What it deliberately doesn't do

- No baked-in player rankings/ADP or live stat projections — you supply
  current rankings via CSV so you're never drafting off stale data.
- No custom points-per-player value engine for your league's exact scoring
  (e.g. 6pt passing TDs) — half-PPR consensus rankings from FantasyPros or
  similar are close enough for draft-day purposes; treat QB value as
  slightly underrated by generic rankings since your league pays out 6 for
  passing TDs instead of the more common 4.
- No bye-week conflict detection, tier-cliff bonuses, or modeling of other
  teams' needs. The recommendation reflects your roster and your league's
  position limits, nothing more.

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
node tools/screenshot-diff.mjs
```

It screenshots this build and a `git worktree` of an earlier commit at a fixed
viewport in both themes and diffs them pixel by pixel, reporting which element
boxes moved. A DOM-structure harness (`tools/dom-diff.mjs`) existed alongside it
during the Preact rewrite and was retired once that port was verified — it
compared against a baseline that no longer exists on `main`.
