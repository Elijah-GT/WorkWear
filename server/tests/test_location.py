"""Where a helmet is: beacons, GPS on the floor plan, or the zone set by hand (2026-11-07).

The plan here is made up: 1000 x 1000 px, with GPS corners chosen so that
x = (lon + 96.001) * 1e6 and y = (41.001 - lat) * 1e6.
"""

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import SITE_FILE, create_app
from app.site import SiteFile, fit_gps_points, parse_site
from payloads import fall, telemetry

GPS_POINTS = [
    {"x": 0, "y": 0, "lat": 41.001, "lon": -96.001},
    {"x": 1000, "y": 0, "lat": 41.001, "lon": -96.000},
    {"x": 0, "y": 1000, "lat": 41.000, "lon": -96.001},
]
SITE = {
    "image": "plan.png", "width": 1000, "height": 1000,
    "zones": [
        {"id": "N", "label": "North", "x": 0, "y": 0, "w": 1000, "h": 500},
        {"id": "S", "label": "South", "x": 0, "y": 500, "w": 1000, "h": 500},
        {"id": "Desk", "label": "Desk", "x": 400, "y": 100, "w": 100, "h": 100},  # inside N
    ],
    "gps_points": GPS_POINTS,
}


def gps(x, y):
    """GPS position of an image pixel on the made-up plan."""
    return {"lat": 41.001 - y / 1e6, "lon": -96.001 + x / 1e6}


# ---------------------------------------------------------------------------
# The GPS-to-plan fit
# ---------------------------------------------------------------------------

def test_fit_maps_the_points_exactly_and_places_others():
    site = parse_site(SITE)
    assert site.problems == ()
    for p in GPS_POINTS:
        assert site.to_plan(p["lat"], p["lon"]) == pytest.approx((p["x"], p["y"]), abs=1e-6)
    assert site.to_plan(**gps(250, 750)) == pytest.approx((250, 750), abs=1e-6)
    assert site.to_pixels.max_error_px == pytest.approx(0, abs=1e-6)


def test_fit_with_more_points_averages_small_errors():
    pts = GPS_POINTS + [{"x": 1000, "y": 1000, "lat": 41.0, "lon": -96.0 + 2e-6}]  # 2 px off
    t = fit_gps_points(pts)
    assert 0 < t.max_error_px < 2
    assert t(**gps(500, 500)) == pytest.approx((500, 500), abs=1)


def test_zone_at_picks_the_smallest_zone_and_none_outside():
    site = parse_site(SITE)
    assert site.zone_at(**gps(100, 100)) == "N"
    assert site.zone_at(**gps(450, 150)) == "Desk"   # inside both Desk and N
    assert site.zone_at(**gps(100, 900)) == "S"
    assert site.zone_at(**gps(1500, 100)) is None    # off the plan
    assert site.zone_at(None, None) is None


@pytest.mark.parametrize("points, reason", [
    (GPS_POINTS[:2], "at least 3"),
    ([{**GPS_POINTS[0], "lat": "41"}] + GPS_POINTS[1:], "numbers"),
    ([{**GPS_POINTS[0], "lat": 91}] + GPS_POINTS[1:], "out of range"),
    ([GPS_POINTS[0], GPS_POINTS[1], {"x": 500, "y": 0, "lat": 41.001, "lon": -96.0005}], "in a line"),
    ([GPS_POINTS[0], GPS_POINTS[0], GPS_POINTS[0]], "in a line"),
    ([{**p, "y": 0} for p in GPS_POINTS], "in a line on the image"),
])
def test_bad_gps_points_are_reported_and_turn_placement_off(points, reason):
    site = parse_site({**SITE, "gps_points": points})
    assert any(reason in p for p in site.problems)
    assert site.to_plan(**gps(10, 10)) is None
    assert site.zone_at(**gps(10, 10)) is None
    assert len(site.zones) == 3  # zones still load


def test_no_gps_points_means_no_placement():
    site = parse_site({k: v for k, v in SITE.items() if k != "gps_points"})
    assert site.problems == ()
    assert site.to_plan(**gps(10, 10)) is None


def test_site_file_reloads_when_edited_and_survives_bad_files(tmp_path):
    path = tmp_path / "zones.json"
    sf = SiteFile(path)
    assert sf.get().zones == ()                      # missing file
    path.write_text(json.dumps(SITE))
    assert sf.get().zone_at(**gps(100, 900)) == "S"
    path.write_text(json.dumps({**SITE, "zones": [{"id": "All", "x": 0, "y": 0, "w": 1000, "h": 1000}]}))
    assert sf.get().zone_at(**gps(100, 900)) == "All"  # picked up without a restart
    path.write_text("{ not json")
    assert "could not be read" in sf.get().problems[0]


def test_the_shipped_zones_json_loads_cleanly():
    assert SiteFile(SITE_FILE).get().problems == ()


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------

@pytest.fixture
def geo_client(tmp_path):
    site_path = tmp_path / "zones.json"
    site_path.write_text(json.dumps(SITE))
    with TestClient(create_app(tmp_path / "test.db", site_path)) as c:
        yield c


def latest(client, device_id="helmet-01"):
    return next(d for d in client.get("/api/devices").json() if d["device_id"] == device_id)["latest"]


def set_zone(client, zone, device_id="helmet-01"):
    client.post("/api/telemetry", json=telemetry(device_id=device_id))
    client.patch(f"/api/devices/{device_id}", json={"zone": zone})


def test_zone_set_by_hand_when_nothing_is_measured(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1))
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == ("N", "manual")


def test_gps_fix_inside_a_zone_beats_the_zone_set_by_hand(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, gps_fix=True, **gps(100, 900)))
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == ("S", "gps")


def test_gps_fix_outside_every_zone_keeps_the_zone_set_by_hand(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, gps_fix=True, **gps(3000, 3000)))
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == ("N", "manual")


def test_gps_position_without_a_fix_is_ignored(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, gps_fix=False, **gps(100, 900)))
    assert latest(geo_client)["zone_source"] == "manual"


def test_beacon_zone_beats_gps(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, zone="Desk", gps_fix=True, **gps(100, 900)))
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == ("Desk", "beacon")


@pytest.mark.parametrize("bad", ["", "   ", "x" * 33])
def test_unusable_helmet_zone_is_ignored(geo_client, bad):
    set_zone(geo_client, "N")
    r = geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, zone=bad))
    assert r.status_code == 200
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == ("N", "manual")


def test_no_zone_at_all(geo_client):
    geo_client.post("/api/telemetry", json=telemetry())
    assert (latest(geo_client)["zone"], latest(geo_client)["zone_source"]) == (None, None)


def incident(client, incident_id):
    return next(i for i in client.get("/api/incidents").json() if i["id"] == incident_id)


def test_fall_uses_the_helmets_zone_from_the_event(geo_client):
    set_zone(geo_client, "N")
    iid = geo_client.post("/api/event", json=fall(zone="S")).json()["incident_id"]
    inc = incident(geo_client, iid)
    assert (inc["zone"], inc["zone_source"]) == ("S", "beacon")
    assert inc["plan_x"] is None  # no GPS fix


def test_fall_with_gps_gets_its_zone_and_a_spot_on_the_plan(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, gps_fix=True, **gps(250.4, 750.6)))
    iid = geo_client.post("/api/event", json=fall()).json()["incident_id"]
    inc = incident(geo_client, iid)
    assert (inc["zone"], inc["zone_source"]) == ("S", "gps")
    assert (inc["plan_x"], inc["plan_y"]) == (250.4, 750.6)


def test_fall_with_gps_outside_the_zones_still_gets_a_spot(geo_client):
    set_zone(geo_client, "N")
    geo_client.post("/api/telemetry", json=telemetry(uptime_ms=1, gps_fix=True, **gps(1200, 300)))
    iid = geo_client.post("/api/event", json=fall()).json()["incident_id"]
    inc = incident(geo_client, iid)
    assert (inc["zone"], inc["zone_source"]) == ("N", "manual")
    assert (inc["plan_x"], inc["plan_y"]) == (1200.0, 300.0)


def test_fall_without_location_uses_the_zone_set_by_hand(geo_client):
    set_zone(geo_client, "N")
    iid = geo_client.post("/api/event", json=fall()).json()["incident_id"]
    inc = incident(geo_client, iid)
    assert (inc["zone"], inc["zone_source"], inc["plan_x"], inc["plan_y"]) == ("N", "manual", None, None)


def test_retried_fall_keeps_the_first_zone(geo_client):
    set_zone(geo_client, "N")
    first = geo_client.post("/api/event", json=fall(zone="S")).json()["incident_id"]
    again = geo_client.post("/api/event", json=fall(zone="N", sent_uptime_ms=130000)).json()["incident_id"]
    assert first == again
    assert incident(geo_client, first)["zone"] == "S"


def test_manual_report_is_marked_manual(geo_client):
    inc = geo_client.post("/api/incidents", json={"type": "hazard_report", "zone": "S"}).json()
    assert (inc["zone_source"], inc["plan_x"]) == ("manual", None)


def test_beacon_zone_counts_on_the_hazard_map(geo_client):
    set_zone(geo_client, "N")
    iid = geo_client.post("/api/event", json=fall(zone="S")).json()["incident_id"]
    geo_client.patch(f"/api/incidents/{iid}", json={"status": "confirmed"})
    counts = {h["zone"]: h["confirmed_count"] for h in geo_client.get("/api/hazards").json()}
    assert counts["S"] == 1
    assert counts.get("N", 0) == 0


def test_site_endpoint_says_whether_gps_placement_is_on(geo_client, client):
    assert geo_client.get("/api/site").json() == {"gps_ready": True, "max_error_px": 0.0, "problems": []}
    # The default client uses the shipped zones.json, which has no gps_points yet.
    assert client.get("/api/site").json()["gps_ready"] is False


def test_site_endpoint_reports_bad_gps_points(tmp_path):
    site_path = tmp_path / "zones.json"
    site_path.write_text(json.dumps({**SITE, "gps_points": GPS_POINTS[:2]}))
    with TestClient(create_app(tmp_path / "t.db", site_path)) as c:
        body = c.get("/api/site").json()
    assert body["gps_ready"] is False
    assert "at least 3" in body["problems"][0]


# ---------------------------------------------------------------------------
# Upgrading a database made before zone_source existed
# ---------------------------------------------------------------------------

def test_old_database_gets_zone_source_marked_manual(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT,
                              created_ts TEXT NOT NULL, last_seen TEXT);
        CREATE TABLE telemetry (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, ts TEXT NOT NULL,
            uptime_ms INTEGER NOT NULL, worn INTEGER NOT NULL, temp_c REAL, humidity_pct REAL,
            pressure_hpa REAL, heat_index_c REAL, accel_g REAL, tilt_deg REAL, zone TEXT,
            gps_fix INTEGER NOT NULL, lat REAL, lon REAL);
        CREATE TABLE incidents (id INTEGER PRIMARY KEY, device_id TEXT, worker_name TEXT,
            type TEXT NOT NULL, ts TEXT NOT NULL, zone TEXT, lat REAL, lon REAL, peak_g REAL,
            status TEXT NOT NULL DEFAULT 'new', notes TEXT NOT NULL DEFAULT '',
            delayed INTEGER NOT NULL DEFAULT 0, sample INTEGER NOT NULL DEFAULT 0);
        INSERT INTO incidents (type, ts, zone) VALUES ('fall', '2026-11-06T10:00:00.000Z', 'A2');
        INSERT INTO incidents (type, ts, zone) VALUES ('fall', '2026-11-06T10:01:00.000Z', NULL);
    """)
    conn.close()

    db.init_db(path)
    db.init_db(path)  # running again changes nothing

    conn = db.connect(path)
    rows = conn.execute("SELECT zone, zone_source FROM incidents ORDER BY id").fetchall()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(telemetry)")}
    conn.close()
    assert [tuple(r) for r in rows] == [("A2", "manual"), (None, None)]
    assert "zone_source" in cols
