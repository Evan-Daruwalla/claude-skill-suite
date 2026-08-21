# Fan-out — parallel workers, cold entry, and merging what they return

Read by all three audit skills. Governs who gets spawned, what they are told,
what they are NOT told, and how their output becomes one report.

---

## The budget

**Eight Sonnet workers maximum, counted across every level — including any
delegate a worker spawns.** A worker that spawns two delegates consumes three
of the eight. State the count in the report's Cost line.

Sonnet for searching and reading; the session model synthesises, adjudicates
and re-verifies. This matches `opus-workers`: cheap tier does the bulk, the
expensive tier reviews against a rubric registered in advance.

For a recent-scoped audit the budget is usually 2–4, not 8. Spending eight workers
on a twelve-file diff is waste, and the coverage map will show them tripping
over each other.

---

## Why fan out at all

Not for speed. For **position**. Liu et al. (arXiv:2307.03172) measured a
>20-point accuracy drop for material sitting mid-context versus at the ends,
and showed that going from 20 to 50 documents in one context bought ~1–1.5%.
A single worker holding the whole repo is provably worse at the middle of it.
Eight workers each holding a bounded slice do not have a middle to lose things
in.

The second reason is **independence**, and it is fragile — see the next
section.

---

## Workers do not vote

**Do not ask workers to reach consensus, cross-review each other, or converge
on a shared list.** The "Refute-or-Promote" study (arXiv:2604.19049) found
heterogeneous multi-agent review teams *consistently failed to match their own
best individual member*, losing up to **37.6%** — even when told which member
was the expert. Consensus-seeking overrides expertise.

So:

- Each worker reports independently, to the session model, in isolation.
- Findings keep their **`Src` attribution** all the way into the report. That
  column exists because a merged, de-attributed list hides which worker was
  carrying the audit and which contributed noise.
- **The session model adjudicates on evidence, not on agreement.** Two workers
  reporting the same thing is not confirmation — they may share a wrong prior.
  One worker's finding with a reproduction beats three workers' agreement
  without one.

Peer review among workers is the one collaboration pattern to avoid here. It is
also, unfortunately, the intuitive one.

---

## Cold entry — what a worker gets

**Hand it:**

- the project path, and one line on what the project is;
- its assigned methods and its manifest shard;
- the pointers to read — README, agent-instruction file, handoff/status doc, PRD, changelog — framed
  explicitly as **claims under test**;
- the relevant reference file (`code-methods.md`, `docs-methods.md`);
- the acceptance rubric (below), pre-registered;
- the output schema it must return.

**Never hand it:**

- conversation history, or what this session already believes;
- what an earlier audit concluded, or which findings were dismissed;
- any "this part is known-good".

Absence of belief is the point. A worker told "the scanner was fixed last week"
will not check the scanner.

**But it must still read the docs.** Cold means unbiased, not amnesiac. A
worker that skips the agent-instruction file to "stay objective" just
rediscovers documented
traps the slow way, and several methods are built on the docs — you cannot
trace an invariant nobody stated.

---

## The rubric, pre-registered

Write this before any worker output exists, and hand it to every worker. Both
real audits of one project did exactly this, and it is the reason their outputs
were comparable.

1. Every finding carries **file:line** and evidence — a command and its real
   output, a query result, or a reproduction. No evidence, no finding.
2. Every finding carries a **tier**: CONFIRMED (you reproduced it), REPORTED
   (you inferred it from reading), CONSTRUCTED (you can name the exact input
   that would trigger it).
3. **Never invent** a number, a filename, a line number, or a tool output. If a
   command failed, report the failure — a fabricated finding is worse than a
   missed one.
4. **A zero-result search is a claim.** Before reporting "clean", re-run the
   search a second way and say which tools produced which result.
5. **State what you could not check**, and why. An honest gap is a result.
6. Severity is argued, not asserted — say what breaks and for whom.
7. **Emit a SEARCH TRAIL.** For every method, state the exact enumeration
   command you ran, the count it returned, and every depth, filter, glob or
   path limit inside it. A finding is a claim about what exists; the trail is
   your claim about what you looked at. Both get checked.

---

## The coverage-provenance gate

Verification tiers cover *findings*. Until 2026-08-21 nothing covered
*coverage* — and that is precisely where this fan-out failed on its first real
run.

Three separate defects turned out to be one defect. A `find -maxdepth 4` that
silently truncated. A manifest whose `grep` dropped every non-ASCII filename,
including the most important document in the repo. A budget a worker never saw
because it lived in this file rather than in the prompt. Each produced a
confident claim about what had been examined, and **nothing in fifteen methods
had the job of checking that claim.** A worker can say "I checked everything",
be wrong, and the report still reads clean.

So the trail is reconciled before any finding is trusted — and *especially*
before a clean one is:

1. **Count reconciliation.** The worker's trail count against the manifest
   shard it was handed. Any discrepancy is a finding about the audit itself,
   resolved before the report ships.
2. **Limit disclosure.** Every `-maxdepth`, `head`, glob, exclude, or sample
   stated with its value. The undisclosed limit is the defect; the limit itself
   is usually fine.
3. **Downgrade rule.** A method whose trail does not reconcile is marked
   **not swept** — never "no findings" — however thorough the worker's prose
   sounds. Absence of findings from an unreconciled sweep is absence of
   evidence.
4. **The orchestrator independently re-enumerates at least one shard** and
   compares. Not all of them: one is enough to catch a *systematic* error, and
   a systematic error is the kind that matters.

Cheap, and non-negotiable. The trail costs a worker a few lines. Skipping it
costs you a confident report about a subset.

---

## Partitioning: two waves

Method-family is the primary axis; the manifest shard is the secondary one.
Coverage is then provable **per method**, which is what the coverage map claims.

### Wave 1 — targeting (1 worker, runs alone)

`M5` (relative churn × coverage), `M4` (static tooling), `M14` (dependency
graph). These are cheap, mostly mechanical, and their output is **where to
point everything else**. Running them in parallel with the deep methods wastes
the targeting.

Wave 1 returns: the churn-ranked file list (relative churn — see
`scoping.md`), the static-tool output, the module graph, and the manifest with
strata assigned.

### Wave 2 — the sweep (up to 7 workers)

Default allocation for a full both-domains audit. Adapt to the project; record
what you actually used.

| Worker | Methods | Notes |
|---|---|---|
| W2 | M1, M2 | Invariant tracing + call-site contracts. The highest-severity pair; give it the churn-ranked list. |
| W3 | M3, M13 | Error paths + concurrency. Both are "what happens off the happy path". |
| W4 | M7, M8 | Spec/intent conformance + data at rest. Needs the docs claim inventory. |
| W5 | M9, M15 | Deps, supply chain, secrets, licensing. Mostly outside first-party code. |
| W6 | M12, G1–G4 | Threat model + the four edge-case generators. The generative worker. |
| W7 | D1–D8 | Docs sweep. |
| W8 | D-series shard 2, or X-series | Split docs if the doc set is large; otherwise cross-domain. |

**M6, M10 and M11 (dynamic verification, mutation testing, fuzzing) stay with
the session model** or get one dedicated worker. They execute code and install
nothing — that needs the judgment and the permission context a worker does not
have.

---

## Merging what comes back

### Deduplicate by fingerprint, not by wording

Two workers describing one bug in different words must collapse to one finding.
Key on **file path + nearest stable symbol + rule/method + the substance of the
claim** — deliberately *not* line number, which shifts. This is SARIF's
`partialFingerprints` idea; its known weakness is that paths differing between
environments break matching, so normalise paths to repo-relative before
comparing.

When two workers report the same defect at different severities, **take the
higher and say both** — the disagreement is information.

### Verify before promoting

Untuned LLM reviewers have been reported at **40–80% false positives** (vendor
figure, not peer-reviewed — treat as an industry observation, not a statistic).
More usefully, the same source attributes **30–42% of false positives to
config, infrastructure-as-code and tooling files** rather than application
code. Weight verification effort accordingly: a finding in a `.yml`, a
`.gitignore`, a hook or a build script deserves more scepticism than one in a
function body, not less.

The session model re-runs **every crit and high** itself. Anything it does not
re-run ships as `REPORTED (unverified)` per `reporting.md`, with a stated
reason.

### Late arrivals

Workers finish at different times. A finding that arrives after the report is
drafted goes in an `## ADDENDUM`, tiered like everything else, with duplicates
marked against the main table rather than renumbering it.

---

## Worker prompt template

> You are auditing `<absolute path>`. `<One line: what this project is.>`
>
> Your assignment: methods `<M#, M#>` from the reference file at `<path>`. Read
> that file first and follow it exactly.
>
> **Agent budget: you may spawn <N> delegates. <N> is normally ZERO — do not
> spawn any.** The audit has a hard cap of eight agents across all levels and
> the orchestrator has already allocated it.
>
> **Persistence: return your findings in CHUNKS as you go — after each method
> completes, return what you have so far.** Do not hold results until the end;
> anything unreturned when you stop is lost. **Do not try to write findings to
> a file** — the harness refuses report-shaped writes from subagents, so the
> attempt fails and wastes the turn.
>
> Your manifest shard is `<N files>`, listed below. Every file in it must be
> accounted for in your output: swept, or not-swept with a reason.
>
> Read these as **claims under test, not facts**: `<README, agent-instruction file,
> handoff/status doc, PRD>`. They describe what the project believes about itself. Your job
> includes checking whether that is true.
>
> Acceptance rubric — output violating it is rejected: `<paste the seven rules>`
>
> Return: `<the schema>`. Your final text is the return value, not a message to
> a human — no preamble, no summary of what you did.
>
> Do not fix anything. Do not install anything. Do not delete anything.

---

### Two rules the template carries that are easy to leave out

Both were observed failing on 2026-08-21, the first time this fan-out ran:

- **The budget must be stated IN THE WORKER PROMPT, not just in this file.**
  A worker given five methods and no budget line spawned six delegates of its
  own, taking a five-worker audit to eleven agents. The worker never saw this
  file. A constraint that lives only in the orchestrator's reference is not a
  constraint on the worker.
- **Findings cannot be persisted to a file at all, and telling a worker to try
  wastes its turn.** The harness refuses report-shaped writes from subagents
  ("Subagents should return findings as text, not write report files"). Two
  workers hit it independently. One of them, having also spawned six delegates,
  returned a bare status message with nothing recoverable behind it — ten of
  the twelve files in its shard ended at zero coverage. **Chunked returns are
  the only persistence that survives an interruption here.**

Both are the same underlying error: assuming a worker inherits the
orchestrator's context. It does not. Anything that must bind the worker goes in
the worker's prompt, verbatim.

## Cost accounting

Report, per `reporting.md` section 9: workers spawned (and their delegates),
tool calls, subagent tokens, wall clock. The 2026-08-20 run's line — *"3
auditors (2 with their own delegates), 208 tool calls, ~796K subagent tokens,
~35 min wall clock"* — is the format. It is what makes "was this worth it"
answerable next time instead of a feeling.
