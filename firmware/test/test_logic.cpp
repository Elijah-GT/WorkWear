// Laptop tests for the firmware's pure logic: fall detector, heat index, JSON payloads and
// the fall-event queue. No ESP32 needed. Run: firmware/test/run_tests.sh
// These use made-up acceleration traces. Real thresholds must still be tuned from logged
// helmet data (PLAN.md W3).
#include <math.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "../event_queue.h"
#include "../fall_detector.h"
#include "../heat_index.h"
#include "../payload.h"
#include "../zone_tracker.h"

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                     \
  do {                                                                  \
    checks++;                                                           \
    if (!(cond)) {                                                      \
      failures++;                                                       \
      printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                   \
  } while (0)

#define CHECK_NEAR(a, b, tol) CHECK(fabs((double)(a) - (double)(b)) <= (tol))

// ---------------- Trace builder ----------------
// A trace is a list of segments; each holds a constant reading for a number of milliseconds,
// sampled every 5 ms (200 Hz, as configured in config.h).

struct Seg {
  uint32_t ms;
  float accel_g;
  float gyro_dps = 0.0f;
  float tilt_deg = 0.0f;
  bool worn = true;
};

struct RunResult {
  int alerts = 0;
  int recovered = 0;
  int suppressed = 0;
  FallEvent last_event = {};
  uint32_t first_alert_ms = 0;
};

static const uint32_t kStepMs = 5;

static RunResult run(FallDetector& d, const std::vector<Seg>& segs, uint32_t start_ms = 0) {
  RunResult r;
  uint32_t t = start_ms;
  for (const Seg& s : segs) {
    for (uint32_t i = 0; i < s.ms; i += kStepMs) {
      FallEvent ev;
      const FallResult res = d.update({t, s.accel_g, s.gyro_dps, s.tilt_deg, s.worn}, &ev);
      if (res == FallResult::ALERT) {
        if (r.alerts == 0) r.first_alert_ms = t;
        r.alerts++;
        r.last_event = ev;
      } else if (res == FallResult::RECOVERED) {
        r.recovered++;
      } else if (res == FallResult::SUPPRESSED) {
        r.suppressed++;
        r.last_event = ev;
      }
      t += kStepMs;
    }
  }
  return r;
}

// Walking-like motion: alternates between two readings every 50 ms.
static void addWiggle(std::vector<Seg>& v, uint32_t ms, float lo, float hi, float gyro = 60.0f) {
  for (uint32_t i = 0; i < ms; i += 100) {
    v.push_back({50, lo, gyro});
    v.push_back({50, hi, gyro});
  }
}

// A typical staged drop: upright 1 s, 300 ms free-fall (starts at 1000 ms), 5 g impact at
// 1300 ms, bounces, then lying still from 1815 ms.
static const uint32_t kFallImpactMs = 1300;
static const uint32_t kFallStillFromMs = 1815;

static std::vector<Seg> fallTrace(uint32_t still_ms = 3000, float tilt = 80.0f, bool worn = true) {
  return {
      {1000, 1.0f, 2.0f, 5.0f, worn},     // upright, still
      {300, 0.1f, 50.0f, 20.0f, worn},    // free-fall
      {15, 5.0f, 200.0f, 60.0f, worn},    // impact
      {100, 1.8f, 150.0f, 70.0f, worn},   // bounce
      {100, 0.6f, 100.0f, 75.0f, worn},
      {100, 6.2f, 100.0f, 80.0f, worn},   // second hit, bigger than the first
      {200, 1.2f, 40.0f, tilt, worn},
      {still_ms, 1.0f, 3.0f, tilt, worn}, // lying still
  };
}

// ---------------- Fall detector tests ----------------

static void test_standing_still_no_alert() {
  FallDetector d;
  RunResult r = run(d, {{10000, 1.0f, 1.0f, 0.0f}});
  CHECK(r.alerts == 0);
  CHECK(d.state() == FallState::IDLE);
}

static void test_clean_fall_alerts() {
  FallDetector d;
  RunResult r = run(d, fallTrace());
  CHECK(r.alerts == 1);
  CHECK(r.recovered == 0);
  CHECK_NEAR(r.last_event.freefall_ms, 300, kStepMs);
  CHECK_NEAR(r.last_event.peak_g, 6.2f, 0.001);  // a bounce inside the settle time counts
  CHECK_NEAR(r.last_event.still_s, 2.0f, 0.01);
  CHECK_NEAR(r.first_alert_ms, kFallStillFromMs + STILL_MS, kStepMs);
  CHECK(r.last_event.uptime_ms == r.first_alert_ms);
  CHECK(d.state() == FallState::ALERT);
}

static void test_alert_soon_after_landing() {
  // A2: the dashboard must show the fall within about 3 s. The helmet's share is the time
  // from impact to alert; this trace settles quickly, so it should be about 2.5 s.
  FallDetector d;
  RunResult r = run(d, fallTrace());
  CHECK(r.alerts == 1);
  CHECK(r.first_alert_ms - kFallImpactMs <= 2600);
}

static void test_short_freefall_ignored() {
  FallDetector d;
  RunResult r = run(d, {{500, 1.0f}, {50, 0.2f}, {20, 5.0f}, {3000, 1.0f}});
  CHECK(r.alerts == 0);
}

static void test_freefall_without_impact_ignored() {
  // Helmet tossed and caught softly: free-fall, then only 1.3 g.
  FallDetector d;
  RunResult r = run(d, {{500, 1.0f}, {300, 0.1f}, {200, 1.3f}, {3000, 1.0f}});
  CHECK(r.alerts == 0);
  CHECK(d.state() == FallState::IDLE);
}

static void test_impact_late_after_freefall_ignored() {
  // The spike comes 800 ms after free-fall ended: outside IMPACT_WINDOW_MS (500 ms).
  FallDetector d;
  RunResult r = run(d, {{500, 1.0f}, {300, 0.1f}, {800, 1.0f}, {20, 5.0f}, {3000, 1.0f}});
  CHECK(r.alerts == 0);
}

static void test_impact_without_freefall_ignored() {
  // A knock on the helmet (bumping a beam) with no free-fall first.
  FallDetector d;
  RunResult r = run(d, {{500, 1.0f}, {20, 6.0f}, {3000, 1.0f}});
  CHECK(r.alerts == 0);
}

static void test_movement_after_impact_recovers() {
  FallDetector d;
  std::vector<Seg> v = {{1000, 1.0f}, {300, 0.1f}, {15, 5.0f}};
  addWiggle(v, 10000, 0.7f, 1.4f);  // gets up and walks away
  RunResult r = run(d, v);
  CHECK(r.alerts == 0);
  CHECK(r.recovered == 1);
  CHECK(d.state() == FallState::IDLE);
}

static void test_rotation_blocks_stillness() {
  // About 1 g but turning fast (rolling over): not still, so no alert.
  FallDetector d;
  RunResult r = run(d, {{1000, 1.0f}, {300, 0.1f}, {15, 5.0f}, {10000, 1.0f, 120.0f}});
  CHECK(r.alerts == 0);
  CHECK(r.recovered == 1);
}

static void test_interrupted_stillness_restarts_count() {
  // Still for about 1.6 s, moves, then still again: the 2 s count starts over.
  FallDetector d;
  RunResult r = run(d, {{1000, 1.0f}, {300, 0.1f}, {15, 5.0f}, {600, 1.0f, 5.0f},
                        {1500, 1.0f, 5.0f}, {100, 1.6f, 90.0f}, {2500, 1.0f, 5.0f}});
  CHECK(r.alerts == 1);
  CHECK_NEAR(r.last_event.still_s, 2.0f, 0.01);
}

static void test_stillness_started_late_in_window_completes() {
  // Moving for about 7.5 s after settling, then still: the still period begins inside the
  // 8 s window and finishes after it. That is still a fall.
  FallDetector d;
  std::vector<Seg> v = {{1000, 1.0f}, {300, 0.1f}, {15, 5.0f}, {500, 1.0f, 100.0f}};
  addWiggle(v, 7500, 0.8f, 1.3f);
  v.push_back({3000, 1.0f, 2.0f});
  RunResult r = run(d, v);
  CHECK(r.alerts == 1);
  CHECK(r.recovered == 0);
}

static void test_not_worn_at_start_suppressed() {
  FallDetector d;
  RunResult r = run(d, fallTrace(3000, 80.0f, false));
  CHECK(r.alerts == 0);
  CHECK(r.suppressed == 1);
  CHECK(d.state() == FallState::IDLE);
}

static void test_knocked_off_during_fall_still_alerts() {
  // Worn when the fall starts; the worn sensor opens mid-fall as the helmet comes off.
  FallDetector d;
  std::vector<Seg> v = fallTrace();
  for (size_t i = 2; i < v.size(); i++) v[i].worn = false;
  RunResult r = run(d, v);
  CHECK(r.alerts == 1);
  CHECK(r.suppressed == 0);
}

static void test_cooldown_then_second_fall() {
  FallDetector d;
  std::vector<Seg> v = fallTrace();
  // A second drop right after the first alert: inside the 10 s cooldown, ignored.
  std::vector<Seg> again = fallTrace();
  v.insert(v.end(), again.begin(), again.end());
  // Wait out the cooldown and drop a third time: alerts again.
  v.push_back({10000, 1.0f});
  std::vector<Seg> third = fallTrace();
  v.insert(v.end(), third.begin(), third.end());
  RunResult r = run(d, v);
  CHECK(r.alerts == 2);
}

static void test_require_tilt() {
  FallConfig cfg;
  cfg.require_tilt = true;
  cfg.min_tilt_deg = 45.0f;
  {
    FallDetector d(cfg);
    RunResult r = run(d, fallTrace(3000, 5.0f));  // ends upright
    CHECK(r.alerts == 0);
  }
  {
    FallDetector d(cfg);
    RunResult r = run(d, fallTrace(3000, 85.0f));  // ends on its side
    CHECK(r.alerts == 1);
  }
}

static void test_tilt_ignored_by_default() {
  FallDetector d;  // REQUIRE_TILT is 0 in config.h
  RunResult r = run(d, fallTrace(3000, 5.0f));
  CHECK(r.alerts == 1);
}

static void test_made_up_normal_activity_no_alerts() {
  // Made-up stand-ins for A3 activities (nodding, looking down, walking, a quick step down,
  // sitting down hard). Real A3 trials on the helmet are still needed.
  FallDetector d;
  std::vector<Seg> v = {{2000, 1.0f}};
  addWiggle(v, 5000, 0.85f, 1.2f, 80.0f);  // nodding
  v.push_back({3000, 1.0f, 1.0f, 70.0f});   // looking down, still
  addWiggle(v, 10000, 0.6f, 1.6f);          // walking
  v.push_back({80, 0.3f});                  // quick step down: brief low-g dip
  v.push_back({30, 2.2f});                  // landing, below the impact threshold
  addWiggle(v, 3000, 0.7f, 1.4f);
  v.push_back({60, 0.5f});
  v.push_back({40, 1.9f});                  // sitting down hard
  v.push_back({5000, 1.0f, 2.0f});
  RunResult r = run(d, v);
  CHECK(r.alerts == 0);
}

static void test_nan_samples_ignored() {
  FallDetector d;
  std::vector<Seg> v = fallTrace();
  v.insert(v.begin() + 1, Seg{100, NAN});  // dropped readings just before the fall
  RunResult r = run(d, v);
  CHECK(r.alerts == 1);
}

static void test_missing_gyro_does_not_block_alert() {
  FallDetector d;
  std::vector<Seg> v = fallTrace();
  for (Seg& s : v) s.gyro_dps = NAN;
  RunResult r = run(d, v);
  CHECK(r.alerts == 1);
}

static void test_stuck_at_zero_g_is_not_a_fall() {
  FallDetector d;
  RunResult r = run(d, {{500, 1.0f}, {5000, 0.0f}, {20, 5.0f}, {3000, 1.0f}});
  CHECK(r.alerts == 0);
}

static void test_millis_wraparound() {
  FallDetector d;
  // Start 1.2 s before millis() wraps to 0, so the fall straddles the wrap.
  RunResult r = run(d, fallTrace(), 0xFFFFFFFFu - 1200u);
  CHECK(r.alerts == 1);
  CHECK_NEAR(r.last_event.freefall_ms, 300, kStepMs);
}

// ---------------- Heat index ----------------

static void test_heat_index_matches_simulator() {
  // Reference values from heat_index_c() in server/simulator.py (rounded to 4 places).
  struct Case { float t, rh; double expected; } cases[] = {
      {20, 50, 19.3611}, {25, 40, 24.6},    {30, 40, 29.6892}, {30, 70, 35.038},
      {35, 50, 40.6754}, {38, 10, 34.727},  {29, 90, 37.2312}, {45, 60, 85.6115},
      {32.5f, 55.5f, 36.8515},
  };
  for (const Case& c : cases) CHECK_NEAR(heatIndexC(c.t, c.rh), c.expected, 0.01);
  CHECK(isnan(heatIndexC(NAN, 50)));
  CHECK(isnan(heatIndexC(30, NAN)));
}

// ---------------- Payloads ----------------

static void test_telemetry_json_full() {
  Telemetry t;
  t.uptime_ms = 123456;
  t.worn = true;
  t.temp_c = 29.4f;
  t.humidity_pct = 41.0f;
  t.pressure_hpa = 1009.2f;
  t.heat_index_c = 30.1f;
  t.accel_g = 1.01f;
  t.tilt_deg = 12.0f;
  t.gps_fix = true;
  t.lat = 37.123456;
  t.lon = -122.654321;
  char buf[512];
  const int n = buildTelemetryJson(buf, sizeof(buf), "helmet-01", t);
  const char* expected =
      "{\"device_id\":\"helmet-01\",\"uptime_ms\":123456,\"worn\":true,\"temp_c\":29.40,"
      "\"humidity_pct\":41.0,\"pressure_hpa\":1009.20,\"heat_index_c\":30.10,"
      "\"accel_g\":1.010,\"tilt_deg\":12.0,\"zone\":null,\"gps_fix\":true,"
      "\"lat\":37.123456,\"lon\":-122.654321}";
  CHECK(n == (int)strlen(expected));
  CHECK(strcmp(buf, expected) == 0);
  if (strcmp(buf, expected) != 0) printf("  got: %s\n", buf);
}

static void test_telemetry_json_drop_check() {
  Telemetry t;  // readings NAN; a drop check present
  t.uptime_ms = 5000;
  t.has_drop_check = true;
  t.drop_uptime_ms = 4200;
  t.drop_freefall_ms = 43;
  t.drop_min_g = 0.2f;
  t.drop_peak_g = 1.41f;
  t.drop_need_ms = 100;
  t.drop_need_g = 2.5f;
  char buf[512];
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-01", t) > 0);
  const char* tail =
      ",\"lon\":null,\"drop_check\":{\"uptime_ms\":4200,\"freefall_ms\":43,\"min_g\":0.20,"
      "\"peak_g\":1.41,\"freefall_need_ms\":100,\"impact_need_g\":2.5}}";
  const size_t len = strlen(buf), tl = strlen(tail);
  CHECK(len > tl && strcmp(buf + len - tl, tail) == 0);
  if (!(len > tl && strcmp(buf + len - tl, tail) == 0)) printf("  got: %s\n", buf);
}

static void test_telemetry_json_missing_values_are_null() {
  Telemetry t;  // every reading NAN, no fix
  t.uptime_ms = 5;
  t.worn = false;
  t.lat = 37.0;  // must not be sent without a fix
  t.lon = -122.0;
  char buf[512];
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-02", t) > 0);
  const char* expected =
      "{\"device_id\":\"helmet-02\",\"uptime_ms\":5,\"worn\":false,\"temp_c\":null,"
      "\"humidity_pct\":null,\"pressure_hpa\":null,\"heat_index_c\":null,"
      "\"accel_g\":null,\"tilt_deg\":null,\"zone\":null,\"gps_fix\":false,"
      "\"lat\":null,\"lon\":null}";
  CHECK(strcmp(buf, expected) == 0);
  if (strcmp(buf, expected) != 0) printf("  got: %s\n", buf);
}

static void test_fall_event_json() {
  FallEvent e = {123999, 4.2f, 220, 2.1f, ""};
  char buf[256];
  CHECK(buildFallEventJson(buf, sizeof(buf), "helmet-01", e, 126000) > 0);
  const char* expected =
      "{\"device_id\":\"helmet-01\",\"uptime_ms\":123999,\"type\":\"fall\",\"peak_g\":4.20,"
      "\"freefall_ms\":220,\"still_s\":2.10,\"zone\":null,\"sent_uptime_ms\":126000}";
  CHECK(strcmp(buf, expected) == 0);
  if (strcmp(buf, expected) != 0) printf("  got: %s\n", buf);
}

static void test_json_too_small_buffer() {
  Telemetry t;
  char buf[40];
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-01", t) == -1);
  FallEvent e = {1, 3.0f, 150, 2.0f, ""};
  CHECK(buildFallEventJson(buf, sizeof(buf), "helmet-01", e, 1) == -1);
  CHECK(buildFallEventJson(buf, 0, "helmet-01", e, 1) == -1);
}

static void test_telemetry_fits_firmware_buffer() {
  // net.cpp uses a 512-byte buffer; the longest realistic message must fit.
  Telemetry t;
  t.uptime_ms = 4294967295u;
  t.temp_c = -40.0f;
  t.humidity_pct = 100.0f;
  t.pressure_hpa = 1100.0f;
  t.heat_index_c = 85.6f;
  t.accel_g = 8.0f;
  t.tilt_deg = 180.0f;
  t.gps_fix = true;
  t.lat = -89.999999;
  t.lon = -179.999999;
  char buf[512];
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-99", t) > 0);
}

// ---------------- Event queue ----------------

static void test_event_queue_order_and_overflow() {
  EventQueue q;
  CHECK(q.empty());
  for (uint32_t i = 1; i <= EVENT_QUEUE_SIZE; i++) CHECK(q.push({i, 3.0f, 100, 2.0f, ""}));
  CHECK(q.size() == EVENT_QUEUE_SIZE);
  CHECK(!q.push({99, 3.0f, 100, 2.0f, ""}));  // full: the oldest (1) is dropped
  CHECK(q.dropped() == 1);
  CHECK(q.front().uptime_ms == 2);
  std::vector<uint32_t> order;
  while (!q.empty()) {
    order.push_back(q.front().uptime_ms);
    q.pop();
  }
  CHECK(order.size() == EVENT_QUEUE_SIZE);
  CHECK(order.back() == 99);
  q.pop();  // popping an empty queue is harmless
  CHECK(q.empty());
}

// ---------------- Zone from BLE beacons ----------------

struct Heard {
  const char* name;
  int rssi;
};

static void scan(ZoneTracker& z, uint32_t t, std::vector<Heard> heard) {
  for (const Heard& h : heard) z.heard(h.name, h.rssi);
  z.endScan(t);
}

static void test_zone_from_beacon_name() {
  char out[ZONE_ID_MAX + 1];
  CHECK(ZoneTracker::zoneFromName("WW-1520-N", out, sizeof(out)) && strcmp(out, "1520-N") == 0);
  CHECK(!ZoneTracker::zoneFromName("XX-1520-N", out, sizeof(out)));  // not our prefix
  CHECK(!ZoneTracker::zoneFromName("WW-", out, sizeof(out)));        // no zone
  CHECK(!ZoneTracker::zoneFromName("WW-a b", out, sizeof(out)));     // space not allowed
  CHECK(!ZoneTracker::zoneFromName("WW-a\"b", out, sizeof(out)));    // would break the JSON
  CHECK(!ZoneTracker::zoneFromName(nullptr, out, sizeof(out)));
  std::string max32 = "WW-" + std::string(32, 'z');
  std::string too_long = "WW-" + std::string(33, 'z');
  CHECK(ZoneTracker::zoneFromName(max32.c_str(), out, sizeof(out)));
  CHECK(!ZoneTracker::zoneFromName(too_long.c_str(), out, sizeof(out)));
}

static void test_tracker_picks_the_strongest_beacon() {
  ZoneTracker z;
  CHECK(strcmp(z.zone(), "") == 0);
  scan(z, 1000, {{"WW-A", -60}, {"WW-B", -70}, {"Someone's phone", -30}});
  CHECK(strcmp(z.zone(), "A") == 0);
}

static void test_tracker_ignores_weak_beacons() {
  ZoneTracker z;
  scan(z, 1000, {{"WW-A", -95}});  // below BEACON_MIN_RSSI (-90)
  CHECK(strcmp(z.zone(), "") == 0);
}

static void test_tracker_needs_a_clear_lead_for_two_scans() {
  ZoneTracker z;
  scan(z, 1000, {{"WW-A", -60}, {"WW-B", -80}});
  CHECK(strcmp(z.zone(), "A") == 0);
  scan(z, 2000, {{"WW-A", -80}, {"WW-B", -55}});  // averages A -70, B -67.5: not 6 dB ahead
  CHECK(strcmp(z.zone(), "A") == 0);
  scan(z, 3000, {{"WW-A", -80}, {"WW-B", -55}});  // B clearly ahead: first scan
  CHECK(strcmp(z.zone(), "A") == 0);
  scan(z, 4000, {{"WW-A", -80}, {"WW-B", -55}});  // second scan in a row: move
  CHECK(strcmp(z.zone(), "B") == 0);
}

static void test_tracker_ignores_a_one_scan_blip() {
  ZoneTracker z;
  scan(z, 1000, {{"WW-A", -60}});
  scan(z, 2000, {{"WW-A", -60}, {"WW-B", -40}});  // B spikes once (someone walks past with it)
  scan(z, 3000, {{"WW-A", -60}});                 // and is gone again
  scan(z, 4000, {{"WW-A", -60}});
  CHECK(strcmp(z.zone(), "A") == 0);
}

static void test_tracker_moves_when_the_current_beacon_fades() {
  ZoneTracker z;
  scan(z, 1000, {{"WW-A", -60}});
  for (uint32_t t = 2000; t <= 5000; t += 1000) scan(z, t, {{"WW-B", -85}});  // walked away from A
  CHECK(strcmp(z.zone(), "B") == 0);
}

static void test_tracker_zone_unknown_when_no_beacons() {
  ZoneTracker z;
  scan(z, 1000, {{"WW-A", -60}});
  for (uint32_t t = 2000; t <= 4000; t += 1000) scan(z, t, {});
  CHECK(strcmp(z.zone(), "") == 0);  // faded below the minimum: the server falls back
  scan(z, 20000, {});                // long gone: forgotten
  scan(z, 21000, {{"WW-B", -70}});
  CHECK(strcmp(z.zone(), "B") == 0);
}

static void test_tracker_handles_more_beacons_than_slots() {
  ZoneTracker z;
  std::vector<std::string> names;
  for (int i = 0; i < ZoneTracker::kMaxBeacons + 2; i++) names.push_back("WW-Z" + std::to_string(i));
  std::vector<Heard> heard;
  for (size_t i = 0; i < names.size(); i++) heard.push_back({names[i].c_str(), -80 + (int)i});
  scan(z, 1000, heard);
  CHECK(strcmp(z.zone(), "Z11") == 0);  // the two extra beacons were ignored, not crashed on
}

static void test_payloads_carry_the_beacon_zone() {
  char buf[512];
  Telemetry t;
  t.uptime_ms = 5;
  strcpy(t.zone, "1520-N");
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-01", t) > 0);
  CHECK(strstr(buf, "\"zone\":\"1520-N\"") != nullptr);
  strcpy(t.zone, "bad\"zone");
  CHECK(buildTelemetryJson(buf, sizeof(buf), "helmet-01", t) > 0);
  CHECK(strstr(buf, "\"zone\":null") != nullptr);

  FallEvent e = {123999, 4.2f, 220, 2.1f, "1522"};
  CHECK(buildFallEventJson(buf, sizeof(buf), "helmet-01", e, 123999) > 0);
  CHECK(strstr(buf, "\"zone\":\"1522\"") != nullptr);
}

static void test_detector_clears_the_event_zone() {
  FallDetector d;
  FallEvent ev;
  memset(&ev, 'x', sizeof(ev));  // garbage, like an uninitialised local
  uint32_t t = 0;
  for (const Seg& s : fallTrace()) {
    for (uint32_t i = 0; i < s.ms; i += kStepMs, t += kStepMs) {
      if (d.update({t, s.accel_g, s.gyro_dps, s.tilt_deg, s.worn}, &ev) == FallResult::ALERT) {
        CHECK(ev.zone[0] == '\0');
        return;
      }
    }
  }
  CHECK(false);  // the trace should have alerted
}

int main() {
  struct Test { const char* name; void (*fn)(); } tests[] = {
      {"zone from beacon name", test_zone_from_beacon_name},
      {"tracker picks the strongest beacon", test_tracker_picks_the_strongest_beacon},
      {"tracker ignores weak beacons", test_tracker_ignores_weak_beacons},
      {"tracker needs a clear lead for 2 scans", test_tracker_needs_a_clear_lead_for_two_scans},
      {"tracker ignores a one-scan blip", test_tracker_ignores_a_one_scan_blip},
      {"tracker moves when current fades", test_tracker_moves_when_the_current_beacon_fades},
      {"zone unknown with no beacons", test_tracker_zone_unknown_when_no_beacons},
      {"more beacons than slots", test_tracker_handles_more_beacons_than_slots},
      {"payloads carry the beacon zone", test_payloads_carry_the_beacon_zone},
      {"detector clears the event zone", test_detector_clears_the_event_zone},
      {"standing still: no alert", test_standing_still_no_alert},
      {"clean fall alerts", test_clean_fall_alerts},
      {"alert soon after landing", test_alert_soon_after_landing},
      {"short free-fall ignored", test_short_freefall_ignored},
      {"free-fall without impact ignored", test_freefall_without_impact_ignored},
      {"late impact ignored", test_impact_late_after_freefall_ignored},
      {"impact without free-fall ignored", test_impact_without_freefall_ignored},
      {"movement after impact recovers", test_movement_after_impact_recovers},
      {"rotation blocks stillness", test_rotation_blocks_stillness},
      {"interrupted stillness restarts", test_interrupted_stillness_restarts_count},
      {"late stillness still completes", test_stillness_started_late_in_window_completes},
      {"not worn at start: suppressed", test_not_worn_at_start_suppressed},
      {"knocked off mid-fall: alerts", test_knocked_off_during_fall_still_alerts},
      {"cooldown, then second fall", test_cooldown_then_second_fall},
      {"require tilt option", test_require_tilt},
      {"tilt ignored by default", test_tilt_ignored_by_default},
      {"made-up normal activity: no alerts", test_made_up_normal_activity_no_alerts},
      {"NAN samples ignored", test_nan_samples_ignored},
      {"missing gyro does not block", test_missing_gyro_does_not_block_alert},
      {"stuck at 0 g is not a fall", test_stuck_at_zero_g_is_not_a_fall},
      {"millis() wraparound", test_millis_wraparound},
      {"heat index matches simulator", test_heat_index_matches_simulator},
      {"telemetry JSON", test_telemetry_json_full},
      {"telemetry JSON with a drop check", test_telemetry_json_drop_check},
      {"telemetry JSON nulls", test_telemetry_json_missing_values_are_null},
      {"fall event JSON", test_fall_event_json},
      {"JSON buffer too small", test_json_too_small_buffer},
      {"telemetry fits 512 bytes", test_telemetry_fits_firmware_buffer},
      {"event queue", test_event_queue_order_and_overflow},
  };
  for (const Test& t : tests) {
    const int before = failures;
    t.fn();
    printf("%s %s\n", failures == before ? "ok  " : "FAIL", t.name);
  }
  printf("\n%d tests, %d checks, %d failed checks\n", (int)(sizeof(tests) / sizeof(tests[0])),
         checks, failures);
  return failures == 0 ? 0 : 1;
}
