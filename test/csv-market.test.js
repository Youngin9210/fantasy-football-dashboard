import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseRankingsCsv } from '../js/csv.js';

const H = 'RK,TIERS,PLAYER NAME,TEAM,POS,ECR VS. ADP';
const row = (v) => `${H}\n1,1,Some Player,CIN,WR1,${v}`;
const first = (csv) => parseRankingsCsv(csv).players[0];

// A 51-row slice of the owner's actual FantasyPros export (RK1-50 plus RK224),
// committed verbatim -- header quirks and all -- so this suite never again
// depends on a file outside the repo. See test/fixtures/rankings-sample.csv
// for provenance.
const FIXTURE = fileURLToPath(new URL('./fixtures/rankings-sample.csv', import.meta.url));

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

test('a CSV with no such column yields null AND now warns -- the owner overrode the spec here', () => {
  // The spec's original call (see the old comment this replaces) was that a
  // blank Value column is self-evident and not worth a warning. The owner
  // overrode that decision post-review: on the live site a blank ADP column is
  // the NORMAL state, so a blank Value column is genuinely ambiguous between
  // "this file has no market data" and "the parse broke" -- only a warning
  // tells the two apart. This assertion now pins the warning, not its absence.
  const { players, warnings } = parseRankingsCsv('RK,PLAYER NAME,POS\n1,Some Player,WR1');
  assert.equal(players[0].ecrVsAdp, null);
  assert.equal(warnings.length, 1, 'an absent market column now warns, by owner override');
  assert.match(warnings[0], /market column/i);
});

test('a market column that is present but entirely dashes still warns nothing', () => {
  // The new warning is for an ABSENT column only. 612 of the owner's 946 rows
  // are "-"; a file that is fully populated with dashes is legitimate, not
  // broken, and must stay silent.
  const csv = 'RK,PLAYER NAME,POS,ECR VS. ADP\n1,Some Player,WR1,-\n2,Other Player,RB1,-';
  const { warnings } = parseRankingsCsv(csv);
  assert.equal(warnings.length, 0);
});

test('the header alias tolerates spacing and case', () => {
  for (const h of ['ECR VS. ADP', 'ecr vs. adp', '  ECR   VS. ADP  ', 'ECR VS ADP']) {
    const csv = `RK,PLAYER NAME,POS,${h}\n1,Some Player,WR1,-16`;
    assert.equal(parseRankingsCsv(csv).players[0].ecrVsAdp, -16, `failed on ${JSON.stringify(h)}`);
  }
});

test('adp still parses when a genuine ADP column is present', () => {
  // Not exercised anywhere else in this suite. Also guards against the new
  // column shifting the map: ecrVsAdp must still land correctly alongside it.
  const csv = 'RK,PLAYER NAME,POS,ADP,ECR VS. ADP\n1,Some Player,WR1,23.4,-16';
  const p = parseRankingsCsv(csv).players[0];
  assert.equal(p.adp, 23.4);
  assert.equal(p.ecrVsAdp, -16, 'adding an ADP column must not shift the ecrVsAdp column');
});

test("a real export slice parses as measured (fixture, not the owner's Downloads folder)", async () => {
  const text = await readFile(FIXTURE, 'utf8');
  const { players } = parseRankingsCsv(text);
  assert.equal(players.length, 51);
  const withValue = players.filter((p) => Number.isFinite(p.ecrVsAdp));
  assert.equal(withValue.length, 50, '50 rows carry a number; Oscar Delp is the fixture\'s one "-"');
  // Fully populated exactly where drafting happens.
  const top50 = players.filter((p) => p.rank <= 50);
  assert.equal(top50.filter((p) => Number.isFinite(p.ecrVsAdp)).length, 50);
  // Spot-check both extremes and a bye, so a column-order regression is caught.
  const gibbs = players.find((p) => p.name === 'Jahmyr Gibbs');
  assert.equal(gibbs.ecrVsAdp, 0, 'RK1, drafted right on rank -- zero is real, not missing');
  const hall = players.find((p) => p.name === 'Breece Hall');
  assert.equal(hall.ecrVsAdp, -2);
  const mcconkey = players.find((p) => p.name === 'Ladd McConkey');
  assert.equal(mcconkey.ecrVsAdp, 3);
  const mclaurin = players.find((p) => p.name === 'Terry McLaurin');
  assert.equal(mclaurin.ecrVsAdp, 11);
  const jacobs = players.find((p) => p.name === 'Josh Jacobs');
  assert.equal(jacobs.ecrVsAdp, -10);
  assert.equal(jacobs.bye, 11, 'bye still parses -- the new column must not shift the map');
  const delp = players.find((p) => p.name === 'Oscar Delp');
  assert.equal(delp.ecrVsAdp, null, 'a literal "-" is missing, not zero');
});
