---
name: research-brief
description: Deep research on a technical or market topic producing a structured, sourced brief saved to the project's docs. Depth means verifiability, not length — citations re-fetched, negatives cross-checked, blind spots hunted by a fresh agent. Use when the user says "research X", "deep dive into X", "do research into X and propose candidates", or asks for analysis of an architecture, paper, strategy, or market event. Not for quick factual questions.
---

# Research Brief

Structured deep research with sources, skepticism, and a saved artifact —
instead of a one-off chat answer that evaporates. Runs a 10-stage research
process adapted for desk research: an LLM can search, read, and analyze; it
cannot run surveys or interviews — stages needing new field data are scoped
honestly as limitations, never simulated.

## Trigger
`/research-brief <topic>`, or the user says "research X", "deep dive into X",
"analyze what happened [in the market / to this stock]", "propose top N
candidates for X".

## Inputs
- Topic, plus any constraints (time budget, number of candidates, decision it
  feeds into).
- Where to save: default `docs/research/<date>_<slug>.md` in the current
  project; if no docs/ exists, ask.

## The 10 stages

**1. Identify the problem.** One sentence: what question is this brief
answering, and what practical problem makes it worth answering? If the topic
is a proposal the user wrote, analyze it from multiple genuinely different
angles (optimistic, pessimistic, different approach directions) — no yes-man
convergence.

**2. Survey existing work.** Before forming any view, check what already
exists: prior project docs/briefs, published papers and peer-reviewed
literature, authoritative primary docs. The gap between what's already
answered and what isn't IS the research problem — restate stage 1 if the
survey shifts it.

**3. State hypotheses.** Write the expected answer as a falsifiable working
hypothesis, plus at least one rival (or null) hypothesis. Do this BEFORE deep
collection — it is the anti-confirmation-bias gate: you now know in advance
what evidence would count against you.

**4. Design the research.** Plan before collecting: which source types
(primary — papers, filings, official docs, datasets — vs. secondary
commentary), what analysis (comparison table, quantitative check, timeline),
and what evidence would confirm or refute each stage-3 hypothesis.

**5. Name the audience.** Who reads this brief, and what decision do they
make with it? Depth, jargon level, and ranking criteria all follow from this.

**6–7. Choose methods, then collect.** Web-search wide then deep per the
stage-4 design, favoring primary sources over blog rehashes; get actual
numbers (prices, dates, magnitudes), not narratives. If the question
genuinely requires NEW primary data — a survey, interviews, an experiment —
say so: scope it as a limitation naming the method a human would use. Never
fabricate respondents, quotes, or results.

**8. Analyze.** Separate analysis from collection. Any load-bearing claim
needs 2+ independent sources or an explicit "single-source, unverified" tag.
Test each hypothesis against the evidence; say which survived and which died.

**8.5. VERIFY — the mechanism, not a promise.** Stages 1–8 are judgment: a
model can satisfy all of them and still produce a confident wrong brief,
because nothing in them can fail. This stage can fail. It produces two
artifacts that ship WITH the brief.

First name the **load-bearing claims**: the ones the verdict rests on. If a
claim were false, would the TL;DR change? If no, it is not load-bearing and
does not need this treatment. Usually 3–8 of them.

- **Re-fetch every load-bearing citation, by a different call than the one
  that found it** — a second `WebFetch` against the URL, asking whether the
  specific claim is present. Mark each **VERIFIED-VERBATIM** (the source
  states it), **CLOSE-PARAPHRASE** (states it in other words),
  **NOT-FOUND** (page loads, claim absent — the dangerous one), or
  **UNREACHABLE**. A NOT-FOUND on a load-bearing claim kills the claim, not
  the source's other uses. Never mark a citation verified because it *sounds*
  like what the source said.
- **Numbers register.** Every quantitative claim in one table: number ·
  what it claims · source · date · **source-interest class** (INDEPENDENT /
  VENDOR-SELF-REPORTED / ADVERSARIAL / UNVERIFIABLE) · verification verdict.
  A vendor's number about its own product is evidence, and it is *interested*
  evidence; the register makes that visible instead of leaving it to prose.
- **Two structural checks that catch what per-claim checking cannot:**
  1. **Same-source dependency.** Do the headline finding and its main
     counterweight come from the SAME study or author? If so they rise and
     fall together, and the brief must say so — a pro and a con from one
     source is one data point wearing two hats.
  2. **Interest concentration.** If more than half the load-bearing numbers
     are VENDOR-SELF-REPORTED, that belongs in the TL;DR, not a footnote.
- **Zero-result cross-check.** "No such study exists" is the highest-value
  finding a brief can make and the easiest to fake with one bad query. Re-run
  every load-bearing negative a SECOND way (different phrasing, different
  tool, a citation-chain walk from the nearest real paper) before writing it
  down. Report which searches produced the negative.

**9. Findings.** State findings distinct from interpretation. If the ask was
"propose top N", rank candidates with a one-line tradeoff each.

**10. Report.** Write and save the brief:
- **Header** — title, absolute date, the question, who it's for (stage 5).
- **TL;DR** (3–5 sentences, verdict first — which hypothesis won).
- **Method** (2–3 lines: the stage-4 design, source types used, limitations
  including any primary-data gap from stages 6–7), plus the **effect log**
  from stage 10.6.
- **Findings** (organized by theme, each with inline source links).
- **Candidates/options ranked** (if asked) with a one-line tradeoff each.
- **Verification table** (stage 8.5): load-bearing claim · source · verdict.
- **Numbers register** (stage 8.5), with source-interest class per row.
- **Thin / missing** — what SHOULD exist and does not: the modality nobody
  ran, the study nobody published, the number nobody reports. Name the
  searches that produced each negative. This section is usually the most
  valuable thing in a real brief and the first thing a shallow one omits.
- **What would change this conclusion** (untested stage-3 falsifiers, open
  questions).
- **Sources** (full list, dated).

**10.5. COLD ASSESSMENT — someone who didn't write it reads it.** The author
of a brief cannot see the shape of its own blind spot; that is what a blind
spot is. Spawn a FRESH agent (Agent tool, general-purpose) and hand it ONLY:
the draft brief, the stage-3 hypotheses, and the stage-8.5 artifacts.

**Do NOT hand it** the collection transcript, which sources were already
dismissed, or any account of how hard something was to find. It must be able
to say "you never looked" without being told you did.

Ask it exactly these, because they are the questions that catch real briefs:

1. Which two claims that look independent actually rest on the same source?
2. What is the source-interest concentration, and is it disclosed up front?
3. Which stage-3 hypothesis was never given a genuine chance to die — where
   was the evidence that *would* have killed it never sought?
4. Which of the source types the design named was never actually run?
5. What would a domain expert say is obviously missing?
6. Which claim is stated with more confidence than its verification verdict
   supports?

Its findings feed **exactly one** more collection round, then stop. Unbounded
assessor loops are how a brief eats a session. If it finds nothing, say so —
that is a real result about the brief, not a wasted pass.

**10.6. EFFECT LOG — the data that decides whether these stages stay.** Stages
8.5 and 10.5 cost real tokens. Whether they earn it is an empirical question
nobody has answered, so answer it locally. Append to the brief, under Method:

```
Phase effects (2026-08-15):
  8.5 verify   — <flipped a verdict | downgraded N claims | added a
                  limitation | caught a NOT-FOUND | no change>
  10.5 assess  — <same vocabulary>
```

Be strict about "no change" — a stage that reliably reports no change across
several briefs is cost without evidence and should be cut, and that finding is
worth as much as the stages themselves. Do NOT inflate an effect to justify a
stage.

Save to the docs path with today's absolute date, and add one line to the
project record if the project keeps one.

**Long runs**: if research will take >15 minutes, spawn background research
agents in parallel by sub-topic (split along stage-4 lines — by hypothesis or
theme), then compile when all report in (this matches the existing
pre-market-report pipeline pattern).

## Output
- The saved brief file, plus the TL;DR and ranked candidates inline in chat.

## Rules
- DO NOT MAKE ANYTHING UP. Missing data is reported as missing; unrunnable
  methods (surveys, interviews, experiments) are reported as limitations, not
  simulated.
- Prefer primary sources; date every source (staleness matters in markets).
- Hypotheses come before deep collection — never retrofit them to findings.
- Keep the chat response short — the file is the deliverable.
- **A citation is not verified because it is plausible.** Only a re-fetch that
  finds the claim on the page verifies it. "It's the kind of thing that source
  would say" is how a fabricated citation survives review.
- **A statistic from a live, growing corpus is a reading, not a constant** —
  pin its state (a count and a timestamp) beside the number, or quote the
  invariant instead of the aggregate.
- **Depth is verifiability, not length.** A longer brief with unverified
  claims is worse than a short one with a big Thin/missing section, because
  length reads as diligence. If stages 8.5 and 10.5 were skipped, the brief
  must say so in Method — a brief that silently skipped its own checks is the
  exact failure this skill exists to prevent.
