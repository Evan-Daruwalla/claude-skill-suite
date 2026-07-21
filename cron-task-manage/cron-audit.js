#!/usr/bin/env node
/*
 * cron-audit — Windows scheduled-task auditor. READ-ONLY EXECUTION, ALWAYS.
 * The ONLY thing this tool ever shells out to is `schtasks /query` (see runQuery,
 * the single spawnSync site). It NEVER runs /create, /delete, or /change — plan
 * mode PRINTS the exact schtasks /create line for you to run yourself.
 *
 *   audit [--all|--like <substr>] [--fixture <csv>]   query + flag unhealthy tasks
 *   plan --name <n> --schedule <SPEC> --command "<c>"  PRINT a /create line (no exec)
 *   --canary                                           self-test (the done-check)
 *
 * Audit flags, per task: Last Result != 0 (shows the code), Disabled state, and —
 * for an ENABLED task only — a Next Run Time that is 'N/A' or already in the past.
 * Default scope excludes \Microsoft\ tasks; --all widens, --like <substr> narrows.
 * --fixture parses a saved `schtasks /query /fo csv /v` capture offline (no shell).
 *
 * Exit codes: 0 clean · 1 flags found / canary-fail · 2 usage error.
 * Zero dependencies, Node >=16, Windows (schtasks).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCHEDULE_TYPES = ["MINUTE", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "ONCE", "ONSTART", "ONLOGON", "ONIDLE"];

// ---- helpers ---------------------------------------------------------------

// RFC4180-ish CSV parse: quoted fields, embedded commas/newlines, "" escapes,
// CRLF tolerated. Returns an array of rows (each an array of string fields).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* swallow — CRLF */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// index of a header column by exact (case-insensitive, trimmed) name; -1 if absent.
function colIndex(header, name) {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

// Last Result is a status code — 0 (or 0x0) is success, anything else a failure.
// Handles both decimal (real schtasks) and 0x-hex (how fixtures are captured).
function resultFails(raw) {
  const s = (raw || "").trim();
  if (s === "") return false; // blank/unknown — don't invent a failure
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  return !Number.isNaN(n) && n !== 0;
}

// next-run problems only matter for an ENABLED task (Disabled legitimately shows N/A).
function nextRunFlag(isDisabled, nextRaw) {
  if (isDisabled) return null;
  const s = (nextRaw || "").trim();
  if (s === "" || /^n\/a$/i.test(s)) return "next-run N/A (enabled)";
  const t = Date.parse(s); // runtime clock compare — live logic, never baseline content
  if (!Number.isNaN(t) && t < Date.now()) return "next-run in past: " + s;
  return null;
}

// ---- audit core ------------------------------------------------------------

// Turn parsed CSV rows into task objects, applying the scope filter.
// opts: { all:bool, like:string|null }
function tasksFromCsv(csvText, opts) {
  const rows = parseCsv(csvText).filter((r) => r.length > 1);
  if (!rows.length) return { tasks: [], missing: [] };
  const header = rows[0];
  const iName = colIndex(header, "TaskName");
  if (iName < 0) throw new Error("no 'TaskName' column — not a `schtasks /query /fo csv /v` capture?");
  const iNext = colIndex(header, "Next Run Time");
  const iStatus = colIndex(header, "Status");
  const iResult = colIndex(header, "Last Result");
  const iState = colIndex(header, "Scheduled Task State");
  const iRun = colIndex(header, "Task To Run");

  const get = (r, i) => (i >= 0 && i < r.length ? r[i] : "");
  const tasks = [];
  for (let k = 1; k < rows.length; k++) {
    const r = rows[k];
    const name = get(r, iName).trim();
    if (!name || name.toLowerCase() === "taskname") continue; // skip repeated header rows
    if (!opts.all && /^\\microsoft\\/i.test(name)) continue; // default: hide OS tasks
    if (opts.like && !name.toLowerCase().includes(opts.like.toLowerCase())) continue;
    // schtasks emits some "Task To Run" commands with UNescaped commas (e.g. a
    // powershell mouse_event(a, b, c) line) — that row gains extra fields and every
    // column past "Task To Run" shifts. TaskName/Status/Last Result sit at low,
    // pre-shift indices and stay correct; "Scheduled Task State" (far right) does
    // not, so on a field-count mismatch we ignore it and read disabled from Status
    // (verified to report "Disabled" identically on well-formed rows).
    const malformed = r.length !== header.length;
    const status = get(r, iStatus).trim();
    const state = malformed ? "" : get(r, iState).trim();
    const disabled = /disabled/i.test(state) || /disabled/i.test(status);
    tasks.push({
      name,
      disabled,
      state: state || status || "?",
      result: get(r, iResult).trim(),
      next: get(r, iNext).trim(),
      run: get(r, iRun).trim(),
    });
  }
  return { tasks };
}

function evaluate(t) {
  const flags = [];
  if (resultFails(t.result)) flags.push(`Last Result ${t.result}`);
  if (t.disabled) flags.push("Disabled");
  const nr = nextRunFlag(t.disabled, t.next);
  if (nr) flags.push(nr);
  return flags;
}

// Returns { rows:[{name,state,result,next,flags[]}], flaggedCount }.
function auditCore(csvText, opts) {
  const { tasks } = tasksFromCsv(csvText, opts);
  let flaggedCount = 0;
  const rows = tasks.map((t) => {
    const flags = evaluate(t);
    if (flags.length) flaggedCount++;
    return { name: t.name, state: t.disabled ? "Disabled" : t.state, result: t.result || "-", next: t.next || "-", flags };
  });
  return { rows, flaggedCount };
}

function printTable(rows) {
  if (!rows.length) { console.log("(no tasks in scope — try --all, or widen --like)"); return; }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);
  console.log(`${clip("TASK", 40)}  ${clip("STATE", 10)}  ${clip("RESULT", 10)}  ${clip("NEXT RUN", 22)}  FLAGS`);
  for (const r of rows) {
    const mark = r.flags.length ? "!" : " ";
    console.log(`${mark}${clip(r.name, 39)}  ${clip(r.state, 10)}  ${clip(r.result, 10)}  ${clip(r.next, 22)}  ${r.flags.join("; ")}`);
  }
}

// ---- the ONLY shell-out: schtasks /query (read-only) -----------------------
function runQuery() {
  // Hard invariant: this tool never spawns any schtasks verb but /query.
  const args = ["/query", "/fo", "csv", "/v"];
  if (args[0] !== "/query") throw new Error("refusing non-query schtasks call"); // belt-and-suspenders
  const r = spawnSync("schtasks", args, { encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true });
  return r; // caller inspects r.error / r.status / r.stdout
}

// ---- commands --------------------------------------------------------------
function cmdAudit(opts) {
  let csv;
  if (opts.fixture) {
    if (!fs.existsSync(opts.fixture)) { console.error(`error: fixture not found: ${opts.fixture}`); return 2; }
    csv = fs.readFileSync(opts.fixture, "utf8");
  } else {
    const r = runQuery();
    if (r.error) { console.error("error: could not run schtasks (" + r.error.code + ") — Windows only, or schtasks not on PATH"); return 2; }
    if (r.status !== 0 && !r.stdout) { console.error("error: schtasks /query failed: " + (r.stderr || "").trim()); return 2; }
    csv = r.stdout || "";
  }
  let res;
  try { res = auditCore(csv, opts); }
  catch (e) { console.error("error: " + e.message); return 2; }
  printTable(res.rows);
  const scope = opts.all ? "all" : opts.like ? `like "${opts.like}"` : "non-Microsoft";
  if (res.flaggedCount) {
    console.error(`\n${res.flaggedCount} flagged / ${res.rows.length} in scope (${scope})`);
    return 1;
  }
  console.log(`\nclean — 0 flagged / ${res.rows.length} in scope (${scope})`);
  return 0;
}

// PLAN MODE: build the /create line as TEXT. Never spawns anything.
function cmdPlan(opts) {
  if (!opts.name || !opts.schedule || !opts.command) {
    console.error('error: plan needs --name <n> --schedule <TYPE[@HH:MM]> --command "<cmd>"');
    return 2;
  }
  const [typeRaw, time] = opts.schedule.split("@");
  const type = (typeRaw || "").trim().toUpperCase();
  if (!SCHEDULE_TYPES.includes(type)) {
    console.error(`error: unknown schedule type '${type}' — one of ${SCHEDULE_TYPES.join("/")} (append @HH:MM for a time)`);
    return 2;
  }
  if (opts.command.includes('"')) {
    console.error('error: --command contains a double quote — schtasks /tr quoting gets ambiguous; simplify the command or edit the printed line by hand');
    return 2;
  }
  let line = `schtasks /create /tn "${opts.name}" /tr "${opts.command}" /sc ${type}`;
  if (time && time.trim()) line += ` /st ${time.trim()}`;
  console.log("# cron-audit does NOT run this. Copy, review, and run it yourself:");
  console.log(line);
  console.log("# (WEEKLY/MONTHLY: append /d MON or /mo 1 as needed. Then re-run `cron-audit audit` to confirm it registered.)");
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Both directions in a throwaway temp dir: a mixed fixture yields exactly 2 flags
// (a failing Last Result + a Disabled task) exit 1, a healthy-only fixture yields
// 0 flags exit 0. Next-run dates are fixed (far-future / year-2020) so the result
// is clock-independent. Plus a live smoke: real `schtasks /query` parses to >= 0
// tasks (or schtasks is absent, off-Windows) — never crashes.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-audit-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  const H = '"HostName","TaskName","Next Run Time","Status","Last Run Time","Last Result","Task To Run","Scheduled Task State"';
  try {
    // mixed: 1 healthy, 1 failing (0x1), 1 disabled  -> exactly 2 flagged, exit 1
    const mixed =
      H + "\r\n" +
      '"PC","\\Backup\\monthly_rebalance","1/1/2099 3:00:00 AM","Ready","1/1/2026 3:00:00 AM","0","rebalance.bat","Enabled"\r\n' +
      '"PC","\\Backup\\nightly_sync","1/1/2099 2:00:00 AM","Ready","1/1/2026 2:00:00 AM","0x1","sync.bat","Enabled"\r\n' +
      '"PC","\\Backup\\old_report","N/A","Disabled","1/1/2026 1:00:00 AM","0","report.bat","Disabled"\r\n';
    const fm = path.join(root, "mixed.csv");
    fs.writeFileSync(fm, mixed);
    const rm = auditCore(fs.readFileSync(fm, "utf8"), { all: false, like: null });
    check(rm.flaggedCount === 2, `mixed fixture flags exactly 2 (got ${rm.flaggedCount})`);
    check(cmdAudit({ fixture: fm, all: false, like: null }) === 1, "mixed fixture audit exit 1");

    // healthy-only -> 0 flagged, exit 0
    const healthy =
      H + "\r\n" +
      '"PC","\\Backup\\monthly_rebalance","1/1/2099 3:00:00 AM","Ready","1/1/2026 3:00:00 AM","0","rebalance.bat","Enabled"\r\n';
    const fh = path.join(root, "healthy.csv");
    fs.writeFileSync(fh, healthy);
    const rh = auditCore(fs.readFileSync(fh, "utf8"), { all: false, like: null });
    check(rh.flaggedCount === 0, `healthy fixture flags 0 (got ${rh.flaggedCount})`);
    check(cmdAudit({ fixture: fh, all: false, like: null }) === 0, "healthy fixture audit exit 0");

    // past next-run on an ENABLED task flags (clock-independent: now > 2020)
    const pastCsv =
      H + "\r\n" +
      '"PC","\\Backup\\stale","1/1/2020 3:00:00 AM","Ready","1/1/2020 3:00:00 AM","0","x.bat","Enabled"\r\n';
    check(auditCore(pastCsv, { all: false, like: null }).flaggedCount === 1, "past enabled next-run flags");

    // scope: \Microsoft\ hidden by default, shown with --all
    const msCsv =
      H + "\r\n" +
      '"PC","\\Microsoft\\Windows\\Foo\\Bar","N/A","Ready","N/A","0","x","Enabled"\r\n' +
      '"PC","\\MyTask","1/1/2099 3:00:00 AM","Ready","1/1/2026","0","x","Enabled"\r\n';
    check(auditCore(msCsv, { all: false, like: null }).rows.length === 1, "default scope hides \\Microsoft\\");
    check(auditCore(msCsv, { all: true, like: null }).rows.length === 2, "--all shows \\Microsoft\\");

    // CSV parser: a quoted field with an embedded comma stays one field
    const commaRows = parseCsv('"a,b","c"\r\n"d","e,f"\r\n');
    check(commaRows[0].length === 2 && commaRows[0][0] === "a,b" && commaRows[1][1] === "e,f", "quoted embedded commas parse correctly");

    // real schtasks quirk: an UNescaped-comma "Task To Run" shifts the far-right
    // columns. Low-index fields (TaskName/Status/Last Result) must survive, and
    // state must fall back to Status instead of showing shifted garbage.
    const malCsv = H + "\r\n" +
      '"PC","\\Backup\\jiggle","1/1/2099 3:00:00 AM","Ready","1/1/2026","0x1",powershell -c foo(a, b, c),"Enabled"\r\n';
    const rmal = auditCore(malCsv, { all: false, like: null });
    check(rmal.rows.length === 1 && rmal.rows[0].flags.length === 1 && /Last Result 0x1/.test(rmal.rows[0].flags[0]),
      "shift-corrupted row: low-index Last Result survives and flags");
    check(rmal.rows[0].state === "Ready", "shift-corrupted row: state falls back to Status, not shifted garbage");

    // value-taking flag present but valueless (last token, or followed by a --flag)
    // must be caught, NOT silently fall through to a live query / no-op filter.
    check(flagMissingValue(["audit", "--fixture"], "--fixture") === true, "--fixture as last token -> missing value");
    check(flagMissingValue(["audit", "--fixture", "--all"], "--fixture") === true, "--fixture followed by --flag -> missing value");
    check(flagMissingValue(["audit", "--like"], "--like") === true, "--like as last token -> missing value");
    check(flagMissingValue(["audit", "--fixture", "f.csv"], "--fixture") === false, "--fixture with a value -> ok");
    check(flagMissingValue(["audit", "--all"], "--fixture") === false, "--fixture absent -> not flagged");

    // plan mode PRINTS and returns 0 (and never spawns — see single runQuery site)
    check(cmdPlan({ name: "t", schedule: "DAILY@03:00", command: "run.bat" }) === 0, "plan valid -> 0");
    check(cmdPlan({ name: "t", schedule: "NOPE", command: "run.bat" }) === 2, "plan bad schedule -> 2");

    // live smoke: real /query parses (>= 0 tasks) OR schtasks is unavailable
    const r = runQuery();
    if (r.error) {
      console.error("  note: schtasks unavailable (" + r.error.code + ") — live smoke skipped, off-Windows");
      check(true, "live smoke (schtasks absent — tolerated)");
    } else {
      let n = -1;
      try { n = auditCore(r.stdout || "", { all: true, like: null }).rows.length; } catch (e) { /* n stays -1 */ }
      check(n >= 0, `live schtasks /query parses to >= 0 tasks (got ${n})`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `cron-audit — Windows scheduled-task auditor. READ-ONLY: only ever runs schtasks /query.

Usage:
  node cron-audit.js [audit] [--all | --like <substr>] [--fixture <csv>]
  node cron-audit.js plan --name <name> --schedule <TYPE[@HH:MM]> --command "<cmd>"
  node cron-audit.js --canary
  node cron-audit.js --help

audit (default): query tasks and flag  Last Result != 0 · Disabled · (enabled only)
  Next Run Time that is N/A or in the past. Scope defaults to non-Microsoft tasks;
  --all includes \\Microsoft\\, --like <substr> narrows by name. --fixture parses a
  saved  schtasks /query /fo csv /v  capture offline. Exit 1 if anything is flagged.

plan: PRINTS the exact  schtasks /create  line for you to review and run yourself.
  This tool NEVER executes /create, /delete, or /change. Schedule TYPE is one of
  ${SCHEDULE_TYPES.join("/")}; append @HH:MM for a start time (e.g. WEEKLY@03:00).

Exit codes: 0 clean · 1 flags found / canary-fail · 2 usage error.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// A value-taking flag present but missing its value: either it's the last token,
// or the next token is itself a --flag. Returns true only when the flag IS present
// but has no usable value — so callers can error (exit 2) instead of silently
// falling through to a live query / no-op filter with the flag ignored.
function flagMissingValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return false; // absent — not this flag's problem
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); process.exit(0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "audit";
  if (sub === "plan") {
    for (const f of ["--name", "--schedule", "--command"]) {
      if (flagMissingValue(argv, f)) { console.error(`error: ${f} requires a value`); process.exit(2); }
    }
    process.exit(cmdPlan({ name: getOpt(argv, "--name"), schedule: getOpt(argv, "--schedule"), command: getOpt(argv, "--command") }));
  }
  if (sub === "audit") {
    for (const f of ["--like", "--fixture"]) {
      if (flagMissingValue(argv, f)) { console.error(`error: ${f} requires a ${f === "--fixture" ? "path" : "value"}`); process.exit(2); }
    }
    process.exit(cmdAudit({ all: argv.includes("--all"), like: getOpt(argv, "--like"), fixture: getOpt(argv, "--fixture") }));
  }
  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
