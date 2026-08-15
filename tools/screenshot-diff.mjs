// Pixel-level proof that the Preact rewrite LOOKS the same as the vanilla build.
//
// tools/dom-diff.mjs already proves structure, attributes and text match. It
// deliberately normalizes whitespace between inline elements, so a spacing or
// color regression that never touches the DOM would slip past it. This tool
// closes that gap: it serves this working tree and a git worktree of the
// pre-rewrite commit on two ports, loads both in headless Chrome with identical
// seeded localStorage and an identical 1440x900 viewport, takes full-page
// screenshots in BOTH themes, and diffs them pixel by pixel.
//
// No dependencies. The static server, chrome-headless-shell launch, CDP client
// and seeded scenarios are shared with dom-diff.mjs via tools/harness.mjs; PNG
// decoding/encoding is hand-rolled on Node's built-in zlib in tools/png.mjs.
// The comparison is done in Node, not in the page.
//
// Usage: node tools/screenshot-diff.mjs [--verbose] [--no-self-test]
//                                       [--keep-passing] [--ref <commit>]
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENARIOS, STORAGE_KEY, THEME_KEY, ENSURE_SETUP_OPEN_SOURCE,
  serve, launchChrome, Page,
} from './harness.mjs';
import { decodePng, encodePng } from './png.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OUT_DIR = join(ROOT, 'screenshot-diff-out');
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const SELF_TEST = !argv.includes('--no-self-test');
const KEEP_PASSING = argv.includes('--keep-passing');
const OLD_REF = argv.includes('--ref') ? argv[argv.indexOf('--ref') + 1] : '998d3ad';

const VIEWPORT = { width: 1440, height: 900 };
const THEMES = ['dark', 'light'];

// A screenshot of a blank page matches another blank page perfectly, so every
// capture must clear these before a 0% difference means anything.
const MIN_DISTINCT_COLORS = 24;
const MIN_FULL_PAGE_HEIGHT = VIEWPORT.height;
// The two themes must be visibly different from each other, or "identical in
// both themes" would only prove the theme seed never took effect.
const MIN_THEME_SEPARATION_PCT = 5;

// ------------------------------------------------------------ in-page code

const PREP_SOURCE = ENSURE_SETUP_OPEN_SOURCE + String.raw`
// Runs after load, before the screenshot. Forces the two builds into the same
// setup-panel state (approved behavior change #1: vanilla shows the panel on
// every load, the rewrite only on an empty install) and reports the facts the
// harness needs to know a real page was rendered.
async function prep() {
  const toggled = await ensureSetupOpen();
  await nextFrame();
  const { rows, playerRows } = countRows();
  const doc = document.documentElement;
  return {
    toggled, rows, playerRows,
    theme: doc.getAttribute('data-theme'),
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    setupVisible: !!document.getElementById('setupPanel')
      && !document.getElementById('setupPanel').classList.contains('hidden'),
    textLength: document.body.innerText.replace(/\s+/g, ' ').trim().length,
  };
}
`;

// --------------------------------------------------------------- capturing

async function openPage(host) {
  const page = await Page.open(host, 'about:blank');
  // Identical metrics on both builds, set once and left in place so the page
  // LAYS OUT at 1440x900 rather than being resized after render.
  await page.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT, deviceScaleFactor: 1, mobile: false,
  });
  return page;
}

async function shoot(page, origin, state, theme) {
  // Seed from a 404 on the SAME origin, not from the app itself. Loading the
  // app first and clearing localStorage underneath it is a race: the rewrite's
  // useTheme reads ffTheme at mount and writes it back in an effect, so a seed
  // written between those two moments is silently clobbered and the next load
  // renders the previous scenario's theme.
  await page.goto(`${origin}/__seed__`);
  await page.eval(`(() => {
    localStorage.clear();
    const s = ${JSON.stringify(JSON.stringify(state))};
    if (s !== 'null') localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, s);
    localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(theme)});
  })()`);
  await page.goto(`${origin}/`);

  const errors = [];
  const off = page.on('Runtime.exceptionThrown', (p) => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  const info = await page.eval(
    `(async () => { ${PREP_SOURCE}\nreturn await prep(); })()`, { awaitPromise: true });
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, fromSurface: true, optimizeForSpeed: false,
  });
  off();

  const img = decodePng(Buffer.from(data, 'base64'));
  return { img, info, errors };
}

// ------------------------------------------------------------- comparison

/** Number of distinct RGBA values, counted up to `cap` then abandoned. */
function distinctColors(img, cap = 4096) {
  const seen = new Set();
  const px = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  for (let i = 0; i < px.length; i++) {
    seen.add(px[i]);
    if (seen.size >= cap) return cap;
  }
  return seen.size;
}

/**
 * Pixel-exact comparison over the union of both canvases. A pixel that exists
 * in one image and not the other counts as differing, so a height change is
 * never silently ignored.
 */
function comparePixels(a, b) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const mask = new Uint8Array(width * height);
  let differing = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;
      let same;
      if (inA !== inB) same = false;
      else if (!inA) same = true;
      else {
        const ia = (y * a.width + x) * 4;
        const ib = (y * b.width + x) * 4;
        same = a.data[ia] === b.data[ib] && a.data[ia + 1] === b.data[ib + 1]
          && a.data[ia + 2] === b.data[ib + 2] && a.data[ia + 3] === b.data[ib + 3];
      }
      if (!same) { mask[y * width + x] = 1; differing++; }
    }
  }
  return { width, height, mask, total: width * height, differing };
}

/**
 * Largest 4-connected run of differing pixels, so a real regression can be
 * pointed at instead of just counted. Iterative flood fill over an explicit
 * stack: a 1440x3000 page is 4M pixels and recursion would blow the stack.
 */
function regions({ width, height, mask }) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const found = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let count = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width, y = (idx / width) | 0;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x + 1 < width && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack[sp++] = idx - width; }
      if (y + 1 < height && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack[sp++] = idx + width; }
    }
    found.push({ pixels: count, x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  found.sort((p, q) => q.pixels - p.pixels);
  return found;
}

const fmtRegion = (r) => `${r.pixels.toLocaleString()} px at x=${r.x} y=${r.y} ${r.width}x${r.height}`;

function reportRegions(list, indent = '         ') {
  if (!list.length) return;
  console.log(`${indent}largest differing region: ${fmtRegion(list[0])}` +
    (list.length > 1 ? `   (${list.length} disjoint regions total)` : ''));
  for (const r of list.slice(1, VERBOSE ? 12 : 5)) console.log(`${indent}  also: ${fmtRegion(r)}`);
  const rest = list.length - Math.min(list.length, VERBOSE ? 12 : 5);
  if (rest > 0) console.log(`${indent}  ...and ${rest} smaller region(s)`);
}

// --------------------------------------------------------------- rendering

function blank(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width, height, data };
}

function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const d = ((oy + y) * dst.width + ox) * 4;
    dst.data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), d);
  }
}

const GUTTER = 16;

function sideBySide(a, b) {
  const out = blank(a.width + GUTTER + b.width, Math.max(a.height, b.height), [24, 24, 28]);
  blit(out, a, 0, 0);
  blit(out, b, a.width + GUTTER, 0);
  return out;
}

/** The new build, desaturated and dimmed, with every differing pixel in magenta. */
function diffImage(b, cmp) {
  const out = blank(cmp.width, cmp.height, [16, 16, 20]);
  for (let y = 0; y < cmp.height; y++) {
    for (let x = 0; x < cmp.width; x++) {
      const o = (y * cmp.width + x) * 4;
      if (cmp.mask[y * cmp.width + x]) {
        out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 200; out.data[o + 3] = 255;
      } else if (x < b.width && y < b.height) {
        const i = (y * b.width + x) * 4;
        const g = ((b.data[i] * 77 + b.data[i + 1] * 150 + b.data[i + 2] * 29) >> 8) >> 1;
        out.data[o] = g; out.data[o + 1] = g; out.data[o + 2] = g; out.data[o + 3] = 255;
      }
    }
  }
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function writeArtifacts(name, old, neu, cmp) {
  const files = {
    [`${name}.vanilla.png`]: old,
    [`${name}.preact.png`]: neu,
    [`${name}.side-by-side.png`]: sideBySide(old, neu),
    [`${name}.diff.png`]: diffImage(neu, cmp),
  };
  for (const [file, img] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, file), encodePng(img));
  }
  return Object.keys(files);
}

// ------------------------------------------------------------- assertions

/** Everything that must hold before a 0% difference is allowed to mean anything. */
function vacuityProblems(label, sc, shotResult) {
  const { img, info, errors } = shotResult;
  const out = [];
  if (errors.length) out.push(`${label} threw: ${errors.join(' | ')}`);
  if (info.theme !== null && info.theme !== shotResult.theme) {
    out.push(`${label} has data-theme="${info.theme}" but was seeded "${shotResult.theme}"`);
  }
  if (!info.setupVisible) out.push(`${label} setup panel is not visible -- panel state was not forced`);
  if (img.width !== VIEWPORT.width) {
    out.push(`${label} screenshot is ${img.width}px wide, expected ${VIEWPORT.width}`);
  }
  if (img.height < MIN_FULL_PAGE_HEIGHT) {
    out.push(`${label} screenshot is only ${img.height}px tall -- did the page render?`);
  }
  const colors = distinctColors(img);
  shotResult.colors = colors;
  if (colors < MIN_DISTINCT_COLORS) {
    out.push(`${label} screenshot has only ${colors} distinct colors -- looks blank`);
  }
  if (info.textLength < 200) {
    out.push(`${label} rendered only ${info.textLength} characters of text -- looks blank`);
  }
  if (sc.expectRows && info.rows === 0) out.push(`${label} expected table rows, rendered none`);
  if (!sc.expectRows && info.playerRows !== 0) {
    out.push(`${label} expected no player rows, rendered ${info.playerRows}`);
  }
  return out;
}

// -------------------------------------------------------------- self-test

// A harness that reports 0% everywhere without being proven sensitive is
// worthless. Re-serve the head tree with one small CSS override injected and
// confirm the comparison notices. Runs by default; --no-self-test skips it.
const PERTURBATION = '\n/* screenshot-diff self-test */\n.setup-card h3 { color: #ff0000 !important; }\n';

async function selfTest(host, oldOrigin) {
  const sc = SCENARIOS.find((s) => s.name === 'rankings, team selected, need mode');
  const srv = await serve(ROOT, (rel, buf) => (
    rel === '/css/styles.css' ? Buffer.concat([buf, Buffer.from(PERTURBATION)]) : buf));
  const page = await openPage(host);
  try {
    const clean = await shoot(page, oldOrigin, sc.state, 'dark');
    const dirty = await shoot(page, srv.origin, sc.state, 'dark');
    const cmp = comparePixels(clean.img, dirty.img);
    const regionList = cmp.differing ? regions(cmp) : [];
    return { cmp, regionList, pct: (cmp.differing / cmp.total) * 100 };
  } finally {
    page.close();
    srv.server.close();
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const wt = mkdtempSync(join(tmpdir(), 'ffdash-shot-'));
  const profile = mkdtempSync(join(tmpdir(), 'ffdash-chrome-shot-'));
  let chrome = null;
  const servers = [];
  const pages = [];
  let failures = 0;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // A run killed by a signal never reaches the finally, so clear any stale
  // registration whose directory is already gone.
  execSync('git worktree prune', { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  execSync(`git worktree add --detach ${wt} ${OLD_REF}`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
  try {
    const oldSrv = await serve(wt);
    const newSrv = await serve(ROOT);
    servers.push(oldSrv.server, newSrv.server);
    const sha = execSync(`git rev-parse --short ${OLD_REF}`, { cwd: ROOT }).toString().trim();
    console.log(`vanilla (${sha}): ${oldSrv.origin}  ->  ${wt}`);
    console.log(`preact  (head)   : ${newSrv.origin}  ->  ${ROOT}`);
    console.log(`viewport ${VIEWPORT.width}x${VIEWPORT.height}, full-page capture, themes: ${THEMES.join(', ')}`);
    console.log(`output           : ${OUT_DIR}\n`);

    chrome = await launchChrome(profile);
    const oldPage = await openPage(chrome.host);
    const newPage = await openPage(chrome.host);
    pages.push(oldPage, newPage);

    const summary = [];
    for (const sc of SCENARIOS) {
      const perTheme = {};
      for (const theme of THEMES) {
        const before = await shoot(oldPage, oldSrv.origin, sc.state, theme);
        const after = await shoot(newPage, newSrv.origin, sc.state, theme);
        before.theme = after.theme = theme;
        perTheme[theme] = { before, after };

        const problems = [
          ...vacuityProblems('vanilla', sc, before),
          ...vacuityProblems('preact', sc, after),
        ];

        const cmp = comparePixels(before.img, after.img);
        const pct = (cmp.differing / cmp.total) * 100;
        const regionList = cmp.differing ? regions(cmp) : [];
        const region = regionList[0] || null;

        // Approved behavior change #2: in need mode with something at a
        // position limit, drafted rows moved above the "At position limit"
        // divider. That reorders table rows, so a large difference here is
        // expected -- but a 0% or 100% difference would mean the harness, not
        // the app, is broken.
        const expected = !!sc.reordersRows;
        let verdict;
        if (problems.length) verdict = 'FAIL';
        else if (expected) {
          if (cmp.differing === 0) { problems.push('expected the approved need-mode row reorder to show up, saw 0 differing pixels'); verdict = 'FAIL'; }
          else if (pct > 60) { problems.push(`the approved reorder should be localized, but ${pct.toFixed(2)}% of the page differs`); verdict = 'FAIL'; }
          else verdict = 'ACCEPTED';
        } else verdict = cmp.differing === 0 ? 'PASS' : 'FAIL';

        if (verdict === 'FAIL') failures++;

        const name = `${slug(sc.name)}.${theme}`;
        const wrote = (cmp.differing > 0 || KEEP_PASSING)
          ? writeArtifacts(name, before.img, after.img, cmp) : [];

        console.log(`${verdict.padEnd(8)} ${sc.name} [${theme}]`);
        console.log(`         ${cmp.width}x${cmp.height} = ${cmp.total.toLocaleString()} px` +
          `  differing ${cmp.differing.toLocaleString()} (${pct.toFixed(4)}%)` +
          `  colors ${before.colors}/${after.colors}` +
          `  rows ${before.info.rows}/${after.info.rows}` +
          `  page height ${before.img.height}/${after.img.height}`);
        reportRegions(regionList);
        for (const p of problems) console.log(`         PROBLEM: ${p}`);
        if (wrote.length) console.log(`         wrote ${wrote.join(', ')}`);

        summary.push({ scenario: sc.name, theme, verdict, pct, differing: cmp.differing,
          total: cmp.total, region });
      }

      // Both themes rendering identically would mean the theme seed never took
      // effect and "both themes match" proved nothing.
      const sep = comparePixels(perTheme.dark.after.img, perTheme.light.after.img);
      const sepPct = (sep.differing / sep.total) * 100;
      if (sepPct < MIN_THEME_SEPARATION_PCT) {
        failures++;
        console.log(`FAIL     ${sc.name}: dark and light renders differ by only ` +
          `${sepPct.toFixed(2)}% -- the theme seed did not take effect`);
      } else if (VERBOSE) {
        console.log(`         (theme separation check: dark vs light differ by ${sepPct.toFixed(2)}%)`);
      }
      console.log('');
    }

    if (SELF_TEST) {
      console.log('---------------- sensitivity self-test ----------------');
      const st = await selfTest(chrome.host, oldSrv.origin);
      const ok = st.cmp.differing > 0;
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}     injected CSS override (.setup-card h3 { color:#ff0000 })`);
      console.log(`         differing ${st.cmp.differing.toLocaleString()} of ` +
        `${st.cmp.total.toLocaleString()} px (${st.pct.toFixed(4)}%)`);
      reportRegions(st.regionList);
      if (!ok) console.log('         PROBLEM: the harness did not notice a deliberate visual change');
      console.log('');
    }

    console.log('======================== summary ========================');
    for (const s of summary) {
      console.log(`${s.verdict.padEnd(8)} ${(`${s.scenario} [${s.theme}]`).padEnd(46)}` +
        ` ${s.pct.toFixed(4)}%  (${s.differing.toLocaleString()}/${s.total.toLocaleString()} px)`);
    }
    console.log(failures === 0
      ? '\nEvery scenario is pixel-identical in both themes, except the one approved reorder.'
      : `\n${failures} comparison(s) failed.`);
  } finally {
    for (const p of pages) p.close();
    if (chrome) chrome.proc.kill('SIGKILL');
    for (const s of servers) s.close();
    execSync(`git worktree remove --force ${wt}`, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'pipe' });
    rmSync(profile, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
