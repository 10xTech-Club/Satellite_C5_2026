# SATCOM ALPHA - Satellite Command Center

A complete ESP32-based Satellite Communication Simulation System with real-time dashboard.

## System Architecture

```
                    +-----------------+
                    |   SATELLITE     |
                    |     ESP32       |
                    |  (Access Point) |
                    |  192.168.4.1    |
                    +--------+--------+
                             |
            +----------------+----------------+
            |                |                |
     +------+------+  +------+------+  +------+------+
     |    EARTH    |  |    ROVER    |  |   HEXAPOD   |
     |    ESP32    |  |    ESP32    |  |    ESP32    |
     |  (Client)   |  |  (Client)   |  |  (Client)   |
     +-------------+  +-------------+  +-------------+
```

## Project Structure

```
SatComV1/
├── src/
│   ├── main.cpp          # Satellite ESP32 code
│   └── client.cpp        # Client ESP32 code (Earth/Rover/Hexapod)
├── data/
│   ├── index.html        # Dashboard HTML
│   ├── style.css         # Space-themed CSS
│   └── script.js         # WebSocket & UI logic
├── platformio.ini        # Build configurations
└── README.md             # This file
```

## Quick Start

### 1. Install PlatformIO

If you haven't already, install PlatformIO:
- VS Code Extension: Search "PlatformIO IDE" in Extensions
- Or via pip: `pip install platformio`

### 2. Build & Upload Satellite

```bash
# Build for Satellite
pio run -e satellite

# Upload filesystem (LittleFS) - IMPORTANT: Do this first!
pio run -e satellite -t uploadfs

# Upload code
pio run -e satellite -t upload

# Monitor serial output
pio device monitor -e satellite
```

### 3. Build & Upload Clients

For Earth Station:
```bash
pio run -e client_earth -t upload
pio device monitor -e client_earth
```

For Rover:
```bash
pio run -e client_rover -t upload
pio device monitor -e client_rover
```

For Hexapod:
```bash
pio run -e client_hexapod -t upload
pio device monitor -e client_hexapod
```

### 4. Access Dashboard

1. Connect your phone/computer to WiFi: `SATCOM-ALPHA`
2. Password: `satellite2024`
3. Open browser: `http://192.168.4.1`

## Build Environments

| Environment | Description | Build Command |
|-------------|-------------|---------------|
| `satellite` | Main satellite hub (AP + WebServer) | `pio run -e satellite` |
| `client_earth` | Earth ground station client | `pio run -e client_earth` |
| `client_rover` | Mars rover client | `pio run -e client_rover` |
| `client_hexapod` | Hexapod robot client | `pio run -e client_hexapod` |

## LittleFS Upload Instructions

The dashboard files (HTML/CSS/JS) must be uploaded to the ESP32's LittleFS filesystem.

### Method 1: PlatformIO CLI
```bash
pio run -e satellite -t uploadfs
```

### Method 2: PlatformIO GUI (VS Code)
1. Open PlatformIO sidebar
2. Select `satellite` environment
3. Click `Upload Filesystem Image`

### Troubleshooting LittleFS Upload

If upload fails:
1. Make sure `data/` folder exists with files
2. Check board is connected and COM port is correct
3. Hold BOOT button during upload if needed
4. Try reducing baud rate in platformio.ini

## Network Configuration

### Default Settings

| Setting | Value |
|---------|-------|
| SSID | `SATCOM-ALPHA` |
| Password | `satellite2024` |
| Satellite IP | `192.168.4.1` |
| WebSocket Port | `80` |
| WebSocket Path | `/ws` |

### Changing WiFi Credentials

Edit in `src/main.cpp` (Satellite):
```cpp
const char* AP_SSID = "SATCOM-ALPHA";
const char* AP_PASSWORD = "satellite2024";
```

Edit in `src/client.cpp` (Clients):
```cpp
const char* SATELLITE_SSID = "SATCOM-ALPHA";
const char* SATELLITE_PASSWORD = "satellite2024";
```

## Communication Protocol

### WebSocket Messages

#### Device Registration (Client → Satellite)
```json
{
    "type": "register",
    "device": "EARTH|ROVER|HEXAPOD",
    "status": "ONLINE"
}
```

#### Heartbeat (Client → Satellite)
```json
{
    "type": "heartbeat",
    "device": "EARTH",
    "rssi": -55,
    "uptime": 12345,
    "freeHeap": 180000
}
```

#### Status Update (Satellite → Dashboard)
```json
{
    "type": "status_update",
    "timestamp": 12345,
    "satellite": {
        "online": true,
        "uptime": "00:15:30",
        "connectedDevices": 2
    },
    "devices": [
        {
            "type": "EARTH",
            "online": true,
            "rssi": -55,
            "lastSeen": 500
        }
    ]
}
```

#### Command (Dashboard → Satellite → Client)
```json
{
    "type": "command",
    "target": "ROVER",
    "command": "forward"
}
```

## Hardware Setup

### Minimum Requirements

- 1x ESP32 DevKit (Satellite)
- 1-3x ESP32 DevKit (Clients)
- USB cables for programming
- Power supplies (USB or battery)

### Wiring Diagram

#### Satellite ESP32
```
No additional wiring required.
Uses built-in WiFi for Access Point mode.

Optional:
- Connect external antenna for better range
- Add status LEDs on GPIO pins
```

#### Client ESP32s
```
Built-in LED (GPIO 2) is used for status indication:
- Fast blink: No WiFi connection
- Slow blink: WiFi connected, WebSocket connecting
- Solid ON: Fully connected and registered

For Rover/Hexapod, add motor drivers and sensors as needed.
```

### LED Status Indicators

| Pattern | Meaning |
|---------|---------|
| Fast blink (200ms) | WiFi disconnected |
| Slow blink (500ms) | WiFi OK, WebSocket connecting |
| Solid ON | Fully connected & registered |

## Extending the System

### Adding Custom Commands

Edit `handleCommand()` in `client.cpp`:

```cpp
void handleCommand(String command) {
    if (command == "my_command") {
        // Your code here
        Serial.println("Executing my_command!");
    }
}
```

### Adding New Device Types

1. Add new environment in `platformio.ini`:
```ini
[env:client_newdevice]
platform = espressif32
board = esp32dev
framework = arduino
lib_deps =
    ArduinoJson
    links2004/WebSockets @ ^2.4.1
build_flags =
    -D CLIENT_MODE=1
    -D DEVICE_TYPE_NEWDEVICE=1
```

2. Add device handling in `client.cpp`:
```cpp
#ifndef DEVICE_TYPE_NEWDEVICE
#define DEVICE_TYPE_NEWDEVICE 0
#endif

#if DEVICE_TYPE_NEWDEVICE
    #define DEVICE_NAME "NEWDEVICE"
    #define DEVICE_DESCRIPTION "My New Device"
#endif
```

3. Update dashboard to display new device.

## Troubleshooting

### Satellite Issues

| Problem | Solution |
|---------|----------|
| Dashboard not loading | Upload LittleFS first: `pio run -e satellite -t uploadfs` |
| Can't connect to WiFi | Check SSID/password, try restarting satellite |
| WebSocket not connecting | Clear browser cache, check console for errors |

### Client Issues

| Problem | Solution |
|---------|----------|
| Won't connect to satellite | Verify satellite is running, check WiFi credentials |
| Fast LED blinking | WiFi not connecting - check satellite is on |
| Slow LED blinking | WiFi OK but WebSocket failing - check satellite web server |

### Common Fixes

1. **Reset everything**: Power cycle all ESP32s
2. **Re-upload**: Upload code again with clean build
3. **Check serial**: Monitor serial output for error messages
4. **Browser cache**: Hard refresh dashboard (Ctrl+Shift+R)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard (index.html) |
| `/ws` | WS | WebSocket connection |
| `/api/status` | GET | Current status JSON |
| `/api/logs` | GET | Recent log entries |

## Dependencies

### Satellite (main.cpp)
- ESPAsyncWebServer
- AsyncTCP
- ArduinoJson
- LittleFS

### Client (client.cpp)
- WebSockets (links2004)
- ArduinoJson

## Performance Notes

- Heartbeat interval: 2.5 seconds
- Status broadcast: 1 second
- Heartbeat timeout: 5 seconds
- Max clients: 10 simultaneous
- Log buffer: 50 entries

## License

MIT License - Feel free to use and modify for your projects.

## Credits

Satellite Command Center v1.0
Built with ESP32 + ESPAsyncWebServer + WebSockets
