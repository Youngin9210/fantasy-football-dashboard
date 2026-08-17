import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRankingsCsv } from '../js/csv.js';

const H = 'RK,TIERS,PLAYER NAME,TEAM,POS,ECR VS. ADP';
const row = (v) => `${H}\n1,1,Some Player,CIN,WR1,${v}`;
const first = (csv) => parseRankingsCsv(csv).players[0];

test('a positive gap parses, plus sign and all', () => {
  assert.equal(first(row('+152')).ecrVsAdp, 152);
});

test('a negative gap parses', () => {
  assert.equal(first(row('-16')).ecrVsAdp, -16);
});

test('zero is a real value, not missing', () => {
  // "drafted exactly on rank". The neighbouring adp line's `|| null` would
  // destroy this, and Number("") === 0 means coercion alone cannot tell a zero
  // from an empty cell.
  assert.equal(first(row('0')).ecrVsAdp, 0);
});

test('a bare dash is missing, not zero', () => {
  // 612 of the owner's 946 rows are exactly this.
  assert.equal(first(row('-')).ecrVsAdp, null);
});

test('an empty cell is missing, not zero', () => {
  assert.equal(first(row('')).ecrVsAdp, null);
});

test('junk is missing, not zero', () => {
  assert.equal(first(row('n/a')).ecrVsAdp, null);
  assert.equal(first(row('1.5')).ecrVsAdp, null, 'the column is integers; a decimal is unexpected');
});

test('a whitespace-padded value still parses', () => {
  // Guards the .trim(). Without this, removing trim leaves the whole suite green
  // -- the shape regex rejects " 5 ", so a padded cell would silently become
  // null. Real exports do ship padded cells; this file's own headers have
  // trailing spaces ("UPSIDE ").
  assert.equal(first(row(' 5 ')).ecrVsAdp, 5);
  assert.equal(first(row('\t-12\t')).ecrVsAdp, -12);
});

test('a CSV with no such column yields null, with no warning', () => {
  const { players, warnings } = parseRankingsCsv('RK,PLAYER NAME,POS\n1,Some Player,WR1');
  assert.equal(players[0].ecrVsAdp, null);
  assert.equal(warnings.length, 0, 'an absent market column is not worth warning about');
});

test('the header alias tolerates spacing and case', () => {
  for (const h of ['ECR VS. ADP', 'ecr vs. adp', '  ECR   VS. ADP  ', 'ECR VS ADP']) {
    const csv = `RK,PLAYER NAME,POS,${h}\n1,Some Player,WR1,-16`;
    assert.equal(parseRankingsCsv(csv).players[0].ecrVsAdp, -16, `failed on ${JSON.stringify(h)}`);
  }
});

test("the owner's real export parses as measured", async () => {
  const text = await readFile('/Users/kyleyoung/Downloads/FantasyPros_2026_Draft_ALL_Rankings (1).csv', 'utf8');
  const { players } = parseRankingsCsv(text);
  assert.equal(players.length, 946);
  const withValue = players.filter((p) => Number.isFinite(p.ecrVsAdp));
  assert.equal(withValue.length, 334, '334 rows carry a number; the other 612 are "-"');
  // Fully populated exactly where drafting happens.
  const top150 = players.filter((p) => p.rank <= 150);
  assert.equal(top150.filter((p) => Number.isFinite(p.ecrVsAdp)).length, 150);
  // Spot-check both extremes and a bye, so a column-order regression is caught.
  const noel = players.find((p) => p.name === 'Jaylin Noel');
  assert.equal(noel.ecrVsAdp, 152);
  const jacobs = players.find((p) => p.name === 'Josh Jacobs');
  assert.equal(jacobs.ecrVsAdp, -10);
  // The brief's snapshot measured bye 8; the owner's current download has since been
  // refreshed (Jacobs now shows team GB, bye 11). That's upstream data drift, not a
  // parser defect -- confirmed by reading the raw row directly: the "BYE WEEK" column
  // holds "11". The assertion's real job -- proving the new ecrVsAdp column didn't
  // shift the column map -- still holds: bye parses to a plausible integer, not null
  // or garbage.
  assert.equal(jacobs.bye, 11, 'bye still parses -- the new column must not shift the map');
});
