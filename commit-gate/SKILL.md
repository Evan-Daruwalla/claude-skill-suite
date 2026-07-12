---
name: commit-gate
description: >
  Blocks commits that stage a secret, and helps produce clean atomic commits.
  The gate is TWO deterministic hooks over the shared pm-secretscan scanner: a
  native git pre-commit hook (covers shell commits) and a PreToolUse hook (covers
  commits the model makes via Bash) — because a PreToolUse hook alone misses
  shell commits. Use when the user says "commit-gate", "guard my commits", "block
  secret commits", "set up the pre-commit hook", or when splitting a large change
  into atomic commits / writing commit messages. Reads .claude/secrets-inventory.md.
---

# commit-gate — the secret never reaches a commit

Two hooks, one scanner (`../history-leak-scan/pm-secretscan.js --staged`):

| Hook | File | Fires when | Effect |
|---|---|---|---|
| git `pre-commit` | `hooks/pre-commit` | you commit from the shell | exit 1 → git aborts the commit |
| PreToolUse (matcher `Bash`) | `hooks/pretooluse-commit-gate.js` | the model runs `git commit` via Bash | `permissionDecision:"deny"` → the tool call is blocked |

Both fail OPEN on scanner error (never wedge commits) — but NOISILY: each
prints/surfaces a "gate SKIPPED (fail-open), commit is UNSCANNED" warning,
because a gate that skips silently is a dead gate. Both point a real hit at
secret-rotation + the secrets-inventory.

## Install

- **PreToolUse:** add to `~/.claude/settings.json` `hooks.PreToolUse` (append,
  don't overwrite) an entry with `"matcher": "Bash"` running
  `node "<abs>/skills/commit-gate/hooks/pretooluse-commit-gate.js"`.
- **git pre-commit, per repo:** `cp hooks/pre-commit <repo>/.git/hooks/pre-commit`
  (already executable via sh). Or set `git config core.hooksPath` globally to a
  dir holding it. Install into every repo that can hold a live credential first.
- The pre-commit script references the scanner by an absolute path — set the
  `SCANNER` variable at the top of `hooks/pre-commit` to wherever you cloned
  this suite. The PreToolUse hook resolves the scanner relative to itself.

## Verify before trusting (definition of done)

1. `node ../history-leak-scan/pm-secretscan.js --canary` prints PASS.
2. In a scratch repo with the pre-commit hook installed: staging a real-format
   secret and committing is BLOCKED; committing a placeholder-only change PASSES.
3. Feed the PreToolUse hook a `git commit` stdin payload whose cwd has a staged
   secret → it returns `permissionDecision:"deny"`; a clean cwd → allow.

## Atomic-commit / message layer (the judgment part)
When asked to commit a large change: propose a split into atomic commits (one
logical change each), and write outcome-first messages (imperative subject, body
explaining WHY). This half is model judgment; the gate above is the deterministic
guarantee.
