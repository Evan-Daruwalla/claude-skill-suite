# claude-skill-suite

A suite of [Claude Code](https://claude.com/claude-code) skills built to keep a
**cheaper model** doing high-quality engineering work. Some are deterministic
Node tools — the model just runs them, so quality doesn't degrade with the
model; others are prose skills that shape how the model reviews, advises, and
writes. The governing rule for the security ones: **skill the judgment, hook
the gates** — a risk that must never slip through (a committed secret) belongs
in a deterministic hook that fires regardless of which model is running, not in
a skill the model has to remember to invoke.

> Memory / documentation-system skills live in the sibling repo
> **[claude-project-memory](https://github.com/Evan-Daruwalla/claude-project-memory)**.
> Together these two repos hold the generalized skill set.

## Security gates — deterministic, hook-backed

| Skill | What it does |
|---|---|
| **history-leak-scan** | Scans a repo's full git history (or the staged diff) for leaked credentials — per-provider keys (AWS, GitHub, Slack, Google, Stripe, Alpaca), private-key blocks, JWTs, high-entropy assignments, weak passwords. Token-level placeholder suppression so it doesn't cry wolf. Ships a `--canary` self-test. |
| **commit-gate** | Blocks any commit that stages a secret, two ways: a native git `pre-commit` hook (shell commits) **and** a `PreToolUse` hook (commits the model makes via Bash) — because a PreToolUse hook alone misses shell commits. Both share the scanner and fail open on error. |

## Model quality & output

| Skill | What it does |
|---|---|
| **llm-eval-harness** | Measures how far a cheaper model falls from your flagship model's quality bar, deterministically: `checks` (format / no-fabrication / surgical-scope assertions — no golden needed) and `golden` (word-level similarity to a captured flagship reference). Appends every run to a ratchet so the gap is a tracked series. No LLM-judge — a non-reproducible judge would be invented data. |
| **token-squeeze** | Deterministic text compressor: strips filler and collapses verbose phrasing while a guard layer proves numbers, negations, dotted identifiers, and masked spans survive byte-for-byte. Ships a reproducible corpus test (`node test.js`). Requires `npm install` (`gpt-tokenizer`). |
| **compact-io** | Always-on output-density style: lead with the answer, cut filler, plain words — governed by a **never-cut list** (numbers, paths, commands, caveats, tradeoffs, negations) so density never drops a fact. Also compresses a prompt/doc for reuse on request. Not a length cap. |
| **opus-workers** | Cost-tiered orchestration: when an expensive flagship (e.g. Fable 5, max/ultracode) spins up agents, route the WORKERS one tier cheaper (Opus 4.8) and keep the flagship as a thin reviewer — accept, or send back with specific pointers, bounded to 2 redo rounds. The cheaper model does the bulk generation; the flagship only reviews. |

## Deterministic quality & reproducibility gates

Read-only or additive-only checkers, each with a bundled `--canary` self-test.
The model just runs them — output quality doesn't degrade with a cheaper model.

| Skill | What it does |
|---|---|
| **golden-lock** | Freeze ANY output as a byte-exact golden baseline (a command's stdout, a fixture file, or a prompt/text asset) and diff on change. `freeze` records it; `check` re-produces it and fails on any drift, byte-exact and on exit code. |
| **determinism-guard** | Ephemeral invariance checker: run a command N times in one shot and prove it gives the same stdout, exit code, and (optionally) rebuilt file bytes every time — plus an order-independence check via seeded input shuffling. No stored baseline; prove stability before you freeze it with golden-lock. |
| **flaky-test-detector** | Run a test command N times and classify it STABLE-PASS, STABLE-FAIL (consistently red — a bug, not flake), or FLAKY (the finding). The harness is deterministic; the subject may not be. |
| **seed-control** | Static scan for unseeded randomness (`random.*`, `np.random.*`, `Math.random()`) that silently breaks reproducibility — the same-file heuristic, `# seed-ok` suppression. |
| **bisect-driver** | Automates `git bisect` to find the exact commit that introduced a behavior change. Always resets the bisect state; refuses on a dirty tree or in-progress bisect; guards against a repro that misclassifies its own endpoints. |
| **data-integrity-audit** | Read-only SQLite audit: `integrity_check`, `foreign_key_check`, and orphan detection (composite-FK-aware, catches bad data even with enforcement off). |
| **etl-validate** | Read-only source-vs-target assertion after a copy/transform: row counts + an order-independent content checksum, with named missing keys. |
| **local-secrets-manage** | Read-only hygiene audit of secret-bearing FILES: is a `.env`/`.pem`/key file tracked in git, ignored, or one `git add` from leaking. Scans names only — pair with history-leak-scan for content/history. |
| **cve-audit** | Dependency-vulnerability audit (npm audit + pip-audit) with a deterministic parse/report layer and a configurable fail-level gate; reports pip-audit as MISSING rather than faking a result. |
| **path-quirk-audit** | Read-only tree scan for Windows path/file corruption classes: non-ASCII bytes in `.bat`, CRLF in `.sh`, BOM/invalid UTF-8 in `.json`, builtin-shadowing root files, case-collision filenames. |
| **shell-portability** | Read-only syntax scanner for cross-shell traps: PS 5.1's missing `&&`/`||`/ternary/`?.`/`??`, unencoded `Set-Content`, and PowerShell-isms leaking into `.sh`. |
| **cron-task-manage** | Windows scheduled-task auditor — READ-ONLY execution always (only ever calls `schtasks /query`). Flags failing/disabled/overdue tasks; `plan` mode prints the `/create` line for you to run. |
| **experiment-log** | Reproducibility provenance: one JSON line per run recording cmd, exit code, git commit/dirty, tool versions, and input/output file hashes. Append-only; separate from any narrative doc system. |
| **milestone-track** | Read-only roadmap status rollup for a PRD_ROADMAP.md-style doc: checkbox/glyph/struck-item counts per milestone, fork-aware (`## CURRENT DIRECTION`), first open item as `next:`. |
| **decision-log** | Append one dated decision line with the real system clock and a configurable timezone label (default US Central) — paste-ready for a fuller record entry. |

## Judgment & review

| Skill | What it does |
|---|---|
| **trusted-advisor** | Candid advisor in two layers: a BASELINE (verdict first, no yes-man, honest calibration — always on) and a triggered FULL-CRITIQUE mode (severity-ranked, flaw-typed analysis). Yields to project/task instructions on format; never on honesty. |
| **audit** | Full sweeping project audit: enumerate findings, rank by severity, present for one-word approval, then fix in order with each fix verified. Diagnosis-first — it does not fix before you approve the plan. |
| **skill-vet** | Evaluates a third-party skill / plugin / MCP server before you install it — capability, risk, redundancy with what you already run — and gives a keep/skip verdict. |
| **research-brief** | Turns a topic into a sourced, decision-oriented research document — every claim cited, structured for the decision it feeds. |
| **reorg-proposal** | Read-only codebase-reorganization advisor: inspects a repo and proposes a file/folder restructure — current tree, proposed tree, and a per-move risk table naming what each move breaks (imports, paths, build, CI) — and **writes nothing**. Grounds every path in a real `git ls-files` listing; "already coherent, propose nothing" is a valid outcome. |
| **github-repo-polish** | Makes an existing repo professional across two layers: **presentation** (name, description, topics, README structure, semver tags/releases) and **branch workflow** (when to branch; GitHub Flow: feature branch → PR → merge → delete). Grounded `gh`/`git` commands, **propose→confirm→apply** on every public change (rename breaks links; a release goes public; merge ships to main). Portfolio-grade anti-fabrication gate. Defers prose voice to the-humanizer. |

## Verify before you trust the gates

A security gate you haven't watched catch a real secret is theater. The scanner
is canary-verified both ways — it must catch a planted real-format secret **and**
ignore a placeholder:

```
node history-leak-scan/pm-secretscan.js --canary          # -> PASS (4 caught, 0 false positives)
node history-leak-scan/pm-secretscan.js --history <repo>   # scan full history
node llm-eval-harness/score.js commit-message <file> --model <name>
node token-squeeze/test.js                                 # corpus guards (after: npm install)
```

## Install

- **Node tools** (history-leak-scan, commit-gate, llm-eval-harness, golden-lock,
  local-secrets-manage, determinism-guard, path-quirk-audit, cve-audit,
  shell-portability, bisect-driver, seed-control, flaky-test-detector,
  cron-task-manage, experiment-log, milestone-track, decision-log): clone
  anywhere, run with `node`. No dependencies.
- **Python tools** (data-integrity-audit, etl-validate): `python3` on PATH,
  stdlib only. No dependencies.
- **token-squeeze:** `cd token-squeeze && npm install` once (pulls
  `gpt-tokenizer`), then `node cli.js` / `node test.js`.
- **Prose skills** (compact-io, opus-workers, trusted-advisor, audit, skill-vet, research-brief, reorg-proposal):
  drop the folder into `~/.claude/skills/`; nothing to install.
- **commit-gate PreToolUse hook:** add to `~/.claude/settings.json` under
  `hooks.PreToolUse` an entry with `"matcher": "Bash"` running
  `node "<clone>/commit-gate/hooks/pretooluse-commit-gate.js"`.
- **commit-gate git hook:** set `SCANNER` at the top of `commit-gate/hooks/pre-commit`
  to your clone path, then `cp commit-gate/hooks/pre-commit <repo>/.git/hooks/`.

## Design notes

- **Deterministic over clever.** The security and compression tools survive a
  model downgrade because a script does the work; the model just runs it and
  reports.
- **Canary self-tests are part of "done."** Both false positives (which train
  you to bypass the gate) and false negatives (which give false confidence) are
  caught before the tool is trusted.
- **No fabricated data.** The eval harness refuses an LLM-judge precisely
  because it can't be reproduced.
