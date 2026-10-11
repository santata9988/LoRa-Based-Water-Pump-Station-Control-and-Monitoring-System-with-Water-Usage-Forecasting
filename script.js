/* =====================================================================
   AquaGuard – ระบบควบคุมและติดตามสถานีปั๊มน้ำผ่านเครือข่าย LoRa
   ข้อมูลทั้งหมดในไฟล์นี้เป็นค่าจำลอง (demo)
   จุดที่ต้องเปลี่ยนเป็น API จริงมีป้ายกำกับ  >>> API  ไว้
   ===================================================================== */

// ---------------------------------------------------------------- helpers
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, "0");
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fmtDur  = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(Math.floor(s % 60))}`;
const nf      = n => Math.round(n).toLocaleString("th-TH");
const clamp   = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd     = () => Math.random();
const TH_DAY  = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const ago = sec => new Date(Date.now() - sec * 1000);
const timeAgo = d => {
    const s = Math.round((Date.now() - d) / 1000);
    if (s < 60)    return "เมื่อสักครู่";
    if (s < 3600)  return `เมื่อ ${Math.floor(s / 60)} นาทีที่แล้ว`;
    return `เมื่อ ${Math.floor(s / 3600)} ชั่วโมงที่แล้ว`;
};

// ---------------------------------------------------------------- config
const PUMP_FLOW  = 18.4;   // L/min ตอนปั๊มทำงานปกติ
const TANK_L     = 5000;   // ความจุถัง (ลิตร) ใช้ประเมินว่าน้ำพอใช้ไหม

// ---------------------------------------------------------------- state
const S = {
    level: 72, pump: true, mode: "auto",
    min: 30, max: 90,
    flowOut: PUMP_FLOW, flowIn: PUMP_FLOW, pressure: 2.8, current: 8.2,
    pumpSince: Date.now() - (2 * 3600 + 18 * 60 + 42) * 1000,
    lastOn: new Date(Date.now() - (2 * 3600 + 18 * 60 + 42) * 1000),
    loraOk: true, lastUpdate: Date.now(),
    latched: null,          // ความผิดปกติที่ทำให้ปั๊มหยุด ต้องรีเซ็ตก่อนใช้ต่อ
    inj: null,              // ความผิดปกติที่จำลองไว้ (โหมดทดสอบ)
    dryCnt: 0,
    active: new Map(),      // เงื่อนไขที่กำลังเกิดอยู่: key -> {sev,msg}
    alerts: [],             // ประวัติการแจ้งเตือน
    logs: [],               // ประวัติปั๊ม
    users: [
        { name: "admin",    role: "admin" },
        { name: "somchai",  role: "user"  },
        { name: "somying",  role: "user"  }
    ],
    live: { t: [], level: [], flow: [] }
};

// ---------------------------------------------------------------- history (seeded)
function seeded(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; }
const R = seeded(20261011);
const BASE = [140,110,90,90,120,300,620,780,600,430,380,440,520,470,420,450,560,720,820,680,480,330,220,160];
const WD   = [0.88, 1.0, 1.0, 1.0, 1.02, 1.05, 0.9];       // อา..ส

const HIST = [];   // HIST[i] = ใช้น้ำรายชั่วโมงของ "i วันก่อน" (0 = วันนี้)
for (let i = 0; i <= 28; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    HIST[i] = BASE.map(v => Math.round(v * WD[d.getDay()] * (0.92 + R() * 0.16)));
}
const dayDate  = i => { const d = new Date(); d.setDate(d.getDate() - i); return d; };
const dayTotal = i => HIST[i].reduce((a, b) => a + b, 0);
const sum      = a => a.reduce((x, y) => x + y, 0);
const mean     = a => sum(a) / a.length;
const nowH     = () => new Date().getHours();
// ใช้น้ำของวันนี้: นับถึงชั่วโมงปัจจุบัน (ชั่วโมงปัจจุบันนับตามสัดส่วนนาที)
function todayActual() {
    const h = nowH(), m = new Date().getMinutes();
    return HIST[0].map((v, i) => i < h ? v : i === h ? Math.round(v * m / 60) : null);
}

// ---------------------------------------------------------------- forecast (baseline)
function trend() {
    const a = mean([1, 2, 3, 4, 5, 6, 7].map(dayTotal));
    const b = mean([8, 9, 10, 11, 12, 13, 14].map(dayTotal));
    return clamp(a / b, 0.9, 1.15);
}
function forecastHour(h) { return mean([1, 2, 3, 4, 5, 6, 7].map(i => HIST[i][h])) * trend(); }
const forecastTomorrowHourly = () => BASE.map((_, h) => Math.round(forecastHour(h)));
function forecastDaily(k) {                         // k = 1..7 วันข้างหน้า
    const d = dayDate(-k), wd = d.getDay();
    const same = [];
    for (let i = 1; i <= 28; i++) if (dayDate(i).getDay() === wd) same.push(dayTotal(i));
    return { date: d, total: Math.round(mean(same) * trend()) };
}
function peakWindow(arr, w = 4) {
    let best = 0, at = 0;
    for (let h = 0; h <= 24 - w; h++) { const s = sum(arr.slice(h, h + w)); if (s > best) { best = s; at = h; } }
    return `${pad(at)}:00 – ${pad(at + w)}:00`;
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, kind = "") {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = "toast", 3200);
}

// ---------------------------------------------------------------- logs & alerts
function addLog(ev, by) {
    const run = ev.startsWith("ปิด") && S.pumpSince ? fmtDur((Date.now() - S.pumpSince) / 1000) : "–";
    S.logs.unshift({ t: new Date(), ev, by, run });
    if (S.logs.length > 50) S.logs.pop();
}
function addAlert(key, sev, title, detail = "") {
    S.alerts.unshift({ id: Date.now() + Math.random(), key, sev, title, detail, time: new Date(), ack: false });
    toast((sev === "danger" ? "🔴 " : "⚠️ ") + title, sev === "danger" ? "bad" : "warn");
}
function raise(key, sev, title, detail) {
    if (S.active.has(key)) return;
    S.active.set(key, { sev, title });
    addAlert(key, sev, title, detail);
}
function clearCond(key) { S.active.delete(key); }
const openAlerts = () => S.alerts.filter(a => !a.ack).length;
window.ackOne = id => { const a = S.alerts.find(x => x.id === id); if (a) a.ack = true; renderAlerts(); renderBadges(); };
window.ackAll = () => { S.alerts.forEach(a => a.ack = true); renderAlerts(); renderBadges(); };

// seed เหตุการณ์ตัวอย่าง (เหมือนต้นแบบเดิม)
S.alerts.push(
    { id: 1, key: "seed1", sev: "warning", title: "ระดับน้ำต่ำ", detail: "ระดับน้ำลดลงต่ำกว่า 30%", time: ago(12 * 60), ack: false },
    { id: 2, key: "seed2", sev: "danger",  title: "ตรวจพบความผิดปกติ", detail: "แรงดันน้ำตกอย่างรวดเร็ว", time: ago(2 * 3600), ack: false },
    { id: 3, key: "seed3", sev: "warning", title: "การเชื่อมต่อ LoRa หลุดชั่วคราว", detail: "กลับมาเชื่อมต่อได้เอง", time: ago(5 * 3600), ack: true }
);
S.logs.push(
    { t: ago(2 * 3600 + 18 * 60 + 42), ev: "เปิดปั๊มน้ำ", by: "ระบบอัตโนมัติ", run: "–" },
    { t: ago(4 * 3600 + 5 * 60),       ev: "ปิดปั๊มน้ำ", by: "ระบบอัตโนมัติ", run: "01:42:10" },
    { t: ago(5 * 3600 + 47 * 60),      ev: "เปิดปั๊มน้ำ", by: "ระบบอัตโนมัติ", run: "–" }
);

// ---------------------------------------------------------------- pump control  >>> API
function setPump(on, by) {
    if (S.pump === on) return;
    addLog(on ? "เปิดปั๊มน้ำ" : "ปิดปั๊มน้ำ", by);
    S.pump = on;
    if (on) { S.pumpSince = Date.now(); S.lastOn = new Date(); }
}
window.togglePump = function () {
    if (S.pump) return stopPump();
    if (!S.loraOk)  return toast("ส่งคำสั่งไม่ได้: LoRa ขาดการเชื่อมต่อ", "bad");
    if (S.latched)  return toast("มีความผิดปกติค้างอยู่ กรุณาตรวจสอบและรีเซ็ตก่อน", "bad");
    // fetch("/api/pump/start", { method: "POST" });
    setPump(true, "ผู้ดูแล (Admin)"); S.mode = "manual";
    toast("ส่งคำสั่งเปิดปั๊มน้ำแล้ว", "ok"); render();
};
window.stopPump = function () {
    if (!S.pump) return;
    if (!S.loraOk) return toast("ส่งคำสั่งไม่ได้: LoRa ขาดการเชื่อมต่อ", "bad");
    if (!confirm("คุณต้องการหยุดปั๊มน้ำหรือไม่?")) return;
    // fetch("/api/pump/stop", { method: "POST" });
    setPump(false, "ผู้ดูแล (Admin)"); S.mode = "manual";
    toast("ส่งคำสั่งหยุดปั๊มน้ำแล้ว", "ok"); render();
};
window.setMode = function (m) {
    S.mode = m;
    if (m === "auto") toast("กลับสู่โหมดอัตโนมัติ", "ok");
    render();
};
window.resetFault = function () {
    S.latched = null; S.inj = null; S.dryCnt = 0; S.active.clear();
    $("#injMsg").textContent = "ยังไม่มีการจำลองความผิดปกติ";
    toast("รีเซ็ตความผิดปกติแล้ว", "ok"); render();
};
window.inject = function (type) {
    S.inj = type;
    const names = { dry: "ปั๊มเดินแต่ไม่มีน้ำ", leak: "ท่อรั่ว", block: "ท่ออุดตัน", over: "กระแสเกิน", lora: "LoRa ขัดข้อง" };
    $("#injMsg").textContent = type ? `กำลังจำลอง: ${names[type]}` : "ยังไม่มีการจำลองความผิดปกติ";
    if (!type) { S.dryCnt = 0; S.active.delete("lora"); }
    if (type && !S.pump && type !== "lora") toast("ความผิดปกติจะแสดงเมื่อปั๊มทำงาน (เปิดปั๊มก่อน)", "warn");
};

// ---------------------------------------------------------------- simulation tick  >>> API (แทนด้วยข้อมูลจาก WebSocket / polling)
function tick() {
    // LoRa หลุด: ค่าค้าง ไม่อัปเดต
    if (S.inj === "lora") {
        S.loraOk = false;
        raise("lora", "danger", "การเชื่อมต่อ LoRa ขัดข้อง", "ไม่สามารถรับข้อมูลจาก LoRa Gateway ได้");
        render(); return;
    }
    S.loraOk = true; clearCond("lora"); S.lastUpdate = Date.now();

    const r = () => rnd() - 0.5;
    const demand = 0.35 + rnd() * 0.35;                          // น้ำที่ผู้ใช้ดึงออกจากถัง (%/tick)

    if (S.pump) {
        const i = S.inj;
        S.flowOut  = i === "dry" ? 0 : i === "block" ? 4 + rnd() * 2 : PUMP_FLOW + r() * 1.6;
        S.flowIn   = i === "leak" ? S.flowOut * 0.6 : Math.max(0, S.flowOut - rnd() * 0.4);
        S.pressure = i === "dry" ? 0.3 : i === "block" ? 4.1 : i === "leak" ? 1.2 : 2.8 + r() * 0.2;
        S.current  = i === "over" ? 13.6 : i === "dry" ? 3.1 : 8.2 + r() * 0.6;
        S.level   += 1.4 * (S.flowIn / PUMP_FLOW);
    } else {
        S.flowOut = S.flowIn = S.pressure = S.current = 0;
    }
    S.level = clamp(S.level - demand, 0, 100);

    // ---- ตรวจจับความผิดปกติแบบกำหนดเงื่อนไข
    let fault = null;
    if (S.pump) {
        S.dryCnt = S.flowOut < 1 ? S.dryCnt + 1 : 0;
        if (S.dryCnt >= 2)                                                   fault = ["dry",   "danger",  "ปั๊มทำงานแต่ไม่มีน้ำไหล (Dry Run)", "Flow Sensor = 0 ขณะปั๊มทำงาน"];
        else if (S.current > 12)                                             fault = ["over",  "danger",  "กระแสไฟฟ้าเกินกำหนด", `กระแส ${S.current.toFixed(1)} A (เกิน 12 A)`];
        else if (S.flowOut > 5 && Math.abs(S.flowOut - S.flowIn) / S.flowOut > 0.25) fault = ["leak", "danger", "ท่อแตก / น้ำรั่วซึม", "Flow ทางเข้า-ออกต่างกันผิดปกติ และแรงดันตก"];
        else if (S.pressure > 3.6 && S.flowOut < PUMP_FLOW * 0.5)            fault = ["block", "warning", "ท่ออุดตัน", "แรงดันสูงแต่อัตราการไหลลดลง"];
    }
    if (S.level >= 97) fault = ["overflow", "danger", "น้ำล้นถัง (Overflow)", "ระดับน้ำสูงเกินขีดความปลอดภัย"];

    if (fault) {
        raise(fault[0], fault[1], fault[2], fault[3]);
        S.latched = fault[0];
        if (S.pump) { setPump(false, "ระบบป้องกันอัตโนมัติ"); toast("ระบบหยุดปั๊มเพื่อความปลอดภัย", "bad"); }
    }

    // เตือนระดับน้ำ (ไม่หยุดปั๊ม)
    if (S.level < S.min) raise("low",  "warning", "ระดับน้ำต่ำ", `ระดับน้ำต่ำกว่า ${S.min}%`); else clearCond("low");
    if (S.level > S.max) raise("high", "warning", "ระดับน้ำสูงกว่าที่กำหนด", `ระดับน้ำสูงกว่า ${S.max}%`); else clearCond("high");

    // ---- ควบคุมอัตโนมัติ
    if (S.mode === "auto" && !S.latched) {
        if (S.level <= S.min) setPump(true,  "ระบบอัตโนมัติ");
        if (S.level >= S.max) setPump(false, "ระบบอัตโนมัติ");
    }

    // ---- เก็บค่าสำหรับกราฟสด
    const L = S.live; L.t.push(fmtTime(new Date()).slice(3)); L.level.push(+S.level.toFixed(1)); L.flow.push(+S.flowOut.toFixed(1));
    if (L.t.length > 30) { L.t.shift(); L.level.shift(); L.flow.shift(); }

    render();
}

// ---------------------------------------------------------------- rendering
function sensorState(kind) {
    const i = S.inj;
    if (!S.pump) return ["good", "● ปกติ (ปั๊มหยุด)"];
    if (kind === "flow")  return i === "dry" ? ["bad", "● ไม่มีน้ำไหล"] : i === "block" ? ["warn", "● ไหลน้อยผิดปกติ"] : i === "leak" ? ["warn", "● เข้า-ออกไม่เท่ากัน"] : ["good", "● ปกติ"];
    if (kind === "press") return S.pressure > 3.6 ? ["warn", "● แรงดันสูง"] : S.pressure < 1.5 ? ["bad", "● แรงดันตก"] : ["good", "● ปกติ"];
    if (kind === "amp")   return S.current > 12 ? ["bad", "● กระแสเกิน"] : ["good", "● ปกติ"];
    return ["good", "● ปกติ"];
}
function setSt(el, st) { el.className = "card-status " + st[0]; el.textContent = st[1]; }

function renderDashboard() {
    const lv = S.level;
    $("#lvVal").textContent = lv.toFixed(0);
    $("#lvBar").style.width = lv + "%";
    $("#lvNote").textContent = `${lv < S.min ? "ต่ำ" : lv > S.max ? "สูง" : "ปกติ"} · Min ${S.min}% / Max ${S.max}%`;
    $("#flowVal").textContent = S.flowOut.toFixed(1);
    $("#flowSub").textContent = `เข้าถัง ${S.flowIn.toFixed(1)} L/min`;
    $("#pressVal").textContent = S.pressure.toFixed(1);
    $("#ampVal").textContent = S.current.toFixed(1);
    setSt($("#flowSt"), sensorState("flow")); setSt($("#pressSt"), sensorState("press")); setSt($("#ampSt"), sensorState("amp"));

    // ปั๊ม
    const fault = !!S.latched;
    $("#pumpBadge").textContent = fault ? "● FAULT" : S.pump ? "● RUNNING" : "● STOPPED";
    $("#pumpBadge").className = "pump-on " + (fault ? "fault" : S.pump ? "" : "off");
    $("#pumpCircle").className = "pump-circle " + (fault ? "fault" : S.pump ? "" : "off");
    $("#pumpOnOff").textContent = fault ? "FAULT" : S.pump ? "ON" : "OFF";
    $("#pumpOnOffTh").textContent = fault ? "หยุดเพื่อความปลอดภัย" : S.pump ? "ทำงานอยู่" : "หยุดอยู่";
    $("#pumpMode").textContent = S.mode === "auto" ? "Automatic" : "Manual";
    $("#runLabel").textContent = S.pump ? "ทำงานมาแล้ว" : "หยุดมาแล้ว";
    const lastOff = S.logs.find(l => l.ev.startsWith("ปิด"));
    $("#pumpRun").textContent = S.pump ? fmtDur((Date.now() - S.pumpSince) / 1000)
        : lastOff ? fmtDur((Date.now() - lastOff.t) / 1000) : "--:--:--";
    $("#pumpLastOn").textContent = fmtTime(S.lastOn);
    const btn = $("#pumpBtn");
    btn.textContent = S.pump ? "⏹ หยุดปั๊มน้ำ" : "▶ เปิดปั๊มน้ำ";
    btn.className = S.pump ? "stop-button" : "start-button";
    $("#modeBtn").hidden = S.mode === "auto";
    $("#resetBtn").hidden = !S.latched;

    // ถัง
    $("#tankWater").style.height = lv + "%";
    $("#tankPct").textContent = lv.toFixed(0) + "%";
    $("#markMax").style.bottom = S.max + "%"; $("#markMin").style.bottom = S.min + "%";
    const tb = $("#tankBadge");
    tb.textContent = lv < S.min ? "Low" : lv > S.max ? "High" : "Normal";
    tb.className = "normal " + (lv < S.min || lv > S.max ? "warn" : "");
}

function renderStatusBar() {
    const crit = [...S.active.values()].find(a => a.sev === "danger");
    const warn = [...S.active.values()].find(a => a.sev === "warning");
    const box = $("#sysStatus");
    let cls = "", text = "ระบบทำงานปกติ", sub = "สถานีปั๊มน้ำ #01";
    if (S.latched || crit) { cls = "bad";  text = "ตรวจพบความผิดปกติ"; sub = (crit || warn || { title: "ปั๊มหยุดเพื่อความปลอดภัย" }).title; }
    else if (warn)         { cls = "warn"; text = "ควรตรวจสอบ";       sub = warn.title; }
    box.className = "system-status " + cls;
    $("#sysText").textContent = text; $("#sysSub").textContent = sub;
    $("#sysLora").textContent = S.loraOk ? "● LoRa Connected" : "● LoRa Disconnected";
    $("#sysLora").style.color = S.loraOk ? "" : "#e54848";
    $("#sysTime").textContent = "อัปเดตล่าสุด " + fmtTime(new Date(S.lastUpdate));
    $("#sysDot").className = "status-dot " + cls;

    $("#loraDot").className = "online-dot " + (S.loraOk ? "" : "off");
    $("#loraText").textContent = S.loraOk ? "LoRa Connected" : "LoRa Disconnected";
    $("#loraSub").textContent = `Last update ${Math.round((Date.now() - S.lastUpdate) / 1000)} sec ago`;
}

function renderBadges() {
    const n = openAlerts();
    $("#menuBadge").textContent = n; $("#menuBadge").hidden = n === 0;
    $("#bellBadge").textContent = n; $("#bellBadge").hidden = n === 0;
}

function alertHTML(a, withAck) {
    const icon = a.sev === "danger" ? "🔴" : "⚠️";
    return `<div class="alert ${a.sev === "danger" ? "danger" : "warning"} ${a.ack ? "acked" : ""}">
        <span>${icon}</span>
        <div><strong>${a.title}</strong>${a.detail ? `<em>${a.detail}</em>` : ""}<small>${timeAgo(a.time)} · ${fmtTime(a.time)}</small></div>
        ${withAck ? (a.ack ? `<i class="ok-tag">รับทราบแล้ว</i>` : `<button class="ack" onclick="ackOne(${a.id})">รับทราบ</button>`) : ""}
    </div>`;
}
function renderDashAlerts() {
    const list = S.alerts.filter(a => !a.ack).slice(0, 3);
    $("#dashAlerts").innerHTML = list.length ? list.map(a => alertHTML(a, false)).join("") : `<div class="empty">✔ ไม่มีการแจ้งเตือนที่รอการตรวจสอบ</div>`;
}
let alFilter = "all";
function renderAlerts() {
    const list = S.alerts.filter(a => alFilter === "all" || !a.ack);
    $("#alertSub").textContent = `ทั้งหมด ${S.alerts.length} รายการ · ยังไม่รับทราบ ${openAlerts()} รายการ`;
    $("#alertFull").innerHTML = list.length ? list.map(a => alertHTML(a, true)).join("") : `<div class="empty">ไม่มีรายการ</div>`;
    renderDashAlerts();
}

function renderMonitor() {
    const f = sensorState("flow"), p = sensorState("press"), a = sensorState("amp");
    const row = (n, pos, val, st) => `<tr><td>${n}</td><td>${pos}</td><td class="r"><b>${val}</b></td><td><span class="card-status ${st[0]}">${st[1]}</span></td></tr>`;
    $("#sensorTable").innerHTML =
        row("ระดับน้ำ (Ultrasonic)", "ถังเก็บน้ำ", S.level.toFixed(1) + " %", [S.level < S.min || S.level > S.max ? "warn" : "good", S.level < S.min ? "● ต่ำ" : S.level > S.max ? "● สูง" : "● ปกติ"]) +
        row("Flow Sensor #1", "ทางออกปั๊ม", S.flowOut.toFixed(1) + " L/min", f) +
        row("Flow Sensor #2", "ทางเข้าถัง", S.flowIn.toFixed(1) + " L/min", f) +
        row("Pressure Sensor", "ทางออกปั๊ม", S.pressure.toFixed(2) + " Bar", p) +
        row("Current Sensor", "สายไฟปั๊ม", S.current.toFixed(1) + " A", a);

    const diff = S.flowOut > 0 ? Math.abs(S.flowOut - S.flowIn) / S.flowOut * 100 : 0;
    $("#balanceBox").innerHTML = `<strong>สมดุลน้ำเข้า-ออก:</strong> ต่างกัน ${diff.toFixed(1)}% ` +
        `<span class="card-status ${diff > 25 ? "bad" : "good"}">${diff > 25 ? "● สงสัยน้ำรั่ว" : "● ปกติ"}</span>`;

    $("#pumpLogTable").innerHTML = S.logs.map(l => `<tr><td>${l.t.toLocaleDateString("th-TH", { day: "2-digit", month: "short" })} ${fmtTime(l.t)}</td><td>${l.ev}</td><td>${l.by}</td><td class="r">${l.run}</td></tr>`).join("");

    if (charts.live) { charts.live.data.labels = S.live.t; charts.live.data.datasets[0].data = S.live.level; charts.live.data.datasets[1].data = S.live.flow; charts.live.update("none"); }
}

function render() {
    renderDashboard(); renderStatusBar(); renderBadges();
    const v = currentView;
    if (v === "monitor") renderMonitor();
    if (v === "alerts") renderAlerts(); else renderDashAlerts();
}

// ---------------------------------------------------------------- charts
const charts = {};
const BLUE = "#0aa6df", ORANGE = "#e59a24", GRID = "#edf1f5";
function mk(key, canvasId, cfg) {
    if (typeof Chart === "undefined") return;           // ไม่ได้โหลด Chart.js (ออฟไลน์)
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart($("#" + canvasId), cfg);
}
const baseOpts = (extra = {}) => ({
    responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: true, grid: { color: GRID } }, x: { grid: { display: false } } }, ...extra
});

function periodData(p) {
    if (p === "today") {
        const act = todayActual(), h = nowH(), fc = BASE.map((_, i) => i >= h ? Math.round(forecastHour(i)) : null);
        if (act[h] !== null) fc[h] = act[h];
        return { labels: BASE.map((_, i) => pad(i) + ":00"), actual: act, forecast: fc, type: "line", unit: "ชั่วโมง" };
    }
    const n = +p, idx = [...Array(n).keys()].reverse();
    return {
        labels: idx.map(i => { const d = dayDate(i); return n <= 7 ? `${TH_DAY[d.getDay()]} ${d.getDate()}` : `${d.getDate()}/${d.getMonth() + 1}`; }),
        actual: idx.map(i => i === 0 ? sum(todayActual().filter(v => v !== null)) : dayTotal(i)),
        forecast: null, type: "bar", unit: "วัน"
    };
}
function buildDashChart() {
    const p = $("#period").value, d = periodData(p);
    $("#dashChartSub").textContent = p === "today" ? "รายชั่วโมง · เส้นประคือค่าพยากรณ์ที่เหลือของวัน" : `รายวัน ย้อนหลัง ${p} วัน`;
    const ds = [{ label: "ใช้น้ำจริง (L)", data: d.actual, borderColor: BLUE, backgroundColor: p === "today" ? "rgba(10,166,223,.12)" : "rgba(10,166,223,.75)", borderWidth: 3, tension: 0.4, fill: p === "today", pointRadius: 0, borderRadius: 4 }];
    if (d.forecast) ds.push({ label: "พยากรณ์ (L)", data: d.forecast, borderColor: ORANGE, borderDash: [6, 5], borderWidth: 3, tension: 0.4, pointRadius: 0, fill: false });
    mk("dash", "waterChart", { type: d.type, data: { labels: d.labels, datasets: ds }, options: baseOpts({ plugins: { legend: { display: !!d.forecast, position: "bottom" } } }) });
}

// ---- Analytics
let anPeriod = "today";
function buildAnalytics() {
    const d = periodData(anPeriod), act = d.actual;
    const real = act.filter(v => v !== null), total = sum(real);
    $("#anTotal").textContent = nf(total);
    $("#anTotalSub").textContent = anPeriod === "today" ? "นับถึงเวลาปัจจุบัน" : `ย้อนหลัง ${anPeriod} วัน`;
    $("#anAvgLabel").textContent = anPeriod === "today" ? "เฉลี่ยต่อชั่วโมง" : "เฉลี่ยต่อวัน";
    $("#anAvg").textContent = nf(total / real.length);
    const mi = act.indexOf(Math.max(...real));
    $("#anPeak").textContent = d.labels[mi];
    $("#anPeakSub").textContent = nf(act[mi]) + " ลิตร";
    $("#anRun").textContent = (total / (PUMP_FLOW * 60)).toFixed(1);
    $("#anColLabel").textContent = anPeriod === "today" ? "ชั่วโมง" : "วัน";
    $("#anTableSub").textContent = anPeriod === "today" ? "รายชั่วโมงของวันนี้" : `รายวัน ย้อนหลัง ${anPeriod} วัน`;
    const avg = total / real.length;
    $("#anTable").innerHTML = d.labels.map((l, i) => {
        if (act[i] === null) return "";
        const pc = (act[i] / avg - 1) * 100;
        return `<tr><td>${l}</td><td class="r">${nf(act[i])}</td><td class="r ${pc > 15 ? "up" : pc < -15 ? "down" : ""}">${pc >= 0 ? "+" : ""}${pc.toFixed(0)}%</td></tr>`;
    }).join("");
    mk("an", "anChart", { type: d.type, data: { labels: d.labels, datasets: [{ label: "ใช้น้ำ (L)", data: act, borderColor: BLUE, backgroundColor: d.type === "bar" ? "rgba(10,166,223,.75)" : "rgba(10,166,223,.12)", borderWidth: 3, tension: .4, fill: d.type === "line", pointRadius: 0, borderRadius: 4 }] }, options: baseOpts() });
}
window.exportCSV = function () {
    const d = periodData(anPeriod);
    const rows = ["label,liters", ...d.labels.map((l, i) => d.actual[i] === null ? null : `${l},${d.actual[i]}`).filter(Boolean)];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + rows.join("\n")], { type: "text/csv" }));
    a.download = `water-usage-${anPeriod}.csv`; a.click(); URL.revokeObjectURL(a.href);
    toast("ดาวน์โหลดไฟล์ CSV แล้ว", "ok");
};

// ---- Forecast
function buildForecast() {
    const hourly = forecastTomorrowHourly(), total = sum(hourly), avg7 = mean([1, 2, 3, 4, 5, 6, 7].map(dayTotal));
    const pc = (total / avg7 - 1) * 100, peak = peakWindow(hourly);
    // หน้า Dashboard
    $("#fcTotal").textContent = nf(total);
    const up = pc >= 0;
    $("#fcDelta").textContent = `${up ? "↑" : "↓"} ${Math.abs(pc).toFixed(1)}%`;
    $("#fcDelta").className = "forecast-up " + (up ? "" : "down");
    $("#fcText").textContent = `คาดว่าปริมาณการใช้น้ำจะ${up ? "สูงกว่า" : "ต่ำกว่า"}ค่าเฉลี่ย 7 วัน โดยใช้น้ำมากที่สุดช่วง ${peak}`;
    // หน้า Forecast
    $("#f2Total").textContent = nf(total);
    $("#f2Delta").textContent = `${up ? "↑" : "↓"} ${Math.abs(pc).toFixed(1)}% จากค่าเฉลี่ย`;
    $("#f2Delta").className = "card-status " + (up ? "warn" : "good");
    $("#f2Peak").textContent = peak;
    const ok = total < TANK_L * 1.6;      // ถังเติมได้หลายรอบต่อวัน: ประเมินคร่าว ๆ
    $("#f2Cap").textContent = ok ? "เพียงพอ" : "ควรเติมเพิ่ม";
    $("#f2CapSub").textContent = `ถัง ${nf(TANK_L)} L · ปั๊มเติมได้ ~${nf(PUMP_FLOW * 60)} L/ชม.`;
    $("#fcTable").innerHTML = [1, 2, 3, 4, 5, 6, 7].map(k => {
        const f = forecastDaily(k), p = (f.total / avg7 - 1) * 100;
        return `<tr><td>${TH_DAY[f.date.getDay()]} ${f.date.getDate()}/${f.date.getMonth() + 1}${k === 1 ? " (พรุ่งนี้)" : ""}</td><td class="r">${nf(f.total)}</td><td class="r ${p > 8 ? "up" : p < -8 ? "down" : ""}">${p >= 0 ? "+" : ""}${p.toFixed(0)}%</td></tr>`;
    }).join("");
    mk("fc", "fcChart", { type: "line", data: { labels: BASE.map((_, i) => pad(i) + ":00"), datasets: [
        { label: "พยากรณ์พรุ่งนี้", data: hourly, borderColor: ORANGE, borderDash: [6, 5], borderWidth: 3, tension: .4, pointRadius: 0 },
        { label: "วันนี้ (ใช้จริง)", data: todayActual(), borderColor: BLUE, backgroundColor: "rgba(10,166,223,.1)", fill: true, borderWidth: 3, tension: .4, pointRadius: 0 }
    ] }, options: baseOpts({ plugins: { legend: { display: true, position: "bottom" } } }) });
}

// ---- Monitor live chart
function buildLive() {
    mk("live", "liveChart", { type: "line", data: { labels: S.live.t, datasets: [
        { label: "ระดับน้ำ (%)", data: S.live.level, borderColor: BLUE, backgroundColor: "rgba(10,166,223,.1)", fill: true, borderWidth: 3, tension: .35, pointRadius: 0, yAxisID: "y" },
        { label: "Flow (L/min)", data: S.live.flow, borderColor: "#20b881", borderWidth: 2, tension: .35, pointRadius: 0, yAxisID: "y1" }
    ] }, options: baseOpts({ animation: false, plugins: { legend: { display: true, position: "bottom" } },
        scales: { y: { min: 0, max: 100, grid: { color: GRID } }, y1: { min: 0, max: 30, position: "right", grid: { display: false } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } } } }) });
}

// ---------------------------------------------------------------- settings
window.saveLimits = function (e) {
    e.preventDefault();
    const mn = +$("#inMin").value, mx = +$("#inMax").value, msg = $("#limitMsg");
    if (!(mn >= 5 && mx <= 95 && mn < mx - 9)) { msg.textContent = "Max ต้องมากกว่า Min อย่างน้อย 10% (Min ≥ 5, Max ≤ 95)"; msg.className = "form-msg bad"; return false; }
    S.min = mn; S.max = mx; msg.textContent = ""; // >>> API: PUT /api/settings/limits
    toast(`บันทึกแล้ว: เปิดที่ ${mn}% · ปิดที่ ${mx}%`, "ok"); render(); return false;
};
function renderUsers() {
    $("#userTable").innerHTML = "";
    S.users.forEach((u, i) => {
        const tr = document.createElement("tr");
        const td1 = document.createElement("td"); td1.textContent = u.name;         // textContent: กัน XSS
        const td2 = document.createElement("td"); td2.innerHTML = `<span class="tag ${u.role}">${u.role === "admin" ? "ผู้ดูแลระบบ" : "ผู้ใช้งานทั่วไป"}</span>`;
        const td3 = document.createElement("td"); td3.className = "r";
        if (u.name !== "admin") { const b = document.createElement("button"); b.className = "ack danger"; b.textContent = "ลบ"; b.onclick = () => { if (confirm(`ลบผู้ใช้ ${u.name}?`)) { S.users.splice(i, 1); renderUsers(); toast("ลบผู้ใช้แล้ว"); } }; td3.appendChild(b); }
        else td3.textContent = "–";
        tr.append(td1, td2, td3); $("#userTable").appendChild(tr);
    });
}
window.addUser = function (e) {
    e.preventDefault();
    const name = $("#uName").value.trim();
    if (!name) return false;
    if (S.users.some(u => u.name.toLowerCase() === name.toLowerCase())) { toast("มีชื่อผู้ใช้นี้แล้ว", "bad"); return false; }
    S.users.push({ name, role: $("#uRole").value }); $("#uName").value = ""; renderUsers(); toast("เพิ่มผู้ใช้แล้ว", "ok"); return false;
};

// ---------------------------------------------------------------- navigation
const VIEWS = {
    dashboard: ["Dashboard", "ภาพรวมสถานีปั๊มน้ำ"],
    monitor:   ["Water Monitor", "ติดตามค่าจากเซนเซอร์แบบเวลาจริง"],
    analytics: ["Analytics", "วิเคราะห์ข้อมูลการใช้น้ำย้อนหลัง"],
    forecast:  ["Forecast", "พยากรณ์ปริมาณการใช้น้ำ"],
    alerts:    ["Alerts", "การแจ้งเตือนและความผิดปกติ"],
    settings:  ["Settings", "ตั้งค่าระบบ ผู้ใช้งาน และโหมดทดสอบ"]
};
let currentView = "dashboard";
function show(v) {
    if (!VIEWS[v]) v = "dashboard";
    currentView = v;
    $$(".view").forEach(el => el.classList.toggle("active", el.id === "view-" + v));
    $$(".menu").forEach(el => el.classList.toggle("active", el.dataset.view === v));
    $("#pageTitle").textContent = VIEWS[v][0]; $("#pageSub").textContent = VIEWS[v][1];
    // สร้างกราฟเมื่อหน้านั้นแสดงแล้ว (Chart.js วัดขนาดไม่ได้ถ้าซ่อนอยู่)
    if (v === "dashboard") { buildDashChart(); buildForecast(); }
    if (v === "monitor")   buildLive();
    if (v === "analytics") buildAnalytics();
    if (v === "forecast")  buildForecast();
    if (v === "settings")  { $("#inMin").value = S.min; $("#inMax").value = S.max; updateModeSeg(); renderUsers(); }
    window.scrollTo(0, 0);
    render();
}
function updateModeSeg() { $$("#modeSeg button").forEach(b => b.classList.toggle("on", b.dataset.m === S.mode)); }
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
$("#bellBtn").onclick = () => { location.hash = "alerts"; };
$("#period").onchange = buildDashChart;
$$("#anSeg button").forEach(b => b.onclick = () => { anPeriod = b.dataset.p; $$("#anSeg button").forEach(x => x.classList.toggle("on", x === b)); buildAnalytics(); });
$$("#alSeg button").forEach(b => b.onclick = () => { alFilter = b.dataset.f; $$("#alSeg button").forEach(x => x.classList.toggle("on", x === b)); renderAlerts(); });
$$("#modeSeg button").forEach(b => b.onclick = () => { setMode(b.dataset.m); updateModeSeg(); });

// ---------------------------------------------------------------- start
for (let i = 0; i < 12; i++) { const t = new Date(Date.now() - (12 - i) * 2000); S.live.t.push(fmtTime(t).slice(3)); S.live.level.push(+(S.level - (12 - i) * 0.05).toFixed(1)); S.live.flow.push(PUMP_FLOW); }
show(location.hash.slice(1) || "dashboard");
setInterval(tick, 2000);          // >>> API: แทนด้วย fetch("/api/status") หรือ WebSocket
setInterval(() => { renderStatusBar(); if (currentView === "dashboard") renderDashboard(); }, 1000);   // นาฬิกา/ตัวจับเวลา