---
name: path-quirk-audit
description: >
  Read-only tree scan for documented Windows path/file corruption classes — the
  traps that silently break a .bat parse, a shell script, a JSON file, or a
  Windows checkout before they cost a debugging session. Flags: .bat/.cmd holding
  ANY non-ASCII byte (one byte corrupts the whole batch parse — reports the
  offset), .sh/.bash with CRLF endings, .json with a UTF-8 BOM or invalid UTF-8,
  scan-root files whose name shadows a cmd builtin (echo/type/sort/find/time/date/
  path/exit/set) or is purely numeric ("12"), and filename pairs colliding by case
  on NTFS. Use when the user says "path-quirk-audit", "scan for windows file
  quirks", "check for bat/encoding/case landmines", "audit the tree for corruption
  traps", or before shipping a repo that runs on Windows. This is the proactive
  sweep — pair it with your own symptom-side runbook to fix what it finds.
  Deterministic, zero deps.
---

# path-quirk-audit — sweep a tree for Windows path/file landmines

The engine is `path-quirk-audit.js` (portable Node, zero deps). It enumerates a
tree (`git ls-files` in a repo, else a recursive walk skipping `node_modules/.git`)
and flags file-shaped corruption classes that fail *silently* on Windows: a
single non-ASCII byte that kills a `.bat` parse, a shell script that arrived with
CRLFs, a JSON file a PowerShell rewrite left with a BOM or mangled UTF-8, a stray
root file whose name shadows a cmd builtin, and two paths that collide by case on
NTFS. It is strictly **read-only** — it never writes, moves, or edits anything.
When it finds an offender, pair the finding with your own symptom-side runbook
for the actual fix.

## Commands

```
node path-quirk-audit.js scan [dir]   audit dir (default cwd)
node path-quirk-audit.js --canary
```

- **scan** enumerates and reports one block per finding: `CLASS<tab>file`, then a
  detail line, then a `fix:` hint. Exit 1 if anything is flagged, 0 if clean.
- Enumeration uses `git ls-files` when `dir` is inside a repo (tracked files only,
  respects `.gitignore`), otherwise a recursive walk skipping `node_modules/.git`.

### Classes flagged

| Class | Matches | Why it bites on Windows |
|---|---|---|
| `BAT-NONASCII` | `.bat`/`.cmd` with any byte > 0x7F (reports offset + value) | one non-ASCII byte silently corrupts the whole batch parse |
| `SH-CRLF` | `.sh`/`.bash` containing CRLF | CRLF breaks the shebang/commands under bash |
| `JSON-BADUTF8` | `.json` with a UTF-8 BOM or an invalid UTF-8 sequence | parsers choke on a BOM; a PS rewrite mangles emoji/multibyte |
| `ROOT-SHADOW` | scan-root file whose basename (case-insensitive, ext-stripped) is `echo/type/sort/find/time/date/path/exit/set`, or is purely numeric (`12`) | a root file named like a builtin/number breaks .bat parses |
| `CASE-COLLIDE` | two paths differing only by case | NTFS treats them as one path; a checkout clobbers one |

### Examples

- **Before a scheduled .bat runs** (a monthly job that runs as a Windows
  scheduled task): `node path-quirk-audit.js scan /path/to/project` — a
  `BAT-NONASCII` hit is exactly the "one non-ASCII byte silently corrupts the
  whole batch parse" failure, caught before the task fires and dies with garbled
  errors.
- **After a PowerShell edit touched JSON** (PS `Set-Content` defaults to the ANSI
  codepage and can leave a BOM / corrupt emoji): scan the tree — `JSON-BADUTF8`
  flags the BOM or the mangled multibyte sequence and points you at a Node writer.
- **Cross-checking this repo before a Windows checkout**: `CASE-COLLIDE` catches
  a `Case.txt`/`case.txt` pair that would clobber on NTFS, and `SH-CRLF` catches
  a helper script that picked up CRLFs.

## Windows notes

- Runs the same in PowerShell 5.1 and Git Bash — no `&&`/`||` chaining, ternary,
  or `??` used; it's a single Node process.
- `scan` is read-only. It reads content only for `.bat/.cmd/.sh/.bash/.json`; all
  other files are inspected by name only (root-shadow, case-collision).
- The BOM/invalid-UTF-8 detector is deliberately hand-rolled on raw bytes so the
  tool never itself re-encodes a file — it reports, it does not touch.

## Exit codes

`0` clean · `1` one or more findings · `2` usage error (missing/not-a-directory).

## Verification (the done-check)

```
node path-quirk-audit.js --canary
```

Plants one instance of every class in a throwaway temp dir and asserts all are
flagged (the bad direction), plus a clean dir with the same file *types* — a pure
-ASCII `.bat`, an LF `.sh`, a BOM-free valid-UTF-8 `.json` (emoji included), a
shadow-named file that is NOT in root — yields zero findings (the good
direction). MUST print `CANARY PASS 10/10` before you trust a result.
