"""The site map (dashboard/zones.json), as the server needs it.

Two jobs, both for GPS positions:
- where a position falls on the floor-plan image (plan_x, plan_y in image pixels), and
- which zone rectangle it is in.

Both need "gps_points" in zones.json: three or more spots on the plan with their GPS position,
for example building corners read off a map:

    "gps_points": [
      {"x": 14,  "y": 20,  "lat": 41.12345, "lon": -96.12345},
      {"x": 552, "y": 20,  "lat": 41.12350, "lon": -96.12280},
      {"x": 14,  "y": 489, "lat": 41.12300, "lon": -96.12344}
    ]

From these the server fits a straight-line (affine) map from GPS to image pixels. That is
accurate enough at the scale of one building. Without gps_points, GPS positions are still
stored but are not placed on the plan.

The file is re-read when it changes, so editing it needs no server restart.
"""

import json
import math
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Zone:
    id: str
    x: float
    y: float
    w: float
    h: float

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h


@dataclass(frozen=True)
class GpsToPlan:
    """Affine map from (lat, lon) to image pixels, fitted to the gps_points."""

    lat0: float
    lon0: float
    scale: float          # degrees per unit, so the fitted numbers stay near 1
    cx: tuple             # x = cx[0]*u + cx[1]*v + cx[2]
    cy: tuple             # y = cy[0]*u + cy[1]*v + cy[2]
    max_error_px: float   # worst distance between a gps_point and where the fit puts it

    def __call__(self, lat: float, lon: float) -> tuple[float, float]:
        u = (lon - self.lon0) / self.scale
        v = (lat - self.lat0) / self.scale
        return (self.cx[0] * u + self.cx[1] * v + self.cx[2],
                self.cy[0] * u + self.cy[1] * v + self.cy[2])


@dataclass(frozen=True)
class Site:
    zones: tuple = ()
    to_pixels: GpsToPlan | None = None
    problems: tuple = field(default=())

    def to_plan(self, lat: float | None, lon: float | None) -> tuple[float, float] | None:
        """Image pixels for a GPS position, or None without gps_points or a position."""
        if self.to_pixels is None or lat is None or lon is None:
            return None
        return self.to_pixels(lat, lon)

    def zone_at(self, lat: float | None, lon: float | None) -> str | None:
        """The zone a GPS position is in (the smallest, if zones overlap), or None."""
        p = self.to_plan(lat, lon)
        if p is None:
            return None
        inside = [z for z in self.zones if z.contains(*p)]
        if not inside:
            return None
        return min(inside, key=lambda z: z.w * z.h).id


EMPTY = Site()


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _solve3(m: list[list[float]], b: list[float]) -> list[float]:
    """Solve a 3x3 linear system by Gaussian elimination with partial pivoting."""
    a = [row[:] + [rhs] for row, rhs in zip(m, b)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(a[r][col]))
        if abs(a[pivot][col]) < 1e-12:
            raise ValueError("singular")
        a[col], a[pivot] = a[pivot], a[col]
        for r in range(col + 1, 3):
            f = a[r][col] / a[col][col]
            for c in range(col, 4):
                a[r][c] -= f * a[col][c]
    out = [0.0, 0.0, 0.0]
    for r in (2, 1, 0):
        out[r] = (a[r][3] - sum(a[r][c] * out[c] for c in range(r + 1, 3))) / a[r][r]
    return out


def _spread(pts: list[tuple[float, float]]) -> float:
    """Twice the largest triangle area among the points, relative to their size. ~0 = in a line."""
    size = max(max(abs(p[0] - q[0]), abs(p[1] - q[1])) for p in pts for q in pts)
    if size == 0:
        return 0.0
    best = 0.0
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            for k in range(j + 1, len(pts)):
                (x1, y1), (x2, y2), (x3, y3) = pts[i], pts[j], pts[k]
                best = max(best, abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)))
    return best / (size * size)


def fit_gps_points(points) -> GpsToPlan:
    """Least-squares affine fit from GPS to image pixels. Raises ValueError with a reason."""
    if not isinstance(points, list) or len(points) < 3:
        raise ValueError("gps_points needs at least 3 points")
    for p in points:
        if not isinstance(p, dict) or not all(_num(p.get(k)) for k in ("x", "y", "lat", "lon")):
            raise ValueError("each gps_point needs numbers x, y, lat, lon")
        if not (-90 <= p["lat"] <= 90 and -180 <= p["lon"] <= 180):
            raise ValueError("a gps_point has lat/lon out of range")
    if _spread([(p["lon"], p["lat"]) for p in points]) < 1e-3:
        raise ValueError("gps_points are in a line (or the same spot); pick 3 corners")
    if _spread([(p["x"], p["y"]) for p in points]) < 1e-3:
        raise ValueError("gps_points are in a line on the image; pick 3 corners")

    lat0 = sum(p["lat"] for p in points) / len(points)
    lon0 = sum(p["lon"] for p in points) / len(points)
    scale = max(max(abs(p["lat"] - lat0), abs(p["lon"] - lon0)) for p in points)
    rows = [((p["lon"] - lon0) / scale, (p["lat"] - lat0) / scale, 1.0) for p in points]

    # Normal equations: (A^T A) c = A^T target, once for x and once for y.
    ata = [[sum(r[i] * r[j] for r in rows) for j in range(3)] for i in range(3)]
    cx = _solve3(ata, [sum(r[i] * p["x"] for r, p in zip(rows, points)) for i in range(3)])
    cy = _solve3(ata, [sum(r[i] * p["y"] for r, p in zip(rows, points)) for i in range(3)])

    def fitted(r):
        return (cx[0] * r[0] + cx[1] * r[1] + cx[2], cy[0] * r[0] + cy[1] * r[1] + cy[2])

    err = max(math.dist(fitted(r), (p["x"], p["y"])) for r, p in zip(rows, points))
    return GpsToPlan(lat0, lon0, scale, tuple(cx), tuple(cy), err)


def parse_site(cfg) -> Site:
    """Build a Site from parsed zones.json. Bad parts are skipped and listed in problems."""
    if not isinstance(cfg, dict):
        return Site(problems=("zones.json is not an object",))
    problems = []
    zones = []
    for z in cfg.get("zones") or []:
        # Only floor-plan zones (x, y, w, h) have a place for GPS; grid zones are skipped.
        if isinstance(z, dict) and isinstance(z.get("id"), str) and z["id"] \
                and all(_num(z.get(k)) for k in ("x", "y", "w", "h")) and z["w"] > 0 and z["h"] > 0:
            zones.append(Zone(z["id"], z["x"], z["y"], z["w"], z["h"]))
    to_pixels = None
    if "gps_points" in cfg:
        try:
            to_pixels = fit_gps_points(cfg["gps_points"])
        except ValueError as e:
            problems.append(str(e))
    return Site(tuple(zones), to_pixels, tuple(problems))


class SiteFile:
    """zones.json, re-read whenever the file changes. A missing or broken file gives EMPTY."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._stamp = None
        self._site = EMPTY

    def get(self) -> Site:
        try:
            st = self.path.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            self._stamp, self._site = None, EMPTY
            return EMPTY
        if stamp != self._stamp:
            try:
                site = parse_site(json.loads(self.path.read_text(encoding="utf-8")))
            except (OSError, ValueError) as e:  # json.JSONDecodeError is a ValueError
                site = Site(problems=(f"zones.json could not be read: {e}",))
            self._stamp, self._site = stamp, site
        return self._site
