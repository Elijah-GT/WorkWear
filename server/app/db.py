"""SQLite storage. Schema follows docs/PROTOCOL.md."""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "workwear.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    device_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    zone        TEXT,
    created_ts  TEXT NOT NULL,
    last_seen   TEXT
);

CREATE TABLE IF NOT EXISTS telemetry (
    id            INTEGER PRIMARY KEY,
    device_id     TEXT NOT NULL REFERENCES devices(device_id),
    ts            TEXT NOT NULL,
    uptime_ms     INTEGER NOT NULL,
    worn          INTEGER NOT NULL,
    temp_c        REAL,
    humidity_pct  REAL,
    pressure_hpa  REAL,
    heat_index_c  REAL,
    accel_g       REAL,
    tilt_deg      REAL,
    zone          TEXT,
    zone_source   TEXT,  -- 'beacon', 'gps', or 'manual' (see main.resolve_zone)
    gps_fix       INTEGER NOT NULL,
    lat           REAL,
    lon           REAL
);
CREATE INDEX IF NOT EXISTS telemetry_device ON telemetry(device_id, id);
CREATE INDEX IF NOT EXISTS telemetry_zone_ts ON telemetry(zone, ts);

CREATE TABLE IF NOT EXISTS incidents (
    id           INTEGER PRIMARY KEY,
    device_id    TEXT REFERENCES devices(device_id),
    worker_name  TEXT,
    type         TEXT NOT NULL CHECK (type IN ('fall', 'injury_report', 'hazard_report')),
    ts           TEXT NOT NULL,
    zone         TEXT,
    zone_source  TEXT,  -- 'beacon', 'gps', or 'manual'
    lat          REAL,
    lon          REAL,
    peak_g       REAL,
    status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'dismissed')),
    notes        TEXT NOT NULL DEFAULT '',
    delayed      INTEGER NOT NULL DEFAULT 0,
    sample       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS incidents_ts ON incidents(ts);
CREATE INDEX IF NOT EXISTS incidents_zone_status ON incidents(zone, status);

-- Raw fall events from helmets. (device_id, uptime_ms) is unique so a
-- retried event does not create a second incident.
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id),
    ts              TEXT NOT NULL,
    uptime_ms       INTEGER NOT NULL,
    sent_uptime_ms  INTEGER,
    type            TEXT NOT NULL,
    peak_g          REAL,
    freefall_ms     INTEGER,
    still_s         REAL,
    zone            TEXT,
    incident_id     INTEGER REFERENCES incidents(id),
    UNIQUE (device_id, uptime_ms)
);
"""


def db_path() -> Path:
    """Database file: $WORKWEAR_DB if set, else server/workwear.db."""
    return Path(os.environ.get("WORKWEAR_DB", DEFAULT_DB_PATH))


def now() -> datetime:
    """Current UTC time. Tests replace this to move the clock."""
    return datetime.now(timezone.utc)


def format_ts(dt: datetime) -> str:
    """ISO 8601 UTC with milliseconds, e.g. 2026-11-06T15:04:05.123Z."""
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def utc_now() -> str:
    """Server timestamp for a message received now."""
    return format_ts(now())


def connect(path: Path) -> sqlite3.Connection:
    # FastAPI may open a request's connection on one worker thread and run the route on
    # another. Each connection still belongs to one request and is used by one thread at a
    # time, so it is safe to let SQLite accept it from any thread.
    conn = sqlite3.connect(path, timeout=5, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Columns added after the first version. init_db adds them to an older database file.
ADDED_COLUMNS = [
    ("telemetry", "zone_source", "TEXT"),
    ("incidents", "zone_source", "TEXT"),
]


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    for table, column, kind in ADDED_COLUMNS:
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            if column == "zone_source":
                # Before this column existed, every zone was set by hand on the dashboard.
                conn.execute(f"UPDATE {table} SET zone_source = 'manual' WHERE zone IS NOT NULL")


def init_db(path: Path) -> None:
    """Create the database file and tables if missing. Safe to run every startup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        # WAL lets the dashboard read while helmets write.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        _add_missing_columns(conn)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Queries. Each takes an open connection; the caller owns the transaction.
# ---------------------------------------------------------------------------

def ensure_device(conn: sqlite3.Connection, device_id: str, ts: str) -> sqlite3.Row:
    """Return the device, creating it (name = device_id, no zone) if it is new."""
    conn.execute(
        "INSERT OR IGNORE INTO devices (device_id, name, created_ts) VALUES (?, ?, ?)",
        (device_id, device_id, ts),
    )
    return get_device(conn, device_id)


def get_device(conn: sqlite3.Connection, device_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()


def list_devices(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM devices ORDER BY device_id").fetchall()


def update_device(conn: sqlite3.Connection, device_id: str, fields: dict) -> None:
    """Set the given columns (only "name" and "zone" are allowed)."""
    allowed = {k: v for k, v in fields.items() if k in ("name", "zone")}
    if not allowed:
        return
    assignments = ", ".join(f"{col} = ?" for col in allowed)
    conn.execute(
        f"UPDATE devices SET {assignments} WHERE device_id = ?",
        (*allowed.values(), device_id),
    )


def insert_telemetry(conn: sqlite3.Connection, t: dict, ts: str, zone: str | None,
                     zone_source: str | None) -> None:
    conn.execute(
        """INSERT INTO telemetry (device_id, ts, uptime_ms, worn, temp_c, humidity_pct,
               pressure_hpa, heat_index_c, accel_g, tilt_deg, zone, zone_source, gps_fix, lat, lon)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (t["device_id"], ts, t["uptime_ms"], t["worn"], t["temp_c"], t["humidity_pct"],
         t["pressure_hpa"], t["heat_index_c"], t["accel_g"], t["tilt_deg"], zone, zone_source,
         t["gps_fix"], t["lat"], t["lon"]),
    )
    conn.execute("UPDATE devices SET last_seen = ? WHERE device_id = ?", (ts, t["device_id"]))


def latest_telemetry(conn: sqlite3.Connection, device_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM telemetry WHERE device_id = ? ORDER BY id DESC LIMIT 1", (device_id,)
    ).fetchone()


def find_event(conn: sqlite3.Connection, device_id: str, uptime_ms: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM events WHERE device_id = ? AND uptime_ms = ?", (device_id, uptime_ms)
    ).fetchone()


def insert_incident(conn: sqlite3.Connection, inc: dict) -> int:
    cur = conn.execute(
        """INSERT INTO incidents (device_id, worker_name, type, ts, zone, zone_source, lat, lon,
               peak_g, status, notes, delayed, sample)
           VALUES (:device_id, :worker_name, :type, :ts, :zone, :zone_source, :lat, :lon,
               :peak_g, :status, :notes, :delayed, :sample)""",
        inc,
    )
    return cur.lastrowid


def insert_event(conn: sqlite3.Connection, ev: dict, ts: str, zone: str | None, incident_id: int) -> None:
    conn.execute(
        """INSERT INTO events (device_id, ts, uptime_ms, sent_uptime_ms, type, peak_g,
               freefall_ms, still_s, zone, incident_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (ev["device_id"], ts, ev["uptime_ms"], ev["sent_uptime_ms"], ev["type"], ev["peak_g"],
         ev["freefall_ms"], ev["still_s"], zone, incident_id),
    )


def list_incidents(conn: sqlite3.Connection, status: str | None, limit: int) -> list[sqlite3.Row]:
    if status is None:
        return conn.execute("SELECT * FROM incidents ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return conn.execute(
        "SELECT * FROM incidents WHERE status = ? ORDER BY id DESC LIMIT ?", (status, limit)
    ).fetchall()


def get_incident(conn: sqlite3.Connection, incident_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM incidents WHERE id = ?", (incident_id,)).fetchone()


def update_incident(conn: sqlite3.Connection, incident_id: int, fields: dict) -> None:
    """Set the given columns (only "status" and "notes" are allowed)."""
    allowed = {k: v for k, v in fields.items() if k in ("status", "notes")}
    if not allowed:
        return
    assignments = ", ".join(f"{col} = ?" for col in allowed)
    conn.execute(f"UPDATE incidents SET {assignments} WHERE id = ?", (*allowed.values(), incident_id))


def hazards(conn: sqlite3.Connection, since: str | None) -> list[dict]:
    """Per zone: confirmed incidents (and how many are sample data) and the highest heat index.

    since: only count incidents and readings at or after this server time; None = all time.
    Incidents and readings with no zone are left out, since they cannot go on the map.
    """
    by_zone: dict[str, dict] = {}

    def entry(zone: str) -> dict:
        return by_zone.setdefault(
            zone, {"zone": zone, "confirmed_count": 0, "sample_count": 0, "max_heat_index_c": None}
        )

    for r in conn.execute(
        """SELECT zone,
                  SUM(status = 'confirmed') AS confirmed,
                  SUM(status = 'confirmed' AND sample = 1) AS sample
           FROM incidents
           WHERE zone IS NOT NULL AND (? IS NULL OR ts >= ?)
           GROUP BY zone""",
        (since, since),
    ):
        e = entry(r["zone"])
        e["confirmed_count"] = r["confirmed"]
        e["sample_count"] = r["sample"]

    for r in conn.execute(
        """SELECT zone, MAX(heat_index_c) AS max_hi
           FROM telemetry
           WHERE zone IS NOT NULL AND (? IS NULL OR ts >= ?)
           GROUP BY zone""",
        (since, since),
    ):
        entry(r["zone"])["max_heat_index_c"] = r["max_hi"]

    return [by_zone[z] for z in sorted(by_zone)]
