#!/usr/bin/env node
/*
 * milestone-track — READ-ONLY roadmap status rollup for a PRD/roadmap doc.
 * Parses PRD_ROADMAP.md (or any --file) and rolls up completion per milestone:
 * markdown checkboxes "- [ ]"/"- [x]", table-cell glyphs ☐/☑, ~~struck~~ items
 * (counted separately as dropped/folded — NEVER as open), and milestone headings
 * ("## N.", "### M...", rows of a MILESTONES table). Fork-aware: if a
 * "## CURRENT DIRECTION" heading exists, DEFAULT scope is that fork section only
 * (heading → EOF); --all rolls up the whole file. The output always names which
 * scope was used.
 *
 *   [--file <path>]   roadmap to read (default PRD_ROADMAP.md in cwd)
 *   [--all]           ignore the fork; roll up the entire file
 *   --canary          self-test (the done-check); asserts counts + fork scoping
 *
 * Reports: per-milestone done/open/struck, overall % (done / (done+open),
 * struck excluded), and the FIRST open item as "next:". It is a REPORT, not a
 * gate — it never edits the PRD and exits 0 even with open work. Exit 2 only on
 * a usage/parse error (bad flag, missing/unreadable file).
 *
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");

// A milestone label: leading section id like 1 / F1 / M1 / F-M0 / M-M0.
// Anchored at start of the heading/cell text; trailing dots stripped by caller.
const LABEL_RE = /^([A-Za-z]{0,3}-?M?-?\d[A-Za-z0-9.-]*)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_ROW_RE = /^\s*\|(.*)\|\s*$/;
const SEP_CELL_RE = /^:?-{2,}:?$/;              // markdown table separator cell
const CHECKBOX_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const STRUCK_RE = /~~.+?~~/;                     // strikethrough span (anywhere)
// Whole-body strike: the entire description is one struck span, optionally
// followed by a trailing dated/parenthetical note (e.g. "~~old~~ (dropped …)").
const WHOLE_STRUCK_RE = /^~~.+?~~\s*(?:[(（].*)?$/;
const FORK_RE = /^##\s+CURRENT DIRECTION\b/i;
const NEXT_MAX = 90;                             // truncate the next-item preview

// ---- helpers ---------------------------------------------------------------
function labelOf(text) {
  const m = LABEL_RE.exec(text);
  if (!m) return null;
  return m[1].replace(/\.+$/, ""); // "1." -> "1", "F1." -> "F1"
}

function isStruck(s) { return STRUCK_RE.test(s); }

function splitCells(inner) {
  // inner is the text between the outer pipes; split and trim each cell.
  return inner.split("|").map((c) => c.trim());
}

// ---- core: compute the rollup ----------------------------------------------
// Returns { scopeLabel, forkFound, milestones:[{label,name,line,done,open,struck}],
//           totals:{done,open,struck}, next:{line,text}|null }
function compute(text, opts) {
  const lines = text.split(/\r?\n/);
  const forkIdx = lines.findIndex((l) => FORK_RE.test(l));
  const forkFound = forkIdx >= 0;

  let startIdx = 0, scopeLabel;
  if (forkFound && !opts.all) {
    startIdx = forkIdx;
    scopeLabel = "CURRENT DIRECTION fork (line " + (forkIdx + 1) + " → EOF)";
  } else if (forkFound) {
    scopeLabel = "entire file (--all; fork present but overridden)";
  } else {
    scopeLabel = "entire file (no CURRENT DIRECTION fork found)";
  }

  const order = [];                 // milestone labels in first-seen order
  const byLabel = new Map();        // label -> milestone record
  const PREAMBLE = "(preamble)";
  let current = null;               // current milestone record (or null => preamble)
  let inMilestonesTable = false;    // current heading section is a MILESTONES table

  function milestone(label, name, lineNo) {
    let m = byLabel.get(label);
    if (!m) {
      m = { label, name: name || "", line: lineNo, done: 0, open: 0, struck: 0 };
      byLabel.set(label, m);
      order.push(label);
    } else if (!m.name && name) {
      m.name = name; // fill in a name from whichever marker carried it
    }
    return m;
  }
  function bucket() {
    if (current) return current;
    return milestone(PREAMBLE, "", 0); // synthetic bucket for items before any milestone
  }

  let next = null;
  function record(kind, lineNo, preview) {
    const b = bucket();
    if (kind === "struck") b.struck++;
    else if (kind === "done") b.done++;
    else { // open
      b.open++;
      if (!next) next = { line: lineNo, text: preview };
    }
  }

  for (let i = startIdx; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // headings first — they set the current milestone / section context.
    const h = HEADING_RE.exec(raw);
    if (h) {
      const level = h[1].length, htext = h[2];
      if (FORK_RE.test(raw)) { current = null; inMilestonesTable = false; continue; }
      inMilestonesTable = /milestone/i.test(htext);
      if (level >= 2 && level <= 3) {
        const label = labelOf(htext);
        if (label) current = milestone(label, htext, lineNo);
      }
      continue;
    }

    // table rows: milestone declarations (in a MILESTONES table) or glyph items.
    const tr = TABLE_ROW_RE.exec(raw);
    if (tr) {
      const cells = splitCells(tr[1]);
      const nonEmpty = cells.filter((c) => c !== "");
      if (nonEmpty.length && nonEmpty.every((c) => SEP_CELL_RE.test(c))) continue; // separator
      if (inMilestonesTable) {
        // a MILESTONES-table data row DECLARES a milestone (first cell = id).
        const label = cells.length ? labelOf(cells[0]) : null;
        if (label) current = milestone(label, cells[1] || "", lineNo);
      }
      // count any status glyphs present in the row's cells (either table kind).
      for (const c of cells) {
        if (c.includes("☑")) record(isStruck(c) ? "struck" : "done", lineNo, raw.trim().slice(0, NEXT_MAX));
        else if (c.includes("☐")) record(isStruck(c) ? "struck" : "open", lineNo, raw.trim().slice(0, NEXT_MAX));
      }
      continue;
    }

    // checkbox list items.
    const cb = CHECKBOX_RE.exec(raw);
    if (cb) {
      const checked = cb[1] !== " ", body = cb[2];
      // Checkbox STATE is authoritative: an inline "~~…~~" inside an open item's
      // wording ("- [ ] migrate off ~~v1~~ endpoints") stays OPEN. Treat the item
      // as struck only when the ENTIRE body is one struck span (+ optional note).
      if (WHOLE_STRUCK_RE.test(body.trim())) record("struck", lineNo, body.slice(0, NEXT_MAX));
      else record(checked ? "done" : "open", lineNo, body.slice(0, NEXT_MAX));
      continue;
    }

    // a struck plain bullet (no checkbox) counts as dropped/folded.
    const bulletStruck = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bulletStruck && isStruck(bulletStruck[1])) record("struck", lineNo, bulletStruck[1].slice(0, NEXT_MAX));
  }

  const milestones = order.map((l) => byLabel.get(l)).filter((m) => m.done + m.open + m.struck > 0);
  const totals = milestones.reduce((t, m) => ({ done: t.done + m.done, open: t.open + m.open, struck: t.struck + m.struck }),
    { done: 0, open: 0, struck: 0 });
  return { scopeLabel, forkFound, milestones, totals, next };
}

function pct(done, open) {
  const denom = done + open;
  return denom === 0 ? "n/a" : (100 * done / denom).toFixed(1) + "%";
}

// ---- report ----------------------------------------------------------------
function report(file, res) {
  const out = [];
  out.push(`milestone-track — ${file}`);
  out.push(`scope: ${res.scopeLabel}` + (res.forkFound && !/entire/.test(res.scopeLabel) ? "  [use --all for the whole file]" : ""));
  out.push("");
  if (!res.milestones.length) {
    out.push("(no checkbox / glyph status items found in scope)");
  } else {
    const w = Math.max(...res.milestones.map((m) => m.label.length));
    for (const m of res.milestones) {
      const name = m.name ? "  " + m.name.replace(/\s+/g, " ").slice(0, 48) : "";
      out.push(`  ${m.label.padEnd(w)}  done ${String(m.done).padStart(3)}  open ${String(m.open).padStart(3)}  struck ${String(m.struck).padStart(3)}  ${pct(m.done, m.open).padStart(6)}${name}`);
    }
  }
  out.push("");
  const t = res.totals;
  out.push(`overall: ${t.done}/${t.done + t.open} done (${pct(t.done, t.open)})` + (t.struck ? `, ${t.struck} struck` : ""));
  out.push(res.next ? `next: L${res.next.line}  ${res.next.text}` : "next: (none — no open items in scope)");
  return out.join("\n");
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions on a bundled fixture: counts + next-item detection are
// exact, and DEFAULT (fork) scope differs from --all as designed. Confined to a
// throwaway temp dir.
const FIXTURE = `# Test PRD — canary fixture

## 3. SUCCESS CRITERIA
- [x] first done criterion
- [ ] an open criterion
- [x] ~~a struck criterion~~ (dropped 2026-07-21: folded above)

## 5. MILESTONES

| # | Milestone | Goal |
|---|---|---|
| M1 | Alpha | do alpha |
| M2 | Beta | do beta |

## 6. TASK BREAKDOWN

### M1 — Alpha
- [x] alpha task one
- [ ] alpha task two

### M2 — Beta
- [ ] beta task one

## CURRENT DIRECTION (forked 2026-07-21): the new plan

## F-M0 OUTPUT — ranked survivors

| # | name | built? |
|---|---|---|
| 1 | thing-a | ☑ 2026-07-21 |
| 2 | thing-b | ☐ |
| 3 | thing-c | ☐ |
`;

function runCanary() {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milestone-track-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  try {
    const fp = path.join(dir, "PRD_ROADMAP.md");
    fs.writeFileSync(fp, FIXTURE);
    const text = fs.readFileSync(fp, "utf8");

    // (a) DEFAULT scope = CURRENT DIRECTION fork → only the F-M0 glyph table.
    const def = compute(text, { all: false });
    check(def.forkFound === true, "fork detected");
    check(/CURRENT DIRECTION/.test(def.scopeLabel), "default scope names the fork");
    check(def.milestones.length === 1 && def.milestones[0].label === "F-M0", "default: exactly milestone F-M0");
    const fm0 = def.milestones[0];
    check(fm0.done === 1 && fm0.open === 2 && fm0.struck === 0, "default F-M0 counts 1/2/0");
    check(def.totals.done === 1 && def.totals.open === 2 && def.totals.struck === 0, "default totals 1/2/0");
    // next = first open glyph row (thing-b), NOT a SUCCESS-CRITERIA checkbox.
    check(def.next && /thing-b/.test(def.next.text), "default next = thing-b glyph row");

    // (b) --all scope = whole file → checkboxes + glyphs + struck across milestones.
    const all = compute(text, { all: true });
    const get = (l) => all.milestones.find((m) => m.label === l);
    check(get("3") && get("3").done === 1 && get("3").open === 1 && get("3").struck === 1, "all: milestone 3 = 1/1/1 (struck counted apart)");
    check(get("M1") && get("M1").done === 1 && get("M1").open === 1, "all: M1 = 1/1 (heading+table merged by label)");
    check(get("M2") && get("M2").open === 1, "all: M2 = 0/1");
    check(get("F-M0") && get("F-M0").done === 1 && get("F-M0").open === 2, "all: F-M0 = 1/2");
    check(all.totals.done === 3 && all.totals.open === 5 && all.totals.struck === 1, "all totals 3/5/1");
    // next = first open in doc order = the SUCCESS-CRITERIA open criterion.
    check(all.next && /an open criterion/.test(all.next.text), "all next = the open criterion");

    // (c) scoping genuinely DIFFERS between default and --all.
    check(def.totals.open !== all.totals.open, "default vs --all differ (open counts)");
    check(def.next.text !== all.next.text, "default vs --all differ (next item)");

    // (d) it is a REPORT, not a gate: render succeeds and struck never inflates done/open.
    check(typeof report("PRD_ROADMAP.md", all) === "string", "report renders");
    check(get("3").done + get("3").open === 2, "struck excluded from done/open denom");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `milestone-track — READ-ONLY roadmap status rollup (PRD conventions).

Usage:
  node milestone-track.js [--file <path>] [--all]
  node milestone-track.js --canary
  node milestone-track.js --help

Parses "- [ ]"/"- [x]" checkboxes, ☐/☑ table glyphs, and ~~struck~~ items
(counted as dropped/folded, never open), bucketed under milestone headings
("## N.", "### M...", MILESTONES-table rows). If a "## CURRENT DIRECTION"
heading exists, DEFAULT scope is that fork section (heading → EOF); --all rolls
up the whole file. The output names the scope used.

Reports per-milestone done/open/struck, overall % (struck excluded), and the
FIRST open item as "next:". Read-only; never edits the PRD.

Exit codes: 0 always (it's a report) · 2 usage/parse error (bad flag, missing file).`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); process.exit(0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const known = new Set(["--file", "--all"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) { console.error("error: --file requires a path. Try --help."); process.exit(2); }
      i++; continue;                               // consume its value
    }
    if (a.startsWith("--") && !known.has(a)) { console.error(`error: unknown flag '${a}'. Try --help.`); process.exit(2); }
    if (!a.startsWith("--")) { console.error(`error: unexpected argument '${a}'. Try --help.`); process.exit(2); }
  }

  const file = getOpt(argv, "--file") || "PRD_ROADMAP.md";
  const fp = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  let text;
  try { text = fs.readFileSync(fp, "utf8"); }
  catch (e) { console.error(`error: cannot read '${file}': ${e.code || e.message}`); process.exit(2); }

  const res = compute(text, { all: argv.includes("--all") });
  console.log(report(file, res));
  process.exit(0);
}
main();
