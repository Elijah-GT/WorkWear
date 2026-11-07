"""Example helmet messages from docs/PROTOCOL.md, with overrides for tests."""


def telemetry(**overrides):
    body = {
        "device_id": "helmet-01", "uptime_ms": 123456, "worn": True, "temp_c": 29.4,
        "humidity_pct": 41.0, "pressure_hpa": 1009.2, "heat_index_c": 30.1,
        "accel_g": 1.01, "tilt_deg": 12.0, "zone": None, "gps_fix": False,
        "lat": None, "lon": None,
    }
    body.update(overrides)
    return body


def fall(**overrides):
    body = {
        "device_id": "helmet-01", "uptime_ms": 123999, "type": "fall",
        "peak_g": 4.2, "freefall_ms": 220, "still_s": 2.1, "zone": None,
    }
    body.update(overrides)
    return body


def without(body, key):
    body = dict(body)
    del body[key]
    return body
