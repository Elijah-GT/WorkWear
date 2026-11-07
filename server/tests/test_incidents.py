import pytest

from payloads import fall


def make_falls(client, n):
    return [client.post("/api/event", json=fall(uptime_ms=1000 * (i + 1))).json()["incident_id"] for i in range(n)]


def set_status(client, incident_id, status):
    client.patch(f"/api/incidents/{incident_id}", json={"status": status})


def test_empty_at_start(client):
    assert client.get("/api/incidents").json() == []


def test_incident_shape(client):
    make_falls(client, 1)
    [inc] = client.get("/api/incidents").json()
    assert set(inc) == {
        "id", "device_id", "worker_name", "type", "ts", "zone", "lat", "lon",
        "peak_g", "status", "notes", "delayed", "sample",
    }


def test_newest_first(client):
    ids = make_falls(client, 3)
    assert [i["id"] for i in client.get("/api/incidents").json()] == ids[::-1]


def test_filter_by_status(client):
    a, b, c = make_falls(client, 3)
    set_status(client, b, "confirmed")
    set_status(client, c, "dismissed")
    assert [i["id"] for i in client.get("/api/incidents?status=confirmed").json()] == [b]
    assert [i["id"] for i in client.get("/api/incidents?status=new").json()] == [a]


def test_limit(client):
    ids = make_falls(client, 5)
    assert [i["id"] for i in client.get("/api/incidents?limit=2").json()] == ids[:-3:-1]


@pytest.mark.parametrize("query", ["status=maybe", "limit=0", "limit=abc"])
def test_bad_query_is_rejected(client, query):
    assert client.get(f"/api/incidents?{query}").status_code == 422
