#!/usr/bin/env node
/*
 * determinism-guard — EPHEMERAL invariance checker: run something repeatedly and
 * prove it produces the SAME output every time. No stored baselines (that is
 * golden-lock's job — freeze-over-time); this runs a thing N times in one shot
 * and fails if the runs disagree. Three checks:
 *
 *   --cmd "<c>" [--times N]        run N times (default 2), compare stdout + exit
 *                                  byte-exact across runs; first-divergence diff on fail
 *   --cmd "<c>" --files "a,b,c"    ALSO sha256 each listed file after every run and
 *                                  compare across runs (rebuild reproducibility)
 *   --cmd "<c>" --shuffle-stdin f  run twice: once feeding f as-is, once with its lines
 *                                  shuffled by a FIXED-SEED PRNG; compare outputs
 *                                  (order-independence). Seed = 0x9E3779B9 (SHUFFLE_SEED).
 *   --canary                       self-test (the done-check); both directions
 *
 * DEFAULT is byte-exact on stdout AND exit code. Nothing is written outside the
 * canary's tmp dir — this only runs the command the caller names and reads the
 * files the caller lists.
 *
 * Exit codes: 0 invariant · 1 varying (with what varied) · 2 usage error.
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const MAX_BUF = 1 << 28; // 256 MB captured-stdout ceiling
const SHUFFLE_SEED = 0x9e3779b9; // fixed seed — shuffles are reproducible run-to-run

// ---- helpers ---------------------------------------------------------------
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// mulberry32: tiny deterministic PRNG. Same seed => same sequence, forever.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// seeded Fisher-Yates shuffle of a file's LINES; trailing-newline convention preserved
// so the shuffled input differs from the original ONLY in line order.
function shuffleLines(text) {
  const hadTrailing = text.endsWith("\n");
  const lines = text.split("\n");
  if (hadTrailing) lines.pop();
  const rng = mulberry32(SHUFFLE_SEED);
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = lines[i]; lines[i] = lines[j]; lines[j] = tmp;
  }
  return lines.join("\n") + (hadTrailing ? "\n" : "");
}

// run the command once, optionally feeding a stdin buffer. stdout captured as bytes.
function runOnce(cmd, cwd, stdinBuf) {
  const opts = { shell: true, cwd, encoding: "buffer", maxBuffer: MAX_BUF };
  if (stdinBuf != null) opts.input = stdinBuf;
  const r = spawnSync(cmd, opts);
  if (r.error) throw new Error("command failed to launch: " + r.error.message);
  return {
    stdout: r.stdout || Buffer.alloc(0),
    // signal-killed => status null; record as -1 so a crash is itself a divergence.
    exitCode: r.status == null ? -1 : r.status,
  };
}

// sha256 every listed file (relative to cwd or absolute). Missing file => throw.
function hashFiles(cwd, files) {
  const out = {};
  for (const f of files) {
    const fp = path.isAbsolute(f) ? f : path.join(cwd, f);
    if (!fs.existsSync(fp)) throw new Error("--files: no such file: " + fp);
    out[f] = sha256(fs.readFileSync(fp));
  }
  return out;
}

// first line where two byte-buffers' text diverges. Deterministic; adequate to
// point a human at the drift. Returns { line, a, b } or null if identical.
function firstDivergence(bufA, bufB) {
  if (bufA.equals(bufB)) return null;
  const a = bufA.toString("utf8").split("\n");
  const b = bufB.toString("utf8").split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { line: i + 1, a: a[i], b: b[i] };
  }
  return { line: n, a: "(end)", b: "(end)" }; // differ only in trailing bytes
}

function reportDivergence(label, ref, cur, refBuf, curBuf) {
  console.error(`VARYING: ${label}`);
  if (ref.exitCode !== cur.exitCode) {
    console.error(`  exit code: ${refBuf.label}=${ref.exitCode} vs ${curBuf.label}=${cur.exitCode}`);
  }
  const d = firstDivergence(ref.stdout, cur.stdout);
  if (d) {
    console.error(`  first divergence at stdout line ${d.line}:`);
    console.error(`    ${refBuf.label} - ${d.a === undefined ? "(no line)" : JSON.stringify(d.a)}`);
    console.error(`    ${curBuf.label} + ${d.b === undefined ? "(no line)" : JSON.stringify(d.b)}`);
  }
}

// ---- commands --------------------------------------------------------------
// default / --files: run N times, compare every run against run #1.
function cmdInvariance(cwd, cmd, times, files) {
  let ref, refHashes;
  try {
    ref = runOnce(cmd, cwd);
    if (files) refHashes = hashFiles(cwd, files);
  } catch (e) { console.error("error: " + e.message); return 2; }

  for (let k = 2; k <= times; k++) {
    let cur, curHashes;
    try {
      cur = runOnce(cmd, cwd);
      if (files) curHashes = hashFiles(cwd, files);
    } catch (e) { console.error("error: " + e.message); return 2; }

    const stdoutSame = ref.stdout.equals(cur.stdout);
    const exitSame = ref.exitCode === cur.exitCode;
    if (!stdoutSame || !exitSame) {
      reportDivergence(`run #1 vs run #${k}`, ref, cur, { label: "run#1" }, { label: `run#${k}` });
      return 1;
    }
    if (files) {
      for (const f of files) {
        if (refHashes[f] !== curHashes[f]) {
          console.error(`VARYING: file '${f}' changed between run #1 and run #${k}`);
          console.error(`  run#1 sha256=${refHashes[f].slice(0, 16)}`);
          console.error(`  run#${k} sha256=${curHashes[f].slice(0, 16)}`);
          return 1;
        }
      }
    }
  }
  const fx = files ? ` + ${files.length} file(s) reproducible` : "";
  // A command can be perfectly INVARIANT and still be broken — a typo'd path or
  // missing script fails identically every run (empty stdout, nonzero exit). That
  // is deterministic but not what the caller wants to hear as a bare green. Surface
  // the reference run's failure/empty-output signal so it can't read as a false pass.
  const notes = [];
  if (ref.exitCode !== 0) notes.push(`command exited ${ref.exitCode}`);
  if (ref.stdout.length === 0) notes.push("stdout empty");
  const note = notes.length ? ` — note: ${notes.join(", ")}` : "";
  if (note) console.error(`WARNING: reproducible but suspect${note}`);
  console.log(`INVARIANT: ${times} runs identical (stdout + exit)${fx}${note}`);
  return 0;
}

// --shuffle-stdin: run twice, once with file as-is, once with lines shuffled.
function cmdShuffle(cwd, cmd, stdinFile) {
  const fp = path.isAbsolute(stdinFile) ? stdinFile : path.join(cwd, stdinFile);
  if (!fs.existsSync(fp)) { console.error("error: --shuffle-stdin: no such file: " + fp); return 2; }
  const original = fs.readFileSync(fp);
  const shuffled = Buffer.from(shuffleLines(original.toString("utf8")), "utf8");
  if (shuffled.equals(original)) {
    console.error("error: shuffling did not reorder the input (0 or 1 lines?) — nothing to test");
    return 2;
  }
  let asIs, shuf;
  try {
    asIs = runOnce(cmd, cwd, original);
    shuf = runOnce(cmd, cwd, shuffled);
  } catch (e) { console.error("error: " + e.message); return 2; }

  const stdoutSame = asIs.stdout.equals(shuf.stdout);
  const exitSame = asIs.exitCode === shuf.exitCode;
  if (stdoutSame && exitSame) {
    console.log(`INVARIANT: output order-independent (seed 0x${SHUFFLE_SEED.toString(16)})`);
    return 0;
  }
  reportDivergence("original-order vs shuffled-stdin", asIs, shuf, { label: "orig " }, { label: "shuf " });
  return 1;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions in a throwaway dir: a deterministic cmd reads INVARIANT,
// a time-dependent cmd is CAUGHT varying, and a sort-then-print cmd is
// order-independent under --shuffle-stdin. ENV GOTCHA (Windows scar tissue): do NOT
// use `node -e "<quoted code>"` — PS 5.1 mangles quoted -e and leaves 0-byte junk.
// Write real temp .js files and run `node <file>`.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "determinism-guard-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  try {
    // (a) deterministic cmd -> INVARIANT (exit 0)
    const det = path.join(root, "det.js");
    fs.writeFileSync(det, 'process.stdout.write("stable line 1\\nstable line 2\\nchecksum=stable\\n");\n');
    check(cmdInvariance(root, `node "${det}"`, 3, null) === 0, "deterministic cmd -> INVARIANT");

    // (b) time-dependent cmd -> CAUGHT varying (exit 1)
    const vary = path.join(root, "vary.js");
    fs.writeFileSync(vary, 'process.stdout.write("t=" + process.hrtime.bigint() + "\\n");\n');
    check(cmdInvariance(root, `node "${vary}"`, 2, null) === 1, "hrtime cmd -> VARYING caught");

    // (c) sort-then-print under --shuffle-stdin -> INVARIANT (order-independent)
    const sorter = path.join(root, "sort.js");
    fs.writeFileSync(sorter,
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{' +
      'process.stdout.write(d.split("\\n").filter(Boolean).sort().join("\\n")+"\\n");});\n');
    const stdinFile = path.join(root, "in.txt");
    fs.writeFileSync(stdinFile, "delta\ncharlie\nbravo\nalpha\necho\n");
    check(cmdShuffle(root, `node "${sorter}"`, stdinFile) === 0, "sort under shuffle -> INVARIANT");

    // (d) NON-sorting (order-preserving) cmd under --shuffle-stdin -> CAUGHT varying
    const catCmd = path.join(root, "cat.js");
    fs.writeFileSync(catCmd,
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d));\n');
    check(cmdShuffle(root, `node "${catCmd}"`, stdinFile) === 1, "cat under shuffle -> VARYING caught");

    // (e) --files: a cmd that rewrites a file with fixed content -> reproducible
    const writer = path.join(root, "writer.js");
    const artifact = path.join(root, "artifact.bin");
    fs.writeFileSync(writer, `require("fs").writeFileSync(${JSON.stringify(artifact)}, "FIXED-BYTES");\n`);
    check(cmdInvariance(root, `node "${writer}"`, 2, [artifact]) === 0, "--files stable artifact -> INVARIANT");

    // (f) --files: a cmd that writes changing bytes each run -> CAUGHT varying
    const badWriter = path.join(root, "badwriter.js");
    fs.writeFileSync(badWriter,
      `require("fs").writeFileSync(${JSON.stringify(artifact)}, String(process.hrtime.bigint()));\n`);
    check(cmdInvariance(root, `node "${badWriter}"`, 2, [artifact]) === 1, "--files changing artifact -> VARYING caught");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `determinism-guard — run something repeatedly, prove the output never varies.

Usage:
  node determinism-guard.js --cmd "<command>" [--times N]
  node determinism-guard.js --cmd "<command>" --files "a,b,c"
  node determinism-guard.js --cmd "<command>" --shuffle-stdin <file>
  node determinism-guard.js --canary
  node determinism-guard.js --help

Default: run --cmd N times (N=2), compare stdout + exit code byte-exact across
runs; first-divergence line diff on failure.
--files: ALSO sha256 each listed file after every run and compare (rebuild repro).
--shuffle-stdin: run cmd twice — file as-is vs. its lines shuffled by a fixed-seed
  PRNG (seed 0x${SHUFFLE_SEED.toString(16)}) — and compare outputs (order-independence).

EPHEMERAL — no baselines are stored. To freeze an output across TIME/commits, use
golden-lock instead.

Exit codes: 0 invariant · 1 varying · 2 usage error.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP); process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.includes("--canary")) process.exit(runCanary());

  const cmd = getOpt(argv, "--cmd");
  if (!cmd) { console.error("error: --cmd \"<command>\" is required"); process.exit(2); }

  const shuffleFile = getOpt(argv, "--shuffle-stdin");
  if (shuffleFile) process.exit(cmdShuffle(process.cwd(), cmd, shuffleFile));

  let times = 2;
  const tRaw = getOpt(argv, "--times");
  if (tRaw != null) {
    times = parseInt(tRaw, 10);
    if (!Number.isInteger(times) || times < 2) { console.error("error: --times must be an integer >= 2"); process.exit(2); }
  }
  const filesRaw = getOpt(argv, "--files");
  const files = filesRaw ? filesRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (filesRaw && (!files || !files.length)) { console.error("error: --files needs at least one path"); process.exit(2); }

  process.exit(cmdInvariance(process.cwd(), cmd, times, files));
}
main();
