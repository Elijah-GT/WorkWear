"""POST /api/incidents (manual reports) and PATCH /api/incidents/{id}."""

import pytest

from payloads import fall, telemetry


def report(**overrides):
    body = {"type": "injury_report", "zone": "B1", "notes": "Cut hand on rebar",
            "device_id": None, "worker_name": "Alex P."}
    body.update(overrides)
    return body


# --- POST /api/incidents ----------------------------------------------------

def test_injury_report_is_created(client):
    r = client.post("/api/incidents", json=report())
    assert r.status_code == 200
    inc = r.json()
    assert inc["type"] == "injury_report"
    assert inc["zone"] == "B1"
    assert inc["notes"] == "Cut hand on rebar"
    assert inc["worker_name"] == "Alex P."
    assert inc["device_id"] is None
    assert inc["status"] == "new"
    assert inc["peak_g"] is None
    assert (inc["lat"], inc["lon"]) == (None, None)
    assert inc["delayed"] is False and inc["sample"] is False
    assert inc["ts"].endswith("Z")
    assert client.get("/api/incidents").json() == [inc]


def test_hazard_report_needs_only_type_and_zone(client):
    r = client.post("/api/incidents", json={"type": "hazard_report", "zone": "A1"})
    assert r.status_code == 200
    inc = r.json()
    assert (inc["notes"], inc["worker_name"], inc["device_id"]) == ("", None, None)


def test_report_for_a_device_copies_its_name(client):
    client.post("/api/telemetry", json=telemetry())
    client.patch("/api/devices/helmet-01", json={"name": "Sam R."})
    inc = client.post("/api/incidents", json=report(device_id="helmet-01", worker_name=None)).json()
    assert (inc["device_id"], inc["worker_name"]) == ("helmet-01", "Sam R.")


def test_report_worker_name_given_wins_over_device_name(client):
    client.post("/api/telemetry", json=telemetry())
    inc = client.post("/api/incidents", json=report(device_id="helmet-01", worker_name="Alex P.")).json()
    assert inc["worker_name"] == "Alex P."


def test_report_for_unknown_device_is_404(client):
    assert client.post("/api/incidents", json=report(device_id="helmet-99")).status_code == 404


def test_report_for_sim_device_is_sample(client):
    client.post("/api/telemetry", json=telemetry(device_id="sim-01"))
    inc = client.post("/api/incidents", json=report(device_id="sim-01")).json()
    assert inc["sample"] is True


@pytest.mark.parametrize(
    "body",
    [
        report(type="fall"),          # falls only come from helmets
        report(type="other"),
        report(zone=None),
        report(zone=""),
        {"type": "injury_report"},     # zone missing
        report(peak_g=9.0),           # unknown field
    ],
)
def test_bad_report_is_rejected(client, body):
    assert client.post("/api/incidents", json=body).status_code == 422
    assert client.get("/api/incidents").json() == []


# --- PATCH /api/incidents/{id} ----------------------------------------------

def new_fall(client):
    return client.post("/api/event", json=fall()).json()["incident_id"]


def test_confirm_with_notes(client):
    iid = new_fall(client)
    r = client.patch(f"/api/incidents/{iid}", json={"status": "confirmed", "notes": "Dropped from scaffold, worker OK"})
    assert r.status_code == 200
    assert (r.json()["status"], r.json()["notes"]) == ("confirmed", "Dropped from scaffold, worker OK")
    assert client.get("/api/incidents").json()[0]["status"] == "confirmed"


def test_patch_only_changes_fields_sent(client):
    iid = new_fall(client)
    client.patch(f"/api/incidents/{iid}", json={"notes": "checking"})
    r = client.patch(f"/api/incidents/{iid}", json={"status": "dismissed"})
    assert (r.json()["status"], r.json()["notes"]) == ("dismissed", "checking")


def test_status_can_be_changed_back(client):
    iid = new_fall(client)
    client.patch(f"/api/incidents/{iid}", json={"status": "dismissed"})
    assert client.patch(f"/api/incidents/{iid}", json={"status": "new"}).json()["status"] == "new"


def test_notes_can_be_cleared(client):
    iid = new_fall(client)
    client.patch(f"/api/incidents/{iid}", json={"notes": "x"})
    assert client.patch(f"/api/incidents/{iid}", json={"notes": ""}).json()["notes"] == ""


def test_patch_does_not_change_anything_else(client):
    iid = new_fall(client)
    before = client.get("/api/incidents").json()[0]
    after = client.patch(f"/api/incidents/{iid}", json={"status": "confirmed"}).json()
    assert {k: v for k, v in after.items() if k != "status"} == {k: v for k, v in before.items() if k != "status"}


def test_patch_unknown_incident_is_404(client):
    assert client.patch("/api/incidents/999", json={"status": "confirmed"}).status_code == 404


@pytest.mark.parametrize(
    "body",
    [{"status": "maybe"}, {"status": None}, {"notes": None}, {"zone": "A1"}, {"Status": "confirmed"}],
)
def test_bad_patch_is_rejected(client, body):
    iid = new_fall(client)
    assert client.patch(f"/api/incidents/{iid}", json=body).status_code == 422
    assert client.get("/api/incidents").json()[0]["status"] == "new"
