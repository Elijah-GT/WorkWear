"""Request bodies, matching docs/PROTOCOL.md. Bad bodies get a 422."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

DeviceId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Zone = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]


class DropCheck(BaseModel):
    """The helmet's latest drop check (firmware DROP_DEBUG), for bench testing on battery.

    Optional in telemetry; kept in memory only (PROTOCOL.md section 2.1).
    """

    model_config = ConfigDict(extra="ignore")

    uptime_ms: int = Field(ge=0)          # helmet uptime when the check finished
    freefall_ms: int = Field(ge=0)        # longest run below the free-fall threshold
    min_g: float | None = None
    peak_g: float | None = None
    freefall_need_ms: int | None = None   # the helmet's FREEFALL_MIN_MS
    impact_need_g: float | None = None    # the helmet's IMPACT_G


class Telemetry(BaseModel):
    """POST /api/telemetry. Unknown extra fields are ignored so newer firmware still works."""

    model_config = ConfigDict(extra="ignore")

    device_id: DeviceId
    uptime_ms: int = Field(ge=0)
    worn: bool
    temp_c: float | None = None
    humidity_pct: float | None = None
    pressure_hpa: float | None = None
    heat_index_c: float | None = None
    accel_g: float | None = None
    tilt_deg: float | None = None
    zone: str | None = None  # null, or the helmet's own zone from beacons (main.resolve_zone)
    gps_fix: bool
    lat: float | None = None
    lon: float | None = None
    drop_check: DropCheck | None = None  # optional, diagnostics only (not stored in the database)


class FallEvent(BaseModel):
    """POST /api/event."""

    model_config = ConfigDict(extra="ignore")

    device_id: DeviceId
    uptime_ms: int = Field(ge=0)
    type: Literal["fall"]
    peak_g: float
    freefall_ms: int = Field(ge=0)
    still_s: float = Field(ge=0)
    zone: str | None = None  # null, or where the helmet was when it fell (beacons)
    sent_uptime_ms: int | None = Field(default=None, ge=0)


class DevicePatch(BaseModel):
    """PATCH /api/devices/{device_id}. Only the fields sent are changed."""

    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    zone: Zone | None = None

    @model_validator(mode="after")
    def name_cannot_be_null(self):
        # "zone": null clears the zone, but every device must keep a name.
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be null")
        return self


IncidentStatus = Literal["new", "confirmed", "dismissed"]
Notes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]


class IncidentReport(BaseModel):
    """POST /api/incidents: a manual report entered on the dashboard. Falls only come from helmets."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["injury_report", "hazard_report"]
    zone: Zone
    notes: Notes = ""
    device_id: DeviceId | None = None
    worker_name: Name | None = None


class IncidentPatch(BaseModel):
    """PATCH /api/incidents/{id}. Only the fields sent are changed."""

    model_config = ConfigDict(extra="forbid")

    status: IncidentStatus | None = None
    notes: Notes | None = None

    @model_validator(mode="after")
    def fields_cannot_be_null(self):
        for field in ("status", "notes"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self
