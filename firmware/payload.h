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
  // Latest drop check (config.h DROP_DEBUG), so a helmet on battery can still be diagnosed.
  // Sent as "drop_check" only when has_drop_check is true (PROTOCOL.md section 2.1).
  bool has_drop_check = false;
  uint32_t drop_uptime_ms = 0;     // when the check finished
  uint32_t drop_freefall_ms = 0;   // longest run below FREEFALL_G
  float drop_min_g = NAN;          // lowest reading in it
  float drop_peak_g = NAN;         // hardest hit after it
  uint32_t drop_need_ms = 0;       // FREEFALL_MIN_MS, so the dashboard can show the target
  float drop_need_g = NAN;         // IMPACT_G
};

// A zone id safe to send: 1 to ZONE_ID_MAX characters of A-Z a-z 0-9 . _ -
// (anything else is sent as null, so a bad beacon name can never break the JSON).
bool zoneIdOk(const char* zone);

// Each returns the JSON length, or -1 if it did not fit in buf.
int buildTelemetryJson(char* buf, size_t cap, const char* device_id, const Telemetry& t);
int buildFallEventJson(char* buf, size_t cap, const char* device_id, const FallEvent& e,
                       uint32_t sent_uptime_ms);
