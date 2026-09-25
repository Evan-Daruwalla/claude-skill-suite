---
name: decision-log
description: >-
  Appends ONE dated decision line to append-only DECISIONS.md — reads the REAL
  clock, stamps the zone by UTC offset (UTC-6→CST, UTC-5→CDT), prints a
  paste-ready line for a record entry. The lightweight per-decision line, NOT
  the project record. Use when: "log this decision", "decision-log", "note
  that we decided X", "record the call we just made". Zero deps.
---

# decision-log — append a dated decision line

The engine is `decision-log.js` (portable Node, zero deps). It writes a single
timestamped line per decision to a plain `DECISIONS.md`. This is deliberately
NOT the append-only project record or a handoff snapshot — those belong to a
project-memory system (see the companion `claude-project-memory` repo). It is
the lightweight one-liner you jot when a call gets made; the line it prints to
stdout is formatted to paste straight into a record entry later.

The timestamp always comes from the machine's real clock at runtime (`new
Date()`) — never a caller-supplied date — and the zone is labelled from the
`ZONES` map at the top of the script. It ships defaulted to a DST-aware US
Central rule: **UTC-6 → CST, UTC-5 → CDT**, and any other offset prints as a
literal `UTC±H:MM`. The file is append-only: existing lines are never rewritten,
and a missing file is created with a one-line header.

## Commands

```
node decision-log.js add "<decision>" [--why "<reason>"] [--file DECISIONS.md]
node decision-log.js list [--file DECISIONS.md]
node decision-log.js --canary
```

- **add** stamps the current clock and appends the line, printing it to stdout.
  Missing decision text exits 2. `--why` adds a ` (why: <reason>)` clause.
  `--file` targets a different log (default `./DECISIONS.md`).
- **list** prints every entry line (the `- ` lines) in file order.

### Examples

- **Freeze call with a reason:**
  `node decision-log.js add "keep the factor weights frozen" --why "frozen regression must stay byte-exact"`
  → `- 2026-07-21 10:37 CDT - decided: keep the factor weights frozen (why: frozen regression must stay byte-exact)`
- **Log to another project's file:**
  `node decision-log.js add "guardian consent is the hard launch gate" --file ../other-project/DECISIONS.md`
- **Review what's been decided:** `node decision-log.js list`

Copy the printed line into a project-memory record entry when you next append
the record — that is the intended handoff between the two.

## Setting your timezone

Zone labelling is one clearly-commented const at the top of `decision-log.js`:

```
const ZONES = { 360: "CST", 300: "CDT" };
```

The keys are `getTimezoneOffset()` minutes (minutes to ADD to local time to
reach UTC, so a zone BEHIND UTC is POSITIVE): UTC-6 → 360, UTC-5 → 300. It
defaults to US Central. Edit the map for your timezone — e.g. `{ 0: "UTC" }`,
or `{ 480: "PST", 420: "PDT" }` for US Pacific. Any offset not listed falls
back to a literal `UTC±H:MM` label, so the tool still works unedited anywhere.

## Windows notes

- **PowerShell 5.1:** quote the decision and reason as whole double-quoted
  arguments: `add "adopt GitHub Flow" --why "cleaner PR history"`. PS 5.1 has no
  `&&`/`||`/ternary, but this is a single command so that does not bite.
- Node writes the file as UTF-8 directly — do NOT pipe through `Set-Content`
  (it defaults to the ANSI codepage and would mangle a `—` or non-ASCII text).

## Storage

A single append-only `DECISIONS.md` (default in the cwd; override with `--file`).
One header line, then one `- ...` line per decision. Commit it if you want the
decisions in version history.

## Exit codes

`0` ok · `1` canary failure · `2` usage error (missing decision text / unknown command / unwritable or invalid `--file` path).

## Verification (the done-check)

```
node decision-log.js --canary
```

Self-tests both directions in a throwaway temp file: a valid `add` writes a
well-formed line whose date equals the system date and whose zone label matches
the current UTC offset (recomputed independently in the canary from the same
`ZONES` map), `--why` appears only when given, a second `add` appends without
disturbing the first line, and missing decision text exits 2 without creating a
file. MUST print `CANARY PASS n/n` before you trust a result.

`node decision-log.js --canary` — MUST print `CANARY PASS 29/29` before you trust a result.

## ASCII-only markdown (rule added 2026-09-23)

Every `.md` file this skill creates or writes to gets ASCII characters only
(bytes 0x00-0x7F) in the text you add. No exceptions for headings, tables,
quotes, names or pasted tool output.

- Dashes: `-` (never an en or em dash). Arrows: `->` and `<-`. Quotes:
  straight `"` and `'`. Ellipsis: `...`. Math: `x`, `+/-`, `<=`, `>=`, `~`.
  Separators: `-`, `;` or `|`. No emoji, no check-mark glyphs (use `[x]` and
  `[ ]`), no accented letters: transliterate names and quoted text.
- Check before saving. In a git repo,
  `git diff -U0 -- <file> | grep -v '^+++' | grep '^+' | grep -nP '[^\x00-\x7F]'`
  must print nothing. For a new or untracked file,
  `grep -nP '[^\x00-\x7F]' <file>` must print nothing.
- Leave non-ASCII in text you did not write. Earlier entries of an
  append-only record stay byte for byte; converting an existing file is a
  separate, explicit job.
