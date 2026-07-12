---
name: research-brief
description: Deep research on a technical or market topic producing a structured, sourced brief saved to the project's docs. Use when the user says "research X", "deep dive into X", "do research into X and propose candidates", or asks for analysis of an architecture, paper, strategy, or market event. Not for quick factual questions.
---

# Research Brief

Structured deep research with sources, skepticism, and a saved artifact —
instead of a one-off chat answer that evaporates.

## Trigger
`/research-brief <topic>`, or the user says "research X", "deep dive into X",
"analyze what happened [in the market / to this stock]", "propose top N
candidates for X".

## Inputs
- Topic, plus any constraints (time budget, number of candidates, decision it
  feeds into).
- Where to save: default `docs/research/<date>_<slug>.md` in the current
  project; if no docs/ exists, ask.

## Steps
1. **Frame it.** One sentence: what question is this brief answering, and
   what decision does it feed? If the topic is a proposal the user wrote,
   analyze it from multiple genuinely different angles (optimistic,
   pessimistic, different approach directions) — no yes-man convergence.
2. **Search wide, then deep.** Web search for primary sources (papers, docs,
   filings, data) over blog rehashes. For market questions, get actual
   numbers (prices, dates, magnitudes), not narratives.
3. **Cross-check.** Any load-bearing claim needs 2+ independent sources or an
   explicit "single-source, unverified" tag. Never present a guess as a fact
   — this feeds real decisions with real consequences.
4. **Synthesize.** Write the brief:
   - **TL;DR** (3-5 sentences, verdict first).
   - **Findings** (organized by theme, each with inline source links).
   - **Candidates/options ranked** (if the ask was "propose top N") with a
     one-line tradeoff each.
   - **What would change this conclusion** (falsifiers, open questions).
   - **Sources** (full list, dated).
5. **Save it** to the docs path with today's absolute date, and add one line
   to the project record if the project keeps one.
6. **For long runs**: if research will take >15 minutes, spawn background
   research agents in parallel by sub-topic, then compile when all report in.

## Output
- The saved brief file, plus the TL;DR and ranked candidates inline in chat.

## Rules
- DO NOT MAKE ANYTHING UP. Missing data is reported as missing.
- Prefer primary sources; date every source (staleness matters in markets).
- Keep the chat response short — the file is the deliverable.
