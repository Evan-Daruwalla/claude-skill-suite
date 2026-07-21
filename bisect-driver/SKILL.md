---
name: bisect-driver
description: >
  Automate git bisect to find the exact commit that introduced a behavior change
  — regression blame. Give it a KNOWN-good ref, a bad ref (default HEAD), and a
  repro command; it drives `git bisect run`, parses the first-bad commit, and
  ALWAYS resets the bisect state so your repo is left exactly where it started.
  Refuses up front on a dirty working tree or an in-progress bisect. Use when the
  user says "bisect this", "which commit broke X", "find the commit that
  introduced the regression", "git bisect", "regression blame", "when did this
  test start failing", or "what change made the output drift". Deterministic, zero
  dependencies, no model calls.
---

# bisect-driver — find the commit that introduced a change

The engine is `bisect-driver.js` (portable Node, zero deps). You hand it a commit
where the behavior was still correct (`--good`), a commit where it is broken
(`--bad`, default `HEAD`), and a repro command; it drives `git bisect run` over
the range, parses the culprit, prints its sha + subject + author date, and
**always** runs `git bisect reset` so the repo ends where it started. This is the
catalog's **regression-blame** — the same operation under a different name.

## Commands

```
node bisect-driver.js --good <ref> [--bad <ref>] --cmd "<repro command>" [--dir <repo>]
node bisect-driver.js --canary
node bisect-driver.js --help
```

- **--good `<ref>`** a commit known to still behave correctly (required).
- **--bad `<ref>`** a commit where the behavior is broken (default `HEAD`).
- **--cmd `"<...>"`** the repro, run per candidate commit via `git bisect run sh -c`.
- **--dir `<repo>`** repo to bisect (default: current directory).

### The repro command's exit code IS the verdict

`git bisect run` classifies each commit by the repro's exit status:

| exit code | meaning |
|-----------|---------|
| `0`       | commit is **good** |
| `1`–`124` | commit is **bad** (avoid `126`/`127` — POSIX-shell reserved) |
| `125`     | **skip** — source can't be tested at this commit |
| `>=128`   | **abort** the bisect |

So write the repro to **exit 0 while the behavior is still correct and non-zero
once it is broken**. Examples: a test runner that already exits non-zero on
failure works as-is; to blame an output change, `run.py ... && diff -q got.txt
want.txt` (0 when it still matches). Wrap a build that must pass first as
`make || exit 125; ./repro` so uncompilable commits are skipped, not blamed.

### Examples

- **A frozen regression started drifting** (a report pinned to hold byte-exact):
  find the good commit before the drift, then
  `node bisect-driver.js --good <sha-before> --cmd "python run_backtest.py --report && diff -q report.txt frozen/report.txt" --dir /path/to/repo`.
  The culprit is the commit that first broke the pin.
- **A frozen regression test started failing:** point `--cmd` straight
  at the test (`python -m pytest tests/test_frozen.py -q`) — pytest exits
  non-zero on failure, which is exactly "bad".
- **An API endpoint changed behavior:**
  `node bisect-driver.js --good <last-known-good> --cmd "pytest tests/test_api.py::test_signup -q" --dir /path/to/backend`.

## Safety

- **Refuses (exit 2) on a dirty working tree.** Bisect checks out historic
  commits during the run and would clobber uncommitted work — commit, stash, or
  clean first. "Dirty" includes untracked files.
- **Refuses (exit 2) on an in-progress bisect** — run `git bisect reset` first.
- **Always resets.** The bisect state is torn down in a `finally`, and best-effort
  on Ctrl-C (SIGINT/SIGTERM), so an interrupted run still restores your HEAD. The
  tool verifies HEAD is back where it started and warns if not.
- Read-only toward the world: it only mutates the target repo's transient bisect
  state, which it restores.
- **Refuses (exit 2) when the repro misclassifies the endpoints.** `git bisect`
  trusts the marked `--good` / `--bad` refs and **never re-tests them** — it only
  tests commits *between* them. So a repro that never actually flips to "bad" on
  historic checkouts (wrong path, missing script, an always-`exit 0` command, or
  the opposite — an always-non-zero command) would otherwise yield a confident
  but false culprit. Guard: before starting, the tool checks out each endpoint
  and runs the repro itself — the `--good` ref must exit `0` and the `--bad` ref
  must exit `1`–`124`. If not, it refuses with an actionable message instead of
  handing back a silent false positive. (This costs two extra repro runs up
  front; on a slow repro that is the price of not trusting a broken one.)

## Windows notes

- The repro is executed as `git bisect run sh -c "<cmd>"`; Git for Windows ships
  the `sh` it needs (bisect has always depended on it), so this works under both
  PowerShell 5.1 and Git Bash.
- **PowerShell 5.1:** wrap the whole `--cmd` value in double quotes —
  `--cmd "pytest -q && diff -q a b"`. PS 5.1 has no `&&` at the *pipeline* level,
  but here `&&` lives inside the quoted string and is interpreted by `sh`, so it
  is fine.
- Do not pass `node -e "<quoted code>"` as the repro on this machine — PS 5.1
  mangles quoted `-e` and leaves 0-byte junk files. Point the repro at a real
  script file instead.

## Exit codes

`0` culprit found · `1` no culprit parsed / bisect error · `2` usage error or
preflight refusal (dirty tree, in-progress bisect, unresolvable ref, or a repro
that misclassifies the `--good`/`--bad` endpoints).

## Verification (the done-check)

```
node bisect-driver.js --canary
```

Builds a throwaway git repo of ~8 commits with a behavior change planted at a
known middle commit, then proves **both directions**: the culprit is identified
as exactly the planted commit and the repo is restored + bisect-state clean
(good direction), AND a dirty tree, an in-progress bisect, an unresolvable ref,
an always-good repro (bad endpoint passes), and an always-bad repro (good
endpoint fails) are each refused with exit 2 (bad direction). Cleans up after
itself. MUST print `CANARY PASS 11/11` before you trust a result. Never bisects
a real repo.
