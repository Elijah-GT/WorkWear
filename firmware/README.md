# Helmet firmware (ESP32)

Reads the BNO085 (motion), BME280 (temperature, humidity, pressure), NEO-6M GPS and the optional worn sensor; runs fall detection **on the helmet**; sends telemetry (1 Hz) and fall events to the server over Wi-Fi. Message formats: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

**Status (2026-11-07):** compiles for the ESP32 (esp32 core 3.3.12) and the logic tests pass on a laptop. The server accepts its JSON. **Not yet run on real hardware**: sensor reads, tilt direction, Wi-Fi, and all thresholds still need checking on the helmet.

## Files

| File | What it does |
|---|---|
| `firmware.ino` | Start-up and the main loop: sensors, fall detection, status lines |
| `config.h` | **Every setting**: device ID, server URL, pins, rates, fall thresholds |
| `secrets.example.h` | Template for `secrets.h` (Wi-Fi name and password; git ignores `secrets.h`) |
| `fall_detector.*` | Fall state machine (pure logic, tested on a laptop) |
| `heat_index.*` | NOAA heat index, same formula as `server/simulator.py` |
| `payload.*` | Builds the telemetry and fall-event JSON |
| `event_queue.*` | Holds fall events until the server confirms them |
| `sensors.*` | BNO085, BME280, GPS and worn-sensor drivers |
| `net.*` | Wi-Fi and HTTP on a separate task, so a slow server never pauses fall detection |
| `beacons.*`, `zone_tracker.*` | Optional BLE zone beacons: scanning, and picking the zone (tracker tested on a laptop) |
| `beacon/beacon.ino` | Separate sketch for the zone beacons themselves |
| `test/` | Laptop tests for the pure logic |

## Set up the Arduino IDE (once)

1. **File > Preferences > Additional boards manager URLs:** add `https://espressif.github.io/arduino-esp32/package_esp32_index.json`.
2. **Boards Manager:** install **esp32 by Espressif** (tested with 3.3.12).
3. **Library Manager:** install **Adafruit BNO08x**, **Adafruit BME280 Library**, and **TinyGPSPlus** (by Mikal Hart). Accept the extra Adafruit libraries they ask for. Tested with BNO08x 1.2.7, BME280 2.3.0, TinyGPSPlus 1.0.3.
4. Open `firmware/firmware.ino`. Board: **ESP32 Dev Module**. Pick the COM port.

## Configure and flash

1. Copy `secrets.example.h` to `secrets.h` and fill in the hotspot name and password (2.4 GHz only).
2. In `config.h`, set `DEVICE_ID` (`helmet-01`, `helmet-02`, ...; never `sim-...`) and `SERVER_URL` (the laptop's IP on the hotspot, port 8000; see [`server/README.md`](../server/README.md)).
3. Upload. Open the Serial Monitor at **115200** baud.

**Power:** while it is plugged into the laptop by USB, do **not** also connect the battery module's 5 V (CLAUDE.md hard rules).

## Wiring (pins from `config.h`)

| Part | Part pin | ESP32 |
|---|---|---|
| BNO085 | VIN / GND | 3V3 / GND |
| BNO085 | SDA / SCL | GPIO21 / GPIO22 |
| BNO085 | RST | GPIO4 |
| BNO085 | INT | GPIO19 (wired, not used yet; the library polls) |
| BME280 | VIN / GND / SDA / SCL | 3V3 / GND / GPIO21 / GPIO22 (shared I2C) |
| GPS NEO-6M | VCC / GND | 3V3 / GND |
| GPS NEO-6M | TX / RX | GPIO16 / GPIO17 (crossed: GPS TX goes to the ESP32's receive pin) |
| Worn sensor (optional) | signal / GND | GPIO27 / GND (switch to GND; set `HAS_WORN_SENSOR 1`) |

RST, INT and the worn-sensor pins were picked for this code; change them in `config.h` if the wiring differs. The full wiring write-up belongs in `docs/WIRING.md` (W1).

## First power-up checklist

The Serial Monitor shows start-up lines, then a status line every 5 s:

```
# Helmet firmware, device helmet-01
# BNO085 IMU: OK
# BME280: OK
# Wi-Fi connected, IP 192.168.43.57, server http://192.168.43.10:8000
# accel 1.00 g, tilt 2 deg, IDLE | 23.8 C, 41 % RH, heat index 23.5 C, 1009.1 hPa | GPS no fix (5120 chars) | Wi-Fi up, 0 falls queued | worn 1
```

- [ ] Both I2C sensors say **OK**. If not, check the wiring and the addresses (`BNO085_ADDR`, `BME280_ADDR`), and try `I2C_CLOCK_HZ 100000`.
- [ ] `accel` reads about **1.00 g** at rest.
- [ ] **Tilt:** with the board mounted in the helmet, upright reads about 0, on its side about 90, upside down about 180. If not, change `IMU_UP_AXIS` / `IMU_UP_SIGN`. *The sign has not been checked on the real board yet.*
- [ ] GPS `chars` keeps climbing. If it stays at 0, TX and RX are probably swapped. "no fix" indoors is normal.
- [ ] The helmet shows **online** on the dashboard.
- [ ] Padded drop onto a mattress (never a person): `# FALL ALERT ...` on serial, then a fall incident on the dashboard.

## Logging data for threshold tuning (W3)

Set `LOG_CSV 1` in `config.h`, upload, and set the Serial Monitor to **921600** baud. Each accelerometer sample (about 200 per second) prints one line:

```
t_ms,accel_g,gyro_dps,tilt_deg,worn,state
```

Lines starting with `#` are status messages; drop them before analysis. Save captures in `data/`. Set `LOG_CSV 0` again for the demo.

## How fall detection works

`IDLE -> FREEFALL -> IMPACT -> STILL -> ALERT`, all thresholds in `config.h`:

1. **Free-fall:** total acceleration below 0.4 g for at least 100 ms.
2. **Impact:** a spike of 2.5 g or more within 500 ms after the free-fall ends.
3. **Still:** after 0.5 s for bounces, about 1 g with little rotation for 2 s. Fall alert.
4. If the wearer keeps moving for 8 s instead, the fall is cancelled and logged on serial as **recovered** (not sent).
5. After an alert, new falls are ignored for 10 s.

**Worn check:** the helmet must have been worn when the free-fall **started**. A helmet that was set down or tossed does not alert. A helmet knocked off during a fall still alerts. With no worn sensor (`HAS_WORN_SENSOR 0`) it always counts as worn.

Fall events go out at once. If that fails, the helmet retries every 2 s (up to 8 events in RAM, lost on reboot). The server ignores repeats.

## Indoor location with BLE beacons (optional)

GPS gets no fix indoors. To have the helmet measure which zone it is in, put one small Bluetooth beacon in each zone. The helmet reports the zone of the strongest one, and the server then uses it instead of the zone picked on the dashboard (`docs/PROTOCOL.md` section 3). **Off by default** (`HAS_BLE_BEACONS 0`): the team decides whether it goes in the demo.

1. **Beacons:** one spare ESP32 per zone (about $5 each). Open `firmware/beacon/beacon.ino`, set `BEACON_ZONE` to the zone's id from `dashboard/zones.json` (`1520-W`, `1520-N`, ...), and upload. Power it from any USB charger or power bank. Place it in the middle of its zone, up high, away from metal.
2. **Helmet:** in `config.h` set `HAS_BLE_BEACONS 1`. In the Arduino IDE pick **Tools > Partition Scheme > Huge APP (3MB No OTA/1MB SPIFFS)**. With Bluetooth the program is about 1.8 MB, too big for the default 1.3 MB space; the compile says "Sketch too big" if you forget.
3. Upload and watch the Serial Monitor: `# beacon zone: 1520-N` appears and changes as you walk between zones. The status line shows `zone ...`.
4. On the dashboard the worker gets a blue "located" ring, and falls are filed in the measured zone.

**Tuning** (`config.h`): the helmet only moves to a new zone when its beacon is `BEACON_SWITCH_DB` (6 dB) stronger for `BEACON_SWITCH_SCANS` (2) scans in a row, which stops flicker at zone edges. `BEACON_MIN_RSSI` ignores beacons that are far away. If no beacon is heard for a few seconds, the zone goes back to "unknown" and the server uses the dashboard zone.

**What to expect:** room-level, not exact. Signal strength moves around with bodies, walls, and which way the helmet faces, so zones next to each other in one open room (1520 West/North/South) will sometimes swap near their edges. Separate rooms (1522, 1533) work better. Wi-Fi and Bluetooth share the ESP32's radio; keep Wi-Fi modem sleep on (the default). **Not yet tried on hardware.**

## Tests (no ESP32 needed)

```
bash firmware/test/run_tests.sh          # Linux / macOS / WSL with g++
wsl bash firmware/test/run_tests.sh      # from Windows
```

38 tests: the fall state machine on made-up acceleration traces, heat index against the simulator's values, exact JSON output, the retry queue, and the beacon zone tracker. Passing them does **not** mean the thresholds are right; that needs real drop and normal-activity data (acceptance tests A2 and A3).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `secrets.h: Copy firmware/secrets.example.h ...` compile error | `secrets.h` not created yet |
| `BME280: NOT FOUND` | Wrong address (0x76 vs 0x77), wiring, or the board is a BMP280 (no humidity) |
| `BNO085 IMU: NOT FOUND`, or it drops out | Wiring, RST not connected, try `I2C_CLOCK_HZ 100000` |
| `Wi-Fi: still not connected` | Wrong name or password, or a 5 GHz-only network |
| `telemetry not sent (HTTP -1)` | Server not reachable: wrong `SERVER_URL`, server not on `0.0.0.0`, firewall, or WSL2 (see `server/README.md`) |
| Resets when Wi-Fi starts (brownout) | Weak power: use the module's 5 V pin, add a 100-470 uF capacitor (PLAN.md risks) |
| Garbage on the Serial Monitor | Baud rate: 115200, or 921600 when `LOG_CSV` is 1 |
