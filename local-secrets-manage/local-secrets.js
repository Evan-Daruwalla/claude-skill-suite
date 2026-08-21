#!/usr/bin/env node
/*
 * local-secrets — read-only hygiene audit of secret-bearing FILES in a git repo.
 * Finds candidate files by NAME (.env*, *.pem, *.key, id_rsa*, id_ed25519*,
 * *_keys.env, credentials*.json, secrets.*) and, for each, asks git two questions:
 *   (a) is it TRACKED in the index?  (git ls-files)
 *   (b) is it IGNORED?               (git check-ignore)
 * and assigns a verdict:
 *   TRACKED-SECRET  worst — the file is in the git index (already leaking / one
 *                   push from public). ROTATE + untrack.
 *   UNIGNORED       on disk, not tracked yet, and NOT ignored — one `git add .`
 *                   from leaking. Add a .gitignore line.
 *   OK              ignored (git will refuse to add it without -f).
 *
 * This scans NAMES only. It NEVER opens a candidate file, never prints its
 * contents, never edits .gitignore. For CONTENT / git-history secret scanning use
 * the history-leak-scan skill (pm-secretscan.js). --fix-print emits the .gitignore
 * lines it WOULD add — it never applies them.
 *
 *   (default) / --dir <path>   audit repo at cwd (or <path>); table output
 *   --fix-print                also print proposed .gitignore lines (stdout only)
 *   --canary                   self-test (the done-check); both directions
 *
 * Exit codes: 0 clean · 1 any TRACKED-SECRET/UNIGNORED (or canary fail) · 2 usage error.
 * Zero dependencies, Node >=16. Read-only toward the world.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Candidate-file NAME rules. Matched against each entry's basename only.
// example/sample/template/fixture names are exempt (they carry no real secret).
//
// KEPT IN SYNC with pm-secretscan's SENSITIVE_FILE. The two skills document
// themselves as two halves of one job ("run both"), and that sync was written
// down as an invariant while NOTHING compared them. A differential test over 25
// names on 2026-08-20 found 10 disagreements — every one a name the commit gate
// BLOCKS and this pre-public auditor called clean: .p12 .pfx .jks .keystore
// .ppk, id_dsa, id_ecdsa, and foo_key.env (singular "key"). The canary now
// asserts the two rule sets agree on a fixed list, so the invariant is checked
// rather than merely asserted.
const NAME_RULES = [
  { re: /^\.env($|\.)/i, label: ".env*" },
  { re: /\.pem$/i, label: "*.pem" },
  { re: /\.key$/i, label: "*.key" },
  { re: /\.p12$/i, label: "*.p12" },
  { re: /\.pfx$/i, label: "*.pfx" },
  { re: /\.jks$/i, label: "*.jks" },
  { re: /\.keystore$/i, label: "*.keystore" },
  { re: /\.ppk$/i, label: "*.ppk" },
  { re: /^id_rsa($|\.|_)/i, label: "id_rsa*" },
  { re: /^id_dsa($|\.|_)/i, label: "id_dsa*" },
  { re: /^id_ecdsa($|\.|_)/i, label: "id_ecdsa*" },
  { re: /^id_ed25519($|\.|_)/i, label: "id_ed25519*" },
  { re: /_keys?\.env$/i, label: "*_key(s).env" },
  { re: /^credentials.*\.json$/i, label: "credentials*.json" },
  { re: /^secrets\./i, label: "secrets.*" },
];
// `dummy` matches pm-secretscan's FILE_EXEMPT, which already exempted it — the
// reverse half of the same differential test (dummy.pem was flagged here and
// exempt there).
const EXEMPT_RE = /(example|sample|template|fixture|dummy|\.dist$|\.sample$)/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build"]);
const MAX_FILES = 200000; // walk ceiling — a runaway tree stops rather than hangs

// ---- helpers ---------------------------------------------------------------
// run git in the repo; returns { code, out } — out is trimmed stdout.
function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error) throw new Error("git not runnable: " + r.error.message);
  return { code: r.status == null ? -1 : r.status, out: (r.stdout || "").trim() };
}

function isGitRepo(root) {
  const r = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.out === "true";
}

// candidate basename? returns the matching rule label or null. exemptions win.
function classifyName(base) {
  if (EXEMPT_RE.test(base)) return null;
  for (const rule of NAME_RULES) if (rule.re.test(base)) return rule.label;
  return null;
}

// walk the working tree (skipping SKIP_DIRS), return repo-relative paths of
// candidate files by NAME. Never reads file contents.
function findCandidates(root) {
  const found = [];
  let count = 0;
  // A ceiling hit used to `return found` silently, so a partial walk printed the
  // identical "No secret-bearing files found by name. Clean." as a complete one.
  // This tool's whole job is the sentence before a repo goes public; a partial
  // scan wearing a clean result's clothes is the worst thing it can say.
  found.truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; } // unreadable dir — skip, don't crash
    for (const ent of entries) {
      if (++count > MAX_FILES) { found.truncated = true; return found; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(full);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (classifyName(ent.name)) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return found;
}

// TRACKED = the path appears in git ls-files (the index).
function isTracked(root, rel) {
  const r = git(root, ["ls-files", "--error-unmatch", "--", rel]);
  return r.code === 0;
}

// IGNORED = git check-ignore matches (exit 0). A tracked file is never reported
// ignored by git, so we only consult this for untracked candidates.
function isIgnored(root, rel) {
  const r = git(root, ["check-ignore", "-q", "--", rel]);
  return r.code === 0;
}

// verdict per candidate. Order matters: tracked beats ignored.
function verdictFor(root, rel) {
  if (isTracked(root, rel)) return "TRACKED-SECRET";
  if (isIgnored(root, rel)) return "OK";
  return "UNIGNORED";
}

// ---- audit -----------------------------------------------------------------
function audit(root) {
  const cands = findCandidates(root);
  const truncated = !!cands.truncated;
  const rows = cands.slice().sort().map((rel) => ({
    path: rel,
    rule: classifyName(path.basename(rel)),
    verdict: verdictFor(root, rel),
  }));
  rows.truncated = truncated;   // carried through so the report cannot lose it
  return rows;
}

// proposed .gitignore lines for the risky rows — the exact path, so we never
// over-ignore a sibling. Deduped, sorted. NEVER written to disk.
function fixLines(rows) {
  const risky = rows.filter((r) => r.verdict === "TRACKED-SECRET" || r.verdict === "UNIGNORED");
  return [...new Set(risky.map((r) => "/" + r.path))].sort();
}

function pad(s, n) { return s.length >= n ? s : s + " ".repeat(n - s.length); }

function printTable(rows) {
  if (rows.truncated) {
    console.error(`PARTIAL SCAN — the ${MAX_FILES}-entry walk ceiling was reached; files past it were NOT examined.`);
    console.error("  This is not a clean result. Narrow --dir, or add the large subtree to SKIP_DIRS.");
  }
  if (!rows.length) {
    console.log(rows.truncated
      ? "No secret-bearing files found in the part of the tree that was walked."
      : "No secret-bearing files found by name. Clean.");
    return;
  }
  const vW = Math.max(7, ...rows.map((r) => r.verdict.length));
  const pW = Math.max(4, ...rows.map((r) => r.path.length));
  console.log(`${pad("VERDICT", vW)}  ${pad("PATH", pW)}  RULE`);
  console.log(`${"-".repeat(vW)}  ${"-".repeat(pW)}  ----`);
  for (const r of rows) console.log(`${pad(r.verdict, vW)}  ${pad(r.path, pW)}  ${r.rule}`);
  const tracked = rows.filter((r) => r.verdict === "TRACKED-SECRET").length;
  const unign = rows.filter((r) => r.verdict === "UNIGNORED").length;
  const ok = rows.filter((r) => r.verdict === "OK").length;
  console.log(`\n${rows.length} candidate(s): ${tracked} TRACKED-SECRET, ${unign} UNIGNORED, ${ok} OK`);
}

function cmdAudit(root, opts) {
  if (!fs.existsSync(root)) { console.error(`error: --dir does not exist: ${root}`); return 2; }
  if (!isGitRepo(root)) { console.error(`error: not a git repo (or git unavailable): ${root}`); return 2; }
  const rows = audit(root);
  printTable(rows);
  const lines = fixLines(rows);
  if (opts.fixPrint) {
    if (lines.length) {
      console.log("\n# proposed .gitignore lines (NOT applied — copy them in yourself):");
      for (const l of lines) console.log(l);
      console.log("# TRACKED-SECRET files also need `git rm --cached <path>` + rotation — see secret-rotation.");
    } else {
      console.log("\n# nothing to add to .gitignore.");
    }
  }
  if (lines.length) return 1;
  // A truncated walk must not exit 0: 0 means "I looked at everything and it is
  // clean", and that is precisely what did not happen.
  return rows.truncated ? 2 : 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions in a throwaway git repo: the risky case is CAUGHT and a
// clean repo stays quiet. Confined to a tmp dir; no network, no model calls.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-secrets-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  const w = (p, c) => fs.writeFileSync(path.join(root, p), c);
  try {
    // isolated repo — no user identity/hooks leak in.
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "canary@test"]);
    git(root, ["config", "user.name", "canary"]);
    git(root, ["config", "commit.gpgsign", "false"]);

    // plant three files exercising each verdict:
    w(".env", "SECRET=tracked\n");            // will be add+committed -> TRACKED-SECRET
    w(".env.local", "SECRET=onDisk\n");        // on disk, not ignored, not tracked -> UNIGNORED
    w(".env.ok", "SECRET=ignored\n");          // ignored -> OK
    w(".env.example", "SECRET=placeholder\n"); // exempt name -> not a candidate at all
    w(".gitignore", ".env.ok\n");

    git(root, ["add", ".env", ".gitignore"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    const rows = audit(root);
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r.verdict]));
    check(byPath[".env"] === "TRACKED-SECRET", "tracked .env -> TRACKED-SECRET");
    check(byPath[".env.local"] === "UNIGNORED", "on-disk .env.local -> UNIGNORED");
    check(byPath[".env.ok"] === "OK", "ignored .env.ok -> OK");
    check(!(".env.example" in byPath), ".env.example exempt (not a candidate)");
    check(!(".gitignore" in byPath), ".gitignore is not a candidate name");

    // risky repo -> exit 1, and fix-lines cover exactly the two risky rows.
    check(cmdAudit(root, { fixPrint: false }) === 1, "risky repo -> exit 1");
    const lines = fixLines(rows);
    check(lines.length === 2 && lines.includes("/.env") && lines.includes("/.env.local"),
      "fix-print proposes /.env and /.env.local only");

    // clean repo (no secret-bearing files) -> exit 0.
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "local-secrets-clean-"));
    try {
      git(clean, ["init", "-q"]);
      fs.writeFileSync(path.join(clean, "README.md"), "# hi\n");
      check(cmdAudit(clean, { fixPrint: false }) === 0, "clean repo -> exit 0");
    } finally { fs.rmSync(clean, { recursive: true, force: true }); }

    // non-repo -> usage error exit 2.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "local-secrets-bare-"));
    try { check(cmdAudit(bare, { fixPrint: false }) === 2, "non-repo -> exit 2"); }
    finally { fs.rmSync(bare, { recursive: true, force: true }); }

    // --dir arg-validation: bare/flag-shaped value is a usage error (never cwd-fallback);
    // a real value passes through.
    check(dirArgMissing(["--dir"]) === true, "bare --dir -> arg error");
    check(dirArgMissing(["--dir", "--fix-print"]) === true, "--dir --fix-print -> arg error");
    check(dirArgMissing(["--dir", "/some/path"]) === false, "--dir with path -> ok");
    check(dirArgMissing(["--fix-print"]) === false, "no --dir -> no arg error");

    // ---- 2026-08-20 audit: the two rule sets must AGREE --------------------
    // "Kept deliberately in sync with pm-secretscan" was written in both files
    // and enforced by nothing. A 25-name differential found 10 disagreements,
    // each one a name the commit gate BLOCKS and this auditor called clean.
    // The invariant is now checked, on the shared scanner as it actually ships.
    const SCANNER = path.join(os.homedir(), ".claude", "skills", "history-leak-scan", "pm-secretscan.js");
    if (fs.existsSync(SCANNER)) {
      const src = fs.readFileSync(SCANNER, "utf8");
      const mSens = /const SENSITIVE_FILE = (\/.*\/i);/.exec(src);
      const mExempt = /const FILE_EXEMPT = (\/.*\/i);/.exec(src);
      check(!!mSens && !!mExempt, "pm-secretscan's rule constants are readable");
      if (mSens && mExempt) {
        // eslint-disable-next-line no-eval -- reading the sibling's own literals
        const SENS = eval(mSens[1]), EXEMPT = eval(mExempt[1]);
        const NAMES = [
          ".env", ".env.local", ".env.dist", ".env.sample", "app.pem", "dummy.pem",
          "client.p12", "cert.pfx", "store.jks", "my.keystore", "putty.ppk",
          "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "alpaca_key.env",
          "alpaca_keys.env", "credentials.json", "credentials-prod.json",
          "secrets.yaml", "server.key", "readme.md", "package.json",
          "example.pem", "config.template.env",
        ];
        const gateBlocks = (n) => SENS.test(n) && !EXEMPT.test(n);
        const weFlag = (n) => NAME_RULES.some((r) => r.re.test(n)) && !EXEMPT_RE.test(n);
        const disagree = NAMES.filter((n) => gateBlocks(n) !== weFlag(n));
        check(disagree.length === 0,
          `NAME_RULES and SENSITIVE_FILE agree on all ${NAMES.length} names` +
          (disagree.length ? ` — DISAGREE on: ${disagree.join(", ")}` : ""));
        // and prove the comparison can actually fail, so a green line means something
        check(gateBlocks("id_rsa") === true && weFlag("id_rsa") === true, "both flag id_rsa");
        check(gateBlocks("readme.md") === false && weFlag("readme.md") === false, "neither flags readme.md");
        // the keystore/ecdsa/singular-key names the differential actually caught
        for (const n of ["client.p12", "cert.pfx", "store.jks", "my.keystore", "putty.ppk",
                         "id_dsa", "id_ecdsa", "alpaca_key.env"]) {
          check(weFlag(n) === true, `local-secrets now flags ${n} (the gate always did)`);
        }
        check(gateBlocks(".env.dist") === false && weFlag(".env.dist") === false,
          ".env.dist is exempt on BOTH sides (a committed template)");
      }
    } else {
      console.error("  note: pm-secretscan not installed — rule-agreement check skipped");
      check(true, "rule-agreement check (scanner absent — tolerated)");
    }

    // A walk that hit its ceiling must not print a clean result. The ceiling
    // used to `return found` silently, so a partial scan and a complete one
    // printed the identical "Clean." — in the tool whose entire job is the
    // sentence you say before a repo goes public.
    {
      const partial = [];
      partial.truncated = true;
      const err = console.error, log = console.log;
      let said = "";
      console.error = console.log = (m) => { said += String(m) + "\n"; };
      try { printTable(partial); } finally { console.error = err; console.log = log; }
      check(/PARTIAL SCAN/.test(said), "a truncated walk says PARTIAL SCAN");
      check(!/Clean\./.test(said), "a truncated walk never prints \"Clean.\"");
      let saidOk = "";
      console.error = console.log = (m) => { saidOk += String(m) + "\n"; };
      try { printTable([]); } finally { console.error = err; console.log = log; }
      check(/Clean\./.test(saidOk), "a COMPLETE empty walk still says Clean.");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `local-secrets — read-only hygiene audit of secret-bearing FILES in a git repo.

Usage:
  node local-secrets.js [--dir <path>] [--fix-print]
  node local-secrets.js --canary
  node local-secrets.js --help

Finds candidate files by NAME (.env*, *.pem, *.key, id_rsa*, id_ed25519*,
*_keys.env, credentials*.json, secrets.*) and asks git whether each is TRACKED
and/or IGNORED. Verdicts:
  TRACKED-SECRET  in the git index — worst; rotate + git rm --cached.
  UNIGNORED       on disk, not ignored, not tracked — one git add from leaking.
  OK              ignored.
--fix-print emits the .gitignore lines it WOULD add (never applied).

Scans NAMES only — never opens a file, never prints contents, never edits
.gitignore. For file CONTENT / git-history scanning use history-leak-scan.

Exit codes: 0 clean · 1 any TRACKED-SECRET/UNIGNORED · 2 usage error.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// --dir, if present, must be followed by a real path (not EOL, not another flag).
// returns true when the --dir usage is INVALID (missing/flag-shaped value).
function dirArgMissing(argv) {
  if (!argv.includes("--dir")) return false;
  const v = getOpt(argv, "--dir");
  return v === null || v.startsWith("-");
}

// Flags that consume the token after them, so that token is a value, not a path.
const VALUE_FLAGS = ["--dir"];

// A bare positional was silently ignored and the audit then ran against cwd —
// printing "Clean." about a directory nobody named, which is a false all-clear
// and the worst output an audit tool has. Sibling scanners in this suite
// (pm-secretscan, seed-control) DO take a positional path, so the wrong
// invocation is the natural one to reach for. Refuse rather than guess.
function strayArgs(argv) {
  const stray = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) { if (VALUE_FLAGS.includes(a)) i++; continue; }
    stray.push(a);
  }
  return stray;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); process.exit(0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  // --dir, if given, must be followed by a real path (not another flag, not EOL).
  if (dirArgMissing(argv)) { console.error("error: --dir requires a path"); process.exit(2); }
  const stray = strayArgs(argv);
  if (stray.length) {
    console.error(`error: unexpected argument '${stray[0]}' — this tool takes its path as --dir <path>, not a positional`);
    process.exit(2);
  }
  const dir = getOpt(argv, "--dir");
  const root = dir ? path.resolve(dir) : process.cwd();
  process.exit(cmdAudit(root, { fixPrint: argv.includes("--fix-print") }));
}
// documented exit 2 for "not a git repo / git unavailable": without this the
// throw at getRepoRoot escapes as an uncaught exception (exit 1 + stack trace).
try { main(); } catch (e) { console.error("error: " + (e && e.message ? e.message : e)); process.exit(2); }
