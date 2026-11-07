// Fall detection state machine. Pure logic, no Arduino calls, so it can be tested on a laptop
// (firmware/test/). Feed it one sample per accelerometer reading.
//
//   IDLE      waiting; total acceleration below FREEFALL_G starts a free-fall
//   FREEFALL  acceleration stays low; too short (< FREEFALL_MIN_MS) goes back to IDLE
//   IMPACT    free-fall ended; waiting up to IMPACT_WINDOW_MS for a spike >= IMPACT_G
//   STILL     impact seen; after POST_IMPACT_SETTLE_MS, waiting for STILL_MS of stillness
//             (about 1 g, little rotation). Movement for STILL_WINDOW_MS = "recovered".
//   ALERT     fall reported; new falls are ignored for ALERT_COOLDOWN_MS
//
// Worn check: the worn flag is latched when the free-fall starts. A helmet that was not worn
// (set down, tossed) gives SUPPRESSED instead of ALERT. A helmet knocked off the head during
// the fall still alerts, because it was worn when the fall began.
#pragma once

#include <stdint.h>

#include "config.h"

struct FallConfig {
  float freefall_g = FREEFALL_G;
  uint32_t freefall_min_ms = FREEFALL_MIN_MS;
  uint32_t freefall_max_ms = FREEFALL_MAX_MS;
  float impact_g = IMPACT_G;
  uint32_t impact_window_ms = IMPACT_WINDOW_MS;
  uint32_t settle_ms = POST_IMPACT_SETTLE_MS;
  float still_accel_tol_g = STILL_ACCEL_TOL_G;
  float still_gyro_dps = STILL_GYRO_DPS;
  uint32_t still_ms = STILL_MS;
  uint32_t still_window_ms = STILL_WINDOW_MS;
  bool require_tilt = REQUIRE_TILT;
  float min_tilt_deg = MIN_TILT_DEG;
  uint32_t cooldown_ms = ALERT_COOLDOWN_MS;
};

struct FallSample {
  uint32_t t_ms;   // millis() when the sample was read
  float accel_g;   // total acceleration magnitude; NAN samples are ignored
  float gyro_dps;  // rotation rate magnitude; NAN = unknown (does not block stillness)
  float tilt_deg;  // 0 upright, 90 on its side; NAN = unknown (does not block the tilt check)
  bool worn;
};

// Matches the fall event in docs/PROTOCOL.md section 2.2.
struct FallEvent {
  uint32_t uptime_ms;    // when the alert fired
  float peak_g;
  uint32_t freefall_ms;
  float still_s;
  char zone[ZONE_ID_MAX + 1];  // where the helmet was (beacons); "" = unknown. Set by the caller.
};

enum class FallState : uint8_t { IDLE, FREEFALL, IMPACT, STILL, ALERT };

enum class FallResult : uint8_t {
  NONE,
  ALERT,       // send a fall event; *event is filled in
  RECOVERED,   // impact seen, then movement resumed: log on the helmet only (not sent)
  SUPPRESSED,  // would have alerted, but the helmet was not worn when the fall started
};

class FallDetector {
 public:
  explicit FallDetector(const FallConfig& cfg = FallConfig());

  // Process one sample. When it returns ALERT or SUPPRESSED, *event holds the fall's details.
  FallResult update(const FallSample& s, FallEvent* event);

  FallState state() const { return state_; }
  static const char* stateName(FallState st);
  void reset();

 private:
  FallConfig cfg_;
  FallState state_ = FallState::IDLE;
  uint32_t freefall_start_ = 0;
  uint32_t freefall_ms_ = 0;
  uint32_t freefall_end_ = 0;
  uint32_t impact_t_ = 0;
  uint32_t still_start_ = 0;
  bool still_running_ = false;
  uint32_t alert_t_ = 0;
  bool worn_at_start_ = true;
  float peak_g_ = 0.0f;
};
