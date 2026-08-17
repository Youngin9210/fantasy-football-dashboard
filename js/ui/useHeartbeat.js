import { useState, useEffect } from '../vendor/preact.js';

// A once-a-second re-render heartbeat, nothing more: it exists so that a
// freshness verdict computed from the wall clock is re-evaluated while the user
// sits still. Without it, syncFreshness is only ever asked at mount and on the
// next store change, so a sync that dies never turns amber until something else
// happens to re-render.
//
// Its stored tick value is deliberately NOT exposed, so no caller can mistake it
// for a clock. Freshness must be judged against a Date.now() read DURING render:
// a sampled `now` is up to a second behind by construction, and syncFreshness
// treats a timestamp in the future as clock skew and reports 'stale', so every
// successful poll would flash the warning for a moment. `active` gates the
// interval so a page with sync off schedules no timer, and the interval is
// cleared on unmount so it cannot outlive the component.
//
// Lives in its own module because BOTH views need exactly this: GlanceView for
// the card's sync line and TopBar's SyncStatus for the Board's sync dot. It was
// previously a private function inside GlanceView.js, and TopBar had no
// heartbeat at all -- which is half of why the Board's dot could sit on a stale
// verdict indefinitely. Two copies of a hook whose whole subtlety is "do not
// read the clock from state" is exactly the shape that drifts.
export function useHeartbeat(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [active]);
}
