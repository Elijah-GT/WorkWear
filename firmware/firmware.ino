// Construction safety helmet firmware (hackathon MVP).
// Reads the IMU, BME280, GPS and worn sensor; runs fall detection on the helmet; sends
// telemetry and fall events to the server over Wi-Fi. Messages: docs/PROTOCOL.md.
// Settings: config.h. Wi-Fi details: secrets.h (copy secrets.example.h). Setup: README.md.
//
// loop() (core 1) does sensors and fall detection only; all networking is on its own task
// (net.cpp, core 0), so a slow server never stalls fall detection.

#include <Arduino.h>
#include <Wire.h>
#include <string.h>

#include "beacons.h"
#include "config.h"
#include "fall_detector.h"
#include "heat_index.h"
#include "net.h"
#include "payload.h"
#include "sensors.h"

static FallDetector detector;
static float accel_g = NAN;
static float gyro_dps = NAN;
static float tilt_deg = NAN;
static EnvReading env = {NAN, NAN, NAN};
static bool gps_has_fix = false;
static uint32_t last_env_ms = 0;
static uint32_t last_status_ms = 0;
static uint32_t imu_samples = 0;  // accel samples since the last status line
static uint32_t last_imu_retry_ms = 0;

static void logStatus(const char* label, bool ok) {
  Serial.printf("# %s: %s\n", label, ok ? "OK" : "NOT FOUND");
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);
  Serial.println();
  Serial.println("# Helmet firmware, device " DEVICE_ID);
  if (strncmp(DEVICE_ID, "sim-", 4) == 0) {
    Serial.println("# ERROR: DEVICE_ID must not start with \"sim-\" (reserved for the simulator)");
  }
#if !HAS_WORN_SENSOR
  Serial.println("# No worn sensor (HAS_WORN_SENSOR 0): always reporting worn: true");
#endif

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(I2C_CLOCK_HZ);
  Wire.setTimeOut(I2C_TIMEOUT_MS);
  logStatus("BNO085 IMU", imuBegin());
  if (!HAS_BME280) {
    envBegin();  // leaves the BME280 off; readings are sent as null
    Serial.println("# BME280: switched off (HAS_BME280 0 in config.h), no heat readings");
  } else if (!envBegin()) {
    logStatus("BME280", false);
    char power[12];
    if (BME280_POWER_PIN >= 0) snprintf(power, sizeof power, "GPIO%d", BME280_POWER_PIN);
    else snprintf(power, sizeof power, "3V3");
    Serial.printf("#   (check its power (VIN on %s, GND) and wiring: SDA GPIO%d, SCL GPIO%d; address 0x%02X in config.h;\n"
                  "#    a BMP280 also fails here, it has no humidity)\n",
                  power, BME280_SDA_PIN, BME280_SCL_PIN, BME280_ADDR);
  } else {
    logStatus("BME280", true);
  }
  gpsBegin();
  wornBegin();
  beaconsBegin();  // does nothing unless HAS_BLE_BEACONS is 1
  netBegin();

#if LOG_CSV
  Serial.println("t_ms,accel_g,gyro_dps,tilt_deg,worn,state");
#endif
}

static void handleFallResult(FallResult r, FallEvent& ev) {
  switch (r) {
    case FallResult::ALERT:
      beaconZone(ev.zone, sizeof(ev.zone));  // where it happened, if beacons know
      Serial.printf("# FALL ALERT: peak %.2f g, free-fall %lu ms, still %.1f s, zone %s\n", ev.peak_g,
                    (unsigned long)ev.freefall_ms, ev.still_s, ev.zone[0] ? ev.zone : "unknown");
      netQueueFall(ev);
#if SERIAL_BRIDGE
      {
        char buf[384];
        if (buildFallEventJson(buf, sizeof buf, DEVICE_ID, ev, millis()) > 0) Serial.printf("@event %s\n", buf);
      }
#endif
      break;
    case FallResult::SUPPRESSED:
      Serial.println("# fall ignored: helmet was not worn when it started");
      break;
    case FallResult::RECOVERED:
      Serial.println("# fall cancelled: movement resumed (recovered)");
      break;
    case FallResult::NONE:
      break;
  }
}

#if DROP_DEBUG && !LOG_CSV
// One line per low-g moment of 20 ms or more: how long, how low, and the hardest hit just after.
static void dropDebug(uint32_t t, float g) {
  static uint32_t low_start = 0, low_ms = 0, low_end = 0;
  static float low_min = 0, peak = 0;
  static bool watching = false;
  if (g < FREEFALL_G) {
    if (!low_start) { low_start = t; low_min = g; }
    else if (g < low_min) low_min = g;
    return;
  }
  if (low_start) {
    if (t - low_start >= 20) { low_ms = t - low_start; low_end = t; peak = g; watching = true; }
    low_start = 0;
  }
  if (!watching) return;
  if (g > peak) peak = g;
  if (t - low_end >= IMPACT_WINDOW_MS) {
    Serial.printf("# drop check: low-g %lu ms (needs %d), lowest %.2f g, then hardest hit %.2f g (needs %.1f)\n",
                  (unsigned long)low_ms, FREEFALL_MIN_MS, low_min, peak, IMPACT_G);
    watching = false;
  }
}
#endif

void loop() {
  const bool worn = wornRead();

  // Every new accelerometer sample goes through the fall detector.
  while (imuPoll(&accel_g, &gyro_dps, &tilt_deg)) {
    imu_samples++;
    const FallSample s = {millis(), accel_g, gyro_dps, tilt_deg, worn};
    FallEvent ev;
    const FallResult r = detector.update(s, &ev);
#if DROP_DEBUG && !LOG_CSV
    dropDebug(s.t_ms, s.accel_g);
#endif
#if LOG_CSV
    Serial.printf("%lu,%.3f,%.1f,%.1f,%d,%s\n", (unsigned long)s.t_ms, s.accel_g, s.gyro_dps,
                  s.tilt_deg, worn ? 1 : 0, FallDetector::stateName(detector.state()));
#endif
    handleFallResult(r, ev);
  }

  gpsPoll();
  const uint32_t now = millis();

  if (!imuOk() && now - last_imu_retry_ms >= 2000) {  // retry a missing or stalled IMU
    last_imu_retry_ms = now;
    logStatus("BNO085 IMU (retry)", imuBegin());
  }

  // About once a second: read the BME280 and hand a fresh reading to the network task.
  if (now - last_env_ms >= ENV_PERIOD_MS) {
    last_env_ms = now;
    envRead(&env);
    Telemetry t;
    t.uptime_ms = now;
    t.worn = worn;
    t.temp_c = env.temp_c;
    t.humidity_pct = env.humidity_pct;
    t.pressure_hpa = env.pressure_hpa;
    t.heat_index_c = heatIndexC(env.temp_c, env.humidity_pct);
    t.accel_g = imuOk() ? accel_g : NAN;
    t.tilt_deg = imuOk() ? tilt_deg : NAN;
    t.gps_fix = gps_has_fix = gpsFix(&t.lat, &t.lon);
    beaconZone(t.zone, sizeof(t.zone));
    netPublishTelemetry(t);
#if SERIAL_BRIDGE
    char buf[512];
    if (buildTelemetryJson(buf, sizeof buf, DEVICE_ID, t) > 0) Serial.printf("@telemetry %s\n", buf);
#endif
  }

#if !LOG_CSV
  if (now - last_status_ms >= STATUS_PERIOD_MS) {
    // Accel samples per second since the last status line: shows the IMU stream is alive (~200).
    const unsigned long rate = imu_samples * 1000UL / (now - last_status_ms);
    imu_samples = 0;
    last_status_ms = now;
    char zone[ZONE_ID_MAX + 1];
    beaconZone(zone, sizeof(zone));
    char env_text[80];
    if (HAS_BME280) {
      snprintf(env_text, sizeof env_text, "%.1f C, %.0f %% RH, heat index %.1f C, %.1f hPa", env.temp_c,
               env.humidity_pct, heatIndexC(env.temp_c, env.humidity_pct), env.pressure_hpa);
    } else {
      snprintf(env_text, sizeof env_text, "heat sensing off");
    }
    Serial.printf(
        "# accel %.2f g (%lu/s), gyro %.1f deg/s, tilt %.0f deg, %s | %s | "
        "GPS %s (%lu chars) | zone %s | Wi-Fi %s, %u falls queued | worn %d\n",
        accel_g, rate, gyro_dps, tilt_deg, FallDetector::stateName(detector.state()), env_text,
        gps_has_fix ? "fix" : "no fix", (unsigned long)gpsCharsReceived(),
        zone[0] ? zone : (HAS_BLE_BEACONS ? "unknown" : "set on dashboard"),
        netWifiConnected() ? "up" : "down", (unsigned)netPendingFalls(), worn ? 1 : 0);
  }
#endif

  delay(1);  // let the idle task run (keeps the watchdog happy)
}
