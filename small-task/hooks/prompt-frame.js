#!/usr/bin/env node
/*
 * small-task — deterministic framing injection (UserPromptSubmit).
 *
 * Same mechanism as compact-io/hooks/prompt-density.js, same reason: a rule
 * that lives at the top of context stops being read once the context is long.
 * This hook appends small-task/SKILL.md's BODY to every prompt, so the framing
 * steps sit next to the prompt they apply to. Firing is deterministic; doing
 * the framing is still the model's job (a hook cannot invoke a skill).
 *
 * Cost: the body is ~110 words, ~150 tokens per prompt, uncached (hook output
 * lands after the conversation). If it stops being worth it, remove the
 * registration — there is no interval knob here on purpose; an every-Nth
 * reminder is exactly the drift this exists to stop.
 *
 * Always exits 0 and prints nothing on error — a hook must never block a
 * prompt, and a missing SKILL.md must degrade to silence, not to a crash.
 *
 * Register in ~/.claude/settings.json:
 *   "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command",
 *     "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ] }
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SKILL = path.join(__dirname, "..", "SKILL.md");
const HEADER = "[SMALL-TASK] Task framing in force this turn:";

// SKILL.md minus its YAML frontmatter — the description is already in context
// through the skills listing.
function skillBody(file = SKILL) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  const body = (m ? text.slice(m[0].length) : text).trim();
  return body.length ? body : null;
}

function main() {
  try { fs.readFileSync(0, "utf8"); } catch { /* no stdin, fine */ }
  const body = skillBody();
  if (body) process.stdout.write(HEADER + "\n" + body + "\n");
}

function runCanary() {
  const os = require("os");
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };

  const body = skillBody();
  check(body !== null, "reads the real SKILL.md");
  check(!/^---/.test(body || "x"), "strips YAML frontmatter");
  check(!/^name:\s*small-task/m.test(body || ""), "frontmatter fields do not leak into the body");
  check(/DONE/.test(body || ""), "body carries the done-check step");
  check(/BLOCKERS/.test(body || ""), "body carries the blockers step");
  check(/RISKIEST FIRST/.test(body || ""), "body carries riskiest-first");
  check(/SCOPE LOCK/.test(body || ""), "body carries the scope lock");
  check(/long-task/.test(body || ""), "body hands long work to long-task");
  check((body || "").split(/\s+/).length <= 140, "body stays under 140 words (per-prompt cost cap)");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "st-canary-"));
  try {
    const crlf = path.join(tmp, "crlf.md");
    fs.writeFileSync(crlf, "---\r\nname: x\r\n---\r\nBODY HERE\r\n");
    check(skillBody(crlf) === "BODY HERE", "CRLF frontmatter is stripped too");
    const empty = path.join(tmp, "empty.md");
    fs.writeFileSync(empty, "---\nname: x\n---\n\n");
    check(skillBody(empty) === null, "frontmatter-only file yields null, not an empty injection");
    let threw = false, out = "sentinel";
    try { out = skillBody(path.join(tmp, "missing.md")); } catch { threw = true; }
    check(!threw && out === null, "a missing SKILL.md returns null instead of throwing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // end to end: the hook's stdout starts with the header
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [__filename], { input: "{}", encoding: "utf8" });
  check(r.status === 0 && (r.stdout || "").startsWith(HEADER), "live run prints the header and exits 0");

  const ok = fail === 0;
  console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
  return ok;
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);

try {
  main();
} catch {
  /* fail open: never block a prompt */
}
process.exit(0);
