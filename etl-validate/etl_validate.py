#!/usr/bin/env python3
"""etl-validate — read-only source-vs-target assertion after a data transform/copy.

A copy that ran is not a copy that landed; this asserts the target equals the
source, deterministically and order-independently:
  1. ROW COUNT: src count == dst count.
  2. CONTENT CHECKSUM: serialize each row's selected columns as tab-joined UTF-8,
     sha256 each row, XOR-combine every row hash. XOR is order-independent by
     construction, so a re-sorted rebuild still matches. Default columns = the
     columns common to both endpoints (sorted); override with --cols.
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
# "sqlite:D:\var\app.db:events" -> db="D:\var\app.db" table="events".
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

    def fold(rowdict):
        nonlocal count
        count += 1
        joined = "\t".join(esc_cell(norm_val(rowdict[c])) for c in cols)
        d = hashlib.sha256(joined.encode("utf-8")).digest()
        for i in range(32):
            acc[i] ^= d[i]
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
    return count, bytes(acc), keys


class Result(NamedTuple):
    cols: list[str]
    src_count: int
    dst_count: int
    src_sum: bytes
    dst_sum: bytes
    missing: list[str] | None  # src keys absent from dst (capped), or None if no --key
    missing_total: int

    @property
    def count_ok(self) -> bool:
        return self.src_count == self.dst_count

    @property
    def sum_ok(self) -> bool:
        return self.src_sum == self.dst_sum

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

    src_count, src_sum, src_keys = scan(src_ep, cols, key)
    dst_count, dst_sum, dst_keys = scan(dst_ep, cols, key)

    missing = None
    missing_total = 0
    if key is not None:
        miss = sorted(src_keys - dst_keys)  # type: ignore[operator]
        missing_total = len(miss)
        missing = miss[:10]
    return Result(cols, src_count, dst_count, src_sum, dst_sum, missing, missing_total)


def print_result(src_spec: str, dst_spec: str, r: Result, key: str | None) -> None:
    print(f"etl-validate")
    print(f"  src: {src_spec}")
    print(f"  dst: {dst_spec}")
    print(f"  cols compared ({len(r.cols)}): {', '.join(r.cols)}")
    print(f"  row count:  src={r.src_count}  dst={r.dst_count}  "
          f"{'MATCH' if r.count_ok else 'MISMATCH'}")
    print(f"  checksum:   src={r.src_sum[:6].hex()}  dst={r.dst_sum[:6].hex()}  "
          f"{'MATCH' if r.sum_ok else 'MISMATCH'}")
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
