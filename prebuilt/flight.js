// Flight planning: a departure airport and runway, an aircraft, a destination and its runway, a cruise level, fuel and
// payload, and the route between them; Start sends it all as a `flight` command (src/sandbox/flight/mod.rs), which
// takes the world to the departure runway. The airports and navaids are OurAirports' (public domain), cut down by
// tools/airports.mjs to large and medium airports with a paved runway.
//
// The route is built here, the way a dispatcher's flight plan would read, from what public data there is (no
// published procedures): a departure fix 5 NM out on the runway heading, the great circle (or the VORs along it), and
// an approach that joins the destination runway's centreline 15 NM out (intermediate fix), crosses the final approach
// fix at 5 NM, and ends at the threshold.
//
// Keys: P opens the planner. While flying, "/" is the speed brake (Shift: arm the ground spoilers) — handled here, as
// place.js takes "/" for its search otherwise — and the function keys are kept from the browser (F5 would reload).
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
  const FT = 3.28084;
  const NM = 1852;
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  // ---- geodesy --------------------------------------------------------------------------------------------------
  function distance(a, b) {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** Initial course (degrees true). */
  function bearing(a, b) {
    const dl = rad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function destination(a, brg, d) {
    const dr = d / R;
    const p1 = rad(a.lat);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(rad(brg)));
    const l2 = rad(a.lon) + Math.atan2(Math.sin(rad(brg)) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
    return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
  }
  /** The point a fraction `f` of the way along the great circle. */
  function between(a, b, f) {
    const d = distance(a, b);
    return d < 1 ? { ...a } : destination(a, bearing(a, b), d * f);
  }
  /** Metres from the great circle a→b (sign: right positive). */
  function crossTrack(a, b, p) {
    const d13 = distance(a, p) / R;
    return Math.asin(Math.sin(d13) * Math.sin(rad(bearing(a, p) - bearing(a, b)))) * R;
  }

  // ---- data -----------------------------------------------------------------------------------------------------
  let airports = null;
  let navaids = null;
  let loading = null;
  function loadData() {
    loading ||= Promise.all([
      fetch("assets/data/airports.json").then((r) => r.json()),
      fetch("assets/data/navaids.json").then((r) => r.json()).catch(() => ({ navaids: [] })),
    ]).then(([a, n]) => {
      airports = a.airports.map(([ident, iata, name, city, cc, lat, lon, elev, type, rwys, freqs]) => ({ ident, iata, name, city, cc, lat, lon, elev, large: type === 1, rwys: rwys.flatMap(directions), freqs }));
      navaids = n.navaids.filter((v) => v[2] <= 3).map(([ident, name, type, lat, lon, khz]) => ({ ident, name, type, lat, lon, mhz: khz / 1000 }));
      render();
    });
    return loading;
  }
  /** Both directions of a runway record, each from its own threshold toward the far one. */
  function directions(r) {
    const [le, he, lenFt, widthFt, hard, lighted, laLat, laLon, laElev, laHdg, laDisp, hbLat, hbLon, hbElev, hbHdg, hbDisp] = r;
    const lo = { ident: le, lat: laLat, lon: laLon, elev_ft: laElev, disp_ft: laDisp, hdg: laHdg };
    const hi = { ident: he, lat: hbLat, lon: hbLon, elev_ft: hbElev, disp_ft: hbDisp, hdg: hbHdg };
    const base = { length_m: lenFt / FT, width_ft: widthFt, hard: !!hard, lighted: !!lighted };
    return [
      { ...base, ident: le, a: lo, b: hi },
      { ...base, ident: he, a: hi, b: lo },
    ];
  }
  function search(q) {
    q = q.trim().toUpperCase();
    if (!airports || q.length < 2) return [];
    const scored = [];
    for (const ap of airports) {
      let s = 0;
      if (ap.ident === q || ap.iata === q) s = 100;
      else if (ap.ident.startsWith(q)) s = 60;
      else if ((ap.city || "").toUpperCase().startsWith(q)) s = 40;
      else if (ap.name.toUpperCase().includes(q)) s = 30;
      else if ((ap.city || "").toUpperCase().includes(q)) s = 20;
      if (s) scored.push([s + (ap.large ? 5 : 0), ap]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 8).map((x) => x[1]);
  }

  // ---- aircraft ---------------------------------------------------------------------------------------------------
  /** What the planner knows of each type (the flight model's own numbers are in src/sandbox/flight/types.rs). */
  const AIRCRAFT = [
    { id: "glider", name: "Sailplane", cls: "15 m unpowered glider", runway: 400, oew: 260, mtow: 525, fuelMax: 0, payload: 90, burn: 0, tas: 59, levels: [25, 100], ga: true, specs: "15 m span · unpowered · airborne release · manual glide" },
    { id: "airliner", name: "Airliner", cls: "A320-class twin jet", runway: 1800, oew: 42600, mtow: 78000, fuelMax: 18700, payload: 13500, burn: 2500, tas: 450, levels: [240, 400], ga: false, specs: "2 × 120 kN · fly-by-wire · autoland" },
    { id: "c172", name: "C172", cls: "Light single", runway: 500, oew: 767, mtow: 1157, fuelMax: 159, payload: 230, burn: 32, tas: 118, levels: [30, 125], ga: true, specs: "180 hp · cables · 2-axis autopilot" },
  ];

  // ---- the plan -------------------------------------------------------------------------------------------------
  const plan = { dep: null, depRwy: null, arr: null, arrRwy: null, aircraft: "airliner", level: null, routing: "direct", start: "runway", payload: null, fuel: null, weather: "sandbox", assist: true, guide: false };
  let open = false;
  let active = false;
  let lastPlan = null;
  const weatherWind = () => {
    const w = window.__hudState?.base?.fx?.weather;
    return { from: w?.windFrom ?? 250, kt: (w?.windSpeed ?? 4) * 1.943844 };
  };
  const headwind = (rwy) => {
    const w = weatherWind();
    return w.kt * Math.cos(rad(w.from - rwy.a.hdg));
  };
  const crosswind = (rwy) => {
    const w = weatherWind();
    return w.kt * Math.sin(rad(w.from - rwy.a.hdg));
  };
  const usable = (ap, type) => (ap ? ap.rwys.filter((r) => r.hard && r.length_m >= type.runway * 0.8) : []);
  /** Into the wind, the longest on a tie. */
  const bestRunway = (ap, type) => usable(ap, type).sort((a, b) => headwind(b) - headwind(a) || b.length_m - a.length_m)[0] || ap?.rwys[0] || null;
  const type = () => AIRCRAFT.find((a) => a.id === plan.aircraft);

  function tripDistance() {
    if (!plan.depRwy || !plan.arrRwy) return 0;
    return distance(plan.depRwy.a, plan.arrRwy.a);
  }
  /** Cruise level (ft): up to the type's ceiling, lower for short hops (half the trip climbing and descending). */
  function suggestedLevel() {
    const t = type();
    if (t.id === "glider") return 4500;
    const nm = tripDistance() / NM;
    const byDistance = t.ga ? Math.min(nm * 120, 8500) : Math.min(nm * 110, 37000);
    const [lo, hi] = t.levels;
    const fl = Math.max(lo * 100, Math.min(hi * 100, byDistance));
    // Semicircular rule: eastbound odd, westbound even thousands (plus 500 ft for light aircraft).
    const east = plan.depRwy && plan.arrRwy ? bearing(plan.depRwy.a, plan.arrRwy.a) < 180 : true;
    const thousands = Math.max(t.ga ? 3 : 7, Math.round(fl / 1000));
    const odd = thousands % 2 === 1;
    const level = (odd === east ? thousands : thousands + 1) * 1000;
    return t.ga ? level + 500 : level;
  }
  /** Trip fuel plus reserves (kg). */
  function suggestedFuel() {
    const t = type();
    const hours = tripDistance() / NM / t.tas + (t.ga ? 0.25 : 0.35);
    return Math.min(t.fuelMax, Math.round((hours * t.burn + t.burn * (t.ga ? 0.75 : 0.75)) / 10) * 10);
  }

  /** The waypoints, from the departure runway to the destination's threshold. */
  function buildRoute() {
    const d = plan.depRwy;
    const a = plan.arrRwy;
    const t = type();
    const wpts = [{ id: d.ident, lat: d.a.lat, lon: d.a.lon, kind: "dep" }];
    // Departure: runway heading to 5 NM.
    const courseDep = bearing(d.a, d.b);
    const d5 = destination(d.a, courseDep, 5 * NM);
    wpts.push({ id: `DEP${d.ident}`, ...d5, alt: Math.round(d.a.elev_ft + (t.ga ? 1500 : 3000)), kind: "fix" });
    // Approach: 15 NM and 5 NM out on the centreline; a fix to join from the side when coming in from behind.
    const courseArr = bearing(a.a, a.b);
    const back = (courseArr + 180) % 360;
    const iF = destination(a.a, back, (t.ga ? 8 : 15) * NM);
    const faf = destination(a.a, back, 5 * NM);
    const inbound = bearing(wpts[wpts.length - 1], iF);
    const turn = (((courseArr - inbound) % 360) + 540) % 360 - 180;
    const join = [];
    if (Math.abs(turn) > 70) {
      // A base fix: abeam the intermediate fix, 6 NM on the side the aircraft comes from.
      const side = turn > 0 ? back - 90 : back + 90;
      join.push({ id: "BASE", ...destination(iF, side, 6 * NM), alt: Math.round(a.a.elev_ft + (t.ga ? 2000 : 3000)), kind: "iaf" });
    }
    // En route: the great circle between, split every 200 NM (every 60 NM for a light aircraft) or its VORs.
    const from = wpts[wpts.length - 1];
    const to = join[0] || iF;
    const legNm = distance(from, to) / NM;
    if (plan.routing === "vor" && navaids) {
      const step = t.ga ? 40 : 90;
      let last = from;
      for (let s = step; s < legNm - step * 0.6; s += step) {
        const p = between(from, to, (s * NM) / distance(from, to));
        let best = null;
        let bestD = (t.ga ? 15 : 30) * NM;
        for (const v of navaids) {
          if (Math.abs(v.lat - p.lat) > 1 || Math.abs(v.lon - p.lon) > 2) continue;
          const dd = distance(v, p);
          if (dd < bestD && distance(last, v) > step * 0.5 * NM) {
            best = v;
            bestD = dd;
          }
        }
        if (best && !wpts.some((w) => w.id === best.ident)) {
          wpts.push({ id: best.ident, lat: best.lat, lon: best.lon, kind: "navaid" });
          last = best;
        }
      }
    } else {
      const split = t.ga ? 60 : 200;
      const n = Math.floor(legNm / split);
      for (let i = 1; i <= n; i++) {
        const f = i / (n + 1);
        wpts.push({ id: `WP${String(i).padStart(2, "0")}`, ...between(from, to, f), kind: "fix" });
      }
    }
    wpts.push(...join);
    const rw = a.ident;
    // Level at the intercept altitude, below the glide slope (src/sandbox/flight/nav.rs: `Route::path_ft`).
    wpts.push({ id: `CI${rw}`, ...iF, alt: Math.round((a.a.elev_ft + (t.ga ? 2000 : 3000)) / 100) * 100, kind: "iaf" });
    wpts.push({ id: `FF${rw}`, ...faf, alt: Math.round(a.a.elev_ft + 1600), kind: "faf" });
    wpts.push({ id: `RW${rw}`, lat: a.a.lat, lon: a.a.lon, alt: Math.round(a.a.elev_ft + 50), kind: "arr" });
    return wpts;
  }

  /** The flight deck's keys, for the planner's legend (the README has them all). */
  const KEYS = [
    ["Mouse / arrows", "Stick"],
    ["A D", "Rudder, nose wheel"],
    ["W S · F1–F4", "Thrust (F4 take-off)"],
    ["F2 held", "Reverse"],
    ["F5–F8", "Flaps"],
    ["G", "Gear"],
    ["/", "Speed brake (⇧ arm)"],
    [". or B", "Brakes (Ctrl . park)"],
    ["0–3", "Autobrake"],
    ["[ ]", "Trim"],
    ["Z", "Autopilot (⇧ A/THR)"],
    ["J", "Flight path guide"],
    ["- =", "Sim rate"],
    ["V", "View"],
    ["I · N · U", "Panel · map range · MCDU"],
    ["Esc", "Mouse free for the panel"],
  ];
  const runwayCmd = (ap, r) => ({ icao: ap.ident, name: ap.name, width_ft: r.width_ft, a: r.a, b: r.b });

  // ---- live weather (METAR, through the gateway: /api/sim/metar) ---------------------------------------------------
  const metars = new Map();
  let metarAsked = "";
  function fetchMetars() {
    const ids = [plan.dep?.ident, plan.arr?.ident].filter(Boolean);
    const key = ids.join(",");
    if (!ids.length || key === metarAsked) return;
    metarAsked = key;
    fetch(`/api/sim/metar?ids=${key}`)
      .then((r) => (r.ok ? r.json() : { metars: [] }))
      .then((j) => {
        for (const m of j.metars || []) metars.set(m.icao, m);
        for (const id of ids) if (!metars.has(id)) metars.set(id, null);
        render();
      })
      .catch(() => {
        for (const id of ids) metars.set(id, null);
        render();
      });
  }
  const COVER = { SKC: 0.02, CLR: 0.02, NSC: 0.02, NCD: 0.02, CAVOK: 0.02, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 0.97, OVX: 1, VV: 1 };
  /** A METAR as the sandbox's weather (its menu's keys: src/weather.rs). */
  function metarWeather(m) {
    const layers = m.clouds.filter((c) => c.baseFt != null);
    const cover = layers.reduce((a, c) => Math.max(a, COVER[c.cover] ?? 0.3), m.raw.includes("CAVOK") ? 0.02 : 0.05);
    const ceiling = layers.find((c) => (COVER[c.cover] ?? 0) >= 0.7) || layers[0];
    const wx = m.wx || "";
    const wet = /RA|DZ|SN|SG|PL|GR|GS|SH/.test(wx);
    return {
      windSpeed: m.windKt / 1.943844,
      ...(m.windFrom != null ? { windFrom: m.windFrom } : {}),
      visibility: m.visibilityM == null || m.visibilityM >= 9999 ? 40000 : m.visibilityM,
      clouds: cover,
      cloudBase: ceiling ? Math.max(60, ceiling.baseFt / 3.28084) : 2500,
      precipitation: wet ? (wx.includes("+") ? 0.9 : wx.includes("-") ? 0.35 : 0.6) : 0,
      snow: /SN|SG/.test(wx),
      lightning: /TS/.test(wx),
    };
  }
  /** Sets the weather to an airport's report (the departure's at the start, the destination's on the way down). */
  function applyMetar(icao) {
    const m = metars.get(icao);
    if (!m) return false;
    send({ type: "weather", weather: metarWeather(m) });
    send({ type: "fsys", sys: "gust", value: m.gustKt || 0 });
    return true;
  }
  window.__flightMetar = { get: (icao) => metars.get(icao) || null, apply: applyMetar, live: () => plan.weather === "live" };

  function start(startAt) {
    const t = type();
    if (!plan.depRwy || !plan.arrRwy) return;
    const fuel = plan.fuel ?? suggestedFuel();
    const payload = plan.payload ?? t.payload;
    const cmd = {
      type: "flight",
      aircraft: t.id,
      dep: runwayCmd(plan.dep, plan.depRwy),
      arr: runwayCmd(plan.arr, plan.arrRwy),
      route: buildRoute(),
      cruise: plan.level ?? suggestedLevel(),
      fuel,
      payload,
      start: t.id === "glider" && (startAt || plan.start) === "runway" ? "cruise" : startAt || plan.start,
      assist: t.id !== "glider" && plan.assist,
      guide: plan.guide,
    };
    lastPlan = { ...plan };
    window.dispatchEvent(new Event("sim:start-hide"));
    send(cmd);
    if (plan.weather === "live") applyMetar(startAt === "final" || plan.start === "final" ? plan.arr.ident : plan.dep.ident);
    // For the controllers (cockpit.js): the airports' frequencies.
    window.__flightInfo = { dep: plan.dep, arr: plan.arr, start: startAt || plan.start };
    close();
    active = true;
    window.__cockpitAudio?.resume();
    document.getElementById("canvas")?.requestPointerLock?.();
  }

  /** The same flight again, or back the other way. */
  /** The flight path guide (src/sandbox/flight/guide.rs) on or off, kept in the plan for the next flight. */
  window.__flightGuide = () => {
    plan.guide = !plan.guide;
    if (lastPlan) lastPlan.guide = plan.guide;
    send({ type: "fsys", sys: "guide", on: plan.guide });
  };
  window.__flightAgain = (reverse) => {
    if (!lastPlan) return;
    Object.assign(plan, lastPlan);
    if (reverse) {
      [plan.dep, plan.arr] = [lastPlan.arr, lastPlan.dep];
      const t = type();
      plan.depRwy = bestRunway(plan.dep, t);
      plan.arrRwy = bestRunway(plan.arr, t);
      plan.level = null;
      plan.fuel = null;
    }
    start("runway");
  };
  window.__flightEnd = () => {
    send({ type: "flightend" });
    active = false;
  };
  /** Opens the planner; `near` ({lat, lon}), when given, preselects the nearest large airport for the departure. */
  window.__flightOpen = (near) => {
    openPanel();
    if (near && isFinite(near.lat) && isFinite(near.lon) && !plan.dep)
      loadData().then(() => {
        const ap = airports.filter((a) => a.large).reduce((best, a) => (!best || distance(near, a) < distance(near, best) ? a : best), null);
        if (ap && !plan.dep) {
          plan.dep = ap;
          plan.depRwy = bestRunway(ap, type());
          render();
        }
      });
  };

  // ---- the panel ------------------------------------------------------------------------------------------------
  const panel = el(`<div id="sim-flight" hidden><div class="fp"><header><b>FLIGHT</b><span class="sub">Plan a flight between any two airports</span><button class="close" aria-label="Close">✕</button></header><div class="fp-body"></div></div></div>`);
  const body = panel.querySelector(".fp-body");
  panel.querySelector(".close").onclick = () => close();
  panel.addEventListener("pointerdown", (e) => {
    if (e.target === panel) close();
  });

  function openPanel() {
    if (open) return;
    // The start screen (start.js) gives way.
    window.dispatchEvent(new Event("sim:start-hide"));
    open = true;
    panel.hidden = false;
    send({ type: "menu", open: true });
    document.exitPointerLock?.();
    loadData();
    render();
    setTimeout(() => panel.querySelector("input")?.focus(), 0);
  }
  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    send({ type: "menu", open: false });
    document.getElementById("canvas")?.focus({ preventScroll: true });
  }

  const fmtNm = (m) => `${Math.round(m / NM).toLocaleString("en")} NM`;
  const fmtTime = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;
  const flagOf = (cc) => (cc && /^[a-z]{2}$/i.test(cc) ? `<img class="flag" src="assets/flags/${cc.toLowerCase()}.svg" alt="">` : "");

  function airportPicker(which) {
    const ap = plan[which];
    const box = el(`<section class="fp-ap"><h3>${which === "dep" ? "Departure" : "Destination"}</h3><div class="fp-search"><input type="search" placeholder="ICAO, IATA, city or name" value="${esc(ap ? ap.ident : "")}" aria-label="${which === "dep" ? "Departure" : "Destination"} airport"><ul class="fp-results"></ul></div><div class="fp-sel"></div><div class="fp-rwys"></div></section>`);
    const input = box.querySelector("input");
    const list = box.querySelector(".fp-results");
    const showResults = () => {
      const res = search(input.value);
      list.replaceChildren(
        ...res.map((r) => {
          const li = el(`<li><button type="button">${flagOf(r.cc)}<b>${esc(r.ident)}</b>${r.iata ? `<i>${esc(r.iata)}</i>` : ""}<span>${esc(r.name)}</span><small>${esc(r.city || "")}</small></button></li>`);
          li.querySelector("button").onclick = () => {
            plan[which] = r;
            plan[which + "Rwy"] = bestRunway(r, type());
            plan.level = null;
            plan.fuel = null;
            render();
          };
          return li;
        }),
      );
    };
    input.addEventListener("input", showResults);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") list.querySelector("button")?.click();
      e.stopPropagation();
    });
    if (ap) {
      box.querySelector(".fp-sel").innerHTML = `${flagOf(ap.cc)}<div><b>${esc(ap.name)}</b><small>${esc(ap.city || "")} · ${esc(ap.ident)}${ap.iata ? " / " + esc(ap.iata) : ""} · ${Math.round(ap.elev).toLocaleString("en")} ft</small></div>`;
      const t = type();
      const rw = box.querySelector(".fp-rwys");
      for (const r of ap.rwys) {
        const hw = headwind(r);
        const xw = crosswind(r);
        const short = r.length_m < t.runway;
        const b = el(`<button type="button" class="rwy${plan[which + "Rwy"] === r ? " on" : ""}${short || !r.hard ? " short" : ""}"><b>${esc(r.ident)}</b><span>${Math.round(r.length_m).toLocaleString("en")} × ${Math.round(r.width_ft / FT)} m</span><small class="${hw < -3 ? "tail" : ""}">${hw >= 0 ? "▲" : "▼"} ${Math.abs(hw).toFixed(0)} kt · ${xw >= 0 ? "▶" : "◀"} ${Math.abs(xw).toFixed(0)}</small></button>`);
        b.title = `True heading ${r.a.hdg.toFixed(0)}°${r.lighted ? " · lighted" : ""}${short ? " · short for this aircraft" : ""}`;
        b.onclick = () => {
          plan[which + "Rwy"] = r;
          plan.level = null;
          render();
        };
        rw.append(b);
      }
    }
    return box;
  }

  function mapSvg() {
    if (!plan.depRwy || !plan.arrRwy) return `<div class="fp-map empty">Pick two airports to see the route</div>`;
    const wpts = buildRoute();
    const lats = wpts.map((w) => w.lat);
    const lons = wpts.map((w) => w.lon);
    let [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const padLat = Math.max(0.3, (n - s) * 0.15);
    const padLon = Math.max(0.3, (e - w) * 0.15);
    s -= padLat;
    n += padLat;
    w -= padLon;
    e += padLon;
    const k = Math.cos(rad((s + n) / 2));
    const W = 460;
    const H = 260;
    const scale = Math.min(W / ((e - w) * k), H / (n - s));
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const xy = (p) => [W / 2 + (p.lon - cx) * k * scale, H / 2 - (p.lat - cy) * scale];
    // The great circle, drawn through many points so it curves.
    const pts = [];
    for (let i = 0; i + 1 < wpts.length; i++) for (let j = 0; j <= 16; j++) pts.push(xy(between(wpts[i], wpts[i + 1], j / 16)));
    const others = (airports || []).filter((a) => a.lat > s && a.lat < n && a.lon > w && a.lon < e).slice(0, 400);
    return `<svg class="fp-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Route map">
      <rect width="${W}" height="${H}" rx="10" class="bg"/>
      ${others.map((a) => { const [x, y] = xy(a); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${a.large ? 1.8 : 1.1}" class="ap"/>`; }).join("")}
      <polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" class="route"/>
      ${wpts.map((p) => { const [x, y] = xy(p); const end = p.kind === "dep" || p.kind === "arr"; return `<g class="${end ? "end" : "wp"}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${end ? 4 : 2.2}"/>${end || p.kind === "navaid" ? `<text x="${(x + 6).toFixed(1)}" y="${(y - 5).toFixed(1)}">${esc(end ? (p.kind === "dep" ? plan.dep.ident : plan.arr.ident) : p.id)}</text>` : ""}</g>`; }).join("")}
    </svg>`;
  }

  function render() {
    if (!open) return;
    const t = type();
    if (!airports) {
      body.innerHTML = `<p class="fp-loading">Loading 4,000 airports…</p>`;
      return;
    }
    const grid = el(`<div class="fp-grid"></div>`);
    grid.append(airportPicker("dep"), airportPicker("arr"));
    const right = el(`<section class="fp-side"></section>`);
    right.innerHTML = `<h3>Aircraft</h3><div class="fp-types">${AIRCRAFT.map((a) => `<button type="button" data-id="${a.id}" class="${a.id === plan.aircraft ? "on" : ""}"><img src="assets/thumbs/${a.id}.png" alt=""><b>${esc(a.name)}</b><small>${esc(a.cls)}</small></button>`).join("")}</div><p class="hint">${esc(t.specs)}</p>`;
    right.querySelectorAll(".fp-types button").forEach((b) => {
      b.onclick = () => {
        plan.aircraft = b.dataset.id;
        if (plan.aircraft === "glider") { plan.start = "cruise"; plan.assist = false; }
        const nt = type();
        if (plan.dep && (!plan.depRwy || plan.depRwy.length_m < nt.runway)) plan.depRwy = bestRunway(plan.dep, nt);
        if (plan.arr && (!plan.arrRwy || plan.arrRwy.length_m < nt.runway)) plan.arrRwy = bestRunway(plan.arr, nt);
        plan.level = null;
        plan.fuel = null;
        plan.payload = null;
        render();
      };
    });
    const dist = tripDistance();
    const level = plan.level ?? suggestedLevel();
    const fuel = plan.fuel ?? suggestedFuel();
    const payload = plan.payload ?? t.payload;
    const gw = t.oew + fuel + payload;
    const currentWx = window.__hudState?.base?.fx?.weather || window.__weatherState?.() || {};
    const wxReport = plan.weather === "live" ? metars.get(plan.dep?.ident) : null;
    const wxWind = wxReport ? `${wxReport.windFrom ?? "VRB"}° / ${wxReport.windKt} kt` : `${Math.round(currentWx.windFrom || 0)}° / ${Math.round((currentWx.windSpeed || 0) * 1.944)} kt`;
    const wxCloud = wxReport ? (wxReport.clouds.find(c => c.baseFt != null)?.baseFt != null ? `${wxReport.clouds.find(c => c.baseFt != null).baseFt} ft` : "No ceiling") : `${Math.round(currentWx.cloudBase || 0)} m`;
    const wxVis = wxReport ? wxReport.visibilityM : currentWx.visibility;

    const levels = [];
    for (let ft = t.ga ? 2500 : 5000; ft <= t.levels[1] * 100; ft += t.ga ? 500 : 1000) levels.push(ft);
    const summary = el(`<section class="fp-plan"></section>`);
    summary.innerHTML = `
      <div class="fp-row"><label>Cruise</label><select class="lvl">${levels.map((ft) => `<option value="${ft}"${ft === level ? " selected" : ""}>${ft >= 18000 ? "FL" + String(ft / 100).padStart(3, "0") : ft.toLocaleString("en") + " ft"}</option>`).join("")}</select></div>
      <div class="fp-row"><label>Route</label><div class="seg">${[["direct", "Direct"], ["vor", "Via VORs"]].map(([k, l]) => `<button type="button" data-r="${k}" class="${plan.routing === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="fp-row"><label>${t.id === "glider" ? "Unpowered" : "Fuel"}</label><input ${t.id === "glider" ? "disabled" : ""} type="range" class="fuel" min="${Math.round(t.fuelMax * 0.05)}" max="${t.fuelMax}" step="${t.ga ? 1 : 100}" value="${fuel}"><output>${fuel.toLocaleString("en")} kg</output></div>
      ${t.payload || plan.aircraft === "airliner" ? `<div class="fp-row"><label>Payload</label><input type="range" class="pay" min="0" max="${Math.round(t.mtow - t.oew - 0)}" step="${t.ga ? 5 : 100}" value="${payload}"><output>${payload.toLocaleString("en")} kg</output></div>` : ""}
      <div class="fp-stats"><div><dt>Distance</dt><dd>${dist ? fmtNm(dist) : "—"}</dd></div><div><dt>Time</dt><dd>${dist ? fmtTime(dist / NM / t.tas + 0.3) : "—"}</dd></div><div class="${gw > t.mtow ? "over" : ""}"><dt>Weight</dt><dd>${(gw / 1000).toFixed(gw < 5000 ? 2 : 1)} t${gw > t.mtow ? " > MTOW" : ""}</dd></div></div>
      ${mapSvg()}
      <div class="fp-weather-cards"><div><small>Wind · ${wxReport ? "METAR" : "Simulated"}</small><strong>${esc(wxWind)}</strong></div><div><small>Cloud base</small><strong>${esc(wxCloud)}</strong></div><div><small>Visibility</small><strong>${wxVis == null ? "—" : (wxVis / 1000).toFixed(1) + " km"}</strong></div></div>
      ${t.id === "glider" ? `<p class="fp-note">Unpowered flight. Release at altitude or on final; no ground launch. Select a nearby destination within gliding range. Glide-computer arrival heights are estimates.</p>` : ""}
      <div class="fp-row"><label>Weather</label><div class="seg">${[["sandbox", "As it is"], ["live", "Live (METAR)"]].map(([k, l]) => `<button type="button" data-w="${k}" class="${plan.weather === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      ${plan.weather === "live" ? `<div class="fp-metar">${[plan.dep, plan.arr].filter(Boolean).map((ap) => { const m = metars.get(ap.ident); return `<code>${m ? esc(m.raw) : m === null ? `${esc(ap.ident)}: no report` : `${esc(ap.ident)}: …`}</code>`; }).join("")}</div>` : ""}
      <div class="fp-row"><label>Copilot</label><div class="seg">${[[true, "Flaps, gear, descent"], [false, "Off: all yours"]].map(([k, l]) => `<button type="button" data-c="${k}" class="${plan.assist === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="fp-row"><label>Guide</label><div class="seg">${[[true, "Gates to fly through"], [false, "Off"]].map(([k, l]) => `<button type="button" data-g="${k}" class="${plan.guide === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="fp-row"><label>Start</label><div class="seg">${(t.id === "glider" ? [["final", "Final approach"], ["cruise", "Airborne release"]] : [["runway", "On the runway"], ["final", "10 NM final"], ["cruise", "In cruise"]]).map(([k, l]) => `<button type="button" data-s="${k}" class="${plan.start === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="actions">${active ? `<button type="button" class="end">End flight</button>` : ""}<button type="button" class="primary go"${plan.depRwy && plan.arrRwy && gw <= t.mtow * 1.001 ? "" : " disabled"}>Fly ${plan.dep ? esc(plan.dep.ident) + " " + esc(plan.depRwy?.ident || "") : ""}${plan.arr ? " → " + esc(plan.arr.ident) : ""}</button></div>`;
    summary.querySelector(".lvl").onchange = (e) => {
      plan.level = +e.target.value;
      render();
    };
    summary.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => ((plan.routing = b.dataset.r), render())));
    summary.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => ((plan.start = b.dataset.s), render())));
    summary.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => ((plan.weather = b.dataset.w), render())));
    summary.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => ((plan.assist = b.dataset.c === "true"), render())));
    summary.querySelectorAll("[data-g]").forEach((b) => (b.onclick = () => ((plan.guide = b.dataset.g === "true"), render())));
    if (plan.weather === "live") fetchMetars();
    summary.querySelector(".fuel").oninput = (e) => {
      plan.fuel = +e.target.value;
      e.target.nextElementSibling.textContent = `${plan.fuel.toLocaleString("en")} kg`;
    };
    summary.querySelector(".fuel").onchange = () => render();
    const pay = summary.querySelector(".pay");
    if (pay) {
      pay.oninput = (e) => {
        plan.payload = +e.target.value;
        e.target.nextElementSibling.textContent = `${plan.payload.toLocaleString("en")} kg`;
      };
      pay.onchange = () => render();
    }
    summary.querySelector(".go").onclick = () => start();
    const end = summary.querySelector(".end");
    if (end) end.onclick = () => (window.__flightEnd(), close());
    // Put the route preview with the airports, keeping configuration together.
    grid.append(summary.querySelector('.fp-map'));
    grid.append(summary.querySelector('.fp-weather-cards'));
    const actions = summary.querySelector('.actions');
    actions.classList.add('fp-launch');
    right.append(summary);
    const wrap = el(`<div class="fp-layout"></div>`);
    wrap.append(grid, right);
    const keys = el(`<div class="fp-keys">${KEYS.map(([k, what]) => `<span><kbd>${esc(k)}</kbd> ${esc(what)}</span>`).join("")}</div>`);
    const controls = el('<details class="fp-controls"><summary>Flight controls</summary></details>');
    controls.append(keys);grid.append(controls);
    body.replaceChildren(wrap);
    panel.querySelectorAll(".fp > .fp-launch").forEach(n => n.remove());
    panel.querySelector(".fp").append(actions);
  }

  // ---- the bar's button, keys -------------------------------------------------------------------------------------
  function mount() {
    document.body.append(panel);
    const bar = document.getElementById("sim-bar");
    if (bar && !document.getElementById("sim-fly")) {
      const b = el(`<button id="sim-fly"><span>Fly</span><kbd>P</kbd></button>`);
      b.onclick = () => (open ? close() : openPanel());
      const first = bar.querySelector("button[data-tab]");
      first ? first.before(b) : bar.append(b);
    }
  }
  // ui.js builds the bar on DOMContentLoaded; wait for it.
  addEventListener("DOMContentLoaded", () => setTimeout(mount, 0));
  const flying = () => !!window.__hudState?.base?.flight;
  window.addEventListener(
    "keydown",
    (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
      if (open) {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
        return;
      }
      if (typing) return;
      if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openPanel();
        return;
      }
      if (!flying()) return;
      if (e.code === "KeyJ" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        window.__flightGuide();
        return;
      }
      // The flight deck's function keys (flaps, throttle), not the browser's.
      if (/^F[1-8]$/.test(e.key)) e.preventDefault();
      if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        e.stopImmediatePropagation();
        send({ type: "fsys", sys: e.shiftKey || e.key === "?" ? "arm" : "speedbrakeToggle" });
      }
    },
    true,
  );
})();
