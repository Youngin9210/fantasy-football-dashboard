# React (Preact + htm) UI Rewrite — Design

Date: 2026-08-14
Status: Approved, ready for implementation planning

## Problem

`js/app.js` is 472 lines that build the entire interface by concatenating HTML
strings and assigning them to `innerHTML`, then re-attaching event listeners to
the freshly destroyed DOM on every render. That approach has produced real
defects during this project's short history:

- An unescaped interpolation (`${p.pos}`) survived review because escaping is
  manual and per-site rather than structural.
- Every state change re-renders the whole table and rebinds every listener,
  so input focus and scroll position are lost mid-draft.
- Rendering logic and application logic are interleaved in one file, which is
  why the roster-aware recommender needed a separate pure module to be testable
  at all.

The scoring logic is already extracted, pure, and covered by 50 tests. Only the
render layer is left, and it is the part that resists testing.

## Goals

- Replace the string-concatenation render layer with components.
- Keep every non-UI module untouched, so the existing test suite continues to
  cover all scoring behavior without modification.
- Preserve the project's defining property: no build step, no runtime
  dependencies, no CI, deploy remains `git push`.
- Introduce no runtime dependency on any external host.

## Non-goals

- No visual redesign. Markup and CSS stay as they are.
- No change to scoring, roster, Sleeper, CSV, or persistence behavior.
- No state-management library. `state.js` remains the single source of truth.
- No JSX, no bundler, no `node_modules`.

## Library choice

**Preact 10 + hooks + htm, vendored as a single 13KB file** at
`js/vendor/preact.js`, sourced from
`https://esm.sh/htm@3.1.1/es2022/preact/standalone.mjs`.

It is self-contained — no further imports — and exports everything needed:
`html`, `render`, `useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`,
`useContext`, `useReducer`, `useLayoutEffect`, `useErrorBoundary`, `Component`,
`createContext`, `h`.

It exports no `useSyncExternalStore`; `state.js`'s existing `onChange` pub/sub
replaces it (see State, below).

This is Preact, not React. The hooks API is the same, the markup is written with
htm tagged templates rather than JSX, and for an app this size the difference is
immaterial. React proper would be ~140KB across three vendored files and still
require htm, since JSX cannot be used without a build step.

### Why vendored rather than loaded from a CDN

The original request was to load from a CDN. Vendoring was chosen instead
because a runtime CDN import makes esm.sh a hard dependency of the draft board
at page load. If esm.sh is unreachable, slow, or blocked by the network — the
README already warns that some locked-down networks block `api.sleeper.app` —
the page renders nothing. A vendored file is pinned forever, works on any
network, and costs 13KB in the repository.

Vendoring preserves every property that motivated the CDN request: no build
step, no npm, no `node_modules`, and an unchanged deploy mechanism.

## Architecture

```
index.html              shell: <div id="root"> + one module script
js/vendor/preact.js     vendored, pinned, never edited
js/main.js              mounts <App/>
js/ui/useStore.js       bridges state.js -> re-render
js/ui/useTheme.js       light/dark toggle, localStorage-backed
js/ui/useSleeperSync.js polling side-effect, lifted out of app.js
js/ui/App.js            composition + ephemeral UI state + error boundary
js/ui/TopBar.js         brand, clock widget, sync status, theme, setup button
js/ui/SetupPanel.js     the five setup cards
js/ui/PlayersTable.js   controls + board
js/ui/RosterPanel.js    my team + needs
js/ui/DraftLog.js       pick log
```

`js/app.js` is **deleted**. The fallback is the `main` branch, which stays on
the vanilla implementation until this work is merged.

Untouched, and therefore still covered by the existing suite: `js/state.js`,
`js/recommend.js`, `js/positions.js`, `js/limits.js`, `js/draft.js`,
`js/csv.js`, `js/sleeper.js`, `css/styles.css`.

## State

`state.js` remains the single source of truth for settings, teams, players, and
picks, and continues to own localStorage persistence. All mutations go through
its existing exported functions.

The bridge:

```js
export function useStore() {
  const [, bump] = useState(0);
  useEffect(() => St.onChange(() => bump((n) => n + 1)), []);
  return St.getState();
}
```

`onChange` returns its own unsubscribe function, so it is a valid `useEffect`
cleanup as written.

### Constraint: state is mutated in place

`getState()` returns the same object reference on every call — `state.js`
mutates rather than replacing. Two consequences that must be respected:

1. React cannot detect changes by identity. The counter bump is what forces the
   re-render; nothing may depend on a new reference appearing.
2. `useMemo` keyed on `state.players` or `state.settings` would never
   invalidate and would serve stale data forever. Derived values are recomputed
   each render instead. At a few hundred players this is free.

This is a deliberate trade, documented here because a later "optimization" that
adds `useMemo` over store data would introduce a silent, hard-to-diagnose bug.

### Ephemeral vs persisted UI state

Search text, the position filter, and setup-panel visibility move to `useState`.
This matches current behavior exactly — they are module-level `let`s today and
are not persisted. `sortMode` stays in `settings` because it *is* persisted.

## Behavior changes

Four, each individually approved by the owner:

1. In need mode only, drafted rows render **above** the "At position limit"
   divider rather than below it, so they no longer imply they are at a limit.
   Rank mode is unaffected — it has no divider and no excluded grouping.
2. Escaping becomes structural — htm escapes interpolated values, which retires
   the manual `escapeHtml` helper and the one unescaped `${p.pos}` site.
3. The `recommendOrder` tie-break test is rewritten to use two players with
   *different* ranks at an equal score, so it actually exercises the tie-break
   direction rather than passing trivially.
4. The Setup panel auto-opens only on an empty install. The vanilla build opens
   it on every load — `index.html` never carried the `hidden` class that
   `app.js:465` tried to remove, so that call was always a no-op. Approved by
   the owner after the discrepancy surfaced in Task 1's review.

5. The sync status dot now reflects reality. `main`'s `render()` ended with an
   unconditional `renderSyncStatus({ ok: true })`, so any store change repainted
   the dot green even while polling was failing. `TopBar` now shows the real
   status until the next successful poll. Found during the final whole-branch
   review; strictly an improvement, recorded here because it is a fifth
   difference from vanilla rather than one of the four planned.

Everything else is markup-for-markup identical.

## Error handling

A component that throws under Preact renders nothing — a blank page mid-draft
is the worst available failure mode for this app. A `Root` component in
`js/main.js` therefore installs `useErrorBoundary` **above** `<App/>`, rendering
`js/ui/ErrorFallback.js` with the error message and a reload affordance instead
of an empty document.

The boundary must sit above `App`, not inside it: Preact's `_catchError` walks
up from the throwing vnode's parent, so a boundary installed within a component
cannot catch that component's own render throw. Task 1's review demonstrated
this empirically — with the boundary inside `App`, an `App` render throw
produced a completely blank page. `useTheme` is called in `Root` for the same
reason, so the fallback renders in the user's chosen theme.

Note that no boundary in Preact or React catches errors thrown from event
handlers; those log to the console rather than blanking the page.

Existing degraded-input handling is unchanged: no team selected still shows the
need-mode notice, empty rankings still render an empty table, and a corrupt
localStorage value still falls back to defaults inside `state.js`.

## Testing

The rewrite's safety rests on three layers.

1. **The existing 50 Node tests pass unmodified.** None of them import
   `js/app.js`; they cover every scoring, roster, position, limits, Sleeper, and
   persistence path. Any failure means a non-UI module was touched, which this
   work must not do.

2. **DOM-diff harness** — the primary verification. A script loads the vanilla
   build and the Preact build with *identical seeded localStorage*, dumps both
   rendered DOMs, and diffs them. The diff must be empty except for the three
   behavior changes above.

   The vanilla build is obtained by checking `main` out into a git worktree at a
   temporary path (`git worktree add`) and serving it on a second port, so both
   versions run simultaneously from real files rather than from reconstructed
   snapshots. The worktree is removed afterward. The harness lives in `tools/`,
   not `test/`, because Node's test runner collects every `.js` file under a
   directory named `test` regardless of suffix.

   States to cover, matching those the final review of the previous branch
   exercised:
   - fresh install, no data
   - a pre-branch saved state (15-slot roster, raw `DEF` player, missing keys)
   - rankings imported, no team selected, need mode on
   - rankings imported, team selected, need mode on
   - a roster at a position limit, so the divider renders
   - an over-full roster
   - empty rankings

3. **Live Sleeper connect** against league `1389708373728964608`, confirming
   roster positions and position limits still populate Setup.

Component-level unit tests are deliberately out of scope: without a DOM
implementation they would require adding a dependency, which violates a hard
constraint. The DOM diff is a stronger check for a port than component tests
would be, because it compares against a known-good implementation rather than
against assertions written by the same author.

## Rollout

Built on `feature/react-ui`. `main` stays vanilla and live throughout, so the
draft board is never at risk. The branch is merged when the owner chooses,
after his draft.
