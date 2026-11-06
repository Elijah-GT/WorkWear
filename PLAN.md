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
- Message formats are in `CLAUDE.md` and move to `docs/PROTOCOL.md`.

## 4. Acceptance criteria (how we know it works)

- [ ] A1. The ESP32 runs on battery and streams telemetry to the dashboard for 10+ minutes without a reset.
- [ ] A2. A staged padded drop produces a "fall" incident on the dashboard within about 3 seconds.
- [ ] A3. Normal activity does not trigger false alarms across a set of trials: walking, sitting, nodding, looking down, climbing steps, and setting the helmet down gently. Record the number of trials and results.
- [ ] A4. Heat color and heat index on the dashboard change when the sensor is exposed to warmer air.
- [ ] A5. The dashboard shows named devices, an incident list that persists after a refresh, and a location (zone) per device.
- [ ] A6. The helmet being taken off or set down does not raise a fall alert (worn detection).
- [ ] A7 (stretch). Confirmed incidents appear as hazard markers or shaded zones on the map. Dismissed incidents do not.

## 5. Workstreams and tasks

Five people, five workstreams. Owners are TBD: write your name next to a task before starting.

### W1. Hardware and power (Owner: TBD)
- [ ] Wire ESP32 + BNO085 + BME280 on a breadboard; confirm both I2C devices are detected.
- [ ] Wire the GY-NEO6MV2 to ESP32 UART2: GPS TX -> GPIO16, GPS RX -> GPIO17, VCC to 3V3, GND to GND. Confirm NMEA sentences at 9600 baud on serial. Test a fix outdoors with sky view (allow several minutes on the first fix; the board's LED blinks on fix).
- [ ] Power the ESP32 from the NULLLAB module's 5 V header pin to VIN (or its USB-A to the ESP32's micro-USB). Never the raw battery pin into VIN, and never laptop USB and the module together. Keep a power bank as a fallback.
- [ ] Solder or secure final connections; heat-shrink; add a switch.
- [ ] Housing (a teammate is designing it; share the dimensions in `CLAUDE.md`): design and 3D-print the housing and a clip for the hat (no drilling): separate LiPo compartment, vent for the BME280, GPS antenna facing up, USB/charge port access, space for LEDs later. Print in PETG or ABS and test-fit before the final print.
- [ ] Add a worn/not-worn sensor (IR proximity or microswitch) if time allows.
- [ ] Wiring notes in `docs/WIRING.md`.

### W2. Firmware (Owner: TBD)
- [ ] Read BNO085 (accel, orientation) and BME280 over I2C; print to serial.
- [ ] Read the GPS with TinyGPSPlus; report `gps_fix`, and `lat`/`lon` only when there is a fix.
- [ ] Compute heat index from temperature and humidity.
- [ ] Fall state machine with thresholds in `firmware/config.h`.
- [ ] Wi-Fi client: POST telemetry (1 Hz) and fall events immediately.
- [ ] Reconnect logic; fall events queued if Wi-Fi drops.

### W3. Data and testing (Owner: TBD)
- [ ] CSV logging mode (firmware or serial capture) at 100 Hz or better; store in `data/`.
- [ ] Safe test protocol: padded drops, sandbag, mattress. No people falling.
- [ ] Collect normal-activity data (see A3) and fake-fall data.
- [ ] Tune thresholds with the firmware owner; write results in section 8.
- [ ] Run the acceptance tests and record results.
- [ ] Stretch: plan staged falls in two or three zones for the demo so the hazard map shows real data.

### W4. Server and dashboard (Owner: TBD)
- [ ] Pick the stack (Python FastAPI or Node) and record it in section 8.
- [ ] API: `POST /api/telemetry`, `POST /api/event`, `GET /api/devices`, `GET /api/incidents`, `PATCH /api/devices/{id}` (assign names).
- [ ] SQLite storage for devices, telemetry, and incidents.
- [ ] Dashboard: device list with names and status, incident list, zone map on a floor-plan image, heat color per worker.
- [ ] Optional: simulator script that posts fake devices so the dashboard can be built before hardware is ready.
- [ ] Stretch: incident status (new, confirmed, dismissed) with confirm and dismiss controls.
- [ ] Stretch: manual "report injury or hazard" form (zone and note).
- [ ] Stretch: hazard map layer (red markers or shaded zones by confirmed incident count), a falls/heat layer toggle, and `GET /api/hazards`.

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
| | Server stack: TBD | |
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
| Time | Follow the cut order in section 6 |

## 10. Open questions

- Hackathon dates, judging format, and demo room setup (indoor, Wi-Fi, power outlets)?
- Who owns each workstream?
- Confirm the zone-based location approach for the indoor demo.
- Which 3D printer and filament for the housing?
- Which helmet will we use, and is there room for the housing and clip? Measure the actual battery runtime with Wi-Fi and GPS on, since no figure is guaranteed.
- Server stack: Python or Node?
- How does the demo assign a location (zone) at the moment of a fall: a manual zone per device, a simulated path, or something else?
- What does "navigation lights" need to do, if we get to it? (Direction to a fallen worker needs position and heading, which are hard indoors.)

## 11. Demo script **[proposed]**

1. Show the helmet and dashboard with a named worker online and a live heat reading.
2. Warm the sensor area slightly; the heat color changes.
3. Perform a padded drop of the helmet; a fall incident appears on the dashboard with its zone.
4. Pick the helmet up and put it down gently; no false alarm.
5. Show the incident list and stored data after a refresh.
6. (Stretch) Confirm the fall incident; its zone turns red on the hazard map. Say plainly which history is sample data.
7. State what is real (falls, ambient heat, dashboard) and what is future (heart rate, navigation lights, Pi gateway; GPS is mounted but only gets a fix outdoors).
