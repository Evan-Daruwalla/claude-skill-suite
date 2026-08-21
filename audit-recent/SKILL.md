---
name: audit-recent
description: >-
  Exhaustive audit of RECENT WORK across BOTH domains — the code and docs
  touched since a chosen base ref, plus uncommitted and untracked work,
  plus the blast radius of unchanged callers. Same fifteen code methods,
  eight docs methods and five cross-domain methods as the full audit, aimed
  at the diff. Use when: "audit recent work", "audit what I just did",
  "audit this session", "audit the last N commits", "audit since <ref>".
  Findings only; fixes after approval.
---

# Audit — both domains, recent work

The full sweep aimed at a diff instead of a tree.

**This is not a budget option.** The 2026-08-20 cold audit of this tree opened with its own measured result: *every confirmed crit sat in code written or modified during the previous session — code that was verified at the time and written up in the record as working.* Three mechanisms built to catch that class were themselves found false-green. Recent work is the measured highest-defect-density stratum here.

## Which audit is this?

| Skill | Domain | Scope |
|---|---|---|
| `audit` | code + docs + cross | whole project |
| `audit-code` | code | whole project |
| `audit-docs` | docs | whole project |
| **`audit-recent`** | code + docs + cross | recent work only |
| `audit-code-recent` | code | recent work only |
| `audit-docs-recent` | docs | recent work only |

## Not this skill

- **Did the change land where it actually executes?** -> `landing-check`.
  This skill hunts defects; it does not verify a deployment reached the live
  file. The two are complementary and neither replaces the other.
- **Is this diff correct?** -> `/code-review`.
- **Did the code I just wrote run?** -> `code-check` (fires on its own).
- **One narrow mechanical check** -> the specialist owns it and this audit
  CALLS it rather than re-deriving: `cve-audit`, `history-leak-scan`,
  `local-secrets-manage`, `data-integrity-audit`, `path-quirk-audit`,
  `shell-portability`, `seed-control`, `determinism-guard`, `milestone-track`.

## Protocol

The depth lives in shared reference files, in the `audit` skill's `references/` directory. Read each as you reach
its step; this file holds only the order and what is different about this mode.

**Enter cold.** If this session already worked on the project, spawn a fresh
auditor per `fanout.md` and hand it only what that file permits — never session
belief, never "this part is known-good". If the session is genuinely fresh, you
ARE the cold auditor. Cold means unbiased, not amnesiac: read the project's own
docs, as **claims under test**.

**1. Resolve the recent scope FIRST.** Per `scoping.md`, Part 4. Pick the
base ref deliberately and say which you chose. Use **three-dot**
(`git diff base...HEAD`) — two-dot picks up base-branch drift and is the
classic wrong answer here.

**2. Include uncommitted and untracked work.** `git status --porcelain`,
`git diff`, `git diff --staged`. Untracked files need `git add -N` to appear in
a diff at all — there is no `--include-untracked` flag. Five of the eleven
repos in this tree were dirty when this skill was written; a committed-only
sweep silently misses the newest work, which is the whole point of this mode.

**3. Rank by RELATIVE churn, not absolute.** Nagappan & Ball (ICSE 2005):
absolute churn predicts defect density at R^2 = 0.052; churn normalized by
module size reaches R^2 = 0.811. "Most lines changed" is nearly worthless;
"most changed relative to its size" is one of the strongest signals available.

**4. Walk the blast radius — this is mandatory, not a nicety.** Take the
changed set, walk reverse dependencies (import graph, call graph, `git log -G`
over changed symbols), and **pull unchanged callers into scope.** A changed
function's untouched callers are exactly where a broken contract surfaces.
Skipping this makes "recent audit clean" mean only "the diff reads fine".

**Fan out.** Per `fanout.md`. Sonnet workers, **eight maximum across all
levels** including any delegates. Pre-register the acceptance rubric before any
worker output exists. Workers do NOT vote or cross-review — they report
independently and the session model adjudicates on evidence.

**Sweep.** `docs-methods.md` (D1-D8) first, then `code-methods.md` (M1-M15, G1-G4), then `cross-methods.md` (X1-X5). Docs first because its claim inventory feeds M1 and M7; cross last because it consumes both.

**Verify.** Every crit and high is reproduced by the session model itself, with
the command and its real output. A zero-result search is a claim, not a fact —
cross-check load-bearing negatives through a second implementation before
believing them.

**Report.** Exactly the contract in `reporting.md`.

**Wait for approval**, then fix in the stated order, verifying each fix by
running the thing. Re-run the automated pass afterwards and report before/after.

## Notes for this mode

**Budget: 2-4 workers, not 8.** Spending eight on a twelve-file diff is waste and the coverage map will show them colliding.

## Rules

- **The findings pass changes NOTHING.** No drive-by fixes.
- **Never delete anything** you did not create this session without asking.
- **Never install new scanners** without asking; never certify compliance.
- **Never invent a number, measurement, or timestamp.** Run `date` before
  writing any timestamp. Missing data is reported as missing.
- **Coverage is proven by the manifest**, not by how thorough it felt. A method
  not run is "not swept", never "no findings".
