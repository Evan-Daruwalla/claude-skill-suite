#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data-integrity-audit — read-only SQLite integrity audit.

Opens a SQLite DB READ-ONLY (file: URI, mode=ro — the file is never written,
locked for write, or created) and runs three checks:

  1. PRAGMA integrity_check   — page/index/row structural corruption
  2. PRAGMA foreign_key_check — SQLite's own dangling-FK sweep
  3. orphan detection         — for every FK in every table's
     PRAGMA foreign_key_list, count child rows whose FK value has no matching
     parent. This catches orphans even when `PRAGMA foreign_keys` enforcement
     was OFF at INSERT time (SQLite defaults enforcement off per-connection),
     which foreign_key_check on a pristine open would also catch — but this
     pass reports per-constraint counts + offending rowids explicitly.

Each check reports PASS/FAIL with a row count and the first 5 offending rowids.
Any failure => exit 1. Clean => exit 0.

  --db <path>   audit the database at <path> (opened read-only)
  --canary      self-test (the done-check); proves both directions
  --help        this help

Exit codes: 0 clean · 1 findings/canary-fail · 2 usage error (unopenable /
not-a-SQLite-DB / corrupt header) · 3 WARN (valid but empty/0-byte database).
Python 3 stdlib only (sqlite3). No model calls, no network, no writes.
"""
import sys
import os
import sqlite3
import tempfile
import shutil
from datetime import datetime

MAX_OFFENDERS = 5  # first N offending rowids surfaced per failing check


# ---- helpers ---------------------------------------------------------------
def open_ro(path):
    """Open <path> read-only via file: URI (mode=ro). Never creates/writes."""
    if not os.path.exists(path):
        raise FileNotFoundError("database not found: " + path)
    # nolink keeps us from being redirected through a symlink; ro is the guard.
    uri = "file:" + _uri_path(path) + "?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _uri_path(path):
    # sqlite file: URIs want forward slashes; Windows drive letters get a
    # leading slash (file:/D:/x). Absolute-ize first so relative paths resolve.
    p = os.path.abspath(path).replace("\\", "/")
    if not p.startswith("/"):
        p = "/" + p
    return p


def list_tables(conn):
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def qid(name):
    # quote an identifier for interpolation (table/column names can't be bound).
    return '"' + str(name).replace('"', '""') + '"'


# ---- checks ----------------------------------------------------------------
def check_integrity(conn):
    """PRAGMA integrity_check. 'ok' (single row) => PASS."""
    rows = conn.execute("PRAGMA integrity_check").fetchall()
    msgs = [r[0] for r in rows]
    if len(msgs) == 1 and msgs[0] == "ok":
        return {"name": "integrity_check", "ok": True, "count": 0, "detail": []}
    return {
        "name": "integrity_check",
        "ok": False,
        "count": len(msgs),
        "detail": msgs[:MAX_OFFENDERS],  # first N corruption messages
    }


def check_foreign_key(conn):
    """PRAGMA foreign_key_check. Each returned row is a violation."""
    rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    # row = (table, rowid, parent, fkid); rowid is None for WITHOUT ROWID tables.
    if not rows:
        return {"name": "foreign_key_check", "ok": True, "count": 0, "detail": []}
    detail = []
    for r in rows[:MAX_OFFENDERS]:
        tbl, rid, parent = r[0], r[1], r[2]
        detail.append("%s.rowid=%s -> missing %s" % (tbl, rid, parent))
    return {
        "name": "foreign_key_check",
        "ok": False,
        "count": len(rows),
        "detail": detail,
    }


def check_orphans(conn):
    """
    For each FK constraint (grouped across its columns), count child rows whose
    FK tuple is fully non-NULL but has no matching parent row. Works regardless
    of whether foreign_keys enforcement was on at insert time. Composite
    (multi-column) FKs are matched as a TUPLE, not column-by-column, so a row
    whose individual column values each appear somewhere in the parent but whose
    combination does not is still caught. Counts DISTINCT constraints (fk ids),
    not columns.
    Returns one aggregate check {ok,count,detail} over ALL constraints.
    """
    total = 0
    detail = []  # human-readable offenders, capped at MAX_OFFENDERS overall
    constraints = 0
    for tbl in list_tables(conn):
        fks = conn.execute("PRAGMA foreign_key_list(%s)" % qid(tbl)).fetchall()
        # PRAGMA foreign_key_list columns:
        # (id, seq, table, from, to, on_update, on_delete, match)
        # Rows sharing an id are the columns of ONE (possibly composite) FK.
        groups = {}
        order = []
        for fk in fks:
            fkid = fk[0]
            if fkid not in groups:
                groups[fkid] = {"parent": fk[2], "cols": []}
                order.append(fkid)
            groups[fkid]["cols"].append((fk[1], fk[3], fk[4]))  # (seq, from, to)
        for fkid in order:
            constraints += 1
            g = groups[fkid]
            parent_tbl = g["parent"]
            cols = sorted(g["cols"], key=lambda c: c[0])  # by seq
            from_cols = [c[1] for c in cols]
            to_cols = [c[2] for c in cols]
            # 'to' is NULL for every column when the FK targets the parent's PK.
            if any(t is None for t in to_cols):
                pk_cols = _parent_pk_cols(conn, parent_tbl)
                if pk_cols is None or len(pk_cols) != len(from_cols):
                    continue  # can't resolve target key; skip this constraint
                to_cols = pk_cols
            # child rows with a fully-non-NULL FK tuple absent from the parent.
            # A NULL in ANY FK column satisfies the constraint (MATCH SIMPLE),
            # so those rows are not violations and are excluded.
            notnull = " AND ".join("c.%s IS NOT NULL" % qid(fc) for fc in from_cols)
            join = " AND ".join(
                "p.%s = c.%s" % (qid(tc), qid(fc))
                for fc, tc in zip(from_cols, to_cols)
            )
            sql = (
                "SELECT c.rowid FROM {ct} c "
                "WHERE {nn} AND NOT EXISTS ("
                "  SELECT 1 FROM {pt} p WHERE {jn}"
                ")"
            ).format(ct=qid(tbl), nn=notnull, pt=qid(parent_tbl), jn=join)
            label_cols = "(%s)" % ",".join(from_cols)
            label_to = "(%s)" % ",".join(str(t) for t in to_cols)
            try:
                offenders = conn.execute(sql).fetchall()
            except sqlite3.Error as e:
                detail.append("%s.%s -> %s.%s: query error: %s"
                              % (tbl, label_cols, parent_tbl, label_to, e))
                continue
            n = len(offenders)
            if n:
                total += n
                rowids = [str(o[0]) for o in offenders[:MAX_OFFENDERS]]
                detail.append(
                    "%s.%s -> %s.%s: %d orphan(s), rowids [%s]"
                    % (tbl, label_cols, parent_tbl, label_to, n, ", ".join(rowids))
                )
    return {
        "name": "orphan_detection",
        "ok": total == 0,
        "count": total,
        "detail": detail[:MAX_OFFENDERS],
        "constraints": constraints,
    }


def _parent_pk_cols(conn, table):
    """PRIMARY KEY column(s) of <table> in key order, or None if absent."""
    cols = conn.execute("PRAGMA table_info(%s)" % qid(table)).fetchall()
    # (cid, name, type, notnull, dflt_value, pk); pk>0 is 1-based key position.
    pks = sorted([c for c in cols if c[5]], key=lambda c: c[5])
    if not pks:
        return None
    return [c[1] for c in pks]


# ---- runner ----------------------------------------------------------------
def audit(path):
    """Run all three checks against <path> (read-only). Returns exit code."""
    try:
        conn = open_ro(path)
    except FileNotFoundError as e:
        print("error: " + str(e), file=sys.stderr)
        return 2
    except sqlite3.Error as e:
        print("error: cannot open database read-only: " + str(e), file=sys.stderr)
        return 2

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print("data-integrity-audit  db=%s  %s" % (path, stamp))
    print("-" * 60)
    # A bad SQLite header / non-DB file opens fine (mode=ro is lazy) and only
    # throws at the first PRAGMA. Guard the checks so header/page corruption is
    # a clean usage error (exit 2), never an uncaught traceback.
    results = []
    n_tables = 0
    try:
        n_tables = len(list_tables(conn))
        results.append(check_integrity(conn))
        results.append(check_foreign_key(conn))
        results.append(check_orphans(conn))
    except sqlite3.DatabaseError as e:
        print("error: not a valid SQLite database: %s (%s)" % (path, e),
              file=sys.stderr)
        return 2
    finally:
        conn.close()

    # A 0-byte / truncated-to-empty file is a valid but EMPTY SQLite database:
    # all three checks trivially pass over zero tables. Flag it so a destroyed
    # file is not mistaken for a clean audit.
    empty = False
    try:
        empty = os.path.getsize(path) == 0
    except OSError:
        pass
    zero_tables = n_tables == 0
    if empty or zero_tables:
        print("[WARN] database is empty (0 user tables)"
              + (" / 0 bytes" if empty else ""))

    any_fail = False
    for r in results:
        status = "PASS" if r["ok"] else "FAIL"
        extra = ""
        if r["name"] == "orphan_detection":
            extra = " (%d FK constraint(s) scanned)" % r.get("constraints", 0)
        print("[%s] %-18s rows=%d%s" % (status, r["name"], r["count"], extra))
        if not r["ok"]:
            any_fail = True
            for line in r["detail"]:
                print("       - " + line)
    print("-" * 60)
    if any_fail:
        print("RESULT: FAIL")
        return 1
    if empty or zero_tables:
        print("RESULT: WARN (empty database)")
        return 3
    print("RESULT: PASS")
    return 0


# ---- canary: the self-test AND the done-check ------------------------------
def run_canary():
    """
    Prove BOTH directions in a throwaway temp dir:
      (bad)   a DB built with foreign_keys=OFF + a planted orphan child row =>
              all three checks run, orphan CAUGHT, audit exits 1.
      (good)  a clean, referentially-sound DB => audit exits 0.
    """
    tmp = tempfile.mkdtemp(prefix="data-integrity-canary-")
    passed = 0
    total = 0

    def check(cond, label):
        nonlocal passed, total
        total += 1
        if cond:
            passed += 1
        else:
            print("  FAIL: " + label, file=sys.stderr)

    try:
        # ---- BAD db: enforcement OFF at insert, planted orphan ----
        bad = os.path.join(tmp, "bad.db")
        con = sqlite3.connect(bad)
        con.execute("PRAGMA foreign_keys=OFF")  # enforcement off at insert time
        con.executescript(
            "CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);"
            "CREATE TABLE child("
            "  id INTEGER PRIMARY KEY, parent_id INTEGER,"
            "  FOREIGN KEY(parent_id) REFERENCES parent(id));"
            "INSERT INTO parent(id,name) VALUES (1,'ok');"
            "INSERT INTO child(id,parent_id) VALUES (10,1);"    # valid
            "INSERT INTO child(id,parent_id) VALUES (11,999);"  # ORPHAN
            "INSERT INTO child(id,parent_id) VALUES (12,NULL);" # NULL: not a violation
        )
        con.commit()
        con.close()

        # inspect the bad db directly (read-only) so we assert each check
        c = open_ro(bad)
        ic = check_integrity(c)
        fk = check_foreign_key(c)
        orph = check_orphans(c)
        c.close()

        check(ic["ok"], "bad db: integrity_check runs and passes structurally")
        check(orph["ok"] is False, "bad db: orphan detection CATCHES the orphan")
        check(orph["count"] == 1, "bad db: exactly 1 orphan counted (NULL FK excluded)")
        check(orph.get("constraints", 0) == 1, "bad db: 1 FK constraint scanned")
        check(any("rowids [11]" in d for d in orph["detail"]),
              "bad db: offending rowid 11 surfaced")
        # foreign_key_check on a fresh read-only open also flags the orphan
        check(fk["ok"] is False and fk["count"] == 1,
              "bad db: PRAGMA foreign_key_check flags the same orphan")
        # full audit() over the bad db exits 1
        check(audit_quiet(bad) == 1, "bad db: audit() exits 1")

        # ---- GOOD db: referentially clean ----
        good = os.path.join(tmp, "good.db")
        con = sqlite3.connect(good)
        con.execute("PRAGMA foreign_keys=OFF")
        con.executescript(
            "CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);"
            "CREATE TABLE child("
            "  id INTEGER PRIMARY KEY, parent_id INTEGER,"
            "  FOREIGN KEY(parent_id) REFERENCES parent(id));"
            "INSERT INTO parent(id,name) VALUES (1,'ok'),(2,'also');"
            "INSERT INTO child(id,parent_id) VALUES (10,1),(11,2),(12,NULL);"
        )
        con.commit()
        con.close()

        c = open_ro(good)
        orph_g = check_orphans(c)
        c.close()
        check(orph_g["ok"] is True and orph_g["count"] == 0,
              "good db: no orphans detected")
        check(audit_quiet(good) == 0, "good db: audit() exits 0")

        # ---- COMPOSITE FK: tuple orphan whose columns each exist in parent ----
        comp = os.path.join(tmp, "composite.db")
        con = sqlite3.connect(comp)
        con.execute("PRAGMA foreign_keys=OFF")
        con.executescript(
            "CREATE TABLE p(a, b, PRIMARY KEY(a,b));"
            "CREATE TABLE c(id INTEGER PRIMARY KEY, a, b,"
            "  FOREIGN KEY(a,b) REFERENCES p(a,b));"
            "INSERT INTO p VALUES (1,2),(3,4);"
            "INSERT INTO c VALUES (1,1,4);"  # (1,4): a=1 in p, b=4 in p, tuple NOT
        )
        con.commit()
        con.close()
        c = open_ro(comp)
        orph_c = check_orphans(c)
        c.close()
        # tuple match catches the orphan the column-by-column check would miss
        check(orph_c["ok"] is False and orph_c["count"] == 1,
              "composite db: tuple orphan (1,4) CAUGHT, count=1")
        # one composite constraint counted as ONE, not two (per-column)
        check(orph_c.get("constraints", 0) == 1,
              "composite db: 1 FK constraint (grouped by fk id, not columns)")
        check(any("rowids [1]" in d for d in orph_c["detail"]),
              "composite db: offending rowid 1 surfaced")

        # ---- read-only guard: a write against the ro handle must fail ----
        c = open_ro(good)
        try:
            c.execute("INSERT INTO parent(id,name) VALUES (99,'x')")
            c.commit()
            check(False, "ro handle: write was blocked")
        except sqlite3.OperationalError:
            check(True, "ro handle: write was blocked")
        finally:
            c.close()

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if passed == total:
        print("CANARY PASS %d/%d" % (passed, total))
        return 0
    print("CANARY FAIL %d/%d" % (passed, total), file=sys.stderr)
    return 1


def audit_quiet(path):
    """audit() with stdout suppressed — used by the canary to assert exit code."""
    devnull = open(os.devnull, "w")
    saved = sys.stdout
    sys.stdout = devnull
    try:
        return audit(path)
    finally:
        sys.stdout = saved
        devnull.close()


# ---- arg parsing + help ----------------------------------------------------
HELP = __doc__


def main(argv):
    if not argv or "--help" in argv or "-h" in argv:
        print(HELP)
        return 0 if argv and ("--help" in argv or "-h" in argv) else 2
    if "--canary" in argv:
        return run_canary()
    if "--db" in argv:
        i = argv.index("--db")
        if i + 1 >= len(argv):
            print("error: --db needs a path", file=sys.stderr)
            return 2
        return audit(argv[i + 1])
    print("error: unknown arguments %r. Try --help." % argv, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
