# PROTOCOL.md: helmet, server, and dashboard messages

This file is the single source of truth for every message between the helmet, the server, and the dashboard. If it disagrees with `CLAUDE.md` or `PLAN.md`, this file wins; fix the other one.

**Changing anything here:** never rename a field or change its type without updating this file, the firmware, the server, and the dashboard in the same commit. Adding a new optional field is fine; note it in the changelog at the bottom.

## 1. General rules

- Transport: HTTP/1.1, JSON bodies, `Content-Type: application/json`. No auth (demo on a private hotspot).
- Server: Python FastAPI + SQLite, on a laptop at port **8000**. The helmet's server URL lives in `firmware/config.h` (for example `http://192.168.43.10:8000`).
- Units are in the field names: `_c` = degrees Celsius, `_pct` = percent, `_hpa` = hectopascals, `_g` = multiples of gravity, `_deg` = degrees, `_ms` = milliseconds, `_s` = seconds.
- Missing or failed readings are sent as `null`, never as `0` or `-999`.
- **Time:** the ESP32 has no real-time clock. It sends `uptime_ms` (milliseconds since boot) only. The server stamps every message on receipt as `ts`, an ISO 8601 UTC string, for example `"2026-11-06T15:04:05.123Z"`.
- **Zone:** firmware sends `"zone": null`, unless it locates itself with BLE zone beacons (`HAS_BLE_BEACONS 1` in `firmware/config.h`); then it sends the zone id of the strongest beacon. The server picks each message's zone in this order (section 3): the helmet's own zone, then the zone its GPS fix is in, then the zone assigned on the dashboard (section 4). It records which one it used as `zone_source`.
- **Device IDs:** `helmet-01`, `helmet-02`, and so on, set in `firmware/config.h`. The server creates a device the first time it hears from a new `device_id`.
- **Simulated devices:** the simulator (`server/simulator.py`) uses IDs starting with `sim-` (for example `sim-01`). Every incident from a `sim-` device gets `sample: true`, so the dashboard labels it "sample data". Real helmets must never use the `sim-` prefix.
- **Zone IDs:** short strings (up to 32 characters, no spaces) that match the floor-plan image, for example `1520-W` or `1522`. The dashboard's floor-plan config (`dashboard/zones.json`) defines the list and a display label for each. Examples elsewhere in this file use `A2` and `B1`; any ID works the same way.

### Responses

| Code | Meaning |
|---|---|
| `200` | OK. Body is JSON (see each route). |
| `404` | Unknown `device_id` or incident `id`. |
| `422` | Body failed validation (FastAPI default). The body says which field. |

Firmware only needs to check for `200`. Anything else, or no answer within 3 s, counts as a failure.

## 2. Helmet to server

### 2.1 Telemetry: `POST /api/telemetry`

Sent about once per second.

```json
{"device_id":"helmet-01","uptime_ms":123456,"worn":true,"temp_c":29.4,
 "humidity_pct":41.0,"pressure_hpa":1009.2,"heat_index_c":30.1,
 "accel_g":1.01,"tilt_deg":12.0,"zone":null,"gps_fix":false,"lat":null,"lon":null}
```

| Field | Type | Notes |
|---|---|---|
| `device_id` | string | Required. |
| `uptime_ms` | integer | Required. Milliseconds since boot. Resets to 0 on reboot. |
| `worn` | boolean | From the worn sensor. Always `true` when `HAS_WORN_SENSOR` is 0. |
| `temp_c` | number or null | BME280 ambient temperature at the helmet. Not body temperature. |
| `humidity_pct` | number or null | BME280 relative humidity, 0 to 100. |
| `pressure_hpa` | number or null | BME280 pressure. |
| `heat_index_c` | number or null | Computed on the helmet from `temp_c` and `humidity_pct` (NOAA heat index formula). `null` if either input is `null`. |
| `accel_g` | number or null | Total acceleration magnitude, about 1.0 at rest. Latest sample, not a peak. |
| `tilt_deg` | number or null | Angle between the helmet's up axis and vertical: 0 = upright, 90 = on its side, 180 = upside down. |
| `zone` | string or null | `null`, or the zone id of the strongest BLE beacon when beacons are on (section 1). Up to 32 characters `A-Z a-z 0-9 . _ -`; anything else is treated as `null`. |
| `gps_fix` | boolean | `true` only when the GPS has a valid fix. |
| `lat`, `lon` | number or null | Decimal degrees (WGS84). `null` unless `gps_fix` is `true`. |
| `drop_check` | object, optional | Diagnostics for bench drop tests (firmware `DROP_DEBUG 1`). Left out until the helmet has seen a drop; then its **latest** check on every message: `{"uptime_ms":4200,"freefall_ms":43,"min_g":0.20,"peak_g":1.41,"freefall_need_ms":100,"impact_need_g":2.5}`. `uptime_ms` is when the check finished; `freefall_ms` the longest unbroken run below the free-fall threshold within 1.5 s; `min_g` the lowest reading; `peak_g` the hardest hit; the `*_need_*` fields are the helmet's thresholds. Not a fall event, and not stored in the database. |

Response: `{"ok": true}`.

If Wi-Fi is down, telemetry is **dropped** (it is not queued). Only fall events are queued.

### 2.2 Event: `POST /api/event`

Sent as soon as the fall state machine reaches `ALERT`.

```json
{"device_id":"helmet-01","uptime_ms":123999,"type":"fall",
 "peak_g":4.2,"freefall_ms":220,"still_s":2.1,"zone":null}
```

| Field | Type | Notes |
|---|---|---|
| `device_id` | string | Required. |
| `uptime_ms` | integer | Required. Uptime when the alert fired, not when it was sent. |
| `type` | string | `"fall"`. This is the only helmet event type in the MVP. A "recovered" (cancelled) fall is logged on the helmet only, not sent. |
| `peak_g` | number | Highest acceleration during the impact. The IMU clips around 8 g, so treat high values as "8 g or more". |
| `freefall_ms` | integer | How long free-fall lasted. |
| `still_s` | number | How long the helmet stayed still before the alert. |
| `zone` | string or null | Where the helmet was when it fell (beacons), or `null`. A retried event keeps the zone of the first copy the server accepted. |
| `sent_uptime_ms` | integer, optional | Uptime when this POST was sent. Equal to `uptime_ms` on the first try; larger on retries. |

Response: `{"ok": true, "incident_id": 17}`.

**Retries:** if the POST fails, the helmet queues the event in RAM and retries every 2 s until it gets a `200`. The queue is lost on reboot. The server treats `(device_id, uptime_ms)` as the event's unique key: a repeat returns `200` with the same `incident_id` and does not create a second incident.

**Late arrival:** a queued event is stamped with the time the server receives it, which can be later than the fall itself. The server sets `delayed: true` on the incident when `sent_uptime_ms - uptime_ms` is more than 5000. If `sent_uptime_ms` is missing, `delayed` is `false`. (Comparing with telemetry does not work, because no telemetry gets through while Wi-Fi is down.)

## 3. What the server does with incoming messages

1. Looks up the device by `device_id`, creating it if it is new (`name` = `device_id`, `zone` = `null`).
2. Stamps `ts` (server time) and picks the message's `zone`, measured before set by hand, and records `zone_source`:
   1. `"beacon"`: the zone the helmet sent (BLE beacons).
   2. `"gps"`: the zone rectangle its GPS fix falls in. Needs `gps_points` in `dashboard/zones.json` (three or more spots on the plan with their lat/lon). For a fall, the fix comes from the device's latest telemetry. A fix outside every zone does not count, because GPS is only good to several metres.
   3. `"manual"`: the zone assigned on the dashboard.
   4. No zone at all: `zone` and `zone_source` are `null`.
3. Telemetry: stores the row and updates the device's latest reading and `last_seen`.
4. Fall event: stores the raw event, then creates an incident (section 5) with:
   - `worker_name` = a copy of the device's `name` at this moment (a snapshot, so history stays correct if the helmet is reassigned);
   - `zone` and `zone_source` from step 2;
   - `lat`/`lon` from the device's latest telemetry, only if it had `gps_fix: true`;
   - `status` = `"new"`.
5. Does not suppress anything: when to alert is decided on the helmet.

`dashboard/zones.json` is re-read when it changes, so adding `gps_points` needs no restart.

A device counts as **online** if its last telemetry arrived within the last **5 s**.

## 4. Dashboard to server: devices

### `GET /api/devices`

```json
[{"device_id":"helmet-01","name":"Sam R.","zone":"A2","online":true,
  "last_seen":"2026-11-06T15:04:05.123Z",
  "latest":{"uptime_ms":123456,"worn":true,"temp_c":29.4,"humidity_pct":41.0,
            "pressure_hpa":1009.2,"heat_index_c":30.1,"heat_level":"caution",
            "accel_g":1.01,"tilt_deg":12.0,"gps_fix":false,"lat":null,"lon":null,
            "zone":"A2","zone_source":"manual"}}]
```

Each device also has `drop_check`: the latest `drop_check` its telemetry carried (section 2.1), or `null`. The server keeps it in memory only, so it is `null` again after a restart.

`latest` is `null` until the first telemetry arrives. `heat_level` is computed by the server from `heat_index_c` (section 7). The device's `zone` is the one assigned on the dashboard; `latest.zone` and `latest.zone_source` say where its latest reading placed it (section 3). The dashboard places a worker by `latest.zone` when `zone_source` is `"beacon"` or `"gps"`, and by the assigned `zone` otherwise.

### `PATCH /api/devices/{device_id}`

Assign a worker name and/or a zone. Send only the fields you are changing.

```json
{"name":"Sam R.","zone":"A2"}
```

Response: the updated device, in the same shape as one item from `GET /api/devices`. The dashboard labels a zone set by hand **"simulated location"**, because it is not measured; zones from beacons or GPS are marked as measured.

### `GET /api/site`

Whether GPS positions can be placed on the floor plan:

```json
{"gps_ready":true,"max_error_px":1.4,"problems":[]}
```

`gps_ready` is `true` when `dashboard/zones.json` has usable `gps_points`. `max_error_px` is the worst distance between a `gps_point` and where the fitted map puts it (a large value means a point was measured wrong). `problems` lists anything wrong with the file.

## 5. Incidents

### Incident object

```json
{"id":17,"device_id":"helmet-01","worker_name":"Sam R.","type":"fall",
 "ts":"2026-11-06T15:04:06.010Z","zone":"A2","zone_source":"manual","lat":null,"lon":null,
 "plan_x":null,"plan_y":null,"peak_g":4.2,"status":"new","notes":"","delayed":false,"sample":false}
```

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Assigned by the server. |
| `device_id` | string or null | `null` for manual reports not tied to a helmet. |
| `worker_name` | string or null | Snapshot taken when the incident is created. |
| `type` | string | `"fall"` (from a helmet), `"injury_report"` or `"hazard_report"` (both manual; a hazard is something like a wet floor). |
| `ts` | string | Server time (ISO 8601 UTC). |
| `zone` | string or null | |
| `zone_source` | string or null | How `zone` was found: `"beacon"`, `"gps"`, or `"manual"` (section 3). Manual reports are `"manual"`. Incidents from before 2026-11-07 that have a zone are `"manual"`. |
| `lat`, `lon` | number or null | |
| `plan_x`, `plan_y` | number or null | Where `lat`/`lon` is on the floor-plan image, in its pixels (worked out from `gps_points` each time it is asked for). `null` without a position or without `gps_points`. The dashboard draws the fall's red dot here; otherwise it draws it at an approximate spot in `zone`. |
| `peak_g` | number or null | Falls only. |
| `status` | string | `"new"`, `"confirmed"`, or `"dismissed"`. |
| `notes` | string | Free text; empty by default. |
| `delayed` | boolean | `true` if a queued fall event arrived late (section 2.2). |
| `sample` | boolean | `true` for seeded or demo history. The dashboard must label these "sample data". |

### `GET /api/incidents`

Optional query parameters: `status` (`new`, `confirmed`, or `dismissed`), `limit` (default 100). Newest first. Returns a list of incident objects.

### `POST /api/incidents` (manual report, stretch)

```json
{"type":"injury_report","zone":"B1","notes":"Cut hand on rebar","device_id":null,"worker_name":"Alex P."}
```

`type` must be `"injury_report"` or `"hazard_report"`; falls only come from helmets. `zone` is required; `notes`, `device_id`, and `worker_name` are optional. The server sets `ts` and `status: "new"`, and returns the new incident object.

- If `device_id` is given, it must be a known device (otherwise `404`). When `worker_name` is left out, the server copies the device's current name, as it does for falls.
- A report for a `sim-` device gets `sample: true`, like its falls.
- Unknown fields are rejected with `422`, to catch typos on the dashboard.

### `PATCH /api/incidents/{id}` (stretch)

```json
{"status":"confirmed","notes":"Dropped from scaffold level 2, worker OK"}
```

Send only the fields you are changing. Returns the updated incident object. `status` can move in any direction (for example a dismissed incident can go back to `new`); `notes` can be set to `""` but not `null`. Returns `404` for an unknown `id`.

## 6. Hazards (stretch): `GET /api/hazards`

Optional query parameter: `hours` (only count incidents and telemetry from the last N hours; must be greater than 0; default: all time).

```json
[{"zone":"A2","confirmed_count":3,"sample_count":1,"max_heat_index_c":31.5},
 {"zone":"B1","confirmed_count":0,"sample_count":0,"max_heat_index_c":27.0}]
```

- `confirmed_count`: incidents in that zone with `status: "confirmed"` (any type). New and dismissed incidents do not count.
- `sample_count`: how many of those confirmed incidents are sample data (`sample: true`). If it is above 0, the dashboard must say the zone's count includes sample data.
- `max_heat_index_c`: the highest `heat_index_c` from telemetry tagged with that zone in the same time window, or `null`.
- Every zone with an incident or with telemetry appears in the list, sorted by zone. Incidents and telemetry with no zone are left out.

## 7. Heat levels

The server maps `heat_index_c` to `heat_level` using the NWS heat index bands. The dashboard colors workers by `heat_level` and calls it **heat risk** (ambient conditions at the helmet), never heat stress or body temperature. The dashboard's map heat layer applies the same bands to `max_heat_index_c` from `GET /api/hazards` (`heatLevelFor` in `dashboard/logic.js`), so change both if the bands change.

| `heat_level` | Heat index | Suggested color |
|---|---|---|
| `"normal"` | below 27 °C | green |
| `"caution"` | 27 to below 32 °C | yellow |
| `"extreme_caution"` | 32 to below 39 °C | orange |
| `"danger"` | 39 to below 51 °C | red |
| `"extreme_danger"` | 51 °C and above | dark red |
| `null` | no reading | grey |

## 8. Changelog

| Date | Change |
|---|---|
| 2026-11-06 | First version, from the data contract in `CLAUDE.md` and the decisions in `PLAN.md` section 8. |
| 2026-11-06 | Added optional `sent_uptime_ms` to fall events and based `delayed` on it. Added the `sim-` device ID rule (incidents marked `sample: true`). |
| 2026-11-06 | S3: added `sample_count` to `GET /api/hazards`; spelled out manual-report rules (known device, name copied from the device, `sim-` reports are sample) and that `PATCH /api/incidents` status can move in any direction. |
| 2026-11-06 | D5: noted that the dashboard's heat layer uses the same heat bands (section 7). No field changes. |
| 2026-11-07 | D7: zone ID examples updated for the room 1520 floor plan. No field changes. |
| 2026-11-07 | F4: optional `drop_check` object on telemetry (bench diagnostics) and on each device in `GET /api/devices` (memory only). Old firmware and clients are unaffected. |
| 2026-11-07 | Location (D8, decided by Elijah): helmets may send their own `zone` (BLE beacons); the server picks beacon, then GPS, then dashboard zone (section 3). New optional fields: `zone_source` on incidents and `latest`; `latest.zone`; `plan_x`/`plan_y` on incidents. New `GET /api/site`. `zones.json` may have `gps_points`. |
