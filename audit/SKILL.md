---
name: audit
description: Full sweeping project audit run COLD — a fresh auditor with no inherited session belief, sweeping by nine methods (invariant tracing, call-site contracts, error paths, static tooling, churn×coverage targeting, dynamic verification, spec conformance, data-at-rest, deps/env/secrets) plus a four-generator edge-case sweep ranked by how likely each case is to actually occur. Produces severity-ranked findings and priority-ranked edge cases, each with a surgical fix. Use when the user says "audit", "full audit", "sweeping audit", "audit everything", "find issues/security fixes/optimizations", "check for inconsistencies", "find edge cases", or "what could break". Findings only by default; fixes happen after approval.
---

# Project Audit

Systematic audit of the current project, hybrid by design: automated tools map
the surface, then a method-driven deep-dive tells how deep the cracks go.
Output is a ranked findings table the user can approve in one word ("do all",
"do 1-4"). Do not fix during the audit pass.

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

0. **Enter cold.** An audit run by the session that just built the thing
   inherits its author's belief — "that module is fine, I wrote it" is not a
   finding you can make, and it silently shrinks the search space. So:

   **If this session has already worked on the project, spawn a fresh auditor**
   (subagent, general-purpose) and hand it ONLY:
   - the project path, and one line on what the project is;
   - the scope and driver from Inputs;
   - the pointers to read (README, agent-instruction files, handoff/status
     docs, PRD, changelog) **as claims under test**;
   - this SKILL.md's steps 1–6.

   If the session is already fresh — no prior work on this project — you ARE
   the cold auditor; proceed inline. Spawning to re-derive what you do not yet
   believe is waste.

   **What the auditor must NOT receive:** conversation history, what an earlier
   session concluded, which findings were already dismissed, or any "this part
   is known-good". Absence of belief is the point.

   **What it MUST still read:** the project's own docs. Methods 1 and 7 are
   built on them — you cannot trace an invariant nobody stated, or check intent
   against a spec you refused to open. Documented scar tissue (a stored-price
   adjustment convention, a batch file that dies on one non-ASCII byte) is a
   **claim to verify**, never a fact to assume and never a reason to skip a
   check. Cold means unbiased, not amnesiac.

1. **Map the surface.** Enumerate entry points, data stores, background jobs,
   scheduled tasks, CI/CD config, and docs. Note what has tests and what
   doesn't. Extract every claimed invariant from the docs into an explicit list
   — method 1 consumes it, method 7 checks intent against it.

2. **Automated pass first.** Run what the project already has or what's free
   and local: the test suite, linters/type-checkers, dependency auditors
   (`npm audit`, `pip-audit`, or equivalent), and any secret scanner the repo
   is wired with. Tool output is evidence — record versions/commands. Do NOT
   install new tooling without asking.

3. **Method sweep.** Nine methods, each finding a class the others structurally
   cannot. **Run them in cost order, not list order** — the cheap ones aim the
   expensive ones:

   **M5 → M4 → M9 → M1 → M2 → M3 → M7 → M8 → M6**

   - **M5 — Churn × coverage targeting** *(run first; finds nothing itself)*.
     Cross-reference `git log` churn against test coverage; sweep TODO/FIXME/
     HACK and recent diffs. High-churn × low-coverage is statistically where
     bugs live. **This is a targeting method** — its output is where to point
     M1–M3, so attention is concentrated rather than spread evenly. **Define the coverage
     measurement or the cross-reference is meaningless**: with no coverage tool
     installed, an import-graph fallback *overstates* coverage — a module
     imported by a test is not necessarily exercised by it. State which measure
     you used. The TODO/FIXME sweep is a separate, usually-empty check; run it,
     but never let it stand in for the churn analysis.
   - **M4 — Static tooling at max strictness.** Type checker + linter +
     semgrep, cranked past whatever the project actually gates on. Shallow but
     deterministic and nearly free; clears the dumb stuff so human attention
     goes to logic. Report what the project's own gate would have missed. **If no linter is
     installed and you may not install one, say so — the fallback floor
     (`py_compile`, import probes) finds essentially nothing — and write a
     ~60-line stdlib-AST pass instead** (unused imports, bare `except`,
     `except: pass`, mutable defaults). Probe imports with
     `PYTHONPATH=<srcdir>`: a flat `src/` with no `__init__.py` makes
     `import src.x` fail for every module, producing ModuleNotFoundErrors that
     look like findings and are not.
   - **M9 — Dependencies / environment / secrets.** CVEs, lockfile drift,
     unpinned or duplicated packages, leaked keys, misconfig. Lives entirely
     outside first-party code, so M1–M3 cannot reach it and M4 only grazes it. Check not
     just whether versions are pinned but whether the pinned set is
     **installable** — a correct pin whose index lives in a comment instead of
     an `--extra-index-url` line fails on a clean machine. With no CVE database
     reachable, write "could not determine" rather than implying coverage.
   - **M1 — Invariant tracing** *(highest-severity class)*. Take step 1's list
     of cross-cutting contracts — units, adjustment state, encoding, ordering,
     timezone basis, ID space — and for each, grep **every reader and every
     writer** of that shared state and check each one honors it. **Two modules
     disagreeing about shared data is the worst bug class in any codebase**:
     both sides look correct in isolation and the corruption is silent. A
     contract with one writer that violates it is a finding even if nothing has
     broken yet.
   - **M2 — Call-site contract audit.** For each non-trivial function, compare
     what callers **actually pass** against what the body **assumes**: nulls,
     empty collections, units, error returns, ownership. Bugs concentrate at
     interfaces, not inside function bodies — so read the call sites, not just
     the definition. **Do not compare each caller to the body — that is O(n²) over a large
     tree and low-yield. Pick a SHARED callee and diff its call sites against
     EACH OTHER**: divergence between siblings is the signal, agreement with
     the body is not. Duplicated helper bodies across modules are call-site
     contracts too — two copies of one function returning `0.0` vs `NaN` on the
     empty case is this class.
   - **M3 — Error-path review.** Read every `catch` / `except` / fallback
     branch specifically, as its own pass. Error paths are the least-executed
     code in any project and therefore the least tested. Look for: swallowed
     exceptions, partial state left behind on failure (half-written file, open
     transaction, released-then-used resource), and retries without
     idempotency. **Then trace where the error RECORD goes.** A handler is
     unremarkable in isolation; it becomes a finding when you follow its
     failure artifact to the exit gate and find one sibling feeds it and
     another doesn't. For every handler: name the artifact that proves the
     failure happened, then check the exit path actually reads it.
   - **M7 — Spec / intent conformance.** M1–M4 check internal consistency only:
     a function named `get_adjusted_price` that returns raw prices passes every
     one of them. Compare actual behavior against the PRD, the docs, and the
     **names**. Doc-vs-code drift is its own error class — and when they
     disagree, report the drift; do not assume the code is the intent. **Committed output
     artifacts are a spec surface too** — read the generated CSV/JSON/report
     against what the docs claim about it; that is where a stale summary gets
     caught. **Sequencing matters**: check every doc layer (live snapshot, PRD,
     paper, docstring) before concluding which one drifted, or you will report
     the correct one as wrong.
   - **M8 — Data-at-rest validation.** M1 proves writers honor the contract
     *going forward*; it cannot see rows already corrupted by a bug since
     fixed. Query the stored data and verify it currently satisfies the
     invariants: FK orphans, unexpected NULLs, duplicates, stale derived
     values, rows predating a convention change. Run actual queries — never
     infer. **Validate every apparent violation against the generating source
     line before reporting it** — on research data, column-name heuristics have
     a brutal false-positive rate (a `gjs` column bounded by log2(K) rather than
     1; a `p` column meaning probability in one record type and an index in
     another). Sparsity is usually the encoding, not a defect: drop "empty
     cells" as an invariant in favour of **"column empty in 100% of rows"** and
     **"column whose semantics change by row"**.
   - **M6 — Dynamic verification** *(nothing above ever executes the code)*.
     Run the suite; hit the endpoints with real data; long-run under
     sanitizers/profiling where available. Config mistakes, integration
     failures, real-data-shape mismatches, and resource leaks manifest **only**
     at runtime. No amount of reading finds a wrong env var. **Pass/fail is not the
     deliverable.** Also report whether any test configuration exists at all (a
     green suite with no pinned strictness is weaker than it looks), the result
     under warnings-as-errors, and the gap between modules that exist and
     modules the suite actually collects.

4. **Edge-case sweep.** Steps 1–3 ask "is this code wrong?" This asks "what
   input or state makes this code wrong?" — a different method, so it runs as
   its own pass. **Four generators**, each producing cases the others cannot:

   - **G1 — Per-input domain enumeration.** For every external input, walk the
     domain: empty, zero, negative, huge, duplicates, unicode, malformed, wrong
     type. Where the project already has a property-based testing library
     (Hypothesis, fast-check), use it to automate the enumeration rather than
     hand-listing. **Trace each input to its USE site, not just its parser** —
     the dangerous defects live between `parse_args()` and the consumer (a cache
     key that omits an argument; a path written without `makedirs`), not in the
     argparse domain. And record a fourth outcome beyond reject/garbage/crash:
     **(d) accepted, runs to completion, silently emits a partial result set** —
     the most dangerous one, and the one a class checklist has no slot for.
     Class checklist:

     | Class | What to try |
     |---|---|
     | Empty / absent | empty file, zero rows, `None`, `""`, missing key, missing dir, no matches |
     | Boundary | first/last element, off-by-one, **exactly at** a threshold (`>=` vs `>` — check which the code uses against which the spec says) |
     | Size | single item, one-more-than-a-batch, unbounded growth, huge input |
     | Encoding / type | unicode, emoji, BOM, CRLF, non-ASCII in a `.bat`, mixed types, numeric string vs number |
     | Numeric | divide-by-zero, NaN/inf, float equality, negative, overflow, silent int/float coercion |
     | Filesystem | spaces or unicode in paths, case collisions, long paths, symlinks |
     | External | network down, API 429/5xx, disk full, permission denied, path not found |

   - **G2 — State & timing seams.** **Lead with this question**: does any script
     reconstruct its results from a *directory scan* rather than from the run
     that produced them? If so, a run killed at 60% yields an output
     byte-shaped like a complete one. Then: restart mid-operation, concurrent writers,
     retry after partial success, clock edges (DST shift, midnight rollover,
     leap day, month/year boundary), out-of-order arrival, a scheduled run that
     silently never fires. **Unit tests essentially never cover these** — they
     have to be enumerated deliberately or they are not covered at all.
   - **G3 — Assumption inversion.** Write down every *implicit* assumption the
     code makes — the file exists, the list is sorted, the network is up, the
     response is well-formed, only one instance is running, the clock moves
     forward, IDs are unique — then ask **"what happens when this is false?"**
     one at a time. An undocumented edge case is just an uninverted assumption. **Bound it or it never terminates**: seed the list from load-bearing
     constants and documented invariants (a pre-registered threshold, a stated
     convention), not from code shape — "dict is ordered" is true and
     irrelevant; "this threshold is 0.0" matters because a claim rides on it.
     An assumption you invert and find *guarded* is a real result — record it.
   - **G4 — Interaction effects.** G1–G3 are all one-variable-at-a-time. Two
     features each individually fine but broken **in conjunction** (unicode
     username × CSV export; discount × refund; retry × partial write) never
     surface from single-axis enumeration. Pair the axes deliberately —
     especially any two that touch the same state. **The generator is `accumulator × key-variation`**, not a list of
     stock pairs: pair an axis that ACCUMULATES (a cache, an append-only file, a
     results directory) with one that VARIES THE KEY (a mutated input, a rerun,
     a partial sweep). Stock examples borrowed from other codebases waste time —
     confirm the pairing exists here before chasing it.

   **Rank each by LIKELIHOOD, and cite why — never a bare guess or a
   percentage.** The tier must name the observable reason it sits there:

   - **L1 ROUTINE** — occurs in normal operation, no unusual input required.
     Cite the path ("runs on every commit via the pre-commit hook").
   - **L2 PLAUSIBLE** — needs an uncommon but realistic state the project can
     actually reach. Cite the reachability ("the data directory already
     contains a zero-row CSV"; "DST shifts twice a year and timestamps are
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
   is trusted. A scheduled job that silently stops firing is the same class:
   nothing errors, and the absence is the failure.

5. **Verify before reporting.** Each finding needs evidence: the file:line,
   the query result, the tool output, or the reproduced error. No speculative
   findings — if you can't demonstrate it, don't list it. For crit/high
   findings, name the root cause, not just the symptom.

   **For edge cases the bar is a concrete trigger, stated literally.** Not
   "handle empty input" — *"a results CSV with zero data rows makes
   `summarize()` do `rows[0]` at `src/x.py:42` → IndexError."* An edge case
   whose trigger you cannot state as an actual input or state is a hypothesis,
   not a finding: drop it. Mark each trigger **OBSERVED** (exists now, or you
   reproduced it) or **CONSTRUCTED** (does not exist yet but you can name the
   exact input that causes it). Constructed is allowed — an empty CSV nobody
   has produced yet is still a real edge case — but never outranks an observed
   one at the same priority.

6. **Rank and report.**
   - **Executive summary** (3–5 lines): top risks and overall health.
   - **Findings** table: `# | Severity (crit/high/med/low) | Method | Finding |
     Evidence | Surgical fix | Effort`, ordered by severity. The Method column
     (M1–M9) makes a thin method visible.
   - **Edge cases** table, numbered `E1, E2, …`: `# | Priority (P1–P3) | Gen |
     L | B | Trigger (literal, OBSERVED/CONSTRUCTED) | Where (file:line) |
     Failure | Surgical fix`, ordered by priority. P3s may collapse to one line
     each — full detail is owed to P1/P2.
   - **Fix order**: one interleaved list across both tables so there is a
     single thing to approve — e.g. `E1, 2, E3, 1, 4, E2`. Severity and
     priority are the same scale: crit≈P1, high≈P1/P2, med≈P2, low≈P3.
   - **Coverage map**: every method M1–M9 and every generator G1–G4 marked
     swept / partial / not swept, with why. Absence of findings is only
     meaningful where coverage was real — a method you did not run is "not
     swept", never "no findings". Say plainly if M6 was skipped for lack of a
     runnable environment; an audit with no dynamic pass is a reading exercise.
7. **Wait for approval.** The user typically replies "do all" or "do 1 and 3"
   (edge cases the same way: "do E1-E3", "do all").
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
  edge-case table + one interleaved fix order + coverage map over M1–M9 and
  G1–G4.
- After approval: fixes applied surgically, each verified (edge-case fixes by
  running their trigger), with a summary of what changed and the follow-up
  validation result.

## Rules
- Findings pass changes NOTHING. No drive-by fixes, no "improved while I was
  there".
- **Cold means unbiased, not uninformed.** Leave session belief at the door;
  read the docs anyway, as claims under test. An auditor who skips the
  agent-instruction file to "stay objective" just re-discovers documented traps
  the slow way.
- **Every proposed fix is surgical or it is honestly labelled large.** Name the
  file:line and the smallest change that closes it; no refactor bundled in, no
  "while we're here". Prefer one guard at the shared chokepoint over N guards
  at call sites — smaller diff and root-cause fix at once. If the real fix
  genuinely is large (a schema change, a rewritten module), say so and size it
  rather than proposing a small patch that only appears to close it.
- **A zero-result search is a claim, not a fact — cross-check it.** M1 is
  grep-driven, so a silently-empty search makes it report "clean" and the
  coverage map say "swept" when nothing was swept: a wrong answer that
  announces itself as a good one, the exact B1 class this skill warns about.
  Before trusting any empty or suspiciously-thin enumeration, re-run it through
  a **second implementation** (e.g. the agent's search tool vs `grep -rn` in a
  shell). Not paranoia — observed live: in one repo the built-in search tool
  returned **0 files** for a pattern GNU grep matched in **21**, with no error
  and no warning. **Equalize path scope before comparing** — two tools with
  different default scopes disagree for reasons that have nothing to do with
  either tool. Reserve the cross-check for **load-bearing negatives** (a "no
  findings" conclusion, a "clean" claim): across two full audits ~26 paired
  searches agreed every time, so applying it to every enumeration is pure cost.
  Its value is not catching discrepancies — it is turning an *assumed* negative
  into a *trustworthy* one. Report which tool produced each enumeration.
- **Likelihood is cited, never guessed, and never a percentage.** "L1 because
  it runs on every commit" is a rank; "L1, ~80% likely" is an invented number
  wearing a rank's clothes. No fabricated precision.
- An edge case without a literal trigger is a hypothesis — drop it rather than
  padding the count. "As many as possible" is bounded by what you can
  substantiate; a long list of unsubstantiated maybes is worse than a short
  list of real ones.
- Never delete anything (files, DB rows, records) without asking, even if it
  looks like junk — some environments accumulate harmless stray files.
- Never install new scanners/tools or claim regulatory compliance status —
  flag gaps, don't certify.
- Keep tokens low: sample large files intelligently, use grep/queries over full
  reads, and don't paste long code excerpts into the report.
