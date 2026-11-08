#include "sensors.h"

#include <Adafruit_BME280.h>
#include <Adafruit_BNO08x.h>
#include <Arduino.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <math.h>

#include "config.h"

static const float kStandardGravity = 9.80665f;  // m/s^2 per g
static const float kRadToDeg = 57.29578f;

// ---------------- BNO085 ----------------

// No reset pin for the library: its own reset waits only 10 ms, and the BNO085 then accepted its
// reports but never sent any (tested 2026-11-07). imuBegin() resets it properly instead.
static Adafruit_BNO08x bno(-1);
static bool imu_ok = false;
static float last_gyro_dps = NAN;
static float last_tilt_deg = NAN;

// Bench findings (2026-11-07), why this does not use the library's getSensorEvent():
// - The BNO085 packs several reports into one transfer; getSensorEvent() keeps only one, so the
//   200 Hz accel overwrote the gyro and gravity reports. Our own SH2 callback keeps all of them.
// - Polling the I2C bus without looking at INT made the report stream stall after ~15 s. Reading
//   only while INT is low kept it steady (255 accel, 100 gyro, 50 gravity reports/s for 40 s).
// Accel samples go through a small queue so the fall detector still sees every one, in order.
static const int kAccelQueue = 32;
static float accel_queue[kAccelQueue];
static int accel_head = 0, accel_count = 0;
static uint32_t last_accel_ms = 0;  // when the last accel report arrived (stall watchdog)

static void onImuReport(void*, sh2_SensorEvent_t* event) {
  sh2_SensorValue_t v;
  if (sh2_decodeSensorEvent(&v, event) != SH2_OK) return;
  switch (v.sensorId) {
    case SH2_ACCELEROMETER: {
      const float x = v.un.accelerometer.x, y = v.un.accelerometer.y, z = v.un.accelerometer.z;
      const float g = sqrtf(x * x + y * y + z * z) / kStandardGravity;
      if (accel_count == kAccelQueue) { accel_head = (accel_head + 1) % kAccelQueue; accel_count--; }  // drop oldest
      accel_queue[(accel_head + accel_count) % kAccelQueue] = g;
      accel_count++;
      last_accel_ms = millis();
      break;
    }
    case SH2_GYROSCOPE_CALIBRATED: {
      const float x = v.un.gyroscope.x, y = v.un.gyroscope.y, z = v.un.gyroscope.z;
      last_gyro_dps = sqrtf(x * x + y * y + z * z) * kRadToDeg;
      break;
    }
    case SH2_GRAVITY: {
      const float g[3] = {v.un.gravity.x, v.un.gravity.y, v.un.gravity.z};
      const float mag = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
      if (mag > 1.0f) {
        // The gravity report gives the "up" direction (+9.8 on the axis pointing up when the
        // board lies flat). Verify on the real helmet: tilt should read ~0 when upright.
        float c = IMU_UP_SIGN * g[IMU_UP_AXIS] / mag;
        c = c > 1.0f ? 1.0f : (c < -1.0f ? -1.0f : c);
        last_tilt_deg = acosf(c) * kRadToDeg;
      }
      break;
    }
    default:
      break;
  }
}

// Let the SH2 library process what the sensor sends for a while (used during set-up only).
static void imuSettle(uint32_t ms) {
  const uint32_t t0 = millis();
  while (millis() - t0 < ms) sh2_service();
}

static bool enableImuReports() {
  // Slow reports first and the 200 Hz accel stream last, with time for each reply: requests sent
  // while the sensor is busy streaming were lost on the bench.
  const bool r = bno.enableReport(SH2_GRAVITY, GRAVITY_INTERVAL_US);
  imuSettle(30);
  const bool g = bno.enableReport(SH2_GYROSCOPE_CALIBRATED, GYRO_INTERVAL_US);
  imuSettle(30);
  const bool a = bno.enableReport(SH2_ACCELEROMETER, ACCEL_INTERVAL_US);
  imuSettle(30);
  return r && g && a;
}

bool imuBegin() {
  pinMode(BNO085_INT_PIN, INPUT_PULLUP);
#if BNO085_RST_PIN >= 0
  // Reset the BNO085 before talking to it. An ESP32 reset (every upload or crash) does not
  // power-cycle the IMU, and one caught mid-transfer holds SDA low so nothing on the bus
  // answers (seen on the bench: SDA stuck at 0 until this pulse). Then let it boot.
  pinMode(BNO085_RST_PIN, OUTPUT);
  digitalWrite(BNO085_RST_PIN, LOW);
  delay(20);
  digitalWrite(BNO085_RST_PIN, HIGH);
  delay(BNO085_BOOT_MS);
#endif
  if (!bno.begin_I2C(BNO085_ADDR, &Wire)) { imu_ok = false; return false; }
  sh2_setSensorCallback(onImuReport, nullptr);  // replaces the library's one-report handler
  // Wait for the sensor's "I have (re)started" message, then a little longer, before asking it
  // for reports.
  const uint32_t t0 = millis();
  while (millis() - t0 < 2000 && !bno.wasReset()) sh2_service();
  imuSettle(200);
  accel_head = accel_count = 0;
  last_accel_ms = millis();
  imu_ok = enableImuReports();
  return imu_ok;
}

bool imuOk() { return imu_ok; }

bool imuPoll(float* accel_g, float* gyro_dps, float* tilt_deg) {
  if (!imu_ok) return false;
  if (bno.wasReset()) enableImuReports();  // the BNO085 forgets its reports after a reset

  // Read only while INT says a transfer is waiting; a few per call, so the rest of loop() runs.
  for (int i = 0; i < 4 && digitalRead(BNO085_INT_PIN) == LOW; i++) sh2_service();

  if (accel_count == 0) {
    // Stall watchdog. Bench, 2026-11-07: after a test drop the stream stopped and the firmware
    // kept the last (bogus) reading for minutes, so later drops went unseen. With no accel
    // report for IMU_STALL_MS, mark the IMU failed: loop() then resets and restarts it.
    if (millis() - last_accel_ms > IMU_STALL_MS) {
      Serial.printf("# BNO085: no motion data for %d ms, restarting it\n", IMU_STALL_MS);
      imu_ok = false;
    }
    return false;
  }
  *accel_g = accel_queue[accel_head];
  accel_head = (accel_head + 1) % kAccelQueue;
  accel_count--;
  *gyro_dps = last_gyro_dps;
  *tilt_deg = last_tilt_deg;
  return true;
}

// ---------------- BME280 ----------------

static Adafruit_BME280 bme;
static bool env_ok = false;

// The BME280's I2C bus: its own (Wire1, on BME280_SDA_PIN/SCL_PIN), or the BNO085's bus (Wire,
// started in firmware.ino) when config.h gives it the same pins. Only the main loop reads it,
// so the two buses never need to share a lock.
static TwoWire* envBus() {
#if BME280_SDA_PIN == I2C_SDA_PIN && BME280_SCL_PIN == I2C_SCL_PIN
  return &Wire;
#else
  static bool started = false;
  if (!started) {
    Wire1.begin(BME280_SDA_PIN, BME280_SCL_PIN, BME280_CLOCK_HZ);
    started = true;
  }
  return &Wire1;
#endif
}

bool envBegin() {
#if !HAS_BME280
  env_ok = false;  // heat sensing switched off in config.h; envRead() then gives NAN (sent as null)
  return false;
#endif
#if BME280_POWER_PIN >= 0
  // The BME280 is powered from a GPIO (config.h): power-cycle it (a real reset, also on a
  // retry after bad readings), then let it boot (datasheet: 2 ms).
  pinMode(BME280_POWER_PIN, OUTPUT);
  digitalWrite(BME280_POWER_PIN, LOW);
  delay(20);
  digitalWrite(BME280_POWER_PIN, HIGH);
  delay(10);
#endif
  // begin() checks the chip ID, so a BMP280 (no humidity) fails here on purpose.
  env_ok = bme.begin(BME280_ADDR, envBus());
  if (env_ok) {
    // Forced mode, one measurement per read: the sensor stays idle in between, so it does
    // not warm itself up and skew the temperature (Bosch "weather monitoring" settings).
    bme.setSampling(Adafruit_BME280::MODE_FORCED, Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                    Adafruit_BME280::FILTER_OFF);
  }
  return env_ok;
}

bool envOk() { return env_ok; }

void envRead(EnvReading* r) {
  r->temp_c = NAN;
  r->humidity_pct = NAN;
  r->pressure_hpa = NAN;
  if (!env_ok) return;
  if (!bme.takeForcedMeasurement()) return;  // blocks about 10 ms
  r->temp_c = bme.readTemperature();
  const float h = bme.readHumidity();
  r->humidity_pct = (h >= 0.0f && h <= 100.0f) ? h : NAN;
  const float p = bme.readPressure();  // pascals, NAN on failure
  r->pressure_hpa = isnan(p) ? NAN : p / 100.0f;

  // Bench, 2026-11-07: after a test drop shook a wire, it read 182 C and -147 hPa, and that
  // went to the dashboard. Outside the sensor's range = a bad bus or a reset sensor: send
  // nothing and switch it off, so loop() power-cycles and restarts it.
  const bool temp_ok = r->temp_c >= BME280_MIN_C && r->temp_c <= BME280_MAX_C;
  const bool pressure_ok = r->pressure_hpa >= BME280_MIN_HPA && r->pressure_hpa <= BME280_MAX_HPA;
  if (!temp_ok || !pressure_ok) {
    Serial.printf("# BME280: impossible reading (%.1f C, %.1f hPa), restarting it\n", r->temp_c,
                  r->pressure_hpa);
    r->temp_c = r->humidity_pct = r->pressure_hpa = NAN;
    env_ok = false;
  }
}

// ---------------- GPS ----------------

static TinyGPSPlus gps;

void gpsBegin() { Serial2.begin(GPS_BAUD, SERIAL_8N1, ESP_GPS_RX_PIN, ESP_GPS_TX_PIN); }

void gpsPoll() {
  while (Serial2.available() > 0) gps.encode(Serial2.read());
}

bool gpsFix(double* lat, double* lon) {
  if (!gps.location.isValid() || gps.location.age() > GPS_MAX_AGE_MS) return false;
  *lat = gps.location.lat();
  *lon = gps.location.lng();
  return true;
}

uint32_t gpsCharsReceived() { return gps.charsProcessed(); }

// ---------------- Worn sensor ----------------

#if HAS_WORN_SENSOR
static bool worn_stable = true;
static bool worn_candidate = true;
static uint32_t worn_changed_ms = 0;
#endif

void wornBegin() {
#if HAS_WORN_SENSOR
  pinMode(WORN_PIN, INPUT_PULLUP);
  worn_stable = worn_candidate = (digitalRead(WORN_PIN) == WORN_ACTIVE_LEVEL);
  worn_changed_ms = millis();
#endif
}

bool wornRead() {
#if HAS_WORN_SENSOR
  const bool raw = (digitalRead(WORN_PIN) == WORN_ACTIVE_LEVEL);
  const uint32_t now = millis();
  if (raw != worn_candidate) {
    worn_candidate = raw;
    worn_changed_ms = now;
  } else if (now - worn_changed_ms >= WORN_DEBOUNCE_MS) {
    worn_stable = raw;
  }
  return worn_stable;
#else
  return true;  // no sensor fitted: always report worn (decided 2026-11-06)
#endif
}
