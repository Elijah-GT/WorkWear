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


def utc_now() -> str:
    """Server timestamp, ISO 8601 UTC with milliseconds, e.g. 2026-11-06T15:04:05.123Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: Path) -> None:
    """Create the database file and tables if missing. Safe to run every startup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        # WAL lets the dashboard read while helmets write.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
