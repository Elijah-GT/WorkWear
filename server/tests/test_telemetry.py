import pytest

from app import db
from payloads import telemetry, without


def get_device(client, device_id="helmet-01"):
    return next(d for d in client.get("/api/devices").json() if d["device_id"] == device_id)


def test_telemetry_returns_ok_and_creates_new_device(client):
    r = client.post("/api/telemetry", json=telemetry())
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    d = get_device(client)
    assert d["name"] == "helmet-01"
    assert d["zone"] is None
    assert d["latest"]["temp_c"] == 29.4
    assert d["latest"]["worn"] is True


def test_telemetry_is_stamped_with_assigned_zone_and_server_time(client, db_file):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"zone": "A2"})
    client.post("/api/telemetry", json=telemetry(uptime_ms=124456))

    conn = db.connect(db_file)
    row = conn.execute("SELECT zone, ts FROM telemetry ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row["zone"] == "A2"
    assert row["ts"].endswith("Z")


def test_helmet_zone_from_beacons_beats_the_dashboard_zone(client, db_file):
    # Changed 2026-11-07: a helmet that locates itself (beacons) reports its zone, and a
    # measured zone wins over one set by hand. More cases in test_location.py.
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"zone": "A2"})
    client.post("/api/telemetry", json=telemetry(uptime_ms=124456, zone="Z9"))
    conn = db.connect(db_file)
    row = conn.execute("SELECT zone, zone_source FROM telemetry ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert (row["zone"], row["zone_source"]) == ("Z9", "beacon")


def test_lat_lon_dropped_without_gps_fix(client):
    client.post("/api/telemetry", json=telemetry(gps_fix=False, lat=51.5, lon=-0.1))
    latest = get_device(client)["latest"]
    assert latest["lat"] is None and latest["lon"] is None


def test_lat_lon_kept_with_gps_fix(client):
    client.post("/api/telemetry", json=telemetry(gps_fix=True, lat=51.5, lon=-0.1))
    latest = get_device(client)["latest"]
    assert (latest["lat"], latest["lon"]) == (51.5, -0.1)
    assert latest["gps_fix"] is True


def test_null_sensor_readings_are_accepted(client):
    body = telemetry(temp_c=None, humidity_pct=None, heat_index_c=None, accel_g=None)
    assert client.post("/api/telemetry", json=body).status_code == 200
    latest = get_device(client)["latest"]
    assert latest["temp_c"] is None
    assert latest["heat_level"] is None


def test_heat_level_is_added_to_latest(client):
    client.post("/api/telemetry", json=telemetry(heat_index_c=33.0))
    assert get_device(client)["latest"]["heat_level"] == "extreme_caution"


def test_unknown_extra_fields_are_ignored(client):
    assert client.post("/api/telemetry", json=telemetry(battery_v=3.9)).status_code == 200


@pytest.mark.parametrize("missing", ["device_id", "uptime_ms", "worn", "gps_fix"])
def test_missing_required_field_is_rejected(client, missing):
    r = client.post("/api/telemetry", json=without(telemetry(), missing))
    assert r.status_code == 422


@pytest.mark.parametrize(
    "field, value",
    [("worn", "maybe"), ("uptime_ms", "soon"), ("uptime_ms", -1), ("device_id", ""), ("temp_c", "hot")],
)
def test_wrong_type_is_rejected(client, field, value):
    r = client.post("/api/telemetry", json=telemetry(**{field: value}))
    assert r.status_code == 422
