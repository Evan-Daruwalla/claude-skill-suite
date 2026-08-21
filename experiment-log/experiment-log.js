#!/usr/bin/env node
/*
 * experiment-log — reproducibility provenance for a run. Runs a command, then
 * appends ONE JSON line capturing everything needed to reproduce it later:
 * ISO timestamp, cwd, cmd, exitCode, durationMs, git {commit, dirty} of the cwd
 * repo, tool versions {node, python, pythonRun}, and the sha256 of every declared input
 * (captured BEFORE the run) and output (after). Append-only — the log is never
 * rewritten.
 *
 * This is MACHINE provenance, deliberately separate from the project's narrative
 * docs: it never touches HANDOFF.md or the append-only record (project-memory
 * owns those). A logged run answers "what exact inputs/code/versions produced
 * this result?" so the result is reproducible.
 *
 *   log --cmd "<command>" [--in a,b] [--out c,d] [--note "..."] [--file <path>]
 *       [--python <path>] [--no-run]
 *   show [--file <path>]     pretty-print entries, oldest-first (newest last)
 *   --canary                 self-test (the done-check); both directions
 *
 * versions records TWO pythons: `python` is bare `python` from PATH (what this
 * tool has always recorded), `pythonRun` is the interpreter that ACTUALLY ran the
 * command -- taken from --python, else parsed off the front of --cmd, else null.
 * They differ whenever a run goes through a venv, and only `pythonRun` is the one
 * a reproduction has to match.
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
// sha256 of a file's bytes. null ONLY when the file does not exist; any other
// failure records `unreadable:<CODE>`. Collapsing both into null made three
// different situations identical in the log — never declared, absent, and
// present-but-unreadable (EACCES, or EBUSY on a locked SQLite file, which is
// this skill's own worked example) — while SKILL.md claimed hashes are "never
// faked". "Absent" is a fact about the world; "I could not read it" is a fact
// about the run, and only one of them means the input wasn't there.
function sha256File(fp) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex"); }
  catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
    return `unreadable:${(e && e.code) || "ERR"}`;
  }
}

// { path: sha256|null|"unreadable:CODE" } for a list of declared files, relative
// to cwd. Order and keys are preserved so the same --in across runs produces the
// same object.
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
  // `:/` = the whole repo, from its root, regardless of cwd. The pathspec used
  // to be `.`, which scopes to cwd: the SAME commit at the SAME instant reported
  // dirty:false from a subdirectory and dirty:true from the repo root. `dirty`
  // is the one field that decides whether a run is reproducible, so a
  // cwd-dependent answer is worse than no answer. `,top` makes the exclude path
  // repo-root-relative to match.
  const args = ["status", "--porcelain"];
  if (logFile) {
    // The exclude path is built from cwd + git's OWN --show-prefix, never by
    // comparing two absolute paths: on Windows `--show-toplevel` can return a
    // directory's LONG form while this process knows it by its 8.3 short form,
    // and path.relative then produces a `../..`-laden path that silently
    // disables the exclusion.
    const pre = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd, encoding: "utf8" });
    const prefix = pre.status === 0 ? pre.stdout.trim() : "";      // "" at the repo root
    const relCwd = path.relative(cwd, logFile).split(path.sep).join("/");
    const joined = relCwd ? path.posix.normalize(prefix + relCwd) : "";
    if (joined && !joined.startsWith("../")) args.push("--", ":/", `:(exclude,top)${joined}`);
    else args.push("--", ":/");
  } else {
    args.push("--", ":/");
  }
  let st = spawnSync("git", args, { cwd, encoding: "utf8" });
  // A log file OUTSIDE the repo makes that pathspec fatal ("... is outside
  // repository"), and a FAILED status must never be read as a clean tree: before
  // this fallback, `--file <somewhere-else>` recorded dirty:false on a visibly
  // dirty tree. Retry unfiltered — an out-of-repo log can't flip the flag anyway.
  if (st.status !== 0 && args.length > 2) st = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return { commit: rev.stdout.trim(), dirty: st.status === 0 && st.stdout.trim().length > 0 };
}

// `<bin> --version`, run from the same cwd as the experiment so a relative
// interpreter path resolves the same way; null when the binary won't run
// (reported missing, not faked).
function probeVersion(bin, cwd) {
  const r = spawnSync(bin, ["--version"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr || "").trim() || null : null;
}

// The first token of `cmd` when it names a python interpreter, else null.
// Deliberately conservative -- ONLY the first token, so `cd x && python y.py`
// yields null (recorded unknown) instead of a guess.
function parsePythonFromCmd(cmd) {
  const s = String(cmd || "").trim();
  if (!s) return null;
  const tok = s[0] === '"' ? s.slice(1).split('"')[0] : s.split(/\s/)[0];
  if (!tok) return null;
  const base = tok.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  return base === "py" || /^pythonw?(3(\.\d+)*)?$/.test(base) ? tok : null;
}

// tool versions. `python` = bare `python` from PATH (unchanged meaning, kept so
// old lines stay comparable). `pythonRun` = the interpreter that actually ran the
// command, which is the one a reproduction must match: PATH python is a DIFFERENT
// install whenever the command goes through a venv (measured on a real project
// 2026-08-19: 87 logged lines recorded PATH's 3.14.4 while every producer ran
// under .venv's 3.12.10). Declared > parsed > null; never guessed.
function toolVersions(cmd, declared, cwd) {
  const ran = declared || parsePythonFromCmd(cmd);
  return {
    node: process.version,
    python: probeVersion("python", cwd),
    pythonRun: ran ? { path: ran, version: probeVersion(ran, cwd), source: declared ? "flag" : "cmd" } : null,
  };
}

// Resolve declared --in/--out values into a file list.
//
// A comma is ambiguous: it separates two files, or it is part of ONE filename.
// Splitting unconditionally meant `--in "data,v2.csv"` recorded
// {"data":null,"v2.csv":null} — the log ASSERTING that the declared input did
// not exist — while the real file hashed fine. The ambiguity is resolved by
// asking the filesystem and preferring the reading under which the declared
// file actually exists. Deterministic, and it can only ever turn a false
// "missing" into a real hash, never the reverse.
//
// --in / --out are also repeatable, which sidesteps the question entirely.
function resolveDeclared(v, cwd) {
  const vals = Array.isArray(v) ? v : (v == null ? [] : [v]);
  const out = [];
  for (const one of vals) {
    const s = String(one).trim();
    if (!s) continue;
    if (!s.includes(",")) { out.push(s); continue; }
    const abs = path.isAbsolute(s) ? s : path.join(cwd, s);
    if (fs.existsSync(abs)) { out.push(s); continue; }        // one comma-named file
    out.push(...s.split(",").map((x) => x.trim()).filter(Boolean));
  }
  return out;
}

// ---- commands --------------------------------------------------------------
function cmdLog(cwd, opts) {
  if (!opts.cmd) { console.error('error: log needs --cmd "<command>"'); return 2; }
  const file = path.isAbsolute(opts.file) ? opts.file : path.join(cwd, opts.file);

  // inputs hashed BEFORE the run so the recorded hash is the state the run saw.
  const inHashes = hashList(resolveDeclared(opts.in, cwd), cwd);
  const git = gitInfo(cwd, file);
  const versions = toolVersions(opts.cmd, opts.python, cwd);

  let exitCode = null, durationMs = null;
  if (!opts.noRun) {
    const start = Date.now();
    const r = spawnSync(opts.cmd, { shell: true, cwd, stdio: "inherit" });
    durationMs = Date.now() - start;
    // signal-killed => status null; record -1 so a crash is still a value.
    exitCode = r.status == null ? -1 : r.status;
  }

  // outputs hashed AFTER the run.
  const outHashes = hashList(resolveDeclared(opts.out, cwd), cwd);

  const entry = {
    // Stamped when the entry is WRITTEN, i.e. after the command finished, so a
    // 3-second run starting 05:02:11Z records 05:02:14Z. `durationMs` gives you
    // the other end. Documented here because neither doc said which end it was.
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
  // Repair a torn trailing line before appending. A crash mid-write leaves the
  // last line without its newline, and the next append then fuses the two into
  // one unparseable line — DESTROYING a legitimate prior entry, in a file whose
  // whole point is append-only provenance. decision-log.js already did this.
  try {
    if (fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (st.size > 0) {
        const fd = fs.openSync(file, "r");
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st.size - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) fs.appendFileSync(file, "\n");
      }
    }
  } catch (_) { /* a repair we cannot make must not block the log line itself */ }
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  const tag = opts.noRun ? "recorded (no-run)" : `exit=${exitCode} ${durationMs}ms`;
  console.log(`LOGGED ${tag} -> ${path.relative(cwd, file) || opts.file}`);
  return 0;
}

function cmdShow(cwd, opts) {
  const file = path.isAbsolute(opts.file) ? opts.file : path.join(cwd, opts.file);
  if (!fs.existsSync(file)) { console.error(`error: no log file '${opts.file}'`); return 1; }
  // Strip a leading BOM: a log file that picked one up (an editor save, a
  // PowerShell redirect) made the FIRST entry print as "[unparseable line]"
  // forever, because \uFEFF is not JSON whitespace.
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split("\n").filter((l) => l.trim());
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
    console.log(`     node=${e.versions ? e.versions.node : "?"} python(PATH)=${e.versions ? e.versions.python || "MISSING" : "?"}`);
    const pr = e.versions && e.versions.pythonRun;
    if (pr) console.log(`     ran under: ${pr.version || "UNPROBEABLE"}  (${pr.path}, from --${pr.source === "flag" ? "python" : "cmd"})`);
    for (const [p, h] of Object.entries(e.in || {})) console.log(`     in  ${p}  ${h ? h.slice(0, 12) : "(absent)"}`);
    for (const [p, h] of Object.entries(e.out || {})) console.log(`     out ${p}  ${h ? h.slice(0, 12) : "(absent)"}`);
    if (e.note) console.log(`     note: ${e.note}`);
  });
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves both directions in a throwaway dir: a SUCCESSFUL run records exit 0, a
// FAILING run records non-zero, --no-run records null; and two identical runs
// produce identical in/out hashes with every field present. ENV GOTCHA
// (Windows scar tissue): do NOT drive the run through `node -e "<quoted code>"` on PS 5.1
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

    // (d) pythonRun: the interpreter that ACTUALLY ran, not whatever `python`
    // PATH happens to point at (the 2026-08-19 defect). Parser first, as a table.
    const PARSE = [
      [".venv\\Scripts\\python.exe src/x.py --n 5", ".venv\\Scripts\\python.exe"],
      [".venv/Scripts/python.exe src/x.py", ".venv/Scripts/python.exe"],
      ['"C:/prog files/py/python.exe" x.py', "C:/prog files/py/python.exe"],
      ["python3 -m pkg", "python3"],
      ["python3.12 x.py", "python3.12"],
      ["pythonw x.py", "pythonw"],
      ["py -3.12 x.py", "py"],
      ['node "x.js"', null],
      ["pytest -q", null],
      ["cd sub && python x.py", null],
      ["", null],
    ];
    for (const [c, want] of PARSE) check(parsePythonFromCmd(c) === want, `parse ${JSON.stringify(c)} -> ${want}`);

    // a non-python command records null, never a guess
    check(e[0].versions.pythonRun === null, "non-python cmd -> pythonRun null");
    // --python probes the DECLARED binary end-to-end. node stands in for python
    // so the canary stays hermetic (no python install required) while still
    // proving the recorded version comes from the declared binary, not PATH.
    check(cmdLog(root, { ...base, cmd: genCmd, python: process.execPath, note: "declared" }) === 0, "log --python -> 0");
    const prDecl = readEntries(logFile).pop().versions.pythonRun;
    check(prDecl && prDecl.source === "flag" && prDecl.path === process.execPath && prDecl.version === process.version,
      "--python records the declared binary's own version");
    // an interpreter that won't run is null, never faked
    check(cmdLog(root, { ...base, cmd: genCmd, python: path.join(root, "no-such-python.exe"), note: "absent" }) === 0, "log --python absent -> 0");
    const prAbs = readEntries(logFile).pop().versions.pythonRun;
    check(prAbs && prAbs.version === null, "unprobeable interpreter -> version null (never faked)");
    // PATH python still recorded under its old key, so old lines stay comparable
    check(readEntries(logFile).every((x) => "python" in x.versions && "pythonRun" in x.versions), "every entry has python + pythonRun");

    // (e) git.dirty must never read a FAILED `git status` as "clean tree". Needs a
    // real repo, so one is built here; the checks run inside it, not in `root`.
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "canary@example.invalid");
    git("config", "user.name", "canary");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "v1\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const inLog = path.join(repo, "experiments.jsonl");
    const outLog = path.join(root, "outside.jsonl"); // deliberately OUTSIDE the repo
    const rec = (f, note) => { cmdLog(repo, { file: f, in: "", out: "", note, noRun: true, cmd: "echo hi" }); return readEntries(f).pop().git; };
    // Ordered so each check has exactly ONE possible source of dirt: the in-repo
    // log is not created until the out-of-repo pair is done, or its own untracked
    // presence would be the thing making the tree dirty.
    check(rec(outLog, "clean-out").dirty === false, "clean tree + out-of-repo log -> dirty false");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "v2\n");
    // THE FIX: this pathspec is rejected by git ("outside repository"), and the
    // rejection used to be recorded as a clean tree.
    check(rec(outLog, "dirty-out").dirty === true, "DIRTY tree + out-of-repo log -> dirty true (git error not swallowed)");
    git("checkout", "--", "tracked.txt"); // back to clean
    // clean tree: the log file's own presence must not flip dirty (verifier finding #1)
    rec(inLog, "clean-1");
    check(rec(inLog, "clean-2").dirty === false, "clean tree + in-repo log -> dirty false on the 2nd run");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "v2\n");
    check(rec(inLog, "dirty-in").dirty === true, "DIRTY tree + in-repo log -> dirty true (exclusion hides only the log)");

    // missing --cmd is a usage error
    check(cmdLog(root, { ...base, cmd: null }) === 2, "missing --cmd -> exit 2");

    // ---- 2026-08-20 audit ----------------------------------------------
    // (i) `dirty` must not depend on WHERE you ran from. Same commit, same
    //     instant, different answer from a subdirectory was the defect: it is
    //     the one field that decides whether a run is reproducible.
    fs.writeFileSync(path.join(repo, "tracked.txt"), "v3\n");     // dirty at the ROOT
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const subLog = path.join(sub, "experiments.jsonl");
    cmdLog(sub, { file: subLog, in: "", out: "", note: "from-sub", noRun: true, cmd: "echo hi" });
    const fromSub = readEntries(subLog).pop().git;
    const fromRoot = rec(inLog, "from-root");
    check(fromSub.dirty === true, "root-level dirt is visible from a SUBDIRECTORY");
    check(fromSub.dirty === fromRoot.dirty, "dirty is the same from cwd=repo and cwd=repo/sub");
    fs.rmSync(sub, { recursive: true, force: true });
    git("checkout", "--", "tracked.txt");

    // (ii) A flag NAME sitting where a flag's VALUE belongs is now a USAGE
    //      ERROR, never a silently-adopted mode. Before, `argv.includes()` ran
    //      before dispatch and `getOpt` scanned all of argv, so:
    //        --note "--canary"  printed CANARY PASS 40/40, exit 0, wrote nothing
    //        --note "--no-run"  skipped a run the caller asked to execute
    //        --note "--file" --cmd X   wrote the log to a file named "--cmd"
    //      Run out-of-process: a usage error exits the process by design.
    const cli = (args) => spawnSync(process.execPath, [__filename].concat(args), { cwd: root, encoding: "utf8" });
    const rCan = cli(["log", "--cmd", "echo hi", "--note", "--canary"]);
    check(rCan.status === 2, `--note "--canary" is a usage error (exit ${rCan.status})`);
    check(!String(rCan.stdout).includes("CANARY PASS"), "--note \"--canary\" does not run the self-test");
    const rNo = cli(["log", "--cmd", "echo hi", "--note", "--no-run"]);
    check(rNo.status === 2, `--note "--no-run" is a usage error (exit ${rNo.status})`);
    const rFile = cli(["log", "--note", "--file", "--cmd", "echo hi"]);
    check(rFile.status === 2, `a missing --note value is a usage error (exit ${rFile.status})`);
    check(!fs.existsSync(path.join(root, "--cmd")), "no file named '--cmd' was created");
    // A value that merely starts with '-' but names no flag is still a value.
    const pd = parseArgs(["log", "--note", "-x", "--cmd", "echo hi"]);
    check(pd.opts.note === "-x" && pd.opts.cmd === "echo hi", "a '-'-leading note does not swallow the next flag");

    // (iii) a filename containing a comma is one file, not two missing ones
    const commaName = "data,v2.csv";
    fs.writeFileSync(path.join(root, commaName), "x\n");
    check(resolveDeclared(commaName, root).length === 1, "an existing comma-NAMED file is one entry, not two");
    check(resolveDeclared("a.csv,b.csv", root).length === 2, "a comma between two non-existent names still separates");
    check(resolveDeclared(["a.csv", commaName], root).length === 2, "repeated --in values are each taken whole");
    const hc = hashList(resolveDeclared(commaName, root), root);
    check(hc[commaName] && hc[commaName].length === 64, "the comma-named file actually hashes");

    // (iv) unreadable != absent
    check(sha256File(path.join(root, "definitely-not-here.txt")) === null, "an absent file hashes to null");
    const dirAsFile = sha256File(root);
    check(typeof dirAsFile === "string" && dirAsFile.startsWith("unreadable:"),
      "an unreadable path records unreadable:CODE, not null");

    // (v) a torn last line must not destroy the entry before it
    const tornLog = path.join(root, "torn.jsonl");
    fs.writeFileSync(tornLog, JSON.stringify({ ts: "t", cmd: "first", note: "keep me" }));  // NO newline
    cmdLog(root, { file: tornLog, in: "", out: "", note: "after-torn", noRun: true, cmd: "echo hi" });
    const tornLines = fs.readFileSync(tornLog, "utf8").split("\n").filter((l) => l.trim());
    check(tornLines.length === 2, `a torn trailing line is repaired, not fused (got ${tornLines.length} lines)`);
    check(tornLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
      "both lines still parse after the repair");

    // (vi) a BOM must not make entry #1 permanently unreadable
    const bomLog = path.join(root, "bom.jsonl");
    fs.writeFileSync(bomLog, "\uFEFF" + JSON.stringify({ ts: "t", cmd: "x", git: null }) + "\n");
    check(cmdShow(root, { file: bomLog }) === 0, "a BOM at the head of the log does not break show");
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
  node experiment-log.js log --cmd "<command>" [--in a,b] [--out c,d] [--note "..."] [--file <path>] [--python <path>] [--no-run]
  node experiment-log.js show [--file <path>]
  node experiment-log.js --canary
  node experiment-log.js --help

Each log appends ONE JSON line: ISO ts, cwd, cmd, exitCode, durationMs,
git {commit, dirty}, versions {node, python, pythonRun}, sha256 of every --in
(before the run) and --out (after), note. 'python' is bare 'python' from PATH;
'pythonRun' is the interpreter that ACTUALLY ran (--python if given, else parsed
off the front of --cmd, else null) -- through a venv these differ, and pythonRun
is the one a reproduction has to match. --no-run records without executing.
Default log file: ${DEFAULT_FILE} (in cwd). Only appended, never rewritten.

This is machine provenance — it never writes to HANDOFF.md or the project record.

Exit codes: 0 ok · 1 nothing-to-show / canary-fail · 2 usage error.`;

// Every flag this script understands. Needed in two places: to tell a MODE flag
// in a real position from the same string appearing as a flag's VALUE, and to
// tell a missing value from a value that merely starts with `--`.
const KNOWN_FLAGS = new Set([
  "--file", "--cmd", "--in", "--out", "--note", "--python",
  "--canary", "--no-run", "--help", "-h",
]);

// `indexOf` scans the WHOLE argv, so `--note "--file" --cmd "node gen.js"`
// found "--file" as the note's value and then, scanning again for --file,
// matched that same token and wrote the provenance log to a file named
// "--cmd". Values are consumed positionally instead, left to right.
function parseArgs(argv) {
  const opts = {};
  const flags = new Set();
  const positional = [];
  const VALUE_FLAGS = new Set(["--file", "--cmd", "--in", "--out", "--note", "--python"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = i + 1 < argv.length ? argv[i + 1] : null;
      if (v === null || KNOWN_FLAGS.has(v)) {
        console.error(`error: ${a} requires a value`);
        process.exit(2);
      }
      // Only the file LISTS repeat; every other flag takes the last value,
      // which is what a single-valued flag given twice has always meant here.
      const key = a.slice(2);
      const repeatable = key === "in" || key === "out";
      if (!repeatable) opts[key] = v;
      else if (opts[key] === undefined) opts[key] = v;
      else if (Array.isArray(opts[key])) opts[key].push(v);
      else opts[key] = [opts[key], v];
      i++;                       // consume the value so it can never be re-read
    } else if (a.startsWith("-")) {
      flags.add(a);
    } else {
      positional.push(a);
    }
  }
  return { opts, flags, positional };
}

function main() {
  const argv = process.argv.slice(2);
  // A mode flag is only honoured in a position that is NOT a flag's value.
  // `argv.includes("--canary")` let `--note "--canary"` print CANARY PASS 40/40
  // and exit 0 having run nothing and written nothing, and `--note "--no-run"`
  // silently skipped a run the caller asked for.
  const { opts, flags } = parseArgs(argv);
  if (flags.has("--help") || flags.has("-h") || argv.length === 0) { console.log(HELP); process.exit(argv.length === 0 ? 2 : 0); }
  if (flags.has("--canary")) process.exit(runCanary());

  const sub = argv[0];
  const file = opts.file || DEFAULT_FILE;

  if (sub === "log") {
    process.exit(cmdLog(process.cwd(), {
      cmd: opts.cmd,
      in: opts.in,
      out: opts.out,
      note: opts.note,
      python: opts.python,
      file,
      noRun: flags.has("--no-run"),
    }));
  }
  if (sub === "show") process.exit(cmdShow(process.cwd(), { file }));

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
