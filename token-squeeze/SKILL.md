---
name: token-squeeze
description: >
  Deterministic, no-LLM compressor that rewrites verbose English into fewer tokens for text
  that will be REUSED — saved prompts, system prompts, skill bodies, docs pasted repeatedly.
  Use when the user asks to "compress this file/prompt/doc for reuse", "shrink this system
  prompt", "run token-squeeze", or wants to cut the token cost of a reusable text asset. Runs a
  bundled Node CLI (no API, no model call). NOT for compressing live chat turns — those tokens
  are already spent on arrival; this only pays when the compressed text replaces the original in
  future contexts. Meaning-leaning, not lossless: it substitutes verbose phrases for equivalents
  and protects code, URLs, paths, quotes, numbers, and negations.
---

This skill wraps a deterministic CLI. It does NOT ask you to compress text by hand — invoke the tool so results are reproducible and guard-checked.

WHEN IT PAYS (state this if the user aims it at live chat). Compressing text already in the context window saves nothing — those tokens were billed on arrival. token-squeeze only nets tokens when its output is reused: a saved prompt, a system prompt, a skill body, a doc pasted across many sessions. For a one-off message, skip it.

RUN IT. From the skill directory: `npm install` once (pulls gpt-tokenizer), then:
- `node cli.js <file>` — compressed text to stdout.
- `node cli.js <file> --stats` — adds a token-before/after + guard line on stderr.
- `node cli.js <file> --json` — structured {tokensBefore, tokensAfter, savedPct, subs, guard}.
- `node cli.js - --stats` — read from stdin.
- add `--clean` only for text carrying junk whitespace (pasted logs, tables); it's off by default because it saves ~0% on normal prose.
Exit code is non-zero if the guard trips, so it's safe to script.

WHAT IT DOES. Layer B (default): token-aware dictionary substitution — "in order to"->"to", "due to the fact that"->"because", "utilize"->"use", plus deletion of pure filler. Each dictionary entry is self-filtered at load against the tokenizer and dropped unless it strictly reduces tokens, so a bad entry can't make output worse. Layer A (`--clean`, opt-in): lossless whitespace reclamation.

GUARANTEES AND LIMITS (report honestly, don't oversell).
- Measured on the bundled corpus: ~24% overall, 34-42% on verbose prose, 13-16% on technical text, 0% on already-tight prompts (a tight prompt returns byte-identical). Run `node test.js` to reproduce.
- Protected spans are never altered: fenced/inline code, URLs, Windows paths, double-quoted strings, dotted identifiers (auth.js, example.com, decimals). A four-way guard (numbers, NOT/NEVER/MUST, dotted identifiers, protected spans) verifies every run and fails loudly.
- Token counts use the o200k (tiktoken) tokenizer as a PROXY for Claude's tokenizer, which Anthropic does not publish. Real Claude savings will be close but not identical. For exact numbers, count via the Anthropic count-tokens API (needs an API key).
- Meaning-leaning, not string-lossless: substitutions preserve propositional content but change wording; emphasis from deleted filler is lost by design. Do not use where exact wording is contractual (legal text, quoted material) — those cases are protected only if quoted.

After running, show the user the savedPct and the guard result; if the guard fails, surface it rather than returning the output silently.
