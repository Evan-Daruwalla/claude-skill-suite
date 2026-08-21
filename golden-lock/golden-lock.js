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
// BYTES, not strings. Until 2026-08-20 every path here decoded through
// toString("utf8"), so any byte sequence that is not valid UTF-8 collapsed to
// U+FFFD and two DIFFERENT files compared EQUAL. Measured: a file changed from
// `41 80 81 42 0a` to `41 82 83 42 0a` reported MATCH, exit 0, and the stored
// baseline was `41 efbfbd efbfbd 42 0a` — 9 bytes recorded for a 5-byte file.
// A tool whose one job is byte-exactness cannot round-trip through a string.
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

// name must be a single safe path segment — blocks traversal; nothing is ever
// written outside .golden/ (or the canary's tmp dir).
function validName(name) {
  return typeof name === "string" && NAME_RE.test(name) && !name.includes("..");
}

// latin1 is a lossless 1:1 byte<->code-unit mapping, so a regex can run over
// arbitrary bytes and come back unchanged. utf8 cannot: it destroys them.
function normalize(buf, norm) {
  if (!norm.stripAnsi && !norm.normalizeEol) return buf;
  let s = buf.toString("latin1");
  if (norm.stripAnsi) s = s.replace(ANSI_RE, "");
  if (norm.normalizeEol) s = s.replace(/\r\n/g, "\n");
  return Buffer.from(s, "latin1");
}

function baselineDir(root, name) { return path.join(root, ".golden", name); }

// A damaged baseline must NOT surface as a mismatch. An uncaught JSON.parse
// threw a stack trace and exited 1 — which is this tool's documented MISMATCH
// code — so a CI wrapper read "the output drifted" when the baseline was
// merely unreadable, and `list` died entirely on one corrupt entry, hiding
// every healthy baseline behind it. Return the "unusable baseline" signal
// instead and let callers exit 2.
function readMeta(root, name) {
  const mp = path.join(baselineDir(root, name), "meta.json");
  if (!fs.existsSync(mp)) return null;
  try { return JSON.parse(fs.readFileSync(mp, "utf8")); }
  catch (e) { return { __unreadable: e.message }; }
}

// produce the CURRENT output for a baseline, with the given normalization applied.
// Returns { output: Buffer, exitCode } — exitCode is null for file mode.
function produce(root, mode, cmd, file, norm) {
  if (mode === "cmd") {
    const r = spawnSync(cmd, { shell: true, cwd: root, encoding: "buffer", maxBuffer: MAX_BUF });
    if (r.error) {
      // ENOBUFS is a truncated capture, not a launch failure — reporting it as
      // "failed to launch" sent you looking for a broken command instead of a
      // command that printed more than the ceiling.
      if (r.error.code === "ENOBUFS") {
        throw new Error(`command produced more than the ${MAX_BUF} byte capture ceiling — output truncated, refusing to freeze a partial baseline`);
      }
      throw new Error("command failed to launch: " + r.error.message);
    }
    const out = normalize(r.stdout || Buffer.alloc(0), norm);
    // signal-killed => status null; record as -1 so a crash is itself a diff.
    return {
      output: out,
      exitCode: r.status == null ? -1 : r.status,
      // Kept so cmdFreeze can tell "this command produced nothing at all" from
      // "this command reports on stderr and we captured none of it". Only stdout
      // is ever frozen — that is the documented contract — but a command whose
      // ENTIRE output goes to stderr freezes a 0-byte baseline whose sha256 is
      // the empty-string hash, and every later check MATCHes no matter what the
      // command does. Measured 2026-08-20: a stderr-only linter froze at
      // `sha256=e3b0c44298fc 0 bytes` and still reported MATCH after its output
      // was replaced entirely.
      stderrLen: (r.stderr || Buffer.alloc(0)).length,
    };
  }
  // file mode: path stored relative to root (or absolute) at freeze time.
  const fp = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(fp)) throw new Error("frozen file no longer exists: " + fp);
  return { output: normalize(fs.readFileSync(fp), norm), exitCode: null };
}

// `.golden/` is meant to be COMMITTED (SKILL.md says so), so freezing a file
// from outside the tree copies its contents into version control. `--file
// ../../../secret.txt` was accepted silently while `<name>` was traversal-
// checked. Opt in explicitly instead.
function fileEscapesRoot(root, file) {
  const fp = path.resolve(path.isAbsolute(file) ? file : path.join(root, file));
  const rel = path.relative(path.resolve(root), fp);
  return rel.startsWith("..") || path.isAbsolute(rel);
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

// Display only — this is the ONE place a decode is correct, because a human is
// about to read it. Comparison never goes through here.
function printDiff(expectedBuf, actualBuf) {
  const expected = expectedBuf.toString("utf8");
  const actual = actualBuf.toString("utf8");
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
  if (mode === "file" && fileEscapesRoot(root, opts.file) && !opts.allowOutside) {
    console.error(`error: --file ${opts.file} resolves outside ${root}. .golden/ is meant to be committed, so this would copy an outside file into version control. Pass --allow-outside if that is what you want.`);
    return 2;
  }
  let res;
  try { res = produce(root, mode, opts.cmd, opts.file, opts.norm); }
  catch (e) { console.error("error: " + e.message); return 2; }
  // An EMPTY baseline can never fail a check — it matches anything that also
  // produces nothing on stdout, forever. That is not a frozen output, it is a
  // frozen absence, and it is indistinguishable from a working guard.
  if (res.output.length === 0 && !opts.allowEmpty) {
    console.error(`error: '${name}' produced 0 bytes on stdout — refusing to freeze an empty baseline, because it can never fail a check.`);
    if (mode === "cmd" && res.stderrLen > 0) {
      console.error(`  the command wrote ${res.stderrLen} byte(s) to STDERR. golden-lock freezes stdout only;`);
      console.error(`  redirect it if that is the output you meant to pin:  --cmd "<command> 2>&1"`);
    }
    console.error("  pass --allow-empty if an empty stdout really is the thing you are pinning.");
    return 2;
  }
  const meta = writeBaseline(root, name, mode, opts.cmd || null, opts.file || null, res.exitCode, res.output, opts.norm);
  console.log(`FROZEN ${name} [${mode}] sha256=${meta.sha256.slice(0, 12)} ${res.output.length} bytes` +
    (mode === "cmd" ? ` exit=${res.exitCode}` : ""));
  return 0;
}

function cmdCheck(root, name, opts) {
  if (!validName(name)) { console.error(`error: bad baseline name '${name}'`); return 2; }
  const meta = readMeta(root, name);
  if (!meta) { console.error(`error: no baseline '${name}' in .golden/ (freeze it first)`); return 2; }
  if (meta.__unreadable) { console.error(`error: baseline '${name}' is unreadable (${meta.__unreadable}) — NOT a mismatch, re-freeze it`); return 2; }
  const norm = { normalizeEol: meta.normalizeEol, stripAnsi: meta.stripAnsi };
  let res;
  try { res = produce(root, meta.mode, meta.command, meta.file, norm); }
  catch (e) { console.error("error: " + e.message); return 2; }
  // a present meta.json with a missing/unreadable output.txt is the same class:
  // an incomplete baseline, not a drifted output
  let expected;
  try { expected = fs.readFileSync(path.join(baselineDir(root, name), "output.txt")); }
  catch (e) { console.error(`error: baseline '${name}' is incomplete (${e.code || e.message}) — NOT a mismatch, re-freeze it`); return 2; }

  // meta.sha256 was written at every freeze and read by NO code path. It exists
  // to tell "your output drifted" apart from "the baseline itself is damaged",
  // and without it a truncated output.txt (writeBaseline is two non-atomic
  // writes, so an interrupted freeze lands exactly here) reported MISMATCH and
  // blamed the current output. Measured: baseline truncated to 3 bytes, file
  // untouched -> MISMATCH exit 1.
  if (meta.sha256 && sha256(expected) !== meta.sha256) {
    console.error(`error: baseline '${name}' is damaged — output.txt does not match meta.sha256 (expected ${String(meta.sha256).slice(0, 12)}, got ${sha256(expected).slice(0, 12)}). NOT a mismatch; re-freeze it.`);
    return 2;
  }

  const outMatch = Buffer.compare(res.output, expected) === 0;
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
  // one damaged baseline must not hide the healthy ones: report it in place
  // and keep listing. Previously the throw killed the whole command.
  let bad = 0;
  for (const n of names) {
    const m = readMeta(root, n);
    if (m.__unreadable) { console.log(`${n}\t(UNREADABLE — ${m.__unreadable})`); bad++; continue; }
    const created = (m.createdAt || "").slice(0, 10);
    console.log(`${n}\t${m.mode}\t${created}\t${(m.sha256 || "").slice(0, 12)}`);
  }
  return bad ? 2 : 0;
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

    // (b) change what the COMMAND PRODUCES -> MISMATCH exit 1 with a diff.
    //     This case used to tamper output.txt instead. That is "the baseline is
    //     damaged", not "the output drifted" — two different verdicts the tool
    //     could not tell apart until meta.sha256 was actually read (see (e)).
    //     Asserting on the baseline made the canary agree with the bug.
    fs.writeFileSync(gen, 'process.stdout.write("golden line 1\\nDRIFTED\\nchecksum=stable\\n");\n');
    check(cmdCheck(root, "cmd_base", {}) === 1, "check drifted cmd -> MISMATCH exit 1");
    fs.writeFileSync(gen, 'process.stdout.write("golden line 1\\ngolden line 2\\nchecksum=stable\\n");\n');
    check(cmdCheck(root, "cmd_base", {}) === 0, "restoring the command restores MATCH");
    check(lineDiff("golden line 1\nDRIFTED\n", "golden line 1\ngolden line 2\n").length === 1, "diff isolates the changed line");

    // (c) freeze a file -> MATCH, mutate it -> MISMATCH
    const asset = path.join(root, "prompt.txt");
    fs.writeFileSync(asset, "You are a careful reviewer.\nBe terse.\n");
    check(cmdFreeze(root, "file_base", { file: "prompt.txt", norm }) === 0, "freeze file -> 0");
    check(cmdCheck(root, "file_base", {}) === 0, "check unchanged file -> MATCH exit 0");
    fs.writeFileSync(asset, "You are a careful reviewer.\nBe VERBOSE.\n");
    check(cmdCheck(root, "file_base", {}) === 1, "check mutated file -> MISMATCH exit 1");

    // name validation blocks traversal
    check(cmdFreeze(root, "../evil", { cmd: genCmd, norm }) === 2, "traversal name rejected");

    // ---- 2026-08-20 audit: byte-exactness, the tool's entire premise ------
    // (d) two DIFFERENT files whose invalid-UTF-8 bytes both decode to U+FFFD
    //     must NOT compare equal. This is the assertion whose absence let a
    //     5-byte file be stored as 9 bytes and report MATCH after changing.
    const bin = path.join(root, "bytes.bin");
    fs.writeFileSync(bin, Buffer.from([0x41, 0x80, 0x81, 0x42, 0x0a]));
    check(cmdFreeze(root, "bin_base", { file: "bytes.bin", norm }) === 0, "freeze binary file -> 0");
    const storedBin = fs.readFileSync(path.join(baselineDir(root, "bin_base"), "output.txt"));
    check(storedBin.length === 5 && storedBin[1] === 0x80 && storedBin[2] === 0x81,
      "baseline stores the ORIGINAL bytes, not a utf8 transcode");
    check(cmdCheck(root, "bin_base", {}) === 0, "unchanged binary -> MATCH");
    fs.writeFileSync(bin, Buffer.from([0x41, 0x82, 0x83, 0x42, 0x0a]));
    check(cmdCheck(root, "bin_base", {}) === 1, "different invalid-utf8 bytes -> MISMATCH");
    // and a single-byte change inside otherwise-valid text
    const cp = path.join(root, "cp1252.txt");
    fs.writeFileSync(cp, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));   // café, cp1252
    cmdFreeze(root, "cp_base", { file: "cp1252.txt", norm });
    fs.writeFileSync(cp, Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]));   // cafè
    check(cmdCheck(root, "cp_base", {}) === 1, "one changed high byte -> MISMATCH");

    // (e) a DAMAGED baseline is exit 2 ("re-freeze it"), never exit 1
    //     ("your output drifted"). meta.sha256 is what tells them apart, and
    //     it was written by every freeze and read by no code path.
    const clean = path.join(root, "clean.txt");
    fs.writeFileSync(clean, "line one\nline two\n");
    cmdFreeze(root, "sha_base", { file: "clean.txt", norm });
    check(cmdCheck(root, "sha_base", {}) === 0, "clean baseline -> MATCH");
    fs.writeFileSync(path.join(baselineDir(root, "sha_base"), "output.txt"), "lin");
    check(cmdCheck(root, "sha_base", {}) === 2, "damaged baseline -> exit 2, not MISMATCH");

    // (f) freezing a file from outside the tree must not silently copy it into
    //     .golden/, which SKILL.md tells you to commit
    // The file is created FIRST so the refusal is provably the escape check and
    // not a missing file — a case that cannot reach the code it names is the
    // false-green this whole pass exists to remove.
    const outsideFile = path.join(path.dirname(root), "outside-secret.txt");
    fs.writeFileSync(outsideFile, "s3cret\n");
    check(cmdFreeze(root, "outside", { file: "../outside-secret.txt", norm }) === 2,
      "--file outside the root is refused by default");
    check(!fs.existsSync(baselineDir(root, "outside")), "the refused baseline was never written");
    check(cmdFreeze(root, "outside_ok", { file: "../outside-secret.txt", norm, allowOutside: true }) === 0,
      "--allow-outside opts back in");
    try { fs.unlinkSync(outsideFile); } catch (_) {}

    // (f2) 2026-08-20 audit: an EMPTY baseline can never fail a check. A command
    //      that reports entirely on STDERR froze at 0 bytes (sha256 of the empty
    //      string) and returned MATCH forever after, whatever the command later
    //      did — a guard indistinguishable from a working one.
    const lint = path.join(root, "lint.js");
    fs.writeFileSync(lint, 'console.error("3 problems found\\n");\n');
    check(cmdFreeze(root, "stderr_only", { cmd: `node "${lint}"`, norm }) === 2,
      "a stdout-empty command is REFUSED, not frozen at 0 bytes");
    check(!fs.existsSync(baselineDir(root, "stderr_only")), "...and no baseline directory was created");
    check(cmdFreeze(root, "stderr_ok", { cmd: `node "${lint}"`, norm, allowEmpty: true }) === 0,
      "--allow-empty opts back in when an empty stdout is genuinely the thing being pinned");
    // redirecting stderr into stdout is the documented way to pin it, and must work
    check(cmdFreeze(root, "stderr_merged", { cmd: `node "${lint}" 2>&1`, norm }) === 0,
      "2>&1 freezes the stderr output normally");
    const merged = fs.readFileSync(path.join(baselineDir(root, "stderr_merged"), "output.txt"));
    check(merged.length > 0 && /3 problems found/.test(merged.toString("utf8")),
      "...and the merged baseline actually holds the stderr text");

    // (g) normalization still works, and still on bytes
    fs.writeFileSync(path.join(root, "crlf.txt"), Buffer.from("a\r\nb\r\n", "latin1"));
    check(cmdFreeze(root, "eol_base", { file: "crlf.txt", norm: { normalizeEol: true, stripAnsi: false } }) === 0, "freeze with --normalize-eol");
    fs.writeFileSync(path.join(root, "crlf.txt"), Buffer.from("a\nb\n", "latin1"));
    check(cmdCheck(root, "eol_base", {}) === 0, "--normalize-eol makes CRLF and LF equal");
    fs.writeFileSync(path.join(root, "ansi.txt"), Buffer.from("\x1b[31mred\x1b[0m\n", "latin1"));
    check(cmdFreeze(root, "ansi_base", { file: "ansi.txt", norm: { normalizeEol: false, stripAnsi: true } }) === 0, "freeze with --strip-ansi");
    check(fs.readFileSync(path.join(baselineDir(root, "ansi_base"), "output.txt")).toString("latin1") === "red\n", "--strip-ansi removes the escapes");
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

  if (sub === "freeze") process.exit(cmdFreeze(process.cwd(), name, { cmd: getOpt(argv, "--cmd"), file: getOpt(argv, "--file"), norm, allowOutside: argv.includes("--allow-outside"), allowEmpty: argv.includes("--allow-empty") }));
  if (sub === "check") process.exit(cmdCheck(process.cwd(), name, { update: argv.includes("--update") }));
  if (sub === "list") process.exit(cmdList(process.cwd()));

  console.error(`error: unknown command '${sub}'. Try --help.`);
  process.exit(2);
}
main();
