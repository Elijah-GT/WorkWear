#include "zone_tracker.h"

#include <string.h>

#include "payload.h"  // zoneIdOk

ZoneTracker::ZoneTracker(const ZoneTrackerConfig& cfg) : cfg_(cfg) {}

bool ZoneTracker::zoneFromName(const char* name, char* out, size_t cap) {
  const size_t prefix = strlen(BEACON_NAME_PREFIX);
  if (name == nullptr || strncmp(name, BEACON_NAME_PREFIX, prefix) != 0) return false;
  const char* zone = name + prefix;
  if (!zoneIdOk(zone) || strlen(zone) + 1 > cap) return false;
  strcpy(out, zone);
  return true;
}

ZoneTracker::Beacon* ZoneTracker::find(const char* zone) {
  for (Beacon& b : beacons_) {
    if (b.used && strcmp(b.zone, zone) == 0) return &b;
  }
  return nullptr;
}

const ZoneTracker::Beacon* ZoneTracker::findConst(const char* zone) const {
  for (const Beacon& b : beacons_) {
    if (b.used && strcmp(b.zone, zone) == 0) return &b;
  }
  return nullptr;
}

void ZoneTracker::heard(const char* name, int rssi) {
  char zone[ZONE_ID_MAX + 1];
  if (!zoneFromName(name, zone, sizeof(zone))) return;
  Beacon* b = find(zone);
  if (b == nullptr) {
    for (Beacon& slot : beacons_) {
      if (!slot.used) { b = &slot; break; }
    }
    if (b == nullptr) return;  // more beacons than slots: ignore the extra ones
    memset(b, 0, sizeof(*b));
    b->used = true;
    b->fresh = true;
    strcpy(b->zone, zone);
  }
  if (!b->in_scan || rssi > b->scan_best) b->scan_best = rssi;
  b->in_scan = true;
}

void ZoneTracker::setCurrent(const char* zone) {
  strcpy(current_, zone);
  challenger_[0] = '\0';
  challenger_scans_ = 0;
}

void ZoneTracker::endScan(uint32_t t_ms) {
  // Fold this scan into each beacon's average, and forget beacons not heard for a while.
  for (Beacon& b : beacons_) {
    if (!b.used) continue;
    if (b.in_scan) {
      b.avg = b.fresh ? b.scan_best
                      : cfg_.smoothing * b.scan_best + (1.0f - cfg_.smoothing) * b.avg;
      b.fresh = false;
      b.last_ms = t_ms;
      b.in_scan = false;
    } else if (t_ms - b.last_ms > cfg_.lost_ms) {
      b.used = false;
    } else if (!b.fresh) {
      // Missed this scan: count it as a very weak reading, so a beacon that went quiet fades
      // instead of keeping its last (maybe strong) value until it is forgotten.
      b.avg = cfg_.smoothing * (cfg_.min_rssi - 10) + (1.0f - cfg_.smoothing) * b.avg;
    }
  }

  const Beacon* best = nullptr;
  for (const Beacon& b : beacons_) {
    if (valid(&b) && (best == nullptr || b.avg > best->avg)) best = &b;
  }
  const Beacon* cur = current_[0] ? findConst(current_) : nullptr;

  if (best == nullptr) {  // nothing usable heard recently
    setCurrent("");
    return;
  }
  if (!valid(cur)) {  // no zone yet, or the current zone's beacon is gone or too weak
    setCurrent(best->zone);
    return;
  }
  if (best == cur || best->avg < cur->avg + cfg_.switch_margin_db) {
    challenger_[0] = '\0';
    challenger_scans_ = 0;
    return;
  }
  // A clearly stronger zone: move only once it has led for enough scans in a row.
  if (strcmp(challenger_, best->zone) == 0) {
    challenger_scans_++;
  } else {
    strcpy(challenger_, best->zone);
    challenger_scans_ = 1;
  }
  if (challenger_scans_ >= cfg_.switch_scans) setCurrent(best->zone);
}
