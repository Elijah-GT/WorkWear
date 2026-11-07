#include "fall_detector.h"

#include <math.h>

FallDetector::FallDetector(const FallConfig& cfg) : cfg_(cfg) {}

void FallDetector::reset() {
  state_ = FallState::IDLE;
  still_running_ = false;
  peak_g_ = 0.0f;
}

const char* FallDetector::stateName(FallState st) {
  switch (st) {
    case FallState::IDLE: return "IDLE";
    case FallState::FREEFALL: return "FREEFALL";
    case FallState::IMPACT: return "IMPACT";
    case FallState::STILL: return "STILL";
    case FallState::ALERT: return "ALERT";
  }
  return "?";
}

// All time differences use unsigned subtraction, so they stay correct when millis() wraps.
FallResult FallDetector::update(const FallSample& s, FallEvent* event) {
  if (isnan(s.accel_g)) return FallResult::NONE;
  const uint32_t t = s.t_ms;

  switch (state_) {
    case FallState::ALERT:
      if (t - alert_t_ < cfg_.cooldown_ms) return FallResult::NONE;
      state_ = FallState::IDLE;
      [[fallthrough]];  // this sample may start a new free-fall

    case FallState::IDLE:
      if (s.accel_g < cfg_.freefall_g) {
        state_ = FallState::FREEFALL;
        freefall_start_ = t;
        worn_at_start_ = s.worn;
        peak_g_ = 0.0f;
      }
      return FallResult::NONE;

    case FallState::FREEFALL:
      if (s.accel_g < cfg_.freefall_g) return FallResult::NONE;
      freefall_ms_ = t - freefall_start_;
      if (freefall_ms_ < cfg_.freefall_min_ms) {
        state_ = FallState::IDLE;  // a dip, not a fall (nodding, a quick step down)
        return FallResult::NONE;
      }
      if (freefall_ms_ > cfg_.freefall_max_ms) {
        state_ = FallState::IDLE;  // seconds near 0 g: a sensor fault, not a fall
        return FallResult::NONE;
      }
      state_ = FallState::IMPACT;
      freefall_end_ = t;
      [[fallthrough]];  // the sample that ends the free-fall is often the impact itself

    case FallState::IMPACT:
      if (s.accel_g > peak_g_) peak_g_ = s.accel_g;
      if (s.accel_g >= cfg_.impact_g) {
        state_ = FallState::STILL;
        impact_t_ = t;
        still_running_ = false;
      } else if (t - freefall_end_ > cfg_.impact_window_ms) {
        state_ = FallState::IDLE;  // free-fall with no impact (caught, set down softly)
      }
      return FallResult::NONE;

    case FallState::STILL: {
      const uint32_t since_impact = t - impact_t_;
      if (since_impact < cfg_.settle_ms) {
        if (s.accel_g > peak_g_) peak_g_ = s.accel_g;  // bounces can be bigger than the first hit
        return FallResult::NONE;
      }
      const bool still = fabsf(s.accel_g - 1.0f) <= cfg_.still_accel_tol_g &&
                         (isnan(s.gyro_dps) || s.gyro_dps <= cfg_.still_gyro_dps);
      const bool tilted = !cfg_.require_tilt || isnan(s.tilt_deg) || s.tilt_deg >= cfg_.min_tilt_deg;

      if (still && tilted) {
        if (!still_running_) {
          still_running_ = true;
          still_start_ = t;
        }
        if (t - still_start_ >= cfg_.still_ms) {
          if (event) {
            event->uptime_ms = t;
            event->peak_g = peak_g_;
            event->freefall_ms = freefall_ms_;
            event->still_s = (t - still_start_) / 1000.0f;
            event->zone[0] = '\0';  // the detector does not know the zone; firmware.ino adds it
          }
          if (!worn_at_start_) {
            state_ = FallState::IDLE;
            return FallResult::SUPPRESSED;
          }
          state_ = FallState::ALERT;
          alert_t_ = t;
          return FallResult::ALERT;
        }
        return FallResult::NONE;  // a still period that began in time may finish after the window
      }

      still_running_ = false;
      if (since_impact - cfg_.settle_ms > cfg_.still_window_ms) {
        state_ = FallState::IDLE;
        return FallResult::RECOVERED;
      }
      return FallResult::NONE;
    }
  }
  return FallResult::NONE;
}
