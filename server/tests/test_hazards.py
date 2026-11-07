"""GET /api/hazards: confirmed incident counts and highest heat index per zone."""

from datetime import timedelta

import pytest

from app import db
from payloads import fall, telemetry


def hazards(client, query=""):
    r = client.get(f"/api/hazards{query}")
    assert r.status_code == 200
    return {h["zone"]: h for h in r.json()}


def put_in_zone(client, device_id, zone, **reading):
    """Create the device, assign its zone, then send one reading from inside that zone."""
    client.post("/api/telemetry", json=telemetry(device_id=device_id, uptime_ms=0, heat_index_c=None))
    client.patch(f"/api/devices/{device_id}", json={"zone": zone})
    client.post("/api/telemetry", json=telemetry(device_id=device_id, uptime_ms=1, **reading))


def fall_from(client, device_id, uptime_ms, status=None):
    iid = client.post("/api/event", json=fall(device_id=device_id, uptime_ms=uptime_ms)).json()["incident_id"]
    if status:
        client.patch(f"/api/incidents/{iid}", json={"status": status})
    return iid


def test_empty_at_start(client):
    assert client.get("/api/hazards").json() == []


def test_only_confirmed_incidents_count(client):
    put_in_zone(client, "helmet-01", "A2")
    fall_from(client, "helmet-01", 1, "confirmed")
    fall_from(client, "helmet-01", 2, "confirmed")
    fall_from(client, "helmet-01", 3, "dismissed")
    fall_from(client, "helmet-01", 4)  # still new
    assert hazards(client)["A2"]["confirmed_count"] == 2


def test_manual_reports_count_once_confirmed(client):
    iid = client.post("/api/incidents", json={"type": "hazard_report", "zone": "B1", "notes": "Wet floor"}).json()["id"]
    assert hazards(client)["B1"]["confirmed_count"] == 0
    client.patch(f"/api/incidents/{iid}", json={"status": "confirmed"})
    assert hazards(client)["B1"]["confirmed_count"] == 1


def test_zone_with_only_telemetry_is_listed_with_its_max_heat(client):
    put_in_zone(client, "helmet-01", "C3")
    client.post("/api/telemetry", json=telemetry(uptime_ms=2, heat_index_c=34.5))
    client.post("/api/telemetry", json=telemetry(uptime_ms=3, heat_index_c=31.0))
    h = hazards(client)["C3"]
    assert h == {"zone": "C3", "confirmed_count": 0, "sample_count": 0, "max_heat_index_c": 34.5}


def test_zone_with_incidents_but_no_telemetry_has_null_heat(client):
    client.post("/api/incidents", json={"type": "injury_report", "zone": "D4"})
    assert hazards(client)["D4"]["max_heat_index_c"] is None


def test_readings_and_incidents_without_a_zone_are_left_out(client):
    client.post("/api/telemetry", json=telemetry())   # device has no zone yet
    client.post("/api/event", json=fall())
    assert client.get("/api/hazards").json() == []


def test_sample_incidents_are_counted_and_flagged(client):
    put_in_zone(client, "sim-01", "A1")
    put_in_zone(client, "helmet-01", "A1")
    fall_from(client, "sim-01", 1, "confirmed")
    fall_from(client, "helmet-01", 1, "confirmed")
    h = hazards(client)["A1"]
    assert (h["confirmed_count"], h["sample_count"]) == (2, 1)


def test_zones_are_sorted(client):
    for z in ["B1", "A2", "A1"]:
        client.post("/api/incidents", json={"type": "hazard_report", "zone": z})
    assert [h["zone"] for h in client.get("/api/hazards").json()] == ["A1", "A2", "B1"]


def test_hours_window(client, monkeypatch):
    put_in_zone(client, "helmet-01", "A2", heat_index_c=40.0)
    fall_from(client, "helmet-01", 1, "confirmed")

    # Three hours later: a new confirmed fall and a cooler reading.
    later = db.now() + timedelta(hours=3)
    monkeypatch.setattr(db, "now", lambda: later)
    client.post("/api/telemetry", json=telemetry(uptime_ms=2, heat_index_c=30.0))
    fall_from(client, "helmet-01", 2, "confirmed")

    all_time = hazards(client)["A2"]
    assert (all_time["confirmed_count"], all_time["max_heat_index_c"]) == (2, 40.0)
    last_hour = hazards(client, "?hours=1")["A2"]
    assert (last_hour["confirmed_count"], last_hour["max_heat_index_c"]) == (1, 30.0)


@pytest.mark.parametrize("query", ["?hours=0", "?hours=-1", "?hours=abc"])
def test_bad_hours_is_rejected(client, query):
    assert client.get(f"/api/hazards{query}").status_code == 422
