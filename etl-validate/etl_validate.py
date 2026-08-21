#!/usr/bin/env python3
"""etl-validate — read-only source-vs-target assertion after a data transform/copy.

A copy that ran is not a copy that landed; this asserts the target equals the
source, deterministically and order-independently:
  1. ROW COUNT: src count == dst count.
  2. CONTENT CHECKSUM: serialize each row's selected columns as tab-joined UTF-8
     and sha256 each row, then combine the row hashes TWO ways — both must match:
       - XOR of every row hash: order-independent by construction, O(1) memory.
       - sha256 over the SORTED list of row hashes: order-independent too, but
         multiplicity-sensitive. XOR alone cancels any row appearing an even
         number of times, so two endpoints could share a row count and an XOR
         while sharing almost no rows (audit 2026-08-20: PASS on a copy holding
         1 of 3 source rows). The row count does not cover that case.
     Default columns = the columns common to both endpoints (sorted); --cols overrides.
  3. --key <col> (optional): list key values present in src but missing from dst
     (first 10) — turns a bare count/checksum mismatch into named rows.

Endpoints (same grammar for --src and --dst):
  csv:<path>              a CSV file (first row = header)
  sqlite:<db>:<table>     a table in a SQLite DB (opened mode=ro, read-only)

Read-only toward the world: SQLite is opened `?mode=ro`, CSV is only read.
Exit codes: 0 = PASS (all match) · 1 = FAIL (any mismatch) · 2 = usage error.

Usage:
  python etl_validate.py --src <endpoint> --dst <endpoint> [--cols a,b,c] [--key id]
  python etl_validate.py --canary
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import os
import sqlite3
import sys
import tempfile
from typing import NamedTuple


# ---- endpoint parsing ------------------------------------------------------
# An endpoint is ("csv", path, None) or ("sqlite", db_path, table). The sqlite
# form is split from the RIGHT once so a Windows drive letter (D:\...) survives:
# "sqlite:D:\var\trades.db:price_cache" -> db="D:\var\trades.db" table="price_cache".
def parse_endpoint(spec: str, which: str) -> tuple[str, str, str | None]:
    if spec.startswith("csv:"):
        path = spec[4:]
        if not path:
            raise ValueError(f"{which}: empty csv path (use csv:<path>)")
        return ("csv", path, None)
    if spec.startswith("sqlite:"):
        db, sep, table = spec[7:].rpartition(":")
        if not sep or not db or not table:
            raise ValueError(f"{which}: bad sqlite endpoint (use sqlite:<db>:<table>)")
        return ("sqlite", db, table)
    raise ValueError(f"{which}: unknown endpoint '{spec}' (use csv:<path> or sqlite:<db>:<table>)")


# ---- helpers ---------------------------------------------------------------
def norm_val(v) -> str:
    # deterministic cross-format cell rendering: NULL -> "", bytes -> utf-8,
    # numbers/text -> str(). A CSV "123" and a SQLite INTEGER 123 both render "123";
    # a NULL and an empty CSV field both render "". Numeric formatting (e.g. 1.0 vs
    # "1") can still differ across formats — pin such columns with --cols and expect it.
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace")
    return str(v)


def esc_cell(s: str) -> str:
    # Make the tab-join injective: escape backslash first, then tab, so a literal
    # tab inside a cell value can never masquerade as the column delimiter. Without
    # this, ("x", "y\tz") and ("x\ty", "z") both serialize to "x\ty\tz" and collide,
    # false-passing the checksum on genuinely different data. Backslash is escaped
    # first so the mapping is reversible (\ -> \\, TAB -> \t).
    return s.replace("\\", "\\\\").replace("\t", "\\t")


def get_columns(ep: tuple[str, str, str | None], which: str) -> list[str]:
    kind, a, b = ep
    if kind == "csv":
        if not os.path.isfile(a):
            raise ValueError(f"{which}: csv not found: {a}")
        with open(a, "r", encoding="utf-8-sig", newline="") as fh:
            header = next(csv.reader(fh), None)
        if not header:
            raise ValueError(f"{which}: csv has no header row: {a}")
        return header
    # sqlite
    if not os.path.isfile(a):
        raise ValueError(f"{which}: sqlite db not found: {a}")
    con = sqlite3.connect(f"file:{_uri(a)}?mode=ro", uri=True)
    try:
        info = con.execute(f'PRAGMA table_info("{b}")').fetchall()
        if not info:
            raise ValueError(f"{which}: table '{b}' not found (or empty schema) in {a}")
        return [r[1] for r in info]
    finally:
        con.close()


def _uri(path: str) -> str:
    # file: URIs want forward slashes even on Windows.
    return path.replace("\\", "/")


def scan(ep: tuple[str, str, str | None], cols: list[str], key: str | None):
    """Stream the endpoint once. Returns (count, xor_digest_bytes, key_set).

    key_set is None when key is None (avoids holding keys in memory needlessly)."""
    acc = bytearray(32)
    count = 0
    keys: set | None = set() if key else None
    kind, a, b = ep

    # XOR is order-independent, which is the property this tool needs — and it is
    # ALSO multiplicity-blind, which the row count does NOT cover. A row hash
    # XORed twice cancels to zero, so any row appearing an even number of times
    # is invisible. Measured 2026-08-20:
    #   src = [login/alice, login/alice, logout/bob]
    #   dst = [logout/bob, purchase/mallory, purchase/mallory]
    # -> count 3 = 3 MATCH, checksum 0d729282de28 = 0d729282de28 MATCH,
    #    RESULT: PASS, exit 0 -- on a copy sharing exactly ONE of three rows.
    # For a tool whose one job is "prove every row moved", a confident PASS over
    # a destroyed transfer is the worst failure available to it.
    #
    # A sorted-multiset digest is order-independent AND multiplicity-sensitive.
    # Both are computed and both must match. The XOR is kept because it is O(1)
    # in memory and still the right primitive for the streaming case.
    row_hashes: list[bytes] = []

    def fold(rowdict):
        nonlocal count
        count += 1
        joined = "\t".join(esc_cell(norm_val(rowdict[c])) for c in cols)
        d = hashlib.sha256(joined.encode("utf-8")).digest()
        for i in range(32):
            acc[i] ^= d[i]
        row_hashes.append(d)
        if keys is not None:
            keys.add(norm_val(rowdict[key]))

    if kind == "csv":
        with open(a, "r", encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                fold(row)
    else:
        con = sqlite3.connect(f"file:{_uri(a)}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            for row in con.execute(f'SELECT * FROM "{b}"'):
                fold(row)
        finally:
            con.close()
    # sorted, then hashed: order-independent like the XOR, but a row present
    # twice on one side and not the other changes the digest.
    ms = hashlib.sha256()
    for d in sorted(row_hashes):
        ms.update(d)
    return count, bytes(acc), keys, ms.digest()


class Result(NamedTuple):
    cols: list[str]
    src_count: int
    dst_count: int
    src_sum: bytes
    dst_sum: bytes
    src_ms: bytes    # sorted-multiset digest: catches duplicate-row cancellation
    dst_ms: bytes
    missing: list[str] | None  # src keys absent from dst (capped), or None if no --key
    missing_total: int

    @property
    def count_ok(self) -> bool:
        return self.src_count == self.dst_count

    @property
    def sum_ok(self) -> bool:
        # BOTH digests. XOR alone cancels a row that appears an even number
        # of times, so it PASSED a copy sharing 1 of 3 rows (audit 2026-08-20).
        return self.src_sum == self.dst_sum and self.src_ms == self.dst_ms

    @property
    def ok(self) -> bool:
        return self.count_ok and self.sum_ok and not self.missing_total


def compare(src_ep, dst_ep, cols_arg: str | None, key: str | None) -> Result:
    src_cols = get_columns(src_ep, "src")
    dst_cols = get_columns(dst_ep, "dst")

    if cols_arg:
        cols = [c.strip() for c in cols_arg.split(",") if c.strip()]
        for c in cols:
            if c not in src_cols:
                raise ValueError(f"--cols: '{c}' not in src columns {src_cols}")
            if c not in dst_cols:
                raise ValueError(f"--cols: '{c}' not in dst columns {dst_cols}")
    else:
        cols = sorted(set(src_cols) & set(dst_cols))
        if not cols:
            raise ValueError(f"no columns common to src {src_cols} and dst {dst_cols} — pass --cols")

    if key is not None:
        if key not in src_cols:
            raise ValueError(f"--key: '{key}' not in src columns {src_cols}")
        if key not in dst_cols:
            raise ValueError(f"--key: '{key}' not in dst columns {dst_cols}")

    src_count, src_sum, src_keys, src_ms = scan(src_ep, cols, key)
    dst_count, dst_sum, dst_keys, dst_ms = scan(dst_ep, cols, key)

    missing = None
    missing_total = 0
    if key is not None:
        miss = sorted(src_keys - dst_keys)  # type: ignore[operator]
        missing_total = len(miss)
        missing = miss[:10]
    return Result(cols, src_count, dst_count, src_sum, dst_sum, src_ms, dst_ms,
                  missing, missing_total)


def print_result(src_spec: str, dst_spec: str, r: Result, key: str | None) -> None:
    print(f"etl-validate")
    print(f"  src: {src_spec}")
    print(f"  dst: {dst_spec}")
    print(f"  cols compared ({len(r.cols)}): {', '.join(r.cols)}")
    print(f"  row count:  src={r.src_count}  dst={r.dst_count}  "
          f"{'MATCH' if r.count_ok else 'MISMATCH'}")
    xor_ok = r.src_sum == r.dst_sum
    ms_ok = r.src_ms == r.dst_ms
    print(f"  checksum:   src={r.src_sum[:6].hex()}  dst={r.dst_sum[:6].hex()}  "
          f"{'MATCH' if xor_ok else 'MISMATCH'}")
    print(f"  multiset:   src={r.src_ms[:6].hex()}  dst={r.dst_ms[:6].hex()}  "
          f"{'MATCH' if ms_ok else 'MISMATCH'}")
    if xor_ok and not ms_ok:
        # Name the mechanism, because this is the case the XOR alone called PASS.
        print("              ^ the XOR agrees but the multiset does not: rows differ "
              "in MULTIPLICITY (a row present an even number of times cancels out "
              "of an XOR). Use --key to name them.")
    if key is not None:
        if r.missing_total:
            shown = ", ".join(r.missing or [])
            more = f" (+{r.missing_total - len(r.missing or [])} more)" if r.missing_total > len(r.missing or []) else ""
            print(f"  key '{key}':  {r.missing_total} src key(s) missing from dst: [{shown}]{more}")
        else:
            print(f"  key '{key}':  no src keys missing from dst")
    print(f"RESULT: {'PASS' if r.ok else 'FAIL'}")


# ---- canary: the self-test AND the done-check ------------------------------
# Proves BOTH directions in a throwaway temp dir: a complete CSV->SQLite copy
# PASSES, and dropping one dst row is CAUGHT (count + checksum mismatch, and the
# --key names the dropped row). Everything confined to a tempfile.mkdtemp dir.
def run_canary() -> int:
    root = tempfile.mkdtemp(prefix="etl-validate-canary-")
    passed = 0
    total = 0

    def check(cond, label):
        nonlocal passed, total
        total += 1
        if cond:
            passed += 1
        else:
            print(f"  FAIL: {label}", file=sys.stderr)

    try:
        rows = [
            ("1", "alpha", "10.5"),
            ("2", "bravo", "20.0"),
            ("3", "charlie", "30.25"),
            ("4", "delta", "40.0"),
            ("5", "echo", "50.75"),
        ]
        csv_path = os.path.join(root, "src.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["id", "name", "val"])
            w.writerows(rows)

        db_path = os.path.join(root, "dst.db")
        con = sqlite3.connect(db_path)
        con.execute("CREATE TABLE t (id TEXT, name TEXT, val TEXT)")
        con.executemany("INSERT INTO t VALUES (?,?,?)", rows)
        con.commit()
        con.close()

        src = ("csv", csv_path, None)
        dst = ("sqlite", db_path, "t")

        # (a) complete copy -> PASS, counts+checksum match
        r = compare(src, dst, None, "id")
        check(r.ok, "complete copy -> PASS")
        check(r.count_ok and r.src_count == 5, "complete copy row counts equal (5)")
        check(r.sum_ok, "complete copy checksum equal")
        check(r.missing_total == 0, "complete copy no missing keys")
        check(r.cols == ["id", "name", "val"], "default cols = sorted common columns")

        # (b) drop one dst row -> FAIL: count + checksum mismatch, key named
        con = sqlite3.connect(db_path)
        con.execute("DELETE FROM t WHERE id='3'")
        con.commit()
        con.close()
        r2 = compare(src, dst, None, "id")
        check(not r2.ok, "dropped row -> FAIL")
        check(not r2.count_ok and r2.src_count == 5 and r2.dst_count == 4, "count mismatch 5 vs 4")
        check(not r2.sum_ok, "checksum mismatch after drop")
        check(r2.missing == ["3"], "missing key '3' named")

        # (c) same rows re-inserted in different order still checksum-MATCH
        # (proves XOR order-independence). Re-add id=3, then shuffle by rebuilding.
        con = sqlite3.connect(db_path)
        con.execute("DELETE FROM t")
        con.executemany("INSERT INTO t VALUES (?,?,?)", list(reversed(rows)))
        con.commit()
        con.close()
        r3 = compare(src, dst, None, "id")
        check(r3.ok and r3.sum_ok, "re-ordered copy still MATCHes (XOR order-independent)")

        # (c2) 2026-08-20 audit: DUPLICATE-ROW CANCELLATION.
        # A row hash XORed twice cancels to zero, so two endpoints can share the
        # same row count AND the same XOR while sharing almost no rows. Measured
        # before the fix: src=[login/alice x2, logout/bob], dst=[logout/bob,
        # purchase/mallory x2] -> count 3=3 MATCH, checksum MATCH, RESULT: PASS,
        # exit 0, on a copy that lost 2 of 3 rows. The row count does not cover
        # this, despite the docstring implying it does.
        dup_src = os.path.join(root, "dup_src.csv")
        dup_dst = os.path.join(root, "dup_dst.csv")
        with open(dup_src, "w", encoding="utf-8", newline="") as fh:
            fh.write("id,name,val\n1,login,alice\n1,login,alice\n2,logout,bob\n")
        with open(dup_dst, "w", encoding="utf-8", newline="") as fh:
            fh.write("id,name,val\n2,logout,bob\n3,purchase,mallory\n3,purchase,mallory\n")
        rdup = compare(("csv", dup_src, None), ("csv", dup_dst, None), None, None)
        check(rdup.count_ok, "duplicate case: row counts DO match (3 vs 3)")
        check(rdup.src_sum == rdup.dst_sum, "duplicate case: the XOR alone still agrees")
        check(rdup.src_ms != rdup.dst_ms, "duplicate case: the MULTISET digest disagrees")
        check(not rdup.sum_ok, "duplicate case: sum_ok is False (both digests required)")
        check(not rdup.ok, "duplicate case: overall FAIL, not PASS")
        # ...and multiplicity-identical data still passes, so the new digest is
        # not simply refusing everything.
        dup_same = os.path.join(root, "dup_same.csv")
        with open(dup_same, "w", encoding="utf-8", newline="") as fh:
            fh.write("id,name,val\n2,logout,bob\n1,login,alice\n1,login,alice\n")
        rsame = compare(("csv", dup_src, None), ("csv", dup_same, None), None, None)
        check(rsame.ok, "same rows incl. duplicates, re-ordered -> still PASS")

        # (d) --cols subset still validates, and a bad col is a usage error
        r4 = compare(src, dst, "id,name", None)
        check(r4.ok and r4.cols == ["id", "name"], "--cols subset validates")
        try:
            compare(src, dst, "nope", None)
            check(False, "bad --cols raises")
        except ValueError:
            check(True, "bad --cols raises")

        # (e) delimiter injection: two DIFFERENT row-tuples that share the same
        # tab-delimited byte string must NOT collide. ("x","y\tz") vs ("x\ty","z")
        # both naively serialize to "x\ty\tz"; escaping must make them differ.
        inj_a = os.path.join(root, "inj_a.csv")
        inj_b = os.path.join(root, "inj_b.csv")
        with open(inj_a, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["a", "b"])
            w.writerow(["x", "y\tz"])
        with open(inj_b, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["a", "b"])
            w.writerow(["x\ty", "z"])
        r5 = compare(("csv", inj_a, None), ("csv", inj_b, None), None, None)
        check(not r5.sum_ok, "delimiter injection: different rows -> checksum MISMATCH")
        check(not r5.ok, "delimiter injection: FAIL, not false-pass")

    finally:
        for dp, _, fnames in os.walk(root, topdown=False):
            for fn in fnames:
                try:
                    os.unlink(os.path.join(dp, fn))
                except OSError:
                    pass
        try:
            os.rmdir(root)
        except OSError:
            pass

    if passed == total:
        print(f"CANARY PASS {passed}/{total}")
        return 0
    print(f"CANARY FAIL {passed}/{total}", file=sys.stderr)
    return 1


# ---- main ------------------------------------------------------------------
def main() -> int:
    if "--canary" in sys.argv[1:]:
        return run_canary()

    ap = argparse.ArgumentParser(prog="etl_validate.py", add_help=True,
                                 description="Read-only source-vs-target assertion after a data copy/transform.")
    ap.add_argument("--src", required=True, help="source endpoint: csv:<path> | sqlite:<db>:<table>")
    ap.add_argument("--dst", required=True, help="target endpoint: csv:<path> | sqlite:<db>:<table>")
    ap.add_argument("--cols", default=None, help="comma-separated columns to checksum (default: all common columns, sorted)")
    ap.add_argument("--key", default=None, help="key column; report src keys missing from dst (first 10)")
    ap.add_argument("--canary", action="store_true", help="run the self-test and exit")
    args = ap.parse_args()

    try:
        src_ep = parse_endpoint(args.src, "src")
        dst_ep = parse_endpoint(args.dst, "dst")
        r = compare(src_ep, dst_ep, args.cols, args.key)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except (sqlite3.Error, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    print_result(args.src, args.dst, r, args.key)
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())
