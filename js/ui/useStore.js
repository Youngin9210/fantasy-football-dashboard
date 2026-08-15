import { useState, useEffect } from '../vendor/preact.js';
import * as St from '../state.js';

// state.js mutates its state object in place, so getState() returns the same
// reference every call and React can never detect a change by identity. The
// counter bump is what forces the re-render.
//
// Consequence: do NOT wrap store-derived values in useMemo keyed on state or
// its fields — the deps would never change and the memo would serve stale data
// forever. Recompute each render; at a few hundred players it is free.
export function useStore() {
  const [, bump] = useState(0);
  useEffect(() => St.onChange(() => bump((n) => n + 1)), []);
  return St.getState();
}
