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
 *   JS  Math.random(     ALWAYS flagged (no seed API; use a seeded PRNG)
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

const EXTS = new Set([".py", ".js", ".ts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"]);

// ---- detectors -------------------------------------------------------------
// bare `random.<fn>(` — but not `.random.` (excludes np.random.*) and not a def.
const PY_RANDOM_USE = /(^|[^.\w])random\.[A-Za-z_]\w*\s*\(/;
const PY_RANDOM_SEED = /(^|[^.\w])random\.seed\s*\(/;
const PY_NP_USE = /\bnp\.random\.[A-Za-z_]\w*\s*\(/;
const PY_NP_SEED = /\bnp\.random\.seed\s*\(/;
const PY_NP_RNG = /\bnp\.random\.default_rng\s*\(|\bdefault_rng\s*\(/;
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
    const hasRandomSeed = lines.some((l) => PY_RANDOM_SEED.test(l));
    const hasNpSeed = lines.some((l) => PY_NP_SEED.test(l) || PY_NP_RNG.test(l));
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
    // .js / .ts — Math.random( always unseeded
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
  for (const f of files.sort()) {
    const { findings } = scanFile(f);
    for (const fd of findings) {
      console.log(`${fd.file}:${fd.line}:${fd.snippet}`);
      total++;
    }
  }
  if (total) { console.error(`\n${total} unseeded-randomness finding(s) in ${files.length} file(s). Seed the PRNG or add a seed-ok comment.`); return 1; }
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
    const tsBad = W("bad.ts", "export const r = Math.random();\n");
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
  JS  Math.random(     always flagged (no seed API — use a seeded PRNG)
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
