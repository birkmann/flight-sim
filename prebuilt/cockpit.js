// The flight deck of a flight (flight.js, src/sandbox/flight/): drawn from the `flight` part of the HUD state each
// frame, on the HUD's canvas (hud.js hands it over while a flight is on). With a modelled flight deck the displays go
// onto its screens instead (window.__flightScreens, called by displays.js), and the canvas has only the head-up
// display; the chase view keeps the middle of the view clear, its instruments in the corners.
//   airliner  primary flight display (tapes, attitude, flight mode annunciator, ILS scales, flight director),
//                       navigation display (arc: route, waypoints, top of descent, wind), engine and warning display,
//                       and a flight control unit and systems strip to click (Esc frees the mouse, a click on the view
//                       takes it back); the MCDU's flight plan page (DIR TO).
//   ga                  the six basic instruments, tachometer, fuel, flaps and trim, a GPS map with a course needle,
//                       and a two-axis autopilot.
// Plus the loading screen, the landing report, the flight path guide's cue, the callouts (radio altitude, V1, GPWS) and the engines' sound.
// Keys: I shows or hides the panel, N steps the map range, U opens the MCDU.
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  window.__cmds = window.__cmds || [];
  const send = (cmd) => window.__cmds.push(JSON.stringify(cmd));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  const pad3 = (n) => String(Math.round(((n % 360) + 360) % 360) || 360).padStart(3, "0");

  // Airbus-style display colours.
  const GREEN = "#3dff6e";
  const CYAN = "#3fe0ff";
  const MAGENTA = "#ff6bff";
  const AMBER = "#ffb000";
  const RED = "#ff3b30";
  const WHITE = "#f2f4f6";
  const YELLOW = "#ffe33d";
  const GREY = "#5b6470";
  const SKY = "#1f73d6";
  const EARTH = "#8a5a2b";

  let showPanel = true;
  let ndRange = 0; // 0: automatic
  const RANGES = [10, 20, 40, 80, 160, 320];
  let g = null;

  // ---- drawing helpers ------------------------------------------------------------------------------------------
  function font(px, weight = 600) {
    g.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  }
  function text(s, x, y, color = WHITE, align = "left", base = "middle") {
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = base;
    g.fillText(s, x, y);
  }
  function line(x1, y1, x2, y2, color = WHITE, w = 1.5) {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }
  function rect(x, y, w, h, fill) {
    g.fillStyle = fill;
    g.fillRect(x, y, w, h);
  }
  function frame(x, y, w, h, color = WHITE, lw = 1.5) {
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.strokeRect(x, y, w, h);
  }
  function tri(x1, y1, x2, y2, x3, y3, color, fill = true) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.lineTo(x3, y3);
    g.closePath();
    if (fill) {
      g.fillStyle = color;
      g.fill();
    } else {
      g.strokeStyle = color;
      g.stroke();
    }
  }
  function screen(x, y, w, h) {
    rect(x, y, w, h, "#05080c");
    frame(x + 0.5, y + 0.5, w - 1, h - 1, "#1b232d", 1);
  }
  /** Red and black stripes (a speed limit's barber pole). */
  function barber(x, y, w, h) {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    rect(x, y, w, h, "#000");
    for (let yy = y - w; yy < y + h + w; yy += w * 2) {
      g.fillStyle = RED;
      g.beginPath();
      g.moveTo(x, yy);
      g.lineTo(x + w, yy - w);
      g.lineTo(x + w, yy);
      g.lineTo(x, yy + w);
      g.fill();
    }
    g.restore();
  }

  // ---- primary flight display -------------------------------------------------------------------------------------
  function fma(f, x, y, w, h) {
    const a = f.ap;
    const col = w / 5;
    for (let i = 1; i < 5; i++) line(x + col * i, y + 3, x + col * i, y + h - 3, GREY, 1);
    font(Math.max(9, h * 0.32));
    const cell = (i, row, s, color) => s && text(s, x + col * (i + 0.5), y + h * (row ? 0.72 : 0.3), color, "center");
    const thr = a.thr === "A/THR" ? "" : a.thr;
    cell(0, 0, thr, thr === "RETARD" ? WHITE : GREEN);
    if (!a.athr && f.onGround && f.eng.lever > 0.85) cell(0, 0, f.eng.lever > 0.97 ? "TOGA" : "FLX", WHITE);
    cell(1, 0, a.vert, GREEN);
    cell(1, 1, a.vertArmed, CYAN);
    cell(2, 0, a.lat, GREEN);
    cell(2, 1, a.latArmed || (a.lat === "RWY" ? "NAV" : ""), CYAN);
    if (a.appr) {
      cell(3, 0, a.ap ? "CAT 3" : "CAT 1", WHITE);
      cell(3, 1, a.ap ? "DUAL" : "", WHITE);
    }
    cell(4, 0, a.ap ? "AP1" : "", WHITE);
    cell(4, 1, `${a.fd ? "1FD2" : ""}`, WHITE);
    if (a.athr) text("A/THR", x + col * 4.5, y + h * 1.12, a.thr === "A/THR" ? CYAN : WHITE, "center");
  }

  function pfd(f, x, y, sz) {
    screen(x, y, sz, sz);
    const fmaH = sz * 0.1;
    fma(f, x, y, sz, fmaH);
    const cx = x + sz * 0.47;
    const cy = y + sz * 0.49;
    const aw = sz * 0.28;
    const ah = sz * 0.3;
    const ppd = sz * 0.011;
    // Attitude.
    g.save();
    g.beginPath();
    g.rect(cx - aw, cy - ah, aw * 2, ah * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-rad(f.bank));
    g.translate(0, f.pitch * ppd);
    rect(-sz, -sz * 2, sz * 2, sz * 2, SKY);
    rect(-sz, 0, sz * 2, sz * 2, EARTH);
    line(-sz, 0, sz, 0, WHITE, 2);
    font(sz * 0.032);
    for (let p = -30; p <= 30; p += 2.5) {
      if (!p) continue;
      const yy = -p * ppd;
      const major = p % 10 === 0;
      const half = p % 5 === 0 ? (major ? sz * 0.09 : sz * 0.045) : sz * 0.02;
      line(-half, yy, half, yy, WHITE, 1.4);
      if (major) {
        text(String(Math.abs(p)), -half - 4, yy, WHITE, "right");
        text(String(Math.abs(p)), half + 4, yy, WHITE, "left");
      }
    }
    g.restore();
    // Bank scale and pointer, sideslip index.
    g.save();
    g.translate(cx, cy);
    const br = ah * 0.95;
    g.strokeStyle = WHITE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(0, 0, br, rad(-90 - 45), rad(-90 + 45));
    g.stroke();
    for (const b of [-45, -30, -20, -10, 10, 20, 30, 45]) {
      const a = rad(b - 90);
      const l = Math.abs(b) % 30 === 0 ? 10 : 6;
      line(Math.cos(a) * br, Math.sin(a) * br, Math.cos(a) * (br + l), Math.sin(a) * (br + l), WHITE, 1.5);
    }
    tri(0, -br, -6, -br - 9, 6, -br - 9, YELLOW);
    g.rotate(-rad(f.bank));
    tri(0, -br + 1, -7, -br + 11, 7, -br + 11, Math.abs(f.bank) > 33 ? AMBER : YELLOW);
    const slip = clamp(f.beta * 3, -14, 14);
    rect(-7 + slip, -br + 13, 14, 4, Math.abs(f.beta) > 5 ? AMBER : YELLOW);
    g.restore();
    // Flight director.
    if (f.ap.fd && (!f.onGround || f.ap.vert === "SRS")) {
      const dx = clamp((f.ap.fdBank - rad(f.bank)) * 90, -aw * 0.8, aw * 0.8);
      const dy = clamp(-f.ap.fdPitch * 57.3 * ppd, -ah * 0.8, ah * 0.8);
      line(cx + dx, cy - ah * 0.55, cx + dx, cy + ah * 0.55, GREEN, 2.5);
      line(cx - aw * 0.55, cy + dy, cx + aw * 0.55, cy + dy, GREEN, 2.5);
    }
    // Flight path vector: where the aircraft is going.
    if (!f.onGround && f.gs > 40) {
      const vx = cx + clamp(wrap180(f.trk - f.hdg) * ppd, -aw, aw);
      const vy = cy - clamp((f.fpa - f.pitch) * ppd, -ah, ah);
      g.strokeStyle = GREEN;
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(vx, vy, 5, 0, Math.PI * 2);
      g.stroke();
      line(vx - 14, vy, vx - 5, vy, GREEN, 1.6);
      line(vx + 5, vy, vx + 14, vy, GREEN, 1.6);
      line(vx, vy - 5, vx, vy - 11, GREEN, 1.6);
    }
    // The aircraft.
    const wing = sz * 0.12;
    g.lineWidth = 5;
    g.strokeStyle = "#000";
    g.beginPath();
    g.moveTo(cx - wing * 1.6, cy);
    g.lineTo(cx - wing * 0.6, cy);
    g.lineTo(cx - wing * 0.6, cy + 9);
    g.moveTo(cx + wing * 1.6, cy);
    g.lineTo(cx + wing * 0.6, cy);
    g.lineTo(cx + wing * 0.6, cy + 9);
    g.stroke();
    g.lineWidth = 3;
    g.strokeStyle = YELLOW;
    g.stroke();
    rect(cx - 3, cy - 3, 6, 6, YELLOW);
    // Radio altitude.
    if (f.ra < 2500) {
      font(sz * 0.05, 700);
      text(String(f.ra < 50 ? Math.round(f.ra) : Math.round(f.ra / 10) * 10), cx, cy + ah * 0.78, f.ra < 200 ? AMBER : GREEN, "center");
    }
    ils(f, cx, cy, aw, ah, sz);
    speedTape(f, x + sz * 0.02, y + fmaH + sz * 0.05, sz * 0.14, sz * 0.72, sz);
    altTape(f, x + sz * 0.8, y + fmaH + sz * 0.05, sz * 0.12, sz * 0.72, sz);
    vsi(f, x + sz * 0.93, y + fmaH + sz * 0.1, sz * 0.06, sz * 0.62, sz);
    headingTape(f, cx, y + sz * 0.9, aw * 2, sz * 0.08, sz);
    // Warnings on the display itself.
    font(sz * 0.045, 800);
    if (f.warnings.includes("STALL")) text("STALL", cx, cy - ah * 0.45, RED, "center");
    if (f.warnings.includes("PULL UP")) text("PULL UP", cx, cy + ah * 0.35, RED, "center");
  }

  function ils(f, cx, cy, aw, ah, sz) {
    const i = f.ils;
    if (!i || !(f.ap.loc || f.ap.appr || f.phase === "approach") || !i.locValid) return;
    font(sz * 0.032);
    text(`${i.ident}`, cx - aw, cy + ah + sz * 0.035, MAGENTA);
    text(`${i.dme.toFixed(1)} NM`, cx - aw, cy + ah + sz * 0.07, MAGENTA);
    // Localizer: under the attitude; glide slope: to its right.
    const dot = aw * 0.3;
    for (const d of [-2, -1, 1, 2]) {
      g.strokeStyle = WHITE;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(cx + d * dot, cy + ah + 10, 3, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(cx + aw + 12, cy + d * ah * 0.3, 3, 0, Math.PI * 2);
      g.stroke();
    }
    line(cx, cy + ah + 3, cx, cy + ah + 17, YELLOW, 2);
    const lx = cx + clamp(i.loc, -2.3, 2.3) * dot;
    diamond(lx, cy + ah + 10, 9, 5, Math.abs(i.loc) >= 2.3 ? null : MAGENTA);
    if (i.gsValid) {
      const gy = cy - clamp(i.gs, -2.3, 2.3) * ah * 0.3;
      diamond(cx + aw + 12, gy, 5, 9, Math.abs(i.gs) >= 2.3 ? null : MAGENTA);
    }
  }
  function diamond(x, y, rx, ry, fill) {
    g.beginPath();
    g.moveTo(x - rx, y);
    g.lineTo(x, y - ry);
    g.lineTo(x + rx, y);
    g.lineTo(x, y + ry);
    g.closePath();
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    } else {
      g.strokeStyle = MAGENTA;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  function speedTape(f, x, y, w, h, sz) {
    rect(x, y, w, h, "#29313b");
    const mid = y + h / 2;
    const span = 84;
    const k = h / span;
    const ys = (v) => mid - (v - f.ias) * k;
    g.save();
    g.beginPath();
    g.rect(x, y, w + 12, h);
    g.clip();
    font(sz * 0.036);
    for (let v = Math.floor((f.ias - span / 2) / 10) * 10; v <= f.ias + span / 2; v += 10) {
      if (v < 30) continue;
      const yy = ys(v);
      line(x + w - 8, yy, x + w, yy, WHITE, 1.4);
      if (v % 20 === 0) text(String(v), x + w - 11, yy, WHITE, "right");
    }
    // Limits: the maximum speed's barber pole above, the stall's below, the lowest selectable speed in amber.
    const vmaxY = ys(f.vmax);
    if (vmaxY > y) barber(x + w - 5, y, 5, vmaxY - y);
    if (!f.onGround) {
      const vsY = ys(f.vstall);
      if (vsY < y + h) barber(x + w - 5, vsY, 5, y + h - vsY);
      const vlsY = ys(f.vls);
      if (vlsY < vsY) rect(x + w - 3, vlsY, 3, vsY - vlsY, AMBER);
    }
    const vsp = f.vspeeds;
    font(sz * 0.032, 700);
    if (f.onGround) {
      text("1", x + w + 3, ys(vsp.v1), CYAN);
      text("R", x + w + 3, ys(vsp.vr), CYAN);
    } else if (f.panel === "airliner") {
      // Flap retraction and the clean manoeuvring speed.
      if (f.flap.lever >= 2) text("F", x + w + 3, ys(vsp.f_speed), GREEN);
      else if (f.flap.lever === 1) text("S", x + w + 3, ys(vsp.s_speed), GREEN);
      else {
        g.strokeStyle = GREEN;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x + w + 5, ys(vsp.green_dot), 3.5, 0, Math.PI * 2);
        g.stroke();
      }
      if (f.vfeNext) text("=", x + w + 3, ys(f.vfeNext), AMBER);
    }
    // Target speed.
    const tgt = f.ap.targetMach ? f.ias * (f.ap.targetMach / Math.max(0.1, f.mach)) : f.ap.target || f.ap.spd;
    const managed = f.ap.spdManaged || f.ap.vert === "SRS" || f.phase === "approach";
    const ty = ys(tgt);
    if (ty > y && ty < y + h) tri(x + w, ty, x + w + 10, ty - 6, x + w + 10, ty + 6, managed ? MAGENTA : CYAN);
    g.restore();
    if (ty <= y || ty >= y + h) {
      font(sz * 0.034, 700);
      const ly = ty <= y ? y + 9 : y + h - 9;
      rect(x, ly - 8, w, 16, "#000");
      text(Math.round(tgt), x + w / 2, ly, managed ? MAGENTA : CYAN, "center");
    }
    // Trend: where the speed will be in 10 s.
    if (Math.abs(f.accel) > 0.2) {
      const ty2 = mid - f.accel * 10 * k;
      line(x + w - 2, mid, x + w - 2, ty2, YELLOW, 2);
      tri(x + w - 2, ty2, x + w - 6, ty2 + Math.sign(f.accel) * 7, x + w + 2, ty2 + Math.sign(f.accel) * 7, YELLOW);
    }
    line(x, mid, x + w + 6, mid, YELLOW, 2.5);
    rect(x - 2, mid - sz * 0.03, w * 0.72, sz * 0.06, "#000");
    frame(x - 2, mid - sz * 0.03, w * 0.72, sz * 0.06, YELLOW, 1.4);
    font(sz * 0.042, 700);
    text(String(Math.round(f.ias)), x + w * 0.68, mid, f.warnings.includes("OVERSPEED") ? RED : GREEN, "right");
    if (f.mach > 0.45) {
      font(sz * 0.036, 700);
      text(`.${String(Math.round(f.mach * 1000)).padStart(3, "0").slice(0, 3)}`.replace(/^\.1/, "1."), x + w / 2, y + h + sz * 0.035, GREEN, "center");
    }
  }

  function altTape(f, x, y, w, h, sz) {
    rect(x, y, w, h, "#29313b");
    const mid = y + h / 2;
    const span = 1100;
    const k = h / span;
    const ys = (a) => mid - (a - f.alt) * k;
    g.save();
    g.beginPath();
    g.rect(x - 12, y, w + 12, h);
    g.clip();
    // The ground, when it is close.
    if (f.ra < 1200) {
      const gy = ys(f.alt - f.ra);
      if (gy < y + h) rect(x, gy, w, y + h - gy, "#6b2b1c");
    }
    font(sz * 0.032);
    for (let a = Math.floor((f.alt - span / 2) / 100) * 100; a <= f.alt + span / 2; a += 100) {
      const yy = ys(a);
      line(x, yy, x + (a % 500 === 0 ? 10 : 6), yy, WHITE, 1.4);
      if (a % 500 === 0) text(String(Math.round(a / 100)).padStart(3, "0"), x + 12, yy, WHITE);
    }
    const sel = f.ap.alt;
    const sy = ys(sel);
    const managedAlt = f.ap.vert === "CLB" || f.ap.vert === "DES";
    if (sy > y && sy < y + h) {
      g.strokeStyle = managedAlt ? MAGENTA : CYAN;
      g.lineWidth = 2;
      g.strokeRect(x - 6, sy - 9, 8, 18);
    }
    g.restore();
    font(sz * 0.034, 700);
    if (sy <= y || sy >= y + h) {
      // Off the scale: at its end, inside the tape.
      const ly = sy <= y ? y + 9 : y + h - 9;
      rect(x, ly - 8, w, 16, "#000");
      text(sel >= 18000 ? `FL${Math.round(sel / 100)}` : String(Math.round(sel)), x + w / 2, ly, managedAlt ? MAGENTA : CYAN, "center");
    }
    rect(x - 4, mid - sz * 0.03, w + 8, sz * 0.06, "#000");
    frame(x - 4, mid - sz * 0.03, w + 8, sz * 0.06, YELLOW, 1.4);
    font(sz * 0.04, 700);
    text(String(Math.round(f.alt / 10) * 10), x + w + 2, mid, GREEN, "right");
    font(sz * 0.03);
    text(f.alt > 18000 ? "STD" : "QNH", x + w / 2, y + h + sz * 0.035, CYAN, "center");
  }

  function vsi(f, x, y, w, h, sz) {
    rect(x, y, w, h, "#29313b");
    const mid = y + h / 2;
    // Non-linear: fine about level, compressed toward ±6,000 ft/min.
    const scale = (vs) => Math.sign(vs) * (1 - Math.exp(-Math.abs(vs) / 1500)) / (1 - Math.exp(-4)) * (h / 2 - 4);
    font(sz * 0.025);
    for (const v of [1000, 2000, 6000]) {
      line(x, mid - scale(v), x + 5, mid - scale(v), WHITE, 1.2);
      line(x, mid + scale(v), x + 5, mid + scale(v), WHITE, 1.2);
      text(String(v / 1000), x + 7, mid - scale(v), WHITE);
      text(String(v / 1000), x + 7, mid + scale(v), WHITE);
    }
    const vs = clamp(f.vs, -6000, 6000);
    const color = Math.abs(f.vs) > 6000 || (f.ra < 2500 && f.vs < -2000) ? AMBER : GREEN;
    line(x + w, mid, x + 2, mid - scale(vs), color, 2.5);
    if (Math.abs(f.vs) > 200) {
      font(sz * 0.03, 700);
      text(String(Math.round(Math.abs(f.vs) / 100)).padStart(2, "0"), x + w / 2, vs > 0 ? y - 6 : y + h + 6, color, "center");
    }
  }

  function headingTape(f, cx, y, w, h, sz) {
    rect(cx - w / 2, y, w, h, "#29313b");
    const k = w / 50;
    g.save();
    g.beginPath();
    g.rect(cx - w / 2, y, w, h);
    g.clip();
    font(sz * 0.03);
    for (let d = Math.floor(f.hdg / 5) * 5 - 30; d <= f.hdg + 30; d += 5) {
      const xx = cx + wrap180(d - f.hdg) * k;
      line(xx, y, xx, y + (d % 10 === 0 ? 8 : 4), WHITE, 1.3);
      if (d % 10 === 0) text(String(((d % 360) + 360) % 360 / 10), xx, y + h * 0.62, WHITE, "center");
    }
    // Selected heading, track, ILS course.
    if (f.ap.lat === "HDG") {
      const hx = cx + clamp(wrap180(f.ap.hdg - f.hdg), -25, 25) * k;
      tri(hx, y + 1, hx - 6, y - 8, hx + 6, y - 8, CYAN);
    }
    const tx = cx + wrap180(f.trk - f.hdg) * k;
    diamond(tx, y + 5, 4, 5, null);
    g.strokeStyle = GREEN;
    if (f.ils && f.ils.locValid && f.phase === "approach") {
      const ix = cx + clamp(wrap180(f.ils.crs - f.hdg), -25, 25) * k;
      line(ix, y, ix, y + h * 0.4, MAGENTA, 3);
    }
    g.restore();
    line(cx, y - 6, cx, y + h * 0.45, YELLOW, 2.5);
  }

  // ---- navigation display -----------------------------------------------------------------------------------------
  function ndProject(f, lat, lon, scale) {
    const k = Math.cos(rad(f.lat));
    const dx = (lon - f.lon) * 60 * k;
    const dy = (lat - f.lat) * 60;
    const h = rad(f.hdg);
    return [(dx * Math.cos(h) - dy * Math.sin(h)) * scale, -(dx * Math.sin(h) + dy * Math.cos(h)) * scale];
  }

  function nd(f, x, y, sz) {
    screen(x, y, sz, sz);
    const cx = x + sz / 2;
    const cy = y + sz * 0.8;
    const r = sz * 0.66;
    const range = ndRange || RANGES.find((rr) => rr >= (f.wp ? f.wp.dist * 1.3 : 20)) || 320;
    const scale = r / range;
    g.save();
    g.beginPath();
    g.rect(x + 1, y + 1, sz - 2, sz - 2);
    g.clip();
    // Compass arc.
    g.strokeStyle = WHITE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, r, rad(-90 - 50), rad(-90 + 50));
    g.stroke();
    font(sz * 0.035);
    for (let d = 0; d < 360; d += 5) {
      const off = wrap180(d - f.hdg);
      if (Math.abs(off) > 50) continue;
      const a = rad(off - 90);
      const l = d % 10 === 0 ? 10 : 5;
      line(cx + Math.cos(a) * r, cy + Math.sin(a) * r, cx + Math.cos(a) * (r - l), cy + Math.sin(a) * (r - l), WHITE, 1.4);
      if (d % 30 === 0) text(String(d / 10), cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20), WHITE, "center");
    }
    // Half-range ring.
    g.setLineDash([3, 5]);
    g.strokeStyle = GREY;
    g.beginPath();
    g.arc(cx, cy, r / 2, rad(-90 - 60), rad(-90 + 60));
    g.stroke();
    g.setLineDash([]);
    font(sz * 0.03);
    text(String(range / 2), cx - r / 2 * 0.7 - 6, cy - r / 2 * 0.7, CYAN, "right");
    // Airports: the runways at scale.
    for (const ap of [f.dep, f.arr]) {
      if (!ap) continue;
      const [ax, ay] = ndProject(f, ap.lat, ap.lon, scale);
      const [bx, by] = ndProject(f, ap.lat2, ap.lon2, scale);
      line(cx + ax, cy + ay, cx + bx, cy + by, WHITE, 3);
      text(ap.icao, cx + ax + 8, cy + ay + 10, WHITE);
    }
    // The route: green, the active waypoint white.
    const w = f.route.wpts;
    const act = f.route.active;
    g.strokeStyle = GREEN;
    g.lineWidth = 2;
    g.beginPath();
    let first = true;
    const [px, py] = [0, 0];
    g.moveTo(cx + px, cy + py);
    for (let i = act; i < w.length; i++) {
      const [wx, wy] = ndProject(f, w[i].lat, w[i].lon, scale);
      if (first) {
        g.lineTo(cx + wx, cy + wy);
        first = false;
      } else g.lineTo(cx + wx, cy + wy);
    }
    g.stroke();
    for (let i = act; i < w.length; i++) {
      const [wx, wy] = ndProject(f, w[i].lat, w[i].lon, scale);
      const color = i === act ? WHITE : GREEN;
      if (w[i].kind === "navaid") {
        g.strokeStyle = color;
        g.beginPath();
        for (let k = 0; k < 6; k++) g[k ? "lineTo" : "moveTo"](cx + wx + 6 * Math.cos((k * Math.PI) / 3), cy + wy + 6 * Math.sin((k * Math.PI) / 3));
        g.closePath();
        g.stroke();
      } else {
        g.save();
        g.translate(cx + wx, cy + wy);
        g.rotate(Math.PI / 4);
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.strokeRect(-4, -4, 8, 8);
        g.restore();
      }
      font(sz * 0.032);
      text(w[i].id, cx + wx + 9, cy + wy - 2, color);
      if (w[i].alt) text(w[i].alt >= 18000 ? `FL${Math.round(w[i].alt / 100)}` : String(w[i].alt), cx + wx + 9, cy + wy + sz * 0.035, MAGENTA);
    }
    // Top of descent.
    if (f.tod && f.dtg > f.todDtg) {
      const [tx, ty] = ndProject(f, f.tod[0], f.tod[1], scale);
      text("(T/D)", cx + tx, cy + ty, WHITE, "center");
    }
    g.restore();
    // The aircraft.
    g.lineWidth = 3;
    line(cx, cy - 12, cx, cy + 14, YELLOW, 3);
    line(cx - 12, cy - 2, cx + 12, cy - 2, YELLOW, 3);
    line(cx - 5, cy + 12, cx + 5, cy + 12, YELLOW, 3);
    // Heading index, track, selected heading.
    tri(cx, cy - r + 1, cx - 7, cy - r - 11, cx + 7, cy - r - 11, YELLOW);
    const ta = rad(wrap180(f.trk - f.hdg) - 90);
    diamond(cx + Math.cos(ta) * (r - 4), cy + Math.sin(ta) * (r - 4), 4, 6, null);
    if (f.ap.lat === "HDG") {
      const ha = rad(clamp(wrap180(f.ap.hdg - f.hdg), -50, 50) - 90);
      tri(cx + Math.cos(ha) * r, cy + Math.sin(ha) * r, cx + Math.cos(ha - 0.05) * (r + 12), cy + Math.sin(ha - 0.05) * (r + 12), cx + Math.cos(ha + 0.05) * (r + 12), cy + Math.sin(ha + 0.05) * (r + 12), CYAN);
    }
    // Data: ground speed, true airspeed, wind; the active waypoint.
    font(sz * 0.036, 700);
    text(`GS ${Math.round(f.gs)}  TAS ${Math.round(f.tas)}`, x + 8, y + 14, WHITE);
    const wd = f.wind;
    text(`${pad3(wd.from)}/${Math.round(wd.kt)}`, x + 8, y + 32, GREEN);
    if (wd.kt > 1) {
      const a = rad(wd.from + 180 - f.hdg);
      const ax = x + 22;
      const ay = y + 58;
      line(ax - Math.sin(a) * 10, ay + Math.cos(a) * 10, ax + Math.sin(a) * 10, ay - Math.cos(a) * 10, GREEN, 2);
      tri(ax + Math.sin(a) * 12, ay - Math.cos(a) * 12, ax + Math.sin(a - 0.5) * 5, ay - Math.cos(a - 0.5) * 5, ax + Math.sin(a + 0.5) * 5, ay - Math.cos(a + 0.5) * 5, GREEN);
    }
    if (f.wp) {
      text(f.wp.id || "", x + sz - 8, y + 14, WHITE, "right");
      text(`${pad3(f.wp.brg)}°  ${f.wp.dist.toFixed(f.wp.dist < 10 ? 1 : 0)} NM`, x + sz - 8, y + 32, GREEN, "right");
      const eta = new Date(Date.now() + (f.wp.dist / Math.max(60, f.gs)) * 3600 * 1000);
      text(`${String(eta.getHours()).padStart(2, "0")}${String(eta.getMinutes()).padStart(2, "0")}`, x + sz - 8, y + 50, WHITE, "right");
    }
    font(sz * 0.03);
    text(`ARC ${range} NM · N`, x + 8, y + sz - 10, GREY);
    if (f.ils && f.ils.locValid && (f.ap.appr || f.ap.loc)) text(`${f.ils.ident} CRS ${pad3(f.ils.crs)}°`, x + sz - 8, y + sz - 10, MAGENTA, "right");
  }

  // ---- engine and warning display -------------------------------------------------------------------------------
  function arcGauge(cx, cy, r, value, min, max, label, digits, color = GREEN, target = null) {
    const a0 = rad(-210);
    const a1 = rad(30);
    const t = clamp((value - min) / (max - min), 0, 1);
    g.strokeStyle = WHITE;
    g.lineWidth = 1.6;
    g.beginPath();
    g.arc(cx, cy, r, a0, a1);
    g.stroke();
    // Red line at the top of the scale.
    g.strokeStyle = RED;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, r, a0 + (a1 - a0) * 0.93, a1);
    g.stroke();
    const a = a0 + (a1 - a0) * t;
    line(cx, cy, cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95, color, 2.5);
    if (target != null) {
      const at = a0 + (a1 - a0) * clamp((target - min) / (max - min), 0, 1);
      g.strokeStyle = CYAN;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(cx + Math.cos(at) * (r + 6), cy + Math.sin(at) * (r + 6), 3, 0, Math.PI * 2);
      g.stroke();
    }
    font(r * 0.42, 700);
    text(digits, cx + r * 0.95, cy + r * 0.55, color, "right");
    font(r * 0.28);
    text(label, cx - r * 0.2, cy + r * 0.55, CYAN, "right");
  }

  function ewd(f, x, y, w, h) {
    screen(x, y, w, h);
    const e = f.eng;
    const n = e.count;
    const r = Math.min(w / (n * 3.2), h * 0.16);
    const idle = f.type === "airliner" ? 20 : 25;
    for (let i = 0; i < n; i++) {
      const cx = x + (w / (n + 0.2)) * (i + 0.6);
      if (e.rpm > 0) arcGauge(cx, y + r * 1.4, r, e.rpm, 0, 2900, "RPM", String(Math.round(e.rpm / 10) * 10));
      else arcGauge(cx, y + r * 1.4, r, e.n1, 0, 110, f.local ? "THR" : "N1", e.n1.toFixed(1), GREEN, idle + (100 - idle) * e.lever);
      arcGauge(cx, y + r * 3.5, r * 0.75, e.egt, 0, 1100, "EGT", String(Math.round(e.egt)));
      font(r * 0.3, 700);
      text(`FF ${f.local ? "—" : Math.round(e.ff / n)}`, cx, y + r * 4.85, GREEN, "center");
      if (e.rev > 0.05) text("REV", cx, y + r * 0.7, e.rev > 0.95 ? GREEN : AMBER, "center");
    }
    font(Math.max(10, h * 0.042), 700);
    let yy = y + r * 5.5;
    text(`FOB ${f.fuel == null ? "—" : Math.round(f.fuel).toLocaleString("en")} KG`, x + 10, yy, GREEN);
    text(`GW ${f.gw == null ? "—" : (f.gw / 1000).toFixed(1)} T`, x + w - 10, yy, GREEN, "right");
    yy += h * 0.07;
    // Flaps, spoilers, gear, brakes.
    text(`FLAP ${f.flap.label}`, x + 10, yy, Math.abs(f.flap.pos - f.flap.lever) > 0.02 ? CYAN : GREEN);
    if (f.hasSpoilers) text(f.spoiler > 0.05 ? `SPD BRK ${Math.round(f.spoiler * 100)}%` : f.armed ? "SPLRS ARM" : "", x + w - 10, yy, f.spoiler > 0.05 ? AMBER : GREEN, "right");
    yy += h * 0.07;
    if (f.retracts) {
      for (let k = 0; k < 3; k++) {
        const gx = x + 16 + k * 24;
        if (f.gear > 0.99) tri(gx, yy + 6, gx - 7, yy - 6, gx + 7, yy - 6, GREEN);
        else if (f.gear > 0.01) tri(gx, yy + 6, gx - 7, yy - 6, gx + 7, yy - 6, RED, false);
      }
      if (f.gear < 0.01) text("GEAR UP", x + 10, yy, WHITE);
    }
    const ab = ["", "LO", "MED", "MAX"][f.autobrake];
    if (ab) text(`A/BRK ${ab}`, x + w - 10, yy, f.autobrakeOn ? GREEN : CYAN, "right");
    yy += h * 0.07;
    if (f.park) text("PARK BRK", x + 10, yy, AMBER);
    if (f.brakes > 0.5) text("BRAKES", x + w - 10, yy, GREEN, "right");
    // Warnings (red) and cautions (amber); otherwise the memo for the phase.
    yy += h * 0.08;
    const reds = ["STALL", "PULL UP", "OVERSPEED", "CONFIG", "TAIL STRIKE"];
    if (f.warnings.length) {
      for (const wn of f.warnings.slice(0, 4)) {
        text(wn, x + 10, yy, reds.includes(wn) ? RED : AMBER);
        yy += h * 0.06;
      }
    } else if (f.onGround && f.phase === "takeoff" && f.ias < 40) {
      const items = [["AUTO BRK MAX", f.autobrake === 3 || f.type !== "airliner"], ["SPLRS ARM", f.armed || !f.hasSpoilers], [`FLAPS T.O`, f.flap.lever > 0 || f.type === "c172"], ["T.O CONFIG TEST", f.flap.lever > 0 && !f.park]];
      text("T.O", x + 10, yy, WHITE);
      for (const [label, ok] of items) {
        text(`${label}${ok ? "" : " ....."}`, x + 44, yy, ok ? GREEN : CYAN);
        yy += h * 0.055;
      }
    } else if (f.phase === "approach" || f.phase === "descent") {
      const items = [["LDG GEAR DN", f.gear > 0.99], ["SPLRS ARM", f.armed || !f.hasSpoilers], [`FLAPS ${f.flap.labels[f.flap.max]}`, f.flap.lever === f.flap.max]];
      text("LDG", x + 10, yy, WHITE);
      for (const [label, ok] of items) {
        text(label, x + 44, yy, ok ? GREEN : CYAN);
        yy += h * 0.055;
      }
    }
    font(Math.max(9, h * 0.036));
    text(`${f.rate > 1 ? `SIM ${f.rate}× · ` : ""}${fmtClock(f.time)}`, x + w - 8, y + 10, WHITE, "right");
    if (f.dtg) text(`${Math.round(f.dtg)} NM`, x + w - 8, y + 10 + h * 0.045, WHITE, "right");
  }
  const fmtClock = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ---- light aircraft instruments -------------------------------------------------------------------------------
  function dial(cx, cy, r) {
    g.fillStyle = "#101418";
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#39414b";
    g.lineWidth = 3;
    g.stroke();
  }
  function needle(cx, cy, a, len, color = WHITE, w = 3) {
    line(cx, cy, cx + Math.sin(a) * len, cy - Math.cos(a) * len, color, w);
    g.fillStyle = "#222";
    g.beginPath();
    g.arc(cx, cy, 4, 0, Math.PI * 2);
    g.fill();
  }
  function asi(f, cx, cy, r) {
    dial(cx, cy, r);
    const ang = (kt) => rad(-150 + clamp((kt - 30) / 170, 0, 1) * 300);
    const arc = (a, b, color, rr, w) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      g.beginPath();
      g.arc(cx, cy, rr, ang(a) - Math.PI / 2, ang(b) - Math.PI / 2);
      g.stroke();
    };
    arc(40, 85, WHITE, r * 0.78, 4);
    arc(48, 129, GREEN, r * 0.86, 5);
    arc(129, 163, YELLOW, r * 0.86, 5);
    arc(163, 166, RED, r * 0.86, 5);
    font(r * 0.16);
    for (let kt = 40; kt <= 200; kt += 20) {
      const a = ang(kt);
      text(String(kt), cx + Math.sin(a) * r * 0.62, cy - Math.cos(a) * r * 0.62, WHITE, "center");
    }
    text("KNOTS", cx, cy + r * 0.3, GREY, "center");
    needle(cx, cy, ang(f.ias), r * 0.85);
  }
  function ai(f, cx, cy, r) {
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-rad(f.bank));
    const ppd = r / 30;
    g.translate(0, f.pitch * ppd);
    rect(-r * 2, -r * 3, r * 4, r * 3, SKY);
    rect(-r * 2, 0, r * 4, r * 3, EARTH);
    line(-r * 2, 0, r * 2, 0, WHITE, 2);
    for (const p of [-20, -10, 10, 20]) line(-r * 0.25, -p * ppd, r * 0.25, -p * ppd, WHITE, 1.5);
    g.restore();
    g.strokeStyle = "#39414b";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    line(cx - r * 0.55, cy, cx - r * 0.15, cy, AMBER, 4);
    line(cx + r * 0.15, cy, cx + r * 0.55, cy, AMBER, 4);
    rect(cx - 3, cy - 3, 6, 6, AMBER);
    g.save();
    g.translate(cx, cy);
    g.rotate(-rad(f.bank));
    tri(0, -r * 0.92, -6, -r * 0.8, 6, -r * 0.8, WHITE);
    g.restore();
  }
  function altimeter(f, cx, cy, r) {
    dial(cx, cy, r);
    font(r * 0.2);
    for (let i = 0; i < 10; i++) {
      const a = rad(i * 36);
      text(String(i), cx + Math.sin(a) * r * 0.72, cy - Math.cos(a) * r * 0.72, WHITE, "center");
    }
    needle(cx, cy, rad(((f.alt % 10000) / 10000) * 360), r * 0.45, WHITE, 5);
    needle(cx, cy, rad(((f.alt % 1000) / 1000) * 360), r * 0.8, WHITE, 3);
    font(r * 0.15);
    text(Math.round(f.alt).toLocaleString("en"), cx, cy + r * 0.4, GREEN, "center");
  }
  let lastHdg = null;
  let turnRate = 0;
  function turnCoordinator(f, cx, cy, r, dt) {
    dial(cx, cy, r);
    if (lastHdg != null && dt > 0) turnRate += (wrap180(f.hdg - lastHdg) / dt - turnRate) * Math.min(1, dt * 3);
    lastHdg = f.hdg;
    font(r * 0.16);
    text("L", cx - r * 0.75, cy + r * 0.25, WHITE, "center");
    text("R", cx + r * 0.75, cy + r * 0.25, WHITE, "center");
    text("2 MIN", cx, cy + r * 0.62, GREY, "center");
    // Standard rate (3°/s) at the marks.
    g.save();
    g.translate(cx, cy);
    g.rotate(rad(clamp(turnRate / 3, -2, 2) * 20));
    line(-r * 0.7, 0, r * 0.7, 0, WHITE, 4);
    rect(-4, -6, 8, 8, WHITE);
    g.restore();
    const ball = clamp(-f.beta * 4, -r * 0.4, r * 0.4);
    g.strokeStyle = WHITE;
    g.lineWidth = 1.5;
    g.strokeRect(cx - r * 0.45, cy + r * 0.35, r * 0.9, r * 0.16);
    g.fillStyle = "#000";
    g.beginPath();
    g.arc(cx + ball, cy + r * 0.43, r * 0.07, 0, Math.PI * 2);
    g.fill();
  }
  function hsi(f, cx, cy, r) {
    dial(cx, cy, r);
    g.save();
    g.translate(cx, cy);
    g.rotate(-rad(f.hdg));
    font(r * 0.17);
    for (let d = 0; d < 360; d += 10) {
      const a = rad(d);
      line(Math.sin(a) * r * 0.85, -Math.cos(a) * r * 0.85, Math.sin(a) * r * (d % 30 ? 0.78 : 0.72), -Math.cos(a) * r * (d % 30 ? 0.78 : 0.72), WHITE, 1.4);
      if (d % 30 === 0) {
        g.save();
        g.rotate(a);
        text(({ 0: "N", 90: "E", 180: "S", 270: "W" })[d] || String(d / 10), 0, -r * 0.6, WHITE, "center");
        g.restore();
      }
    }
    // Heading bug, and the course needle with its deviation bar (ILS or GPS).
    const bug = rad(f.ap.hdg);
    rect(Math.sin(bug) * r * 0.86 - 4, -Math.cos(bug) * r * 0.86 - 4, 8, 8, CYAN);
    const crs = f.ils && f.ils.locValid && f.phase === "approach" ? f.ils.crs : f.wp ? f.wp.dtk : f.hdg;
    const dev = f.ils && f.ils.locValid && f.phase === "approach" ? f.ils.loc : f.wp ? clamp(-f.wp.xtk / 1, -2.5, 2.5) : 0;
    g.rotate(rad(crs));
    line(0, -r * 0.55, 0, -r * 0.25, MAGENTA, 3);
    line(0, r * 0.25, 0, r * 0.55, MAGENTA, 3);
    line(dev * r * 0.12, -r * 0.22, dev * r * 0.12, r * 0.22, MAGENTA, 3);
    g.restore();
    tri(cx, cy - r * 0.95, cx - 6, cy - r * 0.84, cx + 6, cy - r * 0.84, AMBER);
    rect(cx - 2, cy - 12, 4, 24, AMBER);
    line(cx - 12, cy - 2, cx + 12, cy - 2, AMBER, 4);
  }
  function vsiDial(f, cx, cy, r) {
    dial(cx, cy, r);
    const ang = (fpm) => rad(-90 + clamp(fpm / 2000, -1, 1) * 170);
    font(r * 0.17);
    for (const v of [-2000, -1500, -1000, -500, 0, 500, 1000, 1500, 2000]) {
      const a = ang(v);
      text(String(Math.abs(v / 100)), cx + Math.sin(a) * r * 0.66, cy - Math.cos(a) * r * 0.66, WHITE, "center");
    }
    needle(cx, cy, ang(f.vs), r * 0.85);
  }
  function smallGauge(x, y, w, label, value, min, max, color = GREEN, digits = "") {
    rect(x, y, w, 26, "#101418");
    font(10);
    text(label, x + 6, y + 8, GREY);
    rect(x + 6, y + 16, w - 12, 5, "#29313b");
    rect(x + 6, y + 16, (w - 12) * clamp((value - min) / (max - min), 0, 1), 5, color);
    text(digits, x + w - 6, y + 8, color, "right");
  }
  function gaPanel(f, x, y, w, h, dt) {
    rect(x, y, w, h, "#1b1f24");
    const r = Math.min((h - 24) / 4.2, w / 16);
    const row1 = y + r + 10;
    const row2 = y + r * 3.2 + 14;
    const col = (i) => x + r * 1.3 + i * r * 2.3;
    asi(f, col(0), row1, r);
    ai(f, col(1), row1, r);
    altimeter(f, col(2), row1, r);
    turnCoordinator(f, col(0), row2, r, dt);
    hsi(f, col(1), row2, r);
    vsiDial(f, col(2), row2, r);
    // Engine and systems column.
    const ex = col(3) - r * 0.6;
    const ew = r * 2.2;
    smallGauge(ex, y + 10, ew, "RPM", f.eng.rpm, 500, 2800, f.eng.rpm > 2700 ? RED : GREEN, String(Math.round(f.eng.rpm / 10) * 10));
    smallGauge(ex, y + 42, ew, "FUEL KG", f.fuel, 0, 159, f.fuel < 20 ? AMBER : GREEN, String(Math.round(f.fuel)));
    smallGauge(ex, y + 74, ew, "FLAPS", f.flap.pos, 0, f.flap.max, WHITE, f.flap.label);
    smallGauge(ex, y + 106, ew, "TRIM", f.trim, -0.05, 0.2, CYAN, f.trim > 0.07 ? "NOSE UP" : f.trim < 0.04 ? "NOSE DN" : "T/O");
    font(11, 700);
    let yy = y + 150;
    if (f.park) text("PARK BRAKE", ex + 6, yy, AMBER), (yy += 16);
    for (const wn of f.warnings.slice(0, 3)) text(wn, ex + 6, yy, ["STALL", "PULL UP"].includes(wn) ? RED : AMBER), (yy += 16);
    // GPS map (the navigation display's drawing, small) and the autopilot's annunciator.
    const gx = ex + ew + 14;
    const gs = Math.min(h - 20, x + w - gx - 10);
    if (gs > 120) nd(f, gx, y + 10, gs);
    font(12, 700);
    const a = f.ap;
    text(`${a.ap ? "AP " : ""}${a.lat || ""} ${a.latArmed ? "(" + a.latArmed + ")" : ""}  ${a.vert || ""} ${a.vert === "V/S" ? a.vs + " FPM" : ""}`, col(0) - r, y + h - 10, a.ap ? GREEN : GREY);
  }

  // ---- systems display ------------------------------------------------------------------------------------------
  /** The lower centre screen of a modelled flight deck: gear, brakes, flaps, fuel, weights, the warnings. */
  function sd(f, x, y, w, h) {
    screen(x, y, w, h);
    const px = h * 0.046;
    font(px, 700);
    text("STATUS", x + w / 2, y + px * 1.4, WHITE, "center");
    line(x + w * 0.3, y + px * 2.4, x + w * 0.7, y + px * 2.4, WHITE, 1);
    let yy = y + px * 4;
    const row = (name, value, color = GREEN) => {
      font(px * 0.85);
      text(name, x + w * 0.08, yy, CYAN);
      font(px, 700);
      text(value, x + w * 0.92, yy, color, "right");
      yy += px * 1.6;
    };
    if (f.retracts) row("GEAR", f.gear > 0.99 ? "DOWN LOCKED" : f.gear < 0.01 ? "UP" : "IN TRANSIT", f.gear > 0.99 ? GREEN : f.gear < 0.01 ? WHITE : AMBER);
    row("BRAKES", f.park ? "PARK" : f.autobrakeOn ? `AUTO ${f.autobrake}` : f.brakes > 0.05 ? "ON" : "OFF", f.park ? AMBER : GREEN);
    row("FLAPS", f.flap.label, Math.abs(f.flap.pos - f.flap.lever) > 0.02 ? CYAN : GREEN);
    if (f.hasSpoilers) row("SPOILERS", f.spoiler > 0.05 ? `${Math.round(f.spoiler * 100)}%` : f.armed ? "ARMED" : "RET", f.spoiler > 0.05 ? AMBER : GREEN);
    row("PITCH TRIM", `${(f.trim * 100).toFixed(1)}`);
    row("FUEL", `${Math.round(f.fuel).toLocaleString("en")} KG`, f.fuel < 1000 && f.type === "airliner" ? AMBER : GREEN);
    row("GROSS WT", `${(f.gw / 1000).toFixed(1)} T`);
    row("TAS · GS", `${Math.round(f.tas)} · ${Math.round(f.gs)} KT`);
    if (f.wind) row("WIND", `${pad3(f.wind.from)}° / ${Math.round(f.wind.kt)} KT`);
    yy += px * 0.4;
    font(px, 700);
    for (const wn of f.warnings.slice(0, Math.max(0, Math.floor((y + h - yy) / (px * 1.4))))) {
      text(wn, x + w * 0.08, yy, ["STALL", "PULL UP"].includes(wn) ? RED : AMBER);
      yy += px * 1.4;
    }
  }

  /** A modelled flight deck's screen, drawn by displays.js for the 3D panel: false when there is no such picture. */
  window.__flightScreens = (name, ctx, w, h, f, dt) => {
    g = ctx;
    if (name === "pfd") pfd(f, 0, 0, w);
    else if (name === "nd") nd(f, 0, 0, w);
    else if (name === "ewd") ewd(f, 0, 0, w, h);
    else if (name === "sd") sd(f, 0, 0, w, h);
    else if (name === "ga") gaPanel(f, 0, 0, w, h, dt);
    else return false;
    return true;
  };

  // ---- head-up display ----------------------------------------------------------------------------------------
  /**
   * Symbology at infinity, seen in the combiner glass of the modelled flight deck (its outline on screen, from the
   * app), or over the middle of the view for a helmet display. The horizon and pitch ladder are conformal with the
   * outside world: placed from the view's own attitude.
   */
  function headUp(s, f, W, H) {
    const c = s.base.combiner;
    const pts = c && c.map(([nx, ny]) => [((nx + 1) / 2) * W, ((1 - ny) / 2) * H]);
    const box = pts ? { x: Math.min(...pts.map((p) => p[0])), y: Math.min(...pts.map((p) => p[1])) } : { x: W * 0.28, y: H * 0.2 };
    box.w = pts ? Math.max(...pts.map((p) => p[0])) - box.x : W * 0.44;
    box.h = pts ? Math.max(...pts.map((p) => p[1])) - box.y : H * 0.56;
    if (box.w < 60 || box.h < 40) return;
    const ppd = H / ((s.base.fov * 180) / Math.PI);
    const [camPitch, camBank] = s.base.cam ?? [f.pitch, f.bank];
    const col = GREEN;
    g.save();
    if (pts) {
      g.beginPath();
      pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.closePath();
      g.clip();
    }
    g.shadowColor = "rgba(61,255,110,0.55)";
    g.shadowBlur = 4;
    // Horizon and pitch ladder, about the view's centre.
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(-rad(camBank));
    const half = Math.min(box.w * 0.16, 90);
    font(Math.max(10, box.h * 0.035));
    for (let a = -30; a <= 30; a += 5) {
      const dy = (camPitch - a) * ppd;
      if (a === 0) {
        line(-W, dy, -half * 0.35, dy, col, 1.6);
        line(half * 0.35, dy, W, dy, col, 1.6);
        // Heading marks along the horizon.
        for (let d = Math.ceil((f.hdg - 40) / 10) * 10; d <= f.hdg + 40; d += 10) {
          const xx = wrap180(d - f.hdg) * ppd;
          line(xx, dy, xx, dy - 8, col, 1.4);
          if (d % 30 === 0) text(pad3(d).slice(0, 2), xx, dy - 16, col, "center");
        }
        continue;
      }
      g.setLineDash(a < 0 ? [7, 5] : []);
      line(-half, dy, -half * 0.35, dy, col, 1.4);
      line(half * 0.35, dy, half, dy, col, 1.4);
      line(-half, dy, -half, dy + (a > 0 ? 6 : -6), col, 1.4);
      line(half, dy, half, dy + (a > 0 ? 6 : -6), col, 1.4);
      g.setLineDash([]);
      text(String(Math.abs(a)), half + 6, dy, col);
    }
    g.restore();
    // Flight path vector, and the flight director's cue beside it.
    if (s.fpm) {
      const vx = ((s.fpm[0] + 1) / 2) * W;
      const vy = ((1 - s.fpm[1]) / 2) * H;
      g.strokeStyle = col;
      g.lineWidth = 1.8;
      g.beginPath();
      g.arc(vx, vy, 7, 0, Math.PI * 2);
      g.stroke();
      line(vx - 7, vy, vx - 20, vy, col, 1.8);
      line(vx + 7, vy, vx + 20, vy, col, 1.8);
      line(vx, vy - 7, vx, vy - 14, col, 1.8);
      if (f.ap.fd && !f.onGround) {
        const gx = vx + clamp(f.ap.fdBank - f.bank, -30, 30) * ppd * 0.25;
        const gy = vy - clamp(f.ap.fdPitch - f.fpa, -10, 10) * ppd;
        g.beginPath();
        g.arc(gx, gy, 5, 0, Math.PI * 2);
        g.stroke();
      }
    }
    // Speed on the left, altitude on the right, the modes and heading above, vertical speed and G below.
    const px = clamp(box.h * 0.06, 11, 20);
    font(px, 700);
    const my = box.y + box.h * 0.5;
    const boxed = (str, bx, align) => {
      const tw = g.measureText(str).width + 12;
      frame(align === "left" ? bx : bx - tw, my - px * 0.8, tw, px * 1.6, col, 1.4);
      text(str, align === "left" ? bx + 6 : bx - 6, my, col, align);
    };
    boxed(String(Math.round(f.ias)), box.x + box.w * 0.06, "left");
    boxed(String(Math.round(f.alt / 10) * 10), box.x + box.w * 0.94, "right");
    font(px * 0.75);
    if (f.type !== "airliner") text(`M ${f.mach.toFixed(2)}`, box.x + box.w * 0.06, my + px * 1.6, col);
    text(`${f.vs >= 0 ? "+" : ""}${Math.round(f.vs / 100) * 100}`, box.x + box.w * 0.94, my + px * 1.6, col, "right");
    const a = f.ap;
    text([a.thr === "A/THR" ? "" : a.thr, a.vert, a.lat].filter(Boolean).join("   "), box.x + box.w / 2, box.y + px * 1.1, col, "center");
    text(pad3(f.hdg), box.x + box.w / 2, box.y + px * 2.3, col, "center");
    if (f.type !== "airliner") text(`${f.g.toFixed(1)} G`, box.x + box.w * 0.06, box.y + box.h - px, col);
    if (f.ra < 2500 && !f.onGround) text(`${Math.round(f.ra)}R`, box.x + box.w / 2, box.y + box.h - px, col, "center");
    const warn = f.warnings.find((wn) => ["STALL", "PULL UP"].includes(wn));
    if (warn) {
      font(px * 1.3, 800);
      text(warn, box.x + box.w / 2, my + px * 3, col, "center");
    }
    g.restore();
  }

  // ---- chase view -------------------------------------------------------------------------------------------------
  /** A translucent backing so readings hold up over bright ground. */
  function glass(x, y, w, h) {
    g.fillStyle = "rgba(6, 9, 13, 0.55)";
    g.beginPath();
    g.roundRect(x, y, w, h, 10);
    g.fill();
  }

  function compass(f, cx, cy, r) {
    glass(cx - r - 10, cy - r - 22, r * 2 + 20, r * 2 + 32);
    g.save();
    g.translate(cx, cy);
    font(r * 0.2, 700);
    for (let d = 0; d < 360; d += 10) {
      const a = rad(d - f.hdg - 90);
      const len = d % 30 === 0 ? r * 0.16 : r * 0.08;
      line(Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * (r - len), Math.sin(a) * (r - len), WHITE, 1.4);
      if (d % 30 === 0) text(d % 90 === 0 ? "NESW"[d / 90] : String(d / 10), Math.cos(a) * r * 0.66, Math.sin(a) * r * 0.66, d % 90 === 0 ? WHITE : GREY, "center");
    }
    // The next waypoint's bearing, magenta; the track, green.
    if (f.wp) {
      const a = rad(f.wp.brg - f.hdg - 90);
      line(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2, Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95, MAGENTA, 2.5);
    }
    const t = rad(f.trk - f.hdg - 90);
    diamond(Math.cos(t) * r * 0.9, Math.sin(t) * r * 0.9, 4, 5, null);
    g.strokeStyle = GREEN;
    g.stroke();
    tri(0, -r * 0.18, -r * 0.1, r * 0.12, r * 0.1, r * 0.12, AMBER);
    g.restore();
    font(r * 0.24, 700);
    rect(cx - r * 0.34, cy - r - 18, r * 0.68, r * 0.3, "#000");
    text(pad3(f.hdg), cx, cy - r - 18 + r * 0.15, WHITE, "center");
  }

  /** Speed and engines at the bottom left, configuration and altitude at the bottom right, a compass at the top left: the middle, where the aircraft is, stays clear. */
  function chaseInstruments(f, W, H, foot) {
    const h = clamp(H * 0.24, 150, 230);
    // Clear of the credits, with room for the labels under the tapes.
    const y = H - foot - h - 34;
    const sz = h * 2.3;
    const tw = h * 0.36;
    // Left: speed tape, engines, fuel.
    const n = f.eng.count;
    const r = h * 0.2;
    const lw = tw + 34 + n * r * 2.5 + 10;
    glass(8, y - 22, lw, h + 40);
    speedTape(f, 18, y, tw, h, sz);
    font(sz * 0.03);
    text("KT", 18 + tw / 2, y + h + 10, CYAN, "center");
    const idle = f.type === "airliner" ? 20 : 25;
    for (let i = 0; i < n; i++) {
      const cx = 18 + tw + 30 + r * 1.1 + i * r * 2.5;
      if (f.eng.rpm > 0) arcGauge(cx, y + r * 1.3, r, f.eng.rpm, 0, 2900, "RPM", String(Math.round(f.eng.rpm / 10) * 10));
      else arcGauge(cx, y + r * 1.3, r, f.eng.n1, 0, 110, "N1", f.eng.n1.toFixed(0), GREEN, idle + (100 - idle) * f.eng.lever);
    }
    const fx = 18 + tw + 20;
    const fw = n * r * 2.5;
    const fuelMax = f.type === "ga" ? 159 : f.type === "airliner" ? 19000 : 8000;
    smallGauge(fx, y + h - 64, fw, "FUEL KG", f.fuel, 0, fuelMax, f.warnings.includes("FUEL LOW") ? AMBER : GREEN, Math.round(f.fuel).toLocaleString("en"));
    smallGauge(fx, y + h - 32, fw, "THR", f.eng.lever, 0, 1, f.eng.rev > 0.05 ? AMBER : WHITE, f.eng.rev > 0.05 ? "REV" : `${Math.round(f.eng.lever * 100)}%`);
    // Right: flaps, trim, gear, altitude tape, vertical speed.
    const aw = h * 0.42;
    const vw = h * 0.14;
    const cw = h * 0.72;
    const rw = cw + aw + vw + 58;
    const rx = W - 8 - rw;
    glass(rx, y - 22, rw, h + 40);
    const gx = rx + 10;
    smallGauge(gx, y, cw, "FLAPS", f.flap.pos, 0, f.flap.max, Math.abs(f.flap.pos - f.flap.lever) > 0.02 ? CYAN : WHITE, f.flap.label);
    smallGauge(gx, y + 32, cw, "TRIM", f.trim, -0.05, 0.2, CYAN, (f.trim * 100).toFixed(1));
    if (f.hasSpoilers) smallGauge(gx, y + 64, cw, "SPD BRK", f.spoiler, 0, 1, f.spoiler > 0.05 ? AMBER : WHITE, f.spoiler > 0.05 ? `${Math.round(f.spoiler * 100)}%` : f.armed ? "ARM" : "RET");
    font(12, 700);
    let yy = y + 106;
    if (f.retracts) text(f.gear > 0.99 ? "GEAR DOWN" : f.gear < 0.01 ? "GEAR UP" : "GEAR ···", gx + 4, yy, f.gear > 0.99 ? GREEN : f.gear < 0.01 ? WHITE : AMBER), (yy += 18);
    if (f.park) text("PARK BRK", gx + 4, yy, AMBER), (yy += 18);
    for (const wn of f.warnings.filter((w) => w !== "FUEL LOW").slice(0, 2)) text(wn, gx + 4, yy, ["STALL", "PULL UP"].includes(wn) ? RED : AMBER), (yy += 18);
    altTape(f, gx + cw + 22, y, aw, h, sz);
    vsi(f, gx + cw + 22 + aw + 14, y + h * 0.1, vw, h * 0.8, sz);
    // Top left, under the menu bar.
    compass(f, 84, 150, 58);
  }

  /** The flight path guide's cue (src/sandbox/flight/guide.rs), over the sky: which way to the gates, or on path. */
  function guideCue(f, W, H) {
    const c = f.guide;
    if (!c || c.dev == null) return;
    const dist = (m) => (m < 1852 ? `${Math.round(m / 10) * 10} M` : `${(m / 1852).toFixed(1)} NM`);
    const parts = [];
    if (c.inside) parts.push(["ON PATH", GREEN]);
    else {
      if (Math.abs(c.dev) > 60) parts.push([`${c.dev > 0 ? "▲ CLIMB" : "▼ DESCEND"} ${Math.round(Math.abs(c.dev) / 10) * 10} FT`, MAGENTA]);
      if (Math.abs(c.xtk) > 30) parts.push([c.xtk > 0 ? `◀ LEFT ${dist(c.xtk)}` : `RIGHT ${dist(-c.xtk)} ▶`, MAGENTA]);
      if (!parts.length) parts.push(["NEARLY THERE", MAGENTA]);
    }
    font(13, 700);
    const gap = 18;
    const widths = parts.map(([t]) => g.measureText(t).width);
    font(10, 700);
    const label = g.measureText("GUIDE").width + 12;
    const w = label + widths.reduce((a, b) => a + b + gap, 0) + 10;
    const x = W / 2 - w / 2;
    // Under the controls strip while it shows.
    const y = strip.hidden ? Math.round(H * 0.3) : Math.round(strip.getBoundingClientRect().bottom + 24);
    rect(x, y - 13, w, 26, "rgba(5,8,12,0.6)");
    text("GUIDE", x + 10, y, "rgba(233,238,245,0.6)");
    font(13, 700);
    let xx = x + 10 + label;
    parts.forEach(([t, color], i) => {
      text(t, xx, y, color);
      xx += widths[i] + gap;
    });
  }

  /** The flight mode annunciator and the selected targets, small, top centre. */
  function topFma(f, W) {
    const w = 500;
    const x = W / 2 - w / 2;
    rect(x, 58, w, 34, "rgba(5,8,12,0.7)");
    fma(f, x, 58, w, 34);
    const a = f.ap;
    font(11, 700);
    const alt = a.alt >= 18000 ? `FL${Math.round(a.alt / 100)}` : String(Math.round(a.alt));
    const spd = a.spdManaged ? "SPD ---" : `SPD ${Math.round(a.spd)}`;
    const hdg = a.lat === "HDG" ? `HDG ${pad3(a.hdg)}` : "HDG ---";
    const vs = a.vert === "V/S" ? `V/S ${a.vs >= 0 ? "+" : ""}${a.vs}` : "";
    text([spd, hdg, `ALT ${alt}`, vs].filter(Boolean).join("   ·   "), W / 2, 104, CYAN, "center");
  }

  // ---- the controls strip (flight control unit, systems) ----------------------------------------------------------
  const strip = el(`<div id="fcu" hidden></div>`);
  const mcdu = el(`<div id="mcdu" hidden><header><b>MCDU · F-PLN</b><button class="x" aria-label="Close">✕</button></header><div class="rows"></div><footer></footer></div>`);
  mcdu.querySelector(".x").onclick = () => (mcdu.hidden = true);
  const report = el(`<div id="flight-report" hidden></div>`);
  let stripKey = "";
  let reportKey = "";
  const fcu = (what, extra = {}) => send({ type: "fcu", fcu: what, ...extra });
  const sys = (what, extra = {}) => send({ type: "fsys", sys: what, ...extra });

  function knob(label, value, what, step, extra = "") {
    return `<div class="win" data-knob="${what}" data-step="${step}"><small>${label}</small><output>${value}</output><div class="k"><button data-d="-1" aria-label="${label} down">−</button><button data-d="1" aria-label="${label} up">+</button>${extra}</div></div>`;
  }
  function renderStrip(f) {
    const a = f.ap;
    const ga = f.panel === "ga";
    const fmtAlt = (v) => (v >= 18000 ? `FL${String(Math.round(v / 100)).padStart(3, "0")}` : String(Math.round(v)).padStart(5, " "));
    const key = JSON.stringify([ga, a.ap, a.athr, a.loc, a.appr, a.spd, a.spdManaged, a.hdg, a.alt, a.vs, a.lat, a.vert, f.flap.lever, f.gearLever, f.speedbrake > 0.1, f.armed, f.autobrake, f.park, f.rate, f.retracts, f.hasSpoilers, !!f.guide]);
    if (key === stripKey) return;
    stripKey = key;
    const flaps = f.flap.labels.map((l, i) => `<button data-flap="${i}" class="${i === f.flap.lever ? "on" : ""}">${l}</button>`).join("");
    const rate = [1, 2, 4, 8, 16].map((r) => `<button data-rate="${r}" class="${r === f.rate ? "on" : ""}">${r}×</button>`).join("");
    strip.innerHTML = `
      <div class="grp fcu">
        ${ga ? "" : knob("SPD", a.spdManaged ? "- - -" : a.spd, "spd", 1, `<button data-push="spdPush" title="Managed speed">●</button>`)}
        ${knob("HDG", a.lat === "HDG" ? pad3(a.hdg) : "- - -", "hdg", 1, `<button data-push="hdgPush" title="Push: NAV">●</button><button data-push="hdgPull" title="Pull: selected heading">○</button>`)}
        <div class="btns">
          ${ga ? `<button data-push="hdgPull" class="${a.lat === "HDG" ? "on" : ""}">HDG</button><button data-push="hdgPush" class="${a.lat === "NAV" ? "on" : ""}">NAV</button><button data-fcu="altHold" class="${a.vert === "ALT" ? "on" : ""}">ALT</button>` : `<button data-fcu="loc" class="${a.loc && !a.appr ? "on" : ""}">LOC</button>`}
          <button data-fcu="ap" class="${a.ap ? "on" : ""}">${ga ? "AP" : "AP1"}</button>
          ${ga ? "" : `<button data-fcu="athr" class="${a.athr ? "on" : ""}">A/THR</button>`}
          <button data-fcu="appr" class="${a.appr ? "on" : ""}">${ga ? "APR" : "APPR"}</button>
        </div>
        ${knob("ALT", fmtAlt(a.alt), "alt", 100, `<button data-push="altPush" title="Push: managed climb or descent">●</button><button data-push="altPull" title="Pull: open climb or descent">○</button>`)}
        ${knob("V/S", a.vert === "V/S" ? (a.vs > 0 ? "+" : "") + a.vs : "- - - -", "vs", 100, `<button data-push="vsPush" title="Level off">●</button>`)}
      </div>
      <div class="grp sys">
        <div class="seg"><small>FLAPS</small>${flaps}</div>
        ${f.retracts ? `<button data-sys="gear" class="${f.gearLever ? "on" : ""}">GEAR ${f.gearLever ? "DN" : "UP"}</button>` : ""}
        ${f.hasSpoilers ? `<button data-sys="speedbrakeToggle" class="${f.speedbrake > 0.1 ? "on" : ""}">SPD BRK</button><button data-sys="arm" class="${f.armed ? "on" : ""}">ARM</button>` : ""}
        ${f.type === "airliner" ? `<div class="seg"><small>A/BRK</small>${["OFF", "LO", "MED", "MAX"].map((l, i) => `<button data-ab="${i}" class="${i === f.autobrake ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
        ${ga ? `<div class="seg"><small>TRIM</small><button data-trim="-0.005">DN</button><button data-trim="0.005">UP</button></div>` : ""}
        <button data-sys="park" class="${f.park ? "on warn" : ""}">PARK</button>
        <div class="seg"><small>SIM</small>${rate}</div>
        ${ga ? "" : `<button data-mcdu>MCDU</button>`}
        <button data-sound>${muted ? "SOUND OFF" : "SOUND"}</button>
        <button data-guide class="${f.guide ? "on" : ""}" title="Flight path guide: gates to fly through (J)">GUIDE</button>
        <button data-plan>PLAN</button>
      </div>`;
    strip.querySelectorAll("[data-knob]").forEach((k) => {
      const what = k.dataset.knob;
      const step = +k.dataset.step;
      k.querySelectorAll("[data-d]").forEach((b) => (b.onclick = (e) => fcu(what, { delta: +b.dataset.d * step * (e.shiftKey ? 10 : 1) })));
      k.addEventListener("wheel", (e) => {
        e.preventDefault();
        fcu(what, { delta: (e.deltaY < 0 ? 1 : -1) * step * (e.shiftKey ? 10 : 1) });
      });
    });
    strip.querySelectorAll("[data-push]").forEach((b) => (b.onclick = () => fcu(b.dataset.push)));
    strip.querySelectorAll("[data-fcu]").forEach((b) => (b.onclick = () => fcu(b.dataset.fcu)));
    strip.querySelectorAll("[data-flap]").forEach((b) => (b.onclick = () => sys("flaps", { value: +b.dataset.flap })));
    strip.querySelectorAll("[data-sys]").forEach((b) => (b.onclick = () => sys(b.dataset.sys)));
    strip.querySelectorAll("[data-ab]").forEach((b) => (b.onclick = () => sys("autobrake", { value: +b.dataset.ab })));
    strip.querySelectorAll("[data-trim]").forEach((b) => (b.onclick = () => sys("trim", { value: +b.dataset.trim })));
    strip.querySelectorAll("[data-rate]").forEach((b) => (b.onclick = () => send({ type: "simrate", rate: +b.dataset.rate })));
    strip.querySelector("[data-mcdu]")?.addEventListener("click", () => (mcdu.hidden = !mcdu.hidden));
    strip.querySelector("[data-sound]").onclick = () => ((muted = !muted), (stripKey = ""), audio.update(null));
    strip.querySelector("[data-guide]").onclick = () => window.__flightGuide?.();
    strip.querySelector("[data-plan]").onclick = () => window.__flightOpen?.();
  }

  let mcduKey = "";
  function renderMcdu(f) {
    if (mcdu.hidden) return;
    const w = f.route.wpts;
    const key = JSON.stringify([w.length, f.route.active, Math.round(f.dtg || 0)]);
    if (key === mcduKey) return;
    mcduKey = key;
    const rows = mcdu.querySelector(".rows");
    rows.replaceChildren(
      ...w.map((p, i) => {
        const row = el(`<button class="${i === f.route.active ? "act" : i < f.route.active ? "past" : ""}"><b>${esc(p.id)}</b><span>${p.alt ? (p.alt >= 18000 ? "FL" + Math.round(p.alt / 100) : p.alt) : ""}</span><small>${i === f.route.active ? "TO" : i < f.route.active ? "" : "DIR TO ›"}</small></button>`);
        row.onclick = () => i > f.route.active - 1 && fcu("dirto", { index: i });
        return row;
      }),
    );
    const v = f.vspeeds;
    const metar = window.__flightMetar?.get(f.arr?.icao);
    mcdu.querySelector("footer").innerHTML = `${metar ? `<div>${esc(metar.raw)}</div>` : ""}V1 ${Math.round(v.v1)} · VR ${Math.round(v.vr)} · V2 ${Math.round(v.v2)} · VAPP ${Math.round(v.vapp)} · CRZ FL${Math.round(f.cruise / 100)} · T/D ${Math.round(f.todDtg)} NM`;
  }

  function showReport(f) {
    const r = f.report;
    const key = JSON.stringify(r);
    if (!r) {
      report.hidden = true;
      reportKey = "";
      return;
    }
    if (key === reportKey) return;
    reportKey = key;
    const crash = !!r.crash;
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    report.innerHTML = `<div class="card">
      <b class="kicker">${crash ? "FLIGHT ENDED" : "LANDED"}</b>
      <h2>${crash ? esc(r.crash) : `${esc(r.grade)} · ${Math.round(r.sink)} FPM`}</h2>
      ${crash ? `<p>${Math.round(r.sink)} fpm at ${Math.round(r.ias)} kt.</p>` : `<div class="score"><i style="width:${r.score}%"></i></div><p>Score ${r.score} / 100 on ${esc(r.runway || "the ground")}</p>
      <dl>${row("Touchdown", `${Math.round(r.past)} m past the threshold`)}${row("Centreline", `${Math.abs(r.offCentre).toFixed(1)} m ${r.offCentre > 0 ? "right" : "left"}`)}${row("Speed", `${Math.round(r.ias)} kt`)}${row("Bank · crab", `${r.bank.toFixed(1)}° · ${r.crab.toFixed(1)}°`)}${row("Flight time", fmtClock(r.flightTime || 0))}${row("Distance", `${Math.round(r.distance || 0)} NM`)}${row("Fuel used", `${Math.round(r.fuelUsed || 0).toLocaleString("en")} kg`)}</dl>`}
      <div class="actions"><button data-a="again">Fly again</button><button data-a="reverse">Fly back</button><button data-a="plan">New flight</button><button data-a="end" class="primary">Done</button></div></div>`;
    report.querySelector('[data-a="again"]').onclick = () => window.__flightAgain?.(false);
    report.querySelector('[data-a="reverse"]').onclick = () => window.__flightAgain?.(true);
    report.querySelector('[data-a="plan"]').onclick = () => window.__flightOpen?.();
    report.querySelector('[data-a="end"]').onclick = () => (window.__flightEnd?.(), (report.hidden = true));
    report.hidden = false;
    document.exitPointerLock?.();
  }

  // ---- sound: callouts, warnings, engines -------------------------------------------------------------------------
  let muted = false;
  const audio = (() => {
    let ctx = null;
    let eng = null;
    let lastSpoken = new Map();
    function resume() {
      try {
        ctx ||= new AudioContext();
        ctx.resume();
        if (!eng) {
          // Engine: a low tone and a band of noise, both rising with the engine speed; wind noise with the airspeed.
          const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
          const d = noise.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = noise;
          src.loop = true;
          const band = ctx.createBiquadFilter();
          band.type = "bandpass";
          band.Q.value = 0.8;
          const windF = ctx.createBiquadFilter();
          windF.type = "lowpass";
          windF.frequency.value = 500;
          const noiseGain = ctx.createGain();
          const windGain = ctx.createGain();
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          const oscF = ctx.createBiquadFilter();
          oscF.type = "lowpass";
          oscF.frequency.value = 400;
          const oscGain = ctx.createGain();
          noiseGain.gain.value = windGain.gain.value = oscGain.gain.value = 0;
          src.connect(band).connect(noiseGain).connect(ctx.destination);
          src.connect(windF).connect(windGain).connect(ctx.destination);
          osc.connect(oscF).connect(oscGain).connect(ctx.destination);
          src.start();
          osc.start();
          eng = { band, noiseGain, windGain, osc, oscGain };
        }
      } catch {
        /* no audio */
      }
    }
    function update(f) {
      if (!eng || !ctx) return;
      const t = ctx.currentTime;
      const on = f && !muted && f.phase !== "loading" && f.phase !== "crashed";
      const n1 = on ? (f.eng.rpm ? f.eng.rpm / 2700 : f.eng.n1 / 100) : 0;
      const view = window.__hudState?.base?.view;
      const inside = view === "cockpit" || view === "hud";
      const loud = inside ? 0.5 : 1;
      eng.noiseGain.gain.setTargetAtTime(on ? 0.05 * n1 * n1 * loud : 0, t, 0.3);
      eng.band.frequency.setTargetAtTime(300 + 2500 * n1, t, 0.3);
      eng.osc.frequency.setTargetAtTime(f && f.eng.rpm ? (f.eng.rpm / 60) * 2 : 40 + 180 * n1, t, 0.3);
      eng.oscGain.gain.setTargetAtTime(on ? 0.035 * n1 * loud : 0, t, 0.3);
      eng.windGain.gain.setTargetAtTime(on ? clamp((f.ias - 60) / 300, 0, 1) * 0.07 : 0, t, 0.5);
    }
    function say(words, every = 0) {
      if (muted || !("speechSynthesis" in window)) return;
      const now = performance.now();
      if (every && now - (lastSpoken.get(words) || 0) < every) return;
      lastSpoken.set(words, now);
      const u = new SpeechSynthesisUtterance(words);
      u.rate = 1.15;
      u.pitch = 0.9;
      u.volume = 0.9;
      speechSynthesis.speak(u);
    }
    /** The autopilot's disconnect tone. */
    function cavalry() {
      if (!ctx || muted) return;
      const t = ctx.currentTime;
      for (let i = 0; i < 6; i++) {
        const o = ctx.createOscillator();
        const gn = ctx.createGain();
        o.frequency.value = i % 2 ? 1000 : 1350;
        gn.gain.setValueAtTime(0.08, t + i * 0.18);
        gn.gain.setValueAtTime(0, t + i * 0.18 + 0.15);
        o.connect(gn).connect(ctx.destination);
        o.start(t + i * 0.18);
        o.stop(t + i * 0.18 + 0.16);
      }
    }
    return { resume, update, say, cavalry };
  })();
  window.__cockpitAudio = audio;
  addEventListener("pointerdown", () => window.__hudState?.base?.flight && audio.resume());

  const RA_CALLS = [[2500, "twenty five hundred"], [1000, "one thousand"], [500, "five hundred"], [400, "four hundred"], [300, "three hundred"], [200, "two hundred"], [100, "one hundred"], [50, "fifty"], [40, "forty"], [30, "thirty"], [20, "twenty"], [10, "ten"]];
  let prev = null;
  function callouts(f) {
    if (!prev || f.phase === "loading") {
      prev = f;
      return;
    }
    // Take-off: the speed calls.
    if (f.onGround && f.phase === "takeoff") {
      const v = f.vspeeds;
      if (prev.ias < 100 && f.ias >= 100) audio.say("one hundred knots");
      if (prev.ias < v.v1 && f.ias >= v.v1) audio.say("V one");
      if (prev.ias < v.vr && f.ias >= v.vr) audio.say("rotate");
    }
    if (!f.onGround && prev.onGround && f.vs > 0) setTimeout(() => audio.say("positive climb"), 2000);
    // Radio altitude on the way down.
    if (!f.onGround && f.vs < -100) {
      for (const [ft, words] of RA_CALLS) if (prev.ra > ft && f.ra <= ft) audio.say(ft === 200 && f.phase === "approach" ? "minimums" : words);
      if (prev.ra > 20 && f.ra <= 20 && f.eng.lever > 0.02) audio.say("retard", 1500);
    }
    // Warnings, repeated while they last.
    const calls = { "PULL UP": "pull up", "SINK RATE": "sink rate", "TOO LOW GEAR": "too low, gear", "TOO LOW FLAPS": "too low, flaps", "BANK ANGLE": "bank angle", STALL: "stall, stall", OVERSPEED: "overspeed" };
    for (const w of f.warnings) if (calls[w]) audio.say(calls[w], 2600);
    if (f.ap.disconnect && !prev.ap.disconnect) audio.cavalry();
    prev = f;
  }

  // ---- air traffic control ----------------------------------------------------------------------------------------
  // The calls a flight hears, by phase: take-off clearance, the departure's radar contact, the descent and the
  // approach clearance, landing clearance, and vacating. Frequencies are the airports' own (OurAirports); the
  // controllers' words follow the standard phraseology, spoken and shown top centre for a while.
  const atc = (() => {
    const said = new Set();
    let shown = null;
    const box = el(`<div id="atc" hidden><small></small><span></span></div>`);
    addEventListener("DOMContentLoaded", () => document.body.append(box));
    const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
    const spell = (s) => String(s).split("").map((c) => (/\d/.test(c) ? DIGITS[+c] : c === "L" ? "left" : c === "R" ? "right" : c === "C" ? "centre" : c)).join(" ");
    const callsign = "November one two three";
    function freq(ap, types) {
      const f = ap?.freqs?.find((x) => types.includes(x[0]));
      return f ? { type: f[0], mhz: f[1] } : null;
    }
    function call(key, ap, types, fallback, words) {
      if (said.has(key)) return;
      said.add(key);
      const fq = freq(ap, types);
      const unit = `${ap?.city || ap?.ident || ""} ${fq ? { TWR: "Tower", APP: "Approach", DEP: "Departure", CTR: "Control", GND: "Ground" }[fq.type] || fq.type : fallback}`.trim();
      const text = `${callsign}, ${words}`;
      shown = { unit: `${unit}${fq ? ` · ${fq.mhz.toFixed(3)}` : ""}`, text, until: performance.now() + 14000 };
      audio.say(`${unit}. ${text}`);
    }
    function update(f, W) {
      const info = window.__flightInfo;
      if (!info) return;
      const wind = `wind ${spell(String(Math.round(f.wind.from / 10) * 10).padStart(3, "0"))} degrees ${Math.round(f.wind.kt)} knots`;
      if (f.phase === "takeoff" && f.ias < 30 && info.start === "runway") call("to", info.dep, ["TWR"], "Tower", `${wind}, runway ${f.dep.rwy}, cleared for take-off.`);
      if (!f.onGround && f.ra > 1500 && f.phase === "climb") call("dep", info.dep, ["DEP", "APP", "CTR"], "Departure", `radar contact, climb flight level ${Math.round(f.cruise / 100)}, proceed direct ${f.wp?.id || "on course"}.`);
      if (f.phase === "descent") call("des", info.arr, ["APP", "CTR"], "Approach", `descend and maintain five thousand feet, expect I L S approach runway ${f.arr.rwy}.`);
      if (f.dtg != null && f.dtg < 18 && !f.onGround) call("app", info.arr, ["APP"], "Approach", `turn to intercept the localizer, cleared I L S approach runway ${f.arr.rwy}.`);
      if (f.ils && f.ils.dme < 6 && f.ils.dme > 0 && !f.onGround) call("ldg", info.arr, ["TWR"], "Tower", `${wind}, runway ${f.arr.rwy}, cleared to land.`);
      if (f.phase === "rollout" && f.ias < 50) call("vac", info.arr, ["GND", "TWR"], "Ground", `vacate when able, taxi to the stand.`);
      if (shown && performance.now() < shown.until) {
        box.hidden = false;
        box.querySelector("small").textContent = shown.unit;
        box.querySelector("span").textContent = shown.text;
      } else box.hidden = true;
    }
    return {
      update,
      reset: () => {
        said.clear();
        shown = null;
        box.hidden = true;
      },
    };
  })();

  // ---- the frame ------------------------------------------------------------------------------------------------
  let lastT = performance.now();
  let arrWeather = null;
  function loadingScreen(f, W, H) {
    rect(0, 0, W, H, "rgba(4,7,11,0.55)");
    font(14, 700);
    text("LOADING SCENERY", W / 2, H / 2 - 18, WHITE, "center");
    font(12);
    text(f.place || "", W / 2, H / 2 + 4, CYAN, "center");
    const t = performance.now() / 400;
    for (let i = 0; i < 3; i++) rect(W / 2 - 18 + i * 14, H / 2 + 24, 8, 8, `rgba(255,196,91,${0.3 + 0.7 * Math.max(0, Math.sin(t - i * 0.6))})`);
  }

  window.__cockpit = (s, ctx, W, H) => {
    g = ctx;
    const f = s.base.flight;
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    if (!f) return false;
    if (f.phase === "loading") {
      arrWeather = null;
      atc.reset();
      strip.hidden = true;
      loadingScreen(f, W, H);
      return true;
    }
    if (f.phase === "crashed" || !f.ap) {
      strip.hidden = true;
      showReport(f);
      audio.update(null);
      return f.phase === "crashed";
    }
    // Out of the aircraft: the sandbox's own free-flight HUD.
    if (s.mode === "free" || s.mode === "command") {
      strip.hidden = true;
      return false;
    }
    callouts(f);
    audio.update(f);
    atc.update(f, W);
    // Live weather: the destination's report once on the way down.
    if (f.arr && window.__flightMetar?.live() && (f.phase === "descent" || f.phase === "approach") && arrWeather !== f.arr.icao) {
      arrWeather = f.arr.icao;
      window.__flightMetar.apply(f.arr.icao);
    }
    showReport(f);
    guideCue(f, W, H);
    if (window.__detailedCockpit?.(s) || document.body.classList.contains("deck-active")) { strip.hidden = true; return true; }
    const cockpit = s.base.view === "cockpit";
    // The flight deck is modelled: its screens are on the 3D panel (displays.js), and only the head-up display (in
    // its glass; flight instruments over the view) is drawn over it.
    const modelled = cockpit && s.base.station;
    // The HUD view: the seat without the flight deck, the head-up symbology over the middle of the view.
    const headUpOnly = s.base.view === "hud";
    if (!showPanel) {
      strip.hidden = true;
      // Just the essentials, top centre: speed, altitude, the flight mode annunciator.
      if (!modelled) topFma(f, W);
      if (headUpOnly) headUp(s, f, W, H);
      return true;
    }
    // The bottom 22 px stay clear for the map data credits.
    const foot = 22;
    if (headUpOnly) {
      topFma(f, W);
      headUp(s, f, W, H);
      dock(s, f, W, 116);
    } else if (modelled) {
      if (s.base.combiner) headUp(s, f, W, H);
      dock(s, f, W, 60);
    } else if (!cockpit) {
      // Chase view: nothing over the aircraft; the controls only while the mouse is free to click them.
      topFma(f, W);
      chaseInstruments(f, W, H, foot);
      dock(s, f, W, 116);
    } else if (f.panel === "ga") {
      const h = clamp(H * 0.34, 220, 330);
      gaPanel(f, 0, H - h - foot, W, h, dt);
      rect(0, H - foot, W, foot, "#1b1f24");
      placeStrip(f, H - h - foot);
    } else if (cockpit) {
      const h = clamp(H * 0.36, 240, 400);
      rect(0, H - h - foot - 6, W, h + foot + 6, "#12161b");
      const sz = h - 6;
      const ew = Math.min(sz * 0.9, W - sz * 2 - 30);
      const total = sz * 2 + ew + 20;
      const x0 = Math.max(6, (W - total) / 2);
      const top = H - h - foot;
      pfd(f, x0, top, sz);
      nd(f, x0 + sz + 10, top, sz);
      if (ew > 120) ewd(f, x0 + sz * 2 + 20, top, ew, sz);
      placeStrip(f, top - 6);
    }
    renderMcdu(f);
    return true;
  };

  /**
   * The controls strip at the top, over the sky rather than the aircraft or the panel, while the mouse is free to
   * click it (Esc); a hint otherwise.
   */
  function dock(s, f, W, top) {
    // The controllers' calls (top right) go under it while it shows.
    const calls = document.getElementById("atc");
    if (!s.base.locked) {
      renderStrip(f);
      strip.hidden = false;
      strip.style.bottom = "";
      strip.style.top = `${top}px`;
      if (calls) calls.style.top = `${top + strip.offsetHeight + 8}px`;
      return;
    }
    if (calls) calls.style.top = "";
    strip.hidden = true;
    font(11, 600);
    text("ESC · AUTOPILOT AND SYSTEMS", W / 2, top + 10, "rgba(233,238,245,0.55)", "center");
  }

  function placeStrip(f, top) {
    renderStrip(f);
    strip.hidden = false;
    strip.style.top = "";
    strip.style.bottom = `${innerHeight - top + 4}px`;
  }

  // ---- keys and mount ---------------------------------------------------------------------------------------------
  window.addEventListener(
    "keydown",
    (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
      if (typing || !window.__hudState?.base?.flight) return;
      if (e.code === "KeyI") showPanel = !showPanel;
      else if (e.code === "KeyN") {
        const i = RANGES.indexOf(ndRange);
        ndRange = i < 0 ? 10 : i === RANGES.length - 1 ? 0 : RANGES[i + 1];
      } else if (e.code === "KeyU") {
        mcdu.hidden = !mcdu.hidden;
        mcduKey = "";
        if (!mcdu.hidden) document.exitPointerLock?.();
      }
    },
    true,
  );
  addEventListener("DOMContentLoaded", () => {
    document.body.append(strip, mcdu, report);
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
  });

  const CSS = `
    #fcu { position: fixed; left: 50%; transform: translateX(-50%); z-index: 12; display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: calc(100vw - 20px); font: 600 11px ui-monospace, Menlo, monospace; color: #e9eef5; pointer-events: auto; }
    #fcu[hidden], #mcdu[hidden], #flight-report[hidden], #sim-flight[hidden] { display: none; }
    #fcu .grp { display: flex; align-items: center; gap: 5px; padding: 5px 7px; border-radius: 9px; background: rgba(20, 24, 30, 0.9); border: 1px solid rgba(255,255,255,0.08); }
    #fcu .win { display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto; align-items: center; gap: 0 4px; padding: 2px 6px; border-radius: 6px; background: #05080c; }
    #fcu .win small { grid-column: 1 / -1; color: #93a0b2; font-size: 9px; letter-spacing: .1em; }
    #fcu .win output { min-width: 50px; color: #ffb000; font-size: 15px; font-weight: 700; }
    #fcu .k { display: flex; gap: 2px; }
    #fcu button { padding: 5px 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.1); background: #2a313a; color: #e9eef5; font: inherit; cursor: pointer; }
    #fcu button:hover { filter: brightness(1.25); }
    #fcu button.on { background: #1d5132; border-color: #3dff6e; color: #3dff6e; }
    #fcu button.on.warn { background: #4d3a0e; border-color: #ffb000; color: #ffb000; }
    #fcu .btns { display: flex; gap: 3px; }
    #fcu .seg { display: flex; align-items: center; gap: 2px; }
    #fcu .seg small { margin-right: 3px; color: #93a0b2; font-size: 9px; letter-spacing: .1em; }
    #atc { position: fixed; top: 122px; right: 10px; z-index: 12; max-width: min(360px, calc(100vw - 40px)); display: flex; flex-direction: column; gap: 2px; padding: 8px 14px; border-radius: 10px; background: rgba(8, 12, 18, 0.82); border: 1px solid rgba(124,196,255,.3); color: #e9eef5; font: 13px/1.4 Inter, system-ui, sans-serif; pointer-events: none; }
    #atc[hidden] { display: none; }
    #atc small { color: #7cc4ff; font: 700 10px ui-monospace, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    #mcdu { position: fixed; right: 12px; top: 70px; z-index: 30; width: 300px; max-height: calc(100vh - 140px); display: flex; flex-direction: column; border-radius: 12px; background: #0a0e13; border: 1px solid rgba(255,255,255,0.12); color: #3dff6e; font: 600 12px ui-monospace, Menlo, monospace; box-shadow: 0 18px 50px rgba(0,0,0,.5); }
    #mcdu header { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; color: #f2f4f6; border-bottom: 1px solid rgba(255,255,255,0.08); }
    #mcdu header button { border: 0; background: none; color: #93a0b2; cursor: pointer; font-size: 14px; }
    #mcdu .rows { overflow: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; }
    #mcdu .rows button { display: grid; grid-template-columns: 1fr auto 70px; gap: 8px; padding: 5px 8px; border: 0; border-radius: 5px; background: transparent; color: #3dff6e; font: inherit; text-align: left; cursor: pointer; }
    #mcdu .rows button:hover { background: rgba(255,255,255,0.06); }
    #mcdu .rows button.act { color: #f2f4f6; background: rgba(255,255,255,0.05); }
    #mcdu .rows button.past { color: #5b6470; }
    #mcdu .rows span { color: #ff6bff; }
    #mcdu .rows small { color: #3fe0ff; text-align: right; }
    #mcdu footer { padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.08); color: #3fe0ff; font-size: 11px; line-height: 1.5; }
    #flight-report { position: fixed; inset: 0; z-index: 45; display: grid; place-items: center; background: rgba(4,6,10,0.35); }
    #flight-report .card { width: min(460px, calc(100vw - 32px)); padding: 20px 22px; border-radius: 16px; background: rgba(14,18,25,0.92); border: 1px solid rgba(255,255,255,0.1); color: #e9eef5; font: 13px/1.45 Inter, system-ui, sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,.45); }
    #flight-report .kicker { color: #62d6a0; letter-spacing: .14em; font-size: 11px; }
    #flight-report h2 { margin: 4px 0 10px; font-size: 22px; }
    #flight-report .score { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
    #flight-report .score i { display: block; height: 100%; background: #62d6a0; }
    #flight-report dl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
    #flight-report dl div { padding: 8px 10px; border-radius: 9px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
    #flight-report dt { color: #93a0b2; font-size: 11px; }
    #flight-report dd { margin: 2px 0 0; font-weight: 700; }
    #flight-report .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    #flight-report .actions button { flex: 1; padding: 10px 12px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #e9eef5; font: 700 13px Inter, system-ui, sans-serif; cursor: pointer; }
    #flight-report .actions button.primary { background: #62d6a0; border-color: #62d6a0; color: #07140d; }
    /* The planner (flight.js). */
    #sim-flight { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; background: rgba(4, 6, 10, 0.35); }
    #sim-flight .fp { width: min(1240px, calc(100vw - 32px)); height: min(800px, calc(100vh - 40px)); display: flex; flex-direction: column; border-radius: 16px; background: var(--glass, rgba(14,18,25,.8)); border: 1px solid var(--line, rgba(255,255,255,.09)); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2); box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45); color: #273347; font: 13px/1.45 Inter, system-ui, sans-serif; overflow: hidden; }
    #sim-flight header { display: flex; align-items: baseline; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #dbe3ee; }
    #sim-flight header b { letter-spacing: .14em; color: #2864ed; }
    #sim-flight header .sub { color: #526179; }
    #sim-flight header .close { margin-left: auto; border: 0; background: none; color: #526179; font-size: 15px; cursor: pointer; }
    #sim-flight .fp-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
    #sim-flight .fp-loading { color: #526179; }
    #sim-flight .fp-layout { display: grid; grid-template-columns: 1fr 480px; gap: 16px; }
    #sim-flight .fp-grid { display: flex; flex-direction: column; gap: 14px; }
    #sim-flight h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #526179; }
    #sim-flight .fp-ap { padding: 12px; border-radius: 12px; border: 1px solid #dbe3ee; background: #f8fafc; }
    #sim-flight .fp-search { position: relative; }
    #sim-flight input[type=search] { width: 100%; box-sizing: border-box; padding: 9px 11px; border-radius: 8px; border: 1px solid #dbe3ee; background: #f2f5fa; color: #273347; font: 14px Inter, system-ui, sans-serif; }
    #sim-flight .fp-results { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    #sim-flight .fp-results:empty { display: none; }
    #sim-flight .fp-results button { display: grid; grid-template-columns: 22px 56px 36px 1fr auto; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; background: #f4f7fb; color: #273347; font: inherit; text-align: left; cursor: pointer; }
    #sim-flight .fp-results button:hover { background: #dbe3ee; }
    #sim-flight .fp-results i { color: #2864ed; font-style: normal; font-size: 11px; }
    #sim-flight .fp-results span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #sim-flight .fp-results small { color: #526179; }
    #sim-flight .flag { width: 20px; height: 15px; border-radius: 3px; object-fit: cover; }
    #sim-flight .fp-sel { display: flex; gap: 10px; align-items: center; margin: 10px 0 8px; }
    #sim-flight .fp-sel:empty { display: none; }
    #sim-flight .fp-sel small { display: block; color: #526179; }
    #sim-flight .fp-rwys { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
    #sim-flight .rwy { display: grid; grid-template-columns: auto 1fr; gap: 0 8px; padding: 7px 9px; border-radius: 9px; border: 1px solid #dbe3ee; background: #f4f7fb; color: #273347; font: inherit; text-align: left; cursor: pointer; }
    #sim-flight .rwy b { grid-row: span 2; font-size: 17px; align-self: center; }
    #sim-flight .rwy small { color: #2864ed; }
    #sim-flight .rwy small.tail { color: #925000; }
    #sim-flight .rwy.on { border-color: #2864ed; background: #eaf1ff; }
    #sim-flight .rwy.short { opacity: .5; }
    #sim-flight .fp-side { display: flex; flex-direction: column; gap: 10px; }
    #sim-flight .fp-types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    #sim-flight .fp-types button { display: flex; flex-direction: column; align-items: flex-start; padding: 6px; border-radius: 10px; border: 1px solid #dbe3ee; background: #f4f7fb; color: #273347; font: inherit; cursor: pointer; }
    #sim-flight .fp-types button.on { border-color: #2864ed; background: #eaf1ff; }
    #sim-flight .fp-types img { background: radial-gradient(ellipse at 50% 35%, #647c99, #253951); border-radius: 6px; margin-bottom: 6px; width: 100%; aspect-ratio: 16/10; object-fit: contain; }
    #sim-flight .fp-types small { color: #526179; font-size: 10px; }
    #sim-flight .hint { margin: 0; color: #526179; font-size: 11px; }
    #sim-flight .fp-plan { display: flex; flex-direction: column; gap: 8px; }
    #sim-flight .fp-row { display: grid; grid-template-columns: 70px 1fr auto; align-items: center; gap: 10px; }
    #sim-flight .fp-row label { color: #536781; }
    #sim-flight .fp-row select { padding: 7px; border-radius: 7px; border: 1px solid #dbe3ee; background: #f2f5fa; color: #273347; font: inherit; }
    #sim-flight .fp-row input[type=range] { accent-color: #2864ed; }
    #sim-flight .fp-row output { font: 600 12px ui-monospace, Menlo, monospace; }
    #sim-flight .seg { display: flex; gap: 4px; grid-column: 2 / -1; }
    #sim-flight .seg button { flex: 1; padding: 7px 6px; border-radius: 8px; border: 1px solid #dbe3ee; background: #f3f6fb; color: #273347; font: 600 12px Inter, system-ui, sans-serif; cursor: pointer; }
    #sim-flight .seg button.on { background: #2864ed; border-color: #2864ed; color: #ffffff; }
    #sim-flight .fp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 0; }
    #sim-flight .fp-stats div { padding: 7px 9px; border-radius: 9px; background: #f4f7fb; border: 1px solid rgba(255,255,255,.08); }
    #sim-flight .fp-stats div.over dd { color: #925000; }
    #sim-flight .fp-stats dt { color: #526179; font-size: 11px; }
    #sim-flight .fp-stats dd { margin: 0; font-weight: 700; }
    #sim-flight .fp-map { width: 100%; height: auto; }
    #sim-flight .fp-metar { display: flex; flex-direction: column; gap: 3px; }
    #sim-flight .fp-keys { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08); color: #526179; font-size: 12px; }
    #sim-flight .fp-keys kbd { margin-right: 3px; }
    #sim-flight .fp-metar code { padding: 5px 8px; border-radius: 7px; background: #edf2f7; color: #2864ed; font: 11px ui-monospace, Menlo, monospace; white-space: normal; }
    #sim-flight .fp-map.empty { display: grid; place-items: center; height: 200px; border-radius: 10px; background: #edf2f7; color: #526179; }
    #sim-flight .fp-map .bg { fill: #edf2f7; }
    #sim-flight .fp-map .ap { fill: rgba(255,255,255,.28); }
    #sim-flight .fp-map .route { fill: none; stroke: #3dff6e; stroke-width: 2; }
    #sim-flight .fp-map .wp circle { fill: #2459d6; }
    #sim-flight .fp-map .end circle { fill: #fff; }
    #sim-flight .fp-map text { fill: #273347; font: 600 11px ui-monospace, Menlo, monospace; }
    #sim-flight .actions { display: flex; gap: 8px; }
    #sim-flight .actions button { flex: 1; padding: 11px 12px; border-radius: 9px; border: 1px solid #dbe3ee; background: #f3f6fb; color: #273347; font: 700 13px Inter, system-ui, sans-serif; cursor: pointer; }
    #sim-flight .actions button.primary { background: #2864ed; border-color: #2864ed; color: #ffffff; }
    #sim-flight .actions button:disabled { opacity: .4; cursor: default; }
    #sim-bar #sim-fly { color: #2864ed; }
    @media (max-width: 960px) { #sim-flight .fp-layout { grid-template-columns: 1fr; } }
  `;
})();
