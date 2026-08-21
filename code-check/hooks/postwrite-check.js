#!/usr/bin/env node
/*
 * code-check — post-write nudge hook (PostToolUse, matcher "Edit|Write").
 *
 * After Claude edits or writes a CODE file, injects a reminder to run the
 * code-check pass (see ../SKILL.md). The firing is deterministic; running the
 * pass is still the model's job — a hook cannot invoke a skill.
 *
 * PostToolUse stdout is NOT shown to the model as plain text (it goes to the
 * debug log). Context must be returned as JSON on stdout:
 *   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}
 *
 * Debounced to at most one nudge per DEBOUNCE_MS per session, so a burst of
 * edits nudges once instead of once per file. Files edited while suppressed
 * are accumulated and named in the next nudge, so nothing goes unmentioned if
 * the burst continues. State: <tmp>/claude-code-check-<session>.json.
 *
 * Off for a session: CODE_CHECK_OFF=1.
 * Always exits 0 — a hook error must never disrupt the session.
 *
 * Register in ~/.claude/settings.json:
 *   "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command",
 *     "command": "node \"<abs path to this file>\"", "timeout": 5000 } ] } ]
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEBOUNCE_MS = 90_000;

// Extensions that count as code. Docs/config (.md .json .yaml .toml .txt)
// deliberately excluded — editing those needs no run-check.
const CODE_EXT = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs",
  ".java", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift",
  ".kt", ".sh", ".bash", ".ps1", ".sql", ".ipynb",
]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  if (process.env.CODE_CHECK_OFF) return 0;

  const raw = readStdin();
  if (!raw) return 0;

  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!ev || typeof ev !== "object") return 0;

  const filePath = ev.tool_input && ev.tool_input.file_path;
  if (typeof filePath !== "string" || !filePath) return 0;
  if (!CODE_EXT.has(path.extname(filePath).toLowerCase())) return 0;

  const session = String(ev.session_id || "default").replace(/[^\w.-]/g, "");
  const statePath = path.join(os.tmpdir(), `claude-code-check-${session}.json`);

  let state = { last: 0, files: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (prev && typeof prev === "object") {
      state.last = parseInt(prev.last, 10) || 0;
      state.files = Array.isArray(prev.files) ? prev.files : [];
    }
  } catch {
    /* no/corrupt state — treat as first edit */
  }

  const name = path.basename(filePath);
  if (!state.files.includes(name)) state.files.push(name);

  const now = Date.now();
  const due = now - state.last >= DEBOUNCE_MS;
  const touched = state.files.slice(0, 8);
  const more = state.files.length - touched.length;

  if (due) {
    state.last = now;
    state.files = [];
  }

  try {
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* best-effort; a failed write just means the next edit re-nudges */
  }

  // one state file per session, and sessions are never revisited — prune stale
  // ones so tmp does not accumulate a file per session forever.
  //
  // Only when the nudge is DUE, not on every write. This enumerates the WHOLE of
  // %TEMP% — a directory that routinely holds thousands of entries — and it ran
  // on every single Edit/Write of a code file, inside a hook with a 5-second
  // budget, to delete files that are at least a day old. Tying it to `due` keeps
  // it frequent enough (the debounce is minutes, not days) at a fraction of the
  // cost, and needs no randomness to be reproducible.
  if (due) {
    try {
      const cutoff = now - 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (!/^claude-code-check-.*\.json$/.test(f)) continue;
        const p = path.join(os.tmpdir(), f);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* skip */ }
      }
    } catch {
      /* best-effort housekeeping only */
    }
  }

  if (!due) return 0;

  const list = touched.join(", ") + (more > 0 ? ` (+${more} more)` : "");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[CODE-CHECK] Code written this turn: ${list}. Before reporting ` +
          `done, run the code-check pass on it — re-read the real diff, make ` +
          `it actually run (paste real output), confirm non-trivial logic has ` +
          `one runnable check, and confirm every changed line traces to the ` +
          `request. Trivial edits: say so in one line and move on. ` +
          `(~/.claude/skills/code-check/SKILL.md)`,
      },
    }) + "\n"
  );
  return 0;
}

// self-test: fires on every Edit/Write, and stdout must be the additionalContext
// envelope — a plain print here reaches the debug log, not the model.
function runCanary() {
  const { spawnSync } = require("child_process");
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log("  FAIL: " + d); } };
  const fire = (ev) => spawnSync(process.execPath, [__filename], {
    input: JSON.stringify(ev), encoding: "utf8",
  });
  const sid = "canary-" + process.pid;
  const ev = (file, session) => ({ session_id: session || sid, tool_input: { file_path: file } });

  let r = fire(ev("C:/tmp/thing.js"));
  const out = (r.stdout || "").trim();
  check(out.includes("additionalContext"), "emits the additionalContext envelope (not a bare print)");
  check(out.includes("hookEventName"), "declares hookEventName");
  check(out.includes("thing.js"), "names the file that was written");

  // second edit inside the debounce window must stay quiet
  r = fire(ev("C:/tmp/other.js"));
  check((r.stdout || "").trim() === "", "debounced: a burst nudges once");

  check((fire(ev("C:/tmp/notes.md")).stdout || "").trim() === "", "docs are not code -> silent");
  check((fire(ev("C:/tmp/data.json")).stdout || "").trim() === "", "config is not code -> silent");
  check((fire({ session_id: sid }).stdout || "").trim() === "", "missing file_path -> silent");
  r = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
  check(r.status === 0, "malformed stdin never blocks the tool call");

  try {
    const os = require("os");
    fs.unlinkSync(path.join(os.tmpdir(), `claude-code-check-${sid}.json`));
  } catch { /* already pruned */ }

  const ok = fail === 0;
  console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
  return ok;
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
process.exit(main());
