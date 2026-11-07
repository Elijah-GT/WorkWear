#include "net.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include "config.h"
#include "event_queue.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copy firmware/secrets.example.h to firmware/secrets.h and fill in the Wi-Fi details."
#endif

static QueueHandle_t fall_inbox;  // loop() -> network task
static portMUX_TYPE telemetry_lock = portMUX_INITIALIZER_UNLOCKED;
static Telemetry latest_telemetry;
static bool have_telemetry = false;
static volatile size_t pending_falls = 0;

void netPublishTelemetry(const Telemetry& t) {
  portENTER_CRITICAL(&telemetry_lock);
  latest_telemetry = t;
  have_telemetry = true;
  portEXIT_CRITICAL(&telemetry_lock);
}

void netQueueFall(const FallEvent& e) {
  // The inbox holds EVENT_QUEUE_SIZE events; the network task empties it every 20 ms.
  if (xQueueSend(fall_inbox, &e, 0) != pdTRUE) {
    Serial.println("# ERROR: fall inbox full, event lost");
  }
}

bool netWifiConnected() { return WiFi.status() == WL_CONNECTED; }

size_t netPendingFalls() { return pending_falls; }

static bool postJson(const char* path, const char* body, int len, int* status) {
  *status = 0;
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(String(SERVER_URL) + path)) return false;
  http.addHeader("Content-Type", "application/json");
  *status = http.POST((uint8_t*)body, (size_t)len);
  http.end();
  return *status == 200;
}

// Sends queued falls oldest first; stops at the first failure so order is kept.
static void sendPendingFalls(EventQueue& pending, char* buf, size_t cap) {
  while (!pending.empty()) {
    const FallEvent& e = pending.front();
    const int len = buildFallEventJson(buf, cap, DEVICE_ID, e, millis());
    int status = 0;
    if (len > 0 && postJson("/api/event", buf, len, &status)) {
      Serial.printf("# fall event sent (uptime_ms %lu)\n", (unsigned long)e.uptime_ms);
      pending.pop();
    } else {
      Serial.printf("# fall event not sent (HTTP %d), retrying in %d s\n", status,
                    EVENT_RETRY_MS / 1000);
      break;
    }
  }
  pending_falls = pending.size();
}

static void networkTask(void*) {
  static char buf[512];
  EventQueue pending;
  uint32_t last_telemetry_ms = 0;
  uint32_t last_retry_ms = 0;
  uint32_t wifi_started_ms = millis();
  bool was_connected = false;

  for (;;) {
    const uint32_t now = millis();

    // Wi-Fi: report changes, and restart the connection if it has been down too long.
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !was_connected) {
      Serial.printf("# Wi-Fi connected, IP %s, server %s\n", WiFi.localIP().toString().c_str(),
                    SERVER_URL);
    } else if (!connected && was_connected) {
      Serial.println("# Wi-Fi lost");
      wifi_started_ms = now;
    } else if (!connected && now - wifi_started_ms >= WIFI_RETRY_MS) {
      Serial.printf("# Wi-Fi: still not connected to \"%s\", retrying\n", WIFI_SSID);
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      wifi_started_ms = now;
    }
    was_connected = connected;

    // Falls first: new ones go out at once, queued ones every EVENT_RETRY_MS.
    bool new_fall = false;
    FallEvent e;
    while (xQueueReceive(fall_inbox, &e, 0) == pdTRUE) {
      if (!pending.push(e)) Serial.println("# WARNING: fall queue full, oldest fall dropped");
      new_fall = true;
    }
    pending_falls = pending.size();
    if (!pending.empty() && (new_fall || now - last_retry_ms >= EVENT_RETRY_MS)) {
      last_retry_ms = now;
      sendPendingFalls(pending, buf, sizeof(buf));
    }

    // Telemetry about once a second; dropped if it cannot be sent.
    if (now - last_telemetry_ms >= TELEMETRY_PERIOD_MS) {
      last_telemetry_ms = now;
      Telemetry t;
      bool have;
      portENTER_CRITICAL(&telemetry_lock);
      t = latest_telemetry;
      have = have_telemetry;
      portEXIT_CRITICAL(&telemetry_lock);
      if (have && connected) {
        const int len = buildTelemetryJson(buf, sizeof(buf), DEVICE_ID, t);
        int status = 0;
        if (len > 0 && !postJson("/api/telemetry", buf, len, &status)) {
          Serial.printf("# telemetry not sent (HTTP %d)\n", status);
        }
      }
    }

    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void netBegin() {
  fall_inbox = xQueueCreate(EVENT_QUEUE_SIZE, sizeof(FallEvent));
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("# Wi-Fi: connecting to \"%s\"\n", WIFI_SSID);
  // loop() runs on core 1, so the network gets core 0 (where the Wi-Fi stack lives).
  xTaskCreatePinnedToCore(networkTask, "net", 8192, nullptr, 1, nullptr, 0);
}
