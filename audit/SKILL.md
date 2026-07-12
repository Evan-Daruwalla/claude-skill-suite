---
name: audit
description: Full sweeping project audit — code, data integrity, security, performance, and docs — producing severity-ranked findings with fix plans. Use when the user says "audit", "full audit", "sweeping audit", "audit everything", "find issues/security fixes/optimizations", or "check for inconsistencies". Findings only by default; fixes happen after approval.
---

# Project Audit

Systematic audit of the current project. Output is a ranked findings table
the user can approve in one word ("do all", "do 1-4"). Do not fix during the
audit pass.

## Trigger
`/audit`, or the user asks for a "full audit", "sweeping audit", "audit every
file", "find as many security fixes / optimizations / issues as possible".

## Inputs
- Scope (default: whole project; the user may narrow to a subsystem — e.g.
  "the API", "the dashboard", "everything before <date>").
- If a knowledge graph exists (`graphify-out/`), query it first to target the
  audit instead of reading every file cold.

## Steps
1. **Map the surface.** Enumerate entry points, data stores, background jobs,
   scheduled tasks, and config. Note what has tests and what doesn't.
2. **Sweep by category**, collecting findings as you go:
   - **Correctness**: logic bugs, silent failure paths, error handling that
     swallows problems, stale/duplicated state, timezone/encoding traps.
   - **Data integrity**: duplicate rows, gaps, mixed conventions (e.g. price
     adjustment basis), anything that would silently corrupt downstream
     numbers. For DB-backed projects, run actual queries — don't infer.
   - **Security**: injection, authZ/authN gaps, secrets in code, path
     traversal, missing rate limits, dependency alerts.
   - **Performance**: N+1 patterns, missing indexes, unbounded reads,
     needless re-computation.
   - **Docs drift**: HANDOFF/state/record claims that no longer match the
     code or data. Flag, don't rewrite (that's the handoff skill's job).
3. **Verify before reporting.** Each finding needs evidence: the file:line,
   the query result, or the reproduced error. No speculative findings — if
   you can't demonstrate it, don't list it.
4. **Rank and report.** One table: `# | Severity (crit/high/med/low) |
   Finding | Evidence | Proposed fix | Effort`. Order by severity. Under the
   table, one short paragraph on overall health.
5. **Wait for approval.** The user typically replies "do all" or "do 1 and 3".
   Then fix in severity order, verifying each fix (run the relevant tests — if
   the project has frozen regression tests, they must stay at their baseline),
   and report what was fixed vs. skipped.

## Output
- Severity-ranked findings table with evidence and numbered items.
- After approval: fixes applied surgically, each verified, with a summary of
  what changed.

## Rules
- Findings pass changes NOTHING. No drive-by fixes, no "improved while I was
  there".
- Never delete anything (files, DB rows, records) without asking, even if it
  looks like junk — some environments accumulate harmless stray files.
- Keep tokens low: sample large files intelligently, use grep/queries over
  full reads, and don't paste long code excerpts into the report.
