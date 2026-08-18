#!/usr/bin/env node
/*
 * run-all-canaries — execute every bundled `--canary` self-test in a skills tree.
 *
 * The suite ships ~16 canaries and nothing ever ran them, so a skill could rot
 * silently: bisect-driver sat at CANARY FAIL 8/11 in both the live and the
 * published copy until an audit ran it by hand. This is the missing runner.
 *
 *   node run-all-canaries.js [skills-root]              (default root: ~/.claude/skills)
 *   node run-all-canaries.js [skills-root] --write-pin  record this tree's count
 *   node run-all-canaries.js [skills-root] --expect <n> one-off override
 *
 * A pin is how many canaries the tree SHOULD hold, so a tree that lost half its
 * skills fails instead of reporting a confident "N/N passed".
 *
 * PINS LIVE IN canary-pins.json, NOT IN THIS COMMENT. They used to live here, as
 * prose, which meant nothing read them: enforcing a count required remembering to
 * type --expect, and updating one required remembering this block existed. Both
 * were forgotten three times in four days, across three different trees — twice
 * by the same person who had just finished fixing the previous instance. The pins
 * are now data, applied automatically when --expect is omitted, so the BARE
 * command is the enforced one. Adding a canary is deliberate; `--write-pin` is
 * how you say so, and it refuses to record a pin while any canary is failing. An
 * unpinned tree prints NO PIN rather than passing quietly.
 *
 * Exit 0 only if every canary passes AND the count matches --expect when given;
 * 1 otherwise. Deterministic, no model calls.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

// --expect <n> pins the DENOMINATOR. Without it the runner discovers its own
// count, so a tree missing half its skills still reports "N/N passed", exit 0 —
// a green integrity report byte-shaped like a complete one. The three trees hold
// different counts, so the pin belongs with each tree, not in this file.
//
// The pins used to live ONLY in the header comment above, which meant nothing
// read them: enforcing a count required remembering to type --expect, and
// updating one required remembering that the comment existed. It drifted three
// times in four days across three trees. Now they live in canary-pins.json beside this script
// and apply AUTOMATICALLY when --expect is omitted, so the bare command is the
// enforced one and there is no separate step to forget. Adding a canary is a
// deliberate act; `--write-pin` is how you say so.
const PINS_FILE = path.join(__dirname, "canary-pins.json");

function loadPins() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, "utf8")); } catch { return {}; }
}
// Key RELATIVE to the pins file wherever possible: "." for the tree this file
// sits in, "../skills" for a sibling. An absolute key would bake one machine's
// directory layout into the file — which leaks a local path when the repo is
// public, and loses the pin entirely when the repo is cloned anywhere else.
// Falls back to the absolute path only when no relative route exists (a
// different drive), and lowercases so D:\… and /d/… cannot become two entries
// that disagree.
function pinKey(p) {
  const abs = path.resolve(p).replace(/[\\/]+$/, "");
  const rel = path.relative(__dirname, abs);
  if (rel === "") return ".";
  if (rel === "" || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return abs.toLowerCase();
  return rel.split(path.sep).join("/").toLowerCase();
}

const argv = process.argv.slice(2);
let expect = null;
const ei = argv.indexOf("--expect");
if (ei >= 0) {
  expect = Number(argv[ei + 1]);
  if (!Number.isInteger(expect) || expect < 0) {
    console.error("--expect requires a non-negative integer");
    process.exit(2);
  }
  argv.splice(ei, 2);
}
const wi = argv.indexOf("--write-pin");
const writePin = wi >= 0;
if (writePin) argv.splice(wi, 1);

const root = argv[0] || path.join(os.homedir(), ".claude", "skills");
if (!fs.existsSync(root)) { console.error(`no such skills root: ${root}`); process.exit(2); }

// An explicit --expect still wins, so every existing invocation behaves as before.
let pinSource = "--expect";
if (expect === null) {
  const pinned = loadPins()[pinKey(root)];
  if (Number.isInteger(pinned)) { expect = pinned; pinSource = path.basename(PINS_FILE); }
}

// a canary is any .js/.py in the tree whose own source offers --canary
function findCanaries(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "__pycache__") continue;
      findCanaries(p, out);
    } else if (/\.(js|py)$/.test(e.name)) {
      // never discover ourselves — by NAME, not just by path: this script is
      // published into the suite too, so scanning that tree finds a *copy*.
      if (e.name === path.basename(__filename)) continue;
      let src = "";
      try { src = fs.readFileSync(p, "utf8"); } catch { continue; }
      if (src.includes("--canary")) out.push(p);
    }
  }
  return out;
}

const files = findCanaries(root).sort();
if (!files.length) { console.error(`no canaries found under ${root}`); process.exit(2); }

let pass = 0;
const failed = [];
for (const f of files) {
  const label = path.relative(root, f).replace(/\\/g, "/");
  const cmd = f.endsWith(".py") ? "python" : "node";
  const r = spawnSync(cmd, [f, "--canary"], { encoding: "utf8", timeout: 120000 });
  // a canary that cannot even start is a failure, not a skip
  const out = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").filter(Boolean);
  // prefer the canary's own verdict line: several canaries end on a deliberate
  // negative-test fixture, so the LAST line reads like an error next to "PASS".
  const verdict = out.filter((l) => /CANARY (PASS|FAIL)|canary:/i.test(l)).pop();
  const last = (verdict || out[out.length - 1] || "(no output)").slice(0, 90);
  if (r.status === 0) { pass++; console.log(`  PASS  ${label}  ${last}`); }
  else { failed.push(label); console.log(`  FAIL  ${label}  [exit ${r.status}]  ${last}`); }
}

// name what was NOT tested: "N/N passed" otherwise reads as whole-tree health
const skipped = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "__pycache__"].includes(e.name)) continue;
      scan(p);
    } else if (/[.](js|py)$/.test(e.name) && e.name !== path.basename(__filename) && !files.includes(p)) {
      skipped.push(path.relative(root, p).split(String.fromCharCode(92)).join("/"));
    }
  }
})(root);
console.log(`\n=== ${pass}/${files.length} canaries passed ===`);
if (skipped.length) console.log(`(${skipped.length} script(s) ship no --canary and were NOT tested: ${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? ", +" + (skipped.length - 6) + " more" : ""})`);
// Discovery is .js/.py only. If your suite also keeps SHELL canaries — a gate
// self-test, an install check — they are outside this tally entirely, and an
// unqualified "N/N passed" then reads as whole-tree health when the most
// security-critical component was never exercised. Name yours here.
console.log("(shell canaries, if your tree keeps any, are NOT run by this runner — run them by hand after touching a pre-commit hook or a PreToolUse gate)");
let bad = failed.length > 0;
if (failed.length) console.log(`failed: ${failed.join(", ")}`);
// --write-pin RECORDS the discovered count as this tree's pin. It is the
// deliberate "yes, I meant to add a canary" step, and it is the only way a pin
// changes — nothing here ever updates a pin as a side effect of a normal run,
// because a self-healing pin detects nothing.
if (writePin) {
  if (failed.length) {
    console.log(`REFUSING to write a pin while ${failed.length} canary(ies) FAIL — fix them first.`);
    process.exit(1);
  }
  const pins = loadPins();
  const key = pinKey(root), was = pins[key];
  pins[key] = files.length;
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2) + "\n", "utf8");
  console.log(`pin written: ${key} = ${files.length}${was === undefined ? " (new)" : was === files.length ? " (unchanged)" : ` (was ${was})`}`);
  process.exit(0);
}

// a discovered denominator cannot detect its own shortfall — the pin can
if (expect === null) {
  // Say it out loud. A tree with no pin is running with a discovered
  // denominator, which is exactly the silent-green state the pin exists to
  // prevent, and the old header-comment scheme made that state look normal.
  console.log(`NO PIN for ${pinKey(root)} — count is self-reported and cannot detect a shortfall. Set one with --write-pin.`);
} else {
  console.log(`pin: ${expect} (from ${pinSource})`);
  if (files.length !== expect) {
    console.log(`COUNT MISMATCH: expected ${expect} canaries under ${root}, discovered ${files.length}. ` +
      `"${pass}/${files.length} passed" is therefore not whole-tree health.`);
    bad = true;
  }
}
process.exit(bad ? 1 : 0);
