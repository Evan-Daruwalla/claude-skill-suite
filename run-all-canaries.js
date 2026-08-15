#!/usr/bin/env node
/*
 * run-all-canaries — execute every bundled `--canary` self-test in a skills tree.
 *
 * The suite ships ~16 canaries and nothing ever ran them, so a skill could rot
 * silently: bisect-driver sat at CANARY FAIL 8/11 in both the live and the
 * published copy until an audit ran it by hand. This is the missing runner.
 *
 *   node run-all-canaries.js [skills-root] [--expect <n>]   (default root: ~/.claude/skills)
 *
 * --expect pins how many canaries the tree should hold, so a tree that lost half
 * its skills fails instead of reporting a confident "N/N passed".
 *
 * Counts as measured 2026-08-12 (they legitimately differ — the trees do not hold
 * the same skills). Update these when a canary is added or removed; a stale pin
 * fails LOUDLY, which is the point:
 *     ~/.claude/skills            --expect 22   (the tree the runtime loads)
 *     <your-lab-tree>            --expect <n>   (a private lab tree, if you keep one)
 *     claude-skill-suite          --expect 19   (public mirror)
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

const root = argv[0] || path.join(os.homedir(), ".claude", "skills");
if (!fs.existsSync(root)) { console.error(`no such skills root: ${root}`); process.exit(2); }

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
let bad = failed.length > 0;
if (failed.length) console.log(`failed: ${failed.join(", ")}`);
// a discovered denominator cannot detect its own shortfall — the pin can
if (expect !== null && files.length !== expect) {
  console.log(`COUNT MISMATCH: expected ${expect} canaries under ${root}, discovered ${files.length}. ` +
    `"${pass}/${files.length} passed" is therefore not whole-tree health.`);
  bad = true;
}
process.exit(bad ? 1 : 0);
