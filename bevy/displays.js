// The screens of the modelled crew stations (src/sandbox/station.rs): the app asks window.__display(name) for a
// screen's picture a few times a second and puts the pixels on every screen of that name in the cockpit. A flight's
// aircraft shows its flight deck's displays (cockpit.js draws them); any other vehicle gets these simpler pages from
// the HUD state (see `hud` in src/sandbox.rs):
//   pfd              attitude, speed, altitude, heading, vertical speed
//   nd, mfd-nav      heading-up map of the others nearby (red and blue, air and surface), range rings
//   ewd, sd, mfd-status  the vehicle's state: speed, throttle, engine state and landing gear
//   ga               a light aircraft's panel: the attitude page and the state page side by side
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  const GREEN = "#3dff6e";
  const CYAN = "#3fe0ff";
  const AMBER = "#ffb000";
  const RED = "#ff3b30";
  const WHITE = "#f2f4f6";
  const GREY = "#5b6470";
  const SKY = "#1f73d6";
  const EARTH = "#8a5a2b";
  const BLUE = "#6aa8ff";
  const KT = 1.943844;
  const FT = 3.28084;
  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad3 = (n) => String(Math.round(((n % 360) + 360) % 360) || 360).padStart(3, "0");

  /** Picture sizes (px): as wide over high as the screens built for them (COCKPIT_DISPLAY_ASPECT in the models). */
  const SIZE = { engine: [1024, 366], radio: [512, 1024], ga: [1280, 512], glider: [1024, 576] };
  const screens = new Map();

  function surface(name) {
    let sc = screens.get(name);
    if (!sc) {
      const [w, h] = SIZE[name] ?? [512, 512];
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      // Read back every time: kept on the CPU.
      sc = { ctx: canvas.getContext("2d", { willReadFrequently: true }), w, h, last: performance.now() };
      screens.set(name, sc);
    }
    return sc;
  }

  window.__display = (name) => {
    const detailed = window.__cockpitTexture?.(name);
    if (detailed) return detailed;
    const s = window.__hudState;
    const sc = surface(name);
    const { ctx: g, w, h } = sc;
    const now = performance.now();
    const dt = Math.min(0.5, (now - sc.last) / 1000);
    sc.last = now;
    g.save();
    const f = window.__deckFlight ?? s?.base?.flight;
    // The light aircraft's engine and radio pages change only with what they show: an unchanged page is not drawn
    // and read back again (the needles to a fraction of a pixel).
    if(name === "engine" || name === "radio") {
      const page = name === "engine" ? engineGauges(f,s) : radioRows(f,s);
      const key = JSON.stringify(name === "engine" ? page.map(([, value, min, max]) => Number.isFinite(value) ? Math.round(clamp((value-min)/(max-min),0,1)*2000) : null) : page);
      if (key !== sc.key || !sc.pixels) {
        if(name === "engine") enginePage(g,w,h,page); else radioPage(g,w,h,page);
        sc.pixels = g.getImageData(0,0,w,h).data;
        sc.key = key;
      }
      g.restore();
      return sc.pixels;
    }
    const drawn = f?.ap && window.__flightScreens?.(name, g, w, h, f, dt);
    g.restore();
    if (!drawn) {
      g.save();
      vehicleScreen(g, name, w, h, s);
      g.restore();
    }
    return g.getImageData(0, 0, w, h).data;
  };

  function engineGauges(f,s) {
    return [
      ["RPM",s?.rpm??f?.eng?.rpm,0,3000,"×100",100],
      ["POWER",(s?.throttle??f?.eng?.lever??0)*100,0,100,"PERCENT",1],
      ["FUEL",f?.fuel,0,200,"kg",1],
    ];
  }

  function enginePage(g,w,h,gauges) {
    g.fillStyle="#242522";g.fillRect(0,0,w,h);
    gauges.forEach(([label,value,min,max,unit,scale],i)=>{
      const x=176+i*336,y=h/2,r=135;
      g.save();g.translate(x,y);
      const face=g.createRadialGradient(-35,-50,10,0,0,r);face.addColorStop(0,"#202322");face.addColorStop(1,"#080b0d");
      g.fillStyle=face;g.beginPath();g.arc(0,0,r,0,Math.PI*2);g.fill();
      const point=(t,radius)=>{const a=(-135+t*270)*Math.PI/180;return [Math.sin(a)*radius,-Math.cos(a)*radius];};
      for(let tick=0;tick<=20;tick++) {
        const a=point(tick/20,tick%5===0?99:109),b=point(tick/20,119);
        g.strokeStyle="#d9d7cd";g.lineWidth=tick%5===0?3:1.5;g.beginPath();g.moveTo(...a);g.lineTo(...b);g.stroke();
        if(tick%5===0){const p=point(tick/20,78);g.fillStyle="#d9d7cd";g.font="19px sans-serif";g.textAlign="center";g.textBaseline="middle";g.fillText(String(Math.round((min+(max-min)*tick/20)/scale)),...p);}
      }
      g.textAlign="center";g.fillStyle="#b7b9b0";g.font="17px sans-serif";g.fillText(label,0,-32);g.font="14px sans-serif";g.fillText(unit,0,62);
      if(Number.isFinite(value)) {
        const tip=point(clamp((value-min)/(max-min),0,1),106);
        g.strokeStyle="#ede7cf";g.lineWidth=4;g.beginPath();g.moveTo(-tip[0]*.16,-tip[1]*.16);g.lineTo(...tip);g.stroke();
      } else {g.fillStyle="#deb765";g.font="16px sans-serif";g.fillText("—",0,30);}
      g.fillStyle="#202627";g.beginPath();g.arc(0,0,10,0,Math.PI*2);g.fill();g.restore();
    });
  }

  function radioRows(f,s) {
    return [
      ["AUDIO PANEL", "COM 1   NAV 1", "INTERCOM · ACTIVE"],
      ["COM 1 · AIRPORT", window.__flightInfo?.dep?.freqs?.[0]?.[1] || "—", f?.dep?.icao || "NO STATION SELECTED"],
      ["NAVIGATION", f?.wp?.id || "LOCAL", f?.wp?"BRG "+Math.round(f.wp.brg||0)+"°":"NO FLIGHT PLAN"],
      ["FLIGHT GUIDANCE", f?.ap?.ap?"AUTOPILOT":"MANUAL", f?.ap?.ap?f.ap.lat+" · "+f.ap.vert:"PILOT CONTROL"],
      ["ENGINE · RPM", Math.round(s?.rpm??f?.eng?.rpm??0).toLocaleString("en"), "POWER "+Math.round((s?.throttle??f?.eng?.lever??0)*100)+" %"],
    ];
  }

  function radioPage(g,w,h,rows) {
    g.fillStyle="#171c20";g.fillRect(0,0,w,h);
    rows.forEach(([label,value,detail],i)=>{const y=i*h/5;g.fillStyle="#313b43";g.fillRect(8,y+8,w-16,h/5-12);g.fillStyle="#070f12";g.fillRect(24,y+42,w-48,116);g.fillStyle="#c2cbd0";g.font="20px monospace";g.fillText(label,26,y+32);g.fillStyle=i===4?"#ffd18b":"#8eeac4";g.font="bold 38px monospace";g.fillText(String(value),36,y+94);g.fillStyle="#a6b9bc";g.font="17px monospace";g.fillText(detail,36,y+132);for(const x of [30,w-30]){g.fillStyle="#151b20";g.beginPath();g.arc(x,y+182,12,0,Math.PI*2);g.fill();g.strokeStyle="#87919a";g.stroke();}g.fillStyle="#9aa8b2";g.font="14px monospace";g.fillText(i===0?"VOL     MIC     MON":"SEL       MODE       ENT",72,y+188);});
  }

  // ---- the pages ------------------------------------------------------------------------------------------------
  function vehicleScreen(g, name, w, h, s) {
    g.fillStyle = "#05080c";
    g.fillRect(0, 0, w, h);
    if (!s || !s.base || s.mode === "free") return;
    if (name === "pfd") attitudePage(g, 0, 0, w, h, s);
    else if (name === "nd" || name === "mfd-nav") mapPage(g, 0, 0, w, h, s);
    else if (name === "ga") {
      attitudePage(g, 0, 0, h, h, s);
      mapPage(g, h, 0, h, h, s);
      statusPage(g, h * 2, 0, w - h * 2, h, s);
    } else statusPage(g, 0, 0, w, h, s);
    g.strokeStyle = "#1b232d";
    g.lineWidth = 2;
    g.strokeRect(1, 1, w - 2, h - 2);
  }

  function label(g, str, x, y, color, px, align = "left", weight = 700) {
    g.font = `${weight} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = "middle";
    g.fillText(str, x, y);
  }

  function attitudePage(g, x, y, w, h, s) {
    const cx = x + w / 2;
    const cy = y + h * 0.5;
    const r = Math.min(w, h) * 0.36;
    const ppd = r / 25;
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-rad(s.bank ?? 0));
    g.translate(0, (s.pitch ?? 0) * ppd);
    g.fillStyle = SKY;
    g.fillRect(-w, -w * 2, w * 2, w * 2);
    g.fillStyle = EARTH;
    g.fillRect(-w, 0, w * 2, w * 2);
    g.strokeStyle = WHITE;
    g.lineWidth = 2;
    for (let p = -30; p <= 30; p += 10) {
      const half = p ? r * 0.25 : r * 1.2;
      g.beginPath();
      g.moveTo(-half, -p * ppd);
      g.lineTo(half, -p * ppd);
      g.stroke();
      if (p) label(g, String(Math.abs(p)), half + 6, -p * ppd, WHITE, r * 0.1, "left", 600);
    }
    g.restore();
    // The aircraft symbol.
    g.strokeStyle = AMBER;
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(cx - r * 0.5, cy);
    g.lineTo(cx - r * 0.15, cy);
    g.moveTo(cx + r * 0.15, cy);
    g.lineTo(cx + r * 0.5, cy);
    g.stroke();
    g.fillStyle = AMBER;
    g.fillRect(cx - 4, cy - 4, 8, 8);
    // Speed left, altitude right, heading above, vertical speed below.
    const px = h * 0.055;
    const box = (str, bx, color) => {
      g.fillStyle = "#000";
      g.fillRect(bx - w * 0.11, cy - px * 0.8, w * 0.22, px * 1.6);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.strokeRect(bx - w * 0.11, cy - px * 0.8, w * 0.22, px * 1.6);
      label(g, str, bx, cy, color, px, "center");
    };
    const air = s.mode === "jet";
    const speed = air ? `${Math.round((s.speed ?? 0) * KT)}` : `${Math.round(Math.abs(s.speed ?? 0) * 3.6)}`;
    box(speed, x + w * 0.12, WHITE);
    box(`${Math.round(((s.alt ?? 0) * FT) / 10) * 10}`, x + w * 0.88, GREEN);
    label(g, air ? "KT" : "KM/H", x + w * 0.12, cy + px * 1.6, CYAN, px * 0.6, "center");
    label(g, "FT", x + w * 0.88, cy + px * 1.6, CYAN, px * 0.6, "center");
    label(g, `HDG ${pad3(s.heading ?? 0)}`, cx, y + h * 0.07, GREEN, px, "center");
    const vs = (s.vs ?? 0) * FT * 60;
    label(g, `VS ${vs >= 0 ? "+" : ""}${Math.round(vs / 100) * 100}`, cx, y + h * 0.93, Math.abs(vs) > 4000 ? AMBER : GREEN, px * 0.8, "center");
  }

  function mapPage(g, x, y, w, h, s) {
    const cx = x + w / 2;
    const cy = y + h * 0.72;
    const r = Math.min(w, h) * 0.62;
    const air = s.mode === "jet";
    const far = Math.max(1, ...(s.radar ?? []).map((c) => c.range));
    const range = [1000, 2000, 5000, 10000, 20000].find((k) => k >= Math.min(far, air ? 20000 : 5000)) ?? 20000;
    const k = r / range;
    const hdg = s.heading ?? 0;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    // Range rings and the compass arc.
    g.strokeStyle = GREY;
    g.lineWidth = 1.2;
    for (const f of [0.5, 1]) {
      g.beginPath();
      g.arc(cx, cy, r * f, Math.PI, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = WHITE;
    g.lineWidth = 1.6;
    for (let d = 0; d < 360; d += 10) {
      const a = rad(d - hdg - 90);
      const len = d % 30 === 0 ? 12 : 6;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
      g.stroke();
      if (d % 30 === 0) label(g, d % 90 === 0 ? "NESW"[d / 90] : String(d / 10), cx + Math.cos(a) * (r - 26), cy + Math.sin(a) * (r - 26), WHITE, h * 0.035, "center", 600);
    }
    // The others: red squares, blue circles; air ones hollow.
    for (const c of s.radar ?? []) {
      if (c.range > range * 1.05) continue;
      const a = rad(c.brg - hdg - 90);
      const px = cx + Math.cos(a) * c.range * k;
      const py = cy + Math.sin(a) * c.range * k;
      g.strokeStyle = g.fillStyle = c.red ? RED : BLUE;
      g.lineWidth = 2;
      g.beginPath();
      if (c.red) g.rect(px - 5, py - 5, 10, 10);
      else g.arc(px, py, 5.5, 0, Math.PI * 2);
      if (c.air) g.stroke();
      else g.fill();
    }
    g.restore();
    // Own position.
    g.fillStyle = AMBER;
    g.beginPath();
    g.moveTo(cx, cy - 12);
    g.lineTo(cx - 8, cy + 8);
    g.lineTo(cx + 8, cy + 8);
    g.closePath();
    g.fill();
    label(g, pad3(hdg), cx, y + h * 0.06, GREEN, h * 0.05, "center");
    label(g, `${range >= 1000 ? range / 1000 : range} KM`, x + 12, y + h - 18, CYAN, h * 0.035);
    label(g, `${(s.radar ?? []).filter((c) => c.red && c.range <= range).length} HOSTILE`, x + w - 12, y + h - 18, (s.radar ?? []).some((c) => c.red && c.range <= range) ? RED : GREY, h * 0.035, "right");
  }

  function statusPage(g, x, y, w, h, s) {
    const px = Math.min(h * 0.052, w * 0.06);
    const lx = x + w * 0.07;
    const rx = x + w * 0.93;
    let yy = y + h * 0.09;
    label(g, s.label ?? "", x + w / 2, yy, WHITE, px * 1.1, "center");
    yy += px * 2;
    const row = (name, value, color = GREEN) => {
      label(g, name, lx, yy, CYAN, px * 0.85, "left", 600);
      label(g, value, rx, yy, color, px, "right");
      yy += px * 1.55;
    };
    const bar = (name, t, color) => {
      label(g, name, lx, yy, CYAN, px * 0.85, "left", 600);
      const bx = x + w * 0.42;
      const bw = rx - bx;
      g.fillStyle = "#29313b";
      g.fillRect(bx, yy - px * 0.3, bw, px * 0.6);
      g.fillStyle = color;
      g.fillRect(bx, yy - px * 0.3, bw * clamp(t, 0, 1), px * 0.6);
      yy += px * 1.55;
    };
    const air = s.mode === "jet";
    if (air) row("SPEED", `${Math.round((s.speed ?? 0) * KT)} KT`);
    else row("SPEED", `${Math.round(Math.abs(s.speed ?? 0) * 3.6)} KM/H`);
    if (s.throttle != null) bar("THROTTLE", s.throttle, s.ab && s.throttle > 0.9 ? AMBER : GREEN);
    if (s.mode === "heli") bar("TORQUE", s.lift ?? 0, (s.lift ?? 0) > 1.05 ? AMBER : GREEN);
    if (s.hasGear) row("GEAR", s.gear ? "DOWN" : "UP", s.gear ? GREEN : WHITE);
    if (s.pullUp) label(g, "PULL UP", x + w / 2, y + h - px * 1.4, RED, px * 1.2, "center");
  }
})();
