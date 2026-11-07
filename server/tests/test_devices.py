from datetime import timedelta

import pytest

from app import db
from payloads import fall, telemetry


def test_no_devices_at_start(client):
    assert client.get("/api/devices").json() == []


def test_device_shape(client):
    client.post("/api/telemetry", json=telemetry())
    [d] = client.get("/api/devices").json()
    assert set(d) == {"device_id", "name", "zone", "online", "last_seen", "latest"}
    assert set(d["latest"]) == {
        "uptime_ms", "worn", "temp_c", "humidity_pct", "pressure_hpa", "heat_index_c",
        "heat_level", "accel_g", "tilt_deg", "gps_fix", "lat", "lon", "zone", "zone_source",
    }


def test_online_right_after_telemetry_and_offline_after_5s(client, monkeypatch):
    client.post("/api/telemetry", json=telemetry())
    assert client.get("/api/devices").json()[0]["online"] is True

    later = db.now() + timedelta(seconds=6)
    monkeypatch.setattr(db, "now", lambda: later)
    assert client.get("/api/devices").json()[0]["online"] is False


def test_device_seen_only_by_event_is_offline(client):
    client.post("/api/event", json=fall())
    [d] = client.get("/api/devices").json()
    assert d["online"] is False
    assert d["last_seen"] is None


def test_latest_is_the_newest_reading(client):
    client.post("/api/telemetry", json=telemetry(uptime_ms=1, temp_c=20.0))
    client.post("/api/telemetry", json=telemetry(uptime_ms=2, temp_c=25.0))
    assert client.get("/api/devices").json()[0]["latest"]["temp_c"] == 25.0


def test_devices_are_listed_by_id(client):
    for dev in ["helmet-02", "helmet-01", "sim-01"]:
        client.post("/api/telemetry", json=telemetry(device_id=dev))
    ids = [d["device_id"] for d in client.get("/api/devices").json()]
    assert ids == ["helmet-01", "helmet-02", "sim-01"]


def test_patch_name_and_zone(client):
    client.post("/api/telemetry", json=telemetry())
    r = client.patch("/api/devices/helmet-01", json={"name": "Sam R.", "zone": "A2"})
    assert r.status_code == 200
    assert (r.json()["name"], r.json()["zone"]) == ("Sam R.", "A2")
    assert r.json()["latest"]["temp_c"] == 29.4


def test_patch_only_changes_fields_sent(client):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"name": "Sam R.", "zone": "A2"})
    r = client.patch("/api/devices/helmet-01", json={"name": "Alex P."})
    assert (r.json()["name"], r.json()["zone"]) == ("Alex P.", "A2")


def test_patch_zone_null_clears_zone(client):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"zone": "A2"})
    r = client.patch("/api/devices/helmet-01", json={"zone": None})
    assert r.json()["zone"] is None


def test_patch_trims_name(client):
    client.post("/api/telemetry", json=telemetry())
    r = client.patch("/api/devices/helmet-01", json={"name": "  Sam R.  "})
    assert r.json()["name"] == "Sam R."


def test_patch_unknown_device_is_404(client):
    assert client.patch("/api/devices/helmet-99", json={"name": "X"}).status_code == 404


@pytest.mark.parametrize(
    "body",
    [{"name": ""}, {"name": "   "}, {"name": None}, {"zone": ""}, {"Name": "typo"}],
)
def test_patch_bad_body_is_rejected(client, body):
    client.post("/api/telemetry", json=telemetry())
    assert client.patch("/api/devices/helmet-01", json=body).status_code == 422
