---
name: llm-eval-harness
description: >-
  Measures how far a cheaper model falls from the Fable-5 quality bar on real
  task types — deterministic CHECKS (format, discipline, no-fabrication,
  surgical scope) plus line-similarity to captured Fable goldens; appends
  every run to a ratchet so the gap is trackable over time. No API key, no
  LLM-judge. Use when: "eval the model", "measure the Fable gap", "run the
  eval harness", "score this output", or deciding whether a cheaper model is
  good enough to switch to.
---

# llm-eval-harness — is the cheaper model good enough yet?

Deterministic only. No model is called by the harness (it assumes no in-session
API key); the model produces outputs by *being run on the task prompts*, and
`score.js` grades them against fixed criteria. A non-reproducible LLM-judge is
deliberately excluded — it would be invented data.

## Files
- `tasks.json` — the eval task set (examples included; replace with your own).
  Two scoring methods:
  - **checks** — deterministic assertions on the output; needs NO golden, scores
    any model immediately (format conformance, no-fabrication, surgical scope…).
  - **golden** — line-similarity to a captured flagship reference; needs a capture.
- `score.js` — `node score.js <taskId> <candidateFile> --model <name>`; prints
  the score and appends a line to `ratchet.jsonl`. `--dry` scores without
  appending (for testing checks/fixtures). `node score.js --summary` reads the
  ratchet and prints per-(model, task) n / median / min / max — judge from
  medians of ≥3 samples, not single runs.
- `goldens/` — reference outputs, named `<taskId>.<model>.md`.
- `candidates/` — a model's answers to score.
- `ratchet.jsonl` — the tracked series `{date, model, task, method, score}`.

## Capture the flagship goldens (do while the flagship model is available)
The `golden` tasks need the flagship model's own output as the reference. This
MUST be produced by the flagship model itself — don't let a weaker model stand
in (that fabricates the bar).
1. Switch to your flagship model.
2. For each `golden` task in `tasks.json`, answer its `prompt` and save the
   answer verbatim to `goldens/<taskId>.<flagship>.md` (matching the task's
   `refModel`).
3. Commit the goldens. They are the frozen quality bar; if you later lose access
   to the flagship model, they are unrecoverable.

## Score a candidate model
1. Under the model being evaluated, answer each task's `prompt`; save each to
   `candidates/<taskId>.<model>.md`.
2. `node score.js <taskId> candidates/<taskId>.<model>.md --model <model>` for
   each. `checks` tasks score with no golden; `golden` tasks need the capture.
3. Read the trend: `ratchet.jsonl` accumulates every run — the flagship→cheaper
   gap (and whether prompt/skill changes close it) is the series over time.

## Honest limits
- `checks` measure conformance/discipline, not full quality — they catch common
  cheap-model failure modes (fabrication, scope creep, format drift, injection
  obedience, precedence errors), not everything. A perfect checks score means
  baseline discipline, NOT model parity (score.js says so on every 1.000).
- `golden` similarity is word-level; it rewards matching the reference's
  structure, so keep golden tasks structural (summaries, formatted entries), not
  open-ended prose.
- Scores are only as representative as the task set — grow `tasks.json` from real
  failures you observe, not hypotheticals.
- **Contamination rules:** goldens and candidates must come from sessions that
  never saw each other's outputs; and never log a baseline for a model on checks
  that were AUTHORED in the same session (teaching-to-the-test) — capture in a
  fresh session. Use `--dry` for mechanics testing so fixtures never pollute the
  ratchet.
- Single samples are anecdotes: capture ≥3 samples per (model, task) where
  feasible and read `--summary` medians.

## ASCII-only markdown (rule added 2026-09-23)

Every `.md` file this skill creates or writes to gets ASCII characters only
(bytes 0x00-0x7F) in the text you add. No exceptions for headings, tables,
quotes, names or pasted tool output.

- Dashes: `-` (never an en or em dash). Arrows: `->` and `<-`. Quotes:
  straight `"` and `'`. Ellipsis: `...`. Math: `x`, `+/-`, `<=`, `>=`, `~`.
  Separators: `-`, `;` or `|`. No emoji, no check-mark glyphs (use `[x]` and
  `[ ]`), no accented letters: transliterate names and quoted text.
- Check before saving. In a git repo,
  `git diff -U0 -- <file> | grep -v '^+++' | grep '^+' | grep -nP '[^\x00-\x7F]'`
  must print nothing. For a new or untracked file,
  `grep -nP '[^\x00-\x7F]' <file>` must print nothing.
- Leave non-ASCII in text you did not write. Earlier entries of an
  append-only record stay byte for byte; converting an existing file is a
  separate, explicit job.
