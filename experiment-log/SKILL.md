---
name: experiment-log
description: >
  Reproducibility provenance for a single run — runs a command and appends ONE
  JSON line capturing exactly what produced the result: ISO timestamp, cwd, cmd,
  exit code, duration, git {commit, dirty}, tool versions {node, python}, and the
  sha256 of every declared input (hashed before the run) and output (after), plus
  a note. Append-only JSONL; never rewrites the log. Use when the user says "log
  this run", "record provenance", "experiment log", "make this run reproducible",
  "what produced this output", "capture inputs/versions for this backtest", or
  wants a run pinned so it can be reproduced. Machine provenance only — it never
  touches HANDOFF.md or the project record (project-memory owns the narrative).
  Deterministic, zero dependencies, no model calls.
---

# experiment-log — reproducibility provenance for a run

The engine is `experiment-log.js` (portable Node, zero deps). One logged run
answers the question "what exact inputs, code, and versions produced this
result?" — it runs your command, then appends a single JSON line recording the
ISO timestamp, cwd, command, exit code, wall-clock duration, the cwd repo's git
commit + dirty flag, the `node`/`python` versions, and the sha256 of every input
file (hashed *before* the run) and output file (hashed *after*). The log is
append-only: it is never rewritten, so the provenance trail can't be silently
edited.

This is **machine provenance**, deliberately separate from the project's
narrative docs. It never writes to `HANDOFF.md` or the append-only record —
`project-memory` owns the story; this owns the reproducible facts of one run.

## Commands

```
node experiment-log.js log --cmd "<command>" [--in a,b] [--out c,d] [--note "..."] [--file <path>] [--no-run]
node experiment-log.js show [--file <path>]
node experiment-log.js --canary
```

- **log** hashes the `--in` files, captures git + tool versions, runs `--cmd`
  through the shell (stdout/stderr inherited so you see it live), records the
  exit code and duration, then hashes the `--out` files. Appends one JSON line.
- **log --no-run** records the same provenance without executing (exit code and
  duration are `null`) — useful to pin a manual or external run's inputs.
- **show** pretty-prints entries oldest-first (newest last), one block per run.
- `--in` / `--out` are comma-separated file lists. Default log file:
  `experiments.jsonl` in cwd. A missing input/output is recorded as `(absent)`,
  never faked.

### The case: a backtest with a frozen regression report

A frozen regression is pinned byte-exact — but a result is only reproducible if
you know the exact inputs and versions behind it. Log the run:

```
node experiment-log.js log \
  --cmd "python run_backtest.py --sleeve value --report" \
  --in price_cache.db,config/value.yaml \
  --out reports/value_report.txt \
  --note "monthly rebalance, value sleeve"
```

The line now carries the git commit (was the tree dirty?), the Python version,
the sha256 of `price_cache.db` and the config *as they were at run time*, and the
hash of the report it produced. Two runs with identical `--in` hashes, the same
commit, and the same Python version are expected to reproduce byte-for-byte — if
the report hash differs while all inputs match, that difference is real, not
environmental.

Other uses:

- **A migration or seed run** — pin the schema/seed file hashes and
  the git commit behind a data-loading run:
  `log --cmd "python -m app.seed" --in db/seed.sql --out db/snapshot.sql`.
- **Any ad-hoc script whose result you'll want to defend later** — log it once so
  the inputs, commit, and versions are on record instead of in your memory.

## Windows notes

- **PowerShell 5.1:** wrap the whole `--cmd` value in double quotes:
  `--cmd "python run_backtest.py --report"`. Comma-lists for `--in`/`--out` need
  no quoting unless a path contains spaces (then quote the whole list value).
- **Git Bash:** single quotes work for `--cmd`.
- Do NOT drive a run through `node -e "<quoted code>"` on this machine — PS 5.1
  mangles quoted `-e` and leaves 0-byte junk files. Point `--cmd` at a real
  script.
- `python` is resolved from PATH; if it isn't installed the `python` version is
  recorded as `null` (shown as `MISSING`) rather than guessed.

## Storage layout

```
experiments.jsonl   # one JSON object per line, append-only, oldest-first
```

Each line: `ts`, `cwd`, `cmd`, `exitCode` (null on --no-run), `durationMs`
(null on --no-run), `git` ({commit, dirty} or null outside a repo),
`versions` ({node, python}), `in` ({path: sha256|null}), `out` (same), `note`.
Commit the file if you want the provenance trail in version control.

`git.dirty` reflects the state of the *experiment's* tracked code, not the
logging artifact: the log file itself is excluded from the dirty check (via a
`:(exclude)` pathspec), so an untracked `experiments.jsonl` does not flip
`dirty` false→true on the second and later runs. Two runs at the same commit
with a clean tree therefore record the same `dirty` value.

## Exit codes

`0` ok · `1` nothing to show / canary failure · `2` usage error (e.g. missing
`--cmd`).

## Verification (the done-check)

```
node experiment-log.js --canary
```

Self-tests both directions in a throwaway temp dir: a successful run records
`exit 0`, a failing run records its non-zero code, `--no-run` records `null`; two
identical runs produce identical input/output hashes with every field present;
and the log is proven append-only (earlier lines never rewritten). Hash
correctness is pinned against a precomputed sha256 literal, so a broken/constant
hash implementation fails the self-test rather than passing it circularly. MUST
print `CANARY PASS 19/19` before you trust a result.
