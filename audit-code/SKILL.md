---
name: audit-code
description: >-
  Exhaustive CODE audit, run COLD by a fresh auditor and fanned out to
  parallel workers under a file manifest that proves coverage. Fifteen
  methods (invariant tracing, call-site contracts, error paths, static
  tooling, relative-churn targeting, dynamic verification, spec conformance,
  data-at-rest, deps and supply chain, test-suite validation via mutation
  score, fuzzing and property-based exploration, adversary-first threat
  modelling, concurrency, architecture and dependency structure, compliance
  surface) plus a four-generator edge-case sweep. Defaults to the whole
  project; pass "recent" to scope to work since a base ref, plus the blast
  radius of unchanged callers. Use when: "audit the code", "code audit",
  "audit my changes", "find bugs / security fixes / edge cases". Findings
  only; fixes after approval.
---

# Audit — code, whole project

The code half of the full sweep, at full depth. Use this when the docs are not in question and you want every method pointed at the source.

## Which audit is this?

| Skill | Domain |
|---|---|
| `audit` | code + docs + the cross-domain pass |
| `audit-code` | code only |
| `audit-docs` | docs only |

**Scope is an argument, not a separate skill.** Default is the whole project.
Pass `recent` — `/audit-code recent`, or "audit my recent changes" — to scope to
work since a base ref. The methods are identical either way; only what they are
pointed at changes.

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

**1. Resolve scope.** Per `scoping.md`.

**FULL scope (default).** Build the manifest before spawning anyone. Enumerate
with `git -c core.quotepath=false ls-files` — **not** a `$`-anchored extension
grep, which silently drops every non-ASCII filename (this cost a real audit its
most important document on 2026-08-21). Reconcile the count against a second
enumeration. This working directory may contain several git repos rather than
being one: do not silently pick one, and do not sweep them all under a single
manifest without asking.

**RECENT scope (when `recent` is passed).** Resolve the base ref deliberately
and say which you chose. Use **three-dot** `git diff base...HEAD` — two-dot
picks up base-branch drift and is the classic wrong answer. Include uncommitted
and untracked work (`git status --porcelain`, `git diff`, `git diff --staged`;
untracked files need `git add -N` to appear in a diff at all — there is no
`--include-untracked` flag). Rank by **relative** churn, not absolute:
Nagappan & Ball (ICSE 2005) measured absolute churn at R^2 = 0.052 and
size-normalized churn at R^2 = 0.811.

Then **walk the blast radius — mandatory.** Take the changed set, walk reverse
dependencies (import graph, call graph, `git log -G` over changed symbols), and
pull unchanged callers into scope. A changed function's untouched callers are
exactly where a broken contract surfaces. Without this, "recent audit clean"
means only "the diff reads fine".

**Recent-scoped reports state their own blind spots** — what was not swept, and
that they cannot see pre-existing defects in untouched code or a latent bug the
change newly made reachable.

**2. Every file in scope is assigned to a worker**, and every exclusion is
listed with its reason. The coverage map is computed from the manifest and the
workers' reconciled search trails, not narrated from memory. "38 of 41 files
swept, 3 vendored" is checkable; "comprehensive sweep" is not.

**Fan out.** Per `fanout.md`. Sonnet workers, **eight maximum across all
levels** including any delegates. Pre-register the acceptance rubric before any
worker output exists. Workers do NOT vote or cross-review — they report
independently and the session model adjudicates on evidence.

**Sweep.** `code-methods.md` — M1 through M15, then the edge-case generators G1-G4, in the cost order that file specifies.

**Verify.** Every crit and high is reproduced by the session model itself, with
the command and its real output. A zero-result search is a claim, not a fact —
cross-check load-bearing negatives through a second implementation before
believing them.

**Report.** Exactly the contract in `reporting.md`.

**Wait for approval**, then fix in the stated order, verifying each fix by
running the thing. Re-run the automated pass afterwards and report before/after.

## Notes for this mode

**No docs sweep and no cross-domain pass.** That is the trade: this skill will not catch a README asserting something false, and it will not reconcile a documented claim against observed behaviour. If the project's docs are load-bearing, run `audit` instead.

One dependency is worth knowing: M1 (invariant tracing) and M7 (spec conformance) both consume a list of claimed invariants that normally comes from the docs sweep. Running code-only means building that list yourself from comments and constants — do it, and note in the coverage map that it was self-derived rather than doc-sourced.

## Rules

- **The findings pass changes NOTHING.** No drive-by fixes.
- **Never delete anything** you did not create this session without asking.
- **Never install new scanners** without asking; never certify compliance.
- **Never invent a number, measurement, or timestamp.** Run `date` before
  writing any timestamp. Missing data is reported as missing.
- **Coverage is proven by the manifest**, not by how thorough it felt. A method
  not run is "not swept", never "no findings".
