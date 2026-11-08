#include "payload.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>

namespace {

// Appends formatted text to a fixed buffer and remembers if anything did not fit.
struct JsonOut {
  char* buf;
  size_t cap;
  size_t len = 0;
  bool ok = true;

  JsonOut(char* b, size_t c) : buf(b), cap(c) {
    if (cap > 0) buf[0] = '\0';
    else ok = false;
  }

  void add(const char* fmt, ...) {
    if (!ok) return;
    va_list args;
    va_start(args, fmt);
    int n = vsnprintf(buf + len, cap - len, fmt, args);
    va_end(args);
    if (n < 0 || (size_t)n >= cap - len) {
      ok = false;
      return;
    }
    len += (size_t)n;
  }

  // "key":value with the given number of decimals, or "key":null for NAN/infinity.
  void num(const char* key, double v, int decimals) {
    if (isnan(v) || isinf(v)) add("\"%s\":null", key);
    else add("\"%s\":%.*f", key, decimals, v);
  }

  int result() const { return ok ? (int)len : -1; }

  // "zone":"1520-N", or "zone":null when there is no usable zone.
  void zone(const char* z) {
    if (zoneIdOk(z)) add("\"zone\":\"%s\"", z);
    else add("\"zone\":null");
  }
};

}  // namespace

bool zoneIdOk(const char* zone) {
  if (zone == nullptr || zone[0] == '\0') return false;
  size_t n = 0;
  for (const char* c = zone; *c; c++, n++) {
    const bool ok = (*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') ||
                    (*c >= '0' && *c <= '9') || *c == '.' || *c == '_' || *c == '-';
    if (!ok || n >= ZONE_ID_MAX) return false;
  }
  return true;
}

int buildTelemetryJson(char* buf, size_t cap, const char* device_id, const Telemetry& t) {
  JsonOut o(buf, cap);
  o.add("{\"device_id\":\"%s\",\"uptime_ms\":%lu,\"worn\":%s,", device_id,
        (unsigned long)t.uptime_ms, t.worn ? "true" : "false");
  o.num("temp_c", t.temp_c, 2);
  o.add(",");
  o.num("humidity_pct", t.humidity_pct, 1);
  o.add(",");
  o.num("pressure_hpa", t.pressure_hpa, 2);
  o.add(",");
  o.num("heat_index_c", t.heat_index_c, 2);
  o.add(",");
  o.num("accel_g", t.accel_g, 3);
  o.add(",");
  o.num("tilt_deg", t.tilt_deg, 1);
  // zone: null unless beacons located the helmet; the server then uses it (PROTOCOL.md section 1).
  o.add(",");
  o.zone(t.zone);
  o.add(",\"gps_fix\":%s,", t.gps_fix ? "true" : "false");
  o.num("lat", t.gps_fix ? t.lat : NAN, 6);
  o.add(",");
  o.num("lon", t.gps_fix ? t.lon : NAN, 6);
  if (t.has_drop_check) {
    o.add(",\"drop_check\":{\"uptime_ms\":%lu,\"freefall_ms\":%lu,", (unsigned long)t.drop_uptime_ms,
          (unsigned long)t.drop_freefall_ms);
    o.num("min_g", t.drop_min_g, 2);
    o.add(",");
    o.num("peak_g", t.drop_peak_g, 2);
    o.add(",\"freefall_need_ms\":%lu,", (unsigned long)t.drop_need_ms);
    o.num("impact_need_g", t.drop_need_g, 1);
    o.add("}");
  }
  o.add("}");
  return o.result();
}

int buildFallEventJson(char* buf, size_t cap, const char* device_id, const FallEvent& e,
                       uint32_t sent_uptime_ms) {
  JsonOut o(buf, cap);
  o.add("{\"device_id\":\"%s\",\"uptime_ms\":%lu,\"type\":\"fall\",", device_id,
        (unsigned long)e.uptime_ms);
  o.num("peak_g", e.peak_g, 2);
  o.add(",\"freefall_ms\":%lu,", (unsigned long)e.freefall_ms);
  o.num("still_s", e.still_s, 2);
  o.add(",");
  o.zone(e.zone);
  o.add(",\"sent_uptime_ms\":%lu}", (unsigned long)sent_uptime_ms);
  return o.result();
}
