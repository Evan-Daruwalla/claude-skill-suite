#!/usr/bin/env node
/*
 * path-quirk-audit — read-only tree scan for documented Windows path/file
 * corruption classes. Catches the traps that silently break a .bat parse, a
 * shell script, a JSON file, or a scheduled task ON A WINDOWS MACHINE, before
 * they cost a debugging session. This is the proactive sweep that finds the
 * offenders across a whole tree; pair it with your own symptom-side runbook
 * for triaging one that already broke.
 *
 * Classes flagged:
 *   1 BAT-NONASCII  .bat/.cmd containing ANY byte > 0x7F (one non-ASCII byte
 *                   silently corrupts the whole batch parse) — reports byte offset+value.
 *   2 SH-CRLF       .sh/.bash with CRLF line endings (breaks under bash).
 *   3 JSON-BADUTF8  .json with a UTF-8 BOM or an invalid UTF-8 sequence.
 *   4 ROOT-SHADOW   scan-ROOT file whose basename (case-insensitive, with/without
 *                   extension) shadows a cmd builtin/common command, or is purely
 *                   numeric ("12") — the documented shadow-break class.
 *   5 CASE-COLLIDE  two paths differing only by case (collide on Windows/NTFS).
 *
 * Read-only: never writes, moves, or edits anything in the world. --canary
 * experiments are confined to a throwaway temp dir.
 *
 *   scan [dir]     audit dir (default cwd): git ls-files if a repo, else walk
 *   --canary       self-test (the done-check); both directions
 *   --help
 *
 * Exit codes: 0 clean · 1 findings · 2 usage error.
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// cmd builtins + common commands a stray root file can shadow in a .bat parse.
const SHADOW_NAMES = new Set([
  "echo", "type", "sort", "find", "time", "date", "path", "exit", "set",
]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// ---- helpers ---------------------------------------------------------------

// first byte > 0x7F in a buffer, or -1 if pure ASCII.
function firstNonAscii(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return i;
  return -1;
}

// true if the buffer contains a CRLF sequence.
function hasCRLF(buf) {
  for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return true;
  return false;
}

// UTF-8 validity + BOM check. Returns { bom, valid, offset } — offset is the
// byte index of the first invalid sequence (bad === !valid).
function checkUtf8(buf) {
  let i = 0;
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (bom) i = 3;
  for (; i < buf.length;) {
    const b = buf[i];
    if (b <= 0x7f) { i++; continue; }
    let n; // number of continuation bytes expected
    if (b >= 0xc2 && b <= 0xdf) n = 1;
    else if (b >= 0xe0 && b <= 0xef) n = 2;
    else if (b >= 0xf0 && b <= 0xf4) n = 3;
    else return { bom, valid: false, offset: i }; // 0x80-0xc1, 0xf5-0xff: invalid lead
    if (i + n >= buf.length) return { bom, valid: false, offset: i }; // truncated
    for (let k = 1; k <= n; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return { bom, valid: false, offset: i }; // bad continuation
    }
    i += n + 1;
  }
  return { bom, valid: true, offset: -1 };
}

// basename shadow key: lowercased, extension stripped. "ECHO.bat" -> "echo".
function shadowKey(base) {
  const noExt = base.replace(/\.[^.]*$/, "");
  return noExt.toLowerCase();
}

function isPurelyNumeric(base) {
  const noExt = base.replace(/\.[^.]*$/, "");
  return noExt.length > 0 && /^[0-9]+$/.test(noExt);
}

// enumerate files. In a git repo: `git ls-files` (respects .gitignore, tracked
// only). Else: recursive walk skipping node_modules/.git. Returns paths RELATIVE
// to root (forward-slash), which is what the case-collision + root checks want.
function listFiles(root) {
  // -c core.quotePath=false + -z: NUL-delimited, UNESCAPED UTF-8 paths. Without
  // this, git octal-escapes and double-quotes any non-ASCII name (e.g.
  // "caf\303\251.bat"), which mangles basename/extname — a non-ASCII-named
  // .bat/.json/.sh would be silently skipped by the content scan AND misfire a
  // false ROOT-SHADOW. Read raw bytes (no encoding) so multibyte names survive.
  const g = spawnSync("git", ["-C", root, "-c", "core.quotePath=false", "ls-files", "-z"]);
  if (g.status === 0) {
    return g.stdout.toString("utf8").split("\0").filter(Boolean);
  }
  const out = [];
  (function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // don't follow links (read-only, no traversal surprises)
      const abs = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(abs, r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  })(root, "");
  return out;
}

// ---- scan ------------------------------------------------------------------
// Returns an array of findings: { cls, file, detail, fix }.
function scan(root) {
  return scanList(root, listFiles(root));
}

// core scan over an explicit RELATIVE-path list (forward-slash). Split out so the
// canary can exercise CASE-COLLIDE deterministically: NTFS can't hold both
// Case.txt and case.txt on disk, but `git ls-files` returns both — that's the
// real scenario, reproduced here by supplying the list directly.
function scanList(root, files) {
  const findings = [];
  const byLowerPath = new Map(); // lowercased relpath -> first-seen actual relpath

  for (const rel of files) {
    const abs = path.join(root, rel);
    const base = path.basename(rel);
    const ext = path.extname(rel).toLowerCase();
    const inRoot = !rel.includes("/");

    // (5) case-collision: two distinct paths, same lowercased form.
    const low = rel.toLowerCase();
    if (byLowerPath.has(low)) {
      findings.push({
        cls: "CASE-COLLIDE",
        file: rel,
        detail: `collides with '${byLowerPath.get(low)}' (differs only by case)`,
        fix: "rename one — Windows/NTFS treats these as the same path; a checkout clobbers one.",
      });
    } else {
      byLowerPath.set(low, rel);
    }

    // (4) root-shadow: only files directly in the scan root.
    if (inRoot) {
      if (SHADOW_NAMES.has(shadowKey(base))) {
        findings.push({
          cls: "ROOT-SHADOW",
          file: rel,
          detail: `basename shadows cmd builtin/command '${shadowKey(base)}'`,
          fix: "rename it (e.g. prefix with the project) — a root file named like a builtin breaks .bat parses that call that command.",
        });
      } else if (isPurelyNumeric(base)) {
        findings.push({
          cls: "ROOT-SHADOW",
          file: rel,
          detail: `purely-numeric basename '${base.replace(/\.[^.]*$/, "")}' (documented shadow-break class)`,
          fix: "rename it — a root file like '12' shadows numeric tokens and corrupts batch parsing.",
        });
      }
    }

    // content-based classes: only read files whose extension is in scope.
    const isBat = ext === ".bat" || ext === ".cmd";
    const isSh = ext === ".sh" || ext === ".bash";
    const isJson = ext === ".json";
    if (!isBat && !isSh && !isJson) continue;

    let buf;
    try { buf = fs.readFileSync(abs); }
    catch { continue; } // deleted-but-tracked, permission, etc. — skip silently

    if (isBat) {
      const off = firstNonAscii(buf);
      if (off >= 0) {
        findings.push({
          cls: "BAT-NONASCII",
          file: rel,
          detail: `first non-ASCII byte at offset ${off}: 0x${buf[off].toString(16).padStart(2, "0")}`,
          fix: "re-save as pure ASCII — ONE non-ASCII byte silently corrupts the whole batch parse.",
        });
      }
    }
    if (isSh) {
      if (hasCRLF(buf)) {
        findings.push({
          cls: "SH-CRLF",
          file: rel,
          detail: "contains CRLF line endings",
          fix: "convert to LF (e.g. `dos2unix`, or git `* text=auto eol=lf`) — CRLF breaks the shebang/commands under bash.",
        });
      }
    }
    if (isJson) {
      const u = checkUtf8(buf);
      if (u.bom) {
        findings.push({
          cls: "JSON-BADUTF8",
          file: rel,
          detail: "starts with a UTF-8 BOM (EF BB BF)",
          fix: "strip the BOM — many JSON parsers choke on it. Likely written by PowerShell Set-Content/Out-File; use -Encoding utf8 (no BOM) or a Node writer.",
        });
      } else if (!u.valid) {
        findings.push({
          cls: "JSON-BADUTF8",
          file: rel,
          detail: `invalid UTF-8 sequence at byte offset ${u.offset}`,
          fix: "re-save as valid UTF-8 — likely corrupted by a PowerShell rewrite (ANSI codepage mangles emoji/multibyte). Use a Node writer.",
        });
      }
    }
  }
  return findings;
}

// ---- reporting -------------------------------------------------------------
function report(root, findings) {
  if (findings.length === 0) {
    console.log(`CLEAN — no path/file quirks found in ${root}`);
    return 0;
  }
  // group by class for a readable sweep.
  const order = ["BAT-NONASCII", "SH-CRLF", "JSON-BADUTF8", "ROOT-SHADOW", "CASE-COLLIDE"];
  findings.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.file.localeCompare(b.file));
  for (const f of findings) {
    console.log(`${f.cls}\t${f.file}`);
    console.log(`  ${f.detail}`);
    console.log(`  fix: ${f.fix}`);
  }
  console.error(`\n${findings.length} finding(s). Pair with a symptom-side Windows-failure runbook to triage each one.`);
  return 1;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Plants one instance of every class in a throwaway dir and asserts all are
// flagged (bad direction), then asserts a clean dir yields zero (good direction).
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "path-quirk-canary-"));
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) passed++; else console.error(`  FAIL: ${label}`); };
  try {
    // --- bad dir: one instance of each class -------------------------------
    const bad = path.join(root, "bad");
    fs.mkdirSync(bad, { recursive: true });

    // (1) non-ASCII .bat: an em-dash byte (0xE2 in UTF-8) mid-file.
    fs.writeFileSync(path.join(bad, "build.bat"), Buffer.from("@echo off\nrem — dash\n", "utf8"));
    // (2) CRLF .sh
    fs.writeFileSync(path.join(bad, "deploy.sh"), "#!/bin/bash\r\necho hi\r\n");
    // (3) BOM .json
    fs.writeFileSync(path.join(bad, "config.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]));
    // (4a) root file shadowing a builtin
    fs.writeFileSync(path.join(bad, "echo.bat"), "@echo off\n"); // note: also pure-ASCII so class 1 stays quiet here
    // (4b) purely-numeric root file
    fs.writeFileSync(path.join(bad, "12"), "junk\n");
    // (5) case-collision pair — supplied via the list, NOT the FS: NTFS can't
    //     hold both on disk, but `git ls-files` returns both (the real case).
    fs.writeFileSync(path.join(bad, "Case.txt"), "a\n");

    const f = scanList(bad, [...listFiles(bad), "case.txt"]);
    const has = (cls, sub) => f.some((x) => x.cls === cls && (!sub || x.file.includes(sub)));
    check(has("BAT-NONASCII", "build.bat"), "flags non-ASCII .bat");
    check(has("SH-CRLF", "deploy.sh"), "flags CRLF .sh");
    check(has("JSON-BADUTF8", "config.json"), "flags BOM .json");
    check(has("ROOT-SHADOW", "echo.bat"), "flags builtin-shadowing root file");
    check(has("ROOT-SHADOW", "12"), "flags purely-numeric root file");
    check(has("CASE-COLLIDE"), "flags case-collision pair");
    // report exits 1 on findings
    check(report(bad, f) === 1, "report exits 1 on findings");

    // --- also assert invalid (non-BOM) UTF-8 is caught ----------------------
    const bad2 = path.join(root, "bad2");
    fs.mkdirSync(bad2, { recursive: true });
    fs.writeFileSync(path.join(bad2, "data.json"), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d])); // {"a":<0xFF>}
    const f2 = scan(bad2);
    check(f2.some((x) => x.cls === "JSON-BADUTF8" && x.detail.includes("invalid UTF-8")), "flags invalid-UTF-8 .json");

    // --- good dir: nothing should fire -------------------------------------
    const good = path.join(root, "good");
    fs.mkdirSync(path.join(good, "sub"), { recursive: true });
    fs.writeFileSync(path.join(good, "build.bat"), "@echo off\nrem plain ascii\n"); // pure ASCII, not a shadow name
    fs.writeFileSync(path.join(good, "deploy.sh"), "#!/bin/bash\necho hi\n"); // LF only
    fs.writeFileSync(path.join(good, "config.json"), Buffer.from('{"ok":true,"emoji":"✅"}\n', "utf8")); // valid UTF-8, no BOM
    fs.writeFileSync(path.join(good, "sub", "echo.bat"), "@echo off\n"); // shadow name but NOT in root -> ok
    fs.writeFileSync(path.join(good, "readme.txt"), "hello\n");
    const fg = scan(good);
    check(fg.length === 0, `clean dir yields zero findings (got ${fg.length}: ${fg.map((x) => x.cls + ":" + x.file).join(", ")})`);
    check(report(good, fg) === 0, "report exits 0 on clean");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `path-quirk-audit — read-only scan for Windows path/file corruption classes.

Usage:
  node path-quirk-audit.js scan [dir]   audit dir (default cwd)
  node path-quirk-audit.js --canary     self-test (the done-check)
  node path-quirk-audit.js --help

Enumerates via 'git ls-files' in a repo, else a recursive walk skipping
node_modules/.git. Flags:
  BAT-NONASCII  .bat/.cmd with ANY non-ASCII byte (breaks the batch parse)
  SH-CRLF       .sh/.bash with CRLF line endings
  JSON-BADUTF8  .json with a UTF-8 BOM or invalid UTF-8
  ROOT-SHADOW   root file shadowing a cmd builtin (echo/type/sort/find/time/
                date/path/exit/set) or a purely-numeric name ("12")
  CASE-COLLIDE  two paths differing only by case

Read-only — never writes/moves/edits anything.
Exit codes: 0 clean · 1 findings · 2 usage error.`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); process.exit(0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const sub = argv[0];
  if (sub === "scan" || sub === undefined) {
    const dirArg = sub === "scan" ? argv[1] : undefined;
    const root = path.resolve(dirArg || process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error(`error: not a directory: ${root}`);
      process.exit(2);
    }
    process.exit(report(root, scan(root)));
  }

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
