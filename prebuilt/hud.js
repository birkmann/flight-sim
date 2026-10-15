// Flight instruments and free-camera overlay, driven by the simulation HUD state.
(function () {
  const canvas = document.createElement("canvas");
  canvas.id = "hudcanvas";
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:9;pointer-events:none";
  // Lightning goes on its own layer, under the HUD.
  const fxCanvas = document.createElement("canvas");
  fxCanvas.id = "fxcanvas";
  fxCanvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:8;pointer-events:none";
  document.addEventListener("DOMContentLoaded", () => document.body.append(fxCanvas, canvas));
  const g = canvas.getContext("2d");
  const fg = fxCanvas.getContext("2d");
  // Whether anything was painted on the HUD's canvas this frame (here or by cockpit.js): an untouched canvas is not
  // cleared again, so the compositor need not take a new full-screen picture of it every frame.
  let drawn = false;
  for (const m of ["fill", "stroke", "fillRect", "strokeRect", "fillText", "strokeText", "drawImage", "putImageData"]) {
    const draw = g[m];
    g[m] = function () {
      drawn = true;
      return draw.apply(this, arguments);
    };
  }
  let painted = true;
  let fxPainted = true;

  const GREEN = "#6dff8a";
  const AMBER = "#ffc24a";
  const WHITE = "#f4f6f8";
  const RED = "#ff4d4d";
  const KT = 1.943844;
  const FT = 3.28084;

  let W = 0;
  let H = 0;
  let blink = false;
  setInterval(() => (blink = !blink), 350);

  function size() {
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth;
    const h = innerHeight;
    for (const c of [canvas, fxCanvas]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    fg.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = w;
    H = h;
  }

  // ---- drawing helpers ----------------------------------------------------------------------------------------
  const pad = (n, w) => String(Math.round(n)).padStart(w, "0");
  const fmt = (n, d = 0) => (n == null || !isFinite(n) ? "—" : n.toFixed(d));
  /** Stroke and fill colour; `glow` is a halo in the same colour, or in `halo` (a dark one keeps white text legible on bright video). */
  function style(color, width = 1.6, glow = true, halo = color) {
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = width;
    g.shadowColor = glow ? halo : "transparent";
    g.shadowBlur = glow ? (halo === color ? 6 : 3) : 0;
    g.lineCap = "round";
    g.lineJoin = "round";
  }
  function font(px, weight = 600) {
    g.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  }
  function text(s, x, y, align = "left", base = "middle") {
    g.textAlign = align;
    g.textBaseline = base;
    g.fillText(s, x, y);
  }
  function line(x1, y1, x2, y2) {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }
  function box(x, y, w, h) {
    g.strokeRect(x, y, w, h);
  }
  const ndc = (p) => (p ? [((p[0] + 1) / 2) * W, ((1 - p[1]) / 2) * H] : null);
  /** Pixels per degree at the centre of the view. */
  const ppd = (s) => H / 2 / Math.tan(s.base.fov / 2) * (Math.PI / 180);

  // ---- shared pieces ------------------------------------------------------------------------------------------
  function headingTape(hdg, cx, y, width, color) {
    style(color);
    font(12);
    const span = 60;
    const px = width / span;
    g.save();
    g.beginPath();
    g.rect(cx - width / 2, y - 18, width, 36);
    g.clip();
    for (let d = Math.floor((hdg - span / 2) / 5) * 5; d <= hdg + span / 2; d += 5) {
      const x = cx + (d - hdg) * px;
      const major = d % 10 === 0;
      line(x, y + 8, x, y + (major ? 0 : 4));
      if (major) text(pad(((d % 360) + 360) % 360 / 10, 2), x, y - 6, "center");
    }
    g.restore();
    g.beginPath();
    g.moveTo(cx, y + 10);
    g.lineTo(cx - 5, y + 17);
    g.lineTo(cx + 5, y + 17);
    g.closePath();
    g.fill();
    font(13, 700);
    box(cx - 24, y + 20, 48, 18);
    text(pad(((hdg % 360) + 360) % 360, 3), cx, y + 29, "center");
  }

  /** A vertical tape (speed on the left, altitude on the right) with its value boxed. */
  function tape(value, x, cy, step, major, side, color, label) {
    style(color);
    font(12);
    const h = 220;
    const px = h / (step * 10);
    g.save();
    g.beginPath();
    g.rect(side < 0 ? x - 70 : x, cy - h / 2, 70, h);
    g.clip();
    for (let v = Math.floor((value - step * 6) / step) * step; v <= value + step * 6; v += step) {
      const y = cy - (v - value) * px;
      const isMajor = Math.round(v / step) % (major / step) === 0;
      line(x, y, x + side * (isMajor ? 12 : 6), y);
      if (isMajor) text(String(Math.round(v)), x + side * 16, y, side < 0 ? "right" : "left");
    }
    g.restore();
    line(x, cy - h / 2, x, cy + h / 2);
    font(15, 700);
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.shadowBlur = 0;
    const bw = 64;
    const bx = side < 0 ? x - 8 - bw : x + 8;
    g.fillRect(bx, cy - 12, bw, 24);
    style(color);
    box(bx, cy - 12, bw, 24);
    text(String(Math.round(value)), bx + bw / 2, cy, "center");
    font(11);
    text(label, bx + bw / 2, cy - h / 2 - 12, "center");
  }

  function contacts(s, color) {
    style(color, 1.2, false);
    font(10, 600);
    for (const c of s.base.contacts) {
      const p = ndc(c.xy);
      if (!p) continue;
      const r = 9;
      const [x, y] = p;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        line(x + dx * r, y + dy * r, x + dx * (r - 4), y + dy * r);
        line(x + dx * r, y + dy * r, x + dx * r, y + dy * (r - 4));
      }
      text(`${c.label} ${c.range < 1000 ? Math.round(c.range) + "m" : (c.range / 1000).toFixed(1) + "km"}`, x + r + 4, y - r, "left", "top");
    }
  }

  function banner(s) {
    if (s.base.message) {
      style(WHITE, 1, false);
      font(15, 700);
      g.fillStyle = "rgba(0,0,0,0.55)";
      const w = g.measureText(s.base.message).width + 28;
      g.fillRect(W / 2 - w / 2, 128, w, 28);
      g.fillStyle = WHITE;
      text(s.base.message, W / 2, 142, "center");
    }
  }

  function warning(label, y, color = RED) {
    if (!blink) return;
    style(color, 2);
    font(22, 800);
    const w = g.measureText(label).width + 24;
    box(W / 2 - w / 2, y - 16, w, 32);
    text(label, W / 2, y, "center");
  }

  function health(s, x, y, color) {
    if (s.health >= 0.999) return;
    style(color, 1, false);
    font(11);
    text("DMG", x, y, "left");
    box(x + 34, y - 5, 80, 10);
    g.fillStyle = s.health > 0.5 ? color : RED;
    g.fillRect(x + 34, y - 5, 80 * Math.max(0, s.health), 10);
  }

  function crosshair(color, r = 7) {
    style(color, 1.5);
    const cx = W / 2;
    const cy = H / 2;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
  }

  // ---- weather over the view ----------------------------------------------------------------------------------
  // Rain and snow are in the 3D scene and on its lens (src/weather/precip.rs); lightning lights up the view here.
  function weatherFx(fx) {
    if (fxPainted) fg.clearRect(0, 0, W, H);
    fxPainted = fx.flash > 0.02;
    if (fxPainted) {
      fg.fillStyle = `rgba(235,240,255,${Math.min(0.55, fx.flash * 0.5)})`;
      fg.fillRect(0, 0, W, H);
    }
  }

  // ---- free flight --------------------------------------------------------------------------------------------
  function free(s) {
    contacts(s, "#8fe3ff");
    crosshair("rgba(255,255,255,0.85)");
    headingTape(s.heading, W / 2, 84, 360, WHITE);
    style(WHITE, 1, false);
    font(13);
    const lat = s.base.lat;
    const lon = s.base.lon;
    const status = `FREE CAMERA  ${Math.round(s.speed)} m/s  ALT ${Math.round(s.alt)} m  ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}  ${s.spawned} aircraft`;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(10, H - 70, g.measureText(status).width + 20, 30);
    g.fillStyle = WHITE;
    text(status, 20, H - 55);
  }

  // ---- jet ----------------------------------------------------------------------------------------------------
  function ladder(s, color) {
    const cx = W / 2;
    const cy = H / 2;
    const k = ppd(s);
    // The view's own attitude: from a modelled cockpit the eye looks a little down, not along the airframe.
    const [pitch, bank] = s.base.cam ?? [s.pitch, s.bank];
    g.save();
    g.translate(cx, cy);
    g.rotate((-bank * Math.PI) / 180);
    style(color, 1.6);
    font(12);
    for (let a = -90; a <= 90; a += 5) {
      const dy = (pitch - a) * k;
      if (Math.abs(dy) > H * 0.38) continue;
      const half = a === 0 ? W * 0.32 : 90;
      const gap = 36;
      if (a === 0) {
        line(-half, dy, -gap, dy);
        line(gap, dy, half, dy);
        continue;
      }
      g.setLineDash(a < 0 ? [8, 6] : []);
      const tick = a > 0 ? 8 : -8;
      line(-half, dy, -gap, dy);
      line(-half, dy, -half, dy + tick);
      line(gap, dy, half, dy);
      line(half, dy, half, dy + tick);
      g.setLineDash([]);
      text(String(Math.abs(a)), -half - 8, dy, "right");
      text(String(Math.abs(a)), half + 8, dy, "left");
    }
    g.restore();
  }

  function flightPathMarker(s, color) {
    const p = ndc(s.fpm);
    if (!p) return;
    const [x, y] = p;
    style(color, 1.8);
    g.beginPath();
    g.arc(x, y, 7, 0, Math.PI * 2);
    g.stroke();
    line(x - 7, y, x - 20, y);
    line(x + 7, y, x + 20, y);
    line(x, y - 7, x, y - 14);
  }

  function waterline(color) {
    const cx = W / 2;
    const cy = H / 2;
    style(color, 1.6);
    g.beginPath();
    g.moveTo(cx - 22, cy);
    g.lineTo(cx - 12, cy);
    g.lineTo(cx - 6, cy + 8);
    g.lineTo(cx, cy);
    g.lineTo(cx + 6, cy + 8);
    g.lineTo(cx + 12, cy);
    g.lineTo(cx + 22, cy);
    g.stroke();
  }

  /**
   * Where a jet's symbology goes: inside the head-up display's glass in a modelled cockpit (its outline on screen, from
   * the app), otherwise about the middle of the view.
   */
  function hudLayout(s) {
    const c = s.base.view === "cockpit" && s.base.station && s.base.combiner;
    if (!c) return { cx: W / 2, cy: H / 2, hw: 330, top: 84, bottom: H - 110 };
    const pts = c.map(([nx, ny]) => [((nx + 1) / 2) * W, ((1 - ny) / 2) * H]);
    const [x0, x1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
    const [y0, y1] = [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hw: (x1 - x0) / 2, top: y0 + 22, bottom: y1 - 44, pts };
  }

  function jet(s) {
    // Civilian aircraft use the deck's telemetry strip and physical instruments.
    // Keep urgent flight warnings, without duplicating gauges over the scenery.
    if (!s.arms && window.__deckFlight && document.body.classList.contains("deck-active")) {
      return; // FlightFeedback renders both visual warnings and audio for this UI.
    }
    const color = GREEN;
    // From the pilot's seat, with the modelled cockpit or without it (the HUD view).
    const cockpit = s.base.view === "cockpit" || s.base.view === "hud";
    // A modelled cockpit without a head-up display: the flight instruments remain over the view; an
    // unarmed aircraft has only its panel.
    if (cockpit && s.base.station && !s.base.combiner && !s.arms) {
      if (s.pullUp) warning("PULL UP", H / 2 + 70);
      else if (s.stall) warning("STALL", H / 2 + 70, AMBER);
      return;
    }
    const L = hudLayout(s);
    if (L.pts) {
      g.save();
      g.beginPath();
      L.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.clip();
    }
    contacts(s, color);
    if (cockpit) {
      ladder(s, color);
      waterline(color);
    } else {
      crosshair(color, 4);
    }
    flightPathMarker(s, color);
    headingTape(s.heading, L.cx, L.top, Math.min(300, L.hw * 1.5), color);
    tape(s.speed * KT, L.cx - L.hw * 0.76, L.cy, 10, 50, -1, color, "KCAS");
    tape(s.alt * FT, L.cx + L.hw * 0.76, L.cy, 100, 500, 1, color, "ALT FT");
    style(color);
    font(13, 700);
    const lx = L.cx - L.hw;
    const ly = L.cy + L.hw * 0.42;
    text(`G  ${fmt(s.g, 1)}`, lx, ly);
    text(`α  ${fmt(s.alpha, 1)}°`, lx, ly + 20);
    text(`M  ${fmt(s.mach, 2)}`, lx, ly + 40);
    const rx = L.cx + L.hw * 0.76;
    text(`VS ${fmt((s.vs * FT * 60) / 1000, 1)}K`, rx, ly);
    text(`R  ${s.agl == null ? "---" : Math.round(s.agl * FT)}`, rx, ly + 20);
    text(`THR ${Math.round(s.throttle * 100)}%${s.ab && s.throttle > 0.9 ? " AB" : ""}`, rx, ly + 40);
    font(12, 600);
    const bx = L.cx - L.hw;
    const by = L.bottom;
    text(`${s.label}${s.onGround ? "  WOW" : ""}`, bx, by);
    style(color);
    if (s.hasGear) text(s.gear ? "GEAR DN" : "GEAR UP", bx, by + 36);
    if (s.speedbrake) text("SPD BRK", bx, by + 54);
    // Swing wings: the sweep, and whether the schedule sets it (Y picks a fixed one).
    if (s.wing) text(`WING ${Math.round(s.wing.deg)}°${s.wing.auto ? " AUTO" : ""}`, bx, by + (s.speedbrake ? 72 : 54));

    if (s.pullUp) warning("PULL UP", H / 2 + 70);
    else if (s.stall) warning("STALL", H / 2 + 70, AMBER);
    else if (s.gearWarning) warning("GEAR", H / 2 + 70, AMBER);
    if (L.pts) g.restore();
  }

  // ---- entry point --------------------------------------------------------------------------------------------
  window.__hud = (json) => {
    const s = JSON.parse(json);
    window.__hudState = s;
    size();
    if (s.base.fx) weatherFx(s.base.fx);
    if (painted) g.clearRect(0, 0, W, H);
    drawn = false;
    try {
      frame(s);
    } finally {
      painted = drawn;
    }
  };
  function frame(s) {
    g.save();
    // A flight (flight.js) has its own flight deck (cockpit.js).
    if (s.base.flight && window.__cockpit?.(s, g, W, H)) {
      g.restore();
      banner(s);
      return;
    }
    if (window.__detailedCockpit?.(s)) { g.restore(); banner(s); return; }
    switch (s.mode) {
      case "free":
        free(s);
        break;
      case "jet":
        jet(s);
        break;

    }
    g.restore();
    banner(s);
  }
})();
