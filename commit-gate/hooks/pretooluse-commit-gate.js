#!/usr/bin/env node
/*
 * commit-gate — PreToolUse hook (matcher: Bash).
 *
 * Fires before every Bash tool call; no-ops unless the command is a `git commit`.
 * When it is, it runs the shared secret scanner over the STAGED diff and DENIES
 * the commit if a secret is found — so the model cannot commit a leaked key even
 * if it forgets the gate exists. The native git pre-commit hook covers commits
 * made from the shell; this covers commits the model makes via Bash.
 *
 * Always exits 0 — the block is expressed via permissionDecision:"deny" in the
 * JSON, never via a crash. Any internal error fails OPEN (allow), because a
 * scanner bug must not wedge every commit.
 */
"use strict";
const fs = require("fs");
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

// On this platform the Bash tool IS Git Bash, so `/d/ClaudeCode/Skills` is the
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
function usesCommitAll(clause) {
  const toks = clause.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const ci = toks.indexOf("commit");
  if (ci < 0) return false;
  const VALUE_LONG = /^--(message|file|author|date|template|reuse-message|reedit-message|fixup|squash|gpg-sign|cleanup)$/;
  for (let i = ci + 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === "--all") return true;
    if (t.startsWith("--")) { if (VALUE_LONG.test(t)) i++; continue; }   // --opt value
    if (t.startsWith("-") && t.length > 1) {
      const flags = t.slice(1);
      if (/a/.test(flags)) return true;
      // m/F/c/C/t/u/S take a value; in a bundle it is the NEXT token
      if (/[mFcCtS]/.test(flags)) i++;
      continue;
    }
    // a bare positional (pathspec or a consumed value) — not a flag
  }
  return false;
}

function resolveRepoPath(cwd, p) {
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (drive) return drive[1].toUpperCase() + ":" + (drive[2] || "/");
  if (p.startsWith("/")) return null;          // MSYS-root path we cannot map
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
const isRealCommit = (c) => /\bgit\b[\s\S]*\bcommit\b/.test(c) && !/--dry-run/.test(c);

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
  catch { return allowWithWarning("commit-gate WARNING: unparseable hook input — secret gate SKIPPED; if this was a commit it is UNSCANNED."); }
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
  const commitClause = cmd.split(CLAUSE_SEP).find(isRealCommit);
  if (!commitClause) return allow();

  const sessionCwd = (j && j.cwd) || process.cwd();
  const t = targetRepo(cmd, sessionCwd);
  if (t.unknown) {
    return allowWithWarning(
      "commit-gate WARNING: could not determine which repo this command targets " +
      "(unparsed -C/cd) — secret gate SKIPPED; this commit is UNSCANNED."
    );
  }
  const cwd = t.dir;
  // node exits 1 on MODULE_NOT_FOUND as well as on findings, so a missing
  // scanner would land in the status===1 branch below and DENY every commit with
  // a false "a secret was detected" — whose natural remedy is --no-verify, i.e.
  // no gate at all. Check for the file first and skip loudly instead.
  if (!fs.existsSync(SCANNER)) {
    return allowWithWarning(
      "commit-gate WARNING: scanner not found at " + SCANNER +
      " — secret gate SKIPPED; this commit is UNSCANNED."
    );
  }
  // `git commit -a/--all` stages tracked modifications at commit time, AFTER
  // this hook runs, so the staged diff is empty and a real key was allowed
  // through. Widen the scan to HEAD for those. Long options are matched
  // explicitly; the short form only in a bundle of short flags (`-am`, `-a`),
  // so a value like `-m "all done"` cannot trigger it.
  const commitsAll = usesCommitAll(commitClause);
  try {
    execFileSync("node", [SCANNER, commitsAll ? "--staged-all" : "--staged", cwd], { encoding: "utf8" });
    return allow(); // exit 0 → no findings
  } catch (e) {
    if (e && e.status === 1) {
      const report = (e.stdout || "").trim();
      return deny(
        "commit-gate: a secret was detected in the STAGED diff. Commit blocked.\n" +
        report +
        "\nRemove the secret from the diff (git restore --staged / edit the file), and if it is a live " +
        "credential, rotate it via the secret-rotation runbook and update .claude/secrets-inventory.md " +
        "before committing."
      );
    }
    // usage error / scanner failure → fail open, loudly
    return allowWithWarning(
      "commit-gate WARNING: scanner error (" + ((e && e.status) || "unknown") +
      ") — secret gate SKIPPED (fail-open); this commit is UNSCANNED. Check the scanner."
    );
  }
}

// self-test: plant a real staged secret, then assert the decision for each
// command shape. These four regressions all shipped silently before 2026-08-05.
function runCanary() {
  const os = require("os");
  const { execFileSync, spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-canary-"));
  let clean = null;
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
    // an unscannable target must be LOUD, never a silent allow
    check(decide(path.join(os.tmpdir(), "cg-not-a-repo-xyz"), "git commit -m x") === "warn",
      "non-repo cwd -> noisy fail-open, not silent allow");
    // malformed input used to allow SILENTLY — indistinguishable from a clean scan
    const bad = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
    check((bad.stdout || "").includes("systemMessage") && bad.status === 0,
      "malformed stdin -> loud skip, never a silent allow");

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

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (clean) fs.rmSync(clean, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
main();
