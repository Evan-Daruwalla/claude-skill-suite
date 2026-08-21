# Docs method sweep — D1–D8

Read by `audit`, `audit-docs`, `audit-recent`, `audit-docs-recent`. The scope
differs between those four; the methods do not.

**Docs are audited the way code is audited: for defects, against evidence.**
This is not a content inventory, not a style pass, and not a tidy-up. A finding
here has a file:line and a command that proves it, exactly as in
`code-methods.md`.

**Report using `reporting.md`. Resolve scope using `scoping.md`. Spawn workers
using `fanout.md`.**

---

## Why this sweep exists — measured, not assumed

In the 2026-08-15 cold audit of one project, docs were only a *secondary* lens,
and roughly **six of about thirty-five findings were still doc-vs-reality
drift**:

- "One executing file gates all 7 repos" was FALSE — 8 repos had a hook, only 3
  delegated.
- A fix landed in the public mirror only; the installed and lab wording stayed
  false.
- A hook cited a `SKILL.md` that exists nowhere — a dead pointer inside text
  handed to a model, the one audience guaranteed to go and open it. Found in
  one audit, fixed five days later; a document written after the fix still
  described it as open, and the next sweep caught that.
- The public mirror said "16 rules" and shipped 17.
- a status doc's live block was stale in three places.
- A `dependencies.md` claimed zero dependencies; one bundled tool depended
  on a vendored npm package.

Every one of those is a **false statement the user would have relied on**. None
required reading a line of application logic. That is the yield this sweep is
after.

---

## What to hunt, in priority order

The literature is unusually clear about this, and it contradicts what a doc
review instinctively does.

**Practitioners rank content correctness far above presentation.** Aghajani et
al. (ICSE 2020, 146 practitioners) measured which documentation issues actually
matter:

| Issue | Rated important |
|---|---|
| Clarity | 88% |
| Installation / deployment / release completeness | 68% |
| Missing docs for a new feature or component | 69% |
| Inappropriate installation instructions · faulty tutorial | 65% |
| Code-documentation inconsistency | 59% |
| **Wrong** code comments | 49% |
| **Missing** code comments | **28%** |

Two things follow. **A wrong comment is worth roughly twice a missing one** —
so do not spend the sweep counting undocumented functions. And only 7 of 23
content issues were rated important by a majority at all: the taxonomy is broad,
the important subset is small. Uddin & Robillard (IEEE Software 2015, 323 IBM
professionals) found the same shape from the other side — their three severest
API doc problems were **ambiguity, incompleteness, incorrectness**, all content;
their presentation problems ("tangled information", "excess structural
information") were *never once* chosen as anyone's top priority.

**So: hunt WRONG first, MISSING second, UGLY last — and be willing to report
that you did not look hard at UGLY.**

---

## The anti-heuristic: file age does NOT mean stale

**Do not flag a document as outdated because it has not been edited recently.**
This is the obvious heuristic, it is the one every doc-audit tool reaches for,
and it has been measured and found useless.

Tang et al., "Detecting Outdated Screenshot from GUI Document" (ACM TOSEM,
2024) tested exactly this. Using the median 297-day interval between
screenshot-fixing commits as a staleness threshold, **70.3% of all screenshots
were flagged as outdated. Manual inspection of a 154-screenshot sample found 8
genuinely were.** Their verbatim conclusion: *"It is infeasible to use a simple
time interval threshold to accurately determine whether screenshots are
outdated."*

A stale-looking date is a reason to **check**, never a finding on its own. The
finding is the contradiction you then demonstrate. A document that has been
correct and untouched for two years is not a defect.

---

## Cost order

Mechanical and cheap first; they aim the expensive reading.

**D2 → D6 → D1 → D5 → D3 → D4 → D8 → D7**

---

## Step 0 — Automated docs pass first

Run what is already installed before reading anything. **Do not install new
tooling without asking.** Where a tool is absent, say so — the honest floor
(`grep`, a link walk, a manifest diff) still finds real defects, and claiming
tool coverage you did not have is the failure this file exists to prevent.

| Check | Tool |
|---|---|
| Broken internal/external links, dead anchors | `markdown-link-check`, `mlc`, `linkinator` |
| Prose rules — banned words, passive voice, non-inclusive terms; importable Google and Microsoft style packs | Vale |
| Grammar and natural-language rules | textlint |
| reStructuredText defects, long lines, trailing whitespace, non-Unix line endings, missing final newline | doc8 |
| **Documented output versus actual execution output** | Python `doctest`, `sphinx.ext.doctest` |
| Docstring coverage percentage with a pass/fail threshold | `interrogate` (Python) |
| Public-API doc coverage with defined exclusion rules | `rustdoc --show-coverage` |
| Build fails on a broken internal reference | MkDocs `--strict` |

`doctest` deserves emphasis: it is the only tool in the list that catches a
**wrong** documented result rather than a missing or ugly one, which is the
class the evidence says matters most.

**Tool output is evidence — record the command and the version.** A clean Vale
run says nothing about whether the docs are true; say that plainly rather than
letting a green tool pass for a clean audit.

---

## Standing on: what the field actually offers

Worth knowing, because it explains why this sweep is constructed rather than
adopted. A search pass on 2026-08-21 looked for a rigorous documentation-audit
standard comparable to secure-code-review practice and **did not find one.**

- **ISO/IEC/IEEE 26513** is titled and scoped as an audit standard — "testers
  and reviewers" — but is paywalled, so no concrete check could be confirmed.
  Its siblings 26511, 26512, 26514 and 26515 are management, procurement and
  authoring standards, not audit procedures.
- **IEEE 1028** (inactive since 2019) is the closest legitimising precedent: it
  explicitly scopes *documents* as auditable products, with defined auditor
  roles. It establishes that this is a real activity; it does not tell you what
  to check.
- **ISO/IEC 25010** is a software-product quality model and was **not** found
  applied to documentation anywhere.
- **S1000D** is the one place with real machinery — BREX business-rule
  validation, plus an explicit per-module **verified / unverified QA status
  field**. That is independent confirmation of the verification tiers in
  `reporting.md`: a mature documentation standard also refuses to let "checked"
  and "assumed" share a label.
- **Content-audit practice** (inventory versus audit, ROT triage —
  Redundant/Outdated/Trivial, Slater's five questions) is well established but
  entirely secondary-sourced, and it is *triage*, not defect-finding.
- **Google's developer style guide explicitly is not an audit checklist.**
  Microsoft does publish real public checklists. Write the Docs: zero hits.

So the D-series below is built from empirical defect taxonomies plus the
measured local yield, and is honest about being a local convention.

---

## D1 — Claim verification *(the flagship; highest measured yield here)*

Every **factual, checkable claim** the docs make, tested against disk.

Build the claim inventory first — this same inventory is a required input to
`code-methods.md` M1 and M7, which is why the docs sweep runs before the code
sweep in a combined audit.

Harvest, then verify, every:

- **Count or number.** "16 rules", "7 repos", "zero dependencies", "25 skills",
  "73 appendices". These are the single richest vein: they are unambiguous,
  they are checkable in one command, and they rot silently as the thing they
  count changes. **Every number in a doc is a claim under test.**
- **Existence claim.** "ships a SKILL.md", "the hook is registered", "this file
  reads that scanner", "there is a fixture for this".
- **Behavioural claim.** "the gate blocks X", "this runs on every commit",
  "the script refuses when given no value".
- **Structural claim.** "all N copies are identical", "every repo delegates to
  one scanner", "the record is append-only and letters are unique".
- **Status claim.** "this is committed and pushed", "this task is done",
  "resolved 2026-08-11".

For each: **name the command that decides it, run it, paste the output.** A
claim you did not test is not swept — record it as such rather than assuming it
holds.

**Weight by blast radius, not by prominence.** A wrong number in a live status doc that
the user quotes into decisions outranks a wrong number in an old record entry
nobody reads. But note that per the append-only rule, a wrong number in the
record is corrected *forward* with a dated note — never edited in place.

## D2 — Code-element reference drift *(mechanical, run first)*

The DOCER technique (Tan, Wagner & Treude, arXiv:2307.04291): extract every
**code-element reference** from the docs — function names, class names, file
paths, flags, config keys, CLI invocations — and check each still exists in the
code.

Their measured hit rate: **28.9% of the top 1,000 most-starred GitHub projects
had at least one outdated code-element reference.** Roughly one project in
three. This is the cheapest real finding available in any doc set.

Mechanically: for each referenced identifier, `grep` the codebase. Present in an
older snapshot and absent now is drift. Practically, absent now is enough to
open the question.

**Known limits, stated by the technique's own authors:** it catches
*reference/existence* drift only — not "the description of what this function
does is wrong". That is D3's job. It also false-positives on identifiers that
are generic English words, on references to *other* projects' APIs, and on
planned-but-unbuilt names. Confirm each hit before reporting it.

Extend the same pass to: documented **file paths** that no longer exist,
documented **CLI flags** the parser does not accept, documented **config keys**
nothing reads, and documented **env vars** nothing consumes.

## D3 — Doc-vs-code semantic conformance

D2 asks "does this name still exist". D3 asks **"is what the doc says about it
true"** — the class D2's authors explicitly place out of scope.

- **Signatures**: documented parameters, order, types, defaults, return values
  versus the actual definition.
- **Error behaviour**: the doc says it raises on null, returns `None` on
  missing, exits non-zero on mismatch — does it? This is the `@tComment`
  technique (Tan et al., ICST 2012): treat a documented `@throws`/`@param`
  constraint as a test and check the code honours it.
- **Names as specification**: a function called `get_adjusted_price` that
  returns raw prices is a doc defect even with no prose attached. Names are
  documentation, and they are the documentation people trust most.
- **Directive defects** (the DRONE class): documented constraints — "must be
  called after init", "path must be absolute", "not thread-safe" — with nothing
  enforcing them. Mirror `code-methods.md` M1's three verdicts here: HONORED /
  VIOLATED / **UNENFORCEABLE**. An unenforceable documented constraint is a
  finding.

## D4 — Completeness against the real surface

Not "is everything documented" — that question produces a long, low-value list
(missing comments: 28% importance). Ask instead: **what is missing that
somebody would go looking for?**

- **Public surface versus documented surface.** Enumerate exported symbols,
  CLI commands, flags, endpoints, env vars; diff against what the docs cover.
  Report the *undocumented public* set, not every private helper. Filter by
  header or public-API surface first — Zaki & Cadar (EASE 2025) show that
  naive exported-symbol diffing false-positives heavily on internal-only
  exports.
- **Installation, deployment and release** specifically — rated important by
  68% and 65%, the highest-scoring completeness categories in the literature,
  and the ones a new reader hits first.
- **New features with no doc** — 69% importance. Cross-reference recent commits
  against doc changes. In a `-recent` audit this is the primary D4 check.
- **The missing document type.** Prana et al. (EMSE 2019, 4,226 README sections
  from 393 repos) found READMEs commonly cover *what* and *how* while
  frequently lacking **purpose and status**. Check for that specific gap; it is
  the empirically common one.

## D5 — Internal consistency and contradiction

Two documents that disagree. Neither is wrong on its own, so no single-document
review finds this — it is the docs analogue of `code-methods.md` M1, and it is
the same worst-bug-class argument: both sides look correct in isolation.

- The same number stated differently in two places.
- **Copy divergence** — the project keeps installed / lab / public copies of most
  skills. A fix landing in one copy only is a *known, repeated* failure here;
  diff the copies rather than reading one.
- Version numbers drifting between README, manifest, changelog and tag.
- A doc contradicting a *newer* doc without either being marked superseded.
- **Sequencing**: check every layer — live snapshot, PRD, record, docstring —
  before concluding which one drifted. Reporting the correct one as wrong is a
  real and embarrassing failure mode.

Precedence when they conflict, per a typical project's rules: the user's live instruction beats the
project's agent-instruction file, which beats the roadmap, which beats the
live-status snapshot; and for historical fact an append-only record beats every
snapshot.

## D6 — Executable content *(mechanical, run early)*

Anything in the docs a reader would **run or click** — test it rather than read
it.

- **Code samples**: do they parse, import, and run? A sample using a removed
  parameter is a wrong answer handed to someone who trusted it.
- **Install and setup commands**: highest-importance completeness category in
  the literature. Run them, or state plainly that you did not and why.
- **Internal links and anchors**: every one resolves. Where a document carries a table of contents with per-section anchors,
  "73/73 anchors resolve" is exactly the right form of evidence.
- **External links**: check them, but rank low and expect noise. Note honestly
  that no study of link rot *within software documentation specifically* was
  found — general web link-rot figures do not transfer cleanly, so do not quote
  one as if it did.
- **Screenshots and diagrams**: do they show UI that still exists? Real
  technique, real yield — but see the anti-heuristic above: age is not evidence.

## D7 — Structure and navigability *(rank low; report briefly)*

Orphaned pages nothing links to, fragmentation (one topic scattered across many
places), bloat, tangled information, missing entry point.

One structured check is worth running here, because it is cheap and
diagnostic rather than aesthetic: the **Diataxis compass** classifies each
document by its actual mode — tutorial, how-to, reference, explanation — and
asks whether that matches its intended mode. A reference page written as a
tutorial is a real navigability defect with a concrete fix. Readability scores
(Flesch-Kincaid, the one genuinely quantitative formula here) may be reported
as context, never as a finding on their own.

**Deliberately last and deliberately brief.** These are Uddin & Robillard's
"presentation" problems — the ones no practitioner in a 254-person survey ever
ranked as their top priority. Report them as a short list, do not expand each
into a finding record, and never let this section pad a thin audit into a
full-looking one.

## D8 — Provenance and currency

Whether the docs can be trusted as a *record*, distinct from whether they are
correct today.

- **Dates**: absolute, not relative. "Last week" in a permanent document is a
  defect. Undated claims that are inherently time-sensitive are defects.
- **Timezone labelling** is derived from the real reported UTC offset, not
  hardcoded.
- **Append-only integrity** where the project uses an append-only record:
  entries unique, ordered, contiguous, never edited in place. A prior audit's
  check — "73 appendices, letters unique and ordered, TOC balanced and
  contiguous, 0 CRLF, 73/73 anchors resolve, broken: 0" — is the model.
- **Superseded content is marked superseded**, not silently deleted. A dated
  strikethrough is correct; a vanished line is a lost decision.
- **Invented data.** The gravest doc defect class: a number, a date, a
  measurement, or a result that was never measured. Where a doc states a figure,
  D1 tests it — but also ask whether it was *ever* derivable. A statistic with
  no possible source is worse than a wrong one, because nothing will ever
  correct it.

---

## Verdicts and evidence

Same bar as the code sweep. Every finding carries:

- **file:line** in the doc, and the **command** that proves the contradiction;
- the **claim as written**, quoted, versus **what disk says**;
- a **surgical fix** — the specific edit, not "update the docs".

Verification tiers from `reporting.md` apply unchanged: CONFIRMED means you ran
the command; REPORTED means you read it and inferred; CONSTRUCTED means you can
name what would make it wrong.

**A doc finding is not softer than a code finding.** "One executing file gates
all 7 repos" was a false sentence that had been load-bearing for six days.
Grade doc findings by what a reader would do wrong having believed them.

---

## Honest gap in the evidence base

A specific search on 2026-08-21 for adversarial critiques — arguments that
documentation audits are low-value theatre, that content inventories go stale,
that this is a checkbox exercise — **found nothing.** The literature is
uniformly pro-audit, which is itself weak evidence: no published counter-case
means this sweep's value rests on the local measured yield above, not on an
adversarially-tested consensus. Treat the priority ordering as the best current
guess rather than settled fact, and revise it against what this sweep actually
finds.
