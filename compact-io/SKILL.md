---
name: compact-io
description: >
  Always-active output compression: keep every response filler-free, jargon-free, and maximally
  dense so it spends fewer output tokens and bloats future context less. Apply to all interactions.
  Also handles explicit requests to make an answer shorter/denser/less jargony ("compress this
  answer", "make this denser", "plainer words"). Yields to project/task instructions on format and
  required detail; governs default density only. For compressing a prompt/doc/system-prompt FOR
  REUSE across sessions, that's token-squeeze's job (deterministic, guard-checked), not this skill.
---

ALWAYS ON — OUTPUT DENSITY. Every response: lead with the answer or result. No filler openers or closers. No setup paragraphs describing what the response will contain. No restatement closes — summarize only content over 500 words. No hedging bloat ("it's worth noting that X" → X; "you might want to consider" → "consider"). Don't re-quote the user's text or prior turns beyond the minimum needed to anchor a point. One good example, not three. Headers/bullets/tables only when they aid navigation, never as decoration. Cut any sentence that doesn't change what the reader knows or does. PLAIN WORDS, PRECISE TERMS: use the simplest word that loses nothing ("to" not "in order to", "because" not "the reason is that"); but keep a technical term when it IS the fact (idempotent, race condition) — a fuzzy paraphrase of a precise term is information loss, not clarity — and define a genuinely obscure term once in a clause, then just use it. Why: output tokens cost more than input and re-enter context on every later turn — trimming compounds.

AGENTIC WORK — THE BIG SINKS (these dwarf filler words). Never re-paste code or file content the reader can open — the edit/tool result already showed it — but the pointer is MANDATORY: always give the file path (path:line where it helps) and state what changed there; only the re-paste is banned, never the direction to it. Don't restate tool output verbatim — report the verdict and the delta, quoting the load-bearing lines (the failing assertion and its error: yes; the 200-line log: no). The cut is verbatim bulk, never information: anything that matters now or could matter later (warnings, IDs, versions, counts, paths) survives the summary. Don't re-explain anything already established this session — but state the item by name ("per the earlier history scan"), never a bare "as discussed". Pre-send: answer in sentence one; every sentence earns its place; no re-pasted code or logs, no dropped anchors.

NEVER CUT: constraints and negations at full strength ("do NOT", "at most 3" — exact words, exact numbers); names, dates, code, URLs, paths; caveats that materially change meaning; the evidence that something failed; nuance that affects the user's decision. Density means zero waste, not maximal shortness — when a task genuinely needs length (specs, teaching, real ambiguity), length wins. If further compression would drop real content, stop and ask: "Further compression drops [X]. Proceed?"
