#!/usr/bin/env node
/*
 * commit-gate — PreToolUse hook (matcher: Bash|PowerShell).
 *
 * Fires before every Bash OR PowerShell tool call; no-ops unless the command is
 * a `git commit`. PowerShell was added 2026-08-20: the matcher had been `Bash`
 * alone while real `git commit` calls existed in transcript history issued
 * through the PowerShell tool — so in the repos with no native pre-commit hook,
 * nothing gated those at all.
 * When it is, it runs the shared secret scanner over the STAGED diff and DENIES
 * the commit if a secret is found — so the model cannot commit a leaked key even
 * if it forgets the gate exists. The native git pre-commit hook covers commits
 * made from the shell; this covers commits the model makes via Bash.
 *
 * Always exits 0 — the block is expressed via permissionDecision:"deny" in the
 * JSON, never via a crash. A gate that cannot run (unparseable input, scanner
 * missing, scanner exit other than 0/1, output over the buffer) DENIES with
 * "secret gate is broken, fix it" (F-M2.7): a fail-open there is a silent bypass.
 * Only target-resolution gaps (unparsed -C/cd, --git-dir, unmappable cwd,
 * unparseable clauses) still allow, and always with a systemMessage warning.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCANNER = path.join(__dirname, "..", "..", "history-leak-scan", "pm-secretscan.js");

function allow() { process.exit(0); }
// fail-open, but NOISY: surface that the gate was skipped instead of silently
// allowing an unscanned commit (a gate that skips silently is a dead gate).
function allowWithWarning(msg) {
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + "\n");
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\n");
  process.exit(0);
}

function unquote(s) {
  return /^".*"$|^'.*'$/.test(s) ? s.slice(1, -1) : s;
}

// On this platform the Bash tool IS Git Bash, so a `/d/<drive>/<path>` form is the
// natural spelling — but `path.resolve("D:\\…","/d/x")` yields `C:\d\x`, git
// says "cannot chdir", the scanner exits 2, and the gate fails OPEN on a commit
// it never scanned.
//
// Passing the POSIX form through untouched does NOT work either, and the reason
// is worth stating because it defeated the first fix AND its verification: MSYS
// rewrites `/c/x` to `C:/x` when bash hands arguments to a process, so testing
// `git -C /c/x` FROM a shell proves nothing about this hook, which spawns git
// with no shell in between. Convert the drive form explicitly.
//
// Other MSYS-root paths (`/tmp`, `/usr`) map inside the Git installation and
// cannot be derived from here — those return null so the caller can skip
// LOUDLY rather than scan a tree that isn't the one being committed to.
// Does this commit clause use -a/--all? `-a` stages tracked modifications AT
// COMMIT TIME, i.e. after this hook runs, so the scan has to widen to HEAD.
//
// The first attempt scrubbed `-m "msg"` out with a regex before testing for
// `-a`. That regex (`-[A-Za-z]*m\s+"..."`) matched `-am "fix"` in its entirety
// — the `[A-Za-z]*` happily ate the `a` — so the canonical spelling deleted the
// very flag being looked for and the bypass stayed open. It only appeared fixed
// because the canary tested the UNQUOTED `-am fix`.
//
// Tokenise instead, and let a value-taking short flag consume its own argument
// so a message can never be read as flags.
//
// The same walk also reports a PATHSPEC (`git commit -m x file.py`) and -o/-i:
// both record working-tree content that is not in the index when this hook runs,
// so main() widens the scan to --worktree for them.
function commitFlags(clause) {
  const r = { all: false, pathspec: false, only: false };
  const toks = clause.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const ci = toks.indexOf("commit");
  if (ci < 0) return r;
  // --gpg-sign / -S / -u / --untracked-files take an OPTIONAL value that must be
  // ATTACHED (`--gpg-sign=<id>`), so they must not swallow the next token: doing
  // so hid a following pathspec (`git commit -S file`) from this walk.
  const VALUE_LONG = /^--(message|file|author|date|template|reuse-message|reedit-message|fixup|squash|cleanup|trailer|pathspec-from-file)$/;
  for (let i = ci + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--") { if (i + 1 < toks.length) r.pathspec = true; break; }   // everything after is a pathspec
    if (t === "--all") { r.all = true; continue; }
    if (t === "--only" || t === "--include") { r.only = true; continue; }
    if (t.startsWith("--")) {
      if (/^--pathspec-from-file(=|$)/.test(t)) r.pathspec = true;
      if (VALUE_LONG.test(t)) i++;   // --opt value
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      // walk the bundle left to right: m/F/c/C/t take a value, which is the REST
      // of the token if there is one (`-mfix`) and the NEXT token otherwise
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (c === "a") r.all = true;
        else if (c === "o" || c === "i") r.only = true;
        else if ("mFcCt".includes(c)) { if (k === t.length - 1) i++; break; }
        else if (c === "S" || c === "u") break;   // optional value, attached only
      }
      continue;
    }
    r.pathspec = true;   // a bare positional that no flag consumed: a pathspec
  }
  return r;
}
const usesCommitAll = (clause) => commitFlags(clause).all;

// Git Bash's `/tmp` is a real directory this process can reach, so it is the one
// MSYS root worth mapping rather than refusing. Everything else under `/` stays
// null — a guess about where `/usr/local/x` lives on a Windows disk is worse
// than an honest refusal.
function mapMsysRoot(p) {
  const m = /^\/tmp(\/.*)?$/.exec(p);
  if (!m) return null;
  const candidate = path.join(os.tmpdir(), (m[1] || "").replace(/^\//, ""));
  return fs.existsSync(candidate) ? candidate : null;
}

// ONE helper, ONE null contract, used by BOTH the session-cwd site and the
// -C/cd site. The first version of the /tmp fix mapped the root at the
// session-cwd call site only, so `git -C /tmp/repo commit` and
// `cd /tmp/repo && git commit` still fell open while a session cwd of
// /tmp/repo denied — the same two-call-sites-disagreeing bug the audit found,
// reintroduced one layer down. Measured: 17 passed / 4 failed under a /tmp
// scratch dir vs 21/0 under C:/, on the identical 21 cases.
function resolveRepoPath(cwd, p) {
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (drive) return drive[1].toUpperCase() + ":" + (drive[2] || "/");
  if (p.startsWith("/")) return mapMsysRoot(p);   // null unless it is a real /tmp path
  return path.resolve(cwd, p);
}

// The command may target a repo OTHER than the session cwd — `git -C <dir>
// commit`, or `cd <dir> && git commit`. Scanning j.cwd in that case scans the
// wrong tree, and a clean result on the wrong tree reads as "allow".
//
// Resolution is CLAUSE-SCOPED. A multi-clause line can name two different repos
// (`git -C <a> add -A && git -C <b> commit`); reading the first -C anywhere on
// the line scanned <a> and SILENTLY ALLOWED a secret staged in <b>. Only the
// clause that actually commits decides, and inside it git's own -C beats an
// earlier cd — which is what git itself does.
// The newline is a clause separator too. The Bash tool routinely sends
// multi-line commands, so `cd <other-repo>\ngit commit` was read as ONE clause:
// the cd regex is `$`-anchored and failed to match, the commit was found in the
// same clause, and the session cwd was scanned instead of the named repo —
// a clean result on the wrong tree, silently allowed.
const CLAUSE_SEP = /&&|\|\||;|\n/;

// The clause that MATTERS is the first one that really commits — a --dry-run
// clause writes nothing. Selecting the first git+commit clause instead let
// `git commit --dry-run && git commit -m x` nominate the harmless half and
// exempt the whole line. Both the exemption test and the repo resolution must
// use this same predicate or they can disagree about which clause is in play.
// Two bugs lived in the one-line version of this predicate, and both were
// introduced by the fix for an EARLIER --dry-run bypass:
//
//   1. `!/--dry-run/.test(c)` was a SUBSTRING test against the raw clause, so
//      `git commit -m "add --dry-run support"` made no clause qualify, no
//      commit clause was found, and main() returned a bare allow() —
//      silent-allow with a real key staged. A message merely NAMING the flag
//      disarmed the gate.
//   2. `/\bgit\b[\s\S]*\bcommit\b/` matched any clause whose TEXT mentions
//      git and commit, so `echo '=== git commit ==='` or a `# git commit`
//      comment before the real `cd <repo> && git commit` was selected as the
//      commit clause. targetRepo's cd loop then ran `for k < i` with i=0,
//      never saw the real cd, and scanned the session cwd instead.
//
// Fixes: the clause must BEGIN with git (after optional VAR=value prefixes),
// and --dry-run is matched as a whole TOKEN, using the same quote-aware
// tokenizer targetRepo already uses so a quoted message can never be read as
// flags.
const startsWithGit = (c) => /^\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\b/.test(c);
// The token right after -m/-F/--message/--file (or a bundle ending in m/F, like
// `-am`) is that flag's VALUE, not a flag: `git commit -m --dry-run` is a REAL
// commit whose message is "--dry-run", and reading it as the flag disarmed the gate.
const hasDryRunToken = (c) => {
  const toks = c.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--dry-run") return true;
    if (t === "--message" || t === "--file" || /^-[A-Za-z]*[mF]$/.test(t)) i++;   // skip the value
  }
  return false;
};
const isRealCommit = (c) =>
  startsWithGit(c) && /\bcommit\b/.test(c) && !hasDryRunToken(c);

function targetRepo(cmd, cwd) {
  const clauses = cmd.split(CLAUSE_SEP);
  const i = clauses.findIndex(isRealCommit);
  if (i < 0) return { dir: cwd };
  // -C is a top-level git option, so it can only sit between `git` and the
  // subcommand. Tokenising and stopping at the `commit` token keeps
  // `git commit -C <commit>` (reuse-message) from being read as a directory,
  // and keeps a path that merely contains "commit" from ending the span early.
  // --git-dir=/--work-tree= relocate the repo without a -C or a cd, and
  // GIT_DIR=/GIT_WORK_TREE= do it via the environment. Any of them means the
  // tree we would scan is not the tree git will commit to — refuse to guess.
  if (/(^|\s)(--git-dir=|--work-tree=)/.test(clauses[i]) ||
      /(^|\s)GIT_(DIR|WORK_TREE)=/.test(clauses[i])) return { unknown: true };
  const toks = clauses[i].match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const ci = toks.indexOf("commit");
  const span = ci < 0 ? toks : toks.slice(0, ci);
  const ck = span.lastIndexOf("-C");
  if (ck >= 0 && ck + 1 < span.length) {
    const d = resolveRepoPath(cwd, unquote(span[ck + 1]));
    return d === null ? { unknown: true } : { dir: d };
  }
  // a -C is present but did not parse (`-C$DIR`, or -C with nothing after it):
  // we do not know which tree to scan, and guessing cwd is exactly the bug.
  if (span.some((t) => /^-C/.test(t))) return { unknown: true };
  // no -C on the commit itself — the LAST cd before it set the working directory
  let dir = null, cdUnparsed = false;
  for (let k = 0; k < i; k++) {
    const c = /^\s*\(?\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*\)?\s*$/.exec(clauses[k]);
    if (c) {
      dir = resolveRepoPath(cwd, unquote(c[1]));
      cdUnparsed = dir === null;   // an unmappable MSYS path is a loud skip, not cwd
    }
    // Both tests were `^`-anchored, so a leading `(` (subshell) or an embedding
    // `bash -c '...'` matched NEITHER — the cd was invisible and neither dir nor
    // the unknown flag was set, so the session cwd got scanned and the commit was
    // silently allowed. Any cd we cannot parse, anywhere in the clause, must
    // force the loud skip rather than a confident scan of the wrong tree.
    else if (/(^|[\s('"])cd(\s|$)/.test(clauses[k])) { dir = null; cdUnparsed = true; }
  }
  if (cdUnparsed) return { unknown: true };
  return { dir: dir === null ? cwd : dir };
}

function main() {
  let j;
  // A malformed payload means we cannot tell whether this is a commit at all,
  // so we must allow — but LOUDLY: this was the one silent fail-open left in
  // the gate, and a silent skip is indistinguishable from a clean scan.
  try { j = JSON.parse(fs.readFileSync(0, "utf8")); }
  catch { return deny("secret gate is broken, fix it: unparseable hook input (stdin was not JSON), so this gate cannot tell whether the command is a commit."); }
  const cmd = j && j.tool_input && j.tool_input.command;
  if (typeof cmd !== "string") return allow();
  // only a real `git commit`. The --dry-run test is scoped to the git-commit
  // CLAUSE: testing the whole command string let an unrelated `--dry-run`
  // earlier in the line (`npm pack --dry-run && git commit -m x`) disarm the gate.
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) return allow();
  // The comment above was true of the intent and false of the code: the test ran
  // against the WHOLE command, and `[^&|;]*` cannot cross `&&`, so
  // `git commit --dry-run && git commit -m x` sailed through unscanned.
  // If NO clause is a real commit, every commit on this line is a dry run and
  // there is nothing to scan; otherwise the first real one governs.
  const clausesAll = cmd.split(CLAUSE_SEP);
  const commitIdx = clausesAll.findIndex(isRealCommit);
  const commitClause = clausesAll[commitIdx];   // undefined when commitIdx is -1
  const before = commitIdx < 0 ? [] : clausesAll.slice(0, commitIdx);
  if (!commitClause) {
    // A line that plainly commits but whose clauses this parser could not
    // recognise must fail open LOUDLY. It used to return a bare allow() — the
    // ONE silent fail-open left in the gate, and by far the widest: measured
    // 2026-08-20 with a real AKIA key staged, every one of these SILENTLY
    // allowed the commit, indistinguishable from a clean scan —
    //
    //   printf 'msg' | git commit -F -      (the standard multi-line idiom)
    //   command / env / exec / nohup git commit
    //   eval "git commit -m x"
    //   { git commit -m x; }
    //   if true; then git commit -m x; fi
    //   for i in 1; do git commit -m x; done
    //
    // CLAUSE_SEP does not split on `|`, `do`, `then` or `{`, and startsWithGit
    // requires the clause to BEGIN with git. Widening the parser to cover these
    // is a treadmill — two gaps were closed this way in one week and each fix
    // introduced another. Making the parse FAILURE loud is the root-cause fix:
    // the gate still cannot scan, but it can no longer pretend it did.
    //
    // The genuine all-dry-run case stays silent, because there really is
    // nothing to scan when every commit on the line writes nothing.
    const anyCommitShape = clausesAll.some((c) => /\bgit\b/.test(c) && /\bcommit\b/.test(c));
    const everyOneDryRun = clausesAll
      .filter((c) => /\bgit\b/.test(c) && /\bcommit\b/.test(c))
      .every(hasDryRunToken);
    if (anyCommitShape && !everyOneDryRun) {
      return allowWithWarning(
        "commit-gate WARNING: this line commits but no clause could be parsed " +
        "(pipeline, eval, brace/loop/conditional, or a wrapper command) — " +
        "secret gate SKIPPED; this commit is UNSCANNED. Re-run the commit as a " +
        "plain `cd <repo> && git commit ...` to get it scanned."
      );
    }
    return allow();
  }

  // PowerShell/bash directory changes other than `cd` move the commit's target
  // repo, and targetRepo only follows `cd`: `Set-Location <other>; git commit`
  // scanned the session cwd (clean) and allowed a secret staged in <other>.
  // $env:GIT_DIR / $env:GIT_WORK_TREE relocate the repo the same way. Refuse
  // outright rather than guess; this runs BEFORE the t.unknown warn-allow below.
  const DIR_CHANGE = /^\s*\(?\s*(Set-Location|sl|pushd|Push-Location|chdir|popd|Pop-Location)\b/i;
  const GIT_ENV_SET = /\$env:GIT_(DIR|WORK_TREE)\s*=/i;
  const mover = before.find((c) => DIR_CHANGE.test(c) || GIT_ENV_SET.test(c));
  if (mover !== undefined) {
    return deny(
      "secret gate: the commit's target directory is changed by a command this gate cannot follow (" +
      mover.trim().slice(0, 80) + ") - run the commit from the target repo with cd or git -C"
    );
  }

  // j.cwd goes through the SAME normalization as a -C/cd path. It did not, so a
  // session cwd spelled the MSYS way (/c/Users/... — what Git Bash reports, and
  // what this gate's own canary passes as its scratch dir) reached git unmapped:
  // git failed with "cannot change to '/c/...'", the scan errored, and the gate
  // degraded to a loud fail-open. Measured 2026-08-20: with a /c/... scratch dir
  // the gate's 12-case canary produced 4 DENY and 7 warns; with a C:/... one the
  // same 12 cases produced 8 DENY. The gate's real coverage depended on how a
  // path was SPELLED, and nothing said so.
  const rawSessionCwd = (j && j.cwd) || process.cwd();
  // `resolveRepoPath` returns null DELIBERATELY for an MSYS root it cannot map
  // (`:93`). The first version of this fix wrote `|| rawSessionCwd`, which threw
  // that signal away and handed git a path that does not exist — so a cwd of
  // `/tmp/repo` produced `fatal: cannot change to '/tmp/repo'`, the scan errored,
  // and the gate fell open, while the identical repo spelled `C:/...` denied.
  // `targetRepo` honours the same null correctly via `cdUnparsed`; two call
  // sites of one helper disagreeing about its null contract is the same bug
  // class the helper was written to close.
  //
  // `/tmp` is mapped explicitly because Git Bash's /tmp is a REAL directory this
  // process can reach; anything else unmappable is refused loudly rather than
  // guessed at.
  const sessionCwd = resolveRepoPath(rawSessionCwd, rawSessionCwd);
  if (sessionCwd === null) {
    return allowWithWarning(
      `commit-gate WARNING: cannot map the session directory '${rawSessionCwd}' ` +
      "to a path git can use — secret gate SKIPPED; this commit is UNSCANNED."
    );
  }
  const t = targetRepo(cmd, sessionCwd);
  if (t.unknown) {
    return allowWithWarning(
      "commit-gate WARNING: could not determine which repo this command targets " +
      "(unparsed -C/cd) — secret gate SKIPPED; this commit is UNSCANNED."
    );
  }
  const cwd = t.dir;
  // A target that is not inside a git work tree is an UNKNOWN TARGET, not a broken
  // gate: `git commit` fails there, so nothing can land. Loud allow. (A scanner
  // error INSIDE a real repo still denies, below.)
  let inTree = "";
  try {
    inTree = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { /* not a repo, or the path does not exist */ }
  if (inTree.trim() !== "true") {
    return allowWithWarning(
      "commit-gate WARNING: the commit target '" + cwd + "' is not inside a git work tree - " +
      "git commit will fail there; secret gate SKIPPED, nothing to scan."
    );
  }
  // node exits 1 on MODULE_NOT_FOUND as well as on findings, so a missing
  // scanner would land in the status===1 branch below and DENY every commit with
  // a false "a secret was detected" — whose natural remedy is --no-verify, i.e.
  // no gate at all. Check for the file first and skip loudly instead.
  if (!fs.existsSync(SCANNER)) {
    return deny("secret gate is broken, fix it: scanner not found at " + SCANNER);
  }
  // `git commit -a/--all` stages tracked modifications at commit time, AFTER
  // this hook runs, so the staged diff is empty and a real key was allowed
  // through. Widen the scan to HEAD for those. Long options are matched
  // explicitly; the short form only in a bundle of short flags (`-am`, `-a`),
  // so a value like `-m "all done"` cannot trigger it.
  const cf = commitFlags(commitClause);
  // The index is not what gets committed when the SAME line runs `git add` first,
  // when the commit names a pathspec, or with -o/-i: all of them record
  // working-tree content (untracked files, unstaged edits) that neither --staged
  // nor --staged-all can see at this moment. Scan the whole working tree.
  const addsFirst = before.some((c) => startsWithGit(c) &&
    (c.match(/"[^"]*"|'[^']*'|\S+/g) || []).some((t) => t === "add" || t === "stage"));
  const worktree = addsFirst || cf.pathspec || cf.only;
  const scanMode = worktree ? "--worktree" : cf.all ? "--staged-all" : "--staged";
  try {
    execFileSync("node", [SCANNER, scanMode, cwd], { encoding: "utf8", maxBuffer: 64 << 20 });
    return allow(); // exit 0 → no findings
  } catch (e) {
    if (e && e.code === "ENOBUFS") {
      return deny("secret gate: the scanner output exceeded the buffer - denying");
    }
    if (e && e.status === 1) {
      const report = (e.stdout || "").trim();
      return deny(
        "commit-gate: a secret was detected in the " + (worktree ? "WORKING TREE (this commit can record unstaged/untracked content)" : "STAGED diff") + ". Commit blocked.\n" +
        report +
        "\nRemove the secret from the diff (git restore --staged / edit the file), and if it is a live " +
        "credential, rotate it via the secret-rotation runbook and update .claude/secrets-inventory.md " +
        "before committing."
      );
    }
    // usage error / scanner failure: the scan did not run, so deny (F-M2.7)
    return deny(
      "secret gate is broken, fix it: scanner error (exit " + ((e && e.status) || (e && e.code) || "unknown") +
      "); this commit cannot be scanned. Check node and " + SCANNER
    );
  }
}

// self-test: plant a real staged secret, then assert the decision for each
// command shape. These four regressions all shipped silently before 2026-08-05.
function runCanary() {
  // os is required at module scope
  const { execFileSync, spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-canary-"));
  let clean = null, wt = null;
  let pass = 0, fail = 0;
  const check = (cond, desc) => { if (cond) pass++; else { fail++; console.log("  FAIL: " + desc); } };
  const decide = (cwd, command) => {
    const r = spawnSync(process.execPath, [__filename], {
      input: JSON.stringify({ cwd, tool_input: { command } }), encoding: "utf8",
    });
    const o = (r.stdout || "").trim();
    if (!o) return "allow";
    if (o.includes('"deny"')) return "deny";
    if (o.includes("systemMessage")) return "warn";
    return "other";
  };
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    const g = (a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
    g(["config", "user.email", "c@c.c"]); g(["config", "user.name", "canary"]);
    // assembled at runtime so this source holds no matchable literal
    fs.writeFileSync(path.join(dir, ".env"), 'AWS_KEY = "AKIA' + 'QZ3RT7YXKW9MPL2V"\n');
    g(["add", "-A"]);

    check(decide(dir, "git commit -m x") === "deny", "staged secret in cwd repo -> deny");
    check(decide(os.tmpdir(), `git -C ${dir} commit -m x`) === "deny", "-C <repo> from another cwd -> deny");
    check(decide(os.tmpdir(), `cd ${dir} && git commit -m x`) === "deny", "cd <repo> && commit -> deny");
    check(decide(dir, "npm pack --dry-run && git commit -m x") === "deny", "unrelated --dry-run must not disarm the gate");
    check(decide(dir, "git commit --dry-run -m x") === "allow", "a real git commit --dry-run -> allow");
    check(decide(dir, "ls -la") === "allow", "non-commit command -> allow");
    check(decide(dir, "git status") === "allow", "git non-commit -> allow");
    // a target that is not a git work tree is an UNKNOWN target (git commit fails
    // there): loud allow, never a silent one
    check(decide(path.join(os.tmpdir(), "cg-not-a-repo-xyz"), "git commit -m x") === "warn",
      "non-repo cwd -> noisy allow (unknown target), not silent allow");
    // ...but a scanner that exits 2 INSIDE a real repo is a broken gate: deny.
    // Run a copy of this hook next to a stub scanner that exits 2.
    const stubRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-stub-"));
    try {
      fs.mkdirSync(path.join(stubRoot, "commit-gate", "hooks"), { recursive: true });
      fs.mkdirSync(path.join(stubRoot, "history-leak-scan"), { recursive: true });
      const stubHook = path.join(stubRoot, "commit-gate", "hooks", "pretooluse-commit-gate.js");
      fs.copyFileSync(__filename, stubHook);
      fs.writeFileSync(path.join(stubRoot, "history-leak-scan", "pm-secretscan.js"), "process.exit(2);\n");
      const sr = spawnSync(process.execPath, [stubHook], {
        input: JSON.stringify({ cwd: dir, tool_input: { command: "git commit -m x" } }), encoding: "utf8",
      });
      check((sr.stdout || "").includes('"deny"') && (sr.stdout || "").includes("gate is broken"),
        "scanner exit 2 inside a real repo -> deny as broken");
    } finally {
      fs.rmSync(stubRoot, { recursive: true, force: true });
    }
    // malformed input used to allow SILENTLY, then LOUDLY (F-M2.7): now it denies
    const bad = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
    check((bad.stdout || "").includes('"deny"') && (bad.stdout || "").includes("gate is broken") && bad.status === 0,
      "malformed stdin -> deny as broken");

    // A multi-clause line can name TWO repos. Resolving from the first -C on the
    // line scanned the wrong one and allowed the commit with empty stdout — a
    // silent allow, the worst outcome a gate has. Both shapes below were silent
    // allows until 2026-08-12; testing each shape in isolation never caught it.
    clean = fs.mkdtempSync(path.join(os.tmpdir(), "cg-clean-"));
    execFileSync("git", ["init", "-q", clean], { stdio: "ignore" });
    check(decide(os.tmpdir(), `git -C ${clean} add -A && git -C ${dir} commit -m x`) === "deny",
      "add in a clean repo && commit in a dirty one -> the COMMIT clause decides");
    check(decide(os.tmpdir(), `cd ${clean} && git -C ${dir} commit -m x`) === "deny",
      "cd <clean> && git -C <dirty> commit -> -C beats an earlier cd");
    // and the reuse-message flag is not a directory: misreading it as one
    // resolves <dir>/HEAD, which does not exist, so the gate would degrade to a
    // "warn" skip instead of scanning the cwd repo and denying.
    check(decide(dir, "git commit -C HEAD -m x") === "deny",
      "git commit -C <commit> is reuse-message, not a repo path");

    // -a/--all detection. The QUOTED forms are the point: the first fix scrubbed
    // `-m "msg"` with a regex that also ate the `-a` in `-am "fix"`, leaving the
    // bypass open while an unquoted-only canary reported success. Both spellings
    // are pinned here, along with messages that merely CONTAIN flag-like text.
    check(usesCommitAll('git commit -am "fix"'), '-am "quoted" detected as --all');
    check(usesCommitAll("git commit -am 'fix'"), "-am 'quoted' detected as --all");
    check(usesCommitAll("git commit -am fix"), "-am unquoted detected as --all");
    check(usesCommitAll('git commit -avm "fix"'), "-avm bundle detected as --all");
    check(usesCommitAll('git commit -a -m "fix"'), "-a separate detected as --all");
    check(usesCommitAll('git commit --all -m x'), "--all detected");
    check(!usesCommitAll('git commit -m "all done"'), 'message containing "all" is NOT --all');
    check(!usesCommitAll('git commit -m "-a"'), 'message that looks like -a is NOT --all');
    check(!usesCommitAll('git commit --amend -m "x"'), "--amend is NOT --all");

    // isRealCommit is token-scoped and start-anchored. Both properties were
    // absent in a version that shipped green, so each gets an assertion:
    // a message NAMING --dry-run must still be a real commit, and a clause that
    // merely MENTIONS git+commit (echo banner, comment) must not be selected.
    check(isRealCommit('git commit -m "add --dry-run support"'),
      'isRealCommit is token-scoped: --dry-run inside a message is still a real commit');
    check(!isRealCommit('git commit --dry-run -m x'),
      'a genuine --dry-run token is NOT a real commit');
    check(!isRealCommit("echo '=== git commit ==='"),
      'an echo banner mentioning git commit is NOT a real commit');
    check(!isRealCommit('# git commit step'),
      'a comment mentioning git commit is NOT a real commit');
    check(isRealCommit('GIT_AUTHOR_NAME=x git commit -m y'),
      'a VAR=value prefix before git is still a real commit');
    check(!isRealCommit('cd /some/repo'),
      'a bare cd is NOT a real commit');
    // `-m --dry-run`: the token after -m is the MESSAGE, so this is a real commit
    check(isRealCommit('git commit -m --dry-run'), '-m --dry-run is a REAL commit (value, not flag)');
    check(isRealCommit('git commit -am --dry-run'), '-am --dry-run is a REAL commit');
    check(isRealCommit('git commit --message --dry-run'), '--message --dry-run is a REAL commit');
    check(isRealCommit('git commit -F --dry-run'), '-F --dry-run is a REAL commit');
    check(!isRealCommit('git commit -m x --dry-run'), 'a real --dry-run flag after -m x is still a dry run');
    // pathspec / -o / -i detection (they widen the scan to the working tree)
    check(commitFlags('git commit -m x tracked.py').pathspec, 'positional after -m x is a pathspec');
    check(commitFlags('git commit -mfix tracked.py').pathspec, 'attached -mfix does not swallow the pathspec');
    check(commitFlags('git commit -m x -- tracked.py').pathspec, 'tokens after -- are pathspecs');
    check(!commitFlags('git commit -m "a b c" --author "A <a@b.c>"').pathspec, 'message and --author values are not pathspecs');
    check(commitFlags('git commit -o -m x f').only && commitFlags('git commit --include -m x f').only, '-o / --include detected');

    // ---- worktree widening the index is NOT what gets committed when
    // the same line runs `git add`, or the commit names a pathspec / -o / -i.
    // Repo `wt`: HEAD has a clean tracked file; the secret is added UNSTAGED.
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wt-"));
    const gw = (a) => execFileSync("git", ["-C", wt, ...a], { stdio: "ignore" });
    execFileSync("git", ["init", "-q", wt], { stdio: "ignore" });
    gw(["config", "user.email", "c@c.c"]); gw(["config", "user.name", "canary"]);
    fs.writeFileSync(path.join(wt, "tracked.py"), "x = 1\n");
    gw(["add", "-A"]); gw(["commit", "-qm", "base"]);
    check(decide(wt, "git add -A && git commit -m x") === "allow", "control: clean repo, git add -A && commit -> allow");
    fs.writeFileSync(path.join(wt, "tracked.py"), 'AWS_KEY = "AKIA' + 'QZ3RT7YXKW9MPL2V"\n');   // unstaged edit
    check(decide(wt, "git add -A && git commit -m x") === "deny", "git add -A && commit with an UNSTAGED secret -> deny");
    check(decide(wt, "git add . && git commit -m x") === "deny", "git add . && commit with an UNSTAGED secret -> deny");
    check(decide(wt, "git commit -m x tracked.py") === "deny", "commit with a pathspec and an UNSTAGED secret -> deny");
    check(decide(wt, "git commit -o -m x tracked.py") === "deny", "commit -o <path> with an UNSTAGED secret -> deny");
    check(decide(wt, "git commit -a -m x") === "deny", "control: commit -a with an unstaged secret -> deny");
    fs.writeFileSync(path.join(wt, "new_untracked.py"), 'K = "AKIA' + 'QZ3RT7YXKW9MPL2V"\n');
    gw(["checkout", "-q", "--", "tracked.py"]);   // only the UNTRACKED secret remains
    check(decide(wt, "git add -A && git commit -m x") === "deny", "git add -A && commit with an UNTRACKED secret -> deny");
    // `git commit -m --dry-run` is a real commit; the staged secret in `dir` must block it
    check(decide(dir, "git commit -m --dry-run") === "deny", "commit -m --dry-run (real commit) with a staged secret -> deny");

    // Set-Location / pushd / sl move the target repo where the gate cannot follow.
    // Session cwd is a CLEAN repo; the staged secret is in `dir`.
    check(decide(clean, `Set-Location ${dir}; git commit -m x`) === "deny", "Set-Location <other>; commit -> deny");
    check(decide(clean, `pushd ${dir}; git commit -m x`) === "deny", "pushd <other>; commit -> deny");
    check(decide(clean, `sl ${dir}; git commit -m x`) === "deny", "sl <other>; commit -> deny");
    check(decide(clean, `$env:GIT_DIR = "${dir}"; git commit -m x`) === "deny", "$env:GIT_DIR = ..; commit -> deny");

    // a missing scanner must DENY (was a warn-allow): run a copy of this hook from
    // a dir where ../../history-leak-scan/pm-secretscan.js does not exist
    const lone = fs.mkdtempSync(path.join(os.tmpdir(), "cg-lone-"));
    try {
      fs.mkdirSync(path.join(lone, "commit-gate", "hooks"), { recursive: true });
      const copy = path.join(lone, "commit-gate", "hooks", "pretooluse-commit-gate.js");
      fs.copyFileSync(__filename, copy);
      const r = spawnSync(process.execPath, [copy], {
        input: JSON.stringify({ cwd: dir, tool_input: { command: "git commit -m x" } }), encoding: "utf8",
      });
      check((r.stdout || "").includes('"deny"') && (r.stdout || "").includes("gate is broken"),
        "scanner file missing -> deny as broken");
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
    }

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (clean) fs.rmSync(clean, { recursive: true, force: true });
    if (wt) fs.rmSync(wt, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
main();
