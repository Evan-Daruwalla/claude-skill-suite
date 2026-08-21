#!/usr/bin/env node
/*
 * seed-control — read-only static scan for UNSEEDED randomness.
 * Reproducibility guard: a random draw with no seed anywhere in its file makes a
 * run non-repeatable. Motivating case: a frozen regression test whose output
 * is pinned byte-exact — one unseeded random.random()/np.random/Math.random
 * silently breaks that reproducibility.
 *
 * Rules (same-file heuristic — see Known limits in SKILL.md):
 *   PY  random.<fn>(     flagged if NO  random.seed(                  in that file
 *   PY  np.random.<fn>(  flagged if NO  np.random.seed( or default_rng( in file
 *   JS  Math.random(     ALWAYS flagged (no seed API; use a seeded PRNG)   // seed-ok
 *
 * Suppression: a `# seed-ok` (py) or `// seed-ok` (js/ts) comment ON THE LINE
 * silences that one finding.
 *
 *   scan <path> [<path>...]   scan files/dirs (recurses .py/.js/.ts)
 *   --canary                  self-test (the done-check); both directions
 *
 * Report:  file:line:snippet   Exit 1 on findings.
 * Exit codes: 0 clean · 1 findings/canary-fail · 2 usage error.
 * Zero dependencies, Node >=16. Read-only — never writes outside the canary tmp.
 */
"use strict";
const fs = require("fs");
const path = require("path");

// .tsx/.jsx/.mjs/.cjs added 2026-08-20: they were outside the walk entirely, and
// because the report's denominator counts only files it OPENED, five files each
// containing Math.random() were reported as "1 finding in 1 file(s)" — the
// truncation invisible from the output.
const EXTS = new Set([".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"]);

// ---- detectors -------------------------------------------------------------
// bare `random.<fn>(` — but not `.random.` (excludes np.random.*) and not a def.
const PY_RANDOM_USE = /(^|[^.\w])random\.[A-Za-z_]\w*\s*\(/;
// A SEED CALL MUST CARRY A SEED. `random.seed()` with no argument draws from OS
// entropy and is non-reproducible BY DESIGN — the precise defect this tool
// exists to find — and the old `\s*\(` matched it, so a file using it was
// certified clean. Measured 2026-08-20: three files (`random.seed()`,
// `np.random.seed()`, `np.random.default_rng()`) → "clean — no unseeded
// randomness", exit 0, while bare `seed()` produced 0.5506… then 0.3473… on
// consecutive runs. Requiring a non-space, non-`)` first character is the whole
// fix: a seeded call always has one.
const PY_RANDOM_SEED = /(^|[^.\w])random\.seed\s*\(\s*[^)\s]/;
const PY_NP_USE = /\bnp\.random\.[A-Za-z_]\w*\s*\(/;
const PY_NP_SEED = /\bnp\.random\.seed\s*\(\s*[^)\s]/;
const PY_NP_RNG = /\bnp\.random\.default_rng\s*\(\s*[^)\s]|\bdefault_rng\s*\(\s*[^)\s]/;
const JS_MATH_RANDOM = /\bMath\.random\s*\(/;

const PY_SEED_OK = /#\s*seed-ok\b/;
const JS_SEED_OK = /\/\/\s*seed-ok\b/;

// np.random.seed( and np.random.default_rng( ALSO match PY_RANDOM_USE-ish? No:
// they contain `.random.` so PY_RANDOM_USE is guarded by [^.\w] before `random`.

function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return { findings: [], error: e.message }; }
  const lines = text.split(/\r?\n/);
  const ext = path.extname(file).toLowerCase();
  const findings = [];

  if (ext === ".py") {
    // A seed call mentioned only in a COMMENT ("random.seed( is called in our
    // shared harness") used to satisfy the whole-file seed check, so a file with
    // real unseeded draws reported clean — the exact false-negative this tool
    // exists to prevent. Strip comment text before deciding a file is seeded.
    // (shell-portability already masks quoted strings this way.)
    const decommented = lines.map((l) => l.replace(/#.*$/, ""));
    const hasRandomSeed = decommented.some((l) => PY_RANDOM_SEED.test(l));
    const hasNpSeed = decommented.some((l) => PY_NP_SEED.test(l) || PY_NP_RNG.test(l));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (PY_SEED_OK.test(l)) continue;
      const usesNp = PY_NP_USE.test(l);
      // np.random.seed(/default_rng( are themselves np.random.<fn>( — don't flag the seed call.
      const isNpSeedCall = PY_NP_SEED.test(l) || PY_NP_RNG.test(l);
      if (usesNp && !isNpSeedCall && !hasNpSeed) {
        findings.push({ file, line: i + 1, snippet: l.trim() });
        continue;
      }
      // bare random.<fn>( (not np.random.*, not a random.seed( call itself)
      const usesRandom = PY_RANDOM_USE.test(l) && !usesNp;
      const isRandomSeedCall = PY_RANDOM_SEED.test(l);
      if (usesRandom && !isRandomSeedCall && !hasRandomSeed) {
        findings.push({ file, line: i + 1, snippet: l.trim() });
      }
    }
  } else {
    // .js / .ts — Math.random( always unseeded   // seed-ok
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (JS_SEED_OK.test(l)) continue;
      if (JS_MATH_RANDOM.test(l)) findings.push({ file, line: i + 1, snippet: l.trim() });
    }
  }
  return { findings, error: null };
}

// ---- file walk (read-only) -------------------------------------------------
function collect(target, out) {
  let st;
  try { st = fs.statSync(target); }
  catch { return; }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return;
    for (const name of fs.readdirSync(target)) collect(path.join(target, name), out);
  } else if (st.isFile() && EXTS.has(path.extname(target).toLowerCase())) {
    out.push(target);
  }
}

// ---- command ---------------------------------------------------------------
function cmdScan(targets) {
  const files = [];
  for (const t of targets) collect(path.resolve(t), files);
  if (!files.length) { console.error("error: no .py/.js/.ts files under given path(s)"); return 2; }
  let total = 0;
  let unread = 0;
  for (const f of files.sort()) {
    // `error` was set by scanFile and consulted by NOTHING: a file that became
    // unreadable after the directory walk had already stat'd it dropped out of
    // the report with zero trace, not even on stderr. A file we could not read
    // is not a file we cleared.
    const { findings, error } = scanFile(f);
    if (error) {
      console.error(`  COULD NOT READ ${f}: ${error}`);
      unread++;
      continue;
    }
    for (const fd of findings) {
      console.log(`${fd.file}:${fd.line}:${fd.snippet}`);
      total++;
    }
  }
  if (total) {
    console.error(`\n${total} unseeded-randomness finding(s) in ${files.length} file(s)` +
      (unread ? `, ${unread} NOT scanned (unreadable)` : "") +
      ". Seed the PRNG or add a seed-ok comment.");
    return 1;
  }
  if (unread) {
    console.error(`\n0 findings, but ${unread} of ${files.length} file(s) could NOT be read — this is not a clean result.`);
    return 1;
  }
  console.log(`clean — no unseeded randomness in ${files.length} file(s)`);
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seed-control-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  const W = (name, body) => { const p = path.join(root, name); fs.writeFileSync(p, body); return p; };
  try {
    // (a) unseeded python random.random() -> flagged
    const unseeded = W("unseeded.py", "import random\nx = random.random()\ny = random.randint(0, 9)\n");
    check(scanFile(unseeded).findings.length === 2, "unseeded random.* flagged (2 uses)");

    // (b) seeded python file -> clean
    const seeded = W("seeded.py", "import random\nrandom.seed(42)\nx = random.random()\n");
    check(scanFile(seeded).findings.length === 0, "seeded random file clean");

    // (c) unseeded numpy -> flagged; seeded / default_rng -> clean
    const npBad = W("np_bad.py", "import numpy as np\na = np.random.rand(3)\n");
    check(scanFile(npBad).findings.length === 1, "unseeded np.random flagged");
    const npSeed = W("np_seed.py", "import numpy as np\nnp.random.seed(0)\na = np.random.rand(3)\n");
    check(scanFile(npSeed).findings.length === 0, "np.random.seed() makes file clean");
    const npRng = W("np_rng.py", "import numpy as np\nrng = np.random.default_rng(0)\na = np.random.rand(3)\n");
    check(scanFile(npRng).findings.length === 0, "default_rng() makes file clean");

    // (d) Math.random always flagged; // seed-ok suppresses
    const jsBad = W("bad.js", "const r = Math.random();\nconst s = Math.random(); // seed-ok\n");
    const jf = scanFile(jsBad).findings;
    check(jf.length === 1 && jf[0].line === 1, "Math.random flagged, // seed-ok suppressed");
    const tsBad = W("bad.ts", "export const r = Math.random();\n");   // seed-ok
    check(scanFile(tsBad).findings.length === 1, "Math.random flagged in .ts");

    // (e) # seed-ok suppresses python
    const pySup = W("sup.py", "import random\nx = random.random()  # seed-ok\n");
    check(scanFile(pySup).findings.length === 0, "# seed-ok suppresses python finding");

    // (f) end-to-end: scan the dir -> exit 1 (unseeded fixtures present)
    check(cmdScanQuiet([root]) === 1, "scan dir with findings -> exit 1");

    // (g) clean-only dir -> exit 0
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-control-clean-"));
    try {
      fs.writeFileSync(path.join(cleanDir, "ok.py"), "import random\nrandom.seed(1)\nx = random.random()\n");
      check(cmdScanQuiet([cleanDir]) === 0, "scan clean dir -> exit 0");

      // ---- 2026-08-20 audit: a seed call must CARRY a seed ----------------
      // `random.seed()` with no argument draws from OS entropy — the exact
      // non-reproducibility this tool exists to find — and the old regex
      // accepted it, certifying the file clean.
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-control-bare-"));
      try {
        fs.writeFileSync(path.join(bareDir, "a.py"), "import random\nrandom.seed()\nx = random.random()\n");
        check(scanFile(path.join(bareDir, "a.py")).findings.length > 0,
          "a bare random.seed() does NOT vouch for the file");
        fs.writeFileSync(path.join(bareDir, "b.py"), "import numpy as np\nnp.random.seed()\ny = np.random.rand()\n");
        check(scanFile(path.join(bareDir, "b.py")).findings.length > 0,
          "a bare np.random.seed() does NOT vouch for the file");
        fs.writeFileSync(path.join(bareDir, "c.py"), "import numpy as np\nrng = np.random.default_rng()\nz = rng.random()\n");
        check(scanFile(path.join(bareDir, "c.py")).findings.length > 0,
          "a bare default_rng() does NOT vouch for the file");
        // ...and a REAL seed still does, or the fix is just refusing everything
        fs.writeFileSync(path.join(bareDir, "d.py"), "import random\nrandom.seed(1234)\nx = random.random()\n");
        check(scanFile(path.join(bareDir, "d.py")).findings.length === 0,
          "random.seed(1234) still vouches for the file");
        fs.writeFileSync(path.join(bareDir, "e.py"), "import numpy as np\nrng = np.random.default_rng(7)\nz = rng.random()\n");
        check(scanFile(path.join(bareDir, "e.py")).findings.length === 0,
          "default_rng(7) still vouches for the file");
        // extensions that were outside the walk entirely
        for (const ext of ["tsx", "jsx", "mjs", "cjs"]) {
          fs.writeFileSync(path.join(bareDir, `f.${ext}`), "export const r = Math.random();\n");
        }
        const walked = [];
        collect(bareDir, walked);
        check(walked.filter((f) => /\.(tsx|jsx|mjs|cjs)$/.test(f)).length === 4,
          "the walk now reaches .tsx/.jsx/.mjs/.cjs");
      } finally { fs.rmSync(bareDir, { recursive: true, force: true }); }
    } finally { fs.rmSync(cleanDir, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// scan without printing findings (canary end-to-end exit-code checks)
function cmdScanQuiet(targets) {
  const files = [];
  for (const t of targets) collect(path.resolve(t), files);
  if (!files.length) return 2;
  let total = 0;
  for (const f of files) total += scanFile(f).findings.length;
  return total ? 1 : 0;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `seed-control — static scan for UNSEEDED randomness (reproducibility guard).

Usage:
  node seed-control.js scan <path> [<path>...]
  node seed-control.js --canary
  node seed-control.js --help

Rules (same-file heuristic):
  PY  random.<fn>(     flagged if the file has no  random.seed(
  PY  np.random.<fn>(  flagged if the file has no  np.random.seed( or default_rng(
  JS  Math.random(     always flagged (no seed API — use a seeded PRNG)   // seed-ok
Suppress one line with  # seed-ok  (py)  or  // seed-ok  (js/ts).

Recurses directories over .py/.js/.ts (skips node_modules/.git/__pycache__/venv/dist/build).
Report: file:line:snippet.

Exit codes: 0 clean · 1 findings / canary-fail · 2 usage error.`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(HELP); process.exit(argv.length === 0 ? 2 : 0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const sub = argv[0];
  if (sub === "scan") {
    const targets = argv.slice(1).filter((a) => !a.startsWith("--"));
    if (!targets.length) { console.error("error: scan needs at least one <path>"); process.exit(2); }
    process.exit(cmdScan(targets));
  }
  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
