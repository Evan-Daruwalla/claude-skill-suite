#!/usr/bin/env node
/*
 * golden-lock — freeze any output as a byte-exact golden baseline, diff on change.
 * Generalizes frozen-regression-test discipline (a report output pinned
 * byte-exact) to ARBITRARY outputs: a command's stdout, a fixture file, or a
 * prompt/text asset. "freeze" records the baseline; "check" re-produces it and
 * fails on any drift.
 *
 *   freeze <name> --cmd "<command>"   run via shell, capture stdout + exit code
 *   freeze <name> --file <path>       golden = the file's bytes
 *   check  <name> [--update]          re-produce, compare byte-exact; --update re-baselines
 *   list                              one line per baseline in .golden/
 *   --canary                          self-test (the done-check); both directions
 *
 * Normalization (stored at freeze, re-applied at check): --normalize-eol (CRLF->LF),
 * --strip-ansi. DEFAULT is byte-exact. Timestamps live ONLY in meta.json, never in
 * output.txt — baselines must be machine- and time-stable.
 *
 * Exit codes: 0 ok/match · 1 mismatch/canary-fail · 2 usage error / missing baseline.
 * Zero dependencies, Node >=16.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g; // CSI escape sequences (colors, cursor moves)
const MAX_BUF = 1 << 28; // 256 MB captured-stdout ceiling

// ---- helpers ---------------------------------------------------------------
function sha256(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }

// name must be a single safe path segment — blocks traversal; nothing is ever
// written outside .golden/ (or the canary's tmp dir).
function validName(name) {
  return typeof name === "string" && NAME_RE.test(name) && !name.includes("..");
}

function normalize(str, norm) {
  if (norm.stripAnsi) str = str.replace(ANSI_RE, "");
  if (norm.normalizeEol) str = str.replace(/\r\n/g, "\n");
  return str;
}

function baselineDir(root, name) { return path.join(root, ".golden", name); }

function readMeta(root, name) {
  const mp = path.join(baselineDir(root, name), "meta.json");
  if (!fs.existsSync(mp)) return null;
  return JSON.parse(fs.readFileSync(mp, "utf8"));
}

// produce the CURRENT output for a baseline, with the given normalization applied.
// Returns { output, exitCode } — exitCode is null for file mode.
function produce(root, mode, cmd, file, norm) {
  if (mode === "cmd") {
    const r = spawnSync(cmd, { shell: true, cwd: root, encoding: "buffer", maxBuffer: MAX_BUF });
    if (r.error) throw new Error("command failed to launch: " + r.error.message);
    const out = normalize((r.stdout || Buffer.alloc(0)).toString("utf8"), norm);
    // signal-killed => status null; record as -1 so a crash is itself a diff.
    return { output: out, exitCode: r.status == null ? -1 : r.status };
  }
  // file mode: path stored relative to root (or absolute) at freeze time.
  const fp = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(fp)) throw new Error("frozen file no longer exists: " + fp);
  return { output: normalize(fs.readFileSync(fp, "utf8"), norm), exitCode: null };
}

function writeBaseline(root, name, mode, cmd, file, exitCode, output, norm) {
  const dir = baselineDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "output.txt"), output); // EXACTLY the (normalized) output
  const meta = {
    mode,
    command: mode === "cmd" ? cmd : null,
    file: mode === "file" ? file : null,
    exitCode,
    sha256: sha256(output),
    createdAt: new Date().toISOString(),
    normalizeEol: !!norm.normalizeEol,
    stripAnsi: !!norm.stripAnsi,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

// positional line diff — deterministic and adequate for regression baselines.
// (An inserted line shifts everything after it; that still surfaces the drift.)
function lineDiff(expected, actual) {
  const e = expected.split("\n"), a = actual.split("\n");
  const n = Math.max(e.length, a.length), diffs = [];
  for (let i = 0; i < n; i++) if (e[i] !== a[i]) diffs.push([i + 1, e[i], a[i]]);
  return diffs;
}

function printDiff(expected, actual) {
  const diffs = lineDiff(expected, actual);
  const shown = diffs.slice(0, 40);
  for (const [ln, exp, act] of shown) {
    console.error(`  L${ln} - ${exp === undefined ? "(no line)" : JSON.stringify(exp)}`);
    console.error(`  L${ln} + ${act === undefined ? "(no line)" : JSON.stringify(act)}`);
  }
  if (diffs.length > shown.length) console.error(`  +${diffs.length - shown.length} more differing lines`);
}

// ---- commands --------------------------------------------------------------
function cmdFreeze(root, name, opts) {
  if (!validName(name)) { console.error(`error: bad baseline name '${name}' (must match ${NAME_RE}, no "..")`); return 2; }
  if (!!opts.cmd === !!opts.file) { console.error("error: freeze needs exactly one of --cmd \"<command>\" or --file <path>"); return 2; }
  const mode = opts.cmd ? "cmd" : "file";
  let res;
  try { res = produce(root, mode, opts.cmd, opts.file, opts.norm); }
  catch (e) { console.error("error: " + e.message); return 2; }
  const meta = writeBaseline(root, name, mode, opts.cmd || null, opts.file || null, res.exitCode, res.output, opts.norm);
  console.log(`FROZEN ${name} [${mode}] sha256=${meta.sha256.slice(0, 12)} ${Buffer.byteLength(res.output, "utf8")} bytes` +
    (mode === "cmd" ? ` exit=${res.exitCode}` : ""));
  return 0;
}

function cmdCheck(root, name, opts) {
  if (!validName(name)) { console.error(`error: bad baseline name '${name}'`); return 2; }
  const meta = readMeta(root, name);
  if (!meta) { console.error(`error: no baseline '${name}' in .golden/ (freeze it first)`); return 2; }
  const norm = { normalizeEol: meta.normalizeEol, stripAnsi: meta.stripAnsi };
  let res;
  try { res = produce(root, meta.mode, meta.command, meta.file, norm); }
  catch (e) { console.error("error: " + e.message); return 2; }
  const expected = fs.readFileSync(path.join(baselineDir(root, name), "output.txt"), "utf8");
  const outMatch = res.output === expected;
  const exitMatch = meta.mode !== "cmd" || res.exitCode === meta.exitCode;

  if (outMatch && exitMatch) {
    if (opts.update) console.log(`UP-TO-DATE ${name} (already matches)`);
    else console.log(`MATCH ${name}`);
    return 0;
  }
  if (opts.update) {
    const m = writeBaseline(root, name, meta.mode, meta.command, meta.file, res.exitCode, res.output, norm);
    console.log(`UPDATED ${name} [${meta.mode}] sha256=${m.sha256.slice(0, 12)}`);
    return 0;
  }
  console.error(`MISMATCH ${name}`);
  if (!exitMatch) console.error(`  exit code: expected ${meta.exitCode}, got ${res.exitCode}`);
  if (!outMatch) printDiff(expected, res.output);
  return 1;
}

function cmdList(root) {
  const gdir = path.join(root, ".golden");
  if (!fs.existsSync(gdir)) { console.log("(no baselines — .golden/ does not exist)"); return 0; }
  const names = fs.readdirSync(gdir).filter((n) => fs.existsSync(path.join(gdir, n, "meta.json"))).sort();
  if (!names.length) { console.log("(no baselines in .golden/)"); return 0; }
  for (const n of names) {
    const m = readMeta(root, n);
    const created = (m.createdAt || "").slice(0, 10);
    console.log(`${n}\t${m.mode}\t${created}\t${(m.sha256 || "").slice(0, 12)}`);
  }
  return 0;
}

// ---- canary: the self-test AND the done-check ------------------------------
// Proves BOTH directions in a throwaway dir: an unchanged output MATCHES and a
// tampered one is CAUGHT. ENV GOTCHA (Windows scar tissue): do NOT use
// `node -e "<quoted code>"` as the frozen command — PS 5.1 mangles quoted -e and
// leaves 0-byte junk files. Freeze `node <tempfile.js>` instead.
function runCanary() {
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "golden-lock-canary-"));
  const norm = { normalizeEol: false, stripAnsi: false };
  let passed = 0, total = 0;
  const check = (cond, label) => { total++; if (cond) { passed++; } else console.error(`  FAIL: ${label}`); };
  try {
    // deterministic frozen command: a tiny temp .js that prints stable output.
    const gen = path.join(root, "gen.js");
    fs.writeFileSync(gen, 'process.stdout.write("golden line 1\\ngolden line 2\\nchecksum=stable\\n");\n');
    const genCmd = `node "${gen}"`;

    // (a) freeze a command, unchanged check -> MATCH exit 0
    check(cmdFreeze(root, "cmd_base", { cmd: genCmd, norm }) === 0, "freeze cmd -> 0");
    check(cmdCheck(root, "cmd_base", {}) === 0, "check unchanged cmd -> MATCH exit 0");

    // (b) tamper output.txt, check -> MISMATCH exit 1 with a diff
    const outFile = path.join(baselineDir(root, "cmd_base"), "output.txt");
    fs.writeFileSync(outFile, "golden line 1\nTAMPERED\nchecksum=stable\n");
    check(cmdCheck(root, "cmd_base", {}) === 1, "check tampered cmd -> MISMATCH exit 1");
    check(lineDiff("golden line 1\nTAMPERED\n", "golden line 1\ngolden line 2\n").length === 1, "diff isolates the changed line");

    // (c) freeze a file -> MATCH, mutate it -> MISMATCH
    const asset = path.join(root, "prompt.txt");
    fs.writeFileSync(asset, "You are a careful reviewer.\nBe terse.\n");
    check(cmdFreeze(root, "file_base", { file: "prompt.txt", norm }) === 0, "freeze file -> 0");
    check(cmdCheck(root, "file_base", {}) === 0, "check unchanged file -> MATCH exit 0");
    fs.writeFileSync(asset, "You are a careful reviewer.\nBe VERBOSE.\n");
    check(cmdCheck(root, "file_base", {}) === 1, "check mutated file -> MISMATCH exit 1");

    // name validation blocks traversal
    check(cmdFreeze(root, "../evil", { cmd: genCmd, norm }) === 2, "traversal name rejected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (passed === total) { console.log(`CANARY PASS ${passed}/${total}`); return 0; }
  console.error(`CANARY FAIL ${passed}/${total}`);
  return 1;
}

// ---- arg parsing + help ----------------------------------------------------
const HELP = `golden-lock — freeze any output as a golden baseline, diff on change.

Usage:
  node golden-lock.js freeze <name> --cmd "<command>" [--normalize-eol] [--strip-ansi]
  node golden-lock.js freeze <name> --file <path>     [--normalize-eol] [--strip-ansi]
  node golden-lock.js check  <name> [--update]
  node golden-lock.js list
  node golden-lock.js --canary
  node golden-lock.js --help

Baselines live in ./.golden/<name>/ (output.txt + meta.json) — commit them.
<name> must match ${NAME_RE} and contain no "..".
Normalization (--normalize-eol, --strip-ansi) is stored at freeze and re-applied
at check; default is byte-exact. Timestamps live only in meta.json.

Exit codes: 0 ok/match · 1 mismatch/canary-fail · 2 usage error / missing baseline.`;

function getOpt(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) { console.log(HELP); process.exit(argv.length === 0 ? 2 : 0); }
  if (argv.includes("--canary")) process.exit(runCanary());

  const norm = { normalizeEol: argv.includes("--normalize-eol"), stripAnsi: argv.includes("--strip-ansi") };
  const sub = argv[0];
  const name = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;

  if (sub === "freeze") process.exit(cmdFreeze(process.cwd(), name, { cmd: getOpt(argv, "--cmd"), file: getOpt(argv, "--file"), norm }));
  if (sub === "check") process.exit(cmdCheck(process.cwd(), name, { update: argv.includes("--update") }));
  if (sub === "list") process.exit(cmdList(process.cwd()));

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
