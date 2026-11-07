"""seed.py: sample incident history for demos (marked sample, spread out, mostly reviewed)."""

from datetime import timedelta

import seed
from app import db


def rows(path):
    conn = db.connect(path)
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM incidents ORDER BY id")]
    finally:
        conn.close()


def test_adds_a_small_spread_out_sample_history(tmp_path):
    path = tmp_path / "w.db"
    assert seed.main(["--db", str(path)]) == 0
    incs = rows(path)
    assert 6 <= len(incs) <= 8
    assert all(i["sample"] == 1 for i in incs), "every seeded incident is labeled sample data"
    assert all(i["device_id"].startswith("sim-") for i in incs)
    assert sum(i["status"] == "new" for i in incs) <= 2
    assert len({i["zone"] for i in incs}) >= 4
    days = {db.parse_ts(i["ts"]).date() for i in incs}
    assert len(days) >= 3, "spread over several days"
    now = db.now()
    assert all(db.parse_ts(i["ts"]) < now for i in incs), "all in the past"
    # IDs go up with time, like real incidents
    stamps = [db.parse_ts(i["ts"]) for i in incs]
    assert stamps == sorted(stamps)
    assert {i["type"] for i in incs} >= {"fall", "injury_report", "hazard_report"}


def test_refuses_to_add_twice_without_reset(tmp_path, capsys):
    path = tmp_path / "w.db"
    assert seed.main(["--db", str(path)]) == 0
    assert seed.main(["--db", str(path)]) == 1
    assert "--reset" in capsys.readouterr().err
    assert len(rows(path)) == len(seed.HISTORY)


def test_reset_keeps_real_data_and_makes_a_backup(tmp_path):
    path = tmp_path / "w.db"
    db.init_db(path)
    conn = db.connect(path)
    ts = db.format_ts(db.now() - timedelta(hours=1))
    db.ensure_device(conn, "helmet-01", ts)
    db.ensure_device(conn, "sim-09", ts)
    real = db.insert_incident(conn, {
        "device_id": "helmet-01", "worker_name": "Real Person", "type": "fall", "ts": ts, "zone": "1520-W",
        "zone_source": "manual", "lat": None, "lon": None, "peak_g": 3.1, "status": "new", "notes": "",
        "delayed": 0, "sample": 0,
    })
    old_sample = db.insert_incident(conn, {
        "device_id": "sim-09", "worker_name": "sim-09", "type": "fall", "ts": ts, "zone": "1520-N",
        "zone_source": "manual", "lat": None, "lon": None, "peak_g": 4.0, "status": "new", "notes": "",
        "delayed": 0, "sample": 1,
    })
    # a raw fall event pointing at the sample incident must not block deleting it
    db.insert_event(conn, {"device_id": "sim-09", "uptime_ms": 1000, "sent_uptime_ms": 1000, "type": "fall",
                           "peak_g": 4.0, "freefall_ms": 200, "still_s": 2.0}, ts, "1520-N", old_sample)
    conn.commit()
    conn.close()

    assert seed.main(["--db", str(path), "--reset"]) == 0
    incs = rows(path)
    ids = {i["id"] for i in incs}
    assert real in ids, "real helmet data is never deleted"
    # (SQLite may reuse the deleted row's ID for new history, so check by device, not by ID)
    assert not [i for i in incs if i["device_id"] == "sim-09"], "old sample incidents are gone"
    assert sum(i["sample"] == 1 for i in incs) == len(seed.HISTORY)
    backups = list(tmp_path.glob("w.db.bak-*"))
    assert len(backups) == 1
    assert {i["id"] for i in rows(backups[0])} == {real, old_sample}, "backup holds the data from before"
