---
name: flaky-test-detector
description: >
  Run a test command N times and classify its stability: STABLE-PASS (every run
  exited 0), STABLE-FAIL (every run failed IDENTICALLY — a consistently red test
  is a bug, not flake, and is labeled as such), or FLAKY (exit codes varied
  across runs — the finding). Records each run's exit code + wall-clock duration,
  prints a per-run table + pass/fail rates, and can save each run's stdout+stderr
  to numbered files for diffing (--keep-logs). The harness is deterministic; the
  subject under test may not be — that is the point. Use when the user says
  "is this test flaky", "flaky test", "detect flakiness", "does this test pass
  reliably", "run it N times", "why does this test fail intermittently", or wants
  a test/command re-run repeatedly to check for non-determinism. Deterministic
  harness, zero dependencies, no model calls.
---

# flaky-test-detector — run N times, classify stability

The engine is `flaky-detect.js` (portable Node, zero deps). It runs a test
command a fixed number of times, records each run's exit code and duration, and
returns one verdict:

- **STABLE-PASS** — every run exited 0. Exit `0`.
- **STABLE-FAIL** — every run failed with the *same* nonzero exit every time.
  This is a consistently red test: a **bug, not flake**. Exit `1`, labeled so you
  don't chase a phantom race.
- **FLAKY** — exit codes varied across runs (including nonzero codes that differ,
  e.g. `1` then `2`). Non-deterministic; do not trust it as a gate. Exit `1`.

The harness itself is deterministic — same loop, same capture, every time. Any
variation in the verdict comes from the subject, which is exactly what you are
trying to measure.

## Commands

```
node flaky-detect.js --cmd "<test command>" [--times N] [--keep-logs <dir>]
node flaky-detect.js --canary
node flaky-detect.js --help
```

- **--cmd** (required) — the test command, run through the shell in the current
  working directory.
- **--times N** — run count (default 5, minimum 2). More runs raise confidence
  that an intermittent failure is caught.
- **--keep-logs <dir>** — save each run's stdout+stderr to `run-01.log`,
  `run-02.log`, … Diff two runs to see what actually differed between a pass and
  a fail.

### Examples

- **Confirm a regression test is genuinely deterministic** (frozen tests
  are pinned byte-exact — they must never flake):
  `node flaky-detect.js --cmd "python -m pytest tests/test_frozen_regression.py" --times 10`
  A FLAKY verdict here means the "frozen" guarantee is a lie; a STABLE-PASS is
  the evidence the pin holds.
- **Chase an intermittent backend test** (FastAPI/Postgres — async
  ordering and DB state are classic flake sources):
  `node flaky-detect.js --cmd "pytest tests/test_signup.py::test_guardian_email -q" --times 8 --keep-logs flake-logs`
  then diff `flake-logs/run-03.log` against a passing run to isolate the
  non-determinism.
- **Distinguish red-from-flaky before you debug**: if the verdict is STABLE-FAIL,
  stop looking for a race — the test fails the same way every time, so fix the
  test or the code. Only FLAKY warrants a hunt for shared state, timing, or
  ordering.

## Windows notes

- **PowerShell 5.1:** wrap the whole `--cmd` value in double quotes:
  `node flaky-detect.js --cmd "python -m pytest -q" --times 8`.
- **Git Bash:** single quotes work too: `--cmd 'pytest -q'`.
- Do NOT drive a subject with `node -e "<quoted code>"` on this machine — PS 5.1
  mangles quoted `-e` and leaves 0-byte junk files. Point `--cmd` at a real
  script or test runner instead.
- Duration is wall-clock (ms) and will jitter on a busy machine — it is a
  diagnostic signal, not part of the verdict. Only exit codes decide the class.

## Storage

Nothing is written unless you pass `--keep-logs <dir>`, which creates the dir and
writes one `run-NN.log` per run (numbered, zero-padded to at least two digits:
`run-01.log`, `run-02.log`, …) plus a `meta.txt` holding each run's exit code and
duration. Each `run-NN.log` contains the subject's stdout+stderr *only* — no
timing header — so `diff run-01.log run-02.log` shows only real subject deltas,
never the harness's own wall-clock jitter. The tool is otherwise read-only toward
the world — it only launches the command you give it.

## Exit codes

`0` STABLE-PASS · `1` FLAKY or STABLE-FAIL · `2` usage error (missing `--cmd`,
`--times` < 2).

## Verification (the done-check)

```
node flaky-detect.js --canary
```

Self-tests both directions in a throwaway temp dir: an alternating pass/fail
subject (a script that flips its exit code via a state file) is caught as FLAKY
at 4 runs, an always-pass subject stays quiet as STABLE-PASS, an always-fail
subject is labeled STABLE-FAIL, `--keep-logs` writes one file per run, and the
usage guards reject bad input. MUST print `CANARY PASS 11/11` before you trust a
verdict.
