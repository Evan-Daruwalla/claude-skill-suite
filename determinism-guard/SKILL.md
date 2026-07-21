---
name: determinism-guard
description: >
  EPHEMERAL invariance checker — run a command repeatedly in one shot and prove
  it produces the SAME output every time. Three checks over one engine: default
  runs `--cmd` N times and compares stdout + exit code byte-exact across runs
  (first-divergence line diff on failure); `--files "a,b,c"` ALSO sha256s each
  listed file after every run to catch non-reproducible rebuilds; `--shuffle-stdin
  <file>` runs the command twice — input as-is vs. its lines shuffled by a
  fixed-seed PRNG — to catch order-dependence. No baselines are stored (freeze an
  output across time with golden-lock instead). Use when the user says "is this
  deterministic", "does it give the same output every run", "check for flakiness",
  "reproducible build check", "is my output order-dependent", "determinism-guard",
  or wants a command proven stable before it is frozen or scheduled. Deterministic,
  zero dependencies, no model calls.
---

# determinism-guard — prove an output never varies

The engine is `determinism-guard.js` (portable Node, zero deps). It answers one
question: *does running this again change the answer?* It runs the command you
name several times in a single invocation and fails the moment two runs disagree
— on stdout, on exit code, on a rebuilt file's bytes, or on input order.

It is **ephemeral by design**: it stores nothing. It compares runs *against each
other, now* — not against a recorded baseline. Freezing an output so drift over
*commits/time* is a failing diff is a different job — that is **golden-lock**
(`freeze` / `check`, baselines under `.golden/`). Reach for determinism-guard to
prove a thing is stable *before* you freeze it, schedule it, or pin it as a
frozen regression.

## Commands

```
node determinism-guard.js --cmd "<command>" [--times N]
node determinism-guard.js --cmd "<command>" --files "a,b,c"
node determinism-guard.js --cmd "<command>" --shuffle-stdin <file>
node determinism-guard.js --canary
```

- **default** runs `--cmd` **N** times (N=2) through the shell and compares
  stdout AND exit code byte-exact across all runs. INVARIANT → exit 0; any drift →
  exit 1 with the first diverging stdout line (`run#1 -` / `run#k +`).
- **--files "a,b,c"** additionally sha256s each listed file *after every run* and
  compares the hashes — catches a build/script that emits different bytes each
  time even when stdout looks stable (embedded timestamps, hash-map iteration
  order, absolute paths).
- **--shuffle-stdin <file>** runs the command twice — once feeding the file as-is,
  once with its lines reordered by a **fixed-seed** Fisher-Yates shuffle (seed
  `0x9e3779b9`, so the shuffle itself is reproducible) — and compares outputs. Same
  output both ways ⇒ order-independent. Use it on anything that *should* be
  insensitive to input line order (a sorter, an aggregator, a set-builder).

### Examples

- **Prove a frozen regression is actually deterministic before pinning it**
  (a report script meant to hold byte-exact): run
  `node determinism-guard.js --cmd "python run_backtest.py --report" --times 3`
  first. If it already varies run-to-run, freezing it with golden-lock would only
  bake in a flaky baseline — fix the nondeterminism (unseeded RNG, dict ordering,
  wall-clock in output) first, THEN freeze.
- **Catch a non-reproducible rebuild** (a Next.js frontend build):
  `node determinism-guard.js --cmd "npm run build" --files ".next/BUILD_ID"`
  — stdout may match while a build id / hashed asset changes every run; the
  `--files` hash surfaces exactly that.
- **Verify an aggregation ignores input order** (a factor/CSV roll-up that should
  sort or group before emitting):
  `node determinism-guard.js --cmd "python summarize.py" --shuffle-stdin rows.csv`
  — if the shuffled run differs, the pipeline is leaking input order into output.

## Windows notes

- **PowerShell 5.1:** wrap the whole `--cmd` value in double quotes:
  `--cmd "python run.py --report"`. **Git Bash:** single quotes are fine.
- Do NOT pass `node -e "<quoted code>"` as `--cmd` on this machine — PS 5.1 mangles
  quoted `-e` and leaves 0-byte junk files. Point `--cmd` at a real script.
- A command whose stdout embeds wall-clock time or a PID will always read VARYING —
  that is the tool working, not a false alarm. If the timestamp is incidental,
  strip it in the command (`... | findstr /v timestamp`) before comparing.

## What it does NOT do

- No stored baseline / no history — for freeze-then-diff-over-time use **golden-lock**.
- It runs the command you give it (as many as N times) and reads the files you
  list; it writes nothing outside the canary's temp dir. Side effects of *your*
  command (it rebuilds, it writes files) are your command's, not the guard's.

## Exit codes

`0` invariant · `1` varying (prints what varied) · `2` usage error.

## Verification (the done-check)

```
node determinism-guard.js --canary
```

Self-tests both directions in a throwaway temp dir: a deterministic command reads
INVARIANT while an `hrtime()`-printing one is CAUGHT varying; a sort-then-print
command is order-independent under `--shuffle-stdin` while a pass-through (`cat`)
one is CAUGHT; and a fixed-bytes writer is reproducible under `--files` while a
changing-bytes writer is CAUGHT. MUST print `CANARY PASS 6/6` before you trust a
result.
