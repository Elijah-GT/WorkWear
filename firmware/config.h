// config.h: every setting for the helmet firmware lives here.
// Thresholds are starting values from CLAUDE.md; tune them from logged data (PLAN.md W3)
// and record the final values in PLAN.md section 8.
//
// Wi-Fi name and password are NOT here: copy secrets.example.h to secrets.h (git ignores it).
// This file must stay plain #defines so the logic tests can build it on a laptop.
#pragma once

// ---------------- Identity and server ----------------
// helmet-01, helmet-02, ... Never start with "sim-" (that prefix marks simulator data).
#define DEVICE_ID "helmet-01"
// The laptop running the server, as the ESP32 sees it on the hotspot. Find it with
// `ipconfig` on the laptop. Port 8000 (docs/PROTOCOL.md section 1).
#define SERVER_URL "http://172.20.10.3:8000"  // laptop on the iPhone hotspot (2026-11-07); iPhone hotspots use 172.20.10.x

#define HTTP_TIMEOUT_MS      3000   // no answer within 3 s = failure (PROTOCOL.md section 1)
#define TELEMETRY_PERIOD_MS  1000   // about 1 Hz
#define EVENT_RETRY_MS       2000   // retry queued fall events every 2 s (PROTOCOL.md 2.2)
#define EVENT_QUEUE_SIZE     8      // fall events kept in RAM while Wi-Fi is down
#define WIFI_RETRY_MS        10000  // restart the Wi-Fi connection if it has been down this long

// ---------------- Serial ----------------
// LOG_CSV 1 prints one CSV line per IMU sample for threshold tuning (PLAN.md W3).
// Status lines start with "#" so they can be filtered out of the CSV.
#define LOG_CSV 0
#if LOG_CSV
#define SERIAL_BAUD 921600          // 200 lines/s does not fit through 115200 baud
#else
#define SERIAL_BAUD 115200
#endif
#define STATUS_PERIOD_MS 5000       // human-readable status line (off while LOG_CSV is 1)
// 1 = also print each telemetry message and fall event as one JSON line on serial
// ("@telemetry {...}", "@event {...}"). firmware/serial_bridge.ps1 posts them to the server, so a
// helmet plugged into the laptop by USB shows on the dashboard without Wi-Fi. The server ignores
// a fall event it already got over Wi-Fi.
#define SERIAL_BRIDGE 1
// 1 = print one "# drop check" line per low-g moment (free-fall length, lowest g, hardest hit
// within IMPACT_WINDOW_MS after it), to see which fall step a test drop misses. Off for the demo.
#define DROP_DEBUG 1

// ---------------- I2C: BNO085 (and the BME280's own bus below) ----------------
#define I2C_SDA_PIN   21            // as wired (bench, 2026-11-07); moved off GPIO5 (a boot-strap pin)
#define I2C_SCL_PIN   17            // as wired; was 22
#define I2C_CLOCK_HZ  400000        // 100000 is too slow for the 200 Hz accel reports (read 0.00 g in a test)
#define BNO085_ADDR   0x4B          // our GY-BNO085 answers at 0x4B (I2C scan 2026-11-07); some boards use 0x4A
#define BNO085_RST_PIN 19           // as wired (was 4, then 25); imuBegin() pulses it, which un-sticks the IMU (and
                                    // the I2C bus) after an ESP32 reset without power-cycling it. -1 = not wired
#define BNO085_BOOT_MS 300          // wait after the reset pulse before talking to the IMU
#define I2C_TIMEOUT_MS 200          // the BNO085 holds the bus while it boots; the ESP32 default is 50 ms
#define IMU_STALL_MS   1000         // no accel report this long = IMU stalled: reset and restart it
#define BNO085_INT_PIN 18          // as wired (found on the bench); the firmware reads the IMU only while INT is low (polling stalled)
// 1 = read the BME280 (temperature, humidity, pressure). Back on 2026-11-07 (Elijah): the
// dashboard shows each worker's air temperature (no heat section; dashboard/logic.js SHOW_HEAT).
// 0 = not started or powered; telemetry sends those fields as null (PROTOCOL.md allows it).
#define HAS_BME280    1
#define BME280_ADDR   0x76          // 0x77 on some boards
// The BME280 is wired to its own pins and runs on the ESP32's second I2C controller (Wire1).
// To put it on the shared bus with the BNO085 instead, set these to I2C_SDA_PIN / I2C_SCL_PIN.
#define BME280_SDA_PIN  25          // as wired (bench, 2026-11-07); was 32
#define BME280_SCL_PIN  26          // was 33
#define BME280_CLOCK_HZ 100000      // the BME280 is read once a second; slow and safe is fine
// The BME280's VIN is wired to GPIO27, so the firmware drives that pin HIGH (3.3 V) at start-up to
// power it (it draws about 1 mA; a pin can supply that). Set -1 if VIN is moved to the 3V3 pin.
#define BME280_POWER_PIN 27

// IMU report rates (microseconds between samples)
#define ACCEL_INTERVAL_US    5000   // 200 Hz: short impact spikes need a fast rate
#define GYRO_INTERVAL_US     10000  // 100 Hz
#define GRAVITY_INTERVAL_US  20000  // 50 Hz, used for tilt

// Which IMU axis points up through the crown when the helmet is worn upright.
// 0 = X, 1 = Y, 2 = Z. Sign 1 or -1. Check after mounting: tilt_deg should read
// about 0 upright, 90 on its side, 180 upside down.
#define IMU_UP_AXIS  2
#define IMU_UP_SIGN  1

#define ENV_PERIOD_MS 1000          // BME280 read rate

// ---------------- GPS (GY-NEO6MV2 on UART2) ----------------
#define GPS_BAUD          9600
#define ESP_GPS_RX_PIN    16        // ESP32 receives here: connect to the GPS TX pin
#define ESP_GPS_TX_PIN    23        // ESP32 sends here (not used yet): GPS RX pin. Was 17, now the IMU's SCL
#if ESP_GPS_RX_PIN == I2C_SDA_PIN || ESP_GPS_RX_PIN == I2C_SCL_PIN || ESP_GPS_TX_PIN == I2C_SDA_PIN || \
    ESP_GPS_TX_PIN == I2C_SCL_PIN || ESP_GPS_RX_PIN == BME280_SDA_PIN || ESP_GPS_RX_PIN == BME280_SCL_PIN || \
    ESP_GPS_TX_PIN == BME280_SDA_PIN || ESP_GPS_TX_PIN == BME280_SCL_PIN
#error "A GPS pin is also an I2C pin in config.h: the GPS serial port would take it over"
#endif
#define GPS_MAX_AGE_MS    3000      // a fix older than this counts as no fix

// ---------------- Worn sensor ----------------
// 0 = no sensor fitted: firmware always reports worn: true (decided 2026-11-06).
// 1 = microswitch or IR proximity module on WORN_PIN.
#define HAS_WORN_SENSOR    0
#define WORN_PIN           26       // was 27; GPIO27 now powers the BME280
#if HAS_WORN_SENSOR && WORN_PIN == BME280_POWER_PIN
#error "WORN_PIN and BME280_POWER_PIN are the same GPIO: pick another pin for one of them in config.h"
#endif
#define WORN_ACTIVE_LEVEL  LOW      // pin level that means "on a head" (switch to GND, pull-up on)
#define WORN_DEBOUNCE_MS   500

// ---------------- Indoor location: BLE zone beacons ----------------
// 1 = scan for zone beacons (spare ESP32s running firmware/beacon/beacon.ino, one per zone)
// and report the zone of the strongest one. The server then uses it instead of the zone set
// on the dashboard. 0 = no scanning; the helmet sends "zone": null as before.
// With 1, pick Tools > Partition Scheme > "Huge APP" (BLE makes the program too big for the
// default scheme). See firmware/README.md.
#define HAS_BLE_BEACONS      0
#define BEACON_NAME_PREFIX   "WW-"   // beacons advertise "WW-<zone id>", e.g. "WW-1520-N"
#define BEACON_SCAN_S        1       // each scan listens this many seconds
#define BEACON_MIN_RSSI      -90     // dBm; weaker beacons are ignored
#define BEACON_SWITCH_DB     6       // a new zone must be this much stronger than the current one...
#define BEACON_SWITCH_SCANS  2       // ...for this many scans in a row (stops flicker at zone edges)
#define BEACON_LOST_MS       8000    // no beacon heard this long = zone unknown (server falls back)
#define BEACON_SMOOTHING     0.5f    // 0-1: weight of the newest scan in each beacon's average

// Longest zone id (same limit as the server and dashboard).
#define ZONE_ID_MAX 32

// ---------------- Fall detection ----------------
// State machine: IDLE -> FREEFALL -> IMPACT -> STILL -> ALERT (see fall_detector.h).
#define FREEFALL_G          0.4f    // total acceleration below this = free-fall
#define FREEFALL_MIN_MS     100     // free-fall must last at least this long
#define FREEFALL_MAX_MS     3000    // longer than this near 0 g = sensor fault, not a fall
#define IMPACT_G            2.5f    // impact spike (try 2.5 to 3.0); the IMU clips near 8 g
#define IMPACT_WINDOW_MS    500     // impact must come within this long after free-fall ends
#define POST_IMPACT_SETTLE_MS 500   // ignore bounces this long after the impact
#define STILL_ACCEL_TOL_G   0.15f   // "still" = total acceleration within 1 g +/- this
#define STILL_GYRO_DPS      30.0f   // ... and rotating slower than this (degrees per second)
#define STILL_MS            2000    // stillness needed before the alert
#define STILL_WINDOW_MS     8000    // no stillness within this long after settling = recovered
#define REQUIRE_TILT        0       // 1 = also require the helmet tilted away from upright
#define MIN_TILT_DEG        45.0f   // used only when REQUIRE_TILT is 1
#define ALERT_COOLDOWN_MS   10000   // ignore new falls this long after an alert
