import re

import pytest

from payloads import fall, telemetry, without


def incidents(client):
    return client.get("/api/incidents").json()


def test_fall_creates_incident(client):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"name": "Sam R.", "zone": "A2"})

    r = client.post("/api/event", json=fall())
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True

    [inc] = incidents(client)
    assert inc["id"] == body["incident_id"]
    assert inc["device_id"] == "helmet-01"
    assert inc["worker_name"] == "Sam R."
    assert inc["type"] == "fall"
    assert inc["zone"] == "A2"
    assert inc["peak_g"] == 4.2
    assert inc["status"] == "new"
    assert inc["notes"] == ""
    assert inc["delayed"] is False
    assert inc["sample"] is False
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", inc["ts"])


def test_same_fall_sent_twice_gives_one_incident(client):
    first = client.post("/api/event", json=fall()).json()
    second = client.post("/api/event", json=fall(sent_uptime_ms=126000)).json()
    assert second == first
    assert len(incidents(client)) == 1


def test_different_falls_give_different_incidents(client):
    a = client.post("/api/event", json=fall(uptime_ms=1000)).json()["incident_id"]
    b = client.post("/api/event", json=fall(uptime_ms=2000)).json()["incident_id"]
    assert a != b
    assert len(incidents(client)) == 2


def test_rename_and_rezone_only_affect_new_incidents(client):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"name": "Sam R.", "zone": "A2"})
    old_id = client.post("/api/event", json=fall(uptime_ms=1000)).json()["incident_id"]

    client.patch("/api/devices/helmet-01", json={"name": "Alex P.", "zone": "B1"})
    new_id = client.post("/api/event", json=fall(uptime_ms=2000)).json()["incident_id"]

    by_id = {i["id"]: i for i in incidents(client)}
    assert (by_id[old_id]["worker_name"], by_id[old_id]["zone"]) == ("Sam R.", "A2")
    assert (by_id[new_id]["worker_name"], by_id[new_id]["zone"]) == ("Alex P.", "B1")


def test_fall_from_unknown_device_creates_it(client):
    client.post("/api/event", json=fall(device_id="helmet-07"))
    [dev] = client.get("/api/devices").json()
    assert dev["device_id"] == "helmet-07"
    assert dev["latest"] is None
    assert incidents(client)[0]["worker_name"] == "helmet-07"


@pytest.mark.parametrize(
    "sent_uptime_ms, delayed",
    [(None, False), (123999, False), (123999 + 5000, False), (123999 + 5001, True)],
)
def test_delayed_flag(client, sent_uptime_ms, delayed):
    body = fall() if sent_uptime_ms is None else fall(sent_uptime_ms=sent_uptime_ms)
    client.post("/api/event", json=body)
    assert incidents(client)[0]["delayed"] is delayed


def test_sim_devices_create_sample_incidents(client):
    client.post("/api/event", json=fall(device_id="sim-01"))
    assert incidents(client)[0]["sample"] is True


def test_location_from_latest_telemetry_with_fix(client):
    client.post("/api/telemetry", json=telemetry(gps_fix=True, lat=51.5, lon=-0.1))
    client.post("/api/event", json=fall())
    inc = incidents(client)[0]
    assert (inc["lat"], inc["lon"]) == (51.5, -0.1)


def test_no_location_when_latest_telemetry_has_no_fix(client):
    client.post("/api/telemetry", json=telemetry(gps_fix=True, lat=51.5, lon=-0.1, uptime_ms=1))
    client.post("/api/telemetry", json=telemetry(gps_fix=False, uptime_ms=2))
    client.post("/api/event", json=fall())
    inc = incidents(client)[0]
    assert (inc["lat"], inc["lon"]) == (None, None)


@pytest.mark.parametrize(
    "body",
    [
        fall(type="impact"),
        without(fall(), "peak_g"),
        without(fall(), "uptime_ms"),
        without(fall(), "device_id"),
        fall(peak_g="hard"),
    ],
)
def test_bad_event_is_rejected(client, body):
    assert client.post("/api/event", json=body).status_code == 422
    assert incidents(client) == []


def test_simultaneous_duplicate_is_caught_by_unique_key(client, monkeypatch):
    # Simulate two copies arriving at once: the second one's duplicate check
    # runs before the first one is saved, so only the database key can stop it.
    from app import db

    first = client.post("/api/event", json=fall()).json()
    real_find = db.find_event
    calls = {"n": 0}

    def find_misses_once(*args):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_find(*args)

    monkeypatch.setattr(db, "find_event", find_misses_once)
    second = client.post("/api/event", json=fall()).json()
    assert second == first
    assert len(incidents(client)) == 1
