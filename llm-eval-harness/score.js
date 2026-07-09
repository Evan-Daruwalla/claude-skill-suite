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
    default: throw new Error("unknown check type: " + c.type);
  }
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
  const mi = args.indexOf("--model");
  const model = mi >= 0 ? args[mi + 1] : "unknown";
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model");
  const [taskId, candFile] = positional;
  if (!taskId || !candFile) { console.error("usage: score.js <taskId> <candidateFile> --model <name>"); process.exit(2); }

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

  const line = JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    model, task: taskId, method: task.score.method, score: Number(score.toFixed(4)),
  });
  fs.appendFileSync(path.join(DIR, "ratchet.jsonl"), line + "\n");
  console.log(`  -> appended to ratchet.jsonl`);
}

main();
