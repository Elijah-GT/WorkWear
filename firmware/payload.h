// JSON bodies for the server, exactly as in docs/PROTOCOL.md section 2.
// Pure logic (snprintf only), tested on a laptop in firmware/test/.
// Missing readings are NAN in the structs and become null in the JSON.
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

#include "fall_detector.h"

struct Telemetry {
  uint32_t uptime_ms = 0;
  bool worn = true;
  float temp_c = NAN;
  float humidity_pct = NAN;
  float pressure_hpa = NAN;
  float heat_index_c = NAN;
  float accel_g = NAN;
  float tilt_deg = NAN;
  bool gps_fix = false;
  double lat = NAN;  // sent only when gps_fix is true
  double lon = NAN;
  char zone[ZONE_ID_MAX + 1] = "";  // from beacons; "" is sent as null
};

// A zone id safe to send: 1 to ZONE_ID_MAX characters of A-Z a-z 0-9 . _ -
// (anything else is sent as null, so a bad beacon name can never break the JSON).
bool zoneIdOk(const char* zone);

// Each returns the JSON length, or -1 if it did not fit in buf.
int buildTelemetryJson(char* buf, size_t cap, const char* device_id, const Telemetry& t);
int buildFallEventJson(char* buf, size_t cap, const char* device_id, const FallEvent& e,
                       uint32_t sent_uptime_ms);
