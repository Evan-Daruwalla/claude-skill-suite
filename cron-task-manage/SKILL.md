---
name: cron-task-manage
description: >
  Windows scheduled-task auditor, READ-ONLY execution always — the only thing it
  ever shells out to is `schtasks /query`. audit (default) parses the CSV task
  list and flags the unhealthy ones: Last Result != 0 (with the code), Disabled
  state, and — for an ENABLED task — a Next Run Time that is N/A or already in the
  past. Scope defaults to non-Microsoft tasks (--all / --like <substr> to widen or
  narrow). plan mode PRINTS the exact `schtasks /create` line for you to run
  yourself; the tool NEVER runs /create, /delete, or /change. Use when the user
  says "audit my scheduled tasks", "did the scheduled task run", "why did the
  rebalance task fail", "check the cron/scheduled job", "is that task disabled",
  "what's the schtasks command to create X", "cron-task-manage". --fixture parses a
  saved query capture offline. Deterministic, zero dependencies, no model calls.
---

# cron-task-manage — Windows scheduled-task auditor (read-only)

The engine is `cron-audit.js` (portable Node, zero deps). Windows Task Scheduler
is where unattended jobs live — a **monthly rebalance** or nightly sync running as
a scheduled task is invisible when it silently stops, until you go looking. This
tool goes looking: it runs `schtasks /query /fo csv /v`, parses the CSV (quoted
fields with embedded commas and all), and flags the tasks that are failing,
disabled, or overdue. It is **read-only by construction** — the single place it
shells out (`runQuery`) only ever calls `/query`. To create a task, `plan` mode
hands you the exact `/create` line to run yourself; the tool never executes
`/create`, `/delete`, or `/change`.

Why it earns its place: a scheduled `.bat` is a commonly booby-trapped surface —
one non-ASCII byte silently corrupts the whole batch parse, and a stray root file
shadowing a builtin (`ECHO`, `12`) breaks it too. When those fail, the task's
**Last Result** goes non-zero while everything *looks* fine. This surfaces the
non-zero code; pair it with your own Windows-failure runbook to triage the
garbled-`.bat` root cause.

## Commands

```
node cron-audit.js [audit] [--all | --like <substr>] [--fixture <csv>]
node cron-audit.js plan --name <name> --schedule <TYPE[@HH:MM]> --command "<cmd>"
node cron-audit.js --canary
```

- **audit** (the default — bare `node cron-audit.js` runs it) queries every task,
  filters to non-Microsoft by default, and prints a table. A leading `!` marks a
  flagged row; the FLAGS column says why. Exit 1 if anything is flagged, else 0.
- **--all** includes `\Microsoft\` OS tasks; **--like <substr>** narrows to task
  names containing the substring (case-insensitive), e.g. `--like trading`.
- **--fixture <csv>** parses a saved `schtasks /query /fo csv /v` capture offline
  (no shell-out at all) — useful for triaging a capture from another machine.
- **plan** PRINTS a `schtasks /create` line and exits; it runs nothing. `TYPE` is
  one of MINUTE/HOURLY/DAILY/WEEKLY/MONTHLY/ONCE/ONSTART/ONLOGON/ONIDLE; append
  `@HH:MM` for a start time.

### What gets flagged

| Condition | Flag | Note |
|---|---|---|
| `Last Result` != 0 | `Last Result <code>` | shows the raw code (decimal or `0x…`); the corrupted-`.bat` symptom |
| task is Disabled | `Disabled` | via the `Scheduled Task State` column (or `Status`) |
| Enabled + Next Run = `N/A` | `next-run N/A (enabled)` | an enabled task with nothing scheduled next |
| Enabled + Next Run in the past | `next-run in past: <when>` | overdue / the schedule stopped advancing |

Disabled tasks are never flagged for their `N/A` next-run — that's expected.

### Examples

- **Did the monthly rebalance job run clean?**
  `node cron-audit.js audit --like rebalance` — a non-zero `Last Result` on
  `\Backup\monthly_rebalance` means the scheduled `.bat` failed; check for a
  non-ASCII byte or a builtin-shadowing root file.
- **Full non-Microsoft sweep:** `node cron-audit.js` — every non-OS task with its
  state, last result, and next run; exit 1 if any are unhealthy (usable in a check).
- **Triage a capture from elsewhere:** save `schtasks /query /fo csv /v > tasks.csv`
  on the box, then `node cron-audit.js audit --fixture tasks.csv` offline.
- **Get the create line for a new job (you run it):**
  `node cron-audit.js plan --name MonthlyRebalance --schedule MONTHLY@03:00 --command "C:\Scripts\rebalance.bat"`
  prints the exact `schtasks /create …`; review and run it in your own shell, then
  re-audit to confirm it registered.

## Windows notes

- **PowerShell 5.1:** wrap `--command` and the `--like` substring in double quotes.
  PS 5.1 has no `&&`/`||`; run the printed `/create` line on its own.
- `plan` refuses a `--command` containing a `"` — schtasks `/tr` quoting turns
  ambiguous; simplify the command or edit the printed line by hand.
- Windows only (needs `schtasks`). `--fixture` mode works anywhere Node runs.

## Storage / output

Nothing is written. `audit` prints a table + a one-line summary to stdout; the
flag detail goes to stderr. `fixture.csv` ships with the skill as a sample capture
(one healthy, one failing `0x1`, one disabled, one `\Microsoft\` task) for
`--fixture` demos.

## Exit codes

`0` clean · `1` flags found / canary failure · `2` usage error (bad args, missing
fixture, non-Windows without `--fixture`).

## Verification (the done-check)

```
node cron-audit.js --canary
```

Self-tests both directions in a throwaway temp dir: a mixed fixture flags **exactly
2** (a failing `Last Result` + a Disabled task) and exits 1, a healthy-only fixture
flags **0** and exits 0 — plus past-next-run detection, scope filtering, quoted-comma
CSV parsing, plan-mode printing, and a live smoke that real `schtasks /query` parses
to >= 0 tasks without crashing. MUST print `CANARY PASS n/n` before you trust a run.
