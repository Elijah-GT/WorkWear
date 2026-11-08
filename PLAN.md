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
- [x] A7 (stretch). Confirmed incidents appear as hazard markers or shaded zones on the map. Dismissed incidents do not. *Passed 2026-11-06 with simulator and test data (D5 browser checks); recheck at the demo rehearsal.*

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
- [x] **F0. Scaffold (code only).** *Claude (for Elijah), 2026-11-07.* Done: `firmware/` Arduino sketch with code for every task below. Compiles for the ESP32 (esp32 core 3.3.12, 81% of flash). 28 laptop tests of the fall logic, heat index, JSON and retry queue pass (`firmware/test/run_tests.sh`). The real server accepts its JSON, and a retried fall returns the same incident. **Nothing has run on hardware yet**, so the tasks below stay open until each is checked on the helmet. Setup and first power-up checklist: `firmware/README.md`.
- [ ] Read BNO085 (accel, orientation) and BME280 over I2C; print to serial.
- [ ] Read the GPS with TinyGPSPlus; report `gps_fix`, and `lat`/`lon` only when there is a fix.
- [ ] Compute heat index from temperature and humidity. Use the same NOAA formula as `heat_index_c()` in `server/simulator.py` (tested against the NWS chart), so the helmet and simulator agree.
- [ ] Fall state machine with thresholds in `firmware/config.h`. Add a `HAS_WORN_SENSOR` flag; when it is 0, send `worn: true`.
- [ ] Send `zone: null` in telemetry and events (the server fills in the zone).
- [ ] Wi-Fi client: POST telemetry (1 Hz) and fall events immediately.
- [ ] Reconnect logic; fall events queued if Wi-Fi drops. Each retry sends `sent_uptime_ms` (see `docs/PROTOCOL.md` 2.2).
- [ ] Optional (team decision): BLE zone beacons. Code written 2026-11-07 (D8), off by default. To try: flash `firmware/beacon/beacon.ino` on one spare ESP32 per zone, set `HAS_BLE_BEACONS 1`, pick the Huge APP partition scheme, walk between zones and watch `# beacon zone:` on serial. Record how reliable the zones are in section 8.

### W3. Data and testing (Owner: TBD)
- [ ] CSV logging mode (firmware or serial capture) at 100 Hz or better; store in `data/`. *Firmware side written: `LOG_CSV 1` in `firmware/config.h` prints about 200 lines/s at 921600 baud (see `firmware/README.md`); the actual rate is not yet measured on hardware.*
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
- [x] **S5. Docs** (~15 min). *Claude (for Elijah), 2026-11-06.* Done: `server/README.md` (install, tests, run, simulator, ESP32 networking incl. WSL2, troubleshooting), linked from the top-level `README.md`. Checked by following it in a fresh clone: install, 124 tests, server on `0.0.0.0:8000`, 3 simulated helmets online. The "visible on the dashboard" part was checked in D6 (fresh clone, simulator helmets on the dashboard); the WSL2/firewall steps are not yet tested with a real phone or ESP32. `server/README.md`: install, run on `0.0.0.0:8000`, run the simulator, and reach the server from the ESP32 (including the WSL2 note in section 9). Tick these tasks; note anything unexpected in section 8.
  *Done when:* a teammate can follow the README from a fresh clone to the simulator showing up on the dashboard.

**Dashboard** (start once S2 is done; the simulator lets you build it before hardware is ready). *Claimed: Claude (for Elijah), 2026-11-06.* Plain HTML/CSS/JS in `dashboard/`, no build step and no internet needed; generic 2x3 zone grid in `dashboard/zones.json`. Phases:
- [x] **D1. Skeleton:** page at `/`, refreshes every second, connection indicator. *Done when:* live counts with the simulator; "can't reach server" within 3 s of stopping it. Done 2026-11-06: checked in headless Chrome with the simulator (live counts) and with a test server that stops answering ("Can't reach server", last counts kept). 4 `node --test` tests pass. The browser-tool plugin could not start Chrome in WSL; headless Windows Chrome (`chrome.exe --headless=new`) works for screenshots.
- [x] **D2. Workers:** cards with name, online, heat risk, worn, last seen; rename and zone picker. *Done when:* changes survive a refresh and appear on the next incident. Done 2026-11-06: 14 scripted browser checks pass (rename, zone, reload, next incident, half-typed name survives refreshes, Esc, empty name, clear zone); fits a 390 px phone width; 10 `node --test` tests. Found and fixed a server threading bug along the way (section 8).
- [x] **D3. Incidents + fall alert:** newest-first list with sample/delayed/status badges; banner (and optional sound) for new falls. *Done when:* a simulator fall shows the banner within ~2 s; old falls don't trigger it. Done 2026-11-06: with the real simulator the banner showed 0.07 to 0.9 s after each of 4 falls reached the server; 22 scripted browser checks pass (old falls and falls already there after a reload don't alert, repeats and manual reports don't alert, late and sample badges, names shown as text, hide and show-in-list); fits 390 px; 19 `node --test` tests. The banner stays until hidden; sound is off until the supervisor clicks the button (browsers block sound before a click).
- [x] **D4. Site map:** zone grid with worker dots colored by heat risk, "Simulated location" label. *Done when:* changing a zone moves the dot within ~1 s. Done 2026-11-06: in real time the dot moved 21-43 ms after a zone change on a worker card and 0.7-0.8 s after a change made through the API (next refresh); 21 scripted browser checks pass (grid from `zones.json`, heat colors, offline, fall mark, names as text, "Not on the map" for no or unknown zone); fits 390 px; 24 `node --test` tests. Dots carry the heat level in words too, and a legend explains the colors. Bad entries in `zones.json` are skipped and named on the page.
- [x] **D5. Stretch:** confirm/dismiss/notes, manual report form, hazard shading, falls/heat toggle, sample note. *Done when:* A7 passes. Done 2026-11-06: A7 passes; 31 scripted browser checks in real time (confirm shades the zone in ~50 ms, dismissed and new incidents don't count, sample counts are labeled, a note being typed survives refreshes, reports saved from the form, heat layer, time window, confirming a fall clears its alert); fits 390 px; 30 `node --test` tests. Zones are shaded (no GPS markers: the indoor demo has no fix).
- [x] **D6. Docs + check:** how to open it, screenshots at desktop and phone width. Done 2026-11-06: `dashboard/README.md` (open, page tour, label meanings, editing `zones.json`, tests, troubleshooting) with screenshots in `docs/img/`. Checked by following the READMEs in a fresh clone from GitHub: install, 126 server + 30 dashboard tests, server and simulator started as written, `http://localhost:8000/` showed Connected and 3 simulated helmets on the cards and map. Writing the README found one bug, now fixed: after a failed zone save the zone list kept showing the unsaved zone (5 browser checks with a proxy that refuses saves).

- [x] **D7. Floor plan + map colors.** *Claude (for Elijah), 2026-11-07.* Done: the map is now the floor plan of room 1520 (`dashboard/floorplan.png`, from the building plan with room names inside the zones and the outdoor labels removed) with six zones: 1520 West, North, South and Alcove, 1522 Seminar Room, 1533 Data Tech Lab. `zones.json` places zones as rectangles in image pixels; the old grid format still works when there is no image. Colors fixed: a new fall is a pulsing red outline plus a "NEW FALL" tag (never a fill), and confirmed incidents are a red fill (light, medium, dark = 1, 2, 3+) plus a count tag, so confirming a fall visibly turns its zone red (demo step 6). Before, both were nearly the same pale pink, and confirming made the zone look *less* red. The heat layer tints whole zones in heat colors. Empty zones no longer repeat "No confirmed incidents". Incident list and banner show zone labels ("Zone 1520 West"). Also fixed: no space between the site name and the note above the map, and `zones.json` is now retried if it fails to load. Checked: 37 `node --test` tests (7 new, including that the shipped `zones.json` is valid); in Chrome with the simulator, a staged fall showed the outline and tag, and clicking Confirm turned the zone into a red fill 54 ms later; heat layer; 390 px phone width with no sideways scroll; no console errors. New screenshots in `docs/img/`.

- [x] **D8. Location: fall dots, GPS on the plan, BLE beacons.** *Claude (for Elijah, who asked for all three), 2026-11-07.* Done:
  - **Fall dots:** every fall that isn't dismissed is a red dot on the plan (bright = not reviewed, dark = confirmed, pulsing while alerting; click jumps to the list). With a GPS position it sits exactly there; otherwise at a steady spot in its zone with a dashed ring labeled "approximate".
  - **GPS on the plan:** `zones.json` may have `gps_points` (3+ spots with pixel x, y and lat/lon). The server fits a GPS-to-plan map, puts `plan_x`/`plan_y` on incidents, and files a GPS fix inside a zone under that zone. Set up with `/?calibrate` (click to read pixel positions; `dashboard/README.md`). **No real `gps_points` yet**: someone needs the building's corner coordinates. Indoors GPS gets no fix, so this only matters outdoors.
  - **BLE beacons:** firmware `HAS_BLE_BEACONS` (off by default) scans for `WW-<zone>` beacons (`firmware/beacon/beacon.ino` on spare ESP32s) and reports the strongest zone, with smoothing and a 6 dB / 2-scan margin against flicker. Needs the "Huge APP" partition scheme (1.8 MB). **Not tried on hardware.**
  - Server picks zone: beacon, then GPS, then dashboard; stores `zone_source`; `GET /api/site`; old databases upgraded on start. Simulator `--beacon-zones` and `--gps`. Worker dots with a measured zone get a blue ring; the map tag changes from "Simulated location" to "Location: measured where marked" only when something is measured.
  - Checked: 165 server tests (39 new), 48 dashboard tests (11 new), 38 firmware laptop tests (10 new; a broken copy of the tracker fails 3). ESP32 compiles: helmet with beacons off (81%, unchanged), on with Huge APP (57%), beacon sketch (34%). In Chrome: a test server with made-up `gps_points` (scratch copy only) put simulated GPS falls at their exact spots in 1520 North; the real server with `--beacon-zones` showed blue rings, zones moving, and a fall as an approximate dot in its beacon zone. No console errors except a missing favicon.

- [x] **D9. Tabs: Map, Workers, Incidents.** *Claude (for Elijah: "having to scroll to see the map feels bad", then "can we make seperate tabs"), 2026-11-07.* Before, on a 390 px phone the map started about 1,700 px down, under the tiles and every worker card. Now:
  - **One view at a time on every screen:** Map (the default), Workers (online / all count) and Incidents (new count, red). The tabs are in the header; on phones (700 px or less) they are a bar at the bottom. The summary tiles are gone (the tab counts replace them; each card and incident still carries its Simulated helmet / Sample data label).
  - **Map view fits the window:** the plan is as large as the space below the header allows and the page does not scroll, also while a fall banner is showing. On wide screens (1000 px or more) the map key sits beside the map; on smaller ones it folds into "Map key" under it.
  - "Show in list" and clicking a fall dot switch to Incidents and scroll to that row. The fall banner shows on every tab.
  - **Bug fixed (from D8):** the pulsing "NEW FALL" outline was drawn on the zone the worker is in *now*, so after a beacon-located worker moved, it sat on the wrong zone (seen: alert said 1520 North, outline on 1533). It now uses the zone the fall was recorded in.
  - Checked in Chrome with the simulator: phone 390x844, tablet 820x1180, laptops 1366x768 and 1280x620. On each, the Map view is exactly one screen tall with the whole plan visible and no sideways scroll. Also checked: tab switching, a fall dot jumping to its row, and a live fall outlining 1520 North to match its alert. 48 `node --test` tests pass. New README screenshots in `docs/img/`. Still to do: fall dots can cover a worker's name tag when many falls pile up in one zone (seen with ~60 simulated falls on "All time"). *Fixed in D10.*

- [x] **D10. Alert line, names above fall dots, compact map key.** *Claude (for Elijah), 2026-11-07.* Elijah: "I don't like how the alert pops up and shifts everything on the page... without covering anything or shifting the page", and "fix the fall dots covering worker names and make the map Key somthing you dont need to scroll. Get rid of the descriptio section in it."
  - **Alert line:** always on the page under the header at a fixed height (60 px; 70 px on phones). It reads "No fall alerts" with a green check. When a fall arrives it turns red with a blinking "!" and a pulsing glow (color and glow only, no size change), and the tab title, the Incidents tab count, the zone outline and the sound (if on) work as before. The page is now an app layout: the header and alert line stay put and only the area below scrolls, so the alert is visible on every tab without sliding over anything. "Reduce motion" turns the pulsing off.
  - **Names above fall dots:** worker names, zone labels and the NEW FALL and count tags are drawn above the fall dots. The pulsing outline moved to its own layer so it no longer pulls a zone's names under the dots. Fall dots stay clickable around the names.
  - **Map key:** the description paragraph is removed. It is now four short groups (Zones, Falls, Heat risk, Workers) in two columns. The heat group's title still says "air, not body temperature", and the footer and zone tags still carry the sample-data and simulated-location labels. On wide screens it sits beside the map; on smaller ones it opens as a panel over the bottom of the map.
  - Checked in Chrome with the simulator. At 1366x768 and 390x844, the alert line, map and panel stay at the same position and size before and after a live fall. 11 names and labels were sampled at 6 points each, and none had a fall dot on top. The key has no scroll at 1366x768 and 1280x620 (exactly fits), and on a phone it opens above the summary inside the screen. On the Incidents tab the list scrolls inside the content area while the header and alert line stay put, and a fall dot still jumps to its row. 48 `node --test` tests pass. Known limit: in a small zone on a phone, several workers plus tags can still spill into the zone below (seen with 3 simulated workers in 1520 North). *Fixed in D11.*

- [x] **D11. Name tags fit their zone.** *Claude (for Elijah: "fix the name tags spilling into other zones on phone"), 2026-11-07.*
  - On every redraw (and on resize) each zone on the floor plan checks whether its labels and name tags fit inside it. If not, it switches to **initials**: a circle in the worker's heat color with up to 3 characters (`initials()` in `logic.js`: "sim-01" = S1, "Alex Smith" = AS, "Jordan" = JO). The blue located ring and the red new-fall border are kept, and labels shrink. If even that does not fit, the zone shows one "N workers" tag. Roomy zones keep full names, so a laptop normally never sees initials.
  - Clicking or tapping any worker dot opens the Workers tab and highlights that worker's card (phones have no hover to show the full name). Dots can be reached with Tab and opened with Enter.
  - Checked in Chrome. Phone 390x844: with 3 workers each in 1522 (66x112 px), 1533 (122x68) and 1520 North (122x91), all three switched to initials with no tag outside its zone. 6 workers in 1522 switched to the single tag, also with no spill. Tapping a dot opened the Workers tab with that card highlighted and on screen. Laptop 1366x768: the same 3-per-zone test kept full names everywhere with no spill. The crowded zones were made by copying dots in the page for the test (the simulator rarely puts 3 workers in one zone). 49 `node --test` tests (1 new: `initials`).

- [x] **D12. Layout restyle (branch `dashboard-restyle`).** *Claude (for Elijah, who gave Triax Spot-r screenshots as layout ideas only: no colors, names, icons or assets copied), 2026-11-07.* Colors and status colors unchanged; one font and one type scale (11/12/14/16/20/24 px); one pill style; API unchanged.
  - **Shell:** icon rail (Map, Workers, Incidents, Heat, Settings) with counts, and a searchable worker list beside it (hard-hat avatar colored by status, name, device ID). The address follows the page (`#/map`, `#/incident/<id>`, `#/worker/<id>`), so Back works. Phones: the rail is a bottom bar; the worker list is the Workers section. 700-1100 px: no list column.
  - **Alert line:** one slim 40 px line in the existing red: worker, zone, time, peak g, "+N more new falls", Show in list, and ×. Same fixed slot as D10, so nothing moves.
  - **Incidents:** a table (date and time, worker, zone, type, peak g, status pill, View), newest by time, with a status filter (All, Pending, Confirmed, Dismissed; "Pending" = the API's `new`). The report form is kept. Stacked rows on phones.
  - **Incident page:** a mini floor plan with the zone highlighted and the spot marked (exact with GPS, else approximate), workers in that zone now, details, Confirm, Dismiss, Mark new, Add or edit note, and a timeline (received, arrived late, alert shown here, review status; see findings for what can't be timed).
  - **Worker profile:** rename, status pills, zone now and how it was found (beacons, GPS, or set on the dashboard = simulated), the zone picker, air temperature, humidity, heat index and heat risk (never body temperature), helmet details, and recent incidents.
  - **Map:** one shaded count per zone (confirmed only, 1, 2, 3+); no dot per past incident. An active alert is one marker with a pulsing ring, plus a red zone outline. Click a zone to list its incidents. A small collapsible "Key" in the map's corner. The Incidents/Heat switch became the **Heat** section (heat-tinted map plus a table of workers by heat index).
  - **Sample data:** `server/seed.py` adds 8 sample incidents over 4 days and 5 zones (1 pending). `--reset` backs up the database and replaces only sample incidents. A single "Sample data" header badge, with per-row pills only when real data is mixed in (decision in section 8). Ran it on the dev database: 169 simulator falls replaced (backups `server/workwear.db.bak-*`). The simulator now runs without `--fall-every`.
  - Code: `app.js` (views and router), new `map.js` (one floor-plan component for Map, Heat and the incident page), and new `ui.js` (helpers).
  - Checked in Chrome at 1366x768, 820x1180 and 390x844:
    - The map fits with no page scroll.
    - Zone counts match `/api/hazards`.
    - A zone click lists its 4 incidents; the Key opens and closes.
    - Incident #9: Confirm, add a note, clear the note, Mark new all saved (state restored afterwards).
    - Rename on the profile saved and was renamed back.
    - Search filters both lists.
    - Two test falls posted to `/api/event`: the alert line, map and main area kept the same position and size; one ringed marker in 1520 South; "+1 more new fall"; Show in list highlighted the row. Both were dismissed, then the sample history was reset.
    - No sideways scroll on any section.
  - Tests: 59 `node --test` (10 new), 168 pytest (3 new for `seed.py`).
  - Not done: anything needing API changes (review times), messaging, device setup, mobile app.

Original task list (covered by the phases above):
- [x] Device list with names and status, incident list, zone map on a floor-plan image, heat color per worker. *(Floor plan added in D7.)*
- [x] Zone picker per device, labeled "simulated location". Incidents with `sample: true` labeled "sample data".
- [x] Stretch: incident status (new, confirmed, dismissed) with confirm and dismiss controls.
- [x] Stretch: manual "report injury or hazard" form (zone and note).
- [x] Stretch: hazard map layer (red markers or shaded zones by confirmed incident count) and a falls/heat layer toggle. *(Shaded zones; GPS markers not built, since the indoor demo has no fix.)*

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
| 2026-11-07 | Firmware: the worn flag is latched when a free-fall **starts**. A helmet set down or tossed (not worn at the start) does not alert; a helmet knocked off the head during a fall still alerts. This is how the code reads CLAUDE.md's "suppress alerts when `worn` is false" | Claude |
| 2026-11-07 | Firmware pins picked (not in CLAUDE.md): BNO085 RST GPIO4, INT GPIO19 (wired but unused: the Adafruit library polls over I2C), worn sensor GPIO27. W1: confirm or change in `firmware/config.h` and record in `docs/WIRING.md` | Claude |
| 2026-11-07 | Firmware: Wi-Fi and HTTP run on a separate task (core 0), because a failed POST can block for 3 s and would otherwise pause fall detection. The BME280 runs in forced mode, one reading a second, so it does not warm itself up. Wi-Fi name and password go in `firmware/secrets.h` (git-ignored), not `config.h` | Claude |
| 2026-11-07 | Firmware: tilt comes from the BNO085 gravity report and assumes the IMU's +Z axis points up through the crown (`IMU_UP_AXIS`/`IMU_UP_SIGN`). Not yet checked on the real board | Claude |
| 2026-11-07 | Demo room is 1520 (Carlsen Center); floor plan provided by Elijah. Zone IDs are now `1520-W`, `1520-N`, `1520-S`, `1520-A`, `1522`, `1533` (were `A1` to `B3`). Helmets set to an old zone show under "Not on the map" until a new zone is picked; old incidents keep their old zone. How 1520 is split into zones was Claude's choice; change it in `dashboard/zones.json` if the demo layout needs other areas | Claude |
| 2026-11-07 | **Changed decision (Elijah):** measured location beats the dashboard zone. Server zone order: helmet's beacon zone, then GPS zone (needs `gps_points`), then dashboard zone; each has a `zone_source`. Replaces "the helmet's own zone is ignored" from S2. CLAUDE.md and PROTOCOL.md updated | Elijah / Claude |
| 2026-11-07 | Location limits: the NEO-6M gets no fix indoors and is only good to about 3-5 m outdoors (often 10 m+ near buildings), too coarse for zones inside 1520. BLE beacon zones are room-level and will flicker between neighbouring zones in one open room; separate rooms (1522, 1533) work better. With Bluetooth the helmet program is 1.8 MB and needs the Huge APP partition scheme | Claude |
| 2026-11-07 | A GPS fix outside every zone keeps the dashboard zone (a 10 m GPS error shouldn't move a worker out of their zone), but the fall dot is still drawn at the GPS spot | Claude |
| 2026-11-07 | **Sample labeling (Elijah asked for one header badge; rule for mixed data proposed by Claude and accepted):** a single "Sample data" badge in the header while simulated helmets or sample incidents are on. When real helmets or real incidents are also present, each sample row gets its own Sample pill as well; an incident page always says it is sample data. CLAUDE.md updated | Elijah / Claude |
| 2026-11-07 | The incident timeline cannot show **when** an incident was confirmed or dismissed: the server stores no review time, and the API was kept unchanged. "Alert shown" is only known for alerts this browser showed. Adding a `reviewed_ts` field would need a PROTOCOL.md change | Claude |
| 2026-11-07 | `/api/hazards` reads every telemetry row for the heat column. After ~26,000 rows (hours of simulator data) on WSL's `/mnt/c` it takes 0.5-0.8 s and sometimes over the dashboard's 2 s timeout, so "Can't reach server" flickers. Not fixed (server change). Fix later: an index on `telemetry(zone, ts, heat_index_c)`, or a fresh database before the demo | Claude |
| 2026-11-07 | SQLite reuses the ID of a deleted last row, so after `seed.py --reset` new incidents can get IDs that were used before. Old `#/incident/<id>` links may then open a different incident. Harmless for the demo | Claude |
| 2026-11-07 | **First hardware test (ESP32 on USB, COM7, CP210x driver from Windows Update).** I2C scan: our GY-BNO085 answers at **0x4B**, not 0x4A, so `BNO085_ADDR` is now 0x4B; with that the IMU reads OK, 0.99 g at rest. **BME280 not found** at 0x76 or 0x77 (not connected or not powered). **GPS sends nothing** on GPIO16 or GPIO17 (not connected or not powered). Wi-Fi not tested yet (placeholder `secrets.h`). Tilt read 91 deg on the desk; check `IMU_UP_AXIS` once the board is mounted | Claude |
| 2026-11-07 | `server/workwear.db` has one real (not sample) incident, #1: a manual injury report in 1520 North with no helmet, entered while testing earlier. Because of it, real and sample data count as mixed and every sample row shows a Sample pill. Delete it (or start a fresh database) if only the header badge should show | Claude |
| 2026-11-07 | **Bench wiring (second ESP32):** BNO085 SDA GPIO21, SCL GPIO17, RST GPIO19, INT GPIO18. BME280 on its own bus (Wire1) SDA GPIO25, SCL GPIO26, VIN from GPIO27 driven HIGH. GPS TX/RX moved to GPIO16/23 (17 is now SCL). With SDA on GPIO5 (a boot-strap pin) the IMU failed its first start after every upload; on GPIO21 it starts first time | Claude |
| 2026-11-07 | **BNO085 findings:** the library's own reset (10 ms) and its one-report-per-transfer reader both lost data; polling without INT stalled after ~15 s; 100 kHz I2C read 0.00 g. Fixed in `sensors.cpp`: RST pulse + 300 ms boot, our own SH2 callback, read only while INT is low, 400 kHz. After a hard test drop the report stream stopped and the firmware kept a frozen reading for minutes; a stall watchdog now restarts the IMU after 1 s without data | Claude |
| 2026-11-07 | **First real fall on the dashboard** (USB bridge, no Wi-Fi yet): padded drop, free-fall 135-148 ms, peak 13.8 g, still 2.0 s, alert on the dashboard (incidents #10, #11, test drops, not sample). Drops with the USB cable pulling or onto a pillow did not trigger (free-fall 43 ms, hit 1.4 g). Thresholds unchanged | Claude |
| 2026-11-07 | `/api/hazards` slowness fixed: index `telemetry(zone, ts, heat_index_c)` (77k rows: 2.7 s to 0.35 s), and the dashboard now fetches hazards separately every 10 s so it can never block fall alerts (it did: a 3 s hazards call made every refresh fail and hid a real fall). Supersedes the hazards row above | Claude |
| 2026-11-07 | `firmware/serial_bridge.ps1` + `SERIAL_BRIDGE 1`: a helmet on USB posts its telemetry and fall events to the server without Wi-Fi (bench testing). `DROP_DEBUG 1` prints a per-drop check line (it under-counts free-fall when the reading flickers); **set it to 0 before the demo** | Claude |
| 2026-11-07 | **Temperature narrowed to a per-worker reading (Elijah).** Firmware reads the BME280 as before (`HAS_BME280 1`; set 0 to leave it off). Dashboard `SHOW_HEAT = false`: no Heat tab, heat map, heat index or heat colors; the Workers table and worker profile show air temperature only. Protocol, server and simulator unchanged. Test drops #10 and #11 dismissed | Elijah / Claude |
| 2026-11-07 | **Wi-Fi works end to end** (iPhone hotspot, 2.4 GHz): helmet at 172.20.10.6, laptop 172.20.10.3, telemetry about 1/s and a padded test drop (#13, 11.2 g) shown as an alert on the dashboard, not delayed. Server in WSL reached through a Windows portproxy (0.0.0.0:8000 to the WSL IP) and a firewall rule "WorkWear 8000" limited to the local subnet; redo the portproxy if the WSL IP changes after a reboot. iPhone hotspot names use a curly apostrophe (’), which `WIFI_SSID` must match exactly | Claude |
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
