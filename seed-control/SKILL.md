---
name: seed-control
description: >
  Read-only static scan for UNSEEDED randomness — the reproducibility guard.
  Flags Python random.<fn>() in any file with no random.seed() anywhere in it,
  np.random.<fn>() with no np.random.seed()/default_rng() in the file, and every
  JS/TS Math.random() (no seed API exists). Reports file:line:snippet, exit 1 on
  findings. Suppress a known-fine line with a `# seed-ok` / `// seed-ok` comment.
  Use when the user says "scan for unseeded randomness", "reproducibility check",
  "did I forget to seed", "seed-control", or before pinning a frozen/regression
  run whose output must be byte-stable. Deterministic, zero dependencies, no
  model calls, writes nothing.
---

# seed-control — catch unseeded randomness before it breaks reproducibility

The engine is `seed-control.js` (portable Node, zero deps). It statically scans
`.py` / `.js` / `.ts` source for random draws that have no seed governing them.
An unseeded draw makes a run non-repeatable: the motivating case is a
**backtest or simulation** whose frozen regression tests are pinned byte-exact —
one stray `random.random()`, `np.random.rand()`, or `Math.random()` with no seed
silently turns a byte-for-byte-stable report into a moving target, and the
frozen test starts flapping for reasons unrelated to any real change.

Purely read-only: it opens files, never writes to the scanned tree (canary
experiments are confined to a temp dir).

## Rules (same-file heuristic)

| Lang | Use flagged | Silenced when the file contains |
|------|-------------|---------------------------------|
| Python | `random.<fn>(` | `random.seed(` anywhere in that file |
| Python | `np.random.<fn>(` | `np.random.seed(` or `default_rng(` in that file |
| JS/TS | `Math.random(` | never — JS has no stdlib seed API |

`Math.random()` is always flagged because there is no way to seed it; the fix is
a seeded PRNG (mulberry32, seedrandom, etc.). A per-line
`# seed-ok` (Python) or `// seed-ok` (JS/TS) comment suppresses that one finding
when the randomness is intentionally unseeded (jitter, nonces, sampling you don't
need to reproduce).

## Commands

```
node seed-control.js scan <path> [<path>...]
node seed-control.js --canary
```

- **scan** takes files or directories. Directories recurse over `.py`/`.js`/`.ts`
  and skip `node_modules`, `.git`, `__pycache__`, `.venv`/`venv`, `dist`, `build`.
  Each finding prints as `file:line:snippet`. Exit 1 if any finding, else 0.

### Examples

- **Guard a backtest before freezing its report** (must stay byte-exact):
  `node seed-control.js scan /path/to/backtest` — any hit is a draw that can
  drift the frozen baseline; seed it or mark `# seed-ok`, then re-run.
- **Scan a web app's frontend/backend** for stray `Math.random()`
  (token/ID generation that should use a seeded or crypto source):
  `node seed-control.js scan /path/to/app`.
- **Check a single file:** `node seed-control.js scan sim.py`.

## Windows notes

- PowerShell 5.1 and Git Bash both run it the same way; paths with spaces go in
  double quotes: `node seed-control.js scan "D:\path with space"`.
- Pure Node stdlib — no `&&`/`||` chaining, ternary, or encoding gotchas involved;
  nothing is written, so no Set-Content / UTF-8 concerns apply.

## Known limitations (read before trusting a clean result)

- **Same-file heuristic, no cross-module tracking.** A seed set in
  `conftest.py`, a shared `set_seed()` helper, or a fixture in another module does
  NOT count — the scanner only sees `random.seed(`/`np.random.seed(`/`default_rng(`
  *in the same file* as the draw. This yields **false positives** for
  centrally-seeded projects; triage each hit and add `# seed-ok` where a real
  upstream seed exists. Conversely, a seed in one file does not vouch for an
  unseeded draw in another — each file is judged alone.
- **Textual, not semantic.** It matches `random.`/`np.random.`/`Math.random(`
  token patterns; it does not parse scope or data flow. A `random.seed()` guarded
  behind a branch that never runs still reads as "seeded". Aliased imports
  (`from random import random as r`; `import numpy.random as npr`) are NOT matched
  — only the `random.` / `np.random.` / `Math.random` spellings are.
- **Python `random` module only** for the bare form — `secrets.token_*` (which is
  intentionally unseedable and correct for tokens) is not flagged.
- Seeding is necessary, not sufficient, for reproducibility: thread/process
  ordering, dict iteration, hardware floats, and library-internal RNGs can still
  cost you determinism. This scan removes the most common and silent cause, not
  all of them.

## Exit codes

`0` clean · `1` findings or canary failure · `2` usage error (no files, unknown
command).

## Verification (the done-check)

```
node seed-control.js --canary
```

Self-tests both directions in a throwaway temp dir: an unseeded `random.random()`
IS flagged, a `random.seed()`ed file stays clean, unseeded `np.random` is flagged
while `np.random.seed()`/`default_rng()` clear it, `Math.random()` is flagged in
`.js` and `.ts`, and both `# seed-ok` / `// seed-ok` suppressions silence a line —
plus end-to-end exit 1 (findings) vs. exit 0 (clean). MUST print
`CANARY PASS 10/10` before you trust a scan.
