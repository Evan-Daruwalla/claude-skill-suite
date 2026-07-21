---
name: golden-lock
description: >
  Freeze ANY output as a byte-exact golden baseline and diff on change — one
  engine over three inputs: a command's stdout, a fixture file, or a prompt/text
  asset. "freeze" records the baseline (output.txt + meta.json under .golden/);
  "check" re-produces it and fails with a line-numbered diff on any drift,
  comparing bytes AND exit code. Generalizes frozen-regression-test discipline
  (an output pinned byte-exact) to arbitrary outputs. Use when the user says
  "freeze this output", "golden test", "lock the
  baseline", "snapshot freeze", "did the output change", "prompt regression",
  "guard against output drift", or wants a fixture/prompt/command pinned so any
  change is a failing diff. Deterministic, zero dependencies, no model calls.
---

# golden-lock — freeze an output, diff on change

The engine is `golden-lock.js` (portable Node, zero deps). A golden baseline is
the exact output you declare correct today; `check` re-produces that output and
fails on any drift. It is a frozen-regression test (an output pinned byte-exact)
generalized to arbitrary outputs: pin a command's
stdout, a fixture file, or a reusable prompt/text asset, commit the baseline, and
every later run either MATCHes or hands you a line-numbered diff. Byte-exact by
default; comparison is deterministic and time-stable (timestamps live only in
`meta.json`, never in the baseline).

## Commands

```
node golden-lock.js freeze <name> --cmd "<command>" [--normalize-eol] [--strip-ansi]
node golden-lock.js freeze <name> --file <path>     [--normalize-eol] [--strip-ansi]
node golden-lock.js check  <name> [--update]
node golden-lock.js list
node golden-lock.js --canary
```

- **freeze --cmd** runs the command through the shell, captures stdout + exit
  code, and stores both. **freeze --file** freezes the file's bytes.
- **check** re-produces the output, re-applies the *stored* normalization flags,
  and compares byte-exact AND on exit code. MATCH → exit 0; drift → exit 1 with
  the first ~40 differing lines (`+N more differing lines` after that).
- **check --update** accepts the current output as the new baseline (use after a
  change is reviewed and intended).
- **list** prints one line per baseline: name, mode, created date, hash prefix.

### Examples

- **Pin a frozen regression report** (a backtest/report script whose output must
  stay byte-exact): `node golden-lock.js freeze factor-report --cmd "python run_backtest.py --report"`
  then `check factor-report` in the test loop — any drift is a failing diff.
- **Lock a build's output** (a Next.js/webpack frontend build):
  `node golden-lock.js freeze fe-build --cmd "npm run build" --strip-ansi`
  (`--strip-ansi` drops the build tool's color codes; a build that prints timings
  will still drift on every run — freeze a stable artifact file instead when it does).
- **Prompt regression across a compression pass** (a reusable prompt/text asset
  that `token-squeeze` rewrites): freeze the asset before editing —
  `node golden-lock.js freeze sys-prompt --file prompts/system.txt` — run
  token-squeeze, then `check sys-prompt` to see the exact diff the compression made.

## Windows quoting

- **PowerShell 5.1:** wrap the whole `--cmd` value in double quotes:
  `node golden-lock.js freeze x --cmd "python run.py --flag"`.
- **Git Bash:** single quotes work fine: `--cmd 'python run.py --flag'`.
- Do NOT freeze `node -e "<quoted code>"` on this machine — PS 5.1 mangles quoted
  `-e` and leaves 0-byte junk files. Point `--cmd` at a real script instead.

## Storage layout

```
.golden/<name>/output.txt   # the baseline — EXACTLY the (normalized) output
.golden/<name>/meta.json    # command/file, exitCode, sha256, createdAt, norm flags, mode
```

`.golden/` is meant to be committed — the committed baseline is what makes drift
reviewable in a diff. `<name>` must match `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` and
contain no `..` (blocks path traversal; nothing is written outside `.golden/`).

## Exit codes

`0` ok / match · `1` mismatch or canary failure · `2` usage error / missing baseline.

## Verification (the done-check)

```
node golden-lock.js --canary
```

Self-tests both directions in a throwaway temp dir — an unchanged output MATCHes
AND a tampered one is caught (command stdout and file modes, plus name-traversal
rejection). MUST print `CANARY PASS 8/8` before you trust a result.
