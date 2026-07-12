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

function main() {
  let j;
  try { j = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return allow(); }
  const cmd = j && j.tool_input && j.tool_input.command;
  if (typeof cmd !== "string") return allow();
  // only a real `git commit` (skip status/log/--dry-run)
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(cmd) || /--dry-run/.test(cmd)) return allow();

  const cwd = (j && j.cwd) || process.cwd();
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

main();
