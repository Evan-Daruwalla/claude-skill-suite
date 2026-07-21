---
name: etl-validate
description: >
  Read-only source-vs-target assertion after a data transform or copy — prove
  every row actually moved. Compares a CSV file or a SQLite table against another
  (--src / --dst as csv:<path> | sqlite:<db>:<table>) on two axes: row counts
  equal, and a content checksum equal (each row's selected columns tab-joined,
  sha256'd, then XOR-combined so the result is order-independent by construction).
  Optional --key <col> names the src keys missing from dst (first 10), turning a
  bare mismatch into named rows. Use when the user says "validate the copy",
  "did every row move", "verify the ETL", "source vs target check", "reconcile
  the table after a rebuild", or after a cache/table rebuild. SQLite opens
  mode=ro. Deterministic, Python stdlib only, no model calls.
---

# etl-validate — did every row actually land?

`etl_validate.py` (Python 3 stdlib only: `sqlite3`, `csv`, `hashlib`). A copy
that ran is not a copy that landed. After a transform or table rebuild this
asserts the target equals the source, deterministically and independent of row
order:

1. **Row count** — `src` count == `dst` count.
2. **Content checksum** — each row's selected columns are tab-joined as UTF-8,
   sha256'd, and every row hash is XOR-combined. Each cell's backslashes and tabs
   are escaped (`\` → `\\`, TAB → `\t`) before joining, so a literal tab inside a
   value can never masquerade as the column delimiter and make two different
   row-tuples collide. XOR is order-independent, so a re-sorted rebuild of the
   same rows still matches. Default columns = the columns common to both
   endpoints (sorted); override with `--cols`.
3. **`--key <col>`** (optional) — lists key values present in `src` but missing
   from `dst` (first 10), so a mismatch points at named rows, not just a count.

Read-only toward the world: SQLite is opened `file:...?mode=ro`, CSV is only
read. Nothing is written outside the canary's temp dir.

## Commands

```
python etl_validate.py --src <endpoint> --dst <endpoint> [--cols a,b,c] [--key id]
python etl_validate.py --canary
```

Endpoint grammar (same for `--src` and `--dst`):

```
csv:<path>              a CSV file (first row = header)
sqlite:<db>:<table>     a table in a SQLite DB, opened read-only
```

The `sqlite:` form is split from the RIGHT once, so a Windows drive letter
survives: `sqlite:D:\ClaudeCode\Trading\var\trades.db:price_cache` parses to
db=`D:\...\trades.db`, table=`price_cache`.

## Examples (grounded in real project facts)

- **Verify a price_cache rebuild moved every row** (Trading — `price_cache` is
  split-adjusted, dividend-UNadjusted; a rebuild must preserve every row).
  Dump the pre-rebuild table to CSV, rebuild, then reconcile:
  `python etl_validate.py --src csv:price_cache_before.csv --dst sqlite:D:\ClaudeCode\Trading\var\trades.db:price_cache --key symbol`
  MATCH on count and checksum means the rebuild was a faithful copy; a mismatch
  with `--key symbol` names the first 10 symbols that fell out.
- **Reconcile two SQLite tables** (e.g. a staging table vs the live one after a
  migration): `python etl_validate.py --src sqlite:staging.db:trades --dst sqlite:live.db:trades --key trade_id`.
- **Pin the columns that matter** when the two sides carry extra bookkeeping
  columns: `--cols symbol,date,close` checksums only those three.

## Cross-format notes

- Cell rendering is normalized so a CSV and a SQLite table compare fairly: NULL
  and an empty CSV field both render `""`; a SQLite `INTEGER 123` and CSV `"123"`
  both render `123`; `bytes` decode as UTF-8. **Numeric formatting can still
  differ** across formats — SQLite `REAL 1.0` renders `1.0`, a CSV that wrote
  `1` renders `1`. If a float/int column trips a false mismatch, that is the
  cause; compare CSV-to-CSV or SQLite-to-SQLite, or exclude that column via
  `--cols`.
- **XOR caveat (honest limit):** because row hashes are XOR-combined, two
  *identical* rows cancel pairwise. The checksum can therefore miss a defect that
  swaps one duplicate row for another duplicate row. The row-count check and
  `--key` mitigate this; for tables with a unique key it is a non-issue.

## Windows notes

- PowerShell 5.1: endpoints contain no shell metacharacters, but quote a `--src`
  whose path has spaces: `--src "csv:C:\my data\src.csv"`.
- Python 3 is on PATH as `python`; Trading's venv Python works too. No
  `ANTHROPIC_API_KEY` needed — this makes no model calls.

## Exit codes

`0` = PASS (row count AND checksum AND, if `--key`, no missing keys) ·
`1` = FAIL (any mismatch; details printed) · `2` = usage error (bad endpoint,
missing file/table, unknown column).

## Verification (the done-check)

```
python etl_validate.py --canary
```

Builds a temp CSV and a complete SQLite copy of it and asserts PASS (equal
counts, equal checksum, no missing keys); then drops one dst row and asserts the
mismatch is CAUGHT (count + checksum mismatch, the dropped key named); also
proves a re-ordered copy still matches (XOR order-independence), that a
`--cols` subset validates, and that a delimiter-injection pair (two different
row-tuples that share a naive tab-join) is CAUGHT rather than false-passing.
Cleans up its temp dir. MUST print `CANARY PASS 14/14` before you trust a result.
