#!/usr/bin/env node
/*
 * llm-eval-harness scorer — deterministic, no model call, no API key.
 *
 *   node score.js <taskId> <candidateFile> --model <name>
 *
 * 'checks' tasks score immediately (assertions on the output text).
 * 'golden' tasks compare the candidate to goldens/<id>.<refModel>.md by
 * line-similarity — they need a golden captured under that model first.
 *
 * Appends one line to ratchet.jsonl so the Fable->cheaper-model gap is trackable
 * over time. NO LLM-judge (no API key; a non-reproducible judge would be
 * invented data).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const TASKS = JSON.parse(fs.readFileSync(path.join(DIR, "tasks.json"), "utf8")).tasks;

function firstLine(t) { return t.split(/\r?\n/)[0] || ""; }
function nonEmptyLines(t) { return t.split(/\r?\n/).filter((l) => l.trim()).length; }

function runCheck(text, c) {
  switch (c.type) {
    case "matches": return new RegExp(c.re, c.flags || "").test(text);
    case "absent": return !new RegExp(c.re, c.flags || "").test(text);
    case "contains": return text.includes(c.s);
    case "maxFirstLineLen": return firstLine(text).length <= c.n;
    case "minLines": return nonEmptyLines(text) >= c.n;
    case "maxWords": return text.split(/\s+/).filter(Boolean).length <= c.n;
    default: throw new Error("unknown check type: " + c.type);
  }
}

// --summary: read the ratchet and report per (model, task): n, median, min, max.
// Single-sample scores are noisy — judge from the median of >=3 samples.
function summary() {
  const rp = path.join(DIR, "ratchet.jsonl");
  if (!fs.existsSync(rp)) { console.log("ratchet.jsonl not found — nothing scored yet."); return; }
  const rows = fs.readFileSync(rp, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const groups = {};
  for (const r of rows) {
    const k = `${r.model} | ${r.task}`;
    (groups[k] = groups[k] || { method: r.method, scores: [] }).scores.push(r.score);
  }
  console.log(`model | task | method | n | median | min | max`);
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k], s = [...g.scores].sort((a, b) => a - b);
    const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    console.log(`${k} | ${g.method} | ${s.length} | ${med.toFixed(3)} | ${s[0].toFixed(3)} | ${s[s.length - 1].toFixed(3)}`);
  }
  console.log(`\n(${rows.length} run(s) total. n=1 rows are single samples — treat as anecdotes, not measurements.)`);
}

// word-level LCS similarity in [0,1]. (Line-level LCS was effectively binary on
// one-paragraph prose goldens — any wording change scored ~0. Word tokens give a
// graded, still fully deterministic score.)
function similarity(a, b) {
  const tok = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const A = tok(a), B = tok(b);
  if (!A.length && !B.length) return 1;
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++)
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return (2 * dp[A.length][B.length]) / (A.length + B.length);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--summary")) return summary();
  const dry = args.includes("--dry");
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? args[mi + 1] : "unknown";
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model");
  const [taskId, candFile] = positional;
  if (!taskId || !candFile) { console.error("usage: score.js <taskId> <candidateFile> --model <name> [--dry] | score.js --summary"); process.exit(2); }

  const task = TASKS.find((t) => t.id === taskId);
  if (!task) { console.error("no such task: " + taskId + " (have: " + TASKS.map((t) => t.id).join(", ") + ")"); process.exit(2); }
  const text = fs.readFileSync(candFile, "utf8");

  let score, detail = [];
  if (task.score.method === "checks") {
    const results = task.score.checks.map((c) => ({ desc: c.desc, pass: runCheck(text, c) }));
    const passed = results.filter((r) => r.pass).length;
    score = passed / results.length;
    detail = results;
    console.log(`\n[${taskId}] model=${model}  checks ${passed}/${results.length}  score=${score.toFixed(3)}`);
    for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.desc}`);
    if (score === 1) console.log("  note: a perfect checks score = baseline discipline met, NOT model parity — checks are near-ceiling by design; the golden tasks and medians discriminate.");
  } else if (task.score.method === "golden") {
    const gp = path.join(DIR, "goldens", `${taskId}.${task.score.refModel}.md`);
    if (!fs.existsSync(gp)) {
      console.error(`\n[${taskId}] golden missing: ${path.relative(DIR, gp)}\n` +
        `Capture it under a ${task.score.refModel} session first (see SKILL.md). Not scored.`);
      process.exit(3);
    }
    score = similarity(text, fs.readFileSync(gp, "utf8"));
    console.log(`\n[${taskId}] model=${model}  golden-similarity=${score.toFixed(3)} vs ${task.score.refModel}`);
  } else {
    throw new Error("unknown method: " + task.score.method);
  }

  if (dry) { console.log("  -> --dry: NOT appended to ratchet.jsonl"); return; }
  const line = JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    model, task: taskId, method: task.score.method, score: Number(score.toFixed(4)),
  });
  fs.appendFileSync(path.join(DIR, "ratchet.jsonl"), line + "\n");
  console.log(`  -> appended to ratchet.jsonl`);
}

main();
