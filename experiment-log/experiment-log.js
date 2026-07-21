#!/usr/bin/env node
/*
 * experiment-log — reproducibility provenance for a run. Runs a command, then
 * appends ONE JSON line capturing everything needed to reproduce it later:
 * ISO timestamp, cwd, cmd, exitCode, durationMs, git {commit, dirty} of the cwd
 * repo, tool versions {node, python}, and the sha256 of every declared input
 * (captured BEFORE the run) and output (after). Append-only — the log is never
 * rewritten.
 *
 * This is MACHINE provenance, deliberately separate from the project's narrative
 * docs: it never touches HANDOFF.md or the append-only record (project-memory
 * owns those). A logged run answers "what exact inputs/code/versions produced
 * this result?" so the result is reproducible.
 *
 *   log --cmd "<command>" [--in a,b] [--out c,d] [--note "..."] [--file <path>] [--no-run]
 *   show [--file <path>]     pretty-print entries, oldest-first (newest last)
 *   --canary                 self-test (the done-check); both directions
 *
 * --in / --out are comma-separated file lists. --in files are hashed before the
 * run, --out files after. --no-run records provenance without executing
 * (exitCode + durationMs null). Default log file: experiments.jsonl in cwd.
 *
 * Exit codes: 0 ok · 1 nothing-to-show / canary-fail · 2 usage error.
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const DEFAULT_FILE = "experiments.jsonl";

// ---- helpers ---------------------------------------------------------------
// sha256 of a file's bytes; null if the file is absent or unreadable (a missing
// input/output is recorded as null, never faked).
function sha256File(fp) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex"); }
  catch { return null; }
}

// { path: sha256|null } for a comma-separated list, relative to cwd. Order and
// keys are preserved so the same --in across runs produces the same object.
function hashList(list, cwd) {
  const out = {};
  for (const raw of list) {
    const rel = raw.trim();
    if (!rel) continue;
    out[rel] = sha256File(path.isAbsolute(rel) ? rel : path.join(cwd, rel));
  }
  return out;
}

// git {commit, dirty} of the repo containing cwd; null outside a repo (or a repo
// with no commits yet). `logFile` (absolute path, optional) is EXCLUDED from the
// dirty check: the tool's own append-only log is an artifact of logging, not a
// change to the experiment's code — without this exclusion an untracked
// experiments.jsonl flips dirty false->true on the 2nd+ run with zero user
// changes, making the provenance non-reproducible (verifier finding #1).
function gitInfo(cwd, logFile) {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (rev.status !== 0 || !rev.stdout) return null;
  const args = ["status", "--porcelain"];
  if (logFile) {
    // pathspec: everything under cwd EXCEPT the log file (path relative to cwd,
    // which is how git interprets a pathspec run with cwd as its working dir).
    const rel = path.relative(cwd, logFile).split(path.sep).join("/");
    args.push("--", ".", `:(exclude)${rel}`);
  }
  const st = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { commit: rev.stdout.trim(), dirty: st.status === 0 && st.stdout.trim().length > 0 };
}

// tool versions; python null when not on PATH (reported missing, not faked).
function toolVersions() {
  const py = spawnSync("python", ["--version"], { encoding: "utf8" });
  const pyVer = py.status === 0 ? (py.stdout || py.stderr || "").trim() || null : null;
  return { node: process.version, python: pyVer };
}

function splitCsv(v) { return v ? String(v).split(",") : []; }

// ---- commands --------------------------------------------------------------
function cmdLog(cwd, opts) {
  if (!opts.cmd) { console.error('error: log needs --cmd "<command>"'); return 2; }
  const file = path.isAbsolute(opts.file) ? opts.file : path.join(cwd, opts.file);

  // inputs hashed BEFORE the run so the recorded hash is the state the run saw.
  const inHashes = hashList(splitCsv(opts.in), cwd);
  const git = gitInfo(cwd, file);
  const versions = toolVersions();

  let exitCode = null, durationMs = null;
  if (!opts.noRun) {
    const start = Date.now();
    const r = spawnSync(opts.cmd, { shell: true, cwd, stdio: "inherit" });
    durationMs = Date.now() - start;
    // signal-killed => status null; record -1 so a crash is still a value.
    exitCode = r.status == null ? -1 : r.status;
  }

  // outputs hashed AFTER the run.
  const outHashes = hashList(splitCsv(opts.out), cwd);

  const entry = {
    ts: new Date().toISOString(),
    cwd,
    cmd: opts.cmd,
    exitCode,
    durationMs,
    git,
    versions,
    in: inHashes,
    out: outHashes,
    note: opts.note || null,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  const tag = opts.noRun ? "recorded (no-run)" : `exit=${exitCode} ${durationMs}ms`;
  console.log(`LOGGED ${tag} -> ${path.relative(cwd, file) || opts.file}`);
  return 0;
}

function cmdShow(cwd, opts) {
  const file = path.isAbsolute(opts.file) ? opts.file : path.join(cwd, opts.file);
  if (!fs.existsSync(file)) { console.error(`error: no log file '${opts.file}'`); return 1; }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  if (!lines.length) { console.log("(log is empty)"); return 1; }
  // oldest-first (file/append order) so the newest entry is printed last.
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch { console.log(`#${i + 1}  [unparseable line]`); return; }
    const g = e.git ? `${(e.git.commit || "").slice(0, 8)}${e.git.dirty ? "+dirty" : ""}` : "no-repo";
    const dur = e.durationMs == null ? "-" : `${e.durationMs}ms`;
    const ex = e.exitCode == null ? "no-run" : `exit=${e.exitCode}`;
    console.log(`#${i + 1}  ${e.ts}  ${ex}  ${dur}  git=${g}`);
    console.log(`     cmd: ${e.cmd}`);
    console.log(`     node=${e.versions ? e.versions.node : "?"} python=${e.versions ? e.versions.python || "MISSING" : "?"}`);
    for (const [p, h] of Object.entries(e.in || {})) console.log(`     in  ${p}  ${h ? h.slice(0, 12) : "(absent)"}`);
    for (const [p, h] of Object.entries(e.out || {})) console.log(`     out ${p}  ${h ? h.slice(0, 12) : "(absent)"}`);
    if (e.note) console.log(`     note: ${e.note}`);
  });
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves both directions in a throwaway dir: a SUCCESSFUL run records exit 0, a
// FAILING run records non-zero, --no-run records null; and two identical runs
// produce identical in/out hashes with every field present. ENV GOTCHA (Windows
// scar tissue): do NOT drive the run through `node -e "<quoted code>"` on PS 5.1
// (mangled quoting + 0-byte junk files) — point --cmd at a real temp .js.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-log-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  const readEntries = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  try {
    // fixed input; a deterministic command that writes fixed output.
    fs.writeFileSync(path.join(root, "in.txt"), "input-payload\n");
    const gen = path.join(root, "gen.js");
    fs.writeFileSync(gen, 'require("fs").writeFileSync(require("path").join(__dirname,"out.txt"),"output-payload\\n");\n');
    const genCmd = `node "${gen}"`;
    const logFile = path.join(root, "experiments.jsonl");
    const base = { file: logFile, in: "in.txt", out: "out.txt", note: "canary", noRun: false };

    // (a) log the SAME deterministic run twice
    check(cmdLog(root, { ...base, cmd: genCmd }) === 0, "log run #1 -> 0");
    check(cmdLog(root, { ...base, cmd: genCmd }) === 0, "log run #2 -> 0");

    const e = readEntries(logFile);
    check(e.length === 2, "exactly two JSONL lines (append-only)");

    // every required field present in every entry
    const fields = ["ts", "cwd", "cmd", "exitCode", "durationMs", "git", "versions", "in", "out", "note"];
    check(e.every((x) => fields.every((k) => k in x)), "all fields present in every entry");
    check(e.every((x) => x.versions && "node" in x.versions && "python" in x.versions), "versions has node + python");

    // identical in/out hashes across the two runs
    check(e[0].in["in.txt"] === e[1].in["in.txt"] && e[0].in["in.txt"] !== null, "input hash identical + non-null across runs");
    check(e[0].out["out.txt"] === e[1].out["out.txt"] && e[0].out["out.txt"] !== null, "output hash identical + non-null across runs");
    // input hash actually matches the file bytes
    check(e[0].in["in.txt"] === sha256File(path.join(root, "in.txt")), "input hash matches file bytes");
    // hash CORRECTNESS pinned independently of sha256File (verifier finding #2):
    // the fixed input "input-payload\n" has a known sha256. Asserting the recorded
    // hash equals that LITERAL (and is 64 hex chars) fails any broken/constant
    // hash impl that would otherwise pass the circular "matches file bytes" check.
    const KNOWN_SHA = "9a0ea859f16e1725a335d0fac4cd8c0236e921d3cf1e5290f5a84b12acb89433";
    check(e[0].in["in.txt"] === KNOWN_SHA, "input hash == precomputed sha256 of fixed payload");
    check(/^[0-9a-f]{64}$/.test(e[0].in["in.txt"] || ""), "input hash is 64 lowercase hex chars");

    // successful run recorded exit 0, with a numeric duration and no repo here
    check(e[0].exitCode === 0 && typeof e[0].durationMs === "number", "success run -> exit 0 + numeric duration");
    check(e[0].git === null, "git null outside a repo");

    // (b) FAILING run recorded as non-zero (the detect direction)
    const failGen = path.join(root, "fail.js");
    fs.writeFileSync(failGen, "process.exit(3);\n");
    check(cmdLog(root, { ...base, cmd: `node "${failGen}"`, note: "fail" }) === 0, "log failing run -> 0");
    const eFail = readEntries(logFile);
    check(eFail.length === 3, "append-only: third line added");
    check(eFail[2].exitCode === 3, "failing run recorded exitCode 3");

    // (c) --no-run records provenance with null exit/duration, still appends
    check(cmdLog(root, { ...base, cmd: genCmd, noRun: true, note: "norun" }) === 0, "log --no-run -> 0");
    const eNo = readEntries(logFile);
    check(eNo.length === 4 && eNo[3].exitCode === null && eNo[3].durationMs === null, "--no-run: null exit + duration, appended");
    // first line never rewritten
    check(eNo[0].ts === e[0].ts && eNo[0].out["out.txt"] === e[0].out["out.txt"], "first entry unchanged (append-only)");

    // missing --cmd is a usage error
    check(cmdLog(root, { ...base, cmd: null }) === 2, "missing --cmd -> exit 2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `experiment-log — reproducibility provenance for a run (append-only JSONL).

Usage:
  node experiment-log.js log --cmd "<command>" [--in a,b] [--out c,d] [--note "..."] [--file <path>] [--no-run]
  node experiment-log.js show [--file <path>]
  node experiment-log.js --canary
  node experiment-log.js --help

Each log appends ONE JSON line: ISO ts, cwd, cmd, exitCode, durationMs,
git {commit, dirty}, versions {node, python}, sha256 of every --in (before the
run) and --out (after), note. --no-run records without executing. Default log
file: ${DEFAULT_FILE} (in cwd). The file is only appended, never rewritten.

This is machine provenance — it never writes to HANDOFF.md or the project record.

Exit codes: 0 ok · 1 nothing-to-show / canary-fail · 2 usage error.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(HELP); process.exit(argv.length === 0 ? 2 : 0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const sub = argv[0];
  const file = getOpt(argv, "--file") || DEFAULT_FILE;

  if (sub === "log") {
    process.exit(cmdLog(process.cwd(), {
      cmd: getOpt(argv, "--cmd"),
      in: getOpt(argv, "--in"),
      out: getOpt(argv, "--out"),
      note: getOpt(argv, "--note"),
      file,
      noRun: argv.includes("--no-run"),
    }));
  }
  if (sub === "show") process.exit(cmdShow(process.cwd(), { file }));

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
