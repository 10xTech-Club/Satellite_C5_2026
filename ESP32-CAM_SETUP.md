# ESP32-CAM Setup & Troubleshooting Guide

## Current Status
- **Dashboard IP**: 192.168.4.1 (Satellite ESP32)
- **Camera IP**: 192.168.4.184 (ESP32-CAM)
- **Network**: SATCOM-ALPHA / satellite2025

---

## Step 1: Upload Code to ESP32-CAM

### Hardware Setup:
1. Connect ESP32-CAM to USB-to-Serial adapter:
   - RX → TX
   - TX → RX
   - GND → GND
   - 5V → 5V
   - GPIO0 → GND (for programming mode)

2. Upload using PlatformIO:
   ```bash
   pio run -e esp32cam -t upload
   ```

3. After upload:
   - Disconnect GPIO0 from GND
   - Press RESET button on ESP32-CAM

---

## Step 2: Verify ESP32-CAM Connection

### Open Serial Monitor:
```bash
pio device monitor -e esp32cam -b 115200
```

### Expected Output:
```
========================================
ESP32-CAM MJPEG Stream Server
========================================

Initializing camera... SUCCESS!

Connecting to WiFi: SATCOM-ALPHA
..........

✓ WiFi Connected!
   IP Address: 192.168.4.184
   Gateway: 192.168.4.1
   RSSI: -45 dBm

✓ Web Server Started!
   Stream URL: http://192.168.4.184/stream

========================================
```

---

## Step 3: Test Camera Stream

### Direct Browser Test:
1. Connect your computer to `SATCOM-ALPHA` WiFi
2. Open browser: `http://192.168.4.184/`
3. You should see a simple HTML page with embedded camera stream

### Test Stream Endpoint:
- Open: `http://192.168.4.184/stream`
- You should see raw MJPEG video feed

---

## Step 4: Test from Dashboard

1. Connect to dashboard: `http://192.168.4.1`
2. Locate the camera section in Satellite panel
3. Click "CONNECT" button
4. Camera feed should appear

---

## Troubleshooting

### Issue: WiFi not connecting
**Symptoms**: ESP32-CAM shows "WiFi Connection Failed!"

**Solutions**:
- Verify Satellite ESP32 is running and AP is active
- Check SSID/password in code match exactly
- Ensure ESP32-CAM has good power supply (5V 2A recommended)
- Check serial monitor for error messages

---

### Issue: Camera init failed
**Symptoms**: "Camera init failed with error 0x..."

**Solutions**:
- Check camera ribbon cable connection
- Verify AI-Thinker pin definitions in code
- Ensure PSRAM is detected (brown ESP32-CAM boards have PSRAM)
- Try power cycling the ESP32-CAM

---

### Issue: Stream shows 404
**Symptoms**: Browser shows "Not Found" at /stream

**Solutions**:
- Verify web server started (check serial monitor)
- Ensure you're accessing correct IP (192.168.4.184)
- Check firewall settings on client device
- Try restarting ESP32-CAM

---

### Issue: Dashboard shows "Connection Failed"
**Symptoms**: Camera toggle shows "CONNECTION FAILED"

**Solutions**:
- Verify ESP32-CAM is on same network as dashboard
- Test stream directly in browser first
- Check browser console for CORS errors
- Ensure JavaScript has correct IP (192.168.4.184)

---

### Issue: Stream is slow/choppy
**Symptoms**: Low frame rate or frozen frames

**Solutions**:
- Reduce JPEG quality in code (increase jpeg_quality value)
- Lower frame size (use FRAMESIZE_SVGA instead of VGA)
- Ensure good WiFi signal strength
- Reduce FPS by increasing delay(30) to delay(50)

---

## Current Code Location

**ESP32-CAM code**: Provided above (corrected version with fixed pin names)

**Key changes from user's code**:
1. Fixed deprecated pin names: `pin_sccb_sda` and `pin_sccb_scl`
2. Added AsyncWebServer and MJPEG streaming
3. Added `/stream` endpoint
4. Added proper CORS headers
5. Simplified handler (removed incompatible StreamHandler class)

---

## Network Topology

```
Earth (Browser) ──┐
                  │
                  ├──> SATCOM-ALPHA AP (192.168.4.1) - Satellite ESP32
                  │
ESP32-CAM ────────┤    (192.168.4.184)
                  │
Rover ESP32 ──────┤    (192.168.4.10)
                  │
Hexapod ESP32 ────┘    (192.168.4.20)
```

---

## Next Steps

1. Upload corrected code to ESP32-CAM
2. Open serial monitor and verify WiFi connection
3. Test stream in browser: `http://192.168.4.184/stream`
4. Connect from dashboard and click CONNECT button
5. Enjoy your live camera feed!
