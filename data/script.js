// ============================================================
// ORBITAL MISSION CONTROL - Dashboard Script
// ============================================================

const SATELLITE_IP = '192.168.4.1';
const WS_URL = `ws://${SATELLITE_IP}/ws`;

// Global state
let ws = null;
let wsConnected = false;
let scene, camera, renderer, satellite;
let startTime = Date.now();
let roverConnected = false;
let hexapodConnected = false;
let lastRoverTelemetry = 0;
let lastHexapodTelemetry = 0;

// ── MPU Origin calibration ──────────────────────────────────
let mpuOrigin  = { gx: 0, gy: 0, gz: 0 };
let mpuCurrent = { gx: 0, gy: 0, gz: 0 };

// ── Data-flow throttle map ──────────────────────────────────
const lastFlowTrigger = {};

// ── Topology node positions in SVG viewBox (400×300) ────────
const TOPO_POS = {
    satellite: { x: 200, y: 135 },
    rover:     { x: 100, y: 240 },
    hexapod:   { x: 300, y: 240 }
};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    console.log('[ORBITAL] Initializing Mission Control...');

    initMissionClock();
    initWebSocket();
    init3DSatellite();
    initControls();
    initDeviceTimeouts();
    initGroupChat();

    console.log('[ORBITAL] Mission Control initialized');
});

// ============================================================
// MISSION CLOCK
// ============================================================

function initMissionClock() {
    updateClock();
    setInterval(updateClock, 1000);
}

function updateClock() {
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000).toString().padStart(2, '0');
    const minutes = Math.floor((elapsed % 3600000) / 60000).toString().padStart(2, '0');
    const seconds = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');

    const clockEl = document.getElementById('mission-clock');
    if (clockEl) clockEl.textContent = `${hours}:${minutes}:${seconds}`;
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

function initWebSocket() {
    console.log('[WS] Connecting to:', WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('[WS] Connected to satellite');
        wsConnected = true;
        updateConnectionStatus(true);
        addChatMessage('SYSTEM', 'Connected to satellite network', 'all', 'sys');
        ws.send(JSON.stringify({ type: 'identify', device: 'dashboard' }));
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected from satellite');
        wsConnected = false;
        updateConnectionStatus(false);
        addChatMessage('SYSTEM', 'Lost satellite connection', 'all', 'sys');
        setTimeout(initWebSocket, 5000);
    };

    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleTelemetry(data);
        } catch (e) {
            console.error('[WS] Parse error:', e);
        }
    };
}

function updateConnectionStatus(connected) {
    const statusEl = document.querySelector('.system-status');
    if (statusEl) {
        statusEl.innerHTML = connected
            ? '<span class="status-dot"></span> SYSTEM OPTIMAL'
            : '<span class="status-dot" style="background: var(--accent-red); box-shadow: 0 0 10px var(--accent-red);"></span> SIGNAL LOST';
    }
}

// ============================================================
// TELEMETRY HANDLING
// ============================================================

function handleTelemetry(data) {
    if (data.type === 'telemetry') {
        if (data.source === 'satellite') {
            // Satellite sends nested: { source:'satellite', data:{...} }
            updateSatelliteTelemetry(data.data);
        } else if (data.source === 'hexapod') {
            // Hexapod sends nested: { source:'hexapod', data:{...} }
            updateHexapodTelemetry(data.data);
        } else {
            // Rover sends flat telemetry: { type:'telemetry', ultra:..., temp:..., ... }
            updateRoverTelemetry(data);
        }
    } else if (data.type === 'device_connected') {
        onDeviceConnected(data.device);
    } else if (data.type === 'device_disconnected') {
        onDeviceDisconnected(data.device);
    } else if (data.type === 'chat') {
        onChatMessage(data.from, data.msg, data.to);
    }
}

// ── Satellite ──────────────────────────────────────────────

function updateSatelliteTelemetry(data) {
    if (data.gx !== undefined) {
        mpuCurrent = { gx: data.gx, gy: data.gy, gz: data.gz };
        updateElement('mpu-gx', data.gx.toFixed(2));
        updateElement('mpu-gy', data.gy.toFixed(2));
        updateElement('mpu-gz', data.gz.toFixed(2));

        if (satellite) {
            // Use delta from origin so small movements are visible after calibration
            const dx = data.gx - mpuOrigin.gx;
            const dy = data.gy - mpuOrigin.gy;
            const dz = data.gz - mpuOrigin.gz;
            satellite.rotation.x = (dx / 90) * Math.PI;
            satellite.rotation.y = (dy / 90) * Math.PI;
            satellite.rotation.z = (dz / 90) * Math.PI;
        }
    }
    if (data.temperature !== undefined) updateElement('dht-temp', `${data.temperature.toFixed(1)}°C`);
    if (data.humidity    !== undefined) updateElement('dht-hum',  `${data.humidity.toFixed(0)}%`);
    if (data.battery     !== undefined) {
        updateElement('sat-batt', `${data.battery}%`);
        updateProgressBar('bar-batt', data.battery);
    }
    if (data.solar !== undefined) {
        updateElement('sat-solar', `${data.solar.toFixed(1)}W`);
        updateProgressBar('bar-solar', (data.solar / 20) * 100);
    }
    if (data.rssi !== undefined) updateElement('sat-rssi', data.rssi);
}

// ── Rover ─────────────────────────────────────────────────

function updateRoverTelemetry(data) {
    lastRoverTelemetry = Date.now();
    triggerDataFlow('rover', 'satellite');

    if (!roverConnected) {
        roverConnected = true;
        updateDevicePill('rover-status-pill', 'online', 'ONLINE');
        showTopoDevice('rover');
    }

    // Sensors
    if (data.ultra !== undefined) updateElement('rover-ultra', `${data.ultra} cm`);
    if (data.temp  !== undefined) updateElement('rover-temp',  `${Number(data.temp).toFixed(1)}°C`);
    if (data.hum   !== undefined) updateElement('rover-hum',   `${Number(data.hum).toFixed(0)}%`);
    if (data.ldr   !== undefined) updateElement('rover-ldr',   data.ldr);
    if (data.gas   !== undefined) updateElement('rover-gas',   data.gas);
    if (data.hall  !== undefined) updateElement('rover-hall',  data.hall);

    // State (colorised)
    if (data.state !== undefined) {
        updateElement('rover-state', data.state);
        const el = document.getElementById('rover-state');
        if (el) {
            el.className = 'card-value ' + ({
                MOVING: 'text-green', TURNING: 'text-cyan',
                OBSTACLE: 'text-red', ERROR: 'text-orange'
            }[data.state] || '');
        }
    }

    if (data.mode !== undefined) updateElement('rover-mode', data.mode);
}

// ── Hexapod ───────────────────────────────────────────────

// AQI/CO₂ are pre-computed by the hexapod firmware.
// These helpers only handle the display metadata (label + colour).

function aqiCategory(aqi) {
    if (aqi <= 50)  return { label: 'GOOD',      color: '#10b981' };
    if (aqi <= 100) return { label: 'MODERATE',  color: '#f59e0b' };
    if (aqi <= 150) return { label: 'SENSITIVE',  color: '#f97316' };
    if (aqi <= 200) return { label: 'UNHEALTHY', color: '#ef4444' };
    return                 { label: 'HAZARDOUS', color: '#a855f7' };
}

function co2Label(co2) {
    if (co2 < 600)  return 'FRESH';
    if (co2 < 1000) return 'NORMAL';
    if (co2 < 2000) return 'HIGH';
    return 'DANGER';
}

function updateHexapodTelemetry(data) {
    lastHexapodTelemetry = Date.now();
    triggerDataFlow('hexapod', 'satellite');

    if (!hexapodConnected) {
        hexapodConnected = true;
        updateDevicePill('hexapod-status-pill', 'online', 'ONLINE');
        showTopoDevice('hexapod');
    }

    if (data.temp !== undefined) updateElement('hex-temp', `${Number(data.temp).toFixed(1)}°C`);
    if (data.hum  !== undefined) updateElement('hex-hum',  `${Number(data.hum).toFixed(0)}%`);

    if (data.aqi !== undefined && data.co2 !== undefined) {
        const aqi = Number(data.aqi);
        const co2 = Number(data.co2);
        const cat = aqiCategory(aqi);

        // AQI
        updateElement('hex-aqi-value', aqi);
        const aqiCatEl = document.getElementById('hex-aqi-cat');
        if (aqiCatEl) { aqiCatEl.textContent = cat.label; aqiCatEl.style.color = cat.color; }
        const aqiBar = document.getElementById('hex-aqi-bar');
        if (aqiBar) aqiBar.style.width = Math.min(aqi / 300 * 100, 100) + '%';

        // CO₂
        updateElement('hex-co2-value', co2 >= 9999 ? '>9999' : co2);
        const co2Bar = document.getElementById('hex-co2-bar');
        if (co2Bar) co2Bar.style.width = Math.min(co2 / 5000 * 100, 100) + '%';
        updateElement('hex-co2-status', co2Label(co2));
    }
}

// ── Device events ─────────────────────────────────────────

function onDeviceConnected(device) {
    if (device === 'rover') {
        roverConnected = true;
        updateDevicePill('rover-status-pill', 'online', 'ONLINE');
        addChatMessage('SYSTEM', 'Rover linked to satellite', 'all', 'sys');
        showTopoDevice('rover');
    } else if (device === 'hexapod') {
        hexapodConnected = true;
        updateDevicePill('hexapod-status-pill', 'online', 'ONLINE');
        addChatMessage('SYSTEM', 'Hexapod linked to satellite', 'all', 'sys');
        showTopoDevice('hexapod');
    }
}

function onDeviceDisconnected(device) {
    if (device === 'rover') {
        roverConnected = false;
        updateDevicePill('rover-status-pill', 'offline', 'OFFLINE');
        addChatMessage('SYSTEM', 'Rover disconnected', 'all', 'sys');
        hideTopoDevice('rover');
    } else if (device === 'hexapod') {
        hexapodConnected = false;
        updateDevicePill('hexapod-status-pill', 'offline', 'OFFLINE');
        addChatMessage('SYSTEM', 'Hexapod disconnected', 'all', 'sys');
        hideTopoDevice('hexapod');
    }
}

// ── Topology helpers ─────────────────────────────────────────

function showTopoDevice(device) {
    const nodeEl  = document.getElementById('topo-node-' + device);
    const lineEl  = document.getElementById(device === 'rover' ? 'topo-line-sat-rover' : 'topo-line-sat-hex');
    const hotspot = document.getElementById(device === 'rover' ? 'topo-hotspot-rover'  : 'topo-hotspot-hex');
    if (nodeEl)  nodeEl.classList.remove('topo-hidden');
    if (lineEl)  lineEl.classList.remove('topo-hidden');
    if (hotspot) hotspot.classList.remove('topo-hidden');
    // Show rover↔hexapod cross-link only when both are online
    if (roverConnected && hexapodConnected) {
        const cross = document.getElementById('topo-line-rover-hex');
        if (cross) cross.classList.remove('topo-hidden');
    }
}

function hideTopoDevice(device) {
    const nodeEl  = document.getElementById('topo-node-' + device);
    const lineEl  = document.getElementById(device === 'rover' ? 'topo-line-sat-rover' : 'topo-line-sat-hex');
    const hotspot = document.getElementById(device === 'rover' ? 'topo-hotspot-rover'  : 'topo-hotspot-hex');
    if (nodeEl)  nodeEl.classList.add('topo-hidden');
    if (lineEl)  lineEl.classList.add('topo-hidden');
    if (hotspot) hotspot.classList.add('topo-hidden');
    // Always hide cross-link when either goes offline
    const cross = document.getElementById('topo-line-rover-hex');
    if (cross) cross.classList.add('topo-hidden');
}

function onChatMessage(from, msg, to) {
    if ((from || '').toLowerCase() === 'mirror') {
        addChatMessage('MIRROR -> DASHBOARD', msg, 'dashboard', 'mirror');
        return;
    }
    const src = (from || '').toLowerCase();
    const dst = (to || '').toLowerCase();
    if ((src === 'rover' || src === 'hexapod') && (dst === 'rover' || dst === 'hexapod') && src !== dst) {
        // Visualize hub relay path: device -> satellite -> device.
        triggerDataFlow(src, 'satellite');
        triggerDataFlow('satellite', dst);
    }
    addChatMessage(from || 'unknown', msg, to || 'all', 'in');
}

// ============================================================
// UI HELPERS
// ============================================================

function updateElement(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function updateProgressBar(id, percent) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.min(100, Math.max(0, percent))}%`;
}

function updateDevicePill(id, className, text) {
    const el = document.getElementById(id);
    if (el) { el.className = `status-pill ${className}`; el.textContent = text; }
}

// ============================================================
// 3D SATELLITE VISUALIZATION (unchanged)
// ============================================================

function init3DSatellite() {
    const container = document.getElementById('sat-3d-container');
    if (!container || typeof THREE === 'undefined') return;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.z = 5;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0x00f2ff, 1);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    satellite = new THREE.Group();

    const body = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.6, 0.6),
        new THREE.MeshPhongMaterial({ color: 0x333344, emissive: 0x111122, shininess: 100 })
    );
    satellite.add(body);

    const panelMat = new THREE.MeshPhongMaterial({ color: 0x0044aa, emissive: 0x001133, shininess: 50 });
    const panelGeo = new THREE.BoxGeometry(1.5, 0.02, 0.8);
    const leftPanel = new THREE.Mesh(panelGeo, panelMat);
    leftPanel.position.set(-1.2, 0, 0);
    satellite.add(leftPanel);
    const rightPanel = new THREE.Mesh(panelGeo, panelMat);
    rightPanel.position.set(1.2, 0, 0);
    satellite.add(rightPanel);

    const antennaMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), antennaMat);
    antenna.position.set(0, 0.5, 0);
    satellite.add(antenna);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 8, 0, Math.PI), antennaMat);
    dish.position.set(0, 0.75, 0);
    dish.rotation.x = Math.PI;
    satellite.add(dish);

    scene.add(satellite);
    animate3D();

    window.addEventListener('resize', () => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        }
    });
}

function animate3D() {
    requestAnimationFrame(animate3D);
    if (satellite && !wsConnected) satellite.rotation.y += 0.005;
    if (renderer && scene && camera) renderer.render(scene, camera);
}

function setMpuOrigin() {
    mpuOrigin = { ...mpuCurrent };
    const btn = document.getElementById('calibrate-btn');
    if (btn) {
        btn.textContent = '✓ ORIGIN SET';
        btn.classList.add('active');
        setTimeout(() => {
            btn.textContent = '⌖ SET ORIGIN';
            btn.classList.remove('active');
        }, 2000);
    }
}

// ── Data-flow animation ──────────────────────────────────────

function triggerDataFlow(from, to) {
    const flowLayer = document.getElementById('topo-flow-layer');
    if (!flowLayer) return;

    const fromPos = TOPO_POS[from];
    const toPos   = TOPO_POS[to];
    if (!fromPos || !toPos) return;

    // Don't animate if the device node isn't visible yet
    if (from !== 'satellite') {
        const n = document.getElementById('topo-node-' + from);
        if (!n || n.classList.contains('topo-hidden')) return;
    }
    if (to !== 'satellite') {
        const n = document.getElementById('topo-node-' + to);
        if (!n || n.classList.contains('topo-hidden')) return;
    }

    // Throttle: max one packet per 600 ms per direction
    const key = `${from}>${to}`;
    const now  = Date.now();
    if (lastFlowTrigger[key] && now - lastFlowTrigger[key] < 600) return;
    lastFlowTrigger[key] = now;

    // Green = device→satellite (incoming telemetry), Cyan = satellite→device (command)
    const color  = (from !== 'satellite') ? '#00ff88' : '#00f2ff';
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '5');
    circle.setAttribute('fill', color);
    circle.setAttribute('cx', fromPos.x);
    circle.setAttribute('cy', fromPos.y);
    circle.style.filter = `drop-shadow(0 0 6px ${color})`;
    flowLayer.appendChild(circle);

    const duration = 700; // ms
    const t0 = performance.now();

    function step(ts) {
        const t    = Math.min((ts - t0) / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
        circle.setAttribute('cx', fromPos.x + (toPos.x - fromPos.x) * ease);
        circle.setAttribute('cy', fromPos.y + (toPos.y - fromPos.y) * ease);
        if (t < 1) {
            requestAnimationFrame(step);
        } else {
            if (flowLayer.contains(circle)) flowLayer.removeChild(circle);
        }
    }
    requestAnimationFrame(step);
}

// ============================================================
// NEOPIXEL CONTROLLER (unchanged)
// ============================================================

let selectedStrip = -1;
const neoStripState = [
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 }
];

function initNeoPixelControls() {
    document.querySelectorAll('.neo-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.neo-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            selectedStrip = parseInt(tab.dataset.strip);
            syncNeoUI();
        });
    });

    const masterPower = document.getElementById('neo-master-power');
    if (masterPower) {
        masterPower.addEventListener('change', () => {
            const pwr = masterPower.checked;
            if (selectedStrip === -1) {
                neoStripState.forEach(s => s.power = pwr);
                sendCommand('neopixel', { strip: -1, power: pwr });
            } else {
                neoStripState[selectedStrip].power = pwr;
                sendCommand('neopixel', { strip: selectedStrip, power: pwr });
            }
            updateNeoPreview();
        });
    }

    const neoColor = document.getElementById('neo-color');
    if (neoColor) {
        neoColor.addEventListener('input', () => {
            const color = neoColor.value;
            if (selectedStrip === -1) {
                neoStripState.forEach(s => s.color = color);
                sendCommand('neopixel', { strip: -1, color });
            } else {
                neoStripState[selectedStrip].color = color;
                sendCommand('neopixel', { strip: selectedStrip, color });
            }
            updateNeoPreview();
        });
    }

    const neoBrightness = document.getElementById('neo-brightness');
    if (neoBrightness) {
        neoBrightness.addEventListener('input', () => {
            const brt = parseInt(neoBrightness.value);
            if (selectedStrip === -1) {
                neoStripState.forEach(s => s.brightness = brt);
                sendCommand('neopixel', { strip: -1, brightness: brt });
            } else {
                neoStripState[selectedStrip].brightness = brt;
                sendCommand('neopixel', { strip: selectedStrip, brightness: brt });
            }
            updateBrightnessLabel(brt);
            updateNeoPreview();
        });
    }

    document.querySelectorAll('.quick-color').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            const neoColorEl = document.getElementById('neo-color');
            if (neoColorEl) neoColorEl.value = color;
            if (selectedStrip === -1) {
                neoStripState.forEach(s => s.color = color);
                sendCommand('neopixel', { strip: -1, color });
            } else {
                neoStripState[selectedStrip].color = color;
                sendCommand('neopixel', { strip: selectedStrip, color });
            }
            updateNeoPreview();
        });
    });

    updateNeoPreview();
    updateBrightnessLabel(128);
}

function syncNeoUI() {
    const neoColor = document.getElementById('neo-color');
    const neoBrightness = document.getElementById('neo-brightness');
    const masterPower = document.getElementById('neo-master-power');
    const state = selectedStrip >= 0 ? neoStripState[selectedStrip] : neoStripState[0];
    if (neoColor) neoColor.value = state.color;
    if (neoBrightness) neoBrightness.value = state.brightness;
    if (masterPower) masterPower.checked = state.power;
    updateBrightnessLabel(state.brightness);
}

function updateBrightnessLabel(value) {
    const label = document.getElementById('neo-brt-label');
    if (label) label.textContent = `${Math.round(value / 255 * 100)}%`;
}

function updateNeoPreview() {
    for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`neo-prev-${i}`);
        if (!el) continue;
        if (neoStripState[i].power) {
            const opacity = 0.3 + (neoStripState[i].brightness / 255) * 0.7;
            el.style.background = neoStripState[i].color;
            el.style.boxShadow = `0 0 12px ${neoStripState[i].color}60`;
            el.style.opacity = opacity;
            el.classList.remove('off');
        } else {
            el.classList.add('off');
        }
    }
}

// ============================================================
// CONTROLS (flaps + neopixel + dpad)
// ============================================================

function initControls() {
    initNeoPixelControls();
    initFlapControls();
    initDPad();
}

function initFlapControls() {
    const flapA = document.getElementById('flap-a');
    if (flapA) {
        flapA.addEventListener('change', () => {
            sendCommand('flap', { panel: 'A', open: flapA.checked });
            // Sync slider to match toggle (open=90°, closed=0°)
            const angle = flapA.checked ? 90 : 0;
            const slider = document.getElementById('servo-a-slider');
            if (slider) { slider.value = angle; document.getElementById('servo-a-val').textContent = angle + '°'; }
        });
    }
    const flapB = document.getElementById('flap-b');
    if (flapB) {
        flapB.addEventListener('change', () => {
            sendCommand('flap', { panel: 'B', open: flapB.checked });
            // Sync slider to match toggle (open=90°, closed=0°)
            const angle = flapB.checked ? 90 : 0;
            const slider = document.getElementById('servo-b-slider');
            if (slider) { slider.value = angle; document.getElementById('servo-b-val').textContent = angle + '°'; }
        });
    }
}

function updateServoAngle(panel, value) {
    const angle = parseInt(value);
    document.getElementById('servo-' + panel.toLowerCase() + '-val').textContent = angle + '°';
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', target: 'servo', panel, angle }));
    }
}

// ── D-Pad ──────────────────────────────────────────────────

const cmdIntervals = {};

function initDPad() {
    document.querySelectorAll('.dpad-btn[data-cmd]').forEach(btn => {
        const device = btn.dataset.device;
        const cmd    = btn.dataset.cmd;

        if (cmd === 'stop') {
            // Stop button: single tap
            btn.addEventListener('click', () => sendDeviceCommand(device, 'stop'));
            return;
        }

        // Direction buttons: hold to repeat
        const press   = (e) => { e.preventDefault(); startCmd(device, cmd, btn); };
        const release = (e) => { e.preventDefault(); stopCmd(device, btn); };

        btn.addEventListener('mousedown',  press);
        btn.addEventListener('mouseup',    release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('touchstart', press,   { passive: false });
        btn.addEventListener('touchend',   release, { passive: false });
    });
}

function startCmd(device, cmd, btn) {
    stopCmd(device);  // clear any existing hold
    btn.classList.add('pressed');
    sendDeviceCommand(device, cmd);
    cmdIntervals[device] = setInterval(() => sendDeviceCommand(device, cmd), 150);
}

function stopCmd(device, btn) {
    if (cmdIntervals[device]) {
        clearInterval(cmdIntervals[device]);
        delete cmdIntervals[device];
    }
    if (btn) btn.classList.remove('pressed');
    // Hexapod is slow-stepping — don't auto-stop on button release.
    // Use the dedicated ■ stop button to stop hexapod.
    if (device !== 'hexapod') {
        sendDeviceCommand(device, 'stop');
    }
}

function sendDeviceCommand(device, command) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', target: device, command }));
        if (device === 'rover' || device === 'hexapod') {
            triggerDataFlow('satellite', device);
        }
    }
}

function sendCommand(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', target: type, ...data }));
    }
}

// ============================================================
// DEVICE TIMEOUT DETECTION
// ============================================================

function initDeviceTimeouts() {
    setInterval(() => {
        const now = Date.now();
        const TIMEOUT = 5000;

        if (roverConnected && lastRoverTelemetry > 0 && (now - lastRoverTelemetry) > TIMEOUT) {
            roverConnected = false;
            updateDevicePill('rover-status-pill', 'offline', 'OFFLINE');
            addChatMessage('SYSTEM', 'Rover telemetry timeout', 'all', 'sys');
        }

        if (hexapodConnected && lastHexapodTelemetry > 0 && (now - lastHexapodTelemetry) > TIMEOUT) {
            hexapodConnected = false;
            updateDevicePill('hexapod-status-pill', 'offline', 'OFFLINE');
            addChatMessage('SYSTEM', 'Hexapod telemetry timeout', 'all', 'sys');
        }
    }, 2000);
}

// ============================================================
// GROUP COMMS / CHAT
// ============================================================

let chatRecipient = 'all';

function initGroupChat() {
    document.getElementById('rcpt-all')?.addEventListener('click',     () => setChatRecipient('all'));
    document.getElementById('rcpt-rover')?.addEventListener('click',   () => setChatRecipient('rover'));
    document.getElementById('rcpt-hexapod')?.addEventListener('click', () => setChatRecipient('hexapod'));

    addChatMessage('SYSTEM', 'Group comms online — awaiting devices', 'all', 'sys');
}

function setChatRecipient(target) {
    chatRecipient = target;
    document.querySelectorAll('.chat-recipient-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('rcpt-' + target);
    if (btn) btn.classList.add('active');
}

function sendGroupChat() {
    const input = document.getElementById('groupChatInput');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', from: 'satellite', to: chatRecipient, msg }));
        addChatMessage('SATELLITE RELAY', msg, chatRecipient, 'out');
        input.value = '';
    } else {
        addChatMessage('SYSTEM', 'Not connected to satellite', 'all', 'sys');
    }
}

function addChatMessage(from, msg, to, direction) {
    const log = document.getElementById('groupChatLog');
    if (!log) return;

    const div = document.createElement('div');

    if (direction === 'sys') {
        div.className = 'sat-chat-sys';
        div.textContent = `— ${msg} —`;
    } else {
        const directionClass = direction === 'out' ? 'sat-msg-out' : (direction === 'mirror' ? 'sat-msg-mirror' : 'sat-msg-in');
        div.className = 'sat-chat-msg ' + directionClass;
        const now  = new Date();
        const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
        const toLabel = (to && to !== 'all' && direction !== 'mirror') ? ` → ${to.toUpperCase()} (VIA SAT)` : '';
        div.innerHTML =
            `<span class="sat-chat-from">${from.toUpperCase()}${toLabel}</span>` +
            `<span class="sat-chat-text">${msg}</span>` +
            `<span class="sat-chat-time">${time}</span>`;
    }

    log.appendChild(div);
    log.scrollTop = log.scrollHeight;

    // Cap log at 60 messages
    while (log.children.length > 60) log.removeChild(log.firstChild);
}

// ============================================================
// DASHBOARD LINKS
// ============================================================

function openRoverDashboard()   { window.location.href = 'rover.html'; }
function openHexapodDashboard() { window.location.href = 'hexapod.html'; }

// ── Legacy stubs (kept for any external callers) ─────────────
function addLog() {}
function sendRoverCommand(command)   { sendDeviceCommand('rover',   command); }
function sendHexapodCommand(command) { sendDeviceCommand('hexapod', command); }

// ============================================================
// SOFT RESET
// ============================================================

function softReset() {
    const btn = document.getElementById('soft-reset-btn');
    if (btn && btn.classList.contains('busy')) return;   // already in progress

    if (!confirm('Soft-reset SATCOM-ALPHA?\n\nThe satellite will restart (~3 s). The dashboard will reconnect automatically.')) return;

    if (btn) {
        btn.textContent = '⟳ RESTARTING...';
        btn.classList.add('busy');
        btn.disabled = true;
    }
    addChatMessage('SYSTEM', 'Soft reset requested — satellite restarting...', 'all', 'sys');

    fetch('/api/reset')
        .catch(() => {})   // connection drops on restart — that's expected
        .finally(() => {
            // Re-enable the button after 8 s (well past the ~3 s restart time).
            // The WS reconnect loop in initWebSocket() handles reconnecting.
            setTimeout(() => {
                if (btn) {
                    btn.textContent = '⟳ RESET SAT';
                    btn.classList.remove('busy');
                    btn.disabled = false;
                }
                addChatMessage('SYSTEM', 'Satellite should be back — reconnecting...', 'all', 'sys');
            }, 8000);
        });
}
