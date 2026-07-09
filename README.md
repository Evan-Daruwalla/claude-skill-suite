# claude-skill-suite

Three deterministic [Claude Code](https://claude.com/claude-code) skills for
working safely with a **cheaper model** driving your sessions. They share one
design rule: **skill the judgment, hook the gates** — risks that must never slip
through (a committed secret) belong in a deterministic hook that fires
regardless of which model is running, not in a skill the model has to remember
to invoke. Everything here is portable Node (no dependencies) and runs without
an API key.

## The skills

| Skill | What it does |
|---|---|
| **history-leak-scan** | Scans a repo's full git history (or the staged diff) for leaked credentials — per-provider keys (AWS, GitHub, Slack, Google, Stripe, Alpaca), private-key blocks, JWTs, high-entropy assignments, weak passwords. Token-level placeholder suppression so it doesn't cry wolf. Ships a `--canary` self-test. |
| **commit-gate** | Blocks any commit that stages a secret, two ways: a native git `pre-commit` hook (shell commits) **and** a `PreToolUse` hook (commits the model makes via Bash) — because a PreToolUse hook alone misses shell commits. Both share the scanner and fail open on error. |
| **llm-eval-harness** | Measures how far a cheaper model falls from your flagship model's quality bar, deterministically: `checks` (format / no-fabrication / surgical-scope assertions — no golden needed) and `golden` (line-similarity to a captured flagship reference). Appends every run to a ratchet so the gap is a tracked series. No LLM-judge — a non-reproducible judge would be invented data. |

## Verify before you trust it

A security gate you haven't watched catch a real secret is theater. Each tool is
canary-verified both ways — it must catch a planted real-format secret **and**
ignore a placeholder:

```
node history-leak-scan/pm-secretscan.js --canary     # -> PASS (4 caught, 0 false positives)
node history-leak-scan/pm-secretscan.js --history <repo>   # scan full history
node llm-eval-harness/score.js commit-message <file> --model <name>
```

## Install

- **Scanner / eval:** clone anywhere; run with `node`.
- **commit-gate PreToolUse hook:** add to `~/.claude/settings.json` under
  `hooks.PreToolUse` an entry with `"matcher": "Bash"` running
  `node "<clone>/commit-gate/hooks/pretooluse-commit-gate.js"`.
- **commit-gate git hook:** set `SCANNER` at the top of `commit-gate/hooks/pre-commit`
  to your clone path, then `cp commit-gate/hooks/pre-commit <repo>/.git/hooks/`.

Requires `node` on PATH.

## Design notes

- **Deterministic over clever.** These survive a model downgrade because a script
  does the work; the model just runs it and reports.
- **Canary self-tests are part of "done."** Both false positives (which train you
  to bypass the gate) and false negatives (which give false confidence) are
  caught before the tool is trusted.
- **No fabricated data.** The eval harness refuses an LLM-judge precisely because
  it can't be reproduced.
