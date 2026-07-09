---
name: history-leak-scan
description: >
  Deterministic secret scanner for git repositories — no dependencies, no API key.
  Scans full git history (every version ever committed) or the staged diff for
  leaked credentials: per-provider keys (AWS, GitHub, Slack, Google, Stripe,
  Alpaca), private-key blocks, JWTs, high-entropy assignments, and weak/short
  passwords. Use when the user says "scan for secrets", "leak scan", "check for
  leaked keys/credentials", "did I commit a secret", "history-leak-scan", or after
  any repo goes public / any suspected exposure. The same scanner backs commit-gate
  (staged mode). Reads .claude/secrets-inventory.md for what credentials exist.
---

# history-leak-scan — deterministic secret scanner

The engine is `pm-secretscan.js` (portable Node, zero deps). It streams
`git log -p --all` (history) or `git diff --cached` (staged) and flags added
lines against per-provider regexes + a generic high-entropy-assignment detector
+ a weak-password rule, with token-level placeholder suppression.

## Commands

- **Full-history scan (one or more repos):**
  `node pm-secretscan.js --history <repo> [<repo>...]`
  Exit 1 if any finding, 0 if clean. Redacts matched tokens in output.
- **Staged scan (what commit-gate runs):**
  `node pm-secretscan.js --staged <repo>`
- **Self-test (part of the definition of done):**
  `node pm-secretscan.js --canary`
  Plants real-format secrets + placeholders in a throwaway repo, asserts
  ≥4 real caught and 0 false positives. MUST print `PASS` before you trust a
  scan result — an unverified gate is theater.

## When invoked

1. **Run `--canary` first** if the scanner was touched since last use; paste the
   PASS line. Never report a "clean" scan from an unverified scanner.
2. Enumerate the repos to scan (`find <root> -name .git -type d`). Scan all with
   `--history`.
3. Triage every finding by READING the actual line — distinguish a live
   credential from a guarded dev-default or an example. Do NOT auto-rotate;
   report, and on a real leak point at secret-rotation + the secrets-inventory.
4. Report outcome-first: repos clean vs. findings, each finding as
   file@commit + rule + redacted snippet, and the honest severity.

## Known limits
- Catches secrets that were COMMITTED. Files that were always gitignored
  (`.env`, key files) are correctly out of history — verify they were never
  committed by a clean history scan, not by their current absence.
- Entropy detection can miss bespoke low-entropy formats — that's why the
  per-provider regexes exist; extend `RULES` when a new provider appears.
- Redaction shows first-4 + last-2 of long tokens; still treat output as
  sensitive.
