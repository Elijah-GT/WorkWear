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

static Adafruit_BNO08x bno(BNO085_RST_PIN);
static sh2_SensorValue_t bno_value;
static bool imu_ok = false;
static float last_gyro_dps = NAN;
static float last_tilt_deg = NAN;

static bool enableImuReports() {
  return bno.enableReport(SH2_ACCELEROMETER, ACCEL_INTERVAL_US) &&
         bno.enableReport(SH2_GYROSCOPE_CALIBRATED, GYRO_INTERVAL_US) &&
         bno.enableReport(SH2_GRAVITY, GRAVITY_INTERVAL_US);
}

bool imuBegin() {
  pinMode(BNO085_INT_PIN, INPUT_PULLUP);
  imu_ok = bno.begin_I2C(BNO085_ADDR, &Wire) && enableImuReports();
  return imu_ok;
}

bool imuOk() { return imu_ok; }

bool imuPoll(float* accel_g, float* gyro_dps, float* tilt_deg) {
  if (!imu_ok) return false;
  if (bno.wasReset()) enableImuReports();  // the BNO085 forgets its reports after a reset

  // A bounded number of reports per call, so the rest of loop() still runs.
  for (int i = 0; i < 8 && bno.getSensorEvent(&bno_value); i++) {
    switch (bno_value.sensorId) {
      case SH2_ACCELEROMETER: {
        const float x = bno_value.un.accelerometer.x;
        const float y = bno_value.un.accelerometer.y;
        const float z = bno_value.un.accelerometer.z;
        *accel_g = sqrtf(x * x + y * y + z * z) / kStandardGravity;
        *gyro_dps = last_gyro_dps;
        *tilt_deg = last_tilt_deg;
        return true;
      }
      case SH2_GYROSCOPE_CALIBRATED: {
        const float x = bno_value.un.gyroscope.x;
        const float y = bno_value.un.gyroscope.y;
        const float z = bno_value.un.gyroscope.z;
        last_gyro_dps = sqrtf(x * x + y * y + z * z) * kRadToDeg;
        break;
      }
      case SH2_GRAVITY: {
        const float g[3] = {bno_value.un.gravity.x, bno_value.un.gravity.y, bno_value.un.gravity.z};
        const float mag = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
        if (mag > 1.0f) {
          // The gravity report gives the "up" direction (+9.8 on the axis pointing up when
          // the board lies flat). Verify on the real helmet: tilt should read ~0 when upright.
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
  return false;
}

// ---------------- BME280 ----------------

static Adafruit_BME280 bme;
static bool env_ok = false;

bool envBegin() {
  // begin() checks the chip ID, so a BMP280 (no humidity) fails here on purpose.
  env_ok = bme.begin(BME280_ADDR, &Wire);
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
