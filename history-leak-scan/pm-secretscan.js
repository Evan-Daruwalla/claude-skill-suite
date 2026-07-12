#!/usr/bin/env node
/*
 * pm-secretscan — portable, dependency-free secret scanner.
 * Two modes:
 *   history: node pm-secretscan.js --history <repo> [<repo>...]
 *            scans `git log -p --all` (every version ever committed)
 *   staged:  node pm-secretscan.js --staged <repo>
 *            scans `git diff --cached` (for a pre-commit / PreToolUse hook)
 *
 * High-signal per-provider regexes + a generic assignment+entropy detector,
 * with an allowlist so obvious test/example values don't fire (a scanner that
 * cries wolf trains you to bypass it). Exit 1 if any finding (hook-friendly).
 */
"use strict";
const fs = require("fs");
const { spawn } = require("child_process");

// ---- detectors -------------------------------------------------------------
const RULES = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["aws-secret", /\baws_secret_access_key\b['"\s:=]+[A-Za-z0-9/+]{40}\b/i],
  ["alpaca-key-id", /\b(?:PK|AK)[A-Z0-9]{16,}\b/],
  ["github-token", /\bgh[posru]_[A-Za-z0-9]{36,}\b/],
  ["github-fine-grained-pat", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_\-]{35}\b/],
  ["stripe-secret", /\bsk_live_[0-9a-zA-Z]{24,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/],
  ["openai-key", /\bsk-[A-Za-z0-9_\-]*T3BlbkFJ[A-Za-z0-9_\-]{10,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_\-]{16,32}\.[A-Za-z0-9_\-]{16,64}\b/],
  ["twilio-key", /\bSK[0-9a-f]{32}\b/],
  ["resend-key", /\bre_[A-Za-z0-9]{7,}_[A-Za-z0-9]{16,}\b/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/],
];
// files that should never be committed AT ALL, regardless of content.
// Name-based (gitleaks-style path rule); example/sample/template names and
// test-fixture paths are exempt (self-signed test certs are legitimate).
const SENSITIVE_FILE = /(^|\/)(\.env(\.[^\/]+)?|[^\/]+\.(pem|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.[^\/]+)?|[^\/]*_keys?\.env)$/i;
const FILE_EXEMPT = /example|sample|template|dummy|fixture/i;
// generic "secretish_name = <value>" assignment (keyword may be embedded,
// e.g. alpaca_secret_key — no leading word boundary required)
const ASSIGN = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\s*[:=]\s*['"]?([A-Za-z0-9/+_\-]{16,})['"]?(?:\s|$|['";,)])/i;

// placeholder test applied to the MATCHED TOKEN only (never the whole line —
// suppressing a line because it contains "test" anywhere causes false negatives)
function isPlaceholder(tok) {
  return /example|placeholder|your[_-]?|dummy|sample|change[_-]?me|redacted|\bhere\b|^x+$|^0+$|^(.)\1{7,}$|deadbeef|012345|123456|abcdef012/i.test(tok);
}
const SKIP_FILES = /(package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|\.min\.js|\.map$)/i;
// weak/short password literals that slip under the entropy threshold (the
// admin1234 class). Requires a QUOTED value so env-reads don't false-positive.
const WEAK_PW = /\b([A-Za-z0-9_]*(?:password|passwd|pwd)[A-Za-z0-9_]*)\s*[:=]\s*['"]([^'"\s]{4,20})['"]/i;
// Test AND documentation files legitimately hold fake example credentials —
// fixture passwords ("demo1234", "short") and secrets quoted in prose while
// explaining them. Firing the weak-password + high-entropy heuristics on them
// cries wolf and trains --no-verify. In these files, keep only the strong
// per-provider rules (a REAL AWS/GitHub key / private-key block is still a leak
// anywhere). Residual risk: a raw high-entropy token pasted into a .md that
// matches no provider regex won't be caught — accepted vs. gate-fatigue.
function isHeuristicExempt(f) {
  return /(^|\/)(tests?|__tests__|__mocks__|spec|fixtures?|e2e)\//i.test(f) ||
    /(^|\/)test_[^/]*$/i.test(f) ||
    /[._](test|spec)\.[a-z]+$/i.test(f) ||
    /conftest\.py$/i.test(f) ||
    /\.(md|markdown|mdx|rst|txt|adoc)$/i.test(f); // documentation
}

function shannon(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0;
  for (const k in f) { const p = f[k] / s.length; h -= p * Math.log2(p); }
  return h;
}
function redact(s) {
  s = s.slice(0, 120);
  return s.replace(/[A-Za-z0-9/+_\-]{12,}/g, (m) => m.slice(0, 4) + "…" + m.slice(-2));
}

function detect(line, file) {
  for (const [rule, re] of RULES) {
    const m = re.exec(line);
    if (m && !isPlaceholder(m[0])) return rule;
  }
  // test + doc files: strong provider rules only, skip the noisy heuristics
  if (isHeuristicExempt(file || "")) return null;
  const m = ASSIGN.exec(line);
  if (m) {
    const val = m[2];
    if (val.length >= 20 && shannon(val) >= 3.5 && !isPlaceholder(val)) return "high-entropy-assignment";
  }
  const w = WEAK_PW.exec(line);
  if (w && !isPlaceholder(w[2])) return "weak-password";
  return null;
}

// ---- git streaming ---------------------------------------------------------
function scanRepo(repo, mode) {
  return new Promise((resolve) => {
    const args =
      mode === "staged"
        ? ["-C", repo, "diff", "--cached", "--no-color", "-U0"]
        : ["-C", repo, "log", "-p", "--all", "--no-color", "-U0"];
    const git = spawn("git", args, { maxBuffer: 1 << 30 });
    const findings = [];
    let commit = "(working)", file = "?", buf = "";
    const onLine = (line) => {
      if (line.startsWith("commit ")) commit = line.slice(7, 17);
      else if (line.startsWith("+++ b/")) {
        file = line.slice(6);
        if (SENSITIVE_FILE.test(file) && !FILE_EXEMPT.test(file) && !isHeuristicExempt(file)) {
          findings.push({ commit, file, rule: "sensitive-filename", snippet: "(file of this name should not be committed)" });
        }
      }
      else if (line.startsWith("+") && !line.startsWith("+++")) {
        if (SKIP_FILES.test(file)) return;
        const rule = detect(line.slice(1), file);
        if (rule) findings.push({ commit, file, rule, snippet: redact(line.slice(1).trim()) });
      }
    };
    git.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    git.stderr.on("data", () => {});
    git.on("close", () => { if (buf) onLine(buf); resolve({ repo, findings }); });
    git.on("error", () => resolve({ repo, findings: [], error: true }));
  });
}

// self-test: plant real-format secrets + placeholders in a throwaway repo,
// prove the scanner catches the real ones and ignores the placeholders.
async function runCanary() {
  const os = require("os"), path = require("path"), { execFileSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmscan-canary-"));
  const g = (a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    g(["config", "user.email", "c@c.c"]); g(["config", "user.name", "canary"]);
    // Build fixtures so THIS source file contains no matchable `NAME = "secret"`
    // literal (else the scanner flags its own canary when committed). Names are
    // passed as args; values are assembled from fragments at runtime.
    const line = (k, v) => k + " = " + String.fromCharCode(34) + v + String.fromCharCode(34) + "\n";
    fs.writeFileSync(path.join(dir, "config.py"),
      line("AWS_KEY", "AKIA" + "QZ3RT7YXKW9MPL2V") +
      line("alpaca_secret_key", "aQ9vK2mZ7pL4xR8n" + "ToB6yC3dF5gH0jSuWeR") +
      line("DB_PASSWORD", "P4x8Rt2QmZ7v" + "KnBwY6cDfHjSgL0eUaWq") +
      line("admin_password", "admin" + "1234") +
      line("ANTHROPIC_API_KEY", "sk-ant-" + "api03-Xk7mQ2vL9pR4tY8w" + "ZbC5dF1gH6jN0sUa") +
      line("RESEND_API_KEY", "re_dJ8kQ2mV" + "_" + "xT4bN7wZ9cF1gH5pL3sYaR"));
    fs.writeFileSync(path.join(dir, "server" + ".pem"), "placeholder body, the NAME is the finding\n");
    fs.writeFileSync(path.join(dir, "example.env"),
      "API_KEY=your_api_key_here\ndb_password=changeme\n" +
      "ANTHROPIC_API_KEY=sk-ant-" + "your-api-key-goes-here-replace-me\n");
    g(["add", "-A"]); g(["commit", "-qm", "canary"]);
    const { findings } = await scanRepo(dir, "history");
    const real = findings.filter((f) => f.file === "config.py" || f.file.endsWith(".pem")).length;
    const fp = findings.filter((f) => f.file === "example.env").length;
    const pass = real >= 7 && fp === 0;
    console.log(`canary: ${real} real caught (expect >=7), ${fp} false positive(s) (expect 0) -> ${pass ? "PASS" : "FAIL"}`);
    if (!pass) for (const f of findings) console.log(`  [${f.rule}] ${f.file}: ${f.snippet}`);
    return pass;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--canary")) { process.exit((await runCanary()) ? 0 : 1); }
  const mode = argv.includes("--staged") ? "staged" : "history";
  const repos = argv.filter((a) => !a.startsWith("--"));
  if (!repos.length) { console.error("usage: pm-secretscan.js --history|--staged|--canary <repo>..."); process.exit(2); }
  let total = 0;
  for (const repo of repos) {
    const { findings } = await scanRepo(repo, mode);
    // dedupe identical (file,rule,snippet) across history versions
    const seen = new Set(), uniq = [];
    for (const f of findings) { const k = f.file + f.rule + f.snippet; if (!seen.has(k)) { seen.add(k); uniq.push(f); } }
    if (uniq.length) {
      total += uniq.length;
      console.log(`\n### ${repo} — ${uniq.length} finding(s)`);
      for (const f of uniq) console.log(`  [${f.rule}] ${f.file} @${f.commit}: ${f.snippet}`);
    } else {
      console.log(`\n### ${repo} — clean`);
    }
  }
  console.log(`\n=== TOTAL: ${total} unique finding(s) across ${repos.length} repo(s) ===`);
  process.exit(total ? 1 : 0);
}
main();
