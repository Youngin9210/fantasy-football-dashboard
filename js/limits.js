// Position-limits input parsing, shared by the setup-panel UI (js/app.js) and
// the Node test suite. Kept dependency-free of the DOM so it can be imported
// directly by `node --test`.
import { normalizePos } from './positions.js';

// "QB:3,RB:6" -> {QB: 3, RB: 6}. Tolerates spaces and trailing commas.
function parseLimitsInput(text) {
  const limits = {};
  for (const part of String(text || '').split(',')) {
    const [rawPos, max] = part.split(':');
    const pos = normalizePos(rawPos);
    const n = parseInt((max || '').trim(), 10);
    if (pos && Number.isFinite(n) && n > 0) limits[pos] = n;
  }
  return limits;
}

function formatLimits(limits) {
  return Object.entries(limits || {}).map(([pos, max]) => `${pos}:${max}`).join(',');
}

export { parseLimitsInput, formatLimits };
