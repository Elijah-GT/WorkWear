import re
import sqlite3

import pytest

from app import db


def test_startup_creates_database_with_all_tables(client, db_file):
    assert db_file.exists()
    conn = db.connect(db_file)
    names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"devices", "telemetry", "events", "incidents"} <= names


def test_wal_mode_is_on(client, db_file):
    conn = db.connect(db_file)
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    conn.close()


def test_init_db_is_safe_to_run_twice(db_file):
    db.init_db(db_file)
    db.init_db(db_file)


def test_repeat_event_is_rejected_by_unique_key(client, db_file):
    conn = db.connect(db_file)
    conn.execute("INSERT INTO devices (device_id, name, created_ts) VALUES ('helmet-01', 'helmet-01', 'x')")
    insert = "INSERT INTO events (device_id, ts, uptime_ms, type) VALUES ('helmet-01', 'x', 123999, 'fall')"
    conn.execute(insert)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(insert)
    conn.close()


@pytest.mark.parametrize(
    "column, value",
    [("type", "explosion"), ("status", "maybe")],
)
def test_incident_rejects_unknown_type_or_status(client, db_file, column, value):
    conn = db.connect(db_file)
    row = {"type": "fall", "status": "new"}
    row[column] = value
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO incidents (type, status, ts) VALUES (?, ?, 'x')",
            (row["type"], row["status"]),
        )
    conn.close()


def test_utc_now_format():
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", db.utc_now())
