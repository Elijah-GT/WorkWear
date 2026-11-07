# PLAN.md: Construction Safety Helmet (hackathon MVP)

Drafted from the team whiteboard and decisions so far. Items marked **[decided]** came from the team. Items marked **[proposed]** are suggestions that need the team's OK. Fill in owners and dates where marked TBD. Agents: read `CLAUDE.md` first.

Related: customer discovery email (student-researcher outreach) is in the team doc "Customer Discovery Emails: Construction Safety Helmet" (shared by Elijah).

## 1. Goal

By the end of the build, show a working helmet prototype that detects a staged fall, reports it to a dashboard within a few seconds, and shows heat exposure and location for named workers. Indoor demo with Wi-Fi.

## 2. MVP scope

From the whiteboard table (Hardware / Dashboard / Data Analysis):

| Area | In the MVP | Notes |
|---|---|---|
| Hardware | ESP32, IMU, temperature sensor, wiring, housing, body-dynamics data | **[decided]** Hardware list: ESP32, GY-BNO085 (IMU), BME280 (barometer, temp, humidity), NULLLAB 1200 mAh LiPo module, GY-NEO6MV2 (NEO-6M) GPS with ceramic antenna, 3D-printed housing and hat clip. LEDs on hand, for later |
| Dashboard | Mapping, incident compilation, local data storage, assign names | Zone map indoors. Heat color per worker |
| Dashboard (stretch) | Hazard zones: red markers or shaded zones where confirmed falls and reported injuries happened | Built after the incident list works. A supervisor confirms incidents |
| Data analysis | Programming and detecting falls, location data, data transfer to dashboard | Fall detection runs on the device |

**Later, only if time:** heart rate, Raspberry Pi networking, navigation lights (LEDs on a rescuer's helmet that point toward the fallen worker). The GPS module is mounted for the MVP but will not fix indoors, so the indoor demo uses zones; outdoor GPS tracking is a bonus.

## 3. Architecture **[proposed]**

```
Helmet: BNO085 + BME280 (I2C) + GPS (UART) -> ESP32 (5 V from the NULLLAB LiPo module) -> Wi-Fi (2.4 GHz hotspot)
Laptop: server (HTTP API + SQLite) -> web dashboard
```

- Telemetry about once a second, plus an immediate event when a fall is detected.
- Server timestamps messages on receipt (the ESP32 has no real-time clock).
- Same server can move to a Raspberry Pi later.
- Message formats: `docs/PROTOCOL.md` (single source of truth).

## 4. Acceptance criteria (how we know it works)

- [ ] A1. The ESP32 runs on battery and streams telemetry to the dashboard for 10+ minutes without a reset.
- [ ] A2. A staged padded drop produces a "fall" incident on the dashboard within about 3 seconds.
- [ ] A3. Normal activity does not trigger false alarms across a set of trials: walking, sitting, nodding, looking down, climbing steps, and setting the helmet down gently. Record the number of trials and results.
- [ ] A4. Heat color and heat index on the dashboard change when the sensor is exposed to warmer air.
- [ ] A5. The dashboard shows named devices, an incident list that persists after a refresh, and a location (zone) per device.
- [ ] A6. The helmet being taken off or set down does not raise a fall alert (worn detection). If the worn sensor is cut, A6 becomes a stretch test and the firmware sends `worn: true` always; say so in the pitch.
- [ ] A7 (stretch). Confirmed incidents appear as hazard markers or shaded zones on the map. Dismissed incidents do not.

## 5. Workstreams and tasks

Five people, five workstreams. Owners are TBD: write your name next to a task before starting.

### W1. Hardware and power (Owner: TBD)
- [ ] Wire ESP32 + BNO085 + BME280 on a breadboard; confirm both I2C devices are detected.
- [ ] Wire the GY-NEO6MV2 to ESP32 UART2: GPS TX -> GPIO16, GPS RX -> GPIO17, VCC to 3V3, GND to GND. Confirm NMEA sentences at 9600 baud on serial. Test a fix outdoors with sky view (allow several minutes on the first fix; the board's LED blinks on fix).
- [ ] Power the ESP32 from the NULLLAB module's 5 V header pin to VIN (or its USB-A to the ESP32's micro-USB). Never the raw battery pin into VIN, and never laptop USB and the module together. Keep a power bank as a fallback.
- [ ] Solder or secure final connections; heat-shrink; add a switch.
- [ ] Housing (a teammate is designing it; share the dimensions in `CLAUDE.md`): design and 3D-print the housing and a clip for the hat (no drilling): separate LiPo compartment, vent for the BME280, GPS antenna facing up, USB/charge port access, space for LEDs later. Print in PETG or ABS and test-fit before the final print.
- [ ] Add a worn/not-worn sensor (IR proximity or microswitch) if time allows. If it is cut, set `HAS_WORN_SENSOR 0` in `firmware/config.h`.
- [ ] Measure battery runtime with Wi-Fi and GPS on (needed for A1: 10+ minutes). Record the result in section 8.
- [ ] Wiring notes in `docs/WIRING.md`.

### W2. Firmware (Owner: TBD)
- [ ] Read BNO085 (accel, orientation) and BME280 over I2C; print to serial.
- [ ] Read the GPS with TinyGPSPlus; report `gps_fix`, and `lat`/`lon` only when there is a fix.
- [ ] Compute heat index from temperature and humidity. Use the same NOAA formula as `heat_index_c()` in `server/simulator.py` (tested against the NWS chart), so the helmet and simulator agree.
- [ ] Fall state machine with thresholds in `firmware/config.h`. Add a `HAS_WORN_SENSOR` flag; when it is 0, send `worn: true`.
- [ ] Send `zone: null` in telemetry and events (the server fills in the zone).
- [ ] Wi-Fi client: POST telemetry (1 Hz) and fall events immediately.
- [ ] Reconnect logic; fall events queued if Wi-Fi drops. Each retry sends `sent_uptime_ms` (see `docs/PROTOCOL.md` 2.2).

### W3. Data and testing (Owner: TBD)
- [ ] CSV logging mode (firmware or serial capture) at 100 Hz or better; store in `data/`.
- [ ] Safe test protocol: padded drops, sandbag, mattress. No people falling.
- [ ] Collect normal-activity data (see A3) and fake-fall data.
- [ ] Tune thresholds with the firmware owner; write results in section 8.
- [ ] Run the acceptance tests and record results.
- [ ] Stretch: plan staged falls in two or three zones for the demo so the hazard map shows real data.

### W4. Server and dashboard (Owner: TBD)
- [x] Pick the stack: Python FastAPI + SQLite (see section 8).

**Server build phases.** Spec: `docs/PROTOCOL.md`. Work in order; each phase is done only when its "done when" check passes.

- [x] **S1. Setup and database** (~45 min). *Claimed: Claude (for Elijah), 2026-11-06.* Done 2026-11-06: server starts, creates all 4 tables, 7 tests pass. `models.py` and `heat.py` moved to S2, where the routes that use them are built. Create `server/` (`app/main.py`, `app/db.py`, `app/models.py`, `app/heat.py`, `tests/`), pinned `requirements.txt` (fastapi, uvicorn, pytest, httpx), `.gitignore` (`*.db`, `__pycache__`, `.venv`). SQLite tables `devices`, `telemetry`, `events` (unique on `device_id` + `uptime_ms`), `incidents`; WAL mode; times as ISO 8601 UTC.
  *Done when:* `uvicorn app.main:app` starts, creates the database, and `pytest` runs (even with no tests yet).
- [x] **S2. Core routes** (~1.5 h). *Claude (for Elijah).* Done 2026-11-06: 77 tests pass, plus a manual check with curl against the running server. `POST /api/telemetry`, `POST /api/event`, `GET /api/devices`, `PATCH /api/devices/{id}`, `GET /api/incidents`. Server stamps `ts`, fills in the device's assigned zone, snapshots `worker_name`, ignores repeat events, sets `delayed`, marks `sim-` incidents `sample: true`, computes `online` (5 s) and `heat_level`. Write each test before its route.
  *Done when:* tests pass for every route, including a repeat event returning the same `incident_id`, and a zone or name change applying to new incidents only.
- [x] **S3. Stretch routes** (~45 min). *Claude (for Elijah), 2026-11-06.* Done: 124 tests pass. Added `sample_count` to hazards so the map can say when a zone's count includes sample data (see `docs/PROTOCOL.md` changelog). `POST /api/incidents`, `PATCH /api/incidents/{id}`, `GET /api/hazards`.
  *Done when:* tests show that only `confirmed` incidents count toward hazards and that a manual `fall` report is rejected with 422.
- [x] **S4. Simulator** (~45 min). *Claude (for Elijah), 2026-11-06; done before S3 so the dashboard can start.* Done: 89 tests pass; a 32 s live run with `--devices 3 --fall-every 30 --resend` showed 3 online helmets, 1 sample incident, no duplicate, 0 server errors. Also has `--duration` and `--seed`, retries falls when the server is down, and tilts a helmet for 5 s after it falls. `server/simulator.py`, standard library only. Options: `--url`, `--devices`, `--fall-every`, `--heat-ramp`, `--resend`. Uses `sim-` device IDs.
  *Done when:* with `--devices 3 --fall-every 30`, `GET /api/devices` shows 3 online devices and `GET /api/incidents` shows falls marked `sample: true`, with no duplicates under `--resend`.
- [x] **S5. Docs** (~15 min). *Claude (for Elijah), 2026-11-06.* Done: `server/README.md` (install, tests, run, simulator, ESP32 networking incl. WSL2, troubleshooting), linked from the top-level `README.md`. Checked by following it in a fresh clone: install, 124 tests, server on `0.0.0.0:8000`, 3 simulated helmets online. The "visible on the dashboard" part waits for the dashboard; the WSL2/firewall steps are not yet tested with a real phone or ESP32. `server/README.md`: install, run on `0.0.0.0:8000`, run the simulator, and reach the server from the ESP32 (including the WSL2 note in section 9). Tick these tasks; note anything unexpected in section 8.
  *Done when:* a teammate can follow the README from a fresh clone to the simulator showing up on the dashboard.

**Dashboard** (start once S2 is done; the simulator lets you build it before hardware is ready). *Claimed: Claude (for Elijah), 2026-11-06.* Plain HTML/CSS/JS in `dashboard/`, no build step and no internet needed; generic 2x3 zone grid in `dashboard/zones.json`. Phases:
- [x] **D1. Skeleton:** page at `/`, refreshes every second, connection indicator. *Done when:* live counts with the simulator; "can't reach server" within 3 s of stopping it. Done 2026-11-06: checked in headless Chrome with the simulator (live counts) and with a test server that stops answering ("Can't reach server", last counts kept). 4 `node --test` tests pass. The browser-tool plugin could not start Chrome in WSL; headless Windows Chrome (`chrome.exe --headless=new`) works for screenshots.
- [x] **D2. Workers:** cards with name, online, heat risk, worn, last seen; rename and zone picker. *Done when:* changes survive a refresh and appear on the next incident. Done 2026-11-06: 14 scripted browser checks pass (rename, zone, reload, next incident, half-typed name survives refreshes, Esc, empty name, clear zone); fits a 390 px phone width; 10 `node --test` tests. Found and fixed a server threading bug along the way (section 8).
- [x] **D3. Incidents + fall alert:** newest-first list with sample/delayed/status badges; banner (and optional sound) for new falls. *Done when:* a simulator fall shows the banner within ~2 s; old falls don't trigger it. Done 2026-11-06: with the real simulator the banner showed 0.07 to 0.9 s after each of 4 falls reached the server; 22 scripted browser checks pass (old falls and falls already there after a reload don't alert, repeats and manual reports don't alert, late and sample badges, names shown as text, hide and show-in-list); fits 390 px; 19 `node --test` tests. The banner stays until hidden; sound is off until the supervisor clicks the button (browsers block sound before a click).
- [x] **D4. Site map:** zone grid with worker dots colored by heat risk, "Simulated location" label. *Done when:* changing a zone moves the dot within ~1 s. Done 2026-11-06: in real time the dot moved 21-43 ms after a zone change on a worker card and 0.7-0.8 s after a change made through the API (next refresh); 21 scripted browser checks pass (grid from `zones.json`, heat colors, offline, fall mark, names as text, "Not on the map" for no or unknown zone); fits 390 px; 24 `node --test` tests. Dots carry the heat level in words too, and a legend explains the colors. Bad entries in `zones.json` are skipped and named on the page.
- [ ] **D5. Stretch:** confirm/dismiss/notes, manual report form, hazard shading, falls/heat toggle, sample note. *Done when:* A7 passes.
- [ ] **D6. Docs + check:** how to open it, screenshots at desktop and phone width.

Original task list (covered by the phases above):
- [ ] Device list with names and status, incident list, zone map on a floor-plan image, heat color per worker.
- [ ] Zone picker per device, labeled "simulated location". Incidents with `sample: true` labeled "sample data".
- [ ] Stretch: incident status (new, confirmed, dismissed) with confirm and dismiss controls.
- [ ] Stretch: manual "report injury or hazard" form (zone and note).
- [ ] Stretch: hazard map layer (red markers or shaded zones by confirmed incident count) and a falls/heat layer toggle.

### W5. Research, pitch, and demo (Owner: TBD)
- [ ] Send customer discovery emails (use the team doc; fill in names and contacts). Log replies.
- [ ] Summarize competitors (see section 7) and our honest differentiator.
- [ ] Draft the demo script and a short pitch, using only things that work.
- [ ] Prepare the slide or one-pager; collect photos and a short demo video as a backup.
- [ ] Add a question about tracking incident locations and hazard maps to the customer discovery email.

## 6. Schedule **[proposed]**

Hackathon dates and deadlines: **TBD, add here.**

**Day 1: get data flowing**
1. Parts in hand and wired (W1), sensors reading on serial (W2).
2. Server and dashboard skeleton with a simulator (W4).
3. First logged data and a first fall detector (W2, W3).
4. Send outreach emails (W5).

**Day 2: make it reliable and demo-ready**
1. Wi-Fi telemetry and fall events reach the dashboard (W2, W4).
2. Threshold tuning and false-alarm trials (W3).
3. Final enclosure and mounting (W1).
4. Acceptance tests, demo rehearsal, backup video (all).

Cut order if time runs short: hazard map, worn sensor, heat color polish, map polish, then extra tests. Never cut: fall detection, dashboard incident list, battery operation.

## 7. Context and positioning

- Existing products we found: Kenzen (upper-arm heat-stress wearable, piloted by Garney), SlateSafety (arm-worn heat monitor), Triax Spot-r (belt-clip fall detection with location), Blackline G7 (lone-worker fall detection), Guardio Armet PRO (smart hard hat with fall and impact detection), and a Japanese wrist product, Worker Connect, covering falls, heat, and heart rate.
- We did not find a commercial hard-hat product combining fall detection with heat and physiological sensing. This was a quick search, not exhaustive.
- Be honest in the pitch: the functions exist separately. Our angle is one helmet-based device that is simple and affordable for small companies. Test that angle with real customer replies.

## 8. Decisions and findings (append as you go)

| Date | Decision or finding | Who |
|---|---|---|
| | MCU: ESP32 (ESP-32S WROOM-32) | team |
| | IMU: GY-BNO085 | team |
| | MVP is helmet-only, indoor demo with Wi-Fi | team |
| | Barometer/temp/humidity: BME280 | team |
| | Battery: NULLLAB 1200 mAh LiPo module, 5 V header to ESP32 VIN | team |
| | GPS: GY-NEO6MV2 (NEO-6M), mounted; indoor demo uses zones | team |
| | Enclosure: 3D-printed housing and hat clip, no drilling | team |
| 2026-11-06 | Server stack: Python FastAPI + SQLite | team |
| 2026-11-06 | Indoor zone is set per device on the dashboard; server stamps it on telemetry and events; firmware sends `zone: null`; UI labels it simulated | team |
| 2026-11-06 | Incidents store a snapshot of the worker's name at creation time | team |
| 2026-11-06 | Worn sensor: attempt it; if cut, firmware sends `worn: true` (`HAS_WORN_SENSOR 0`) and A6 becomes a stretch test | team |
| 2026-11-06 | `docs/PROTOCOL.md` written: all routes, field types, retry/dedupe for fall events, heat-level bands, `hazard_report` incident type | team |
| 2026-11-06 | Server deps install fine on Python 3.14 (fastapi 0.162.0, uvicorn 0.54.0, pytest 9.2.0, httpx 0.28.1). Starlette warns that `httpx` for TestClient is deprecated in favor of `httpx2`; harmless for now | Claude |
| 2026-11-06 | If ROS is installed, its `PYTHONPATH` leaks into the venv and pytest auto-loads a ROS plugin that crashes (`osrf_pycommon` missing). Fixed in `server/pytest.ini` with `--disable-plugin-autoload`; tests now run without extra steps. ROS packages can still shadow server dependencies, so `env -u PYTHONPATH` stays a fallback for running the server | Claude |
| 2026-11-06 | Known limit: fall events are de-duplicated by `(device_id, uptime_ms)`, and `uptime_ms` restarts at 0 when a helmet reboots. A fall after a reboot at the exact same millisecond count as an earlier fall from that helmet would be treated as a repeat and dropped. Very unlikely; accepted for the MVP | Claude |
| 2026-11-06 | Server decisions in S2: lat/lon are dropped when `gps_fix` is false; a helmet's own `zone` is ignored (the dashboard zone wins); unknown extra fields from the helmet are ignored, but unknown fields in `PATCH /api/devices` are rejected (catches typos); a device's name cannot be cleared, only its zone | Claude |
| 2026-11-06 | **Server bug found by the dashboard, fixed:** with parallel requests (dashboard + helmets), about 40% of requests returned 500 (`SQLite objects created in a thread can only be used in that same thread`), including helmet telemetry. FastAPI can open a request's DB connection on one thread and run the route on another. Fixed with `check_same_thread=False` in `server/app/db.py` (each connection is still used by one request at a time); regression tests in `server/tests/test_concurrency.py`. Earlier "0 errors" server checks only sent one request at a time | Claude |
| | Battery runtime with Wi-Fi + GPS on: TBD (measure) | |
| | Threshold values after tuning: TBD | |

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| BNO085 is flaky on I2C with the ESP32 | Wire RST and INT, lower the I2C clock, check PS0/PS1 protocol pads; SPI as a fallback |
| ESP32 brownouts from the battery | 5 V source or boost to 5 V, add a 100-470 uF capacitor, measure the 3V3 pin under Wi-Fi load |
| Battery module does not power the ESP32 reliably | Test 10+ minutes with Wi-Fi and GPS on; measure the 5 V pin; add a 100-470 uF capacitor; a power bank is the fallback |
| Charging while running (the listing says no UPS operation) | Charge with the helmet off; do not rely on pass-through for the demo |
| Wi-Fi blocks device-to-device traffic | Use a phone hotspot or travel router |
| False fall alarms (helmet dropped, taken off, nodding) | Worn sensor, orientation and stillness checks, threshold tuning, trial log |
| False alarms create fake hazard zones | A supervisor confirms incidents; only confirmed ones count toward the hazard map |
| GPS does not work indoors | GPS module is mounted and reports `gps_fix`; the indoor demo uses zone-based or simulated location, labeled as simulated; test a real fix outdoors |
| Heat claim is overstated | Call it heat exposure; do not claim core temperature or heat stress |
| LiPo safety on a head-mounted device | Module has built-in protection; keep it padded inside the enclosure, charge only via its USB-C, supervised charging, retire if swollen |
| Server runs in WSL2, which the ESP32 cannot reach by default | Run the server on Windows Python, or forward port 8000 from Windows to WSL2 and allow it in the Windows firewall; test with a phone browser on the hotspot first |
| Python 3.14 lacks wheels for a pinned package | Use a Python 3.12 virtual environment |
| Simulator data mistaken for real data | `sim-` device IDs; their incidents are marked `sample: true` and labeled on the dashboard |
| Time | Follow the cut order in section 6 |

## 10. Open questions

- Hackathon dates, judging format, and demo room setup (indoor, Wi-Fi, power outlets)?
- Who owns each workstream?
- Which 3D printer and filament for the housing?
- Which helmet will we use, and is there room for the housing and clip? Measure the actual battery runtime with Wi-Fi and GPS on, since no figure is guaranteed.
- What does "navigation lights" need to do, if we get to it? (Direction to a fallen worker needs position and heading, which are hard indoors.)

## 11. Demo script **[proposed]**

1. Show the helmet and dashboard with a named worker online and a live heat reading.
2. Warm the sensor area slightly; the heat color changes.
3. Perform a padded drop of the helmet; a fall incident appears on the dashboard with its zone.
4. Pick the helmet up and put it down gently; no false alarm.
5. Show the incident list and stored data after a refresh.
6. (Stretch) Confirm the fall incident; its zone turns red on the hazard map. Say plainly which history is sample data.
7. State what is real (falls, ambient heat, dashboard) and what is future (heart rate, navigation lights, Pi gateway; GPS is mounted but only gets a fix outdoors).
