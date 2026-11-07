// Zone beacon for the helmet's indoor location (firmware/config.h: HAS_BLE_BEACONS 1).
//
// Flash one spare ESP32 per zone, set BEACON_ZONE to that zone's id from dashboard/zones.json,
// and put it in the middle of the zone, up high (on a shelf or taped to a wall). It advertises
// the Bluetooth name "WW-<zone>" ten times a second; the helmet picks the strongest one.
// Power it from any USB charger or power bank. Nothing else to wire.

#include <BLEAdvertising.h>
#include <BLEDevice.h>

#define BEACON_ZONE "1520-N"  // change for each beacon: 1520-W, 1520-N, 1520-S, 1520-A, 1522, 1533
#define NAME_PREFIX "WW-"     // must match BEACON_NAME_PREFIX in firmware/config.h
#define BEACON_NAME NAME_PREFIX BEACON_ZONE

// The name has to fit in one advertisement packet (31 bytes, minus flags and headers).
static_assert(sizeof(BEACON_NAME) - 1 <= 26, "BEACON_ZONE is too long for a BLE advertisement");

void setup() {
  Serial.begin(115200);
  BLEDevice::init(BEACON_NAME);

  BLEAdvertisementData data;
  data.setFlags(0x06);       // general discoverable, no classic Bluetooth
  data.setName(BEACON_NAME);  // in the advertisement itself, so a quick scan sees it

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->setAdvertisementData(data);
  adv->setMinInterval(160);  // 160 x 0.625 ms = 100 ms between advertisements
  adv->setMaxInterval(160);
  adv->start();
  Serial.println("Beacon advertising as " BEACON_NAME);
}

void loop() {
  delay(5000);
  Serial.println("Beacon " BEACON_NAME " running");
}
