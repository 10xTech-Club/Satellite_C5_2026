/*
 * SATCOM ALPHA - Satellite Command Center (ESP32 Version)
 *
 * Board: ESP32 Dev Module
 *
 * GPIO PINOUT:
 *   GPIO 21      → I2C SDA (MPU6050)
 *   GPIO 22      → I2C SCL (MPU6050)
 *   GPIO 4       → DHT11 (Temperature/Humidity)
 *   GPIO 13      → NeoPixel Strip 1 — 6 LEDs
 *   GPIO 14      → NeoPixel Strip 2 — 6 LEDs
 *   GPIO 26      → NeoPixel Strip 3 — 6 LEDs
 *   GPIO 25      → NeoPixel Strip 4 — 6 LEDs
 *   GPIO 18      → Servo A (Solar Flap A)
 *   GPIO 19      → Servo B (Solar Flap B)
 *   GPIO 34      → Battery Voltage (ADC, input-only)
 *   GPIO 35      → Solar Voltage  (ADC, input-only)
 *   GPIO 2       → Built-in LED
 *
 * Note: All 4 NeoPixel strips are physical (6 LEDs each = 24 total).
 *       Servos A & B support toggle (open/close) and direct angle control.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <ESPAsyncWebServer.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_NeoPixel.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <ArduinoOTA.h>
#include <esp_now.h>            // ESP-NOW replaces WebSocket client link to hexapod
#include <esp_idf_version.h>    // for ESP_IDF_VERSION_MAJOR check

// ============================================================
// CONFIGURATION
// ============================================================

const char* AP_SSID = "SATCOM-ALPHA";
const char* AP_PASSWORD = "satellite2025";
IPAddress local_IP(192, 168, 4, 1);
IPAddress gateway(192, 168, 4, 1);
IPAddress subnet(255, 255, 255, 0);

// Pin Definitions (ESP32)
#define DHT_PIN       4
#define DHT_TYPE      DHT11
#define NEOPIXEL1_PIN 13   // GPIO 13
#define NEOPIXEL2_PIN 14   // GPIO 14
#define NEOPIXEL3_PIN 26   // GPIO 26
#define NEOPIXEL4_PIN 25   // GPIO 25
#define SERVO1_PIN    18   // GPIO 18 — Flap A
#define SERVO2_PIN    19   // GPIO 19 — Flap B
#define BATTERY_PIN   34   // ADC1_CH6 (input-only)
#define SOLAR_PIN     35   // ADC1_CH7 (input-only)
#define I2C_SDA       21
#define I2C_SCL       22
#define LED_PIN       2    // Active HIGH on most ESP32 dev boards

// NeoPixel Configuration — 4 physical strips, 6 LEDs each
#define NEOPIXEL_COUNT 6

// ============================================================
// OBJECTS
// ============================================================

DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_MPU6050 mpu;

// 4 physical strips, 6 LEDs each
Adafruit_NeoPixel strip1(NEOPIXEL_COUNT, NEOPIXEL1_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel strip2(NEOPIXEL_COUNT, NEOPIXEL2_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel strip3(NEOPIXEL_COUNT, NEOPIXEL3_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel strip4(NEOPIXEL_COUNT, NEOPIXEL4_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel* strips[4] = { &strip1, &strip2, &strip3, &strip4 };

Servo servoA;
Servo servoB;

int servoAAngle = 90;
int servoBAngle = 90;

AsyncWebServer server(80);
AsyncWebSocket ws("/ws");

// ============================================================
// GLOBAL VARIABLES
// ============================================================

struct NeoPixelState {
    bool power;
    uint8_t r, g, b;
    uint8_t brightness;
};
NeoPixelState neoState[4] = {
    { true, 0, 242, 255, 128 },
    { true, 0, 242, 255, 128 },
    { true, 0, 242, 255, 128 },
    { true, 0, 242, 255, 128 }
};

bool flapAOpen = true;
bool flapBOpen = true;

struct SatelliteData {
    float temperature = 0.0;
    float humidity = 0.0;
    float batteryVoltage = 0.0;
    float batteryPercent = 0.0;
    float solarVoltage = 0.0;
    float pitch = 0.0;
    float roll = 0.0;
    float yaw = 0.0;
    float gx = 0.0;
    float gy = 0.0;
    float gz = 0.0;
    float signalStrength = 0.0;
    bool systemOK = true;
    unsigned long uptime = 0;
    int connectedClients = 0;
} satData;

struct ClientInfo {
    uint32_t id;
    String type;
    bool connected;
    unsigned long lastSeen;
};

std::vector<ClientInfo> clients;

unsigned long lastTelemetryUpdate = 0;
unsigned long lastBroadcast = 0;
const unsigned long TELEMETRY_INTERVAL = 1000;
const unsigned long BROADCAST_INTERVAL = 500;

bool mpuInitialized = false;
bool dhtInitialized = false;

// Soft-reset support — HTTP handler sets the flag; loop() calls ESP.restart()
// after a short delay so the HTTP response is fully sent first.
static bool          pendingReset    = false;
static unsigned long resetRequestedAt = 0;

// ─── ESP-NOW: Multi-device ↔ Satellite backhaul ───────────────────────────
// Message type tags — must match all device firmware.
#define ESPNOW_MSG_TELEMETRY  0x01   // device → satellite
#define ESPNOW_MSG_COMMAND    0x02   // satellite → device
#define ESPNOW_MSG_CHAT       0x03   // bidirectional
// Device-type tags — sent as telemetry[1] so satellite can route correctly.
#define ESPNOW_DEVICE_HEXAPOD 0x01
#define ESPNOW_DEVICE_ROVER   0x02

struct __attribute__((packed)) EspNowTelemetry {
  uint8_t  msgType;
  uint8_t  deviceType;   // ESPNOW_DEVICE_HEXAPOD
  float    temp;
  float    hum;
  int16_t  gas;
  int16_t  aqi;
  int16_t  co2;
  int8_t   rssi;
  uint8_t  walking;
  uint8_t  step;
  uint8_t  clients;
  int8_t   legs[6];   // coxa angle offset from 90°
};  // 26 bytes

struct __attribute__((packed)) EspNowRoverTelemetry {
  uint8_t  msgType;
  uint8_t  deviceType;   // ESPNOW_DEVICE_ROVER
  int16_t  ultra;
  float    temp;
  float    hum;
  uint16_t ldr;
  uint16_t gas;
  uint16_t hall;
  uint8_t  mode;
  uint8_t  motion;
  uint8_t  obstacle;
  uint8_t  forwardBlocked;
  int16_t  armBase;
  int16_t  armJoint;
  uint8_t  armPose;
};  // 27 bytes

struct __attribute__((packed)) EspNowCommand {
  uint8_t  msgType;
  char     cmd[16];   // "forward" / "backward" / "left" / "right" / "stop"
};  // 17 bytes

struct __attribute__((packed)) EspNowChat {
  uint8_t  msgType;
  char     from[16];
  char     msg[64];
};  // 81 bytes

// Broadcast MAC — fallback before device real MACs are learned.
static uint8_t hexMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// Hexapod's actual AP MAC — learned from the first incoming telemetry packet.
// Sending to a unicast MAC is far more reliable on ESP8266 than sending to
// broadcast, which the ESP8266 recv callback may silently ignore.
static uint8_t       hexapodActualMac[6] = {0,0,0,0,0,0};
static volatile bool hexapodMacKnown     = false;
static volatile bool pendingAddHexPeer   = false;

// Rover's actual AP MAC — learned from the first incoming rover telemetry.
static uint8_t       roverActualMac[6]    = {0,0,0,0,0,0};
static volatile bool roverMacKnown        = false;
static volatile bool pendingAddRoverPeer  = false;

// Pending telemetry relay — set in ESP-NOW recv callback (WiFi task),
// consumed in loop() where ws.textAll() is safe to call.
static volatile bool pendingHexTelemetry   = false;
static char          hexTelemetryJson[320] = "";
static volatile bool pendingRoverTelemetry  = false;
static char          roverTelemetryJson[320] = "";

// ============================================================
// FUNCTION DECLARATIONS
// ============================================================

void initWiFi();
void initSensors();
void initNeoPixels();
void initServos();
void initWebServer();
void initEspNow();
void sendCommandEspNow(const char* cmd);
void sendChatEspNow(const char* from, const char* msg);
void sendRoverCommandEspNow(const char* cmd);
void sendRoverChatEspNow(const char* from, const char* msg);
void initFileSystem();
void updateTelemetry();
void broadcastTelemetry();
void handleWebSocketMessage(void *arg, uint8_t *data, size_t len, AsyncWebSocketClient *client);
void onWebSocketEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
                      AwsEventType type, void *arg, uint8_t *data, size_t len);
String getSystemStatus();
void applyNeoPixel(int stripIndex);
void applyAllNeoPixels();
void handleNeoPixelCommand(JsonDocument& doc);
void handleFlapCommand(JsonDocument& doc);
void handleServoAngle(JsonDocument& doc);

// ============================================================
// SETUP
// ============================================================

void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n========================================");
    Serial.println("  SATCOM ALPHA - Satellite Hub (ESP32)");
    Serial.println("========================================\n");

    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);  // LED on (active HIGH on ESP32)

    Wire.begin(I2C_SDA, I2C_SCL);

    initFileSystem();
    initWiFi();
    initSensors();
    initNeoPixels();
    initServos();
    initWebServer();
    initEspNow();   // must come after initWiFi() so the AP channel is set

    // ── OTA (Over-the-Air) firmware update ──────────────────────
    ArduinoOTA.setHostname("SATCOM-ALPHA");
    ArduinoOTA.setPassword("satellite2025");
    ArduinoOTA.onStart([]()  { Serial.println("[OTA] Starting update..."); });
    ArduinoOTA.onEnd([]()    { Serial.println("\n[OTA] Done. Rebooting..."); });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
        Serial.printf("[OTA] %u%%\r", progress * 100 / total);
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.printf("[OTA] Error[%u]\n", error);
    });
    ArduinoOTA.begin();
    Serial.println("OTA ready — hostname: SATCOM-ALPHA  password: satellite2025");

    Serial.println("\n========================================");
    Serial.println("  System Ready!");
    Serial.println("  Dashboard: http://192.168.4.1");
    Serial.println("========================================\n");

    digitalWrite(LED_PIN, LOW);  // LED off
}

// ============================================================
// MAIN LOOP
// ============================================================

void loop() {
    ArduinoOTA.handle();

    // ── Deferred soft reset ────────────────────────────────────────────────────
    // The /api/reset handler sets the flag. We wait 500 ms so the HTTP response
    // is fully transmitted before the chip restarts.
    if (pendingReset && millis() - resetRequestedAt > 500) {
        Serial.println("[RESET] Soft reset triggered — restarting now.");
        ESP.restart();
    }

    unsigned long currentMillis = millis();

    if (currentMillis - lastTelemetryUpdate >= TELEMETRY_INTERVAL) {
        lastTelemetryUpdate = currentMillis;
        updateTelemetry();
    }

    if (currentMillis - lastBroadcast >= BROADCAST_INTERVAL) {
        lastBroadcast = currentMillis;
        broadcastTelemetry();
    }

    ws.cleanupClients();

    // ── Relay hexapod ESP-NOW telemetry → dashboard browsers ──────────────────
    // pendingHexTelemetry is set by onEspNowRecv (WiFi task).
    // ws.textAll() must be called from the main task (here), not from the callback.
    if (pendingHexTelemetry) {
        pendingHexTelemetry = false;
        if (ws.count() > 0) ws.textAll(hexTelemetryJson);
    }

    // ── Register hexapod unicast peer once its AP MAC is learned ──────────────
    // esp_now_add_peer() must be called from the main task, not from the
    // WiFi-task recv callback — so we defer it here via a flag.
    if (pendingAddHexPeer && !hexapodMacKnown) {
        pendingAddHexPeer = false;
        esp_now_peer_info_t peer = {};
        memcpy(peer.peer_addr, hexapodActualMac, 6);
        peer.channel = 0;
        peer.ifidx   = WIFI_IF_AP;
        peer.encrypt = false;
        if (esp_now_add_peer(&peer) == ESP_OK) {
            hexapodMacKnown = true;
            Serial.printf("[ESP-NOW] Hexapod MAC learned: %02X:%02X:%02X:%02X:%02X:%02X\n",
                hexapodActualMac[0], hexapodActualMac[1], hexapodActualMac[2],
                hexapodActualMac[3], hexapodActualMac[4], hexapodActualMac[5]);
        } else {
            Serial.println("[ESP-NOW] Failed to add hexapod unicast peer");
        }
    }

    // ── Relay rover ESP-NOW telemetry → dashboard browsers ────────────────────
    if (pendingRoverTelemetry) {
        pendingRoverTelemetry = false;
        if (ws.count() > 0) ws.textAll(roverTelemetryJson);
    }

    // ── Register rover unicast peer once its AP MAC is learned ────────────────
    if (pendingAddRoverPeer && !roverMacKnown) {
        pendingAddRoverPeer = false;
        esp_now_peer_info_t roverPeer = {};
        memcpy(roverPeer.peer_addr, roverActualMac, 6);
        roverPeer.channel = 0;
        roverPeer.ifidx   = WIFI_IF_AP;
        roverPeer.encrypt = false;
        if (esp_now_add_peer(&roverPeer) == ESP_OK) {
            roverMacKnown = true;
            Serial.printf("[ESP-NOW] Rover MAC learned: %02X:%02X:%02X:%02X:%02X:%02X\n",
                roverActualMac[0], roverActualMac[1], roverActualMac[2],
                roverActualMac[3], roverActualMac[4], roverActualMac[5]);
        } else {
            Serial.println("[ESP-NOW] Failed to add rover unicast peer");
        }
    }

    static unsigned long lastBlink = 0;
    if (currentMillis - lastBlink >= 1000) {
        lastBlink = currentMillis;
        digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }
}

// ============================================================
// INITIALIZATION FUNCTIONS
// ============================================================

void initFileSystem() {
    Serial.print("Initializing LittleFS... ");
    if (!LittleFS.begin(true)) {  // true = format if mount fails
        Serial.println("FAILED!");
        return;
    }
    Serial.println("OK");

    File root = LittleFS.open("/");
    File file = root.openNextFile();
    Serial.println("Files in filesystem:");
    while (file) {
        Serial.printf("  %s (%d bytes)\n", file.name(), file.size());
        file = root.openNextFile();
    }
}

void initWiFi() {
    Serial.print("Configuring Access Point... ");

    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(local_IP, gateway, subnet);
    // Channel 6 is pinned so the hexapod can start its AP on the same channel.
    // ESP8266 has one radio — AP and STA must share a channel. If SATCOM-ALPHA
    // and the hexapod AP are already on the same channel, connecting the STA
    // causes zero channel change and the hexapod AP stays alive.
    WiFi.softAP(AP_SSID, AP_PASSWORD, 6);

    Serial.println("OK");
    Serial.printf("  SSID: %s\n", AP_SSID);
    Serial.printf("  Channel: 6\n");
    Serial.printf("  IP Address: %s\n", WiFi.softAPIP().toString().c_str());
}

void initSensors() {
    Serial.println("Initializing Sensors...");

    Serial.print("  DHT11 (GPIO 4)... ");
    dht.begin();
    delay(2000);  // DHT11 needs warmup time
    float testTemp = dht.readTemperature();
    if (!isnan(testTemp)) {
        dhtInitialized = true;
        Serial.println("OK");
    } else {
        Serial.println("Not connected");
    }

    Serial.print("  MPU6050 (I2C SDA:21 SCL:22)... ");
    if (mpu.begin()) {
        mpuInitialized = true;
        mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
        mpu.setGyroRange(MPU6050_RANGE_500_DEG);
        mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
        Serial.println("OK");
    } else {
        Serial.println("Not connected");
    }
}

void initNeoPixels() {
    Serial.println("Initializing NeoPixels (4 strips x 6 LEDs)...");

    strip1.begin(); strip1.setBrightness(neoState[0].brightness); strip1.show();
    Serial.println("  Strip 1 (GPIO 13) OK");

    strip2.begin(); strip2.setBrightness(neoState[1].brightness); strip2.show();
    Serial.println("  Strip 2 (GPIO 14) OK");

    strip3.begin(); strip3.setBrightness(neoState[2].brightness); strip3.show();
    Serial.println("  Strip 3 (GPIO 26) OK");

    strip4.begin(); strip4.setBrightness(neoState[3].brightness); strip4.show();
    Serial.println("  Strip 4 (GPIO 25) OK");

    applyAllNeoPixels();
}

void initServos() {
    Serial.println("Initializing Servos...");

    servoA.attach(SERVO1_PIN);
    servoA.write(servoAAngle);
    Serial.println("  Servo A - Solar Flap A (GPIO 18) OK");

    servoB.attach(SERVO2_PIN);
    servoB.write(servoBAngle);
    Serial.println("  Servo B - Solar Flap B (GPIO 19) OK");
}

void initWebServer() {
    Serial.print("Starting Web Server... ");

    ws.onEvent(onWebSocketEvent);
    server.addHandler(&ws);

    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");

    server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "application/json", getSystemStatus());
    });

    server.on("/api/devices", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray devices = doc["devices"].to<JsonArray>();

        for (const auto& client : clients) {
            if (client.connected) {
                JsonObject device = devices.add<JsonObject>();
                device["id"] = client.id;
                device["type"] = client.type;
                device["lastSeen"] = millis() - client.lastSeen;
            }
        }

        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    server.on("/api/neopixel", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray arr = doc["strips"].to<JsonArray>();
        for (int i = 0; i < 4; i++) {
            JsonObject s = arr.add<JsonObject>();
            s["power"] = neoState[i].power;
            s["r"] = neoState[i].r;
            s["g"] = neoState[i].g;
            s["b"] = neoState[i].b;
            s["brightness"] = neoState[i].brightness;
        }
        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // Soft-reset endpoint — dashboard button calls GET /api/reset.
    // The flag is consumed in loop() after 500 ms so the response is sent first.
    server.on("/api/reset", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "text/plain", "Restarting SATCOM-ALPHA...");
        pendingReset     = true;
        resetRequestedAt = millis();
        Serial.println("[RESET] Soft reset scheduled by dashboard.");
    });

    server.onNotFound([](AsyncWebServerRequest *request) {
        request->send(404, "text/plain", "Not found");
    });

    server.begin();
    Serial.println("OK");
}

// ============================================================
// NEOPIXEL CONTROL
// ============================================================

void applyNeoPixel(int idx) {
    if (idx < 0 || idx > 3) return;

    // All 4 strips are physical — direct 1-to-1 mapping
    strips[idx]->setBrightness(neoState[idx].brightness);

    if (neoState[idx].power) {
        uint32_t color = strips[idx]->Color(neoState[idx].r, neoState[idx].g, neoState[idx].b);
        for (int i = 0; i < NEOPIXEL_COUNT; i++) {
            strips[idx]->setPixelColor(i, color);
        }
    } else {
        strips[idx]->clear();
    }
    strips[idx]->show();
}

void applyAllNeoPixels() {
    for (int i = 0; i < 4; i++) {
        applyNeoPixel(i);
    }
}

void handleNeoPixelCommand(JsonDocument& doc) {
    int stripIdx = doc["strip"] | -1;

    if (doc["color"].is<const char*>()) {
        String hexColor = doc["color"].as<String>();
        if (hexColor.startsWith("#")) hexColor = hexColor.substring(1);
        long colorVal = strtol(hexColor.c_str(), NULL, 16);
        uint8_t r = (colorVal >> 16) & 0xFF;
        uint8_t g = (colorVal >> 8) & 0xFF;
        uint8_t b = colorVal & 0xFF;

        if (stripIdx >= 0 && stripIdx < 4) {
            neoState[stripIdx].r = r;
            neoState[stripIdx].g = g;
            neoState[stripIdx].b = b;
        } else {
            for (int i = 0; i < 4; i++) {
                neoState[i].r = r;
                neoState[i].g = g;
                neoState[i].b = b;
            }
        }
    }

    if (doc["brightness"].is<int>()) {
        uint8_t brt = doc["brightness"];
        if (stripIdx >= 0 && stripIdx < 4) {
            neoState[stripIdx].brightness = brt;
        } else {
            for (int i = 0; i < 4; i++) {
                neoState[i].brightness = brt;
            }
        }
    }

    if (doc["power"].is<bool>()) {
        bool pwr = doc["power"];
        if (stripIdx >= 0 && stripIdx < 4) {
            neoState[stripIdx].power = pwr;
        } else {
            for (int i = 0; i < 4; i++) {
                neoState[i].power = pwr;
            }
        }
    }

    if (stripIdx >= 0 && stripIdx < 4) {
        applyNeoPixel(stripIdx);
    } else {
        applyAllNeoPixels();
    }

    Serial.printf("[NEO] Strip:%d R:%d G:%d B:%d Brt:%d Pwr:%d\n",
                  stripIdx, neoState[0].r, neoState[0].g, neoState[0].b,
                  neoState[0].brightness, neoState[0].power);
}

// ============================================================
// SERVO / FLAP CONTROL
// ============================================================

void handleFlapCommand(JsonDocument& doc) {
    String panel = doc["panel"] | "";
    bool open = doc["open"] | true;

    if (panel == "A") {
        flapAOpen = open;
        servoAAngle = open ? 90 : 0;
        servoA.write(servoAAngle);
        Serial.printf("[SERVO] Flap A: %s\n", open ? "OPEN" : "CLOSED");
    } else if (panel == "B") {
        flapBOpen = open;
        servoBAngle = open ? 90 : 0;
        servoB.write(servoBAngle);
        Serial.printf("[SERVO] Flap B: %s\n", open ? "OPEN" : "CLOSED");
    }
}

void handleServoAngle(JsonDocument& doc) {
    String panel = doc["panel"] | "";
    int angle = constrain((int)(doc["angle"] | 90), 0, 180);

    if (panel == "A") {
        servoAAngle = angle;
        servoA.write(servoAAngle);
        Serial.printf("[SERVO] Flap A angle: %d\n", servoAAngle);
    } else if (panel == "B") {
        servoBAngle = angle;
        servoB.write(servoBAngle);
        Serial.printf("[SERVO] Flap B angle: %d\n", servoBAngle);
    }
}

// ============================================================
// TELEMETRY FUNCTIONS
// ============================================================

void updateTelemetry() {
    satData.uptime = millis() / 1000;

    if (dhtInitialized) {
        float temp = dht.readTemperature();
        float hum = dht.readHumidity();
        if (!isnan(temp)) satData.temperature = temp;
        if (!isnan(hum)) satData.humidity = hum;
    }

    if (mpuInitialized) {
        sensors_event_t a, g, temp;
        mpu.getEvent(&a, &g, &temp);

        satData.pitch = atan2(a.acceleration.y, a.acceleration.z) * 180.0 / PI;
        satData.roll = atan2(-a.acceleration.x,
                            sqrt(a.acceleration.y * a.acceleration.y +
                                 a.acceleration.z * a.acceleration.z)) * 180.0 / PI;
        satData.yaw += g.gyro.z * 0.001;
        satData.gx = g.gyro.x;
        satData.gy = g.gyro.y;
        satData.gz = g.gyro.z;
    }

    // ESP32 has 12-bit ADC (0-4095), default attenuation handles 0-3.3V
    int batteryRaw = analogRead(BATTERY_PIN);
    satData.batteryVoltage = (batteryRaw / 4095.0) * 3.3 * 2;  // Voltage divider
    satData.batteryPercent = constrain(map(batteryRaw, 1240, 1640, 0, 100), 0, 100);

    // ESP32 has multiple ADC pins - read solar voltage directly
    int solarRaw = analogRead(SOLAR_PIN);
    satData.solarVoltage = (solarRaw / 4095.0) * 3.3 * 2;  // Voltage divider

    satData.connectedClients = ws.count();
    satData.signalStrength = WiFi.RSSI();
}

void broadcastTelemetry() {
    if (ws.count() == 0) return;

    JsonDocument doc;
    doc["type"] = "telemetry";
    doc["source"] = "satellite";

    JsonObject data = doc["data"].to<JsonObject>();
    data["temperature"] = round(satData.temperature * 10) / 10.0;
    data["humidity"] = round(satData.humidity * 10) / 10.0;
    data["batteryVoltage"] = round(satData.batteryVoltage * 100) / 100.0;
    data["battery"] = (int)satData.batteryPercent;
    data["solarVoltage"] = round(satData.solarVoltage * 100) / 100.0;
    data["solar"] = round(satData.solarVoltage * 2.8 * 10) / 10.0;
    data["pitch"] = round(satData.pitch * 10) / 10.0;
    data["roll"] = round(satData.roll * 10) / 10.0;
    data["yaw"] = round(satData.yaw * 10) / 10.0;
    data["gx"] = round(satData.gx * 100) / 100.0;
    data["gy"] = round(satData.gy * 100) / 100.0;
    data["gz"] = round(satData.gz * 100) / 100.0;
    data["rssi"] = (int)satData.signalStrength;
    data["uptime"] = satData.uptime;
    data["clients"] = satData.connectedClients;
    data["systemOK"] = satData.systemOK;
    data["dhtOK"] = dhtInitialized;
    data["mpuOK"] = mpuInitialized;

    String message;
    serializeJson(doc, message);
    ws.textAll(message);
}

String getSystemStatus() {
    JsonDocument doc;
    doc["satellite"] = "SATCOM-ALPHA";
    doc["board"] = "ESP32";
    doc["status"] = satData.systemOK ? "OPERATIONAL" : "WARNING";
    doc["uptime"] = satData.uptime;
    doc["clients"] = satData.connectedClients;
    doc["ip"] = WiFi.softAPIP().toString();
    doc["heap"] = ESP.getFreeHeap();

    String response;
    serializeJson(doc, response);
    return response;
}

// ============================================================
// WEBSOCKET HANDLER
// ============================================================

void onWebSocketEvent(AsyncWebSocket *server, AsyncWebSocketClient *client,
                      AwsEventType type, void *arg, uint8_t *data, size_t len) {
    switch (type) {
        case WS_EVT_CONNECT:
            Serial.printf("[WS] Client #%u connected from %s\n",
                         client->id(), client->remoteIP().toString().c_str());
            {
                JsonDocument doc;
                doc["type"] = "welcome";
                doc["satellite"] = "SATCOM-ALPHA";
                doc["clientId"] = client->id();

                String msg;
                serializeJson(doc, msg);
                client->text(msg);

                ClientInfo info;
                info.id = client->id();
                info.type = "unknown";
                info.connected = true;
                info.lastSeen = millis();
                clients.push_back(info);
            }
            break;

        case WS_EVT_DISCONNECT:
            Serial.printf("[WS] Client #%u disconnected\n", client->id());
            {
                String disconnectedType = "unknown";
                for (auto& c : clients) {
                    if (c.id == client->id()) {
                        c.connected = false;
                        disconnectedType = c.type;
                        break;
                    }
                }
                // Notify dashboards if a device (not dashboard) disconnected
                if (disconnectedType != "dashboard" && disconnectedType != "unknown") {
                    JsonDocument notif;
                    notif["type"]   = "device_disconnected";
                    notif["device"] = disconnectedType;
                    String notifMsg;
                    serializeJson(notif, notifMsg);
                    for (AsyncWebSocketClient& c : ws.getClients()) {
                        if (c.status() == WS_CONNECTED) {
                            for (const auto& ci : clients) {
                                if (ci.id == c.id() && ci.type == "dashboard") {
                                    c.text(notifMsg);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            break;

        case WS_EVT_DATA:
            handleWebSocketMessage(arg, data, len, client);
            break;

        case WS_EVT_ERROR:
            Serial.printf("[WS] Client #%u error\n", client->id());
            break;

        case WS_EVT_PONG:
            break;
    }
}

void handleWebSocketMessage(void *arg, uint8_t *data, size_t len, AsyncWebSocketClient *client) {
    AwsFrameInfo *info = (AwsFrameInfo*)arg;

    if (info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT) {
        data[len] = 0;
        String message = (char*)data;

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, message);

        if (error) {
            Serial.printf("[WS] JSON parse error: %s\n", error.c_str());
            return;
        }

        String msgType = doc["type"].as<String>();

        if (msgType == "identify") {
            String clientType = doc["device"].as<String>();
            for (auto& c : clients) {
                if (c.id == client->id()) {
                    c.type = clientType;
                    c.lastSeen = millis();
                    Serial.printf("[WS] Client #%u identified as: %s\n", client->id(), clientType.c_str());
                    break;
                }
            }

            JsonDocument ack;
            ack["type"] = "identified";
            ack["device"] = clientType;
            String response;
            serializeJson(ack, response);
            client->text(response);

            // Notify all dashboard clients that a device has connected
            JsonDocument notif;
            notif["type"]      = "device_connected";
            notif["device"]    = clientType;
            notif["clientId"]  = client->id();
            String notifMsg;
            serializeJson(notif, notifMsg);
            for (AsyncWebSocketClient& c : ws.getClients()) {
                if (c.status() == WS_CONNECTED && c.id() != client->id()) {
                    for (const auto& ci : clients) {
                        if (ci.id == c.id() && ci.type == "dashboard") {
                            c.text(notifMsg);
                            break;
                        }
                    }
                }
            }
        }
        else if (msgType == "telemetry") {
            // Relay device telemetry to all dashboard clients
            String relay;
            serializeJson(doc, relay);

            for (AsyncWebSocketClient& c : ws.getClients()) {
                if (c.status() == WS_CONNECTED && c.id() != client->id()) {
                    for (const auto& ci : clients) {
                        if (ci.id == c.id() && ci.type == "dashboard") {
                            c.text(relay);
                            break;
                        }
                    }
                }
            }
        }
        else if (msgType == "chat") {
            // Relay chat — supports optional "to" field for targeted send.
            // Hexapod is no longer a WS client: addressed or broadcast chat
            // that should reach it is forwarded via ESP-NOW.
            String from = doc["from"] | "unknown";
            String msg  = doc["msg"]  | "";
            String to   = doc["to"]   | "all";
            Serial.printf("[CHAT] From %s to %s: %s\n", from.c_str(), to.c_str(), msg.c_str());

            // Forward chat to hexapod and/or rover via ESP-NOW as appropriate.
            if (to == "hexapod" || to == "all") {
                sendChatEspNow(from.c_str(), msg.c_str());
            }
            if (to == "rover" || to == "all") {
                sendRoverChatEspNow(from.c_str(), msg.c_str());
            }

            // Relay to WS clients (dashboards and any other WS devices)
            String relay;
            serializeJson(doc, relay);

            for (AsyncWebSocketClient& c : ws.getClients()) {
                if (c.status() == WS_CONNECTED && c.id() != client->id()) {
                    bool shouldSend = false;
                    if (to == "all") {
                        shouldSend = true;
                    } else {
                        for (const auto& ci : clients) {
                            if (ci.id == c.id() && (ci.type == to || ci.type == "dashboard")) {
                                shouldSend = true;
                                break;
                            }
                        }
                    }
                    if (shouldSend) c.text(relay);
                }
            }
        }
        else if (msgType == "command") {
            String target = doc["target"].as<String>();

            if (target == "led" || target == "neopixel") {
                handleNeoPixelCommand(doc);
            } else if (target == "flap") {
                handleFlapCommand(doc);
            } else if (target == "servo") {
                handleServoAngle(doc);
            } else if (target == "hexapod") {
                // Hexapod is no longer a WebSocket client — route via ESP-NOW.
                String command = doc["command"].as<String>();
                Serial.printf("[ESP-NOW] Command -> hexapod: %s\n", command.c_str());
                sendCommandEspNow(command.c_str());
            } else if (target == "rover") {
                // Rover is linked via ESP-NOW — forward command directly.
                String command = doc["command"].as<String>();
                Serial.printf("[ESP-NOW] Command -> rover: %s\n", command.c_str());
                sendRoverCommandEspNow(command.c_str());
            } else {
                String command = doc["command"].as<String>();
                Serial.printf("[CMD] %s -> %s\n", command.c_str(), target.c_str());

                String relay;
                serializeJson(doc, relay);

                for (AsyncWebSocketClient& c : ws.getClients()) {
                    if (c.status() == WS_CONNECTED) {
                        for (const auto& ci : clients) {
                            if (ci.id == c.id() && ci.type == target) {
                                c.text(relay);
                                break;
                            }
                        }
                    }
                }
            }
        }

        for (auto& c : clients) {
            if (c.id == client->id()) {
                c.lastSeen = millis();
                break;
            }
        }
    }
}

// ============================================================
// ESP-NOW — Hexapod Backhaul
// ============================================================

void onEspNowSent(const uint8_t *mac, esp_now_send_status_t status) {
    (void)mac; (void)status;  // fire and forget — broadcast always reports success
}

// IDF 5.x changed the recv callback signature to use esp_now_recv_info_t.
// The preprocessor selects the correct version at compile time.
#if ESP_IDF_VERSION_MAJOR >= 5
void onEspNowRecv(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
    const uint8_t *mac = recv_info->src_addr;
#else
void onEspNowRecv(const uint8_t *mac, const uint8_t *data, int len) {
#endif
    // Require at least msgType + deviceType bytes.
    if (len < 2) return;

    uint8_t msgType    = data[0];
    uint8_t deviceType = data[1];

    if (msgType == ESPNOW_MSG_TELEMETRY) {

        if (deviceType == ESPNOW_DEVICE_HEXAPOD && len >= (int)sizeof(EspNowTelemetry)) {
            // ── Hexapod telemetry ────────────────────────────────────────────
            // Learn the hexapod's AP MAC so we can send unicast back to it.
            if (!hexapodMacKnown) {
                memcpy(hexapodActualMac, mac, 6);
                pendingAddHexPeer = true;  // registered safely in loop()
            }
            const EspNowTelemetry* pkt = (const EspNowTelemetry*)data;
            JsonDocument doc;
            doc["type"]   = "telemetry";
            doc["source"] = "hexapod";
            JsonObject d  = doc["data"].to<JsonObject>();
            d["temp"]          = round(pkt->temp * 10) / 10.0f;
            d["hum"]           = round(pkt->hum  * 10) / 10.0f;
            d["signalStrength"]= (int)pkt->rssi;
            d["aqi"]           = (int)pkt->aqi;
            d["co2"]           = (int)pkt->co2;
            d["walking"]       = (bool)pkt->walking;
            d["step"]          = (int)pkt->step;
            d["clients"]       = (int)pkt->clients;
            JsonArray legs     = d["legs"].to<JsonArray>();
            for (int i = 0; i < 6; i++) legs.add(90 + (int)pkt->legs[i]);
            serializeJson(doc, hexTelemetryJson, sizeof(hexTelemetryJson));
            pendingHexTelemetry = true;
        }
        else if (deviceType == ESPNOW_DEVICE_ROVER && len >= (int)sizeof(EspNowRoverTelemetry)) {
            // ── Rover telemetry ──────────────────────────────────────────────
            // Learn the rover's AP MAC so we can send unicast commands back.
            if (!roverMacKnown) {
                memcpy(roverActualMac, mac, 6);
                pendingAddRoverPeer = true;  // registered safely in loop()
            }
            const EspNowRoverTelemetry* pkt = (const EspNowRoverTelemetry*)data;
            // Decode mode/motion codes to strings the dashboard expects.
            const char* modeStr  = (pkt->mode == 1) ? "Auto" : "Manual";
            const char* stateStr = pkt->obstacle   ? "OBSTACLE" :
                                   (pkt->motion != 0) ? "MOVING" : "IDLE";
            JsonDocument doc;
            doc["type"]          = "telemetry";
            // No "source" field → dashboard routes to updateRoverTelemetry().
            doc["ultra"]         = (int)pkt->ultra;
            doc["temp"]          = round(pkt->temp * 10) / 10.0f;
            doc["hum"]           = round(pkt->hum  * 10) / 10.0f;
            doc["ldr"]           = (int)pkt->ldr;
            doc["gas"]           = (int)pkt->gas;
            doc["hall"]          = (int)pkt->hall;
            doc["mode"]          = modeStr;
            doc["state"]         = stateStr;
            doc["obstacle"]      = (bool)pkt->obstacle;
            doc["forwardBlocked"]= (bool)pkt->forwardBlocked;
            serializeJson(doc, roverTelemetryJson, sizeof(roverTelemetryJson));
            pendingRoverTelemetry = true;
        }
    }
    else if (msgType == ESPNOW_MSG_CHAT && len >= (int)sizeof(EspNowChat)) {
        const EspNowChat* pkt = (const EspNowChat*)data;
        // Relay chat to all dashboard WebSocket clients.
        JsonDocument doc;
        doc["type"] = "chat";
        doc["from"] = pkt->from;
        doc["msg"]  = pkt->msg;
        char buf[192];
        serializeJson(doc, buf, sizeof(buf));
        ws.textAll(buf);
        Serial.printf("[ESP-NOW] Chat from %s: %s\n", pkt->from, pkt->msg);
    }
}

// Called after WiFi AP is up so esp_now_init() can use the radio.
void initEspNow() {
    if (esp_now_init() != ESP_OK) {
        Serial.println("[ESP-NOW] Init failed!");
        return;
    }
    esp_now_register_send_cb(onEspNowSent);
    esp_now_register_recv_cb(onEspNowRecv);

    // Add broadcast peer — channel 0 means "use current WiFi channel" (ch 6).
    // ifidx MUST be WIFI_IF_AP because the satellite runs in AP-only mode.
    // Default (0 = WIFI_IF_STA) is inactive here and causes outgoing sends to fail.
    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, hexMac, 6);
    peerInfo.channel = 0;
    peerInfo.ifidx   = WIFI_IF_AP;   // satellite is AP-only; STA interface is not active
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("[ESP-NOW] Add peer failed!");
        return;
    }
    Serial.println("[ESP-NOW] Initialized — broadcast peer on ch 6");
}

void sendCommandEspNow(const char* cmd) {
    EspNowCommand pkt;
    pkt.msgType = ESPNOW_MSG_COMMAND;
    strncpy(pkt.cmd, cmd, sizeof(pkt.cmd) - 1);
    pkt.cmd[sizeof(pkt.cmd) - 1] = '\0';
    // Prefer unicast to hexapod's real AP MAC; fall back to broadcast until
    // the MAC is learned from the first incoming telemetry packet.
    const uint8_t* dest = hexapodMacKnown ? hexapodActualMac : hexMac;
    esp_err_t result = esp_now_send(dest, (uint8_t*)&pkt, sizeof(pkt));
    if (result != ESP_OK) {
        Serial.printf("[ESP-NOW] Command send failed: %d\n", result);
    }
}

void sendChatEspNow(const char* from, const char* msg) {
    EspNowChat pkt;
    pkt.msgType = ESPNOW_MSG_CHAT;
    strncpy(pkt.from, from, sizeof(pkt.from) - 1);
    pkt.from[sizeof(pkt.from) - 1] = '\0';
    strncpy(pkt.msg, msg, sizeof(pkt.msg) - 1);
    pkt.msg[sizeof(pkt.msg) - 1] = '\0';
    const uint8_t* dest = hexapodMacKnown ? hexapodActualMac : hexMac;
    esp_err_t result = esp_now_send(dest, (uint8_t*)&pkt, sizeof(pkt));
    if (result != ESP_OK) {
        Serial.printf("[ESP-NOW] Hexapod chat send failed: %d\n", result);
    }
}

void sendRoverCommandEspNow(const char* cmd) {
    EspNowCommand pkt;
    pkt.msgType = ESPNOW_MSG_COMMAND;
    strncpy(pkt.cmd, cmd, sizeof(pkt.cmd) - 1);
    pkt.cmd[sizeof(pkt.cmd) - 1] = '\0';
    const uint8_t* dest = roverMacKnown ? roverActualMac : hexMac;
    esp_err_t result = esp_now_send(dest, (uint8_t*)&pkt, sizeof(pkt));
    if (result != ESP_OK) {
        Serial.printf("[ESP-NOW] Rover command send failed: %d\n", result);
    }
}

void sendRoverChatEspNow(const char* from, const char* msg) {
    EspNowChat pkt;
    pkt.msgType = ESPNOW_MSG_CHAT;
    strncpy(pkt.from, from, sizeof(pkt.from) - 1);
    pkt.from[sizeof(pkt.from) - 1] = '\0';
    strncpy(pkt.msg, msg, sizeof(pkt.msg) - 1);
    pkt.msg[sizeof(pkt.msg) - 1] = '\0';
    const uint8_t* dest = roverMacKnown ? roverActualMac : hexMac;
    esp_err_t result = esp_now_send(dest, (uint8_t*)&pkt, sizeof(pkt));
    if (result != ESP_OK) {
        Serial.printf("[ESP-NOW] Rover chat send failed: %d\n", result);
    }
}
