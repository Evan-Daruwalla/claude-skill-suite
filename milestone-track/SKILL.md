---
name: milestone-track
description: >
  READ-ONLY roadmap status rollup for a PRD_ROADMAP.md-style doc. Parses
  markdown checkboxes ("- [ ]"/"- [x]"), table-cell glyphs (☐/☑), ~~struck~~
  items (counted as dropped/folded, NEVER as open), and milestone headings
  ("## N.", "### M...", rows of a MILESTONES table), then rolls up per-milestone
  done/open/struck counts, an overall completion %, and the FIRST open item as
  "next:". Fork-aware: if a "## CURRENT DIRECTION" heading exists, default scope
  is that fork section only (--all covers the whole file), and the output says
  which scope it used. Use when the user says "milestone status", "roadmap
  rollup", "how much of the PRD is done", "what's next on the roadmap", "PRD
  progress", or "milestone-track". Never edits the PRD. Deterministic, zero
  dependencies, no model calls.
---

# milestone-track — roadmap status rollup

The engine is `milestone-track.js` (portable Node, zero deps). It reads a PRD in
this common markdown-roadmap format and reports, per milestone, how many status
items are done vs open vs struck, an overall completion percentage, and the
first open item to work next. It is a **report, not a gate** — it never touches
the PRD and exits 0 even when work is open. It understands two common PRD
mutation idioms: `~~struck~~` items are counted as dropped/folded (never as
open — "REMOVE by striking through in place"), and a `## CURRENT DIRECTION`
heading means only the current tree is rolled up by default ("exactly one
current direction").

## What it counts

- **Checkboxes** — `- [x]` done, `- [ ]` open (SUCCESS CRITERIA lists).
- **Table glyphs** — `☑` done, `☐` open in any table cell (e.g. the F-M0 OUTPUT
  survivors table's "built?" column).
- **Struck items** — anything wrapped in `~~...~~` (a struck checkbox or a struck
  bullet) is counted as **struck**, separately, and excluded from the done/open
  percentage denominator.
- **Milestones** — items bucket under the nearest preceding milestone marker:
  a `## N.`/`### M...` heading, or a row of a **MILESTONES** table. A heading and
  a table row that share a label (e.g. `### M1` and `| M1 | ... |`) merge into one
  bucket. Milestones with zero status items are omitted from the report.

## Commands

```
node milestone-track.js [--file <path>] [--all]
node milestone-track.js --canary
node milestone-track.js --help
```

- **default** reads `PRD_ROADMAP.md` in the current directory. If a
  `## CURRENT DIRECTION` heading exists, the rollup is scoped to that fork section
  (heading → end of file); the output line names the scope.
- **--all** ignores the fork and rolls up the entire file (both the superseded
  original tree and the current fork).
- **--file `<path>`** points at a different roadmap.
- **--canary** self-test (below).

### Examples

- **A PRD with a superseded tree and an active fork**: `node milestone-track.js`
  rolls up just the `## CURRENT DIRECTION` section — its success criteria and
  milestone tables — with the first open item as `next:`.
- **Whole-file view** including the completed original tree:
  `node milestone-track.js --all` — adds the original success-criteria bucket
  alongside the fork's.
- **A different project's PRD**: `node milestone-track.js --file /path/to/PRD_ROADMAP.md`.

## Scope & percentage semantics

- **Fork scope** (default when `## CURRENT DIRECTION` is present) = from that
  heading to EOF — deliberately NOT "until the next `##`", because the fork's own
  F1/F2/…/F-M0 sections are all `##` headings that belong to it. The report always
  prints which scope ran, so a fork rollup is never mistaken for a whole-file one.
- **Overall %** = done / (done + open). Struck items are excluded from the
  denominator (they are neither open work nor a completed criterion). A milestone
  with no done/open items shows `n/a`.

## Windows notes

- Pure Node stdlib; no shell quoting traps. Handles both `\n` and `\r\n` line
  endings, so a CRLF-saved PRD parses identically.
- Reads the file as UTF-8, so `☐`/`☑` glyphs and em-dashes are matched correctly
  (no PowerShell `Set-Content` ANSI round-trip involved — the tool only reads).

## Exit codes

`0` always — it is a report, not a gate (open work does not fail it) ·
`2` usage/parse error only (unknown flag, or a missing/unreadable `--file`).

## Verification (the done-check)

```
node milestone-track.js --canary
```

Self-tests both directions on a bundled fixture (modeled on a typical PRD: a
`## CURRENT DIRECTION` fork, `- [x]`/`- [ ]` checkboxes, a `☑`/`☐` glyph table, a
MILESTONES table whose rows merge with `### M...` headings by label, and one
`~~struck~~` item). It asserts exact per-milestone counts, correct next-item
detection, that struck items never inflate done/open, and that default (fork)
scope genuinely differs from `--all`. MUST print `CANARY PASS 16/16` before you
trust a rollup.
