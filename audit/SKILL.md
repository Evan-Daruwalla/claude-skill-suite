---
name: audit
description: >-
  Exhaustive project audit across BOTH domains — every code file and every doc,
  run COLD by a fresh auditor with no inherited session belief, fanned out to
  parallel workers under a file manifest that proves coverage. Runs the code
  method sweep, the docs method sweep, AND the cross-domain pass neither can do
  alone (doc claims tested against disk, code behaviour tested against stated
  intent). Severity-ranked findings with verification tiers, load-bearing
  negatives, and architecture findings ranked above the patch list. Use when:
  "audit", "full audit", "audit everything", "find issues / security fixes /
  edge cases", "what could break". Findings only by default; fixes after
  approval.
---

# Audit — both domains, whole project

The widest sweep in the toolchain. Code and docs are audited together **and
against each other**, because the highest-value findings in both real runs of
this skill lived in the gap between them: a doc asserting something disk
contradicts, or a function whose name promises what its body does not do.

## Which audit is this?

| Skill | Domain |
|---|---|
| **`audit`** | code + docs + the cross-domain pass |
| `audit-code` | code only |
| `audit-docs` | docs only |

**Scope is an argument, not a separate skill.** Default is the whole project.
Pass `recent` — `/audit recent`, or "audit what I just did" — to scope to work
since a base ref. The methods are identical either way; only what they are
pointed at changes.

Use `audit` when the user says "audit" with no qualifier. It is the default and the
most expensive.

## Not this skill

- **Did the change land where it actually executes?** → `landing-check`. This
  skill hunts defects; it does not verify a deployment reached the live file.
- **Is this diff correct?** → `/code-review`.
- **Did the code I just wrote run?** → `code-check` (fires on its own).
- **One narrow mechanical check** → the specialist owns it, and this audit
  CALLS it rather than re-deriving it: `cve-audit`, `history-leak-scan`,
  `local-secrets-manage`, `data-integrity-audit`, `path-quirk-audit`,
  `shell-portability`, `seed-control`, `determinism-guard`, `milestone-track`.

## Inputs

- **Scope** — default: the whole project. Resolved by `references/scoping.md`,
  which also covers the case where the working directory contains several git
  repos rather than being one.
- **Driver**, if stated (pre-launch, performance complaints, tech-debt sizing,
  pre-handoff) — weight the sweep toward it; never let it shrink the manifest.
- **Knowledge graph** — if `graphify-out/` exists, query it first to target the
  sweep instead of reading every file cold.

## Protocol

Read each reference file as you reach its step. They hold the depth; this file
holds the order.

**1. Enter cold.** An audit run by the session that built the thing inherits
its author's belief, and "that module is fine, I wrote it" is not a finding you
can make. If this session has already worked on the project, spawn a fresh
auditor and hand it only what `references/fanout.md` permits. If the session is
genuinely fresh, you ARE the cold auditor — proceed inline rather than spawning
to re-derive what you do not yet believe.

Cold means unbiased, not amnesiac. Read the project's own docs — as **claims
under test**, never as facts to assume, and never as a reason to skip a check.

**2. Resolve scope and build the manifest.** Per `references/scoping.md`.
Produce an explicit file manifest: every file in scope, each assigned to at
least one worker. **The manifest is what turns "audited everything" into a
claim you can prove rather than assert.** Exclusions are listed with reasons
(vendored `node_modules/`, generated output), never silently dropped.

Enumerate with `git -c core.quotepath=false ls-files`, **never** a `$`-anchored
extension grep — that silently drops every non-ASCII filename, and on
2026-08-21 it cost a real run of this skill the single most important document
in the tree. Reconcile the count against a second enumeration before trusting
it.

**If `recent` was passed**, resolve the base ref instead and say which you
chose: three-dot `git diff base...HEAD` (two-dot picks up base drift and is the
classic wrong answer), plus uncommitted and untracked work, ranked by
**relative** churn rather than absolute — R^2 = 0.811 versus 0.052 (Nagappan &
Ball, ICSE 2005). Then **walk the blast radius**, which is mandatory, not
optional: pull unchanged callers of changed symbols into scope, because that is
where a broken contract actually surfaces. A recent-scoped report states its
own blind spots — it cannot see pre-existing defects in untouched code, or a
latent bug the change newly made reachable.

**3. Fan out.** Per `references/fanout.md`. Sonnet workers, **eight maximum
across all levels, including any delegates a worker spawns.** Pre-register the
acceptance rubric before any worker output exists. The session model
synthesises and re-verifies; it does not merely relay.

**4. Sweep — three method families.**

- **Docs first** — `references/docs-methods.md` (D-series). It is the cheaper
  sweep, and its claim inventory is a *required input* to the code sweep:
  running code first means tracing invariants nobody wrote down and checking
  intent against a spec you have not read.
- **Code** — `references/code-methods.md` (M1–M9 plus the edge-case
  generators). Run in cost order; the cheap methods aim the expensive ones.
- **Cross-domain** — `references/cross-methods.md` (X-series). The reason this
  combined skill exists. Run it LAST, because it consumes both sweeps' outputs.

**5. Verify before reporting.** Every crit and high is reproduced by the
session model itself, with the command and its real output pasted. Everything
else carries its tier. A zero-result search is a claim, not a fact — cross-check
load-bearing negatives through a second implementation before believing them.
That rule is in `references/code-methods.md` and it has bitten this project
for real.

**6. Report.** Exactly the contract in `references/reporting.md`. No section
invented, none silently dropped.

**7. Wait for approval.** the user replies "do all", "do 1 and 3", "do E1-E3". Then
fix in the stated fix order, verifying each fix by running the thing —
edge-case fixes are verified by feeding them their actual trigger, not by
reading the patch — and report what was fixed versus skipped.

**8. Follow-up validation.** Re-run the automated pass and the affected tests to
prove the fixes introduced no regressions. Report before/after.

## Rules

- **The findings pass changes NOTHING.** No drive-by fixes, no "improved while
  I was there".
- **Never delete anything** you did not create this session without asking —
  a working tree often holds harmless stray files.
- **Never install new scanners** without asking, and never claim regulatory
  compliance status. Flag gaps; do not certify.
- **Never invent a number, measurement, or timestamp.** Run `date` before
  writing any timestamp. Missing data is reported as missing.
- **Every fix is surgical or it is honestly labelled large.** Prefer one guard
  at the shared chokepoint over N guards at call sites — smaller diff and root
  cause at once.
- **Coverage is proven by the manifest**, not by how thorough the sweep felt. A
  method not run is "not swept", never "no findings".
- Keep tokens low per unit of coverage: sample large files, prefer grep and
  queries over full reads, and never paste long code excerpts into the report.
