---
name: audit
description: Full sweeping project audit — code, data integrity, security, dependencies, infrastructure, performance, and docs — producing severity-ranked findings with fix plans. Use when the user says "audit", "full audit", "sweeping audit", "audit everything", "find issues/security fixes/optimizations", or "check for inconsistencies". Findings only by default; fixes happen after approval.
---

# Project Audit

Systematic audit of the current project, hybrid by design: automated tools map
the surface, then a manual deep-dive tells how deep the cracks go. Output is a
ranked findings table the user can approve in one word ("do all", "do 1-4").
Do not fix during the audit pass.

## Trigger
`/audit`, or the user asks for a "full audit", "sweeping audit", "audit every
file", "find as many security fixes / optimizations / issues as possible".

## Inputs
- Scope (default: whole project; the user may narrow to a subsystem — e.g.
  "the API", "the dashboard", "everything before <date>").
- Driver, if stated (vendor-code evaluation, performance complaints,
  pre-launch, tech-debt sizing, pre-handoff) — weight the sweep toward it.
- If a code knowledge graph or index already exists (e.g. a `graphify-out/`
  directory), query it first to target the audit instead of reading every file
  cold.

## Steps
1. **Prepare and map the surface.** Enumerate entry points, data stores,
   background jobs, scheduled tasks, CI/CD config, and docs. Note what has
   tests and what doesn't. Read the project docs for claimed invariants — the
   audit checks reality against them, not the other way around.
2. **Automated pass first.** Run what the project already has or what's free
   and local: the test suite, linters/type-checkers, dependency auditors
   (`npm audit`, `pip-audit`, or equivalent), and any secret scanner the repo
   is wired with. Tool output is evidence — record versions/commands. Do NOT
   install new tooling without asking.
3. **Manual sweep by category**, collecting findings as you go:
   - **Correctness**: logic bugs, silent failure paths, error handling that
     swallows problems, stale/duplicated state, timezone/encoding traps.
   - **Data integrity**: duplicate rows, gaps, mixed conventions (e.g. units,
     timezone bases, or adjustment flags), anything that would silently corrupt
     downstream numbers. For DB-backed projects, run actual queries — don't infer.
   - **Security**: injection, authZ/authN gaps, secrets in code, path
     traversal, missing rate limits, insecure session/cookie handling.
     Compliance-relevant gaps (unencrypted PII, missing consent capture, data
     kept past need) get flagged as findings — but NEVER claim the project
     "is compliant" with a regulation; that's an assessment this audit can't
     certify.
   - **Dependencies & supply chain**: known CVEs, outdated majors, unused or
     duplicated packages, unpinned versions, licenses incompatible with the
     project's use.
   - **Infrastructure & CI/CD**: deployment scripts, pipeline config, env/
     secret handling, scheduled tasks, broken or unmonitored jobs.
   - **Performance**: N+1 patterns, missing indexes, unbounded reads,
     needless re-computation.
   - **Maintainability & docs**: project docs (README, handoff, status,
     changelog) whose claims no longer match the code or data — flag, don't
     rewrite; plus dead code, inconsistent naming, and missing onboarding
     docs that would slow a new developer.
4. **Verify before reporting.** Each finding needs evidence: the file:line,
   the query result, the tool output, or the reproduced error. No speculative
   findings — if you can't demonstrate it, don't list it. For crit/high
   findings, name the root cause, not just the symptom.
5. **Rank and report.**
   - **Executive summary** (3–5 lines): top risks and overall health.
   - One table: `# | Severity (crit/high/med/low) | Finding | Evidence |
     Proposed fix | Effort`, ordered by severity.
   - **Coverage map**: each category above marked swept / partial / not
     swept, with why — absence of findings is only meaningful where coverage
     was real.
6. **Wait for approval.** The user typically replies "do all" or "do 1 and 3".
   Then fix in severity order, verifying each fix (run the relevant tests — if
   the project has frozen regression tests, they must stay at their baseline),
   and report what was fixed vs. skipped.
7. **Follow-up validation.** After fixes, re-run the step-2 automated pass and
   the affected tests to prove the fixes didn't introduce regressions; report
   the before/after.

## Output
- Executive summary + severity-ranked findings table + coverage map.
- After approval: fixes applied surgically, each verified, with a summary of
  what changed and the follow-up validation result.

## Rules
- Findings pass changes NOTHING. No drive-by fixes, no "improved while I was
  there".
- Never delete anything (files, DB rows, records) without asking, even if it
  looks like junk — some environments accumulate harmless stray files.
- Never install new scanners/tools or claim regulatory compliance status —
  flag gaps, don't certify.
- Keep tokens low: sample large files intelligently, use grep/queries over
  full reads, and don't paste long code excerpts into the report.
