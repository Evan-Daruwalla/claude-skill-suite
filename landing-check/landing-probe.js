#!/usr/bin/env node
/**
 * landing-probe — deterministic census for the mechanical half of landing-check.
 *
 * Read-only. It answers the enumerable parts of "did the change land where it
 * executes" so the verifying agent reads a table instead of re-deriving it:
 *
 *   HOOK     per repo, per hook name: the file git will RUN (resolved with
 *            `git rev-parse --git-path`, the resolver git itself uses, which
 *            honours core.hooksPath) and any DEAD copy left in the other place.
 *   CHANGED  the changed set per repo (staged / modified / untracked), plus
 *            files named with --file and, for NON-repo roots, files modified in
 *            the last --since minutes.
 *   TWIN     for every changed file, every other file under any root with the
 *            same basename, and whether it is SAME or DIFF (sha256, CRLF-
 *            normalized). Same name, different path, different bytes is the
 *            2026-08-05 signature.
 *   REG      --settings <json>: every path-shaped string in the file, and
 *            whether it resolves on disk (hook registrations, entry points).
 *   REMOTE   ahead/behind per repo. Against the CACHED ref unless --remote is
 *            given, in which case it fetches first — `ahead N` without a fetch
 *            proves nothing, and the line says which one you got.
 *
 * It judges nothing. Exit 1 only when there is something the agent must look
 * at (a DEAD hook copy, a TWIN DIFF of a changed file, a REG path that does not
 * resolve); exit 0 for a clean census. Zero deps.
 *
 *   node landing-probe.js probe <root>... [--file <p>]... [--since <min>]
 *                              [--settings <json>] [--remote] [--all]
 *   node landing-probe.js --canary
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".tox", "dist", "build"]);
const MAX_DEPTH = 8;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  // `out` is trimmed for scalars; `raw` is untouched because `status --porcelain`
  // is positional — a trim eats the leading space of " M path", which shifts the
  // status column and drops the path's first character (".claude" -> "claude").
  return { ok: r.status === 0, out: (r.stdout || "").trim(), raw: r.stdout || "", err: (r.stderr || "").trim() };
}
function isRepo(dir) {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? path.resolve(r.out) : null;
}
function walk(root, onFile, onDir, depth = 0) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (onDir) onDir(p);
      if (depth < MAX_DEPTH) walk(p, onFile, onDir, depth + 1);
    } else if (e.isFile()) onFile(p);
  }
}
// Find git repos at or under each root. A root that is itself inside a repo
// counts as that repo once; otherwise every `.git` below it (not nested).
function findRepos(roots) {
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const top = isRepo(r);
    if (top) { if (!seen.has(top)) { seen.add(top); out.push(top); } continue; }
    walk(r, () => {}, (d) => {
      if (path.basename(d) === ".git") return;
      if (fs.existsSync(path.join(d, ".git"))) {
        const t = path.resolve(d);
        if (!seen.has(t)) { seen.add(t); out.push(t); }
      }
    });
  }
  return out;
}
function sha(p) {
  const b = fs.readFileSync(p);
  // CRLF-normalize so autocrlf checkouts do not read as drift
  const t = b.toString("latin1").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(Buffer.from(t, "latin1")).digest("hex").slice(0, 12);
}

// ---- HOOK ------------------------------------------------------------------
function hookReport(repo) {
  const lines = [];
  const hp = git(repo, ["config", "--get", "core.hooksPath"]).out;
  const gitDir = path.resolve(repo, git(repo, ["rev-parse", "--git-dir"]).out);
  const dotHooks = path.join(gitDir, "hooks");
  const hpAbs = hp ? (path.isAbsolute(hp) ? hp : path.resolve(repo, hp)) : null;
  const names = new Set();
  const listHooks = (d) => {
    try { for (const f of fs.readdirSync(d)) if (!f.endsWith(".sample") && fs.statSync(path.join(d, f)).isFile()) names.add(f); } catch {}
  };
  listHooks(dotHooks);
  if (hpAbs) listHooks(hpAbs);
  for (const n of [...names].sort()) {
    const live = path.resolve(repo, git(repo, ["rev-parse", "--git-path", `hooks/${n}`]).out);
    const liveExists = fs.existsSync(live);
    const candidates = [path.join(dotHooks, n)];
    if (hpAbs) candidates.push(path.join(hpAbs, n));
    const dead = candidates.filter((c) => fs.existsSync(c) && path.resolve(c) !== live);
    lines.push({
      kind: "HOOK", repo, name: n, hooksPath: hp || "(unset)",
      live: live + (liveExists ? "" : "  [MISSING — registered path has no file]"),
      dead, flag: dead.length > 0 || !liveExists,
    });
  }
  return lines;
}

// ---- CHANGED -----------------------------------------------------------------
function changedIn(repo) {
  const r = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  const out = [];
  for (const l of r.raw.split(/\r?\n/)) {
    if (!l.trim()) continue;
    const st = l.slice(0, 2), f = l.slice(3).replace(/^"|"$/g, "");
    const rel = f.includes(" -> ") ? f.split(" -> ")[1] : f;
    out.push({ status: st.trim() || "??", file: path.resolve(repo, rel) });
  }
  return out;
}
function recentIn(root, sinceMin) {
  const cutoff = Date.now() - sinceMin * 60000;
  const out = [];
  walk(root, (p) => { try { if (fs.statSync(p).mtimeMs >= cutoff) out.push({ status: "mtime", file: path.resolve(p) }); } catch {} });
  return out;
}

// ---- TWIN --------------------------------------------------------------------
// A basename group larger than this is a CONVENTIONAL name (SKILL.md, README.md,
// index.js, __init__.py): every directory has one, so "same name" means nothing
// and the match is refined to parent-dir/basename. Data-driven rather than a
// list, so a convention this file has never heard of is handled the same way.
const CONVENTIONAL_AT = 6;
const parentKey = (p) => (path.basename(path.dirname(p)) + "/" + path.basename(p)).toLowerCase();
function indexByName(roots) {
  const idx = new Map();
  for (const r of roots) walk(r, (p) => {
    const k = path.basename(p).toLowerCase();
    if (!idx.has(k)) idx.set(k, new Set());
    idx.get(k).add(path.resolve(p));
  });
  return idx;
}
function twinsFor(file, idx) {
  let set = idx.get(path.basename(file).toLowerCase()) || new Set();
  if (set.size > CONVENTIONAL_AT) {
    const pk = parentKey(file);
    set = new Set([...set].filter((p) => parentKey(p) === pk));
  }
  const me = path.resolve(file);
  const out = [];
  let mine = null;
  for (const p of set) {
    if (p === me) continue;
    if (mine === null) mine = fs.existsSync(me) ? sha(me) : "(deleted)";
    const h = fs.existsSync(p) ? sha(p) : "(deleted)";
    out.push({ path: p, same: h === mine });
  }
  // stable order so two censuses can be diffed regardless of root order
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---- REG ---------------------------------------------------------------------
function expandHome(s) {
  const home = os.homedir();
  return s.replace(/^~(?=[\\/])/, home).replace(/\$\{?HOME\}?/g, home).replace(/%USERPROFILE%/gi, home);
}
function regReport(settingsFile) {
  const text = fs.readFileSync(settingsFile, "utf8");
  let json; try { json = JSON.parse(text); } catch (e) { return [{ kind: "REG", path: settingsFile, resolves: false, note: "settings file is not valid JSON" }]; }
  const found = [];
  const visit = (v) => {
    if (typeof v === "string") {
      // every path-shaped token: has a dir separator and a script-ish extension
      const re = /(?:~|\$\{?HOME\}?|%USERPROFILE%|[A-Za-z]:|\.{0,2})?[\\/][^\s"'`]*?\.(?:js|py|sh|ps1|cmd|bat|mjs|cjs)\b/g;
      let m; while ((m = re.exec(v))) found.push(m[0]);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(json);
  return [...new Set(found)].map((raw) => {
    const p = expandHome(raw);
    return { kind: "REG", raw, path: p, resolves: fs.existsSync(p) };
  });
}

// ---- REMOTE -------------------------------------------------------------------
function remoteReport(repo, doFetch) {
  let fetched = false;
  if (doFetch) { const f = git(repo, ["fetch", "--quiet"]); fetched = f.ok; }
  const up = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!up.ok) return { kind: "REMOTE", repo, note: "no upstream", fetched };
  const c = git(repo, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  const [behind, ahead] = c.out.split(/\s+/).map(Number);
  return { kind: "REMOTE", repo, upstream: up.out, ahead, behind, fetched };
}

// ---- probe --------------------------------------------------------------------
function probe(opts) {
  const report = { hooks: [], changed: [], twins: [], reg: [], remote: [], flags: 0 };
  // canonical paths: a Windows 8.3 short name (PROGRA~1) and its long form would
  // otherwise index as two files and list a file as its own twin
  const canon = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const roots = opts.roots.map(canon);
  const repos = findRepos(roots);
  for (const repo of repos) {
    report.hooks.push(...hookReport(repo));
    for (const c of changedIn(repo)) report.changed.push({ ...c, repo });
    report.remote.push(remoteReport(repo, opts.remote));
  }
  for (const r of roots) if (!isRepo(r) && opts.since > 0) for (const c of recentIn(r, opts.since)) report.changed.push({ ...c, repo: "(no repo) " + r });
  for (const f of opts.files) report.changed.push({ status: "--file", file: canon(f), repo: "(named)" });
  const idx = indexByName(roots);
  const seen = new Set();
  for (const c of report.changed) {
    if (seen.has(c.file)) continue; seen.add(c.file);
    const tw = twinsFor(c.file, idx);
    if (tw.length) report.twins.push({ file: c.file, twins: tw });
    // a twin already shown under this file is not shown again as its own row
    for (const x of tw) seen.add(x.path);
  }
  if (opts.all) for (const [, set] of idx) if (set.size > 1) {
    const [first] = set;
    if (!seen.has(first)) { seen.add(first); report.twins.push({ file: first, twins: twinsFor(first, idx) }); }
  }
  if (opts.settings) report.reg.push(...regReport(opts.settings));
  report.flags = report.hooks.filter((h) => h.flag).length
    + report.twins.reduce((n, t) => n + t.twins.filter((x) => !x.same).length, 0)
    + report.reg.filter((r) => !r.resolves).length;
  return report;
}
function render(rep) {
  const L = [];
  for (const h of rep.hooks) {
    L.push(`HOOK\t${h.repo}\t${h.name}\thooksPath=${h.hooksPath}\tlive=${h.live}`);
    for (const d of h.dead) L.push(`  DEAD\t${d}\t(exists, git will not run it)`);
  }
  for (const c of rep.changed) L.push(`CHANGED\t${c.status}\t${c.file}\t[${c.repo}]`);
  for (const t of rep.twins) {
    L.push(`TWIN\t${t.file}`);
    for (const x of t.twins) L.push(`  ${x.same ? "SAME" : "DIFF"}\t${x.path}`);
  }
  for (const r of rep.reg) L.push(`REG\t${r.resolves ? "RESOLVES" : "MISSING "}\t${r.raw || r.path}${r.raw && r.path !== r.raw ? `  -> ${r.path}` : ""}${r.note ? `  (${r.note})` : ""}`);
  for (const r of rep.remote) L.push(r.note
    ? `REMOTE\t${r.repo}\t${r.note}`
    : `REMOTE\t${r.repo}\tahead ${r.ahead} behind ${r.behind} vs ${r.upstream} (${r.fetched ? "fetched" : "CACHED ref — pass --remote to ask the remote"})`);
  L.push(`SUMMARY\t${rep.hooks.length} hook(s), ${rep.changed.length} changed, ${rep.twins.length} with twins, ${rep.reg.length} registration(s), ${rep.flags} to look at`);
  return L.join("\n");
}

// ---- canary -------------------------------------------------------------------
function canary() {
  const checks = [];
  const T = (name, ok) => checks.push([name, !!ok]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-probe-"));
  const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const initRepo = (d) => { fs.mkdirSync(d, { recursive: true }); git(d, ["init", "-q"]); git(d, ["config", "user.email", "c@x"]); git(d, ["config", "user.name", "c"]); git(d, ["config", "commit.gpgsign", "false"]); };

  // (1) repo A: core.hooksPath set, a DEAD copy in .git/hooks
  const A = path.join(tmp, "A"); initRepo(A);
  W(path.join(A, "hooks", "pre-commit"), "#!/bin/sh\necho live\n");
  W(path.join(A, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho dead\n");
  git(A, ["config", "core.hooksPath", "hooks"]);
  // (2) repo B: no hooksPath, hook in .git/hooks — live, nothing dead
  const B = path.join(tmp, "B"); initRepo(B);
  W(path.join(B, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho b\n");
  W(path.join(B, ".git", "hooks", "pre-push.sample"), "sample");
  // (3) repo C: hooksPath set but the registered file is MISSING
  const C = path.join(tmp, "C"); initRepo(C);
  git(C, ["config", "core.hooksPath", "nohooks"]);
  W(path.join(C, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");

  const repA = hookReport(A), repB = hookReport(B), repC = hookReport(C);
  T("hooksPath repo: live hook is the hooksPath file", repA.length === 1 && path.resolve(repA[0].live) === path.resolve(A, "hooks", "pre-commit"));
  T("hooksPath repo: .git/hooks copy reported DEAD", repA[0].dead.length === 1 && repA[0].dead[0].endsWith(path.join(".git", "hooks", "pre-commit")) && repA[0].flag);
  T("plain repo: live hook is .git/hooks, nothing dead, .sample ignored", repB.length === 1 && repB[0].dead.length === 0 && !repB[0].flag && repB[0].live.endsWith(path.join(".git", "hooks", "pre-commit")));
  T("hooksPath pointing at a missing file is flagged MISSING", repC.length === 1 && /MISSING/.test(repC[0].live) && repC[0].flag);

  // (4) changed set + twins across two roots, CRLF-insensitive
  W(path.join(A, "tool.js"), "x = 1;\n");
  git(A, ["add", "tool.js"]); git(A, ["commit", "-qm", "one"]);
  W(path.join(A, "tool.js"), "x = 2;\n");                 // modified
  W(path.join(A, "scratch.tmp"), "junk");                  // untracked
  const other = path.join(tmp, "other"); W(path.join(other, "deep", "tool.js"), "x = 2;\r\n"); // SAME after CRLF normalization
  const third = path.join(tmp, "third"); W(path.join(third, "tool.js"), "x = 3;\n");          // DIFF
  W(path.join(third, "node_modules", "tool.js"), "x = 2;\n");                                 // skipped dir
  const ch = changedIn(A);
  T("changed set lists the modified and the untracked file", ch.some((c) => c.file.endsWith("tool.js") && c.status === "M") && ch.some((c) => c.file.endsWith("scratch.tmp") && c.status === "??"));
  const idx = indexByName([A, other, third]);
  const tw = twinsFor(path.join(A, "tool.js"), idx);
  T("twin search finds both same-name copies and skips node_modules", tw.length === 2);
  T("CRLF-only difference is SAME", tw.find((x) => x.path.includes("other"))?.same === true);
  T("different bytes is DIFF", tw.find((x) => x.path.includes("third"))?.same === false);
  T("case-insensitive basename match", twinsFor(path.join(A, "TOOL.JS"), idx).length >= 2);
  // conventional name: 8 dirs each holding SKILL.md; only the same-parent one is a twin
  const conv = path.join(tmp, "conv");
  for (const d of ["a", "b", "c", "d", "e", "f", "g", "h"]) W(path.join(conv, "t1", d, "SKILL.md"), "s " + d);
  W(path.join(conv, "t2", "c", "SKILL.md"), "s c"); W(path.join(conv, "t2", "zz", "SKILL.md"), "s zz");
  const cidx = indexByName([conv]);
  const ctw = twinsFor(path.join(conv, "t1", "c", "SKILL.md"), cidx);
  T("a conventional basename is matched by parent/name, not name alone", ctw.length === 1 && ctw[0].path.endsWith(path.join("t2", "c", "SKILL.md")) && ctw[0].same);

  // (5) whole probe: flags count and rendering
  const rep = probe({ roots: [tmp], files: [], since: 0, settings: null, remote: false, all: false });
  T("probe discovers all three repos", rep.hooks.map((h) => h.repo).filter((v, i, a) => a.indexOf(v) === i).length === 3);
  T("porcelain paths keep their first character (the trimmed ' M .x' bug)",
    rep.changed.some((c) => c.file.endsWith(path.join("A", "tool.js"))) && rep.changed.some((c) => c.file.endsWith(path.join("A", "scratch.tmp"))));
  T("flags = 1 dead + 1 missing + 1 twin DIFF", rep.flags === 3);
  const txt = render(rep);
  T("render names the DEAD copy and the DIFF twin", /DEAD\t.*pre-commit/.test(txt) && /DIFF\t.*third/.test(txt) && /SUMMARY\t.*3 to look at/.test(txt));
  T("remote without upstream says so, never invents ahead/behind", rep.remote.every((r) => r.note === "no upstream"));

  // (6) --since on a non-repo root
  const rec = recentIn(other, 60);
  T("--since picks up the recently written file in a non-repo root", rec.length === 1 && rec[0].file.endsWith("tool.js"));

  // (7) registrations
  const okScript = path.join(tmp, "hook.js"); W(okScript, "//");
  const homeScript = path.join(os.homedir(), ".landing-probe-canary.js"); W(homeScript, "//");
  try {
    const settings = path.join(tmp, "settings.json");
    W(settings, JSON.stringify({ hooks: { PreToolUse: [{ command: `node "${okScript.replace(/\\/g, "/")}" --x` }], Stop: [{ command: "node ~/.landing-probe-canary.js" }, { command: `node ${path.join(tmp, "gone.py").replace(/\\/g, "/")}` }] } }));
    const reg = regReport(settings);
    T("existing registered path RESOLVES", reg.some((r) => r.resolves && r.path.replace(/\\/g, "/").endsWith("hook.js")));
    T("~ is expanded before checking", reg.some((r) => r.raw.startsWith("~") && r.resolves));
    T("missing registered path is MISSING", reg.some((r) => !r.resolves && r.path.endsWith("gone.py")));
    W(settings, "{ not json");
    T("invalid settings JSON is reported, not thrown", regReport(settings).some((r) => /not valid JSON/.test(r.note || "")));
  } finally { try { fs.unlinkSync(homeScript); } catch {} }

  // (8) remote: bare + clone, local commit → ahead 1, and the line says CACHED vs fetched
  const bare = path.join(tmp, "bare.git"); fs.mkdirSync(bare); git(bare, ["init", "-q", "--bare"]);
  const D = path.join(tmp, "D"); initRepo(D);
  W(path.join(D, "f"), "1"); git(D, ["add", "f"]); git(D, ["commit", "-qm", "i"]);
  git(D, ["remote", "add", "origin", bare]); git(D, ["push", "-q", "-u", "origin", "HEAD"]);
  W(path.join(D, "f"), "2"); git(D, ["commit", "-qam", "ii"]);
  const r1 = remoteReport(D, false), r2 = remoteReport(D, true);
  T("ahead 1 vs cached ref, marked not fetched", r1.ahead === 1 && r1.behind === 0 && r1.fetched === false);
  T("--remote fetches and reports the same ahead 1", r2.ahead === 1 && r2.fetched === true);
  T("render labels the cached case", /CACHED ref/.test(render({ hooks: [], changed: [], twins: [], reg: [], remote: [r1], flags: 0 })));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const bad = checks.filter(([, ok]) => !ok);
  for (const [n, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${n}`);
  console.log(`\nCANARY ${bad.length ? "FAIL" : "PASS"} ${checks.length - bad.length}/${checks.length}`);
  process.exit(bad.length ? 1 : 0);
}

// ---- main ---------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes("--canary")) canary();
  else if (argv[0] === "probe") {
    const opts = { roots: [], files: [], since: 0, settings: null, remote: argv.includes("--remote"), all: argv.includes("--all") };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--file") opts.files.push(argv[++i]);
      else if (a === "--since") opts.since = Number(argv[++i]) || 0;
      else if (a === "--settings") opts.settings = argv[++i];
      else if (a === "--remote" || a === "--all") continue;
      else opts.roots.push(a);
    }
    if (!opts.roots.length) opts.roots.push(process.cwd());
    const rep = probe(opts);
    console.log(render(rep));
    process.exit(rep.flags ? 1 : 0);
  } else {
    console.log("usage: node landing-probe.js probe <root>... [--file <p>]... [--since <min>] [--settings <json>] [--remote] [--all]\n       node landing-probe.js --canary");
    process.exit(2);
  }
}
module.exports = { hookReport, changedIn, twinsFor, indexByName, regReport, remoteReport, probe, render };
