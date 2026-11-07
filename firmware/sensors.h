// Sensor drivers: BNO085 (IMU), BME280 (temperature, humidity, pressure), NEO-6M GPS,
// and the optional worn sensor. ESP32 only; all pins and addresses are in config.h.
#pragma once

#include <stdint.h>

// ---- BNO085 ----
bool imuBegin();  // call after Wire.begin(); returns false if the IMU did not answer
bool imuOk();
// Reads pending IMU reports. Returns true each time a new accelerometer sample arrives, with
// the latest rotation rate and tilt alongside it. Call it in a loop until it returns false.
bool imuPoll(float* accel_g, float* gyro_dps, float* tilt_deg);

// ---- BME280 ----
struct EnvReading {
  float temp_c;
  float humidity_pct;
  float pressure_hpa;
};
bool envBegin();
bool envOk();
void envRead(EnvReading* r);  // NAN fields when the sensor is missing or a read fails

// ---- GPS ----
void gpsBegin();
void gpsPoll();  // feed waiting NMEA characters to the parser; call often
bool gpsFix(double* lat, double* lon);  // true only with a valid, recent fix
uint32_t gpsCharsReceived();  // 0 after a few seconds = check the GPS wiring

// ---- Worn sensor ----
void wornBegin();
bool wornRead();  // always true when HAS_WORN_SENSOR is 0
