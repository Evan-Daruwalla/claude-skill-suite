# Scope resolution — full and recent

Read by all six audit skills. Answers two questions before any sweep starts:
**what is in scope**, and **how do we prove we covered it.**

Getting this wrong is the quiet failure. An audit that swept 60% of the tree
and reported "clean" is worse than no audit, because it manufactures confidence.

---

## Part 1 — What is the project?

A working directory is sometimes **not a git repo** — it can be a container
holding many independent repos plus non-git directories. This breaks the usual
assumption that "the project" and "the repo" are the same thing.

Resolve in this order:

1. **The user named a target** ("audit the API", "audit the sim") — that is the
   scope. Confirm which directory it maps to before sweeping.
2. **The working directory is itself a git repo** — that repo is the scope.
3. **The working directory contains several repos** — do NOT silently pick one,
   and do NOT sweep them all under one manifest. Ask which, and offer the
   short list ranked by recent activity. A whole-container audit is a
   legitimate answer but it is an expensive one the user should choose knowingly.

**Record the resolved scope as an absolute path in the report.** Every real
audit of one project has had a "Scope:" line as its second line; keep that.

---

## Part 2 — The file manifest

**Honest provenance: there is no published, named methodology for proving
file-level audit coverage.** A search pass on 2026-08-21 specifically looked
and found none. The closest established analogues are the requirements
traceability matrix from safety-critical practice (DO-178C, ISO 26262), which
proves every *requirement* was checked rather than every *file*, and SARIF
fingerprinting, which is a finding-identity mechanism rather than a coverage
one. What follows is a synthesis of those two applied to files. Do not cite it
as an industry standard; it is a local convention that works.

Build the manifest before spawning anyone:

```bash
git -c core.quotepath=false ls-files > manifest.txt
git -c core.quotepath=false ls-files --others --exclude-standard >> manifest.txt
```

For a non-git directory, `find . -type f` with the exclusions applied instead.

**`core.quotepath=false` is not optional, and neither is avoiding a `$`-anchored
extension grep.** This was found the hard way on 2026-08-21, on this skill's
first real run.

By default `git ls-files` octal-escapes any non-ASCII byte in a filename and
wraps the whole name in double quotes. A file named
`Project Record — Full Chronological History.md` (em-dash) is emitted as:

```
"docs/Project Record \342\200\224 Full Chronological History.md"
```

That line ends in `.md"`, not `.md`. So the natural filter —
`git ls-files | grep -iE '\.(md|txt|rst)$'` — **silently drops it**, along with
every other non-ASCII-named file. Measured on this repo: 62 files with the
naive command, 63 with `core.quotepath=false`. The one missing file was the
project's 6,200-line append-only record — the single most important document in
the tree, and the one the provenance method exists to check. The manifest
reported a confident count and proved coverage of a set that omitted it.

**This is the exact failure class this file is meant to prevent: a wrong answer
that announces itself as a good one.** Two defences, use both:

1. Enumerate with `core.quotepath=false`, and filter on the extension without
   anchoring to end-of-line, or filter in a real language rather than grep.
2. **Cross-check the count.** `git ls-files | wc -l` against
   `find . -type f -not -path './.git/*' | wc -l`, and reconcile the
   difference against your stated exclusions. A count you did not reconcile is
   not a manifest, it is a guess with a number attached.

Then:

- **Every file gets assigned to at least one worker.** Assignment is recorded,
  not assumed.
- **Every excluded file is listed with its reason** — `vendored`, `generated`,
  `binary`, `>N KB and sampled instead`. Silent exclusion is the failure mode
  this whole section exists to prevent.
- **The coverage map in the report is computed from the manifest**, not
  narrated from memory. "38 of 41 files swept, 3 excluded (vendored)" is a
  claim you can check. "Comprehensive sweep" is not.

**ISO 19011 is the wrong reference here and is worth naming so nobody reaches
for it.** It is a *sampling* standard — it endorses risk-based partial coverage
and sets no full-coverage mandate. It is useful for justifying a deliberately
partial sweep, and useless for proving an exhaustive one.

---

## Part 3 — Batch size, and why the manifest matters more than context size

**Do not put the whole repo in one context and call it a sweep.** Liu et al.,
"Lost in the Middle" (arXiv:2307.03172, TACL) measured a U-shaped accuracy
curve over position in context: with 20–30 documents, accuracy drops **more
than 20 points** when the target sits mid-context versus at either end — in the
worst case falling *below* the model's own closed-book accuracy, meaning the
right file placed badly is worse than no file at all. Replicated across
Claude-1.3, Claude-1.3-100K, GPT-3.5-Turbo and others.

The same paper kills the obvious workaround: going from 20 to 50 retrieved
documents improved accuracy by only ~1.5% (GPT-3.5-Turbo) and ~1%
(Claude-1.3), while retriever recall kept climbing. **More context is not
better use of context.** Traversal and partition beat stuffing.

Human review-rate guidance points the same direction, though its numbers are
softer: roughly **100–500 LOC per session, under ~500 LOC/hour, under 60–90
minutes**, descended from the Fagan/Cisco lineage. Treat these as an
order-of-magnitude range, not constants — the published renderings disagree
(200–400 vs 100–300 LOC), because they paraphrase Cohen's book rather than
quote it, and Fagan's 1976 original was not directly obtainable. What survives
across every rendering is the structural claim: **past some threshold, more
volume per review buys sharply less detection per unit code.**

Practical rule: partition so no worker holds more than a few hundred lines of
*primary* reading at a time, and let it re-read on demand rather than
pre-loading everything it might need.

---

## Part 4 — Recent scope

### Choosing the base ref

Ask, or infer from what the user said. In descending preference:

| Intent | Base |
|---|---|
| "since I branched" | `git merge-base main HEAD` |
| "this session's work" | the commit at session start, or `HEAD@{N}` from reflog |
| "the last N days" | `git log --since="N days ago"` to find the oldest commit, use its parent |
| "since the last release" | the last tag: `git describe --tags --abbrev=0` |

### The commands, with their real semantics

| Goal | Command | Semantics | Pitfall |
|---|---|---|---|
| What this branch introduced | `git diff base...HEAD` | **Three-dot**: diffs the *merge base* of `base` and `HEAD` against `HEAD`. Only your branch's changes. Matches GitHub PR semantics. | Goes stale relative to a moving base, but does not pick up base's new commits. **This is the correct default.** |
| Direct tip-to-tip | `git diff base..HEAD` | **Two-dot**: direct comparison. Changes that landed on `base` after you branched appear as if `HEAD` removed them. | Changes every time `base` moves even if you touched nothing. Commonly confused with three-dot — do not use it for "my recent work". |
| Commits unique to the branch | `git log base..HEAD` | For `log`, two-dot already means "reachable from HEAD, not from base". | **`log` two-dot and `diff` two-dot do NOT mean the same thing.** The dot conventions do not transfer between the two commands. |
| Find the ancestor | `git merge-base base HEAD` | The primitive three-dot builds on. | Fails or misleads on a **shallow clone** (`--depth=1`) — `git fetch --unshallow` first. |
| Staged only | `git diff --staged` | Index vs HEAD. | Misses unstaged edits AND untracked files entirely. |
| Include brand-new files | `git add -N <path>` then `git diff` | `--intent-to-add` creates an empty index entry so new files appear in the diff. | Untracked files have no index entry, so plain `git diff` **silently skips them**. There is **no** `git diff --include-untracked` flag — verified against the manpage. |
| Recover after force-push | `git reflog` | Local record of HEAD movements. | **Local only**, never pushed, and entries expire (~90 days reachable / ~30 unreachable). Not a durable audit trail. |
| Which commits changed a literal | `git log -S'<string>'` | Pickaxe: commits where the **count** of occurrences changed. | A same-count edit (`hit = frotz(x)` → `return frotz(x)`) does **not** appear. The most common pickaxe surprise. |
| Which commits touched matching text | `git log -G'<regex>'` | Commits whose diff has an added/removed line matching the regex. | `-G` catches the same-count edit that `-S` misses. Confusing the two silently changes your results. |

### Uncommitted work is in scope

Working directories are dirty more often than not. A recent-scoped audit that only reads committed history misses
live work — usually the *most* recent work, which is the whole point.

Always run all three, and say which produced what:

```bash
git status --porcelain          # what is dirty, staged or not
git diff                        # unstaged changes
git diff --staged               # staged changes
```

### Rank by RELATIVE churn, not absolute

Nagappan & Ball, "Use of Relative Code Churn Measures to Predict System Defect
Density" (ICSE 2005, Windows Server 2003: 44.97M LOC, 2,465 binaries, 96,189
files — full text read) measured this directly:

- **Absolute churn**: R² = **0.052**. Effectively no predictive power.
- **Relative churn** (churn normalized by module size): R² = **0.811**.
- Churned-LOC / total-LOC vs defects-per-KLOC: Spearman **ρ = 0.883** — the
  strongest single predictor in the study.
- Fault-prone vs not-fault-prone classification: **89.0%** accuracy.

So "this file changed the most lines" is close to worthless as a targeting
signal. **"This file changed the most lines relative to its size"** is one of
the strongest signals available. M5 in `code-methods.md` inherits this: compute
churn as a ratio, and state which you used.

### Blast radius — mandatory, not optional

A recent-scoped audit structurally cannot see how a change interacts with code
it did not touch. That is its defining blind spot, and the fix is a companion
pass, not a caveat:

1. Take the changed file set.
2. Walk **reverse dependencies** — who imports, calls, or reads these? Use the
   import graph, the call graph, or `git log -G` over the changed symbols.
3. **Pull those callers into scope even though they are not recent.** A changed
   function's unchanged callers are exactly where a contract break shows up.

Without this step, "recent audit clean" means only "the diff reads fine."

### Every recent-scoped report states its own blind spots

Required text, adapted to the run — not optional boilerplate:

> This audit covered `<base>...HEAD` plus uncommitted work: N files, M
> insertions. It did **not** sweep the other K files in the project. It cannot
> see: pre-existing defects in untouched code; a latent bug that this change
> newly made reachable; or interactions with modules outside the blast-radius
> walk. For those, run the full `audit`.

---

## Part 5 — Why recent scope is worth having

Not a convenience mode. The 2026-08-20 cold audit of one project opened with its
own measured finding: **every confirmed crit sat in code written or modified
during the previous session — code that was verified at the time and written up
in the record as working.** Three mechanisms built to catch that class were
themselves found false-green.

Recent-scoped audits target the stratum where defects were actually measured to
live here. Combined with relative-churn ranking above, that is the highest
defect-density-per-token sweep available.
