#!/usr/bin/env node
/*
 * decision-log — append a dated decision line.
 * The lightweight per-decision line, NOT the project record: this writes one
 * timestamped line to a plain DECISIONS.md; it never touches an append-only
 * project record or a handoff snapshot (that belongs to a project-memory
 * system). Its output line is paste-ready FOR a record entry.
 *
 *   add "<decision>" [--why "<reason>"] [--file DECISIONS.md]
 *       reads the REAL system clock at runtime (never caller-supplied),
 *       appends "- YYYY-MM-DD HH:MM <ZONE> — decided: <decision>"
 *       plus " (why: <reason>)" when --why is given.
 *   list [--file DECISIONS.md]   print every entry line.
 *   --canary                     self-test (the done-check); both directions.
 *
 * Zone labelling is driven by the ZONES const below (defaults to US Central:
 * UTC-6 -> CST, UTC-5 -> CDT); any offset not listed prints "UTC±H:MM"
 * literally. Timestamp comes ONLY from new Date() at runtime, never from an
 * argument. Append-only: existing lines are never rewritten; a missing file is
 * created with a one-line header.
 *
 * Exit codes: 0 ok · 1 (reserved: canary fail) · 2 usage error (missing decision
 * text, or an unwritable/invalid --file path — ENOENT/EISDIR/EACCES).
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = "DECISIONS.md";
const HEADER = "# Decision Log — one dated line per decision (append-only; not the project record)";

// Zone labels by getTimezoneOffset() minutes — defaults to US Central.
// getTimezoneOffset() returns minutes to ADD to local time to reach UTC, so a
// zone BEHIND UTC has a POSITIVE offset: UTC-6 (CST) -> 360, UTC-5 (CDT) -> 300.
// Edit this map for your timezone (e.g. {0:"UTC"}, {480:"PST",420:"PDT"}); any
// offset not listed here prints a literal UTC±H:MM label instead.
const ZONES = { 360: "CST", 300: "CDT" };

// ---- helpers ---------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, "0"); }

// Label the zone from the clock's UTC offset via the ZONES map above.
function zoneLabel(d) {
  const off = d.getTimezoneOffset(); // minutes; positive = behind UTC
  if (ZONES[off]) return ZONES[off];
  const sign = off > 0 ? "-" : "+"; // behind UTC prints as minus
  const abs = Math.abs(off);
  return `UTC${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
}

// "- YYYY-MM-DD HH:MM <ZONE> — decided: <decision>" [" (why: <reason>)"]
function formatLine(d, decision, why) {
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${zoneLabel(d)}`;
  let line = `- ${stamp} — decided: ${decision}`;
  if (why) line += ` (why: ${why})`;
  return line;
}

function resolveFile(file) {
  const f = file || DEFAULT_FILE;
  return path.isAbsolute(f) ? f : path.join(process.cwd(), f);
}

// ---- commands --------------------------------------------------------------
function cmdAdd(decision, why, file) {
  if (!decision || !decision.trim()) {
    console.error('error: add needs decision text — add "<decision>" [--why "<reason>"]');
    return 2;
  }
  const fp = resolveFile(file);
  const line = formatLine(new Date(), decision.trim(), why ? why.trim() : null);
  try {
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, HEADER + "\n\n" + line + "\n", "utf8"); // create with header
    } else {
      const cur = fs.readFileSync(fp, "utf8");
      const sep = cur.length && !cur.endsWith("\n") ? "\n" : "";
      fs.appendFileSync(fp, sep + line + "\n", "utf8"); // append-only, never rewrite
    }
  } catch (e) {
    console.error(`error: cannot write decision log at ${fp}: ${e.code || e.message}`);
    return 2;
  }
  console.log(line); // paste-ready for a record entry
  return 0;
}

function cmdList(file) {
  const fp = resolveFile(file);
  if (!fs.existsSync(fp)) { console.error(`error: no decision log at ${fp}`); return 2; }
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch (e) {
    console.error(`error: cannot read decision log at ${fp}: ${e.code || e.message}`);
    return 2;
  }
  const lines = raw.split("\n").filter((l) => l.startsWith("- "));
  if (!lines.length) { console.log("(no decisions logged yet)"); return 0; }
  for (const l of lines) console.log(l);
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Both directions in a throwaway temp file: a valid add writes a well-formed
// line matching the CURRENT clock/zone, --why is present only when given, a
// second add appends without disturbing the first, and missing text exits 2.
function runCanary() {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-log-canary-"));
  const file = path.join(dir, "DECISIONS.md");
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  try {
    // Independent expectation for date + zone from the SAME rule, computed here.
    const now = new Date();
    const expDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const off = now.getTimezoneOffset();
    const expZone = ZONES[off] ||
      `UTC${off > 0 ? "-" : "+"}${Math.floor(Math.abs(off) / 60)}:${pad2(Math.abs(off) % 60)}`;

    // (a) first add with --why -> line parses, date/zone/why correct
    check(cmdAdd("freeze the release config", "output must stay byte-exact", file) === 0, "add returns 0");
    let all = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
    check(all.length === 1, "one entry after first add");
    const re = /^- (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) (\S+) — decided: (.+)$/;
    const m = all[0].match(re);
    check(!!m, "line matches the required format");
    check(m && m[1] === expDate, "date equals system date");
    check(m && m[4] === expZone, `zone label matches current offset (${expZone})`);
    check(m && /\(why: output must stay byte-exact\)$/.test(m[5]), "why-clause present when given");
    check(fs.readFileSync(file, "utf8").startsWith(HEADER), "file created with header");

    // (b) second add WITHOUT --why -> appends, first line untouched, no why-clause
    const firstBefore = all[0];
    check(cmdAdd("adopt trunk-based branching", null, file) === 0, "second add returns 0");
    all = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- "));
    check(all.length === 2, "two entries after second add");
    check(all[0] === firstBefore, "first line untouched by second add");
    check(!/\(why:/.test(all[1]), "no why-clause when --why omitted");

    // (c) missing decision text -> exit 2, no file mutation for a fresh file
    const empty = path.join(dir, "EMPTY.md");
    check(cmdAdd("", null, empty) === 2, "empty decision -> exit 2");
    check(cmdAdd("   ", null, empty) === 2, "whitespace decision -> exit 2");
    check(!fs.existsSync(empty), "no file written on usage error");

    // (d) unwritable/invalid --file path -> exit 2 (not an uncaught throw / exit 1)
    const badParent = path.join(dir, "nope", "D.md"); // nonexistent parent dir
    check(cmdAdd("x", null, badParent) === 2, "bad --file parent dir -> exit 2");
    check(cmdAdd("x", null, dir) === 2, "--file pointing at a directory -> exit 2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `decision-log — append a dated decision line (the lightweight per-decision line).

Usage:
  node decision-log.js add "<decision>" [--why "<reason>"] [--file DECISIONS.md]
  node decision-log.js list [--file DECISIONS.md]
  node decision-log.js --canary
  node decision-log.js --help

Writes "- YYYY-MM-DD HH:MM <ZONE> — decided: <decision>" (+ " (why: ...)" ) to
DECISIONS.md, append-only. Clock is the REAL system clock; zone is driven by the
ZONES map at the top of this file (default CST at UTC-6, CDT at UTC-5, else
literal UTC±H:MM). NOT the project record or a handoff — the printed line is
paste-ready for a project-memory record entry.

Exit codes: 0 ok · 1 canary fail · 2 usage error (missing decision text, or an
unwritable/invalid --file path).`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP); process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.includes("--canary")) process.exit(runCanary());

  const file = getOpt(argv, "--file");
  const sub = argv[0];

  if (sub === "add") {
    const decision = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
    process.exit(cmdAdd(decision, getOpt(argv, "--why"), file));
  }
  if (sub === "list") process.exit(cmdList(file));

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
