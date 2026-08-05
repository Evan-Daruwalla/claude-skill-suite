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

// The command may target a repo OTHER than the session cwd — `git -C <dir>
// commit`, or `cd <dir> && git commit`. Scanning j.cwd in that case scans the
// wrong tree, and a clean result on the wrong tree reads as "allow".
function targetRepo(cmd, cwd) {
  const c = /(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(cmd);
  if (c) return { dir: path.resolve(cwd, unquote(c[1])) };
  const m = /\bgit\b\s+(?:[^&|;]*?\s)?-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  if (m) return { dir: path.resolve(cwd, unquote(m[1])) };
  // a -C or cd is present but did not parse: we do not know which tree to scan,
  // and guessing cwd is exactly the bug. Skip loudly rather than scan blind.
  if (/\s-C\s/.test(cmd) || /(?:^|&&|;|\|\|)\s*cd\s/.test(cmd)) return { unknown: true };
  return { dir: cwd };
}

function main() {
  let j;
  try { j = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return allow(); }
  const cmd = j && j.tool_input && j.tool_input.command;
  if (typeof cmd !== "string") return allow();
  // only a real `git commit`. The --dry-run test is scoped to the git-commit
  // CLAUSE: testing the whole command string let an unrelated `--dry-run`
  // earlier in the line (`npm pack --dry-run && git commit -m x`) disarm the gate.
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) return allow();
  if (/\bgit\b[^&|;]*\bcommit\b[^&|;]*--dry-run/.test(cmd)) return allow();

  const sessionCwd = (j && j.cwd) || process.cwd();
  const t = targetRepo(cmd, sessionCwd);
  if (t.unknown) {
    return allowWithWarning(
      "commit-gate WARNING: could not determine which repo this command targets " +
      "(unparsed -C/cd) — secret gate SKIPPED; this commit is UNSCANNED."
    );
  }
  const cwd = t.dir;
  try {
    execFileSync("node", [SCANNER, "--staged", cwd], { encoding: "utf8" });
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

    const ok = fail === 0;
    console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
    return ok;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
main();
