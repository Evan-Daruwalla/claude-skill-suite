# Code method sweep — M1–M15 and the edge-case generators

Read by `audit` and `audit-code`, at either scope. The
scope differs between those four; the methods below do not.

This file is the accumulated scar tissue of real audits on this machine. Where
a rule cites a date and an incident, that incident actually happened — do not
soften those rules on the grounds that they look paranoid.

**Report using `reporting.md`. Resolve scope using `scoping.md`. Spawn workers
using `fanout.md`.**

---

## Step A — Map the surface

Enumerate entry points, data stores, background jobs,
scheduled tasks, CI/CD config, and docs. Note what has tests and what
doesn't. Extract every claimed invariant from the docs into an explicit list
— method 1 consumes it, method 7 checks intent against it.

## Step B — Automated pass first

Run what the project already has or what's free
and local: the test suite, linters/type-checkers, dependency auditors
(`npm audit`, `pip-audit`, or equivalent), and the commit-gate secret
scanner (`pm-secretscan.js --history`). Tool output is evidence — record
versions/commands. Do NOT install new tooling without asking.

---

## Step C — The core nine methods (M1–M9)

Nine methods, each finding a class the others structurally
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
  timezone basis, ID space — and for each, grep **every reader, every
  writer, and every GUARD** of that shared state, check each one honors it,
  then separately ask **what mechanism would catch a violation: a contract
  whose only guard cannot arithmetically fire is as broken as one no module
  honors.** Compare each guard's threshold against the *mathematical bound*
  of the quantity it guards — a detector is a third role, and reader/writer
  alone will not find it. **Two modules disagreeing about shared data is the
  worst bug class in any codebase**: both sides look correct in isolation
  and the corruption is silent. A contract with one writer that violates it
  is a finding even if nothing has broken yet.

  **Choose targets by grep-hit count on the shared symbol, not by doc
  emphasis — and invert the obvious prior.** A contract restated across five
  documents is usually one that already had its incident and got fixed; the
  productive target is the contract stated ONCE, in a comment, in passing.
  Hit-count is computable in one command *before* committing to a trace.

  **Enumerate by the shared symbol's NAME** (the table, the column, the
  constant) **— never by the access verb.** Verb-based enumeration
  structurally misses dynamic/f-string names and helper-mediated access.
  Then check the stored data's actual distinct values against the set the
  code believes in. A silently-empty search here yields a false "clean" on
  the highest-severity method in the sweep — cross-check it (see Rules).

  **A call-graph asymmetry is an M1 signal in its own right**: an adjustment
  helper with exactly one caller where its siblings have many usually means
  every other path silently skips the adjustment.

  **Unstated contracts count.** M1 starts from the *documented* list, but two
  readers disagreeing about an *undocumented* shared assumption is the same
  bug class at the same severity — the absence of a doc is not evidence the
  contract isn't real. Report it, and flag that it was never written down.

  **Three verdicts, not two: HONORED / VIOLATED / UNENFORCEABLE.** A contract
  with no mechanical enforcement anywhere ("never run these concurrently",
  "always open read-only") is a **finding, not a skip** — often the
  highest-value output available on a small team, because nothing will ever
  catch the slip.
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

---

## Step D — Edge-case sweep

Steps 1–3 ask "is this code wrong?" This asks "what
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
  | Encoding / type | unicode, emoji, BOM, CRLF, non-ASCII in `.bat` (winfix), mixed types, numeric string vs number |
  | Numeric | divide-by-zero, NaN/inf, float equality, negative, overflow, silent int/float coercion |
  | Filesystem | spaces or unicode in paths, case collisions, long paths, symlinks (Windows-specific per path-quirk-audit) |
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
  actually reach. Cite the reachability ("`results/` already contains a
  zero-row CSV"; "DST shifts twice a year and timestamps are labelled by
  offset").
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
announces itself; a wrong number propagates into a report, a paper, or a
trade and is trusted. A scheduled job that silently stops firing is the same
class: nothing errors, and the absence is the failure.

---

## Step E — Verify before reporting

Each finding needs evidence: the file:line,
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


---


---

## Step C2 — The six added methods (M10–M15)

Added 2026-08-21 from a gap analysis against OWASP, CWE, NIST SSDF, MS SDL,
SEI/CERT and the fuzzing/mutation literature. Each earns its place by the same
rule as M1–M9: **it finds a class the others structurally cannot.** Anything the
gap analysis found already covered was folded into an existing method instead of
becoming a new one.

### Applicability gating — read before running these

M1–M9 apply to essentially any project. M10–M15 do not. **A method that does not
apply is recorded as `N/A` with the evidence that established it** — not as
"swept" (a lie) and not as "not swept" (which implies you should have).

`N/A — no concurrency primitives: grep for thread/async/lock/mutex over 41 files
returned 0` is an honest coverage-map entry. `N/A` with no evidence is not.

### M10 — Test-suite validation *(the tests are evidence; audit the evidence)*

Every other method treats the test suite as ground truth. **M5 measures that
coverage exists; M6 runs the suite. Neither ever asks whether the suite would
catch a bug if one were there.** A file with 100% line coverage and no
meaningful assertions passes M4, M5 and M6 silently.

This is the highest-leverage addition, because it does not just find its own
bugs — it tells you how much to believe M5's and M6's output.

- Run a mutation tester over the churn-hot files M5 already identified — `mutmut`
  or `cosmic-ray` (Python), Stryker (JS/TS), PIT (Java). Report the **mutation
  score** (percentage of injected mutants the suite killed) alongside the line
  coverage, never instead of it.
- **A large gap between line coverage and mutation score is the finding**, and
  it is usually a bigger one than any single bug: it means the suite's green is
  not evidence.
- Where no mutation tool is available, the manual floor is cheap and still
  worth doing: **pick the three highest-churn test files and check each test
  actually asserts on a value**, not merely that the call did not raise. Count
  assertion-free tests and report the number.
- Coverage *criteria* matter as well as coverage percent: statement coverage is
  the weakest, branch better, MC/DC (required by DO-178C and ISO 26262) the
  strongest. State which one the number you are quoting actually measures.

**Precondition:** a test suite exists. If it does not, that IS the finding, and
it outranks whatever else M10 would have said.

### M11 — Generative input exploration *(G1 is manual and finite; this is not)*

G1 walks the input domain by hand, so it is bounded by what the auditor thought
of. **Coverage-guided fuzzing and property-based testing explore inputs no
method author would enumerate** — which is precisely why they find the parser
and memory-safety bugs that hand-enumeration misses.

- **Property-based testing** over pure functions: Hypothesis (Python),
  fast-check (JS), jqwik (Java). State an invariant, let the library generate
  and then *shrink* failures to a minimal reproduction. The shrunk case is the
  edge-case trigger `reporting.md` demands, produced for free.
- **Coverage-guided fuzzing** for anything parsing untrusted bytes or strings:
  Atheris (Python), libFuzzer/AFL++ (native), jazzer (JVM). Even a short local
  run is worth more than a long argument about whether the parser is safe.
- **Model checking** (TLA+, Alloy, Spin) where a protocol or state machine has
  a spec worth writing — exhaustive over the state space, so it catches
  interleavings no test run reaches. Expensive; propose it, do not run it
  unasked.

**Do not install a fuzzing toolchain without asking.** If none is present, say
so, name which functions would be the highest-value harness targets, and size
the work — that recommendation is the deliverable.

**Precondition:** something takes structured or untrusted input.

### M12 — Adversary-first threat model *(every other method is code-first)*

M1–M11 all start from code that exists and ask whether it is wrong. **None of
them start from "what does an attacker want, and what is the cheapest path to
it."** That is a generative step, and it finds architectural exposure — a trust
boundary crossed without revalidation — that no amount of grepping a correct-
looking function will surface.

- Draw the **data-flow diagram**: external entities, processes, data stores,
  and the **trust boundaries** (every place the privilege level changes —
  network edge, process edge, user-to-admin, unauthenticated-to-authenticated).
- Walk **STRIDE** at each boundary: Spoofing, Tampering, Repudiation,
  Information disclosure, Denial of service, Elevation of privilege. Six
  prompts per boundary, and the boundary list is short — this is cheaper than
  it sounds.
- For the top one or two threats, sketch an **attack tree**: the attacker goal
  at the root, AND/OR decomposition beneath it, and mark the cheapest leaf.
- Cross-check against the **CWE Top 25** for the project's language and shape,
  and be explicit that this is a *checklist* pass, not a proof.

**G3 (assumption inversion) is the closest existing analog and is not a
substitute** — G3 is per-assumption and opportunistic; M12 is systematic per
boundary.

**Precondition:** the project has an attack surface — a network listener, a
file it did not write, user input, or a privilege transition. A pure offline
numeric library may genuinely be `N/A`; say so with evidence.

### M13 — Concurrency & interleaving *(M1 traces state, not time)*

M1 enumerates readers, writers and guards of shared state. **It says nothing
about ordering**, and the whole concurrency bug class lives in ordering.

- **TOCTOU**: an access check followed by a separate open or use of the same
  path, without reusing a validated handle. This is a grep-able shape —
  `os.path.exists` then `open`, `access()` then `fopen()`, a `SELECT` that
  decides whether to `INSERT`.
- **Lock-order inversion**: enumerate every site acquiring two or more locks
  and check they all acquire in the same order. Divergence is a deadlock,
  findable statically, and it is exactly the M2 sibling-diff technique applied
  to acquisition order.
- **Races on shared files and rows**: two writers to one path or key with no
  lock, no atomic rename, no transaction. On this machine, appends that *look*
  atomic have been proven atomic only for specific sizes — do not generalise.
- **Retry without idempotency** overlaps M3; check it from the timing side
  (two retries in flight at once), not just the handler side.
- Where a dynamic detector exists and the project already runs it, use it:
  ThreadSanitizer, Helgrind. Do not install one unasked.

**Scheduled jobs and multi-instance runs count as concurrency** even in a
single-threaded program — two invocations of the same script overlapping is
the same bug class.

**Precondition:** threads, async, multiprocessing, scheduled tasks, or any
possibility of two instances running at once.

### M14 — Architecture & dependency structure *(a whole-graph property)*

M1 and M2 are local — one contract, one callee. **No existing method looks at
the module graph as a whole**, so structural decay is invisible to all of them.

- **Dependency cycles** between modules or packages: one command with `madge`
  (JS/TS), `pydeps` or a stdlib-AST import walk (Python), `go list` (Go). A
  cycle is a finding on its own; it also predicts where future changes will
  break in surprising places.
- **Layering violations**: if the docs state a layering (UI → service → data),
  check the import graph actually obeys it. When no layering is stated but one
  is obviously intended, report the intent as undocumented and check it anyway.
- **Architectural erosion**: as-implemented drifting from as-intended. This is
  M7's cousin — M7 checks behaviour against the spec, M14 checks *structure*
  against it.
- **God modules**: the file every other file imports. Report fan-in and fan-out
  for the top few; a module with very high fan-in and no tests is a standing
  risk regardless of whether it is currently wrong.

Formal stakeholder methods (ATAM, CBAM) are workshops, not sweeps — name them
if the project genuinely needs one, but do not simulate one.

**Precondition:** more than a handful of modules.

### M15 — Compliance surface *(licensing, accessibility, i18n)*

Three dimensions no other method touches, grouped because each is usually small
or `N/A`, and because all three are cheap to check and expensive to discover
late.

- **Licensing**: every dependency's licence and its obligations — copyleft
  contamination into a repo about to go public, attribution requirements never
  satisfied. Generate an SBOM (`syft`, `cdxgen`, SPDX or CycloneDX format) if
  tooling exists; otherwise read the manifest and report what you could not
  determine. **Never certify compliance** — flag obligations, name the ones
  unmet, and say plainly that this is not legal advice.
- **Accessibility**: only where a UI exists. WCAG 2.2 is the reference
  (W3C Recommendation, 2023-10-05). Automated scanning catches a minority of
  real issues; say so rather than reporting a clean automated pass as
  "accessible".
- **i18n**: hardcoded user-facing strings, date and number formats assuming one
  locale, assumptions that text is left-to-right or that one character is one
  byte. There is no single owning standard here — treat it as a practice area,
  not a certification.

**Precondition:** third-party dependencies (licensing), a user interface
(accessibility), or any user-facing text (i18n). Frequently `N/A` in part —
record which part.

---

## Additions folded into existing methods

These were gaps, but not new classes — they belong to a method that already
exists, and splitting them out would have been bookkeeping rather than method.

- **M9 gains supply-chain provenance.** M9 covered CVEs, lockfile drift,
  unpinned packages and leaked keys. It did not cover: **build provenance**
  (SLSA — was this artifact built by the pipeline it claims?), **SBOM
  generation and diff against the previous audit** (catches a changed component
  that has no CVE yet), **typosquatting and dependency confusion** (a private
  package name with a public-registry namesake is an attack, not a CVE — check
  scope pinning), and **maintenance status** (an unmaintained dependency with
  no CVE is still a finding). CVE lookup answers "is it known-bad"; none of
  these do, and that is the point.
- **M6 gains complexity and resource exhaustion.** M6 already names profiling.
  Make two things explicit: **algorithmic complexity read statically** (nested
  loops over inputs that grow, accidental quadratic string building, an N+1
  query pattern) — no other method inspects Big-O; and **unbounded growth** (a
  cache with no eviction, a log with no rotation, an accumulator that only ever
  appends), which is a resource-exhaustion class M6 will only surface if the
  run is long enough to show it.
- **G1 gains a pointer to M11.** Where a property-based library is already
  installed, use it rather than hand-enumerating — same generator, vastly wider
  domain.

---

## Revised cost order

Cheap methods aim expensive ones, and the generative methods run last because
they need the map and the harness the earlier ones establish:

**M5 → M4 → M9 → M14 → M1 → M2 → M3 → M13 → M7 → M8 → M12 → M6 → M10 → M11 → M15**

Then the edge-case generators G1–G4.

**If the budget runs out, it runs out in that order and the coverage map says
where it stopped.** Truncating silently and reporting a clean sweep is the
failure this whole file exists to prevent.

---

## The zero-result rule — read this before believing any "clean"

**A zero-result search is a claim, not a fact — cross-check it.** M1 is
grep-driven, so a silently-empty search makes it report "clean" and the
coverage map say "swept" when nothing was swept: a wrong answer that
announces itself as a good one, the exact B1 class this skill warns about.
Before trusting any empty or suspiciously-thin enumeration, re-run it through
a **second implementation** (the agent's search tool vs `grep -rn` in a shell). Not
paranoia — observed live: in one repo the built-in search tool
returned **0 files** for `auto_adjust` while GNU grep matched **21**.
**Root-caused 2026-08-05, and the cause is worth memorising: a single
malformed glob in `.gitignore` silently hides THE ENTIRE REPO from every
ripgrep-backed tool.** The line was `*}` (meant to ignore stray `10.2f}`
files). `{`/`}` are alternation syntax to ripgrep's globset, so an unmatched
`}` is a parse error, the ignore matcher fails CLOSED, and every search
returns a confident zero. git itself is unaffected, so the repo looks fine.
Proven by A/B: two identical trees differing only in that line returned 3
files vs 0. Fix: escape it (`*\}`) or bracket it (`*[}]`) — both keep git's
behaviour identical. **When a whole-repo search comes back empty, grep the
ignore files for `{`/`}` before believing it.** **Backslash patterns are their own hazard, and a separate one:** a pattern
containing `\` can be collapsed by a layer between you and grep (observed
2026-08-05: a four-backslash ERE reached grep as one), so a backslash search
that returns nothing proves nothing. Use `-F` for a literal Windows path, or a
bracketed `[\]`. This does NOT explain the `auto_adjust` case above — that
pattern has no backslash — that one was the malformed-glob bug above.
**A BOUNDED search is a zero-result search wearing a limit.** Observed
2026-08-21, and it cost a real false finding: a delegate ran
`find <root> -maxdepth 4 -iname '.git'`, counted 16 repos, and reported a
document claiming 17 as WRONG. The 17th repo sat at depth 5
(`<proj>/ml/vendor/<clone>/.git`). The document was correct; acting on the
finding would have introduced the error. Verified by re-running at increasing
depth: maxdepth 4 -> 16, maxdepth 5 -> 17, maxdepth 6 -> 17.

Every bound is an assumption: `-maxdepth`, `head -n`, a glob that only matches
one extension, `-type d` when the thing might be a file, a default-excluded
directory. **When a bounded search produces the negative half of a finding,
re-run it with the bound relaxed before reporting.** If the count changes, the
bound WAS the finding.

**Corollary for delegate findings: a REPORTED-tier finding's file:line and
counts belong to the delegate, not to you.** Promoting it to CONFIRMED means
re-deriving its evidence yourself, not re-reading its prose and finding it
convincing. Relaying a citation you did not run makes the delegate's bound your
claim.

**Equalize path scope before comparing** — two tools with different
default scopes disagree for reasons that have nothing to do with either tool.
Reserve the cross-check for **load-bearing negatives** (a "no findings"
conclusion, a "clean" claim): across two full audits ~26 paired searches
agreed every time, so applying it to every enumeration is pure cost. Its
value is not catching discrepancies — it is turning an *assumed* negative
into a *trustworthy* one. Report which tool produced each enumeration.
