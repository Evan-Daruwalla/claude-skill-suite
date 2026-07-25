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

process.exit(main());
