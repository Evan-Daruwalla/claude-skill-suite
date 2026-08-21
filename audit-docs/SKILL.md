---
name: audit-docs
description: >-
  Exhaustive DOCUMENTATION audit of the whole project — every doc, README,
  comment block, PRD and record entry, run COLD and tested against disk.
  Eight methods (claim verification, code-element reference drift,
  doc-vs-code semantic conformance, completeness against the real public
  surface, internal contradiction and copy divergence, executable content,
  structure, provenance and currency). Hunts WRONG before MISSING before
  UGLY, because that is the measured priority order. Use when: "audit the
  docs", "docs audit", "are the docs true", "check my documentation", "is
  the status doc still accurate". Findings only; fixes after approval.
---

# Audit — docs, whole project

Documentation audited for **defects**, against evidence — not a content inventory, not a style pass. Every finding carries a file:line and the command that proves the contradiction.

In this tree's 2026-08-15 cold audit, roughly six of about thirty-five findings were doc-vs-reality drift even though docs were only a secondary lens. This skill makes them the primary one.

## Which audit is this?

| Skill | Domain | Scope |
|---|---|---|
| `audit` | code + docs + cross | whole project |
| `audit-code` | code | whole project |
| **`audit-docs`** | docs | whole project |
| `audit-recent` | code + docs + cross | recent work only |
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

**1. Resolve scope and build the manifest.** Per `scoping.md`. This working
directory may contain several git repos rather than being one — do not silently
pick one, and do not sweep all of them under a single manifest without asking.

**2. Every file in scope is assigned to a worker**, and every exclusion is
listed with its reason. The coverage map is computed from the manifest, not
narrated from memory. "38 of 41 files swept, 3 vendored" is checkable;
"comprehensive sweep" is not.

**Fan out.** Per `fanout.md`. Sonnet workers, **eight maximum across all
levels** including any delegates. Pre-register the acceptance rubric before any
worker output exists. Workers do NOT vote or cross-review — they report
independently and the session model adjudicates on evidence.

**Sweep.** `docs-methods.md` — D1 through D8, after the automated pass, in the cost order that file specifies.

**Verify.** Every crit and high is reproduced by the session model itself, with
the command and its real output. A zero-result search is a claim, not a fact —
cross-check load-bearing negatives through a second implementation before
believing them.

**Report.** Exactly the contract in `reporting.md`.

**Wait for approval**, then fix in the stated order, verifying each fix by
running the thing. Re-run the automated pass afterwards and report before/after.

## Notes for this mode

**Two rules from that file are worth surfacing here, because both cut against instinct:**

**File age is not staleness.** Tang et al. (ACM TOSEM 2024) tested the "untouched for N days" heuristic: it flagged 70.3% of screenshots, of which a 154-item sample contained 8 genuinely outdated. An old date is a reason to check, never a finding.

**Hunt wrong before missing.** Practitioners rate a *wrong* code comment (49% important) at roughly twice a *missing* one (28%). Do not spend the sweep counting undocumented functions.

## Rules

- **The findings pass changes NOTHING.** No drive-by fixes.
- **Never delete anything** you did not create this session without asking.
- **Never install new scanners** without asking; never certify compliance.
- **Never invent a number, measurement, or timestamp.** Run `date` before
  writing any timestamp. Missing data is reported as missing.
- **Coverage is proven by the manifest**, not by how thorough it felt. A method
  not run is "not swept", never "no findings".
