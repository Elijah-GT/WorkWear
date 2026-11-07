// Wi-Fi and HTTP, on their own FreeRTOS task (core 0). A slow or failing POST can block for
// up to 3 s; running it here keeps the fall detector in loop() sampling the IMU meanwhile.
#pragma once

#include <stddef.h>

#include "fall_detector.h"
#include "payload.h"

void netBegin();  // connects to Wi-Fi and starts the network task

// Called from loop(): hand over the latest reading. The network task sends it about once
// a second. Telemetry that cannot be sent is dropped, not queued (PROTOCOL.md 2.1).
void netPublishTelemetry(const Telemetry& t);

// Called from loop() when a fall alert fires. The network task sends it right away and
// retries every 2 s until the server answers 200 (PROTOCOL.md 2.2).
void netQueueFall(const FallEvent& e);

bool netWifiConnected();
size_t netPendingFalls();
