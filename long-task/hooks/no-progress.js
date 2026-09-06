#!/usr/bin/env node
/*
 * long-task — progress lock (PostToolUseFailure, matcher "Bash|PowerShell").
 *
 * The harness fires PostToolUseFailure when a shell command exits non-zero
 * (PostToolUse fires only on success), with the command in tool_input.command
 * and the exit line + interleaved output in `error`. This hook remembers the
 * last failing (command, error) pair per session; when the SAME pair fails
 * again back-to-back it injects [NO-PROGRESS] as additionalContext. Two
 * identical failures is the definition of spinning, and the model is the last
 * one to notice it from inside a long session.
 *
 * Not a heuristic: no output parsing beyond whitespace normalisation, no
 * guessing whether stdout "looks like" an error — the harness already decided
 * this call failed. A different command, or the same command failing
 * differently, resets the count.
 *
 * Output must be the JSON envelope; plain stdout goes to the debug log:
 *   {"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"..."}}
 *
 * State: <tmp>/claude-no-progress-<session>.json. Off: NO_PROGRESS_OFF=1.
 * Always exits 0 — a hook error must never disrupt the session.
 *
 * Register in ~/.claude/settings.json:
 *   "PostToolUseFailure": [ { "matcher": "Bash|PowerShell", "hooks": [ { "type": "command",
 *     "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ]
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Fire on the Nth consecutive identical failure (2 = the second one).
const THRESHOLD = 2;
// Only this much of the error is hashed: the harness middle-truncates output
// past 10,000 chars, and a timing line deep in a log must not make two
// identical failures look different.
const ERROR_HASH_CHARS = 2000;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, ERROR_HASH_CHARS);
}

function keyOf(command, error) {
  return crypto.createHash("sha1")
    .update(normalize(command) + " " + normalize(error))
    .digest("hex");
}

// Pure decision so the canary can test it without spawning: returns the new
// state and whether to fire.
function step(prev, key) {
  const same = prev && prev.key === key;
  const count = same ? (parseInt(prev.count, 10) || 1) + 1 : 1;
  return { state: { key, count }, fire: count >= THRESHOLD, count };
}

function main() {
  if (process.env.NO_PROGRESS_OFF) return 0;

  const raw = readStdin();
  if (!raw) return 0;
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!ev || typeof ev !== "object") return 0;
  if (ev.hook_event_name && ev.hook_event_name !== "PostToolUseFailure") return 0;
  if (!SHELL_TOOLS.has(ev.tool_name)) return 0;
  if (ev.is_interrupt) return 0; // the user stopped it; nothing to learn from that

  const command = ev.tool_input && ev.tool_input.command;
  if (typeof command !== "string" || !command.trim()) return 0;

  const session = String(ev.session_id || "default").replace(/[^\w.-]/g, "");
  const statePath = path.join(os.tmpdir(), `claude-no-progress-${session}.json`);

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    /* first failure this session */
  }

  const { state, fire, count } = step(prev, keyOf(command, ev.error));
  try {
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* best-effort; a failed write means the next failure counts as the first */
  }
  if (!fire) return 0;

  const firstLine = String(ev.error || "").split(/\r?\n/).find((l) => l.trim()) || "(no output)";
  const cmd = command.trim().replace(/\s+/g, " ").slice(0, 120);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext:
          `[NO-PROGRESS] The same command has failed the same way ${count} times in a row: ` +
          `\`${cmd}\` → ${firstLine.slice(0, 160)}. You are spinning. Change the approach ` +
          `(different command, different diagnosis, read the code) or stop and report a ` +
          `NO-PROGRESS BLOCK naming the command and the error. Do not run it a third time ` +
          `unchanged. (long-task/SKILL.md section 4)`,
      },
    }) + "\n"
  );
  return 0;
}

function runCanary() {
  const { spawnSync } = require("child_process");
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };

  // pure logic
  const k = keyOf("npm test", "Exit code 1\nError: x");
  check(k === keyOf("npm   test ", "Exit code 1\r\nError:  x"), "whitespace/CRLF differences hash the same");
  check(k !== keyOf("npm test", "Exit code 2\nError: y"), "a different error is a different key");
  check(k !== keyOf("npm run lint", "Exit code 1\nError: x"), "a different command is a different key");
  let s = step(null, k);
  check(!s.fire && s.count === 1, "first failure is silent");
  s = step(s.state, k);
  check(s.fire && s.count === 2, "second identical failure fires");
  s = step(s.state, keyOf("other", "err"));
  check(!s.fire && s.count === 1, "a different failure resets the count");

  // end to end through stdin
  const sid = "canary-" + process.pid;
  const ev = (command, error, extra) => Object.assign({
    session_id: sid, hook_event_name: "PostToolUseFailure", tool_name: "Bash",
    tool_input: { command }, error,
  }, extra || {});
  const fire = (e) => spawnSync(process.execPath, [__filename], { input: JSON.stringify(e), encoding: "utf8" });

  let r = fire(ev("node build.js", "Exit code 1\nTypeError: boom"));
  check(r.status === 0 && (r.stdout || "").trim() === "", "live: first failure silent, exit 0");
  r = fire(ev("node build.js", "Exit code 1\nTypeError: boom"));
  const out = (r.stdout || "").trim();
  check(out.includes("additionalContext") && out.includes("NO-PROGRESS"), "live: second identical failure injects [NO-PROGRESS]");
  check(out.includes("PostToolUseFailure"), "declares the PostToolUseFailure hookEventName");
  check(out.includes("node build.js") && out.includes("Exit code 1"), "names the command and the exit line");
  r = fire(ev("node build.js", "Exit code 1\nTypeError: different"));
  check((r.stdout || "").trim() === "", "live: same command, different error -> silent (count reset)");
  r = fire(ev("node build.js", "Exit code 1\nTypeError: different", { is_interrupt: true }));
  check((r.stdout || "").trim() === "", "an interrupted command is ignored");
  r = fire(ev("node build.js", "Exit code 1\nTypeError: different", { tool_name: "Read" }));
  check((r.stdout || "").trim() === "", "non-shell tools are ignored");
  r = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
  check(r.status === 0 && (r.stdout || "").trim() === "", "malformed stdin never blocks and prints nothing");

  try { fs.unlinkSync(path.join(os.tmpdir(), `claude-no-progress-${sid}.json`)); } catch { /* fine */ }

  const ok = fail === 0;
  console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
  return ok;
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
process.exit(main());
