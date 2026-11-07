"""WorkWear server. Routes follow docs/PROTOCOL.md.

Run from the server/ folder:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.staticfiles import StaticFiles

from . import db
from .heat import heat_level
from .models import DevicePatch, FallEvent, IncidentPatch, IncidentReport, IncidentStatus, Telemetry
from .site import Site, SiteFile

DASHBOARD_DIR = Path(__file__).resolve().parent.parent.parent / "dashboard"
SITE_FILE = DASHBOARD_DIR / "zones.json"
MAX_ZONE_LEN = 32                      # same limit as zones set on the dashboard

ONLINE_WINDOW = timedelta(seconds=5)   # PROTOCOL.md section 3
DELAYED_AFTER_MS = 5000                # PROTOCOL.md section 2.2
SIM_PREFIX = "sim-"                    # PROTOCOL.md section 1


def get_conn(request: Request) -> Iterator[sqlite3.Connection]:
    """FastAPI dependency: one SQLite connection per request."""
    conn = db.connect(request.app.state.db_path)
    try:
        yield conn
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Response shapes (PROTOCOL.md sections 4 and 5)
# ---------------------------------------------------------------------------

def latest_view(t: sqlite3.Row | None) -> dict | None:
    if t is None:
        return None
    return {
        "uptime_ms": t["uptime_ms"],
        "worn": bool(t["worn"]),
        "temp_c": t["temp_c"],
        "humidity_pct": t["humidity_pct"],
        "pressure_hpa": t["pressure_hpa"],
        "heat_index_c": t["heat_index_c"],
        "heat_level": heat_level(t["heat_index_c"]),
        "accel_g": t["accel_g"],
        "tilt_deg": t["tilt_deg"],
        "gps_fix": bool(t["gps_fix"]),
        "lat": t["lat"],
        "lon": t["lon"],
        "zone": t["zone"],                # where this reading placed the helmet
        "zone_source": t["zone_source"],  # how: 'beacon', 'gps', 'manual', or None
    }


def device_view(conn: sqlite3.Connection, d: sqlite3.Row) -> dict:
    last_seen = d["last_seen"]
    online = last_seen is not None and db.now() - db.parse_ts(last_seen) <= ONLINE_WINDOW
    return {
        "device_id": d["device_id"],
        "name": d["name"],
        "zone": d["zone"],
        "online": online,
        "last_seen": last_seen,
        "latest": latest_view(db.latest_telemetry(conn, d["device_id"])),
    }


def incident_view(i: sqlite3.Row, site: Site) -> dict:
    view = dict(i)
    view["delayed"] = bool(i["delayed"])
    view["sample"] = bool(i["sample"])
    # Where the incident's GPS position is on the floor plan, in image pixels. Worked out when
    # asked, so adding gps_points to zones.json later also places older incidents.
    p = site.to_plan(i["lat"], i["lon"])
    view["plan_x"], view["plan_y"] = (round(p[0], 1), round(p[1], 1)) if p else (None, None)
    return view


def clean_zone(zone: str | None) -> str | None:
    """A zone reported by a helmet, or None if it is missing or unusable."""
    if not isinstance(zone, str):
        return None
    zone = zone.strip()
    return zone if 0 < len(zone) <= MAX_ZONE_LEN else None


def resolve_zone(helmet_zone: str | None, gps_zone: str | None,
                 assigned_zone: str | None) -> tuple[str | None, str | None]:
    """Pick a message's zone and say where it came from. Measured beats set by hand:

    1. 'beacon': the helmet located itself (BLE beacons, firmware HAS_BLE_BEACONS 1).
    2. 'gps':    the helmet's GPS fix is inside a zone (needs gps_points in zones.json).
    3. 'manual': the zone the supervisor set on the dashboard.
    A GPS fix outside every zone keeps the manual zone: GPS is only good to several metres.
    """
    if helmet_zone:
        return helmet_zone, "beacon"
    if gps_zone:
        return gps_zone, "gps"
    if assigned_zone:
        return assigned_zone, "manual"
    return None, None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

def create_app(db_path: Path | None = None, site_path: Path | None = None) -> FastAPI:
    path = db_path or db.db_path()
    site_file = SiteFile(site_path or SITE_FILE)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.init_db(path)
        yield

    app = FastAPI(title="WorkWear server", lifespan=lifespan)
    app.state.db_path = path

    @app.post("/api/telemetry")
    def post_telemetry(t: Telemetry, conn: sqlite3.Connection = Depends(get_conn)):
        ts = db.utc_now()
        body = t.model_dump()
        if not t.gps_fix:
            # PROTOCOL.md: lat/lon only count with a fix. Keeps bad positions off the map.
            body["lat"] = body["lon"] = None
        gps_zone = site_file.get().zone_at(body["lat"], body["lon"])
        with conn:
            device = db.ensure_device(conn, t.device_id, ts)
            zone, source = resolve_zone(clean_zone(t.zone), gps_zone, device["zone"])
            db.insert_telemetry(conn, body, ts, zone, source)
        return {"ok": True}

    @app.post("/api/event")
    def post_event(ev: FallEvent, conn: sqlite3.Connection = Depends(get_conn)):
        # A retried event (same device_id + uptime_ms) returns the incident already made.
        existing = db.find_event(conn, ev.device_id, ev.uptime_ms)
        if existing is not None:
            return {"ok": True, "incident_id": existing["incident_id"]}

        ts = db.utc_now()
        try:
            with conn:  # incident and event are saved together or not at all
                device = db.ensure_device(conn, ev.device_id, ts)
                latest = db.latest_telemetry(conn, ev.device_id)
                has_fix = latest is not None and bool(latest["gps_fix"])
                lat = latest["lat"] if has_fix else None
                lon = latest["lon"] if has_fix else None
                # The event's own zone is where the helmet was when it fell (beacons).
                zone, source = resolve_zone(clean_zone(ev.zone), site_file.get().zone_at(lat, lon),
                                            device["zone"])
                delayed = (
                    ev.sent_uptime_ms is not None
                    and ev.sent_uptime_ms - ev.uptime_ms > DELAYED_AFTER_MS
                )
                incident_id = db.insert_incident(conn, {
                    "device_id": ev.device_id,
                    "worker_name": device["name"],  # snapshot, so renames don't rewrite history
                    "type": "fall",
                    "ts": ts,
                    "zone": zone,
                    "zone_source": source,
                    "lat": lat,
                    "lon": lon,
                    "peak_g": ev.peak_g,
                    "status": "new",
                    "notes": "",
                    "delayed": delayed,
                    "sample": ev.device_id.startswith(SIM_PREFIX),
                })
                db.insert_event(conn, ev.model_dump(), ts, zone, incident_id)
        except sqlite3.IntegrityError:
            # Two copies of the same event arrived at once; the other one won.
            existing = db.find_event(conn, ev.device_id, ev.uptime_ms)
            if existing is None:
                raise
            return {"ok": True, "incident_id": existing["incident_id"]}
        return {"ok": True, "incident_id": incident_id}

    @app.get("/api/devices")
    def get_devices(conn: sqlite3.Connection = Depends(get_conn)):
        return [device_view(conn, d) for d in db.list_devices(conn)]

    @app.patch("/api/devices/{device_id}")
    def patch_device(device_id: str, patch: DevicePatch, conn: sqlite3.Connection = Depends(get_conn)):
        if db.get_device(conn, device_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown device_id: {device_id}")
        with conn:
            db.update_device(conn, device_id, patch.model_dump(include=patch.model_fields_set))
        return device_view(conn, db.get_device(conn, device_id))

    @app.get("/api/incidents")
    def get_incidents(
        status: IncidentStatus | None = None,
        limit: int = Query(100, ge=1, le=1000),
        conn: sqlite3.Connection = Depends(get_conn),
    ):
        site = site_file.get()
        return [incident_view(i, site) for i in db.list_incidents(conn, status, limit)]

    @app.post("/api/incidents")
    def post_incident(rep: IncidentReport, conn: sqlite3.Connection = Depends(get_conn)):
        worker_name = rep.worker_name
        if rep.device_id is not None:
            device = db.get_device(conn, rep.device_id)
            if device is None:
                raise HTTPException(status_code=404, detail=f"unknown device_id: {rep.device_id}")
            if worker_name is None:
                worker_name = device["name"]  # snapshot, like falls
        with conn:
            incident_id = db.insert_incident(conn, {
                "device_id": rep.device_id,
                "worker_name": worker_name,
                "type": rep.type,
                "ts": db.utc_now(),
                "zone": rep.zone,
                "zone_source": "manual",  # picked on the report form
                "lat": None,
                "lon": None,
                "peak_g": None,
                "status": "new",
                "notes": rep.notes,
                "delayed": False,
                "sample": rep.device_id is not None and rep.device_id.startswith(SIM_PREFIX),
            })
        return incident_view(db.get_incident(conn, incident_id), site_file.get())

    @app.patch("/api/incidents/{incident_id}")
    def patch_incident(incident_id: int, patch: IncidentPatch, conn: sqlite3.Connection = Depends(get_conn)):
        if db.get_incident(conn, incident_id) is None:
            raise HTTPException(status_code=404, detail=f"unknown incident id: {incident_id}")
        with conn:
            db.update_incident(conn, incident_id, patch.model_dump(include=patch.model_fields_set))
        return incident_view(db.get_incident(conn, incident_id), site_file.get())

    @app.get("/api/hazards")
    def get_hazards(
        hours: float | None = Query(None, gt=0),
        conn: sqlite3.Connection = Depends(get_conn),
    ):
        since = None if hours is None else db.format_ts(db.now() - timedelta(hours=hours))
        return db.hazards(conn, since)

    @app.get("/api/site")
    def get_site():
        """Whether GPS positions can be placed on the floor plan (zones.json gps_points)."""
        site = site_file.get()
        t = site.to_pixels
        return {
            "gps_ready": t is not None,
            "max_error_px": round(t.max_error_px, 1) if t else None,
            "problems": list(site.problems),
        }

    # Serve the dashboard from "/" once it exists. Registered last, so /api/* wins.
    if DASHBOARD_DIR.is_dir():
        app.mount("/", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")

    return app


app = create_app()
