import random

import pytest

import simulator
from simulator import Simulator, heat_index_c


def f_to_c(f):
    return (f - 32) * 5 / 9


@pytest.mark.parametrize(
    "temp_f, rh, expected_f",
    [(90, 40, 91), (90, 70, 106), (96, 50, 108), (80, 40, 80)],  # NWS heat index chart
)
def test_heat_index_matches_nws_chart(temp_f, rh, expected_f):
    # The chart is rounded to whole degrees F; allow 1 F (about 0.56 C).
    assert heat_index_c(f_to_c(temp_f), rh) == pytest.approx(f_to_c(expected_f), abs=5 / 9)


def test_heat_index_close_to_temperature_when_cool():
    assert heat_index_c(20.0, 50.0) == pytest.approx(20.0, abs=1.0)


class Recorder:
    """post() that sends to the test server and remembers every status code."""

    def __init__(self, client, fail_events_until=None):
        self.client = client
        self.statuses = []
        self.fail_events_until = fail_events_until
        self.t = 0.0

    def __call__(self, path, body):
        if path == "/api/event" and self.fail_events_until is not None and self.t < self.fail_events_until:
            return None  # server "down" for fall events
        r = self.client.post(path, json=body)
        self.statuses.append(r.status_code)
        return r.json() if r.status_code == 200 else None


def run(sim, recorder, seconds):
    for t in range(seconds):
        recorder.t = t
        sim.tick(float(t))


def make(client, **kwargs):
    rec = Recorder(client, fail_events_until=kwargs.pop("fail_events_until", None))
    sim = Simulator(post=rec, rng=random.Random(1), log=lambda msg: None, **kwargs)
    return sim, rec


def test_three_helmets_online_and_every_message_accepted(client):
    sim, rec = make(client, devices=3)
    run(sim, rec, 3)
    devices = client.get("/api/devices").json()
    assert [d["device_id"] for d in devices] == ["sim-01", "sim-02", "sim-03"]
    assert all(d["online"] for d in devices)
    assert set(rec.statuses) == {200}


def test_falls_are_sent_on_schedule_and_marked_sample(client):
    sim, rec = make(client, devices=3, fall_every=30)
    run(sim, rec, 61)  # falls at t=30 and t=60
    incidents = client.get("/api/incidents").json()
    assert len(incidents) == 2
    assert all(i["sample"] and i["type"] == "fall" for i in incidents)
    assert set(rec.statuses) == {200}


def test_resend_creates_no_duplicates(client):
    sim, rec = make(client, devices=3, fall_every=10, resend=True)
    run(sim, rec, 31)  # 3 falls, each sent twice
    assert len(client.get("/api/incidents").json()) == 3


def test_failed_fall_is_retried_and_marked_delayed(client):
    sim, rec = make(client, devices=1, fall_every=100, fail_events_until=110)
    run(sim, rec, 112)  # fall at t=100 fails, retries every 2 s, gets through at t=110
    [inc] = client.get("/api/incidents").json()
    assert inc["delayed"] is True
    assert sim.pending == []


def test_helmet_lies_tilted_after_a_fall(client):
    sim, rec = make(client, devices=1)
    h = sim.helmets[0]
    sim.fall(h, 10.0)
    assert sim.telemetry(h, 11.0)["tilt_deg"] >= 80
    assert sim.telemetry(h, 10.0 + simulator.STILL_AFTER_FALL_S + 1)["tilt_deg"] <= 25


def test_heat_ramp_raises_temperature_up_to_the_cap():
    sim = Simulator(devices=1, heat_ramp=2.0, rng=random.Random(1))
    h = sim.helmets[0]
    t0 = sim.telemetry(h, 0)["temp_c"]
    t5 = sim.telemetry(h, 300)["temp_c"]  # 5 minutes at 2 C/min
    assert t5 - t0 == pytest.approx(10.0, abs=1.0)
    assert sim.telemetry(h, 3600)["temp_c"] == simulator.MAX_TEMP_C


def test_rejects_bad_device_count():
    with pytest.raises(SystemExit):
        simulator.main(["--devices", "0"])


def test_beacon_zones_are_reported_and_used_by_the_server(client):
    zones = ["1520-N", "1520-S", "1520-W"]
    sim, rec = make(client, devices=3, beacon_zones=zones, fall_every=50)
    seen = set()
    for t in range(101):
        rec.t = t
        sim.tick(float(t))
        seen |= {h.zone for h in sim.helmets}
    assert seen <= set(zones) and len(seen) >= 2  # helmets moved between zones
    for d in client.get("/api/devices").json():
        assert d["latest"]["zone_source"] == "beacon"
        assert d["latest"]["zone"] in zones
    falls = client.get("/api/incidents").json()
    assert len(falls) == 2
    assert all(i["zone_source"] == "beacon" and i["zone"] in zones for i in falls)
    assert set(rec.statuses) == {200}


def test_helmet_does_not_change_zone_while_lying_still():
    sim = Simulator(devices=1, beacon_zones=["A", "B"], rng=random.Random(1))
    h = sim.helmets[0]
    h.move_at = 0.0     # due to move
    h.fallen_at = 10.0  # but it just fell
    before = h.zone
    sim.move(h, 11.0)
    assert h.zone == before
    sim.move(h, 10.0 + simulator.STILL_AFTER_FALL_S + 1)
    assert h.zone != before


def test_gps_fix_stays_within_the_radius():
    sim = Simulator(devices=2, gps=(41.0, -96.0, 25.0), rng=random.Random(2))
    for t in range(600):
        for h in sim.helmets:
            sim.move(h, float(t))
            body = sim.telemetry(h, float(t))
            assert body["gps_fix"] is True
            north = (body["lat"] - 41.0) * simulator.M_PER_DEG_LAT
            east = (body["lon"] + 96.0) * simulator.M_PER_DEG_LAT * 0.7547  # cos(41 deg)
            assert (north ** 2 + east ** 2) ** 0.5 <= 25.5


def test_no_location_options_means_no_zone_and_no_fix():
    sim = Simulator(devices=1, rng=random.Random(1))
    body = sim.telemetry(sim.helmets[0], 0.0)
    assert (body["zone"], body["gps_fix"], body["lat"], body["lon"]) == (None, False, None, None)


@pytest.mark.parametrize("args", [
    ["--gps", "41.0"], ["--gps", "abc,1"], ["--gps", "95,0"], ["--beacon-zones", "x" * 33],
])
def test_rejects_bad_location_options(args):
    with pytest.raises(SystemExit):
        simulator.main(args)
