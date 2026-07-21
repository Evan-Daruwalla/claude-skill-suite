---
name: data-integrity-audit
description: >
  Read-only SQLite integrity audit — no dependencies, no writes, no model calls.
  Opens a database READ-ONLY (file: URI mode=ro) and runs three checks: PRAGMA
  integrity_check (structural corruption), PRAGMA foreign_key_check (SQLite's own
  dangling-FK sweep), and explicit orphan detection that counts child rows whose
  foreign-key value has no parent — catching orphans even when foreign_keys
  enforcement was OFF at insert time. Reports per-check PASS/FAIL with row counts
  and the first 5 offending rowids; exit 1 on any failure. Use when the user says
  "audit the database", "check DB integrity", "find orphaned rows", "foreign key
  check", "is the SQLite file corrupt", "data-integrity-audit", or before trusting
  a SQLite DB that a process may have written with FK enforcement off.
---

# data-integrity-audit — read-only SQLite integrity audit

The engine is `integrity_audit.py` (Python 3 stdlib, `sqlite3` only, zero deps).
It opens a database strictly READ-ONLY through a `file:…?mode=ro` URI — the file
is never created, written, or write-locked — and runs three independent checks,
each reporting PASS/FAIL with a row count and the first 5 offending rowids:

1. **`PRAGMA integrity_check`** — page/index/row structural corruption.
2. **`PRAGMA foreign_key_check`** — SQLite's built-in dangling-FK sweep.
3. **orphan detection** — for every FK constraint in every table's `PRAGMA
   foreign_key_list`, counts child rows whose FK tuple has no matching parent.
   Multi-column (composite) FKs are matched as a **tuple**, not column-by-column,
   so a row whose individual values each appear in the parent but whose
   combination does not is still caught; constraints are counted by distinct FK
   id, not by column. This holds even when `PRAGMA foreign_keys` enforcement was
   OFF at INSERT time (SQLite defaults enforcement off per-connection), so bad
   data already at rest is found. A NULL in any FK column satisfies the
   constraint (MATCH SIMPLE) and is not counted as a violation.

## Target class: application SQLite databases

The intended targets are your application's own SQLite databases — a cache,
backtest/result DB, or any embedded store a process writes to on a schedule.
Two hard rules:

- **NEVER run this against a DB that a writer process is mid-write on.** If a
  scheduled job or long-running process holds the DB, audit only when no writer
  is live — even a read-only open takes a shared lock and can read a
  half-written transaction as "current." Read-only mode protects the *file*,
  not your interpretation of a live write.
- The audit is **read-only by design** — it will never repair. On a FAIL, capture
  the output and hand the fix to a writer path under your own test discipline
  (any frozen/regression assertions must still hold after the fix).

## Commands

```
python integrity_audit.py --db <path>   # audit one DB, opened read-only
python integrity_audit.py --canary      # self-test (the done-check)
python integrity_audit.py --help
```

- **`--db <path>`** prints a header line (db + local timestamp), one line per
  check (`[PASS]`/`[FAIL]` + row count; orphan line also notes how many FK
  constraints were scanned), offending rowids under any FAIL, and a final
  `RESULT: PASS|FAIL`. Exit 1 if any check failed.

### Example

```
$ python integrity_audit.py --db /var/data/price_cache.db
data-integrity-audit  db=/var/data/price_cache.db  2026-07-21 10:38:04
------------------------------------------------------------
[PASS] integrity_check     rows=0
[PASS] foreign_key_check   rows=0
[FAIL] orphan_detection    rows=3 (2 FK constraint(s) scanned)
       - prices.symbol_id -> symbols.id: 3 orphan(s), rowids [4192, 4193, 4198]
------------------------------------------------------------
RESULT: FAIL
```

## Postgres — documented queries, NOT executed

This skill is SQLite-only; it does not touch Postgres. If your stack is
FastAPI/Postgres (or similar) and holds sensitive user data, run these
equivalents by hand via `psql` when you need the same audit there (read-only
session, off-peak):

```sql
-- 1. structural integrity: Postgres has no PRAGMA integrity_check.
--    Nearest read-only checks:
--    per-table heap/index consistency (superuser, needs the amcheck extension):
--      CREATE EXTENSION IF NOT EXISTS amcheck;
--      SELECT bt_index_check(c.oid)
--      FROM pg_class c JOIN pg_am a ON a.oid = c.relam
--      WHERE a.amname = 'btree' AND c.relkind = 'i';

-- 2. dangling foreign keys — one query per FK. Enumerate FKs first:
SELECT conrelid::regclass  AS child,
       confrelid::regclass AS parent,
       conname
FROM   pg_constraint
WHERE  contype = 'f';

-- 3. orphan count for a given FK (child.col -> parent.pk), enforcement-independent:
SELECT count(*) AS orphans
FROM   child c
LEFT   JOIN parent p ON p.id = c.parent_id
WHERE  c.parent_id IS NOT NULL
AND    p.id IS NULL;
```

These are **documentation only** — nothing here executes them. Treat any output as
potentially sensitive and handle under your project's data rules.

## Windows notes

- Runs under both PowerShell 5.1 and Git Bash; no shell-chaining/quoting traps —
  a single `--db <path>` argument, forward or back slashes both accepted (the
  script absolutizes and normalizes to a `file:` URI internally).
- Read-only open means the audit never trips the "rewriting a DB file corrupts
  it" class of hazard — it issues no writes at all.

## Storage / exit codes

Writes nothing (read-only tool). Exit codes: **0** clean · **1** any check failed
or canary failure · **2** usage error (bad flag, missing `--db` path, unopenable
file, **or a corrupt-header / non-SQLite file** — reported cleanly on stderr, no
traceback) · **3** WARN: the file is a valid but **empty / 0-byte** database (all
checks trivially pass over zero tables — surfaced so a truncated file is not
mistaken for a clean audit).

## Verification (the done-check)

```
python integrity_audit.py --canary
```

Builds three throwaway DBs in a temp dir: a **bad** one created with
`foreign_keys=OFF` plus a planted orphan child row (asserts all three checks run,
the orphan is caught with its rowid, NULL FKs are excluded, and `audit()` exits 1);
a **clean** one (asserts no orphans and exit 0); and a **composite-FK** one whose
tuple orphan `(1,4)` has each column value present in the parent but not the
combination (asserts the tuple orphan is caught, and that one composite constraint
counts as ONE, not two). Also asserts the read-only handle rejects a write. Cleans
up and prints `CANARY PASS 13/13` (exit 0) or `CANARY FAIL` (exit 1). Must pass
before you trust a result.
