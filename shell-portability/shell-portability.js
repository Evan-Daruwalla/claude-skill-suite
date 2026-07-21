#!/usr/bin/env node
/*
 * shell-portability — read-only SYNTAX/semantics scan for cross-shell traps.
 * Proactive counterpart to a reactive shell-troubleshooting runbook (that
 * runbook diagnoses a script that already broke; this = scanner that catches
 * the same traps BEFORE they ship).
 *
 * Scans .ps1/.psm1 and .sh/.bash source for constructs that silently break on
 * this machine's default shells:
 *
 *   .ps1/.psm1 (PowerShell 5.1 is the default here — NOT PS7):
 *     - && / ||            pipeline-chain operators -> PS 5.1 PARSER ERROR
 *     - ?: ternary         PS7-only               -> parser error on 5.1
 *     - ?. / ?[]           null-conditional        PS7-only
 *     - ?? / ??=           null-coalescing         PS7-only
 *     - Read-Host/pause/Out-GridView   block a non-interactive/scheduled run
 *     - Set-Content/Add-Content/Out-File WITHOUT -Encoding  (ANSI/UTF-16
 *       default corrupts UTF-8 for the next tool that reads the file)
 *     - bash-style `NAME=value` / `export NAME=value` assignments
 *
 *   .sh/.bash:
 *     - $env:NAME            PowerShell env syntax in a POSIX script
 *     - Verb-Noun cmdlet calls (Get-ChildItem, Set-Content, ...) in bash
 *
 * ENCODING / FILENAME traps are path-quirk-audit's job — this scanner is
 * SYNTAX/semantics only and does not duplicate them.
 *
 * Reports file:line + why it breaks + the PS5.1-safe alternative.
 * Suppress one line with a trailing `# portability-ok` comment.
 *
 * Commands:
 *   scan <path> [<path>...]   recurse files/dirs, flag traps      (exit 1 on findings)
 *   --canary                  self-test (the done-check), both directions
 *   --help
 *
 * Exit codes: 0 clean · 1 findings / canary-fail · 2 usage error.
 * Zero dependencies, Node >=16. Read-only: never writes outside a temp canary dir.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const PS_EXT = new Set([".ps1", ".psm1"]);
const SH_EXT = new Set([".sh", ".bash"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".golden", "graphify-out"]);
const SUPPRESS = "portability-ok";
const MAX_SNIPPET = 100;

// ---- rule tables -----------------------------------------------------------
// Each rule: { id, re, why, fix }. `re` is tested per logical line. The
// unencoded-write rule is special-cased (needs an absence check) below.
const PS_RULES = [
  { id: "chain-and-or", re: /&&|\|\|/,
    why: "PS 5.1 has no && / || pipeline-chain operators (parser error)",
    fix: "A; if ($?) { B }  (and)   /   A; if (-not $?) { B }  (or)" },
  { id: "null-coalesce", re: /\?\?/,
    why: "?? / ??= null-coalescing is PS7-only",
    fix: "if ($null -eq $x) { ... } else { ... }" },
  { id: "null-conditional", re: /(\$\w+|\)|\])\?(\.|\[)/,
    // Require a real operand ($var / ) / ]) before ?. or ?[ so a `?` WILDCARD in
    // a path (temp?.tmp, *?.log) is not mistaken for PS7 null-conditional.
    why: "?. / ?[] null-conditional is PS7-only",
    fix: "guard first: if ($null -ne $x) { $x.Prop }" },
  { id: "ternary", re: /[^|\s]\s+\?\s+.*\s+:\s+\S/,
    // A ternary needs BOTH arms: ` ? ` ... ` : `. The leading [^|\s] rejects the
    // Where-Object alias (`... | ? { }`, `... | ? Prop -eq x`) — a spaced `?`
    // right after a pipe — which is valid, ubiquitous PS 5.1, not a ternary.
    why: "?: ternary is PS7-only (parser error on 5.1)",
    fix: "use an if/else statement" },
  { id: "interactive", re: /(?:^|[;|{=(])\s*(Read-Host|Out-GridView|pause)\b/i,
    // Only at a command position (statement start or after ; | { = ( ) — not
    // when the word merely appears inside a string, e.g. Write-Host "...pause...".
    why: "Read-Host / pause / Out-GridView block a non-interactive or scheduled run (no console attached)",
    fix: "take the value as a param / from env / from a file; drop the prompt" },
  { id: "bash-assign", re: /^\s*(export\s+)?[A-Za-z_]\w*=(?!=)/,
    why: "bash-style assignment: PS can't assign to a bareword and `export` is not a cmdlet",
    fix: "$name = value   (or  $env:NAME = 'value'  for an env var)" },
];

const SH_RULES = [
  { id: "ps-env-var", re: /\$env:/,
    why: "$env: is PowerShell syntax; bash has no $env: namespace",
    fix: "use $NAME / ${NAME}; set with  export NAME=value" },
  { id: "ps-cmdlet",
    re: /(?:^|[|;&(])\s*(Get|Set|New|Remove|Add|Out|Write|Read|Select|Where|ForEach|Import|Export|Invoke|Test|Start|Stop|Copy|Move|Clear|Format|ConvertTo|ConvertFrom)-[A-Z]\w+/,
    // Anchored to a command position (line start or after | ; & $( ) so a
    // Verb-Capital token inside an argument/string — e.g. the HTTP header
    // "Set-Cookie: ..." in a curl call — is not mistaken for a cmdlet invocation.
    why: "PowerShell cmdlet used in a POSIX shell script (not a bash command)",
    fix: "use the POSIX equivalent (Get-ChildItem->ls/find, Set-Content->printf > file)" },
];

const WRITE_CMDLET_RE = /(?<![\w-])(Set-Content|Add-Content|Out-File)(?![\w-])/i;
const HAS_ENCODING_RE = /-Encoding\b/i;

// ---- scanning --------------------------------------------------------------
// Build LOGICAL lines from physical lines: a PowerShell statement continues
// across a trailing backtick, so an -Encoding flag on the next line still
// counts. Also tracks <# ... #> block comments so doc text is not scanned.
// Returns [{ line, text }] where `line` is the 1-based starting physical line.
function logicalLines(text, isPs) {
  const raw = text.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    let phys = raw[i];
    if (isPs) {
      // strip/track <# #> block comments (may open and close on one line)
      if (inBlock) {
        const end = phys.indexOf("#>");
        if (end < 0) continue;
        phys = phys.slice(end + 2);
        inBlock = false;
      }
      let open = phys.indexOf("<#");
      while (open >= 0) {
        const end = phys.indexOf("#>", open + 2);
        if (end < 0) { phys = phys.slice(0, open); inBlock = true; break; }
        phys = phys.slice(0, open) + phys.slice(end + 2);
        open = phys.indexOf("<#");
      }
    }
    const startLine = i + 1;
    let joined = phys;
    // join PowerShell backtick continuations into one logical line
    while (isPs && /`\s*$/.test(joined) && i + 1 < raw.length) {
      joined = joined.replace(/`\s*$/, " ") + raw[++i];
    }
    out.push({ line: startLine, text: joined });
  }
  return out;
}

function isFullLineComment(text) {
  return /^\s*#/.test(text);
}

// Blank the CONTENTS of quoted string literals (keeping the delimiters) so a
// trap that merely appears inside a string — a "Set-Cookie:" header value, a
// "temp?.tmp" glob, a "...pause..." message — cannot false-positive. Rules run
// against this masked text; the original line is still used for the snippet.
function stripStrings(s) {
  return s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function scanContent(text, ext) {
  const isPs = PS_EXT.has(ext);
  const rules = isPs ? PS_RULES : SH_RULES;
  const findings = [];
  for (const { line, text: lt } of logicalLines(text, isPs)) {
    if (lt.includes(SUPPRESS)) continue;      // trailing # portability-ok
    if (isFullLineComment(lt)) continue;       // whole-line comment
    const st = stripStrings(lt);               // string-literal contents masked out
    for (const rule of rules) {
      if (rule.re.test(st)) {
        findings.push({ line, id: rule.id, why: rule.why, fix: rule.fix, snippet: snip(lt) });
      }
    }
    if (isPs && WRITE_CMDLET_RE.test(st) && !HAS_ENCODING_RE.test(st)) {
      findings.push({
        line, id: "unencoded-write",
        why: "Set-Content/Add-Content/Out-File without -Encoding: PS 5.1 default (ANSI/UTF-16) corrupts UTF-8 for the next reader",
        fix: "add  -Encoding utf8",
        snippet: snip(lt),
      });
    }
  }
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

function snip(s) {
  const t = s.trim();
  return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET) + "..." : t;
}

// ---- file walking ----------------------------------------------------------
function targetExt(file) {
  const e = path.extname(file).toLowerCase();
  return PS_EXT.has(e) || SH_EXT.has(e) ? e : null;
}

function walk(target, acc) {
  let st;
  try { st = fs.statSync(target); } catch { return; }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return;
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), acc);
  } else if (st.isFile() && targetExt(target)) {
    acc.push(target);
  }
}

// ---- commands --------------------------------------------------------------
function cmdScan(paths) {
  if (!paths.length) { console.error("error: scan needs at least one file or directory"); return 2; }
  const files = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) { console.error(`error: no such path: ${p}`); return 2; }
    walk(path.resolve(p), files);
  }
  if (!files.length) { console.log("clean: no .ps1/.psm1/.sh/.bash files found to scan"); return 0; }

  let totalFindings = 0, filesWithFindings = 0;
  for (const f of files.sort()) {
    let content;
    try { content = fs.readFileSync(f, "utf8"); }
    catch (e) { console.error(`error: cannot read ${f}: ${e.message}`); continue; }
    const findings = scanContent(content, path.extname(f).toLowerCase());
    if (!findings.length) continue;
    filesWithFindings++;
    for (const fd of findings) {
      totalFindings++;
      console.log(`${f}:${fd.line}: [${fd.id}] ${fd.why}`);
      console.log(`    fix: ${fd.fix}`);
      console.log(`    > ${fd.snippet}`);
    }
  }
  if (!totalFindings) { console.log(`clean: no portability traps in ${files.length} scanned file(s)`); return 0; }
  console.error(`\n${totalFindings} finding(s) in ${filesWithFindings} file(s) (of ${files.length} scanned) — suppress a line with  # ${SUPPRESS}`);
  return 1;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions in a throwaway dir: the documented traps are CAUGHT
// and clean PS5.1-safe / POSIX code stays quiet. Writes only inside the temp
// dir (read-only toward the world), cleans up regardless.
function runCanary() {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-portability-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  try {
    // (a) bad .ps1: && + ternary + Set-Content without -Encoding -> exactly 3
    const badPs = [
      "git pull && git push",
      '$x = $flag ? "a" : "b"',
      "Set-Content out.txt $data",
    ].join("\r\n");
    check(scanContent(badPs, ".ps1").length === 3, "bad .ps1 -> 3 findings");

    // (b) clean PS5.1-safe .ps1 -> 0
    const cleanPs = [
      "git pull; if ($?) { git push }",
      'if ($flag) { $x = "a" } else { $x = "b" }',
      "Set-Content out.txt $data -Encoding utf8",
      "<# a ? b : c inside a block comment is not code #>",
    ].join("\r\n");
    check(scanContent(cleanPs, ".ps1").length === 0, "clean .ps1 -> 0 findings");

    // (c) suppression: a real trap silenced by # portability-ok -> 0
    check(scanContent("git pull && git push  # portability-ok", ".ps1").length === 0, "# portability-ok suppresses");

    // (d) more PS traps individually caught (?? , ?. , Read-Host, bash-assign)
    check(scanContent('$v = $a ?? "d"', ".ps1").length === 1, "?? null-coalesce caught");
    check(scanContent("$n = $obj?.Name", ".ps1").length === 1, "?. null-conditional caught");
    check(scanContent("$pw = Read-Host 'password'", ".ps1").length === 1, "Read-Host caught");
    check(scanContent("FOO=bar", ".ps1").length === 1, "bash-style assignment caught");

    // (e) bad .sh: $env: + Verb-Noun cmdlet -> 2
    const badSh = ["echo $env:PATH", "Get-ChildItem /tmp"].join("\n");
    check(scanContent(badSh, ".sh").length === 2, "bad .sh -> 2 findings");

    // (f) clean .sh -> 0
    const cleanSh = ['echo "$PATH"', "ls /tmp"].join("\n");
    check(scanContent(cleanSh, ".sh").length === 0, "clean .sh -> 0 findings");

    // (g) end-to-end file walk over a temp dir returns exit 1 on the bad file
    fs.writeFileSync(path.join(dir, "bad.ps1"), badPs);
    fs.writeFileSync(path.join(dir, "clean.sh"), cleanSh);
    check(cmdScanQuiet([dir]) === 1, "cmdScan over a dir with a bad file -> exit 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// cmdScan wrapper that swallows stdout/stderr (canary only wants the exit code).
function cmdScanQuiet(paths) {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try { return cmdScan(paths); } finally { console.log = log; console.error = err; }
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `shell-portability — scan scripts for cross-shell syntax traps (read-only).

Usage:
  node shell-portability.js scan <path> [<path>...]
  node shell-portability.js --canary
  node shell-portability.js --help

Scans .ps1/.psm1 for PS7-only / bash-ism / non-interactive / unencoded-write
traps, and .sh/.bash for PowerShell-isms. Reports file:line + why + the
PS5.1-safe fix. Encoding/filename issues belong to path-quirk-audit, not here.

Suppress one line with a trailing  # ${SUPPRESS}  comment.

Exit codes: 0 clean · 1 findings / canary-fail · 2 usage error.`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP); process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.includes("--canary")) process.exit(runCanary());
  if (argv[0] === "scan") process.exit(cmdScan(argv.slice(1)));
  console.error(`error: unknown command '${argv[0]}'. Try --help.`);
  process.exit(2);
}
main();
