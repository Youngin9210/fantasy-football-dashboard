// The market-value signal: how far a player's expert consensus rank sits from
// where he is actually drafted. Pure -- no DOM, no store.
//
// Sign convention, stated once here so no call site has to remember it:
//   NEGATIVE -> drafted EARLIER than ranked -> he will be gone, take him now
//   POSITIVE -> drafted LATER  than ranked -> he lasts, you can wait
//
// That is backwards from intuition (a minus sign reads as "worse player"), so
// the rendered strings always name the direction in words and never show a raw
// sign. One column, one convention.

// Flags roughly one player per round across the owner's first six rounds. At 5
// it becomes wallpaper (23 in the top 60); at 12 it nearly vanishes (1).
export const MARKET_FLAG_AT = 8;

export function marketNote(gap) {
  if (!Number.isFinite(gap)) return null;
  const n = Math.abs(gap);
  const flagged = n >= MARKET_FLAG_AT;

  if (gap === 0) {
    return { short: 'on rank', long: 'drafted right about at his rank', flagged: false };
  }
  if (gap < 0) {
    return {
      short: `${n} early`,
      long: `usually gone ~${n} picks before this`,
      flagged,
    };
  }
  return {
    short: `${n} late`,
    long: `usually still there ~${n} picks later`,
    flagged,
  };
}
