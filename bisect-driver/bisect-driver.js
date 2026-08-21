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
 * Exit codes: 0 culprit found · 1 no culprit / bisect error · 2 usage / preflight
 * · 130 interrupted by a signal (NO result: an aborted search has not narrowed
 * anything). SIGTERM on Windows is delivered by TerminateProcess and cannot be
 * caught by any JS handler, so a `kill -TERM` can still leave bisect state
 * active and HEAD detached; the next run refuses on that state and names the fix.
 * Zero dependencies, Node >=16. Read-only toward the world; only touches the
 * target repo's bisect state, which it always restores.
 */
"use strict";
const { spawnSync } = require("child_process");

// ---- helpers ---------------------------------------------------------------
// A repro that never returns (infinite loop, a command waiting on stdin) used to
// block the driver forever with the repo left on a historic checkout. spawnSync
// blocks the event loop, so its own timeout is the only thing that can end it.
const GIT_TIMEOUT_MS = 30 * 60 * 1000;

// One git invocation. Args passed as an array (no outer shell) so nothing needs
// quoting at the Node level. Returns { code, out, signal } with out = stdout+stderr.
function git(dir, args, allowFail) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26, timeout: GIT_TIMEOUT_MS });
  if (r.error && r.error.code === "ETIMEDOUT") {
    throw new Error(`git ${args.join(" ")} exceeded the ${GIT_TIMEOUT_MS / 60000}-minute ceiling and was killed — does the repro command ever return?`);
  }
  if (r.error) throw new Error(`git could not launch (${r.error.message}) — is git on PATH?`);
  const out = (r.stdout || "") + (r.stderr || "");
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${out.trim()}`);
  // `signal` is the only SYNCHRONOUS evidence that a child was interrupted
  // rather than finished. A JS signal handler cannot help here: spawnSync blocks
  // the event loop, so the handler does not run until after the main path has
  // already parsed the output and printed a result. Measured 2026-08-20: a
  // SIGINT mid-run printed `CULPRIT <commit 5>` for a defect planted at commit
  // 4 — a specific, wrong, unhedged accusation — and then exited 130.
  return { code: r.status == null ? -1 : r.status, out, signal: r.signal || null };
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
  const r = spawnSync(shPath(), ["-c", cmd], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw new Error(`could not launch repro via sh -c (${r.error.message}) — is 'sh' on PATH? (Git for Windows ships it)`);
  return r.status == null ? -1 : r.status;
}

// `sh` is on PATH under Git Bash and NOT under PowerShell, which is this
// machine's primary shell. `git bisect run` needs it, so the whole canary suite's
// verdict depended on which shell launched it: 25/25 exit 0 from Git Bash,
// 24/25 exit 1 from PowerShell, on identical files — and every tally ever
// published was the Git Bash one. Resolve Git's own bundled sh.exe so the tool
// works from either, and fail with a NAMED reason rather than a raw ENOENT if
// neither is reachable.
let _shCache;
function shPath() {
  if (_shCache !== undefined) return _shCache;
  const probe = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
  if (!probe.error) return (_shCache = "sh");
  const path = require("path"), fs = require("fs");
  // `git --exec-path` -> <git>/mingw64/libexec/git-core; sh.exe lives at
  // <git>/usr/bin/sh.exe. Derive it rather than hardcoding an install path.
  const ep = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (ep.status === 0 && ep.stdout) {
    let d = ep.stdout.trim().replace(/\//g, path.sep);
    for (let i = 0; i < 6 && d; i++) {
      const cand = path.join(d, "usr", "bin", "sh.exe");
      if (fs.existsSync(cand)) return (_shCache = cand);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  return (_shCache = "sh");   // let the caller's error message name the problem
}

function restoreHead(dir, orig) {
  git(dir, ["checkout", "-q", orig.branch || orig.sha], true);
}

// Re-test the answer. git bisect never re-checks the classifications it made,
// so ONE bad classification anywhere in the search yields a confident, wrong,
// unhedged culprit — and `git bisect run` still exits 0 with no signal and no
// diagnostic. Measured 2026-08-20: a SIGINT during a run killed the repro's
// `sleep`, that one commit was misclassified, and the driver reported commit 6
// for a defect planted at commit 4. There is no synchronous evidence of the
// interruption to check; the only thing that survives it is the CLAIM, so the
// claim is what gets tested.
//
// A sound culprit satisfies both halves of what "first bad commit" means:
// the culprit is bad, and its parent is good. Costs two more repro runs, the
// same price the endpoint check already pays for the same reason.
function verifyCulprit(dir, culprit, cmd) {
  const parent = git(dir, ["rev-parse", "--verify", "--quiet", culprit + "^"], true).out.trim();
  const culpritExit = testRefExit(dir, culprit, cmd);
  const parentExit = parent ? testRefExit(dir, parent, cmd) : null;
  const badOk = culpritExit >= 1 && culpritExit <= 124;
  const goodOk = parent ? parentExit === 0 : true;
  return { ok: badOk && goodOk, culpritExit, parent, parentExit, badOk, goodOk };
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

  // Signal handlers are registered HERE, not after endpoint verification.
  // Endpoint verification runs the repro twice against historic checkouts, so a
  // signal during it used to hit no custom handler at all and leave the repo on
  // a detached HEAD — a wider window than the bisect run the old handler covered.
  let interrupted = null;
  const onSig = (sig) => {
    interrupted = sig;
    try { git(dir, ["bisect", "reset"], true); } catch (_) {}
    try { restoreHead(dir, orig); } catch (_) {}
    console.error(`\n${sig} received — bisect aborted, repo restored. NO result: an interrupted run has not narrowed anything.`);
    process.exit(130);
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  const clearSig = () => {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  };

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
    clearSig();
    return { code: 2, error: e.message };
  }
  try { restoreHead(dir, orig); } catch (_) {}
  if (ep.goodExit !== 0) { clearSig();
    return { code: 2, error: `--good ref '${opts.good}' does NOT pass the repro (exit ${ep.goodExit}; a good ref must exit 0). Your repro classifies the good endpoint as bad — git would trust it as good without testing, giving a false culprit. Fix the repro (does it work on a historic checkout?) or pick a genuinely-good ref.` }; }
  if (ep.badExit === 0) { clearSig();
    return { code: 2, error: `--bad ref '${bad}' PASSES the repro (exit 0; a bad ref must exit non-zero). Your repro doesn't reproduce the failure at the bad endpoint — git would trust it as bad without testing, and report the bad ref itself as the culprit. Fix the repro so it exits non-zero on the broken behavior, or pick a genuinely-broken ref.` }; }
  if (ep.badExit < 1 || ep.badExit > 124) { clearSig();
    return { code: 2, error: `--bad ref '${bad}' returned exit ${ep.badExit} (must be 1-124 to signal 'bad'; 125=skip, >=128=abort). Your repro doesn't cleanly classify the bad endpoint — fix it before bisecting.` }; }

  let culprit = null, err = null, aborted = null;
  try {
    git(dir, ["bisect", "start"]);
    git(dir, ["bisect", "bad", bad]);
    git(dir, ["bisect", "good", opts.good]);
    // git drives the loop: checkout -> sh -c "<cmd>" -> classify by exit code.
    // shPath(), not the bare "sh" — same reason as testRefExit: under PowerShell
    // there is no `sh` on PATH and git bisect run cannot classify anything.
    const run = git(dir, ["bisect", "run", shPath(), "-c", opts.cmd], true);
    // A signal reaches the whole process group, so `git bisect run` dies too and
    // spawnSync returns a PARTIAL transcript. That transcript can still contain
    // a "first bad commit" line from a search that never finished — measured
    // 2026-08-20: an interrupted run named commit 5 for a defect at commit 4.
    // The signal is checked BEFORE the parse, because there is no honest result
    // to extract from an aborted search.
    if (run.signal || interrupted) {
      aborted = run.signal || interrupted;
    } else {
      // git quotes the term in newer versions: 2.55 prints "is the first 'bad'
      // commit", older prints "is the first bad commit". Accept both, or the
      // driver silently never identifies a culprit.
      const m = run.out.match(/([0-9a-f]{7,40}) is the first '?bad'? commit/);
      if (m) culprit = git(dir, ["rev-parse", m[1]], true).out.trim() || m[1];
      else err = `bisect did not identify a first bad commit — check the repro command classifies good/bad correctly:\n${run.out.trim().slice(-800)}`;
    }
  } catch (e) {
    err = e.message;
  } finally {
    try { git(dir, ["bisect", "reset"], true); } catch (_) {}
    clearSig();
  }

  // Re-test the claim before reporting it (see verifyCulprit). Runs after the
  // bisect state is reset, on a clean tree, and always restores HEAD.
  let ver = null;
  if (culprit && !aborted) {
    try {
      ver = verifyCulprit(dir, culprit, opts.cmd);
    } catch (e) {
      ver = { ok: false, error: e.message };
    }
    try { restoreHead(dir, orig); } catch (_) {}
  }

  // verify we are back where we started (informational — reset should have done it).
  const now = currentHead(dir);
  const restored = now.sha === orig.sha && now.branch === orig.branch;
  if (aborted) {
    return { code: 130, aborted, restored,
      error: `interrupted by ${aborted} — the bisect was aborted and the repo restored. NO culprit is reported: a search that did not finish has not narrowed anything, and the commit it was testing at the time is not an answer.` };
  }
  if (err) return { code: 1, error: err, restored };
  if (!culprit) return { code: 1, error: "no culprit parsed", restored };

  if (ver && !ver.ok) {
    const why = ver.error
      ? `the re-test could not run: ${ver.error}`
      : [
          ver.badOk ? null : `the culprit itself exits ${ver.culpritExit} (a bad commit must exit 1-124)`,
          ver.goodOk ? null : `its parent ${String(ver.parent).slice(0, 12)} exits ${ver.parentExit} (the commit before the culprit must exit 0)`,
        ].filter(Boolean).join("; ");
    return {
      code: 1, restored, culprit,
      error: `bisect reported ${culprit.slice(0, 12)} but that answer does NOT hold up on re-test — ${why}.\n` +
        `git never re-checks its own classifications, so a single bad one (an interrupted run, a flaky or nondeterministic repro, a build that failed at one commit) produces a confident wrong culprit at exit 0. Refusing to report it. Re-run on a quiet machine, or make the repro deterministic.`,
    };
  }

  const info = git(dir, ["show", "-s", "--format=%s%n%ai", culprit], true).out.trim().split("\n");
  return { code: 0, culprit, subject: info[0] || "", authorDate: info[1] || "", restored, verified: true };
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

    // ---- 2026-08-20 audit: the culprit re-test -----------------------------
    // A SIGINT mid-run killed one repro invocation, that commit was
    // misclassified, and `git bisect run` then finished NORMALLY (exit 0,
    // signal null) reporting a commit two places past the real defect. Nothing
    // synchronous distinguishes that from a good run — only re-testing the
    // ANSWER does. These assert the check directly, because a real signal
    // cannot be delivered deterministically from inside a self-test.
    check(r.verified === true, "a clean run reports its culprit as re-tested");
    const vTrue = verifyCulprit(repo, plantedSha, cmd);
    check(vTrue.ok === true, "re-test accepts the true culprit (bad, parent good)");
    // `before` (commit 8), NOT a fresh rev-parse of HEAD: verifyCulprit leaves
    // HEAD detached at the parent it just tested, so reading HEAD here returns
    // the previous probe's position and silently tests the wrong commit.
    const vLate = verifyCulprit(repo, before, cmd);
    check(vLate.ok === false && vLate.goodOk === false,
      "re-test REJECTS a too-late culprit (its parent is already bad)");
    const vEarly = verifyCulprit(repo, goodSha, cmd);            // commit 3, before the defect
    check(vEarly.ok === false && vEarly.badOk === false,
      "re-test REJECTS a too-early culprit (the commit itself still passes)");
    g(["checkout", "-q", before]);
    check(g(["rev-parse", "HEAD"]).stdout.trim() === before, "HEAD restored after the re-test probes");
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

Exit codes: 0 culprit found · 1 no culprit / bisect error · 2 usage / preflight
· 130 interrupted by a signal (no result is reported for an aborted search).`;

// A value-flag given without a value used to return null and fall back to a
// default — for --dir that meant bisecting the SESSION CWD and printing a
// confident CULPRIT from a repo nobody named, at exit 0. cve-audit hardened
// this exact shape in this same suite ("Refuse rather than guess"); the fix
// never propagated here. Refuse instead of guessing.
function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = i + 1 < argv.length ? argv[i + 1] : null;
  if (v === null || v.startsWith("--")) {
    console.error(`error: ${flag} requires a value (got ${v === null ? "nothing" : v})`);
    process.exit(2);
  }
  return v;
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
  if (r.code === 130) {
    console.error("aborted: " + r.error);
    if (r.restored === false) console.error("WARNING: repo may not be back on its original HEAD — run 'git bisect reset' and check 'git status'.");
    process.exit(130);
  }
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
