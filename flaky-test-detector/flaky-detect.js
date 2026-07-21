#!/usr/bin/env node
/*
 * flaky-detect — run a test command N times, classify pass/fail stability.
 * The HARNESS is deterministic; the SUBJECT under test may not be — that is the
 * point. Each run records exit code + wall-clock duration (ms); the verdict is:
 *
 *   STABLE-PASS   every run exited 0                       -> exit 0
 *   STABLE-FAIL   every run nonzero, SAME exit every time  -> exit 1 (a red test
 *                 is a BUG, not flake — labeled as such)
 *   FLAKY         mixed exits across runs                  -> exit 1 (the finding)
 *
 * A run that exits nonzero-but-with-varying-codes (e.g. 1 then 2) is FLAKY too:
 * the story changed. STABLE-FAIL means identical failure every time.
 *
 *   --cmd "<command>"   test command, run through the shell (required)
 *   --times N           run count (default 5, min 2)
 *   --keep-logs <dir>   save each run's stdout+stderr to numbered files
 *   --canary            self-test (the done-check); both directions
 *
 * Exit codes: 0 stable-pass · 1 flaky OR stable-fail · 2 usage error.
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_TIMES = 5;
const MAX_BUF = 1 << 28; // 256 MB per-run capture ceiling

// ---- helpers ---------------------------------------------------------------
// run the subject once; capture exit code + duration + stdout/stderr buffers.
// signal-killed => status null; record as -1 so a crash reads as its own outcome.
function runOnce(cmd, cwd) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, { shell: true, cwd, encoding: "buffer", maxBuffer: MAX_BUF });
  const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
  if (r.error && r.error.code === "ENOBUFS") {
    // output exceeded the ceiling; still a completed run, treat as captured-partial.
  } else if (r.error) {
    return { exit: -1, ms, stdout: Buffer.alloc(0), stderr: Buffer.from(String(r.error.message)), launchFail: true };
  }
  return {
    exit: r.status == null ? -1 : r.status,
    ms,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: r.stderr || Buffer.alloc(0),
    launchFail: false,
  };
}

// classify the collected exit codes.
function classify(runs) {
  const exits = runs.map((r) => r.exit);
  const allPass = exits.every((e) => e === 0);
  const allFail = exits.every((e) => e !== 0);
  const sameStory = exits.every((e) => e === exits[0]);
  if (allPass) return "STABLE-PASS";
  if (allFail && sameStory) return "STABLE-FAIL";
  return "FLAKY";
}

function pct(n, total) { return (100 * n / total).toFixed(0); }

function writeLogs(dir, runs) {
  fs.mkdirSync(dir, { recursive: true });
  // pad to the width of the run count, but never fewer than 2 digits, so the
  // files are run-01.log, run-02.log, … (matches the docs) and sort correctly.
  const pad = Math.max(2, String(runs.length).length);
  // per-run log CONTENT is the subject's stdout+stderr only — no timing/exit
  // header — so `diff run-01.log run-02.log` surfaces only real subject deltas,
  // never the harness's own wall-clock jitter. Exit + duration go to meta.txt.
  const meta = ["# run  exit  duration"];
  for (let i = 0; i < runs.length; i++) {
    const n = String(i + 1).padStart(pad, "0");
    const r = runs[i];
    const body = Buffer.concat([
      Buffer.from("# --- stdout ---\n"),
      r.stdout,
      Buffer.from("\n# --- stderr ---\n"),
      r.stderr,
      Buffer.from("\n"),
    ]);
    fs.writeFileSync(path.join(dir, `run-${n}.log`), body);
    meta.push(`  ${String(i + 1).padStart(3)}  ${String(r.exit).padStart(4)}  ${String(r.ms).padStart(6)}ms`);
  }
  fs.writeFileSync(path.join(dir, "meta.txt"), meta.join("\n") + "\n");
}

// ---- report ----------------------------------------------------------------
function report(verdict, runs, cmd) {
  const total = runs.length;
  const passes = runs.filter((r) => r.exit === 0).length;
  const fails = total - passes;
  const durs = runs.map((r) => r.ms);
  const minMs = Math.min(...durs), maxMs = Math.max(...durs);

  console.log(`cmd: ${cmd}`);
  console.log(`runs: ${total}`);
  console.log("");
  console.log("  run  exit  duration");
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    console.log(`  ${String(i + 1).padStart(3)}  ${String(r.exit).padStart(4)}  ${String(r.ms).padStart(6)}ms`);
  }
  console.log("");
  console.log(`pass: ${passes}/${total} (${pct(passes, total)}%)   fail: ${fails}/${total} (${pct(fails, total)}%)`);
  console.log(`duration: min ${minMs}ms · max ${maxMs}ms`);
  console.log("");

  if (verdict === "STABLE-PASS") {
    console.log(`VERDICT: STABLE-PASS — every run exited 0.`);
  } else if (verdict === "STABLE-FAIL") {
    console.log(`VERDICT: STABLE-FAIL — every run failed identically (exit ${runs[0].exit}). This is a consistently red test: a BUG, not flake. Fix the test/subject.`);
  } else {
    const exits = [...new Set(runs.map((r) => r.exit))].sort((a, b) => a - b);
    console.log(`VERDICT: FLAKY — exit codes varied across runs (${exits.join(", ")}). Non-deterministic outcome; do not trust this test as a gate until stabilized.`);
  }
}

// ---- run command -----------------------------------------------------------
function cmdRun(cwd, opts) {
  if (!opts.cmd) { console.error('error: --cmd "<test command>" is required'); return 2; }
  if (!Number.isInteger(opts.times) || opts.times < 2) {
    console.error(`error: --times must be an integer >= 2 (got ${opts.timesRaw})`); return 2;
  }
  const runs = [];
  for (let i = 0; i < opts.times; i++) runs.push(runOnce(opts.cmd, cwd));

  if (opts.keepLogs) {
    try { writeLogs(opts.keepLogs, runs); console.error(`logs: ${opts.times} files written to ${opts.keepLogs}`); }
    catch (e) { console.error("warning: could not write logs: " + e.message); }
  }

  const verdict = classify(runs);
  report(verdict, runs, opts.cmd);
  return verdict === "STABLE-PASS" ? 0 : 1;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions in a throwaway dir: an alternating pass/fail subject is
// caught as FLAKY, and an always-pass subject stays quiet as STABLE-PASS.
// ENV GOTCHA (Windows scar tissue): don't drive the subject with `node -e "<quoted>"`
// on PS 5.1 — it mangles quoted -e and leaves 0-byte junk. Use a real temp .js.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flaky-detect-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) { passed++; } else console.error(`  FAIL: ${label}`); };
  const nodeExe = process.execPath;
  try {
    // (a) alternating pass/fail subject via a state file -> FLAKY at 4 runs.
    // reads a counter, increments it, exits 0 on even / 1 on odd calls.
    const stateFile = path.join(root, "state.txt");
    const flakyJs = path.join(root, "flaky.js");
    fs.writeFileSync(flakyJs,
      'const fs=require("fs");const p=' + JSON.stringify(stateFile) + ';' +
      'let n=0;try{n=parseInt(fs.readFileSync(p,"utf8"),10)||0;}catch(e){}' +
      'fs.writeFileSync(p,String(n+1));' +
      'process.stdout.write("run "+n+"\\n");' +
      'process.exit(n%2);\n');
    const flakyCmd = `"${nodeExe}" "${flakyJs}"`;

    // capture verdict directly (report() prints; we assert on classify()).
    const flakyRuns = [];
    for (let i = 0; i < 4; i++) flakyRuns.push(runOnce(flakyCmd, root));
    check(classify(flakyRuns) === "FLAKY", "alternating subject -> FLAKY");
    check(cmdRun(root, { cmd: flakyCmdFresh(root, nodeExe), times: 4 }) === 1, "flaky run exits 1");

    // (b) always-pass subject -> STABLE-PASS, exit 0.
    const passJs = path.join(root, "pass.js");
    fs.writeFileSync(passJs, 'process.stdout.write("ok\\n");process.exit(0);\n');
    const passCmd = `"${nodeExe}" "${passJs}"`;
    const passRuns = [];
    for (let i = 0; i < 5; i++) passRuns.push(runOnce(passCmd, root));
    check(classify(passRuns) === "STABLE-PASS", "always-pass subject -> STABLE-PASS");
    check(cmdRun(root, { cmd: passCmd, times: 5 }) === 0, "stable-pass run exits 0");

    // (c) always-fail-identically subject -> STABLE-FAIL (labeled bug, exit 1).
    const failJs = path.join(root, "fail.js");
    fs.writeFileSync(failJs, 'process.stderr.write("boom\\n");process.exit(3);\n');
    const failCmd = `"${nodeExe}" "${failJs}"`;
    const failRuns = [];
    for (let i = 0; i < 5; i++) failRuns.push(runOnce(failCmd, root));
    check(classify(failRuns) === "STABLE-FAIL", "always-fail subject -> STABLE-FAIL");
    check(cmdRun(root, { cmd: failCmd, times: 5 }) === 1, "stable-fail run exits 1");

    // (d) --keep-logs writes one numbered (min-2-digit) file per run + meta.txt,
    // and the per-run logs carry NO timing header so identical output diffs clean.
    const logDir = path.join(root, "logs");
    cmdRun(root, { cmd: passCmd, times: 3, keepLogs: logDir });
    check(fs.existsSync(path.join(logDir, "run-01.log")), "keep-logs writes run-01.log");
    const runLogs = fs.readdirSync(logDir).filter((f) => /^run-\d+\.log$/.test(f));
    check(runLogs.length === 3, "keep-logs writes one run-log per run");
    const l1 = fs.readFileSync(path.join(logDir, "run-01.log"));
    const l2 = fs.readFileSync(path.join(logDir, "run-02.log"));
    check(l1.equals(l2), "identical passing output -> byte-identical run logs");

    // (e) usage guards.
    check(cmdRun(root, { cmd: null, times: 5 }) === 2, "missing --cmd -> usage exit 2");
    check(cmdRun(root, { cmd: passCmd, times: 1, timesRaw: "1" }) === 2, "--times 1 -> usage exit 2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// the flaky subject mutates its own state file; give cmdRun a fresh one so its
// 4 runs are independent of the earlier classify() probe.
function flakyCmdFresh(root, nodeExe) {
  const stateFile = path.join(root, "state2.txt");
  const flakyJs = path.join(root, "flaky2.js");
  fs.writeFileSync(flakyJs,
    'const fs=require("fs");const p=' + JSON.stringify(stateFile) + ';' +
    'let n=0;try{n=parseInt(fs.readFileSync(p,"utf8"),10)||0;}catch(e){}' +
    'fs.writeFileSync(p,String(n+1));process.exit(n%2);\n');
  return `"${nodeExe}" "${flakyJs}"`;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `flaky-detect — run a test command N times, classify pass/fail stability.

Usage:
  node flaky-detect.js --cmd "<test command>" [--times N] [--keep-logs <dir>]
  node flaky-detect.js --canary
  node flaky-detect.js --help

Runs the command --times (default ${DEFAULT_TIMES}, min 2) times, recording each
run's exit code + duration. Verdict:
  STABLE-PASS  every run exited 0                      -> exit 0
  STABLE-FAIL  every run failed IDENTICALLY (a red     -> exit 1
               test is a bug, not flake — labeled)
  FLAKY        exit codes varied across runs           -> exit 1  (the finding)

--keep-logs <dir> saves each run's stdout+stderr to numbered run-NN.log files
for diffing. The harness is deterministic; the subject may not be — that is the
point.

Exit codes: 0 stable-pass · 1 flaky or stable-fail · 2 usage error.`;

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

  const timesRaw = getOpt(argv, "--times");
  const times = timesRaw == null ? DEFAULT_TIMES : parseInt(timesRaw, 10);
  process.exit(cmdRun(process.cwd(), {
    cmd: getOpt(argv, "--cmd"),
    times,
    timesRaw: timesRaw == null ? String(DEFAULT_TIMES) : timesRaw,
    keepLogs: getOpt(argv, "--keep-logs"),
  }));
}
main();
