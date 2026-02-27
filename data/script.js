/* ============================================================
   ORBITAL MISSION CONTROL — script.js
   Fully offline — no external dependencies
   Canvas 2D-based 3D satellite renderer + WebSocket logic
   ============================================================ */

// ============================================================
// CANVAS-BASED 3D SATELLITE RENDERER
// Custom projection engine — replaces Three.js
// ============================================================

const SAT3D = (() => {
    let canvas, ctx, W, H;
    let rotX = 0.15, rotY = 0, rotZ = 0;
    let targetX = 0.15, targetY = 0, targetZ = 0;
    let autoSpin = true;
    const stars = [];

    // ── Math helpers ────────────────────────────────────────
    function rotatePoint(p, rx, ry, rz) {
        let [x, y, z] = p;
        // Rotate Z
        let c = Math.cos(rz), s = Math.sin(rz);
        [x, y] = [x * c - y * s, x * s + y * c];
        // Rotate X
        c = Math.cos(rx); s = Math.sin(rx);
        [y, z] = [y * c - z * s, y * s + z * c];
        // Rotate Y
        c = Math.cos(ry); s = Math.sin(ry);
        [x, z] = [x * c + z * s, -x * s + z * c];
        return [x, y, z];
    }

    function project(p) {
        const fov = 380;
        const z = p[2] + 12;
        return [W / 2 + p[0] * fov / z, H / 2 - p[1] * fov / z, p[2]];
    }

    function p3d(pt) {
        return project(rotatePoint(pt, rotX, rotY, rotZ));
    }

    // ── Draw primitives ──────────────────────────────────────
    function line3d(a, b, style, lw = 1.5) {
        const pa = p3d(a), pb = p3d(b);
        ctx.strokeStyle = style;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
    }

    function rect3d(corners, fillStyle, strokeStyle) {
        const pts = corners.map(p3d);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        if (fillStyle)  { ctx.fillStyle = fillStyle; ctx.fill(); }
        if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = 0.8; ctx.stroke(); }
    }

    function box3d(cx, cy, cz, w, h, d, faceColors) {
        const hw = w / 2, hh = h / 2, hd = d / 2;
        const v = [
            [cx - hw, cy - hh, cz - hd], [cx + hw, cy - hh, cz - hd],
            [cx + hw, cy + hh, cz - hd], [cx - hw, cy + hh, cz - hd],
            [cx - hw, cy - hh, cz + hd], [cx + hw, cy - hh, cz + hd],
            [cx + hw, cy + hh, cz + hd], [cx - hw, cy + hh, cz + hd],
        ];
        const faces = [
            [[4, 5, 6, 7], faceColors[0]], // +Z
            [[1, 0, 3, 2], faceColors[1]], // -Z
            [[4, 5, 1, 0], faceColors[2]], // -Y
            [[7, 6, 2, 3], faceColors[3]], // +Y
            [[0, 4, 7, 3], faceColors[4]], // -X
            [[5, 1, 2, 6], faceColors[5]], // +X
        ];
        // Painter's algorithm — sort back to front
        const sorted = faces.map(([idxs, col]) => {
            const pts = idxs.map(i => rotatePoint(v[i], rotX, rotY, rotZ));
            const avgZ = pts.reduce((s, p) => s + p[2], 0) / pts.length;
            return { idxs, col, avgZ };
        }).sort((a, b) => a.avgZ - b.avgZ);

        for (const { idxs, col } of sorted) {
            rect3d(idxs.map(i => v[i]), col, 'rgba(0,0,0,0.3)');
        }
    }

    // ── Main satellite draw ──────────────────────────────────
    function drawSatellite() {
        const t = Date.now() * 0.001;

        // Starfield
        for (const s of stars) {
            const bri = 0.4 + 0.3 * Math.sin(t * s.tw + s.tp);
            ctx.fillStyle = `rgba(255,255,255,${bri})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }

        // Orbit ring
        ctx.strokeStyle = 'rgba(0,242,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 80; i++) {
            const a = (i / 80) * Math.PI * 2;
            const rp = rotatePoint([Math.cos(a) * 3.8, 0, Math.sin(a) * 2.2], rotX + 0.3, rotY, rotZ);
            const pp = project(rp);
            i === 0 ? ctx.moveTo(pp[0], pp[1]) : ctx.lineTo(pp[0], pp[1]);
        }
        ctx.closePath();
        ctx.stroke();

        // ── Central bus body ──
        const sx = Math.sin(rotY) * 0.5;
        box3d(0, 0, 0, 1.3, 1.1, 1.5, [
            `rgba(180,115,0,${0.85 + sx * 0.1})`,  // +Z gold foil
            `rgba(150,95,0,0.75)`,                  // -Z gold foil
            `rgba(42,58,74,0.9)`,                   // top
            `rgba(35,50,65,0.9)`,                   // bottom
            `rgba(38,54,70,0.85)`,                  // left
            `rgba(38,54,70,0.85)`,                  // right
        ]);

        // Status LEDs on front face
        const ledColors = ['#00ff88', '#00f2ff', '#ff4444', '#ff9d00'];
        for (let i = 0; i < 4; i++) {
            const lp = p3d([-0.4 + i * 0.26, 0.52, 0.76]);
            ctx.shadowColor = ledColors[i];
            ctx.shadowBlur = 8;
            ctx.fillStyle = ledColors[i];
            ctx.beginPath();
            ctx.arc(lp[0], lp[1], 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // ── Solar booms ──
        line3d([-0.65, 0.08, 0], [-3.2, 0.08, 0], 'rgba(100,120,140,0.7)', 2.5);
        line3d([ 0.65, 0.08, 0], [ 3.2, 0.08, 0], 'rgba(100,120,140,0.7)', 2.5);

        // ── Solar panels ──
        function drawPanel(side) {
            const sx2 = side * 2.2;
            const pH = 0.9, pW = 1.55;
            for (let row = 0; row < 2; row++) {
                const py = row === 0 ? 0.44 : -0.44;
                const corners = [
                    [sx2 - pW / 2, py - pH / 2, 0],
                    [sx2 + pW / 2, py - pH / 2, 0],
                    [sx2 + pW / 2, py + pH / 2, 0],
                    [sx2 - pW / 2, py + pH / 2, 0],
                ];
                // Panel background
                rect3d(corners, 'rgba(0,18,60,0.95)', 'rgba(60,80,120,0.5)');
                // PV cells 3×6
                const cw = pW / 6.5, ch = pH / 3.5;
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 6; c++) {
                        const cx2 = sx2 - pW / 2 + 0.12 + c * (cw + 0.01);
                        const cy2 = py  - pH / 2 + 0.10 + r * (ch + 0.01);
                        const shine = 0.55 + 0.2 * Math.sin(t * 0.5 + c * 0.7 + r * 1.1 + row * 2);
                        rect3d(
                            [[cx2,cx2+cw,cx2+cw,cx2].map((x,i)=>x),
                             [cy2,cy2,cy2+ch,cy2+ch].map(y=>y),
                             [0.002,0.002,0.002,0.002]].reduce((a,_,i,arr)=>
                                [[cx2,cy2,0.002],[cx2+cw,cy2,0.002],[cx2+cw,cy2+ch,0.002],[cx2,cy2+ch,0.002]],[]),
                            `rgba(0,28,${Math.round(100*shine)},0.9)`,
                            'rgba(0,34,110,0.6)'
                        );
                    }
                }
                // Frame border
                rect3d(corners, null, 'rgba(70,90,120,0.9)');
            }
        }
        drawPanel(-1);
        drawPanel(1);

        // ── Antenna mast ──
        line3d([0, 0.55, 0], [0, 1.38, 0], 'rgba(180,200,220,0.8)', 2.2);

        // ── Parabolic dish ──
        const dc = p3d([0, 1.45, 0]);
        const dDepth = rotatePoint([0, 1.45, 0], rotX, rotY, rotZ)[2] + 12;
        const dRad = 0.42 * 380 / dDepth;
        const grad = ctx.createRadialGradient(dc[0], dc[1], 0, dc[0], dc[1], dRad);
        grad.addColorStop(0, 'rgba(200,230,255,0.75)');
        grad.addColorStop(0.5, 'rgba(100,160,200,0.4)');
        grad.addColorStop(1, 'rgba(40,80,120,0.05)');
        ctx.shadowColor = 'rgba(0,242,255,0.5)';
        ctx.shadowBlur = 14;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(dc[0], dc[1], dRad, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(160,200,220,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(dc[0], dc[1], dRad, 0, Math.PI * 2);
        ctx.stroke();

        // Feed struts × 3
        for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2;
            line3d([Math.cos(a) * 0.24, 1.15, Math.sin(a) * 0.24], [0, 1.12, 0], 'rgba(180,190,200,0.6)', 1.2);
        }

        // Feed horn (gold dot)
        const fh = p3d([0, 1.12, 0]);
        ctx.fillStyle = 'rgba(255,190,0,0.95)';
        ctx.beginPath();
        ctx.arc(fh[0], fh[1], 4, 0, Math.PI * 2);
        ctx.fill();

        // ── Omni antenna ──
        line3d([0.5, 0.55, 0], [0.5, 1.18, 0], 'rgba(180,200,220,0.7)', 1.8);
        const ot = p3d([0.5, 1.2, 0]);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(ot[0], ot[1], 2.5, 0, Math.PI * 2);
        ctx.fill();

        // ── Star tracker ──
        box3d(-0.42, 0.62, 0.62, 0.19, 0.19, 0.19, [
            'rgba(30,30,60,0.9)', 'rgba(25,25,55,0.9)',
            'rgba(20,20,50,0.9)', 'rgba(20,20,50,0.9)',
            'rgba(20,20,50,0.9)', 'rgba(20,20,50,0.9)',
        ]);

        // ── Reaction wheel ──
        const rwc = p3d([0, -0.65, 0]);
        const rwD = rotatePoint([0, -0.65, 0], rotX, rotY, rotZ)[2] + 12;
        const rwR = 0.3 * 380 / rwD;
        ctx.strokeStyle = 'rgba(80,100,120,0.8)';
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(rwc[0], rwc[1], rwR * 0.85, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(55,75,95,0.5)';
        ctx.lineWidth = 14;
        ctx.beginPath();
        ctx.arc(rwc[0], rwc[1], rwR, 0, Math.PI * 2);
        ctx.stroke();
    }

    function initStars() {
        for (let i = 0; i < 180; i++) {
            stars.push({
                x: Math.random() * W,
                y: Math.random() * H,
                r: Math.random() * 1.2 + 0.2,
                tw: Math.random() * 2 + 0.5,
                tp: Math.random() * Math.PI * 2
            });
        }
    }

    function frame() {
        requestAnimationFrame(frame);
        ctx.clearRect(0, 0, W, H);

        if (autoSpin) {
            rotY += 0.005;
            rotX = 0.15 + Math.sin(Date.now() * 0.0004) * 0.08;
        } else {
            // Fast lerp — snappy response to MPU data
            rotX += (targetX - rotX) * 0.35;
            rotY += (targetY - rotY) * 0.35;
            rotZ += (targetZ - rotZ) * 0.35;
        }

        drawSatellite();
    }

    return {
        init() {
            const container = document.getElementById('sat-3d-container');
            if (!container) { console.error('[SAT3D] Container not found'); return; }

            canvas = document.createElement('canvas');
            W = canvas.width  = container.clientWidth  || container.offsetWidth  || 400;
            H = canvas.height = container.clientHeight || container.offsetHeight || 240;
            canvas.style.width  = '100%';
            canvas.style.height = '100%';
            container.innerHTML = '';
            container.appendChild(canvas);
            ctx = canvas.getContext('2d');

            initStars();
            frame();

            // Resize observer keeps canvas sharp on layout changes
            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(() => {
                    W = canvas.width  = container.clientWidth;
                    H = canvas.height = container.clientHeight;
                    for (const s of stars) {
                        s.x = Math.random() * W;
                        s.y = Math.random() * H;
                    }
                }).observe(container);
            }

            console.log('[SAT3D] Initialized — canvas', W, 'x', H);
        },

        // Called by telemetry handler with MPU-6050 data
        setRotation(rx, ry, rz) {
            autoSpin = false;
            // Apply directly — no lerp lag for real-time MPU response
            rotX = targetX = rx;
            rotY = targetY = ry;
            rotZ = targetZ = rz;
        },

        enableAutoSpin() {
            autoSpin = true;
        }
    };
})();

// ============================================================
// DASHBOARD — WebSocket, Telemetry, Controls
// ============================================================

const SATELLITE_IP = '192.168.4.1';
const WS_URL = `ws://${SATELLITE_IP}/ws`;

let ws = null;
let wsConnected = false;
let startTime = Date.now();
let roverConnected   = false;
let hexapodConnected = false;
let lastRoverTelemetry   = 0;
let lastHexapodTelemetry = 0;
let mpuOrigin  = { pitch: 0, roll: 0 };
let mpuCurrent = { pitch: 0, roll: 0 };
const lastFlowTrigger = {};
const TOPO_POS = {
    satellite: { x: 200, y: 135 },
    rover:     { x: 100, y: 240 },
    hexapod:   { x: 300, y: 240 }
};

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initMissionClock();
    setTimeout(() => SAT3D.init(), 150);   // slight delay so layout is ready
    initControls();
    initDeviceTimeouts();
    initGroupChat();
    setTimeout(initWebSocket, 250);         // defer WS so page paints first
});

// ── Mission Clock ─────────────────────────────────────────────
function initMissionClock() { updateClock(); setInterval(updateClock, 1000); }
function updateClock() {
    const e = Date.now() - startTime;
    const h = Math.floor(e / 3600000).toString().padStart(2, '0');
    const m = Math.floor((e % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((e % 60000) / 1000).toString().padStart(2, '0');
    const el = document.getElementById('mission-clock');
    if (el) el.textContent = `${h}:${m}:${s}`;
}

// ── WebSocket ─────────────────────────────────────────────────
function initWebSocket() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        wsConnected = true;
        updateConnStatus(true);
        addChat('SYSTEM', 'Connected to satellite network', 'all', 'sys');
        ws.send(JSON.stringify({ type: 'identify', device: 'dashboard' }));
    };
    ws.onclose = () => {
        wsConnected = false;
        updateConnStatus(false);
        addChat('SYSTEM', 'Lost satellite connection', 'all', 'sys');
        SAT3D.enableAutoSpin();
        setTimeout(initWebSocket, 2000);
    };
    ws.onerror = e => console.error('[WS] Error:', e);
    ws.onmessage = ev => {
        try { handleTelemetry(JSON.parse(ev.data)); } catch (e) {}
    };
}

function updateConnStatus(ok) {
    const el = document.querySelector('.system-status');
    if (el) el.innerHTML = ok
        ? '<span class="status-dot"></span> SYSTEM OPTIMAL'
        : '<span class="status-dot" style="background:var(--accent-red);box-shadow:0 0 10px var(--accent-red);"></span> SIGNAL LOST';
}

// ── Telemetry Router ──────────────────────────────────────────
function handleTelemetry(d) {
    if (d.type === 'telemetry') {
        if      (d.source === 'satellite') updateSatTelemetry(d.data);
        else if (d.source === 'hexapod')   updateHexTelemetry(d.data);
        else                               updateRoverTelemetry(d);
    } else if (d.type === 'device_connected')    onDeviceConn(d.device);
    else if   (d.type === 'device_disconnected') onDeviceDisconn(d.device);
    else if   (d.type === 'chat')                onChatMsg(d.from, d.msg, d.to);
}

// ── Satellite Telemetry ───────────────────────────────────────
function updateSatTelemetry(d) {
    if (d.gx !== undefined) {
        updateEl('mpu-gx', d.gx.toFixed(2));
        updateEl('mpu-gy', d.gy.toFixed(2));
        updateEl('mpu-gz', d.gz.toFixed(2));
    }
    if (d.pitch !== undefined) {
        mpuCurrent = { pitch: d.pitch, roll: d.roll || 0 };
        // pitch/roll are real angles in degrees (-90 to +90) from accelerometer
        // subtract origin so "SET ORIGIN" zeros the view, then convert to radians
        const rx = (d.pitch - mpuOrigin.pitch) * Math.PI / 180;
        const rz = (d.roll  - mpuOrigin.roll)  * Math.PI / 180;
        SAT3D.setRotation(rx + 0.15, 0, rz);
    }
    if (d.temperature !== undefined) updateEl('dht-temp', `${d.temperature.toFixed(1)}°C`);
    if (d.humidity    !== undefined) updateEl('dht-hum',  `${d.humidity.toFixed(0)}%`);
    if (d.battery     !== undefined) { updateEl('sat-batt', `${d.battery}%`); updateBar('bar-batt', d.battery); }
    if (d.solar       !== undefined) { updateEl('sat-solar', `${d.solar.toFixed(1)}W`); updateBar('bar-solar', (d.solar / 20) * 100); }
    if (d.rssi        !== undefined) updateEl('sat-rssi', d.rssi);
}

// ── Rover Telemetry ───────────────────────────────────────────
function updateRoverTelemetry(d) {
    lastRoverTelemetry = Date.now();
    triggerFlow('rover', 'satellite');
    if (!roverConnected) {
        roverConnected = true;
        updatePill('rover-status-pill', 'online', 'ONLINE');
        showTopo('rover');
    }
    if (d.ultra !== undefined) updateEl('rover-ultra', `${d.ultra} cm`);
    if (d.temp  !== undefined) updateEl('rover-temp',  `${Number(d.temp).toFixed(1)}°C`);
    if (d.hum   !== undefined) updateEl('rover-hum',   `${Number(d.hum).toFixed(0)}%`);
    if (d.ldr   !== undefined) updateEl('rover-ldr',   d.ldr);
    if (d.gas   !== undefined) updateEl('rover-gas',   d.gas);
    if (d.hall  !== undefined) updateEl('rover-hall',  d.hall);
    if (d.state !== undefined) {
        updateEl('rover-state', d.state);
        const el = document.getElementById('rover-state');
        if (el) el.className = 'card-value ' + ({
            MOVING: 'text-green', TURNING: 'text-cyan',
            OBSTACLE: 'text-red', ERROR: 'text-orange'
        }[d.state] || '');
    }
    if (d.mode !== undefined) updateEl('rover-mode', d.mode);
}

// ── Hexapod Telemetry ─────────────────────────────────────────
function aqiCat(a) {
    if (a <= 50)  return { label: 'GOOD',      color: '#10b981' };
    if (a <= 100) return { label: 'MODERATE',  color: '#f59e0b' };
    if (a <= 150) return { label: 'SENSITIVE', color: '#f97316' };
    if (a <= 200) return { label: 'UNHEALTHY', color: '#ef4444' };
    return               { label: 'HAZARDOUS', color: '#a855f7' };
}
function co2Lbl(c) {
    if (c < 600)  return 'FRESH';
    if (c < 1000) return 'NORMAL';
    if (c < 2000) return 'HIGH';
    return 'DANGER';
}
function updateHexTelemetry(d) {
    lastHexapodTelemetry = Date.now();
    triggerFlow('hexapod', 'satellite');
    if (!hexapodConnected) {
        hexapodConnected = true;
        updatePill('hexapod-status-pill', 'online', 'ONLINE');
        showTopo('hexapod');
    }
    if (d.temp !== undefined) updateEl('hex-temp', `${Number(d.temp).toFixed(1)}°C`);
    if (d.hum  !== undefined) updateEl('hex-hum',  `${Number(d.hum).toFixed(0)}%`);
    if (d.aqi !== undefined && d.co2 !== undefined) {
        const aqi = Number(d.aqi), co2 = Number(d.co2), cat = aqiCat(aqi);
        updateEl('hex-aqi-value', aqi);
        const ac = document.getElementById('hex-aqi-cat');
        if (ac) { ac.textContent = cat.label; ac.style.color = cat.color; }
        const ab = document.getElementById('hex-aqi-bar');
        if (ab) ab.style.width = Math.min(aqi / 300 * 100, 100) + '%';
        updateEl('hex-co2-value', co2 >= 9999 ? '>9999' : co2);
        const cb = document.getElementById('hex-co2-bar');
        if (cb) cb.style.width = Math.min(co2 / 5000 * 100, 100) + '%';
        updateEl('hex-co2-status', co2Lbl(co2));
    }
}

// ── Device Connect / Disconnect ───────────────────────────────
function onDeviceConn(d) {
    if (d === 'rover') {
        roverConnected = true;
        updatePill('rover-status-pill', 'online', 'ONLINE');
        addChat('SYSTEM', 'Rover linked to satellite', 'all', 'sys');
        showTopo('rover');
    } else if (d === 'hexapod') {
        hexapodConnected = true;
        updatePill('hexapod-status-pill', 'online', 'ONLINE');
        addChat('SYSTEM', 'Hexapod linked to satellite', 'all', 'sys');
        showTopo('hexapod');
    }
}
function onDeviceDisconn(d) {
    if (d === 'rover') {
        roverConnected = false;
        updatePill('rover-status-pill', 'offline', 'OFFLINE');
        addChat('SYSTEM', 'Rover disconnected', 'all', 'sys');
        hideTopo('rover');
    } else if (d === 'hexapod') {
        hexapodConnected = false;
        updatePill('hexapod-status-pill', 'offline', 'OFFLINE');
        addChat('SYSTEM', 'Hexapod disconnected', 'all', 'sys');
        hideTopo('hexapod');
    }
}

// ── Topology ──────────────────────────────────────────────────
function showTopo(d) {
    const ids = [
        'topo-node-' + d,
        d === 'rover' ? 'topo-line-sat-rover' : 'topo-line-sat-hex',
        d === 'rover' ? 'topo-hotspot-rover'  : 'topo-hotspot-hex',
    ];
    ids.forEach(id => { const e = document.getElementById(id); if (e) e.classList.remove('topo-hidden'); });
    if (roverConnected && hexapodConnected) {
        const c = document.getElementById('topo-line-rover-hex');
        if (c) c.classList.remove('topo-hidden');
    }
}
function hideTopo(d) {
    const ids = [
        'topo-node-' + d,
        d === 'rover' ? 'topo-line-sat-rover' : 'topo-line-sat-hex',
        d === 'rover' ? 'topo-hotspot-rover'  : 'topo-hotspot-hex',
    ];
    ids.forEach(id => { const e = document.getElementById(id); if (e) e.classList.add('topo-hidden'); });
    const c = document.getElementById('topo-line-rover-hex');
    if (c) c.classList.add('topo-hidden');
}

// ── Chat messages ─────────────────────────────────────────────
function onChatMsg(from, msg, to) {
    if ((from || '').toLowerCase() === 'mirror') {
        addChat('MIRROR -> DASHBOARD', msg, 'dashboard', 'mirror');
        return;
    }
    const src = (from || '').toLowerCase();
    const dst = (to   || '').toLowerCase();
    if ((src === 'rover' || src === 'hexapod') && (dst === 'rover' || dst === 'hexapod') && src !== dst) {
        triggerFlow(src, 'satellite');
        triggerFlow('satellite', dst);
    }
    addChat(from || 'unknown', msg, to || 'all', 'in');
}

// ── Topology flow animation ───────────────────────────────────
function triggerFlow(from, to) {
    const fl = document.getElementById('topo-flow-layer');
    if (!fl) return;
    const fp = TOPO_POS[from], tp = TOPO_POS[to];
    if (!fp || !tp) return;
    if (from !== 'satellite') {
        const n = document.getElementById('topo-node-' + from);
        if (!n || n.classList.contains('topo-hidden')) return;
    }
    if (to !== 'satellite') {
        const n = document.getElementById('topo-node-' + to);
        if (!n || n.classList.contains('topo-hidden')) return;
    }
    const key = `${from}>${to}`, now = Date.now();
    if (lastFlowTrigger[key] && now - lastFlowTrigger[key] < 600) return;
    lastFlowTrigger[key] = now;

    const color = from !== 'satellite' ? '#00ff88' : '#00f2ff';
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '5'); c.setAttribute('fill', color);
    c.setAttribute('cx', fp.x); c.setAttribute('cy', fp.y);
    c.style.filter = `drop-shadow(0 0 6px ${color})`;
    fl.appendChild(c);

    const dur = 700, t0 = performance.now();
    function step(ts) {
        const t = Math.min((ts - t0) / dur, 1);
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        c.setAttribute('cx', fp.x + (tp.x - fp.x) * e);
        c.setAttribute('cy', fp.y + (tp.y - fp.y) * e);
        if (t < 1) requestAnimationFrame(step);
        else if (fl.contains(c)) fl.removeChild(c);
    }
    requestAnimationFrame(step);
}

// ── UI helpers ────────────────────────────────────────────────
function updateEl(id, v)    { const e = document.getElementById(id); if (e) e.textContent = v; }
function updateBar(id, pct) { const e = document.getElementById(id); if (e) e.style.width = `${Math.min(100, Math.max(0, pct))}%`; }
function updatePill(id, cls, txt) { const e = document.getElementById(id); if (e) { e.className = `status-pill ${cls}`; e.textContent = txt; } }

// ── MPU Origin calibration ────────────────────────────────────
function setMpuOrigin() {
    mpuOrigin = { pitch: mpuCurrent.pitch, roll: mpuCurrent.roll };
    SAT3D.setRotation(0.15, 0, 0);   // snap model to neutral immediately
    const btn = document.getElementById('calibrate-btn');
    if (btn) {
        btn.textContent = '✓ ORIGIN SET';
        btn.classList.add('active');
        setTimeout(() => { btn.textContent = '⌖ SET ORIGIN'; btn.classList.remove('active'); }, 2000);
    }
}

// ── NeoPixel ──────────────────────────────────────────────────
let selStrip = -1;
const neoState = [
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 },
    { power: true, color: '#00f2ff', brightness: 128 },
];

function initNeo() {
    document.querySelectorAll('.neo-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.neo-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            selStrip = parseInt(tab.dataset.strip);
            syncNeoUI();
        });
    });

    const mp = document.getElementById('neo-master-power');
    if (mp) mp.addEventListener('change', () => {
        const p = mp.checked;
        if (selStrip === -1) { neoState.forEach(s => s.power = p); sendCmd('neopixel', { strip: -1, power: p }); }
        else                  { neoState[selStrip].power = p; sendCmd('neopixel', { strip: selStrip, power: p }); }
        updateNeoPrev();
    });

    const nc = document.getElementById('neo-color');
    if (nc) nc.addEventListener('input', () => {
        const v = nc.value;
        if (selStrip === -1) { neoState.forEach(s => s.color = v); sendCmd('neopixel', { strip: -1, color: v }); }
        else                  { neoState[selStrip].color = v; sendCmd('neopixel', { strip: selStrip, color: v }); }
        updateNeoPrev();
    });

    const nb = document.getElementById('neo-brightness');
    if (nb) nb.addEventListener('input', () => {
        const v = parseInt(nb.value);
        if (selStrip === -1) { neoState.forEach(s => s.brightness = v); sendCmd('neopixel', { strip: -1, brightness: v }); }
        else                  { neoState[selStrip].brightness = v; sendCmd('neopixel', { strip: selStrip, brightness: v }); }
        updateBrtLbl(v);
        updateNeoPrev();
    });

    document.querySelectorAll('.quick-color').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.dataset.color;
            const nc2 = document.getElementById('neo-color');
            if (nc2) nc2.value = v;
            if (selStrip === -1) { neoState.forEach(s => s.color = v); sendCmd('neopixel', { strip: -1, color: v }); }
            else                  { neoState[selStrip].color = v; sendCmd('neopixel', { strip: selStrip, color: v }); }
            updateNeoPrev();
        });
    });

    updateNeoPrev();
    updateBrtLbl(128);
}

function syncNeoUI() {
    const s = selStrip >= 0 ? neoState[selStrip] : neoState[0];
    const nc = document.getElementById('neo-color');
    const nb = document.getElementById('neo-brightness');
    const mp = document.getElementById('neo-master-power');
    if (nc) nc.value      = s.color;
    if (nb) nb.value      = s.brightness;
    if (mp) mp.checked    = s.power;
    updateBrtLbl(s.brightness);
}
function updateBrtLbl(v)  { const l = document.getElementById('neo-brt-label'); if (l) l.textContent = `${Math.round(v / 255 * 100)}%`; }
function updateNeoPrev()  {
    for (let i = 0; i < 4; i++) {
        const el = document.getElementById(`neo-prev-${i}`);
        if (!el) continue;
        if (neoState[i].power) {
            const op = 0.3 + (neoState[i].brightness / 255) * 0.7;
            el.style.background = neoState[i].color;
            el.style.boxShadow  = `0 0 12px ${neoState[i].color}60`;
            el.style.opacity    = op;
            el.classList.remove('off');
        } else {
            el.classList.add('off');
        }
    }
}

// ── Flaps & Servos ────────────────────────────────────────────
function initFlaps() {
    const fa = document.getElementById('flap-a');
    if (fa) fa.addEventListener('change', () => {
        sendCmd('flap', { panel: 'A', open: fa.checked });
        const a = fa.checked ? 90 : 0;
        const sl = document.getElementById('servo-a-slider');
        if (sl) { sl.value = a; document.getElementById('servo-a-val').textContent = a + '°'; }
    });
    const fb = document.getElementById('flap-b');
    if (fb) fb.addEventListener('change', () => {
        sendCmd('flap', { panel: 'B', open: fb.checked });
        const a = fb.checked ? 90 : 0;
        const sl = document.getElementById('servo-b-slider');
        if (sl) { sl.value = a; document.getElementById('servo-b-val').textContent = a + '°'; }
    });
}
function updateServoAngle(panel, value) {
    const a = parseInt(value);
    document.getElementById('servo-' + panel.toLowerCase() + '-val').textContent = a + '°';
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'command', target: 'servo', panel, angle: a }));
}

// ── D-Pad ─────────────────────────────────────────────────────
const cmdIv = {};
function initDPad() {
    document.querySelectorAll('.dpad-btn[data-cmd]').forEach(btn => {
        const dev = btn.dataset.device;
        const cmd = btn.dataset.cmd;
        if (cmd === 'stop') {
            btn.addEventListener('click', () => sendDevCmd(dev, 'stop'));
            return;
        }
        const press   = e => { e.preventDefault(); startCmd(dev, cmd, btn); };
        const release = e => { e.preventDefault(); stopCmdBtn(dev, btn); };
        btn.addEventListener('mousedown',  press);
        btn.addEventListener('mouseup',    release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('touchstart', press,   { passive: false });
        btn.addEventListener('touchend',   release, { passive: false });
    });
}
function startCmd(dev, cmd, btn) {
    stopCmdBtn(dev);
    btn.classList.add('pressed');
    sendDevCmd(dev, cmd);
    cmdIv[dev] = setInterval(() => sendDevCmd(dev, cmd), 150);
}
function stopCmdBtn(dev, btn) {
    if (cmdIv[dev]) { clearInterval(cmdIv[dev]); delete cmdIv[dev]; }
    if (btn) btn.classList.remove('pressed');
    if (dev !== 'hexapod') sendDevCmd(dev, 'stop');
}
function sendDevCmd(dev, cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', target: dev, command: cmd }));
        if (dev === 'rover' || dev === 'hexapod') triggerFlow('satellite', dev);
    }
}
function sendCmd(type, data) {
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'command', target: type, ...data }));
}

function initControls() { initNeo(); initFlaps(); initDPad(); }

// ── Device timeout detection ──────────────────────────────────
function initDeviceTimeouts() {
    setInterval(() => {
        const now = Date.now(), T = 15000;
        if (roverConnected   && lastRoverTelemetry   > 0 && (now - lastRoverTelemetry)   > T) {
            roverConnected = false;
            updatePill('rover-status-pill', 'offline', 'OFFLINE');
            addChat('SYSTEM', 'Rover telemetry timeout', 'all', 'sys');
        }
        if (hexapodConnected && lastHexapodTelemetry > 0 && (now - lastHexapodTelemetry) > T) {
            hexapodConnected = false;
            updatePill('hexapod-status-pill', 'offline', 'OFFLINE');
            addChat('SYSTEM', 'Hexapod telemetry timeout', 'all', 'sys');
        }
    }, 2000);
}

// ── Group Chat ────────────────────────────────────────────────
let chatRcpt = 'all';
function initGroupChat() {
    document.getElementById('rcpt-all')?.addEventListener('click',     () => setChatRcpt('all'));
    document.getElementById('rcpt-rover')?.addEventListener('click',   () => setChatRcpt('rover'));
    document.getElementById('rcpt-hexapod')?.addEventListener('click', () => setChatRcpt('hexapod'));
    addChat('SYSTEM', 'Group comms online — awaiting devices', 'all', 'sys');
}
function setChatRcpt(t) {
    chatRcpt = t;
    document.querySelectorAll('.chat-recipient-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('rcpt-' + t);
    if (btn) btn.classList.add('active');
}
function sendGroupChat() {
    const inp = document.getElementById('groupChatInput');
    if (!inp) return;
    const msg = inp.value.trim();
    if (!msg) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat', from: 'satellite', to: chatRcpt, msg }));
        addChat('SATELLITE RELAY', msg, chatRcpt, 'out');
        inp.value = '';
    } else {
        addChat('SYSTEM', 'Not connected to satellite', 'all', 'sys');
    }
}
function addChat(from, msg, to, dir) {
    const log = document.getElementById('groupChatLog');
    if (!log) return;
    const div = document.createElement('div');
    if (dir === 'sys') {
        div.className   = 'sat-chat-sys';
        div.textContent = `— ${msg} —`;
    } else {
        const dc = dir === 'out' ? 'sat-msg-out' : (dir === 'mirror' ? 'sat-msg-mirror' : 'sat-msg-in');
        div.className = 'sat-chat-msg ' + dc;
        const now = new Date();
        const t   = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
        const tl  = (to && to !== 'all' && dir !== 'mirror') ? ` → ${to.toUpperCase()} (VIA SAT)` : '';
        div.innerHTML =
            `<span class="sat-chat-from">${from.toUpperCase()}${tl}</span>` +
            `<span class="sat-chat-text">${msg}</span>` +
            `<span class="sat-chat-time">${t}</span>`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 60) log.removeChild(log.firstChild);
}

// ── Navigation ────────────────────────────────────────────────
function openRoverDashboard()   { window.location.href = 'rover.html'; }
function openHexapodDashboard() { window.location.href = 'hexapod.html'; }

// ── Legacy stubs ──────────────────────────────────────────────
function addLog() {}
function sendRoverCommand(c)   { sendDevCmd('rover',   c); }
function sendHexapodCommand(c) { sendDevCmd('hexapod', c); }

// ── Soft Reset ────────────────────────────────────────────────
function softReset() {
    const btn = document.getElementById('soft-reset-btn');
    if (btn && btn.classList.contains('busy')) return;
    if (!confirm('Soft-reset SATCOM-ALPHA?\n\nThe satellite will restart (~3 s). The dashboard will reconnect automatically.')) return;
    if (btn) { btn.textContent = '⟳ RESTARTING...'; btn.classList.add('busy'); btn.disabled = true; }
    addChat('SYSTEM', 'Soft reset requested — satellite restarting...', 'all', 'sys');
    fetch('/api/reset').catch(() => {}).finally(() => {
        setTimeout(() => {
            if (btn) { btn.textContent = '⟳ RESET SAT'; btn.classList.remove('busy'); btn.disabled = false; }
            addChat('SYSTEM', 'Satellite should be back — reconnecting...', 'all', 'sys');
        }, 8000);
    });
}
