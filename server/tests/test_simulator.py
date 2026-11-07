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
