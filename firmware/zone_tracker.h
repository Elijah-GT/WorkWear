// Which zone the helmet is in, from BLE zone beacons. Pure logic (no Arduino calls), tested on a
// laptop in firmware/test/. beacons.cpp feeds it from the ESP32's Bluetooth scanner.
//
// Each beacon advertises the name BEACON_NAME_PREFIX + zone id, e.g. "WW-1520-N". After each
// scan the tracker averages every beacon's signal strength (RSSI) and picks the strongest zone.
// To stop flicker when a worker stands between two zones, it only moves to a new zone when that
// zone is BEACON_SWITCH_DB stronger for BEACON_SWITCH_SCANS scans in a row. If no beacon has
// been heard for BEACON_LOST_MS, the zone becomes unknown ("") and the server falls back to the
// zone set on the dashboard.
//
// Expect room-level accuracy, not exact positions: RSSI moves around with bodies, walls, and how
// the helmet is turned. Tune the numbers in config.h with the beacons in their real places.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "config.h"

struct ZoneTrackerConfig {
  int min_rssi = BEACON_MIN_RSSI;
  int switch_margin_db = BEACON_SWITCH_DB;
  uint8_t switch_scans = BEACON_SWITCH_SCANS;
  uint32_t lost_ms = BEACON_LOST_MS;
  float smoothing = BEACON_SMOOTHING;
};

class ZoneTracker {
 public:
  static const int kMaxBeacons = 12;

  explicit ZoneTracker(const ZoneTrackerConfig& cfg = ZoneTrackerConfig());

  // During a scan: one advertisement heard. Names without the prefix, or with a zone id that
  // could not be sent safely, are ignored.
  void heard(const char* name, int rssi);

  // After each scan: update the averages and decide the zone.
  void endScan(uint32_t t_ms);

  const char* zone() const { return current_; }  // "" when unknown

  // "WW-1520-N" -> "1520-N". False if the name is not one of our beacons.
  static bool zoneFromName(const char* name, char* out, size_t cap);

 private:
  struct Beacon {
    bool used;
    char zone[ZONE_ID_MAX + 1];
    float avg;          // smoothed RSSI
    int scan_best;      // strongest RSSI in the current scan
    bool in_scan;       // heard in the current scan
    bool fresh;         // no average yet
    uint32_t last_ms;
  };

  Beacon* find(const char* zone);
  const Beacon* findConst(const char* zone) const;
  bool valid(const Beacon* b) const { return b && b->used && !b->fresh && b->avg >= cfg_.min_rssi; }
  void setCurrent(const char* zone);

  ZoneTrackerConfig cfg_;
  Beacon beacons_[kMaxBeacons] = {};
  char current_[ZONE_ID_MAX + 1] = "";
  char challenger_[ZONE_ID_MAX + 1] = "";
  uint8_t challenger_scans_ = 0;
};
