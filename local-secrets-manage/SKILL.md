---
name: local-secrets-manage
description: >
  Read-only hygiene audit of secret-bearing FILES in a git repo — finds candidate
  files by NAME (.env*, *.pem, *.key, id_rsa*, id_ed25519*, *_keys.env,
  credentials*.json, secrets.*) and asks git two questions per file: is it TRACKED
  (in the index) and is it IGNORED. Verdicts: TRACKED-SECRET (worst — already in the
  index), UNIGNORED (on disk, not ignored, one `git add` from leaking), OK (ignored).
  --fix-print proposes .gitignore lines but NEVER applies them. Use when the user
  says "check my .env is ignored", "is this secret file tracked", "audit secret
  files", "did I gitignore my keys", "local-secrets", or before a repo goes public.
  Scans NAMES only — for file CONTENT / git-history secret scanning use
  history-leak-scan. Deterministic, zero dependencies, no model calls.
---

# local-secrets-manage — is my secret file tracked or ignored?

The engine is `local-secrets.js` (portable Node, zero deps). It answers a narrow,
high-value question: for every file whose NAME looks like it holds credentials, is
git about to leak it? It walks the working tree, matches basenames against the
secret-file name rules, and for each candidate asks git — `ls-files` (tracked?) and
`check-ignore` (ignored?) — then assigns a verdict. That is the whole job.

This is the FILE-STATUS half of secret hygiene. It scans names, never contents:
it never opens a candidate file, never prints a byte of one, never edits
`.gitignore`. The CONTENT / git-history half — is an actual key string committed
anywhere in history — is `history-leak-scan`'s job (`pm-secretscan.js`). Run both:
this one catches "my `.env` is about to be added", that one catches "an AWS key is
already in commit `abc123`".

## Verdicts

| verdict | meaning | fix |
|---|---|---|
| `TRACKED-SECRET` | the file is in the git index — already leaking (or one push from public) | rotate the credential, then `git rm --cached <path>` and ignore it |
| `UNIGNORED` | on disk, not tracked yet, and not ignored — one `git add .` from leaking | add a `.gitignore` line (`--fix-print` gives you the exact line) |
| `OK` | ignored — git refuses to add it without `-f` | none |

## Commands

```
node local-secrets.js [--dir <path>]          audit repo at cwd (or <path>)
node local-secrets.js [--dir <path>] --fix-print   also print proposed .gitignore lines
node local-secrets.js --canary                self-test (the done-check)
node local-secrets.js --help
```

- **audit** prints a table (verdict / path / matched rule) plus a count line.
  Exit 1 if any `TRACKED-SECRET` or `UNIGNORED`; exit 0 clean.
- **--fix-print** appends the `.gitignore` lines it WOULD add — the exact path per
  risky row (`/.env`, `/config/id_rsa`, …), so a sibling is never over-ignored.
  It prints them to stdout only; you copy them in. It never writes the file.

Candidate name rules (basename): `.env*`, `*.pem`, `*.key`, `id_rsa*`,
`id_ed25519*`, `*_keys.env`, `credentials*.json`, `secrets.*`. Names containing
`example`/`sample`/`template`/`fixture` (and `.dist`/`.sample` suffixes) are
exempt — a placeholder is not a secret. `.git`, `node_modules`, `.venv`, and
similar build/dep dirs are skipped during the walk.

### Examples

- **Before making a repo public** — confirm no key file is staged:
  `node local-secrets.js --dir /path/to/repo`. A `*_keys.env` (e.g. a
  provider API-key file) showing `TRACKED-SECRET` means rotate the credential
  first, then untrack; `UNIGNORED` means add the ignore line now.
- **A backend service holding sensitive user data** — a `.env` with a database
  URL must read `OK`. If it shows `UNIGNORED`:
  `node local-secrets.js --dir /path/to/service --fix-print`
  and paste the proposed `/.env` line into `.gitignore` yourself.
- **This repo** — a quick pre-commit sanity check from the repo root:
  `node local-secrets.js`. Clean → exit 0.

## Windows notes

- Paths with spaces: quote `--dir` (`--dir "D:/path with spaces"`). Forward slashes
  work in both PowerShell and Git Bash; git resolves them.
- This tool never writes `.gitignore`. If you do apply the `--fix-print` lines by
  hand in PowerShell, use `Add-Content -Encoding utf8` (Set-Content defaults to the
  ANSI codepage) — a single non-ASCII byte in `.gitignore` is harmless, but keep
  the file UTF-8 to be safe.

## Storage / side effects

None. Read-only toward the world: it runs `git ls-files` / `git check-ignore`
(both read-only) and `fs.readdirSync` on directory entries. It writes nothing
outside its own `--canary` temp dir.

## Exit codes

`0` clean · `1` any `TRACKED-SECRET`/`UNIGNORED` (or canary failure) · `2` usage
error (missing `--dir`, not a git repo, git unavailable).

## Verification (the done-check)

```
node local-secrets.js --canary
```

Builds a throwaway git repo, plants a committed `.env` (→ `TRACKED-SECRET`), an
on-disk `.env.local` (→ `UNIGNORED`), an ignored `.env.ok` (→ `OK`), and an exempt
`.env.example`; asserts all four verdicts, exit 1, and the exact `--fix-print`
lines — then asserts a clean repo exits 0 and a non-repo exits 2. Cleans up.
MUST print `CANARY PASS 9/9` before you trust a result.
