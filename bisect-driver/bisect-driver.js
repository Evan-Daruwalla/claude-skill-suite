#!/usr/bin/env node
/*
 * bisect-driver — automate git bisect to find the commit that introduced a
 * behavior change. Give it a KNOWN-good ref, a bad ref (default HEAD), and a
 * repro command; it drives `git bisect run`, parses the culprit, and ALWAYS
 * resets the bisect state so your repo is left exactly where it started.
 *
 * This is also the catalog's "regression-blame" — same operation: which commit
 * first made the repro fail.
 *
 *   --good <ref> [--bad <ref>=HEAD] --cmd "<repro command>" [--dir <repo>]
 *   --canary   self-test (the done-check); both directions, throwaway repo
 *
 * The repro command is handed to `git bisect run sh -c "<cmd>"` at each step.
 * git bisect run reads its EXIT CODE:
 *     0            -> commit is GOOD
 *     1-124        -> commit is BAD   (avoid 126/127: shell-reserved)
 *     125          -> SKIP (source can't be tested here)
 *     >=128        -> ABORT the bisect
 * So write the repro to exit 0 when the behavior is still correct and non-zero
 * when it is broken.
 *
 * Preflight refuses (exit 2) on a dirty working tree or an in-progress bisect —
 * bisect checks out historic commits during the run and would clobber
 * uncommitted work. It ALSO verifies the endpoints (git never re-tests the
 * marked good/bad refs): the --good ref must exit 0 and --bad must exit 1-124,
 * else a broken repro would produce a silent false positive.
 *
 * Exit codes: 0 culprit found · 1 no culprit / bisect error · 2 usage / preflight.
 * Zero dependencies, Node >=16. Read-only toward the world; only touches the
 * target repo's bisect state, which it always restores.
 */
"use strict";
const { spawnSync } = require("child_process");

// ---- helpers ---------------------------------------------------------------
// One git invocation. Args passed as an array (no outer shell) so nothing needs
// quoting at the Node level. Returns { code, out } with out = stdout+stderr.
function git(dir, args, allowFail) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`git could not launch (${r.error.message}) — is git on PATH?`);
  const out = (r.stdout || "") + (r.stderr || "");
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${out.trim()}`);
  return { code: r.status == null ? -1 : r.status, out };
}

function isRepo(dir) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 && String(r.stdout).trim() === "true";
}

// dirty = any tracked modification OR untracked file — a bisect checkout can
// clobber it, so we refuse rather than risk the user's uncommitted work.
function isDirty(dir) {
  return git(dir, ["status", "--porcelain"], true).out.trim().length > 0;
}

function bisectInProgress(dir) {
  // BISECT_LOG lives in the git dir only while a bisect is active.
  const p = git(dir, ["rev-parse", "--git-path", "BISECT_LOG"], true).out.trim();
  if (!p) return false;
  const path = require("path");
  const fs = require("fs");
  const abs = path.isAbsolute(p) ? p : path.join(dir, p);
  return fs.existsSync(abs);
}

// original position, to restore to and to verify against afterward.
function currentHead(dir) {
  const b = git(dir, ["symbolic-ref", "-q", "--short", "HEAD"], true).out.trim();
  if (b) return { branch: b, sha: git(dir, ["rev-parse", "HEAD"], true).out.trim() };
  return { branch: null, sha: git(dir, ["rev-parse", "HEAD"], true).out.trim() }; // detached
}

function resolves(dir, ref) {
  return git(dir, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], true).code === 0;
}

// Check out `ref` (detached) and run the repro exactly as `git bisect run` would
// — `sh -c "<cmd>"` at cwd = repo — returning its exit code. Used to verify the
// marked endpoints before starting, since git itself never re-tests them.
function testRefExit(dir, ref, cmd) {
  git(dir, ["checkout", "-q", "--detach", ref + "^{commit}"]);
  const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`could not launch repro via sh -c (${r.error.message}) — is 'sh' on PATH? (Git for Windows ships it)`);
  return r.status == null ? -1 : r.status;
}

function restoreHead(dir, orig) {
  git(dir, ["checkout", "-q", orig.branch || orig.sha], true);
}

// ---- the operation ---------------------------------------------------------
// Returns { code, culprit, subject, authorDate, error }. ALWAYS resets bisect
// state in a finally. Never throws to the caller.
function bisect(opts) {
  const dir = opts.dir;
  // --- preflight (all exit 2) ---
  if (!isRepo(dir)) return { code: 2, error: `not a git repository: ${dir}` };
  if (!opts.good) return { code: 2, error: `missing --good <ref> (a commit known to still work)` };
  if (!opts.cmd) return { code: 2, error: `missing --cmd "<repro command>"` };
  const bad = opts.bad || "HEAD";
  if (!resolves(dir, opts.good)) return { code: 2, error: `--good ref does not resolve: ${opts.good}` };
  if (!resolves(dir, bad)) return { code: 2, error: `--bad ref does not resolve: ${bad}` };
  if (bisectInProgress(dir)) return { code: 2, error: `a bisect is already in progress here — run 'git bisect reset' first` };
  if (isDirty(dir)) return { code: 2, error: `working tree is dirty — commit, stash, or clean before bisecting (bisect checks out historic commits and would clobber uncommitted work)` };

  const orig = currentHead(dir);

  // --- endpoint verification (exit 2) ---
  // git bisect TRUSTS the marked --good/--bad refs and never re-tests them, so a
  // repro that misclassifies the endpoints (wrong path, missing script, always
  // exit 0, always non-zero) yields a confident but false culprit with no error.
  // Test the endpoints ourselves up front and refuse on a contradiction, turning
  // that silent false positive into a loud, actionable refusal. We run this on a
  // clean tree (dirty was already refused) and always restore HEAD.
  // Resolve to concrete shas BEFORE any checkout — testing an endpoint detaches
  // HEAD, so a symbolic ref like the default --bad=HEAD would otherwise re-resolve
  // to the just-checked-out good commit.
  const goodSha = git(dir, ["rev-parse", opts.good + "^{commit}"], true).out.trim();
  const badSha = git(dir, ["rev-parse", bad + "^{commit}"], true).out.trim();
  let ep;
  try {
    const goodExit = testRefExit(dir, goodSha, opts.cmd);
    const badExit = testRefExit(dir, badSha, opts.cmd);
    ep = { goodExit, badExit };
  } catch (e) {
    try { restoreHead(dir, orig); } catch (_) {}
    return { code: 2, error: e.message };
  }
  try { restoreHead(dir, orig); } catch (_) {}
  if (ep.goodExit !== 0)
    return { code: 2, error: `--good ref '${opts.good}' does NOT pass the repro (exit ${ep.goodExit}; a good ref must exit 0). Your repro classifies the good endpoint as bad — git would trust it as good without testing, giving a false culprit. Fix the repro (does it work on a historic checkout?) or pick a genuinely-good ref.` };
  if (ep.badExit === 0)
    return { code: 2, error: `--bad ref '${bad}' PASSES the repro (exit 0; a bad ref must exit non-zero). Your repro doesn't reproduce the failure at the bad endpoint — git would trust it as bad without testing, and report the bad ref itself as the culprit. Fix the repro so it exits non-zero on the broken behavior, or pick a genuinely-broken ref.` };
  if (ep.badExit < 1 || ep.badExit > 124)
    return { code: 2, error: `--bad ref '${bad}' returned exit ${ep.badExit} (must be 1-124 to signal 'bad'; 125=skip, >=128=abort). Your repro doesn't cleanly classify the bad endpoint — fix it before bisecting.` };

  let culprit = null, err = null;
  // best-effort cleanup if the process is interrupted mid-run.
  const onSig = () => { try { git(dir, ["bisect", "reset"], true); } catch (_) {} process.exit(130); };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  try {
    git(dir, ["bisect", "start"]);
    git(dir, ["bisect", "bad", bad]);
    git(dir, ["bisect", "good", opts.good]);
    // git drives the loop: checkout -> sh -c "<cmd>" -> classify by exit code.
    const run = git(dir, ["bisect", "run", "sh", "-c", opts.cmd], true);
    const m = run.out.match(/([0-9a-f]{7,40}) is the first bad commit/);
    if (m) culprit = git(dir, ["rev-parse", m[1]], true).out.trim() || m[1];
    else err = `bisect did not identify a first bad commit — check the repro command classifies good/bad correctly:\n${run.out.trim().slice(-800)}`;
  } catch (e) {
    err = e.message;
  } finally {
    try { git(dir, ["bisect", "reset"], true); } catch (_) {}
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }

  // verify we are back where we started (informational — reset should have done it).
  const now = currentHead(dir);
  const restored = now.sha === orig.sha && now.branch === orig.branch;
  if (err) return { code: 1, error: err, restored };
  if (!culprit) return { code: 1, error: "no culprit parsed", restored };

  const info = git(dir, ["show", "-s", "--format=%s%n%ai", culprit], true).out.trim().split("\n");
  return { code: 0, culprit, subject: info[0] || "", authorDate: info[1] || "", restored };
}

// ---- canary: the self-test AND the done-check ------------------------------
// Builds a throwaway git repo (~8 commits) with a behavior change planted at a
// KNOWN middle commit, then proves: (good direction) the culprit is identified
// exactly and the repo is restored + bisect-state clean; (bad direction) a dirty
// tree and an in-progress bisect are both refused. NEVER touches any real repo.
function runCanary() {
  const os = require("os"), fs = require("fs"), path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bisect-driver-canary-"));
  const repo = path.join(root, "repo");
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  const g = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    fs.mkdirSync(repo);
    g(["init", "-q"]);
    g(["config", "user.email", "canary@example.com"]);
    g(["config", "user.name", "Canary"]);
    g(["config", "commit.gpgsign", "false"]);

    // repro script lives OUTSIDE the repo so historic checkouts never remove it.
    // It reads value.txt from cwd (git bisect run's cwd = repo): exit 0 while the
    // value is still "ok", exit 1 once it flips to "BAD".
    // value.txt holds "<state> <n>" — the trailing counter makes every commit a
    // real distinct commit (identical content would no-op the commit); the repro
    // keys only off the first token: exit 0 while "ok", exit 1 once "BAD".
    const repro = path.join(root, "repro.js");
    fs.writeFileSync(repro,
      'const fs=require("fs");' +
      'let v="";try{v=fs.readFileSync("value.txt","utf8").trim().split(" ")[0];}catch(e){process.exit(1);}' +
      'process.exit(v==="BAD"?1:0);\n');

    let goodSha = null, plantedSha = null;
    for (let i = 1; i <= 8; i++) {
      const val = i >= 4 ? "BAD" : "ok"; // behavior flips at commit 4
      fs.writeFileSync(path.join(repo, "value.txt"), val + " " + i + "\n");
      g(["add", "value.txt"]);
      g(["commit", "-q", "-m", `commit ${i}`]);
      const sha = g(["rev-parse", "HEAD"]).stdout.trim();
      if (i === 3) goodSha = sha;      // last good commit
      if (i === 4) plantedSha = sha;   // first bad commit = the culprit we expect
    }

    const before = g(["rev-parse", "HEAD"]).stdout.trim();
    const cmd = `node "${repro}"`;

    // (good direction) find the culprit, restored + clean
    const r = bisect({ dir: repo, good: goodSha, bad: "HEAD", cmd });
    check(r.code === 0, "clean run -> exit 0");
    check(r.culprit === plantedSha, `culprit == planted first-bad commit (got ${r.culprit && r.culprit.slice(0,8)}, want ${plantedSha && plantedSha.slice(0,8)})`);
    check(g(["rev-parse", "HEAD"]).stdout.trim() === before, "HEAD restored to original after run");
    check(!bisectInProgress(repo), "bisect state cleaned (no BISECT_LOG)");
    check(!!r.subject && !!r.authorDate, "culprit subject + author date reported");

    // (bad direction 1) in-progress bisect is refused
    g(["bisect", "start"]); g(["bisect", "bad", "HEAD"]); g(["bisect", "good", goodSha]);
    const rp = bisect({ dir: repo, good: goodSha, bad: "HEAD", cmd });
    check(rp.code === 2, "in-progress bisect refused -> exit 2");
    g(["bisect", "reset"]);

    // (bad direction 2) dirty working tree is refused
    fs.writeFileSync(path.join(repo, "value.txt"), "uncommitted change\n");
    const rd = bisect({ dir: repo, good: goodSha, bad: "HEAD", cmd });
    check(rd.code === 2, "dirty working tree refused -> exit 2");
    g(["checkout", "--", "value.txt"]);

    // (bad direction 3) unresolvable good ref -> exit 2
    const rr = bisect({ dir: repo, good: "no-such-ref", bad: "HEAD", cmd });
    check(rr.code === 2, "bad --good ref refused -> exit 2");

    // (bad direction 4) repro that never flips to bad (always exit 0): the --bad
    // endpoint passes, so git would falsely report the bad ref itself. Refused.
    const rok = bisect({ dir: repo, good: goodSha, bad: "HEAD", cmd: "exit 0" });
    check(rok.code === 2, "always-good repro (--bad passes) refused -> exit 2");
    check(g(["rev-parse", "HEAD"]).stdout.trim() === before, "HEAD restored after endpoint-verify refusal");

    // (bad direction 5) repro broken so the --good endpoint fails (always exit 1):
    // git would trust the good ref as good and report a false culprit. Refused.
    const rbad = bisect({ dir: repo, good: goodSha, bad: "HEAD", cmd: "exit 1" });
    check(rbad.code === 2, "always-bad repro (--good fails) refused -> exit 2");
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `bisect-driver — find the commit that introduced a behavior change (git bisect).

Usage:
  node bisect-driver.js --good <ref> [--bad <ref>] --cmd "<repro command>" [--dir <repo>]
  node bisect-driver.js --canary
  node bisect-driver.js --help

  --good <ref>   a commit where the behavior was still CORRECT (required)
  --bad  <ref>   a commit where it is BROKEN (default: HEAD)
  --cmd  "<...>" repro command, run per commit via 'git bisect run sh -c'.
                 EXIT 0 = good, 1-124 = bad, 125 = skip, >=128 = abort.
  --dir  <repo>  repo to bisect (default: current directory)

Preflight refuses (exit 2) on a dirty working tree, an in-progress bisect, or a
repro that misclassifies the endpoints (--good must exit 0, --bad must exit 1-124
— git trusts the marked refs and never re-tests them, so a broken repro would
otherwise yield a silent false positive).
The bisect state is ALWAYS reset afterward — your repo is left where it started.
Bisect checks out historic commits DURING the run; commit or stash first.

Exit codes: 0 culprit found · 1 no culprit / bisect error · 2 usage / preflight.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); process.exit(0); }
  if (argv.includes("--canary")) process.exit(runCanary());
  if (argv.length === 0) { console.log(HELP); process.exit(2); }

  const r = bisect({
    dir: getOpt(argv, "--dir") || process.cwd(),
    good: getOpt(argv, "--good"),
    bad: getOpt(argv, "--bad"),
    cmd: getOpt(argv, "--cmd"),
  });

  if (r.code === 2) { console.error("error: " + r.error); process.exit(2); }
  if (r.code === 1) {
    console.error("error: " + r.error);
    if (r.restored === false) console.error("WARNING: repo may not be back on its original HEAD — check 'git bisect reset' / 'git status'.");
    process.exit(1);
  }
  console.log(`CULPRIT ${r.culprit}`);
  console.log(`  subject: ${r.subject}`);
  console.log(`  author date: ${r.authorDate}`);
  if (r.restored === false) console.error("WARNING: repo may not be back on its original HEAD — check 'git status'.");
  process.exit(0);
}
main();
