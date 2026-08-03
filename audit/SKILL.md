---
name: audit
description: Full sweeping project audit — code, data integrity, security, dependencies, infrastructure, performance, docs, plus an edge-case sweep that enumerates concrete failure scenarios and ranks them by how likely they are to actually occur. Produces severity-ranked findings and priority-ranked edge cases, each with a surgical fix. Use when the user says "audit", "full audit", "sweeping audit", "audit everything", "find issues/security fixes/optimizations", "check for inconsistencies", "find edge cases", or "what could break". Findings only by default; fixes happen after approval.
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
4. **Edge-case sweep.** Step 3 asks "is this code wrong?" This asks "what
   input or state makes this code wrong?" — a different method, so run it as
   its own pass over the entry points mapped in step 1. Walk the input classes
   below against each entry point, data reader, and scheduled job. Go wide:
   the goal is every scenario you can substantiate, not a tidy top-five.

   | Class | What to try |
   |---|---|
   | Empty / absent | empty file, zero rows, `None`, `""`, missing key, missing dir, no matches |
   | Boundary | first/last element, off-by-one, **exactly at** a threshold (`>=` vs `>` — check which the code uses against which the spec says) |
   | Size | single item, one-more-than-a-batch, unbounded growth, huge input |
   | Encoding / type | unicode, emoji, BOM, CRLF, non-ASCII in a `.bat`, mixed types, numeric string vs number |
   | Time | DST transition, timezone label vs offset, clock skew, out-of-order timestamps, first-of-month/year, a scheduled run that silently never fires |
   | Concurrency | two runs at once, partial write, lock not taken, resumed-after-kill |
   | Lifecycle / state | first run (no state file), stale cache, half-migrated schema, resumed run, rollback |
   | External | network down, API 429/5xx, disk full, permission denied, path not found |
   | Numeric | divide-by-zero, NaN/inf, float equality, negative, overflow, silent int/float coercion |
   | Filesystem | spaces or unicode in paths, case collisions, long paths, symlinks |

   **Rank each by LIKELIHOOD, and cite why — never a bare guess or a
   percentage.** The tier must name the observable reason it sits there:

   - **L1 ROUTINE** — occurs in normal operation, no unusual input required.
     Cite the path that makes it routine ("runs on every commit via the
     pre-commit hook").
   - **L2 PLAUSIBLE** — needs an uncommon but realistic state the project can
     actually reach. Cite the reachability ("the data directory already
     contains a zero-row CSV", "DST shifts twice a year and timestamps are
     labelled by offset").
   - **L3 RARE / ADVERSARIAL** — needs crafted input or a conjunction of
     failures. Cite what has to line up.

   Then **blast radius**: **B1** silently wrong data, data loss, or a security
   hole · **B2** loud failure (crash, non-zero exit, broken run) · **B3**
   degraded or cosmetic.

   **Priority is mechanical, not a vibe** — read it off this matrix:

   | | B1 silent/loss | B2 loud | B3 degraded |
   |---|---|---|---|
   | **L1** | P1 | P1 | P3 |
   | **L2** | P1 | P2 | P3 |
   | **L3** | P2 | P3 | P3 |

   **A silent wrong answer outranks a crash of equal likelihood.** A crash
   announces itself; a wrong number propagates into a report or a decision and
   is trusted. A scheduled job that silently stops firing is the same class of
   problem: nothing errors, and the absence is the failure.

5. **Verify before reporting.** Each finding needs evidence: the file:line,
   the query result, the tool output, or the reproduced error. No speculative
   findings — if you can't demonstrate it, don't list it. For crit/high
   findings, name the root cause, not just the symptom.

   **For edge cases the bar is a concrete trigger, stated literally.** Not
   "handle empty input" — *"a results CSV with zero data rows makes
   `summarize()` do `rows[0]` at `src/x.py:42` → IndexError."* An edge case
   whose trigger you cannot state as an actual input or state is a hypothesis,
   not a finding: drop it. Mark each trigger **OBSERVED** (it exists now, or
   you reproduced it) or **CONSTRUCTED** (it does not exist yet but you can
   name the exact input that causes it). Constructed is allowed — an empty CSV
   nobody has produced yet is still a real edge case — but it never outranks
   an observed one at the same priority.

6. **Rank and report.**
   - **Executive summary** (3–5 lines): top risks and overall health.
   - **Findings** table: `# | Severity (crit/high/med/low) | Finding |
     Evidence | Surgical fix | Effort`, ordered by severity.
   - **Edge cases** table, numbered `E1, E2, …`: `# | Priority (P1–P3) | L | B
     | Trigger (literal, OBSERVED/CONSTRUCTED) | Where (file:line) | Failure |
     Surgical fix`, ordered by priority. P3s may collapse to one line each —
     full detail is owed to P1/P2.
   - **Fix order**: one interleaved list across both tables so there is a
     single thing to approve — e.g. `E1, 2, E3, 1, 4, E2`. Severity and
     priority are the same scale here: crit≈P1, high≈P1/P2, med≈P2, low≈P3.
   - **Coverage map**: each step-3 category AND each step-4 input class marked
     swept / partial / not swept, with why — absence of findings is only
     meaningful where coverage was real. An input class you did not try is
     "not swept", never "no findings".
7. **Wait for approval.** The user typically replies "do all" or "do 1 and 3"
   (edge cases are approved the same way: "do E1-E3", "do all").
   Then fix in the step-6 fix order, verifying each fix (run the relevant
   tests — if the project has frozen regression tests, they must stay at their
   baseline), and report what was fixed vs. skipped. **An edge-case fix is
   verified by feeding it the trigger** — run the actual empty file, the
   exactly-at-threshold value, the unicode path — not by reading the patch. A
   fix that was never fed its own trigger is unverified; say so.
8. **Follow-up validation.** After fixes, re-run the step-2 automated pass and
   the affected tests to prove the fixes didn't introduce regressions; report
   the before/after.

## Output
- Executive summary + severity-ranked findings table + priority-ranked
  edge-case table + one interleaved fix order + coverage map.
- After approval: fixes applied surgically, each verified (edge-case fixes by
  running their trigger), with a summary of what changed and the follow-up
  validation result.

## Rules
- Findings pass changes NOTHING. No drive-by fixes, no "improved while I was
  there".
- **Every proposed fix is surgical or it is honestly labelled large.** Name
  the file:line and the smallest change that closes the finding; no refactor
  bundled in, no "while we're here". Prefer one guard at the shared chokepoint
  over N guards at call sites — that is both the smaller diff and the
  root-cause fix. If the real fix genuinely is large (a schema change, a
  rewritten module), say so and size it rather than proposing a small patch
  that only appears to close it.
- **Likelihood is cited, never guessed, and never a percentage.** "L1 because
  it runs on every commit" is a rank; "L1, ~80% likely" is an invented number
  wearing a rank's clothes. No fabricated precision.
- An edge case without a literal trigger is a hypothesis — drop it rather than
  padding the count. "As many as possible" is bounded by what you can
  substantiate, and a long list of unsubstantiated maybes is worse than a
  short list of real ones.
- Never delete anything (files, DB rows, records) without asking, even if it
  looks like junk — some environments accumulate harmless stray files.
- Never install new scanners/tools or claim regulatory compliance status —
  flag gaps, don't certify.
- Keep tokens low: sample large files intelligently, use grep/queries over
  full reads, and don't paste long code excerpts into the report.
