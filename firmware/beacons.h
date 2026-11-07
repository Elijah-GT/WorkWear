// BLE zone beacons: scans for beacons on its own FreeRTOS task (core 0) and keeps the current
// zone (zone_tracker.h). Does nothing when HAS_BLE_BEACONS is 0 in config.h.
#pragma once

#include <stddef.h>

void beaconsBegin();                     // start scanning (only with HAS_BLE_BEACONS 1)
void beaconZone(char* out, size_t cap);  // current zone id, or "" if unknown or beacons are off
