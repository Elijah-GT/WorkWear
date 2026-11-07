#!/usr/bin/env python3
"""Sample incident history for demos: 8 incidents over the last few days, in several zones.

Every incident it adds is marked sample data and belongs to a simulated helmet (sim-01 ...
sim-03), so the dashboard labels it as sample (CLAUDE.md honesty rules). Only one is left
unreviewed ("new"); the rest are confirmed or dismissed, as if a supervisor had reviewed them.

Standard library only (plus the server's own app/db.py). Run from the server/ folder:
    python3 seed.py              # add the sample history (refuses if sample incidents exist)
    python3 seed.py --reset      # back up the database, delete ALL sample incidents, then add
    python3 seed.py --db other.db

--reset deletes every incident marked sample (for example falls from the simulator's
--fall-every), and their raw fall events. Real helmet data is never touched. Before deleting,
it saves a copy of the whole database next to it: workwear.db.bak-YYYYMMDD-HHMMSS.
"""

import argparse
import sqlite3
import sys
from datetime import timedelta
from pathlib import Path

from app import db

# (days ago, hours ago, type, device, zone, peak_g, status, notes, delayed)
# Zone IDs are the ones in dashboard/zones.json. 1520 North gets 3 confirmed incidents so the
# map shows its darkest shade; 1520 South has only a dismissed and a new one, so it stays clear.
HISTORY = [
    (3, 6.0, "fall", "sim-01", "1520-N", 4.8, "confirmed", "Slipped on a cable cover. Checked by the first aider, back to work.", False),
    (3, 1.5, "injury_report", "sim-02", "1533", None, "confirmed", "Cut hand on a sheet metal edge. First aid given.", False),
    (2, 7.0, "fall", "sim-03", "1520-N", 3.9, "confirmed", "", False),
    (2, 2.0, "fall", "sim-02", "1520-S", 5.6, "dismissed", "Helmet knocked off a bench, nobody was wearing it.", False),
    (1, 5.0, "hazard_report", "sim-01", "1522", None, "confirmed", "Wet floor by the sink.", False),
    (1, 1.0, "fall", "sim-01", "1520-W", 4.2, "confirmed", "", True),
    (0, 26.0, "fall", "sim-03", "1520-N", 6.4, "confirmed", "Tripped over a pallet edge on the stairs side.", False),
    (0, 2.0, "fall", "sim-03", "1520-S", 6.1, "new", "", False),
]


def sample_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM incidents WHERE sample = 1").fetchone()[0]


def backup(path: Path) -> Path:
    """Copy the whole database (consistent even while the server is running)."""
    stamp = db.now().astimezone().strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(f"{path.name}.bak-{stamp}")
    src = sqlite3.connect(path)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return dest


def delete_sample(conn: sqlite3.Connection) -> int:
    """Delete every incident marked sample, and the raw fall events that point at them."""
    conn.execute("DELETE FROM events WHERE incident_id IN (SELECT id FROM incidents WHERE sample = 1)")
    return conn.execute("DELETE FROM incidents WHERE sample = 1").rowcount


def add_history(conn: sqlite3.Connection) -> list[int]:
    now = db.now()
    ids = []
    # Oldest first, so incident IDs go up with time like they do for real ones.
    rows = sorted(HISTORY, key=lambda r: -(r[0] * 24 + r[1]))
    for days, hours, kind, device_id, zone, peak_g, status, notes, delayed in rows:
        ts = db.format_ts(now - timedelta(days=days, hours=hours))
        device = db.ensure_device(conn, device_id, ts)
        ids.append(db.insert_incident(conn, {
            "device_id": device_id,
            "worker_name": device["name"],  # snapshot of the helmet's name, like real incidents
            "type": kind,
            "ts": ts,
            "zone": zone,
            "zone_source": "manual",  # sample location, set by hand: labeled simulated
            "lat": None,
            "lon": None,
            "peak_g": peak_g,
            "status": status,
            "notes": notes,
            "delayed": int(delayed),
            "sample": 1,
        }))
    return ids


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Add sample incident history (marked sample data).")
    p.add_argument("--db", type=Path, default=None, help="database file (default: $WORKWEAR_DB or server/workwear.db)")
    p.add_argument("--reset", action="store_true",
                   help="back up the database, then delete ALL sample incidents before adding the history")
    args = p.parse_args(argv)

    path = args.db or db.db_path()
    db.init_db(path)
    conn = db.connect(path)
    try:
        existing = sample_count(conn)
        if existing and not args.reset:
            print(f"{path} already has {existing} sample incidents. Run with --reset to replace them "
                  "(a backup is made first).", file=sys.stderr)
            return 1
        if args.reset and existing:
            copy = backup(path)
            print(f"Backup saved: {copy}")
            print(f"Deleted {delete_sample(conn)} sample incidents.")
        ids = add_history(conn)
        conn.commit()
    finally:
        conn.close()
    print(f"Added {len(ids)} sample incidents (IDs {ids[0]}-{ids[-1]}), all marked sample data.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
