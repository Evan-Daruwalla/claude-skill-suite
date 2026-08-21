---
name: experiment-log
description: >-
  Reproducibility provenance for a single run: executes a command and appends
  ONE JSON line — ISO timestamp, cwd, cmd, exit, duration, git {commit,
  dirty}, node/python versions, sha256 of declared inputs (hashed before) and
  outputs (after), note. Append-only JSONL; never touches HANDOFF.md or the
  record (project-memory owns the narrative). Use when: "log this run",
  "record provenance", "experiment log", "make this run reproducible", "what
  produced this output". Also ships a SubagentStop hook that logs every subagent
  run (cost, tools, duration) to agent-runs.jsonl automatically. Zero deps.
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
- `--in` / `--out` are comma-separated file lists, and are also **repeatable**
  (`--in a.csv --in b.csv`). A comma inside a FILENAME is resolved by asking the
  filesystem: if the whole value names a real file it is taken whole, otherwise
  it splits. Before that, `--in "data,v2.csv"` recorded
  `{"data":null,"v2.csv":null}` — the log asserting the declared input did not
  exist while the real file hashed fine.
- Default log file: `experiments.jsonl` in cwd. An **absent** input/output is
  recorded as `null` and rendered `(absent)`; one that exists but could not be
  read (EACCES, or EBUSY on a locked SQLite file) is recorded as
  `"unreadable:<CODE>"`. Those are different facts and used to be the same one.
  Nothing is ever faked.
- `ts` is stamped when the entry is WRITTEN, i.e. AFTER the command finished.
  `durationMs` gives you the other end.

### The case: a backtest with a frozen regression report

A frozen regression is pinned byte-exact — but a result is only reproducible if
you know the exact inputs and versions behind it. Log the run:

```
node experiment-log.js log --cmd "python run_backtest.py --sleeve value --report" --in price_cache.db,config/value.yaml --out reports/value_report.txt --note "monthly rebalance, value sleeve"
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

## The subagent hook (automatic, no command)

`hooks/subagent-log.js` is a `SubagentStop` hook: it appends one line to
`~/.claude/agent-runs.jsonl` every time a subagent finishes, with no invocation
from you. It answers a different question from the CLI above — not "what
produced this output?" but **"what did this agent run cost, and did it catch
anything real?"** — which is the measurement no published study provides for
subagent review gates.

Register it in `~/.claude/settings.json`:

```json
{ "hooks": { "SubagentStop": [ { "hooks": [
  { "type": "command",
    "command": "node \"<skills-dir>/experiment-log/hooks/subagent-log.js\"" }
] } ] } }
```

Each line carries `ts`, `session_id`, `agent_id`, `agent_type`, `name`,
`description`, `model`, `cwd`, `input_new`, `output_tokens`, `context_peak`,
`tool_uses`, `turns`, `duration_ms`, `transcript`, `result_head`, and
`finding`. **`transcript` says whether the numbers beside it are real**:
`parsed` (they are), `absent`, `unreadable`, `no-usage`, or `none-declared`.
Without it a missing transcript produced `input_new:0, output_tokens:0,
turns:0` — byte-identical to a genuinely cheap run, and on one real dataset 38%
of rows were all-zero while every one of them carried a `result_head`, so the
agent demonstrably ran. Rows written before the column existed have no
`transcript` key; treat an all-zero row without one as unknown cost, not free.
**`finding`
is always `null` — it is yours to fill in by hand.** That column is the point of
the exercise: cost is measured automatically, value is not.

Two derivation rules the hook exists to get right, both of which produced
confident wrong numbers first:

- **`cache_read_input_tokens` is cumulative but NOT monotonic** — summing it
  across turns inflates a 78K-token run to 517K, so it is never summed; but the
  final turn is not the peak either (28/409 real transcripts), and a terminal
  `<synthetic>` message with all-zero usage resets a last-turn reading to 0.
  `context_peak` is the running MAX.
- **One API message spans several transcript lines**, one per content block, all
  sharing `message.id`. Deduping by it is fatal for content — it keeps the
  leading `thinking` block and discards every `tool_use` behind it, reading 0
  tools on every multi-turn agent. `tool_use` blocks are counted across all lines.
- **`output_tokens` is the one usage field that STREAMS across those lines.**
  The first line carries a partial count and the last carries the total;
  `input_tokens`, `cache_creation` and `cache_read` are genuinely identical
  across all lines of a message. Measured over 409 transcripts: `output_tokens`
  differs in 4,855 of 6,335 multi-line ids, the other three differ in zero, and
  the max is on the last line 6,335/6,335 times. Taking the first line — the
  original implementation — undercounted by **86.3%**. Usage is deduped per id,
  except `output_tokens`, which is taken as that id's MAX.
  **This was shipped green:** the canary's fixture gave every split line the
  same usage object, so it passed 15/15 while encoding the identical false
  assumption as the code. The fixture now streams 5 → 12 → 20 and asserts the
  result is not the first-line sum, so it fails against the old logic.

**Not reproduced on purpose:** the harness's own `subagent_tokens` aggregate. No
combination of transcript fields matched it across five real runs (closest was
14-105 tokens under, inconsistently) and its definition is undocumented, so the
exact components are logged instead and any aggregate can be computed later.
Don't "fix" this into a fitted number.

The hook never blocks a turn: every failure path exits 0 silently. Verify with
`node hooks/subagent-log.js --canary` — MUST print `CANARY PASS 26/26`.

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
`node experiment-log.js --canary` — MUST print `CANARY PASS 57/57` before you
trust a result.
