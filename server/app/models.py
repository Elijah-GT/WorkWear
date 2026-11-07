"""Request bodies, matching docs/PROTOCOL.md. Bad bodies get a 422."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

DeviceId = Annotated[str, StringConstraints(min_length=1, max_length=64)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Zone = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]


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
    zone: str | None = None  # always null from firmware; the server sets it
    gps_fix: bool
    lat: float | None = None
    lon: float | None = None


class FallEvent(BaseModel):
    """POST /api/event."""

    model_config = ConfigDict(extra="ignore")

    device_id: DeviceId
    uptime_ms: int = Field(ge=0)
    type: Literal["fall"]
    peak_g: float
    freefall_ms: int = Field(ge=0)
    still_s: float = Field(ge=0)
    zone: str | None = None  # always null from firmware; the server sets it
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
