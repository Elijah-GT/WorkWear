# CLAUDE.md: Construction Safety Helmet (hackathon MVP)

Read this file first, then `PLAN.md`. This brief is for any AI agent (and human) working on this repo. Keep changes small, follow the rules below, and update `PLAN.md` when you finish or change something.

## What we are building

A helmet-mounted safety sensor for construction workers. The MVP:

1. **Detects falls** from head/helmet motion and alerts a supervisor dashboard.
2. **Monitors heat exposure** (ambient temperature and humidity at the helmet, shown as a heat index).
3. **Shows it all on a dashboard**: named devices, incident list, location (zone on a site map), and a heat color per worker.
4. **Marks hazard zones** (stretch goal, built after the incident list works): confirmed falls and reported injuries appear as red markers or shaded zones on the site map, so a supervisor can see where incidents cluster.

Framing for outsiders: we are student researchers exploring whether wearable fall and heat detection is useful to small construction companies. We are not selling a product.

## Decisions already made (do not reopen without the team)

- Helmet only for the MVP (no armband).
- Demo is **indoors** with **Wi-Fi** available.
- MCU: **ESP32** (ESP-32S / WROOM-32 dev board). Not the Nano 33 IoT.
- IMU: **GY-BNO085** (BNO085, I2C).
- Barometer / temperature / humidity: **BME280** (I2C). It must be a BME280, not a BMP280 (the BMP280 has no humidity).
- Battery: **NULLLAB 1200 mAh LiPo module** (USB-C charging, 56x40 mm board, cell marked 3.7 V 1200 mAh 4.44 Wh). It has a built-in boost converter, 3.3 V regulator, and protection circuits. Rails: 5 V/1.2 A (header pin and USB-A), 3.3 V/800 mA, and the raw battery on a JST PH2.0 connector. We power the ESP32 from the **5 V header pin to VIN** (or USB-A to the ESP32's micro-USB). Docs: github.com/nulllaborg/pm11-module (seen on the listing; verify the pin labels on the board).
- Location: a **GY-NEO6MV2 (u-blox NEO-6M) GPS module with a ceramic antenna** (UART) is on the helmet. Indoors it will not get a fix, so the indoor demo uses zones (see below).
- Enclosure: a **3D-printed housing and clip** for the hard hat. No drilling. A teammate is already designing it; give them the dimensions and constraints in the hardware notes below.
- LEDs are on hand but are **later** (navigation lights). Do not wire or program them for the MVP.
- Heart rate and the Raspberry Pi networking are **later**, only if there is time.
- Navigation lights (LEDs on the helmet that point toward a fallen worker) are **later**.
- The hazard-zone map (red markers where falls or injuries happened) is a **stretch goal**, built only after the basic incident list works.

## Proposed defaults (change only if the team agrees; note it in PLAN.md)

- The BME280 gives a heat index, and pressure lets us see altitude drops.
- Location for the indoor demo: **zone-based or simulated**, because GPS will not get a fix indoors. The GPS module still runs: firmware reads it, reports `gps_fix` (true or false), and fills `lat`/`lon` only when there is a fix. Outdoors, or near a window, a real fix replaces the zone.
- Data path: ESP32 sends JSON over Wi-Fi (HTTP POST) to a server on a laptop. Moving that same server to a Raspberry Pi later should need no rewrite.
- Fall detection runs **on the ESP32**, not on the laptop, so alerts survive a dropped connection.
- A worn/not-worn sensor (IR proximity or microswitch inside the crown) so a helmet set down or tossed is not read as a fall.

## Architecture

```
Helmet:  BNO085 + BME280 (I2C) + GPS (UART) -> ESP32 (5 V from the NULLLAB LiPo module) -> Wi-Fi (2.4 GHz, phone hotspot)
Laptop:  server (HTTP API + SQLite)  ->  web dashboard (devices, incidents, map, heat color)
```

Proposed repo layout:

```
firmware/    ESP32 code (Arduino framework): sensors, fall state machine, Wi-Fi client
server/      API + SQLite storage
dashboard/   web UI
data/        logged CSV test data (falls and normal activity)
docs/        wiring, protocol, test notes
CLAUDE.md
PLAN.md
```

## Data contract (single source of truth: `docs/PROTOCOL.md` once created)

Telemetry, about 1 Hz, `POST /api/telemetry`:

```json
{"device_id":"helmet-01","uptime_ms":123456,"worn":true,"temp_c":29.4,
 "humidity_pct":41.0,"pressure_hpa":1009.2,"heat_index_c":30.1,
 "accel_g":1.01,"tilt_deg":12.0,"zone":"A2","gps_fix":false,"lat":null,"lon":null}
```

Event, sent immediately, `POST /api/event`:

```json
{"device_id":"helmet-01","uptime_ms":123999,"type":"fall",
 "peak_g":4.2,"freefall_ms":220,"still_s":2.1,"zone":"A2"}
```

Rules: the ESP32 has no real-time clock, so the **server stamps time on receipt**. Never change a field name or type without updating `docs/PROTOCOL.md`, the firmware, the server, and the dashboard in the same change. The dashboard assigns human names to `device_id`s.

## Hazard map (stretch goal)

Each incident the server stores has: `id`, `device_id`, `worker_name`, `type` (`fall` or `injury_report`), `ts` (server time), `zone`, optional `lat` and `lon`, `peak_g` (falls only), `status` (`new`, `confirmed`, `dismissed`), and `notes`.

- Falls come from the helmet. Injuries and other hazards (for example a wet floor) are **manual reports** entered on the dashboard, because the helmet cannot detect injuries.
- Only `confirmed` incidents count toward a hazard zone. A supervisor confirms or dismisses each incident on the dashboard, so false alarms do not create hazards.
- Hazard level per zone = number of confirmed incidents (optionally within a recent time window). Indoors, shade the zone. With real GPS outdoors, show red markers at `lat` and `lon`.
- Routes: `POST /api/incidents` (manual report), `PATCH /api/incidents/{id}` (set status and notes), `GET /api/hazards` (confirmed counts per zone).
- Map quality depends on the location source. For the indoor demo, use zones.
- Layers: falls and heat, with a toggle. Heat uses the highest heat index seen per zone.

## Fall detection (starting values, to be tuned from logged data)

State machine: `IDLE -> FREEFALL -> IMPACT -> STILL -> ALERT`.

- Free-fall: total acceleration below about 0.4 g for at least about 100 ms.
- Impact: a spike above about 2.5 to 3 g shortly after free-fall.
- Stillness: roughly 1 g with little rotation for about 2 s, ideally with the helmet tilted away from upright.
- Cancel and log as "recovered" if normal movement resumes.
- Suppress alerts when `worn` is false.
- Keep all thresholds in one config header (`firmware/config.h`), never scattered in code.
- The BNO085 accelerometer range is about +/-8 g (verify in the datasheet). Hard impacts will clip, which is fine for triggering but not for measuring severity.

## Hard rules (hardware and safety)

- **Never** feed a raw 3.7 V LiPo into the ESP32's VIN (the AMS1117 regulator needs roughly 4.4 V or more). Use the module's **5 V** output, not its raw battery pin or JST output. **Never** put 4.2 V on the 3V3 pin.
- Check battery connector **polarity** before plugging in. JST wiring differs between vendors.
- Do not connect laptop USB and a battery module's 5 V to the ESP32 at the same time.
- Set and measure any adjustable boost converter output (5.0 V) before connecting the ESP32.
- LiPo: the NULLLAB module has protection circuits, but still keep it inside the enclosure, charge it only through its own USB-C port, never charge it unattended, and stop using it if it swells, gets hot, or is punctured. The listing says it does **not** support UPS operation, so do not count on it running the ESP32 reliably while it charges; charge with the helmet off.
- Mount the module away from the top of the head where an impact could crush it, with padding between it and the hat shell, and no sharp edges against the cell.
- **Do not drill or modify a hard-hat shell.** Use accessory slots, clips, or tape, and treat the helmet as a demo prop, not certified PPE.
- Do not test falls with a person falling. Use a padded drop, a sandbag, or a mattress.
- I2C: BNO085 at 0x4A (or 0x4B), BME280 at 0x76 (or 0x77), default ESP32 pins SDA GPIO21 and SCL GPIO22. Wire the BNO085 RST and INT pins. Use a lower I2C clock if it is flaky. Power sensors from 3V3.
- GPS (GY-NEO6MV2): UART2 on the ESP32. Wire GPS TX -> GPIO16 (RX2) and GPS RX -> GPIO17 (TX2), GND to GND, VCC to 3V3. Default 9600 baud, 1 Hz updates, 3.3 V logic. Boards of this type usually accept 3.3-5 V on VCC, but verify against the seller's page, and power it from 3V3 so the logic levels match. The onboard LED blinks once there is a fix. A cold start outdoors can take several minutes and it will not fix indoors. Keep the ceramic antenna facing up with a clear view of the sky, and away from the ESP32's Wi-Fi antenna and the battery. These values are from memory of the NEO-6M; verify them.
- Enclosure: 3D print in PETG or ABS (PLA softens in a hot car or sun). Leave airflow to the BME280 and keep it away from the ESP32 and the battery so their heat does not skew readings. Keep the LiPo module in its own compartment. Dimensions: board 56 x 40 mm; the cell is marked 103040, which normally means about 10 mm thick x 30 mm wide x 40 mm long (measure the real parts before the final print). Leave access to the USB-C port, the power switch, and the 4 gauge LEDs. Leave room for the LEDs later.
- Wi-Fi is 2.4 GHz only. Campus or guest networks may block device-to-device traffic, so use a phone hotspot or travel router.

## Honesty rules (matter for judges and customers)

- Do **not** claim heat-stress or core-temperature detection. The sensor reads ambient conditions at the helmet. Call it "heat exposure" or "heat risk".
- Do **not** claim heart-rate monitoring until it exists.
- Label simulated or zone-based location as simulated in the UI.
- Label seeded or sample incident history as sample data. Never present made-up history as real.
- Never fabricate test results or customer feedback. Real numbers only.

## Conventions

- Firmware: Arduino framework on ESP32 (Arduino IDE or PlatformIO). Libraries we expect: Adafruit BNO08x, Adafruit BME280, TinyGPSPlus, ArduinoJson, WiFi/HTTPClient.
- Server: Python (FastAPI) or Node, with SQLite. Pick one in `PLAN.md` and stick to it.
- Dashboard: static HTML/JS served by the server. Use a floor-plan image with zones for the indoor demo. A Leaflet map is optional for later outdoor GPS.
- Keep it simple. This is a 2-day build. Prefer working over elegant, and no new dependencies without a reason.
- Small commits, clear messages. One workstream per branch if you use branches.
- Before you start, read `PLAN.md` and claim a task by adding your name. When you finish, tick it and add a one-line note.
- If you hit something the plan did not expect (a part that does not work, a threshold that fails), write it in the "Decisions and findings" section of `PLAN.md` instead of silently working around it.

## Out of scope for the MVP

Heart rate, Raspberry Pi networking, navigation LEDs (the LEDs are on hand but unused for now), cloud hosting, cellular or LoRa, accounts and logins, mobile apps, certification, and multi-site support.
