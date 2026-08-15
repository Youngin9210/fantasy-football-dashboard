// Verifies the Preact rewrite renders the same DOM as the vanilla version.
//
// Serves this working tree and a git worktree of `main` on two ports, loads
// both in headless Chrome with identical seeded localStorage, and diffs a
// normalized structural extraction of the rendered page.
//
// No dependencies: a hand-rolled static file server, and CDP driven over
// Node's built-in global WebSocket against chrome-headless-shell.
//
// Usage: node tools/dom-diff.mjs [--verbose]
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENARIOS, STORAGE_KEY, ENSURE_SETUP_OPEN_SOURCE, serve, launchChrome, Page,
} from './harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

// ------------------------------------------------------------ in-page code
//
// Everything below the `PAGE_SOURCE` marker runs inside the browser, injected
// as a string. Kept as source text (not a function reference) so the shape of
// the normalizer is obvious and reviewable.

const PAGE_SOURCE = String.raw`
// Walk the DOM emitting tag + sorted attributes + trimmed text. A raw
// innerHTML diff would be pure noise: the vanilla build emits template-literal
// indentation and Preact does not.
//
// Normalizations, each deliberate and documented in the task report:
//  * attribute values collapse runs of whitespace and trim, which absorbs the
//    trailing space an empty interpolation leaves behind (class="btn small ").
//  * the style attribute is compared by COMPUTED value of each property, since
//    Preact re-serializes the shorthand (flex:none -> flex: 0 0 auto).
//  * form controls are compared by their value/selected/checked PROPERTY, not
//    attribute: Preact's defaultValue reflects into the value attribute and
//    vanilla assigned the property only. What the user sees is the property.
//  * ADJACENT TEXT NODES ARE MERGED before comparison. htm gives every
//    interpolation its own text node, so "Pick (n) - Rd (r)" is three nodes
//    where the template literal produced one. The character sequence is
//    compared unchanged, so a genuinely missing space ("T 1" vs "T1") still
//    diffs -- only the invisible node boundary is normalized away.
function extract(root) {
  const out = [];
  const FORM_VALUE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  const styleSig = (node) => {
    const decl = node.style;
    if (!decl || decl.length === 0) return null;
    const cs = getComputedStyle(node);
    const parts = [];
    for (let i = 0; i < decl.length; i++) {
      const prop = decl[i];
      parts.push(prop + ':' + cs.getPropertyValue(prop));
    }
    return parts.sort().join('; ');
  };

  const emitText = (raw, depth) => {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push('  '.repeat(depth) + '"' + t + '"');
  };

  const walkChildren = (parent, depth) => {
    let text = '';
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) { text += child.textContent; continue; }
      if (child.nodeType === 8) continue; // comments are invisible
      emitText(text, depth);
      text = '';
      walk(child, depth);
    }
    emitText(text, depth);
  };

  const walk = (node, depth) => {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT') return;

    const checkable = node.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(node.type);
    const skip = new Set(['style']);
    if (FORM_VALUE.has(node.tagName)) skip.add('value');
    if (node.tagName === 'OPTION') skip.add('selected');
    if (checkable) skip.add('checked');

    const attrs = [...node.attributes]
      .filter((a) => !skip.has(a.name))
      .map((a) => a.name + '=' + JSON.stringify(a.value.replace(/\s+/g, ' ').trim()));

    const sig = styleSig(node);
    if (sig !== null) attrs.push('style=' + JSON.stringify(sig));
    if (FORM_VALUE.has(node.tagName)) attrs.push('value=' + JSON.stringify(node.value));
    if (node.tagName === 'OPTION') attrs.push('selected=' + node.selected);
    if (checkable) attrs.push('checked=' + node.checked);

    attrs.sort();
    out.push('  '.repeat(depth) + '<' + node.tagName.toLowerCase() +
      (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
    walkChildren(node, depth + 1);
  };

  // The rewrite mounts into <div id="root">; vanilla writes its markup
  // straight into <body>. Compare the CONTENTS of whichever container the
  // build uses so the wrapper itself is not a spurious difference.
  walkChildren(document.getElementById('root') || document.body, 0);
  return out.join('\n');
}

async function capture() {
  // ensureSetupOpen / countRows come from harness.mjs's ENSURE_SETUP_OPEN_SOURCE,
  // spliced in below, and are shared with tools/screenshot-diff.mjs.
  const toggled = await ensureSetupOpen();
  const { rows, playerRows } = countRows();
  const keyed = document.querySelectorAll('[key]').length;
  return { dom: extract(document), rows, playerRows, keyed, toggled };
}
` + ENSURE_SETUP_OPEN_SOURCE;

// --------------------------------------------------------------- utilities

async function captureScenario(page, origin, state) {
  await page.goto(`${origin}/`);
  await page.eval(`(() => {
    localStorage.clear();
    const s = ${JSON.stringify(JSON.stringify(state))};
    if (s !== 'null') localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, s);
  })()`);
  await page.reload();
  const errors = [];
  const off = page.on('Runtime.exceptionThrown', (p) => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  const result = await page.eval(`(async () => { ${PAGE_SOURCE}\nreturn await capture(); })()`, { awaitPromise: true });
  off();
  result.errors = errors;
  return result;
}

// --------------------------------------------------------------------- diff

// Plain LCS line diff. The extractions are a few hundred lines, so the
// quadratic table is irrelevant and the output is easy to read.
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push(['-', a[i++]]); }
    else { out.push(['+', b[j++]]); }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

function unified(ops, context = 2) {
  if (!ops.some(([k]) => k !== '=')) return null;
  const keep = new Set();
  ops.forEach(([kind], idx) => {
    if (kind === '=') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
  });
  const lines = [];
  let gap = false;
  ops.forEach(([kind, text], idx) => {
    if (!keep.has(idx)) { gap = true; return; }
    if (gap) { lines.push('   ...'); gap = false; }
    lines.push(`${kind === '=' ? ' ' : kind}  ${text}`);
  });
  return lines.join('\n');
}

// The one signed-off behavior change that shows up as a DOM difference: in
// need mode the excluded ("At position limit") group now renders AFTER the
// drafted rows instead of before, so drafted players never sit under a divider
// claiming they are at a limit. It appears in the diff as a block of table
// rows removed from one position and re-inserted, byte for byte, at another.
//
// Accepting it is deliberately narrow: the removed and inserted blocks must be
// line-for-line identical, and the block must start at a <tr>. Anything else,
// including any block whose CONTENT changed, is reported as unexpected.
function classify(ops) {
  const blocks = [];
  let run = null;
  ops.forEach(([kind, text], idx) => {
    if (kind === '=') { run = null; return; }
    if (!run || run.kind !== kind) { run = { kind, start: idx, lines: [] }; blocks.push(run); }
    run.lines.push(text);
  });

  const moves = [];
  const removed = blocks.filter((b) => b.kind === '-');
  const added = blocks.filter((b) => b.kind === '+');
  const isRowBlock = (b) => /^\s*<tr\b/.test(b.lines[0]);
  for (const r of removed) {
    if (r.paired || !isRowBlock(r)) continue;
    const match = added.find((a) => !a.paired && a.lines.length === r.lines.length
      && a.lines.every((line, i) => line === r.lines[i]));
    if (!match) continue;
    r.paired = match.paired = true;
    moves.push(r);
  }

  const unexpected = [];
  for (const b of blocks) {
    if (b.paired) continue;
    for (const line of b.lines) unexpected.push(`${b.kind}  ${line}`);
  }
  return { unexpected, moves };
}

// --------------------------------------------------------------------- main

async function main() {
  const wt = mkdtempSync(join(tmpdir(), 'ffdash-main-'));
  const profile = mkdtempSync(join(tmpdir(), 'ffdash-chrome-'));
  let chrome = null;
  let servers = [];
  let pages = [];
  let failures = 0;

  // A run killed by a signal (SIGPIPE from `| head`, Ctrl-C) never reaches the
  // finally, so clear any registration whose directory is already gone.
  execSync('git worktree prune', { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  execSync(`git worktree add --detach ${wt} main`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  try {
    const oldSrv = await serve(wt);
    const newSrv = await serve(ROOT.replace(/\/$/, ''));
    servers = [oldSrv.server, newSrv.server];
    console.log(`vanilla (main): ${oldSrv.origin}  ->  ${wt}`);
    console.log(`preact  (head): ${newSrv.origin}  ->  ${ROOT}`);

    chrome = await launchChrome(profile);
    const oldPage = await Page.open(chrome.host, 'about:blank');
    const newPage = await Page.open(chrome.host, 'about:blank');
    pages = [oldPage, newPage];

    const summary = [];
    for (const sc of SCENARIOS) {
      const before = await captureScenario(oldPage, oldSrv.origin, sc.state);
      const after = await captureScenario(newPage, newSrv.origin, sc.state);

      const problems = [];
      for (const [label, cap] of [['vanilla', before], ['preact', after]]) {
        if (cap.errors.length) problems.push(`${label} threw: ${cap.errors.join(' | ')}`);
        if (cap.keyed) problems.push(`${label} rendered ${cap.keyed} element(s) with a literal key attribute`);
        // Two blank pages diff clean. The chrome alone is well over 100 lines.
        const lines = cap.dom.split('\n').length;
        if (lines < 100) problems.push(`${label} extraction is only ${lines} lines -- did the page render?`);
      }
      // A harness that diffs two empty tables and reports success is worse
      // than no harness.
      if (sc.expectRows && (before.rows === 0 || after.rows === 0)) {
        problems.push(`expected rows but got vanilla=${before.rows} preact=${after.rows}`);
      }
      if (!sc.expectRows && (before.playerRows !== 0 || after.playerRows !== 0)) {
        problems.push(`expected no player rows but got vanilla=${before.playerRows} preact=${after.playerRows}`);
      }

      const ops = diffLines(before.dom.split('\n'), after.dom.split('\n'));
      const diff = unified(ops);
      const { unexpected, moves } = classify(ops);

      const ok = problems.length === 0 && unexpected.length === 0;
      if (!ok) failures++;
      summary.push({ name: sc.name, ok, rows: [before.rows, after.rows],
        playerRows: [before.playerRows, after.playerRows], moves: moves.length });

      console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${sc.name}`);
      console.log(`      rows: vanilla=${before.rows} preact=${after.rows}` +
        ` (player rows ${before.playerRows}/${after.playerRows})` +
        `  lines: ${before.dom.split('\n').length}/${after.dom.split('\n').length}` +
        `  setup toggled: vanilla=${before.toggled} preact=${after.toggled}`);
      for (const m of moves) {
        console.log(`      accepted move (approved need-mode row order): ` +
          `${m.lines.length} lines starting ${m.lines[0].trim()}`);
      }
      for (const p of problems) console.log(`      PROBLEM: ${p}`);
      if (unexpected.length) {
        console.log('      UNEXPECTED DIFFERENCES (- vanilla, + preact):');
        for (const line of unexpected) console.log(`      ${line}`);
      }
      if (VERBOSE && diff) console.log(`\n--- full diff: ${sc.name} ---\n${diff}`);
    }

    console.log('\n================ summary ================');
    for (const s of summary) {
      console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(34)} rows ${s.rows[0]}/${s.rows[1]}` +
        ` (player rows ${s.playerRows[0]}/${s.playerRows[1]})` +
        (s.moves ? `  accepted moves: ${s.moves}` : ''));
    }
    console.log(failures === 0
      ? '\nAll scenarios match (modulo the documented accepted differences).'
      : `\n${failures} scenario(s) differ.`);
  } finally {
    for (const p of pages) p.close();
    if (chrome) chrome.proc.kill('SIGKILL');
    for (const s of servers) s.close();
    execSync(`git worktree remove --force ${wt}`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
