---
name: shell-portability
description: >
  Read-only SYNTAX/semantics scanner for cross-shell traps in shell scripts —
  the proactive counterpart to your own reactive troubleshooting runbook.
  Flags, with file:line + why it breaks + the PowerShell-5.1-safe fix: in
  .ps1/.psm1, the && / || pipeline chain (PS 5.1 parser error), ?: ternary,
  ?. null-conditional and ?? / ??= null-coalescing (PS7-only), Read-Host /
  pause / Out-GridView (block a non-interactive or scheduled run), Set-Content
  / Add-Content / Out-File written WITHOUT -Encoding (ANSI/UTF-16 default
  corrupts UTF-8), and bash-style NAME=value assignments; in .sh/.bash,
  PowerShell-isms ($env:NAME, Verb-Noun cmdlet calls). Use when the user says
  "shell-portability", "scan for PS5.1 traps", "will this script run on
  PowerShell 5.1", "check my .ps1 for portability", "lint my shell scripts",
  or before shipping a script to the scheduled-task / CI path. Encoding and
  filename quirks belong to path-quirk-audit; this is syntax only.
  Deterministic, zero dependencies, no model calls.
---

# shell-portability — cross-shell syntax trap scanner

The engine is `shell-portability.js` (portable Node, zero deps). It is the
proactive counterpart to a reactive shell-troubleshooting runbook (that
runbook diagnoses a script that already broke; this scans the source and flags
the same documented traps *before* they reach the shell) — with `file:line`,
why it breaks on a Windows machine, and the PowerShell-5.1-safe alternative.
Read-only; it never writes outside its own canary temp dir.

Scope is **syntax and semantics only**. Encoding and filename quirks (non-ASCII
bytes that corrupt a `.bat` parse, UTF-16 BOMs, builtin-shadowing stray files)
are `path-quirk-audit`'s job — this scanner deliberately does not duplicate
them, and it skips `.bat` files entirely.

## What it flags

**`.ps1` / `.psm1`** — the target here is PowerShell **5.1** (the common
Windows default, not PS7):

| Trap | Why it breaks | PS5.1-safe fix |
|---|---|---|
| `&&` / `\|\|` | no pipeline-chain operators — parser error | `A; if ($?) { B }` / `A; if (-not $?) { B }` |
| `?:` ternary | PS7-only | `if/else` |
| `?.` / `?[]` | null-conditional, PS7-only | guard with `if ($null -ne $x)` |
| `??` / `??=` | null-coalescing, PS7-only | `if ($null -eq $x) { ... }` |
| `Read-Host` / `pause` / `Out-GridView` | block a non-interactive / scheduled run | take input as a param / env / file |
| `Set-Content`/`Add-Content`/`Out-File` w/o `-Encoding` | ANSI/UTF-16 default corrupts UTF-8 for the next reader | add `-Encoding utf8` |
| bash-style `NAME=value` / `export NAME=value` | PS can't assign to a bareword; `export` isn't a cmdlet | `$name = value` / `$env:NAME = 'value'` |

**`.sh` / `.bash`** — PowerShell-isms leaking into a POSIX script:

| Trap | Why it breaks | POSIX fix |
|---|---|---|
| `$env:NAME` | bash has no `$env:` namespace | `$NAME` / `${NAME}`, set with `export` |
| Verb-Noun cmdlet (`Get-ChildItem`, `Set-Content`, ...) | PowerShell cmdlet, not a bash command | POSIX equivalent (`ls`/`find`, `printf > file`) |

## Commands

```
node shell-portability.js scan <path> [<path>...]
node shell-portability.js --canary
node shell-portability.js --help
```

- **scan** recurses any files or directories given (skips `.git`,
  `node_modules`, `.golden`, `graphify-out`), reads every `.ps1/.psm1/.sh/.bash`
  file, and prints one block per finding:

  ```
  path\to\deploy.ps1:12: [chain-and-or] PS 5.1 has no && / || pipeline-chain operators (parser error)
      fix: A; if ($?) { B }  (and)   /   A; if (-not $?) { B }  (or)
      > git pull && npm run build
  ```

  Exit 1 if anything is flagged, 0 if clean.

### Suppression

A trailing `# portability-ok` comment silences every finding on that line — use
it for a deliberate exception (e.g. a string that merely *contains* `&&`, or a
script that is PS7-only on purpose):

```powershell
$result = git pull && git push   # portability-ok  (PS7 CI runner only)
```

### Examples

- **Guard a scheduled job's script before it ships** (a monthly rebalance job
  runs as a Windows scheduled task — a `Read-Host` or a `&&` would hang or
  parser-error unattended): `node shell-portability.js scan /path/to/scripts`
  — catches any interactive prompt or PS7-ism before the scheduled run hits it.
- **Check a helper `.ps1` writes UTF-8 for the next tool** (`Set-Content`'s
  ANSI default is a well-known trap): the scanner flags every
  `Set-Content`/`Out-File` missing `-Encoding utf8`.
- **Scan a `.sh` you cross-wrote in a PowerShell headspace**: catches a stray
  `$env:PATH` or `Get-ChildItem` before it silently does nothing under bash.

## Windows notes

- PowerShell 5.1 lacks `&&`, `||`, ternary, `?.`, and `??` — this scanner exists
  because those keep leaking in from PS7 / bash habits.
- Backtick line-continuations are joined into one logical line, so an
  `-Encoding` flag on the following line still counts. `<# ... #>` block comments
  and whole-line `#` comments are not scanned.
- `.bat` files are out of scope — their traps are byte/parse-level, which is
  `path-quirk-audit`'s domain.

## Storage / exit codes

Read-only — writes nothing except inside a throwaway temp dir during `--canary`.

`0` clean · `1` findings or canary failure · `2` usage error.

## Verification (the done-check)

```
node shell-portability.js --canary
```

Self-tests both directions in a throwaway temp dir: the documented traps are
CAUGHT (a bad `.ps1` with `&&` + a ternary + an unencoded `Set-Content` yields
exactly 3 findings; `??`, `?.`, `Read-Host`, bash-assign, and a bad `.sh` each
caught) AND clean PS5.1-safe / POSIX code stays quiet (0 findings), plus the
`# portability-ok` suppression and an end-to-end directory walk. MUST print
`CANARY PASS 10/10` before you trust a result.
