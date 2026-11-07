#include "beacons.h"

#include <string.h>

#include "config.h"

#if HAS_BLE_BEACONS

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEScan.h>

#include "zone_tracker.h"

static ZoneTracker tracker;
static char shared_zone[ZONE_ID_MAX + 1] = "";
static portMUX_TYPE zone_lock = portMUX_INITIALIZER_UNLOCKED;

static void scanTask(void*) {
  BLEScan* scan = BLEDevice::getScan();
  scan->setActiveScan(true);  // also read names sent in scan responses
  scan->setInterval(100);
  scan->setWindow(80);
  char last[ZONE_ID_MAX + 1] = "";
  for (;;) {
    BLEScanResults* found = scan->start(BEACON_SCAN_S, false);  // blocks for the scan
    if (found != nullptr) {
      for (int i = 0; i < found->getCount(); i++) {
        BLEAdvertisedDevice d = found->getDevice(i);
        if (d.haveName()) tracker.heard(d.getName().c_str(), d.getRSSI());
      }
    }
    tracker.endScan(millis());
    scan->clearResults();  // free the results' memory

    portENTER_CRITICAL(&zone_lock);
    strcpy(shared_zone, tracker.zone());
    portEXIT_CRITICAL(&zone_lock);
    if (strcmp(last, tracker.zone()) != 0) {
      Serial.printf("# beacon zone: %s\n", tracker.zone()[0] ? tracker.zone() : "unknown");
      strcpy(last, tracker.zone());
    }
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}

void beaconsBegin() {
  BLEDevice::init("");
  // Same core as Wi-Fi: the ESP32 shares one radio between Wi-Fi and Bluetooth. Wi-Fi modem
  // sleep must stay on (the Arduino default) for the two to work together.
  xTaskCreatePinnedToCore(scanTask, "beacons", 6144, nullptr, 1, nullptr, 0);
  Serial.println("# BLE beacons: scanning for \"" BEACON_NAME_PREFIX "<zone>\"");
}

void beaconZone(char* out, size_t cap) {
  if (cap == 0) return;
  portENTER_CRITICAL(&zone_lock);
  strncpy(out, shared_zone, cap - 1);
  portEXIT_CRITICAL(&zone_lock);
  out[cap - 1] = '\0';
}

#else  // HAS_BLE_BEACONS 0: no Bluetooth code is built at all

void beaconsBegin() {}

void beaconZone(char* out, size_t cap) {
  if (cap > 0) out[0] = '\0';
}

#endif
