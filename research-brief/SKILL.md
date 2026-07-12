---
name: research-brief
description: Deep research on a technical or market topic producing a structured, sourced brief saved to the project's docs. Use when the user says "research X", "deep dive into X", "do research into X and propose candidates", or asks for analysis of an architecture, paper, strategy, or market event. Not for quick factual questions.
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

**9. Findings.** State findings distinct from interpretation. If the ask was
"propose top N", rank candidates with a one-line tradeoff each.

**10. Report.** Write and save the brief:
- **Header** — title, absolute date, the question, who it's for (stage 5).
- **TL;DR** (3–5 sentences, verdict first — which hypothesis won).
- **Method** (2–3 lines: the stage-4 design, source types used, limitations
  including any primary-data gap from stages 6–7).
- **Findings** (organized by theme, each with inline source links).
- **Candidates/options ranked** (if asked) with a one-line tradeoff each.
- **What would change this conclusion** (untested stage-3 falsifiers, open
  questions).
- **Sources** (full list, dated).

Save to the docs path with today's absolute date, and add one line to the
project record if the project keeps one.

**Long runs**: if research will take >15 minutes, spawn background research
agents in parallel by sub-topic (split along stage-4 lines — by hypothesis or
theme), then compile when all report in.

## Output
- The saved brief file, plus the TL;DR and ranked candidates inline in chat.

## Rules
- DO NOT MAKE ANYTHING UP. Missing data is reported as missing; unrunnable
  methods (surveys, interviews, experiments) are reported as limitations, not
  simulated.
- Prefer primary sources; date every source (staleness matters).
- Hypotheses come before deep collection — never retrofit them to findings.
- Keep the chat response short — the file is the deliverable.
