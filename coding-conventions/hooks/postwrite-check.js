#!/usr/bin/env node
/*
 * coding-conventions — post-write injection hook (PostToolUse, matcher "Edit|Write").
 *
 * After Claude edits or writes a CODE file, injects coding-conventions/SKILL.md's
 * BODY (the four rules + the verification pass) as additionalContext. Formerly
 * code-check's hook, which injected a one-sentence nudge; now the rules
 * themselves ride along, because at high context the copy at the top of
 * CLAUDE.md is no longer being read. Firing is deterministic; following the
 * rules is still the model's job — a hook cannot invoke a skill.
 *
 * PostToolUse stdout is NOT shown to the model as plain text (it goes to the
 * debug log). Context must be returned as JSON on stdout:
 *   {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}
 *
 * Debounced to at most one injection per DEBOUNCE_MS per session, so a burst
 * of edits injects once instead of once per file. Files edited while
 * suppressed are accumulated and named in the next injection. State:
 * <tmp>/claude-code-check-<session>.json (prefix kept from code-check so a
 * session that straddled the rename keeps its debounce window).
 *
 * Off for a session: CODING_CONVENTIONS_OFF=1 (CODE_CHECK_OFF=1 still honoured).
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
const SKILL = path.join(__dirname, "..", "SKILL.md");

// Extensions that count as code. Docs/config (.md .json .yaml .toml .txt)
// deliberately excluded — editing those needs no run-check.
const CODE_EXT = new Set([
  ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs",
  ".java", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift",
  ".kt", ".sh", ".bash", ".ps1", ".sql", ".ipynb",
]);

// If SKILL.md is unreadable the hook still says SOMETHING — a silent hook is
// a failure mode seen in practice (a broken registered path, exit 0, nothing).
const FALLBACK =
  "run the coding-conventions pass — re-read the real diff, make it actually " +
  "run (paste real output), one runnable check behind non-trivial logic, every " +
  "changed line traces to the request. Trivial edits: say so in one line.";

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// SKILL.md minus its YAML frontmatter; `file` is a parameter so the canary can
// exercise the missing-file path without touching the real SKILL.md.
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
  if (process.env.CODING_CONVENTIONS_OFF || process.env.CODE_CHECK_OFF) return 0;

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
    /* best-effort; a failed write just means the next edit re-injects */
  }

  // Prune stale per-session state files — only when DUE, because this walks
  // the whole of %TEMP% (thousands of entries) inside a 5-second hook budget.
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
  const body = skillBody();
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `[CODING-CONVENTIONS] Code written this turn: ${list}. Before reporting done, ` +
          (body ? `apply these rules to it:\n${body}` : FALLBACK),
      },
    }) + "\n"
  );
  return 0;
}

// self-test: fires on every Edit/Write of code, and stdout must be the
// additionalContext envelope carrying the real rules.
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
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* checked below */ }
  const ctx = (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || "";
  check(/Surgical changes only/.test(ctx), "injects rule 1 from the real SKILL.md");
  check(/Verify before claiming done/.test(ctx), "injects rule 4 from the real SKILL.md");
  check(/ran: <command>/.test(ctx), "injects the report block");
  check(!/^---/m.test(ctx), "frontmatter is stripped from the injection");

  // second edit inside the debounce window must stay quiet
  r = fire(ev("C:/tmp/other.js"));
  check((r.stdout || "").trim() === "", "debounced: a burst injects once");

  check((fire(ev("C:/tmp/notes.md")).stdout || "").trim() === "", "docs are not code -> silent");
  check((fire(ev("C:/tmp/data.json")).stdout || "").trim() === "", "config is not code -> silent");
  check((fire({ session_id: sid }).stdout || "").trim() === "", "missing file_path -> silent");
  r = spawnSync(process.execPath, [__filename], { input: "not json", encoding: "utf8" });
  check(r.status === 0, "malformed stdin never blocks the tool call");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-canary-"));
  try {
    let threw = false, got = "sentinel";
    try { got = skillBody(path.join(tmp, "missing.md")); } catch { threw = true; }
    check(!threw && got === null, "a missing SKILL.md returns null (fallback text path) instead of throwing");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  try {
    fs.unlinkSync(path.join(os.tmpdir(), `claude-code-check-${sid}.json`));
  } catch { /* already pruned */ }

  const ok = fail === 0;
  console.log(`CANARY ${ok ? "PASS" : "FAIL"} ${pass}/${pass + fail}`);
  return ok;
}

if (process.argv.includes("--canary")) process.exit(runCanary() ? 0 : 1);
process.exit(main());
