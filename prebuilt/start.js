// The start screen: where (a city), how (free flight or a vehicle), a briefing with what to expect, then launch.
// - The live world is the backdrop: picking a city flies the camera there (`flyto` with `orbit`, handled by
//   src/sandbox/globe.rs) and circles it behind the menu.
// - Each city has hand-picked starts: an approach for aircraft, a road for land vehicles, open water for ships
//   (roads and water checked against OpenStreetMap). Launch flies the camera to the start, spawns the vehicle there
//   (`spawn` with `lat`, `lon`, `heading`) and hands over the controls.
// - It loads before ui.js so its key handler runs first: while it is open, the game and the other menus get no keys.
//   The FLIGHT SIMULATOR mark in the bar opens it again. An invite link (`?join=`) skips it.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.has("bench")) return;

  // ---- cities ------------------------------------------------------------------------------------------------
  // `view`: the height (m) the camera circles at. `air`: aircraft start `back` m before the city centre, flying
  // `heading`. `land`/`sea`: a spot and a heading. `elev`: the ground's rough height (m above sea level), used only
  // if the tiles there never answer.
  const CITIES = [
    {
      id: "berlin", name: "Berlin", country: "Germany", cc: "de", tz: "Europe/Berlin", lat: 52.5163, lon: 13.3777, view: 900, elev: 35,
      tagline: "Brandenburg Gate, the Reichstag and the Tiergarten",
      air: { heading: 84, back: 3500, name: "Over the Tiergarten", detail: "inbound to the Brandenburg Gate" },
      land: { lat: 52.51547, lon: 13.36418, heading: 84, name: "Straße des 17. Juni", detail: "facing the Brandenburg Gate" },
      noSea: "The Spree is too narrow for ships.",
    },
    {
      id: "paris", name: "Paris", country: "France", cc: "fr", tz: "Europe/Paris", lat: 48.8584, lon: 2.2945, view: 1000, elev: 35,
      tagline: "The Eiffel Tower, the Seine and the Champs-Élysées",
      air: { heading: 120, back: 4000, name: "Along the Seine", detail: "inbound to the Eiffel Tower" },
      land: { lat: 48.8687, lon: 2.31098, heading: 296, name: "Champs-Élysées", detail: "facing the Arc de Triomphe" },
      noSea: "The Seine is too narrow for ships.",
    },
    {
      id: "london", name: "London", country: "United Kingdom", cc: "gb", tz: "Europe/London", lat: 51.5007, lon: -0.1246, view: 1100, elev: 10,
      tagline: "Westminster, the Thames and Buckingham Palace",
      air: { heading: 270, back: 5000, name: "Over the City", detail: "westbound along the Thames" },
      land: { lat: 51.50384, lon: -0.13573, heading: 236, name: "The Mall", detail: "facing Buckingham Palace" },
      noSea: "The Thames here is too narrow for ships.",
    },
    {
      id: "newyork", name: "New York", country: "United States", cc: "us", tz: "America/New_York", lat: 40.7484, lon: -73.9857, view: 1400, elev: 10,
      tagline: "Midtown's towers, Central Park and the harbour",
      air: { heading: 200, back: 4500, name: "Over Central Park", detail: "southbound down Manhattan" },
      land: { lat: 40.75804, lon: -73.98548, heading: 208, name: "7th Avenue", detail: "southbound through Times Square" },
      sea: { lat: 40.68, lon: -74.032, heading: 15, name: "Upper New York Bay", detail: "by the Statue of Liberty, heading for the Hudson" },
    },
    {
      id: "sanfrancisco", name: "San Francisco", country: "United States", cc: "us", tz: "America/Los_Angeles", lat: 37.8199, lon: -122.4783, view: 1500, elev: 5,
      tagline: "The Golden Gate, the bay and Alcatraz",
      air: { heading: 280, back: 6000, name: "Over the bay", detail: "westbound through the Golden Gate" },
      land: { lat: 37.81401, lon: -122.47782, heading: 357, name: "Golden Gate Bridge", detail: "northbound toward Marin" },
      sea: { lat: 37.815, lon: -122.445, heading: 280, name: "San Francisco Bay", detail: "off the Marina, heading for the Golden Gate" },
    },
    {
      id: "tokyo", name: "Tokyo", country: "Japan", cc: "jp", tz: "Asia/Tokyo", lat: 35.6586, lon: 139.7454, view: 1600, elev: 20,
      tagline: "Tokyo Tower, Shibuya and Tokyo Bay",
      air: { heading: 300, back: 5000, name: "Over Tokyo Bay", detail: "inbound to Tokyo Tower" },
      land: { lat: 35.65944, lon: 139.69924, heading: 70, name: "Dōgenzaka, Shibuya", detail: "toward the Scramble Crossing" },
      sea: { lat: 35.625, lon: 139.765, heading: 350, name: "Tokyo Bay", detail: "off Shinagawa, heading for the Rainbow Bridge" },
    },
    {
      id: "sydney", name: "Sydney", country: "Australia", cc: "au", tz: "Australia/Sydney", lat: -33.8568, lon: 151.2153, view: 1200, elev: 5,
      tagline: "The Opera House, the Harbour Bridge and Port Jackson",
      air: { heading: 250, back: 5000, name: "Over Port Jackson", detail: "inbound to the Harbour Bridge" },
      land: { lat: -33.85592, lon: 151.20846, heading: 208, name: "Harbour Bridge", detail: "southbound into the city" },
      sea: { lat: -33.8515, lon: 151.225, heading: 265, name: "Sydney Harbour", detail: "off Kirribilli, heading for the Harbour Bridge" },
    },
    {
      id: "singapore", name: "Singapore", country: "Singapore", cc: "sg", tz: "Asia/Singapore", lat: 1.2834, lon: 103.8607, view: 1500, elev: 5,
      tagline: "Marina Bay Sands, Gardens by the Bay and the Strait",
      air: { heading: 340, back: 5000, name: "Over the Singapore Strait", detail: "inbound to Marina Bay Sands" },
      land: { lat: 1.27964, lon: 103.85755, heading: 33, name: "Bayfront Avenue", detail: "past Gardens by the Bay toward Marina Bay Sands" },
      sea: { lat: 1.258, lon: 103.866, heading: 265, name: "Singapore Strait", detail: "off Marina South, heading west for Sentosa" },
    },
    {
      id: "rio", name: "Rio de Janeiro", country: "Brazil", cc: "br", tz: "America/Sao_Paulo", lat: -22.9519, lon: -43.2105, view: 1400, elev: 20,
      tagline: "Christ the Redeemer, Sugarloaf and Copacabana",
      air: { heading: 88, back: 3000, name: "Over the Tijuca Forest", detail: "past Christ the Redeemer toward Sugarloaf" },
      land: { lat: -22.97067, lon: -43.18303, heading: 50, name: "Avenida Atlântica", detail: "along Copacabana beach" },
      sea: { lat: -22.92, lon: -43.145, heading: 170, name: "Guanabara Bay", detail: "heading out past Sugarloaf" },
    },
    {
      id: "hongkong", name: "Hong Kong", country: "China", cc: "hk", tz: "Asia/Hong_Kong", lat: 22.2855, lon: 114.16, view: 1500, elev: 5,
      tagline: "Victoria Harbour, the skyline and the Peak",
      air: { heading: 80, back: 5000, name: "Over Victoria Harbour", detail: "eastbound between the towers" },
      land: { lat: 22.2809, lon: 114.16399, heading: 125, name: "Harcourt Road", detail: "Admiralty, eastbound" },
      sea: { lat: 22.289, lon: 114.165, heading: 80, name: "Victoria Harbour", detail: "between Central and Tsim Sha Tsui" },
    },
    {
      id: "hamburg", name: "Hamburg", country: "Germany", cc: "de", tz: "Europe/Berlin", lat: 53.5413, lon: 9.9841, view: 1000, elev: 5,
      tagline: "The Elbphilharmonie, the port and the Elbe",
      air: { heading: 80, back: 5000, name: "Over the Elbe", detail: "inbound to the Elbphilharmonie" },
      land: { lat: 53.51856, lon: 9.9269, heading: 35, name: "Köhlbrand Bridge", detail: "high above the port, northbound" },
      sea: { lat: 53.543, lon: 9.96, heading: 80, name: "The Elbe", detail: "in the port, heading for the Elbphilharmonie" },
    },
    {
      id: "matterhorn", name: "Matterhorn", country: "Switzerland", cc: "ch", tz: "Europe/Zurich", lat: 45.9763, lon: 7.6586, view: 4000, elev: 1600,
      tagline: "4,478 m of rock and ice above Zermatt",
      air: { heading: 225, back: 9000, name: "Above Zermatt", detail: "inbound to the Matterhorn: climb!" },
      noLand: "No roads up here: fly it.",
      noSea: "No water up here.",
    },
  ];

  /** How each kind of vehicle starts, what to expect, and its keys (ids match src/catalog.rs and ui.js). */
  const KINDS = {
    transport: {
      start: { glider: "1,200 m above terrain · 108 km/h", c172: "300 m above terrain · 107 kt", airliner: "600 m above terrain · 233 kt" },
      expect: ["Start in the air and explore the scenery.", "Manage your speed, altitude and throttle; avoid stalls.", "V switches between chase view and the cockpit. P opens airport flight planning."],
      keys: [["Mouse / arrows", "Pitch and roll"], ["W / S", "Throttle"], ["A / D", "Rudder"], ["G", "Landing gear"], ["B", "Brakes"], ["V", "View"], ["F", "Free camera"], ["P", "Flight planner"]],
    },
    free: {
      expect: ["Explore the world with a free camera.", "Climb to travel faster, or slow down for a closer look.", "Tab opens the aircraft menu; P plans a flight between airports."],
      keys: [["Mouse", "Look"], ["W A S D", "Move"], ["Space / C", "Up / down"], ["Shift", "Faster"], ["Wheel", "Speed"], ["Tab", "Aircraft"], ["P", "Flight planner"], ["/", "Search places"]],
    },
  };
  const KIND_OF = { glider: "transport", c172: "transport", airliner: "transport" };
  const DOMAIN = { air: "air" };
  const CATS = [["air", "Aircraft"]];
  const WEATHER = ["Clear", "Scattered", "Overcast", "Rain", "Thunderstorm", "Snow", "Fog"];
  const TIMES = [["Dawn", 5.5], ["Morning", 8.5], ["Noon", 12], ["Afternoon", 15.5], ["Dusk", 20.1], ["Night", 23.5]];

  // ---- state ---------------------------------------------------------------------------------------------------
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem("flight-simulator.start")) ?? null;
    } catch {
      return null;
    }
  };
  const save = (v) => {
    try {
      localStorage.setItem("flight-simulator.start", JSON.stringify(v));
    } catch {
      /* private window */
    }
  };
  const last = load();
  const pick = {
    city: CITIES.find((c) => c.id === last?.city) ?? CITIES[0],
    // Start with the light training aircraft; ignore saved aircraft that are no longer available.
    mode: ["free", "vehicle", "airports"].includes(last?.mode) ? last.mode : "airports",
    asset: ["c172", "airliner", "glider"].includes(last?.asset) ? last.asset : "c172",
    cat: null,
    time: null,
    weather: null,
  };
  let step = "welcome";
  let cityView = "grid";
  let open = false;
  let boot = true; // the first time, at page load (Esc can't close it then)
  let flownTo = null; // the city the backdrop last flew to
  let deploying = false;

  window.__cmds = window.__cmds || [];
  const send = (cmd) => window.__cmds.push(JSON.stringify(cmd));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const assets = () => window.__simCatalog?.assets ?? [];
  const asset = () => assets().find((a) => a.id === pick.asset);
  const domainOf = (a) => DOMAIN[a?.cat] ?? "air";
  /** Why a vehicle can't start in this city, or "". */
  const unavailable = (a, c = pick.city) => {
    const d = domainOf(a);
    if (d === "land" && !c.land) return c.noLand ?? `No road start in ${c.name}.`;
    if (d === "sea" && !c.sea) return c.noSea ?? `No open water in ${c.name}.`;
    return "";
  };

  // ---- geometry and time ---------------------------------------------------------------------------------------
  /** The point `distance` m from a place along a bearing (degrees). */
  function destination(lat, lon, bearing, distance) {
    const r = Math.PI / 180;
    const d = distance / 6371000;
    const p1 = lat * r;
    const b = bearing * r;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = lon * r + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / r, lon: ((l2 / r + 540) % 360) - 180 };
  }
  /** Where the chosen vehicle starts in the chosen city: a place, a heading, a name, and the camera's height there. */
  function startSpot(c = pick.city, a = asset()) {
    const d = domainOf(a);
    if (d === "land" && c.land) return { ...c.land, height: 320 };
    if (d === "sea" && c.sea) return { ...c.sea, height: 650 };
    const air = c.air ?? { heading: 0, back: 3000, name: `Over ${c.name}`, detail: "" };
    return { ...destination(c.lat, c.lon, air.heading + 180, air.back), heading: air.heading, name: air.name, detail: air.detail, height: 900 };
  }
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtHour = (h) => `${pad2(Math.floor(h))}:${pad2(Math.floor((h % 1) * 60))}`;
  /** Local clock time at a city (its time zone), or the solar time for a searched place. */
  function localTime(c) {
    if (c.tz) {
      try {
        return new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
      } catch {
        /* unknown zone */
      }
    }
    return fmtHour(solarNow(c.lon));
  }
  /** The sun's local time now at a longitude (the sim's clock is solar time). */
  function solarNow(lon) {
    const d = new Date();
    return (((d.getUTCHours() + d.getUTCMinutes() / 60 + lon / 15) % 24) + 24) % 24;
  }
  const dayOfYear = () => {
    const d = new Date();
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  };
  const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  // ---- icons -----------------------------------------------------------------------------------------------------
  const svg = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    air: svg(`<path d="M12 3c.8 0 1.3 1 1.3 2.3V10l7.2 4.2v2l-7.2-2.2v4.3l2.2 1.7v1.5L12 20.6l-3.5.9V20l2.2-1.7V14l-7.2 2.2v-2L10.7 10V5.3C10.7 4 11.2 3 12 3z"/>`),
    land: svg(`<rect x="3" y="12" width="15" height="5" rx="2"/><path d="M6 12l1.5-3h6L15 12M12 10.5h9"/><circle cx="6.5" cy="17" r="1.5"/><circle cx="14.5" cy="17" r="1.5"/>`),
    sea: svg(`<path d="M4 15l1.5-4h13L20 15"/><path d="M8 11V8h6v3M11 8V5"/><path d="M2 19c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0 3-1 4.5 0"/>`),
    free: svg(`<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>`, 30),
    vehicle: svg(`<path d="M12 3c.8 0 1.3 1 1.3 2.3V10l7.2 4.2v2l-7.2-2.2v4.3l2.2 1.7v1.5L12 20.6l-3.5.9V20l2.2-1.7V14l-7.2 2.2v-2L10.7 10V5.3C10.7 4 11.2 3 12 3z"/>`, 30),
    search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>`, 16),
    back: svg(`<path d="M15 5l-7 7 7 7"/>`, 16),
    next: svg(`<path d="M9 5l7 7-7 7"/>`, 16),
    play: `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>`,
  };

  // ---- styles ------------------------------------------------------------------------------------------------------
  const CSS = `
    html.starting #sim-bar, html.starting #sim-place, html.starting #sim-search, html.starting #sim-cmd, html.starting #hudcanvas, html.starting #sim-menu,
    html.deploying #sim-bar, html.deploying #sim-place, html.deploying #sim-cmd, html.deploying #hudcanvas { visibility: hidden !important; }
    html.starting #footer, html.deploying #footer { z-index: 70 !important; }
    #sim-bar .brand { cursor: pointer; border-radius: 6px; }
    #sim-bar .brand:hover { color: var(--text); }
    #sim-start { --text: #202c40; --muted: #526179; --line: #cbd5e3; --accent: #2459d6; --accent-2: #2459d6; color-scheme: light; position: fixed; inset: 0; z-index: 60; color: var(--text); font: 13px/1.45 Inter, system-ui, sans-serif; opacity: 1; transition: opacity .45s ease; }
    #sim-start[hidden] { display: none; }
    #sim-start.leaving { opacity: 0; pointer-events: none; }
    #sim-start .st-shade { position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(90deg, #14263c66, #14263c08 80%); }
    #sim-start .st-panel { position: absolute; top: 20px; left: 20px; width: min(460px, calc(100vw - 40px)); max-height: calc(100dvh - 60px); background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; box-shadow: 0 18px 64px #0c1c3540; display: flex; flex-direction: column; padding: 24px; box-sizing: border-box; }
    .st-head { flex-shrink: 0; display: flex; flex-direction: column; gap: 18px; }
    .st-brand { font: 750 11px/1 Inter, system-ui, sans-serif; letter-spacing: .18em; color: var(--accent); }
    .st-brand b { color: var(--accent); }
    .st-steps { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .st-steps li { display: flex; align-items: center; gap: 7px; padding: 5px 10px 5px 5px; border-radius: 999px; color: var(--muted); font-weight: 600; font-size: 12px; border: 1px solid transparent; transition: color .2s, border-color .2s, background .2s; }
    .st-steps li i { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #edf2f9; font: 700 11px ui-monospace, Menlo, monospace; font-style: normal; }
    .st-steps li.on { color: var(--text); border-color: var(--line); background: #f4f7fb; }
    .st-steps li.on i { background: var(--accent); color: #fff; }
    .st-steps li.done i { background: #e6edff; color: var(--accent); }
    .st-steps li[hidden] { display: none; }
    .st-body { position: relative; contain: paint; flex: 0 1 auto; min-height: 0; overflow: auto; margin: 26px -10px 0; padding: 0 10px 4px; scrollbar-width: thin; }
    .st-body h1 { margin: 0 0 8px; font: 750 28px/1.2 Inter, system-ui, sans-serif; letter-spacing: -.01em; }
    .st-body .lede { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
    .st-anim { animation: st-in .35s ease both; }
    @keyframes st-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .st-foot { flex-shrink: 0; margin-top: 22px; display: flex; align-items: center; gap: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
    .st-foot .grow { flex: 1; color: var(--muted); font-size: 12px; }
    .st-btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 16px; border-radius: 10px; border: 1px solid var(--line); background: #f4f7fb; color: var(--text); font: 700 13px Inter, system-ui, sans-serif; cursor: pointer; }
    .st-btn:hover:not(:disabled) { background: #e8effa; }
    .st-btn:disabled { cursor: wait; }
    .st-btn.primary:disabled { background: #e5ebf5; border-color: #cbd5e3; color: #526179; }
    .st-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; padding: 12px 20px; }
    .st-btn.primary:hover:not(:disabled) { background: #1946af; border-color: #1946af; }
    .st-btn.launch { padding: 12px 22px; font-size: 14px; }
    .st-btn kbd { background: rgba(0,0,0,.12); border-color: rgba(0,0,0,.15); color: inherit; }
    #sim-start button:focus-visible, #sim-start input:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
    .st-quick { display: flex; align-items: center; gap: 12px; width: 100%; margin: 0 0 16px; padding: 10px 12px; border-radius: 12px; border: 1px solid #b8cbed; background: #f0f5ff; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .st-quick:hover { background: #e6edff; }
    .st-quick img { width: 64px; height: 40px; object-fit: contain; }
    .st-quick span { flex: 1; display: flex; flex-direction: column; }
    .st-quick small { color: var(--muted); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; }
    .st-quick b { font-size: 14px; }
    .st-quick em { font-style: normal; color: var(--accent); font-weight: 700; display: flex; align-items: center; gap: 6px; }
    .st-search { position: relative; margin-bottom: 14px; }
    .st-search form { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 11px; border: 1px solid var(--line); background: #f5f7fb; color: var(--muted); }
    .st-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font: 14px Inter, system-ui, sans-serif; }
    .st-search input::-webkit-search-cancel-button { opacity: .7; }
    .st-search .st-results { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
    .st-search .st-results:empty { display: none; }
    .st-search .st-results button { display: grid; grid-template-columns: 1fr auto; gap: 1px 10px; padding: 8px 10px; border: 0; border-radius: 9px; background: #f4f7fb; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
    .st-search .st-results button:hover, .st-search .st-results button:focus-visible { background: #e8effa; }
    .st-search .st-results small { grid-column: 1 / -1; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .st-search .st-msg { margin-top: 6px; color: var(--muted); font-size: 12px; }
    .st-search .st-msg:empty { display: none; }
    .st-cities { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .st-city { position: relative; display: flex; flex-direction: column; gap: 3px; padding: 12px 12px 10px; min-height: 104px; border-radius: 13px; border: 1px solid var(--line); background: #f6f8fc; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: transform .12s, border-color .12s, background .12s; }
    .st-city:hover { transform: translateY(-2px); border-color: #889bb8; }
    .st-city.on { border-color: var(--accent); background: #edf3ff; box-shadow: inset 0 0 0 1px var(--accent); }
    .st-city .top { display: flex; align-items: center; gap: 8px; }
    .st-city .flag, .st-title .flag { width: 22px; height: 16px; border-radius: 3px; object-fit: cover; box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 1px 3px rgba(0,0,0,.35); flex: none; }
    .st-city b { font-size: 15px; }
    .st-city .time { margin-left: auto; color: var(--muted); font: 600 11px ui-monospace, Menlo, monospace; }
    .st-city p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .st-city .caps { display: flex; gap: 4px; margin-top: auto; padding-top: 6px; }
    .st-cap { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px 2px 4px; border-radius: 6px; background: #e9eef6; color: var(--muted); font-size: 10.5px; font-weight: 600; }
    .st-cap svg { width: 13px; height: 13px; }
    .st-cap.off { opacity: .3; text-decoration: line-through; }
    .st-modes { display: grid; gap: 10px; }
    .st-mode { display: grid; grid-template-columns: 42px 1fr 20px; align-items: start; gap: 14px; padding: 18px 16px; border-radius: 13px; border: 1px solid var(--line); background: #f8fafc; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background .15s; }
    .st-mode:hover { border-color: #889bb8; background: #f0f4fa; }
    .st-mode.on { border-color: var(--accent); background: #edf3ff; box-shadow: inset 0 0 0 1px var(--accent); }
    .st-mode .ico { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid #d4deef; border-radius: 11px; background: #fff; color: var(--accent); }
    .st-mode .mode-name { display: block; font-size: 16px; font-weight: 750; line-height: 1.4; }
    .st-mode .mode-sub { display: block; margin: 3px 0 7px; color: var(--accent); font-size: 12px; font-weight: 650; }
    .st-mode .mode-description { display: block; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .st-mode .mode-check { display: grid; place-items: center; width: 18px; height: 18px; margin-top: 2px; border: 1.5px solid #8393aa; border-radius: 50%; background: #fff; }
    .st-mode.on .mode-check { border-color: var(--accent); background: var(--accent); }
    .st-mode.on .mode-check::after { content: "✓"; color: white; font-size: 12px; font-weight: 800; }
    .st-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .st-list li { position: relative; padding-left: 16px; color: var(--muted); font-size: 12.5px; }
    .st-list li::before { content: ""; position: absolute; left: 2px; top: 7px; width: 6px; height: 6px; border-radius: 2px; background: var(--accent); opacity: .8; }
    .st-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
    .st-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12px Inter, system-ui, sans-serif; cursor: pointer; }
    .st-chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .st-chip.off { opacity: .45; }
    .st-vehicles { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 8px; }
    .st-veh { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 8px 10px 10px; border-radius: 12px; border: 1px solid var(--line); background: #f6f8fc; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: transform .12s, border-color .12s; }
    .st-veh:hover:not(:disabled) { transform: translateY(-2px); border-color: #889bb8; }
    .st-veh.on { border-color: var(--accent); background: #edf3ff; box-shadow: inset 0 0 0 1px var(--accent); }
    .st-veh:disabled { cursor: not-allowed; opacity: .4; }
    .st-veh img { width: 100%; aspect-ratio: 16 / 10; object-fit: contain; border-radius: 8px; background: radial-gradient(ellipse at 50% 35%, #647c99, #253951); }
    .st-veh b { margin-top: 4px; font-size: 13px; }
    .st-veh small { color: var(--muted); font-size: 11px; }
    .st-veh .why { position: absolute; left: 8px; right: 8px; top: 40%; padding: 4px 6px; border-radius: 6px; background: rgba(0,0,0,.7); color: #ffcf9e; font-size: 10.5px; text-align: center; }
    .st-note { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
    .st-hero { display: grid; grid-template-columns: 180px 1fr; gap: 16px; align-items: center; padding: 14px; border-radius: 16px; border: 1px solid var(--line); background: #f6f8fc; }
    .st-hero .pic { display: grid; place-items: center; aspect-ratio: 16 / 10; border-radius: 12px; background: radial-gradient(ellipse at 50% 35%, #647c99, #253951); color: var(--accent); }
    .st-hero .pic img { width: 100%; height: 100%; object-fit: contain; }
    .st-hero h2 { margin: 0; font-size: 21px; }
    .st-hero h2 small { display: block; margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--muted); }
    .st-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 10px 0 0; font-size: 12.5px; }
    .st-facts dt { color: var(--muted); }
    .st-facts dd { margin: 0; color: var(--text); font-weight: 600; }
    .st-sec { margin: 18px 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
    .st-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; }
    .st-keys div { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid #e5eaf1; font-size: 12.5px; color: var(--muted); }
    .st-keys kbd { flex: none; }
    .st-seg { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    .st-seg button { padding: 8px 6px; border-radius: 9px; border: 1px solid var(--line); background: #f4f7fb; color: var(--text); font: 600 12px Inter, system-ui, sans-serif; cursor: pointer; }
    .st-seg button:hover { background: #e8effa; }
    .st-seg button.on { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
    .st-title { position: absolute; right: 24px; bottom: 54px; padding: 18px 22px; border-radius: 16px; background: #142337e8; color: #fff; max-width: min(46vw, 620px); text-align: right; pointer-events: none; text-shadow: 0 2px 18px rgba(0,0,0,.55); }
    .st-title .kicker { display: inline-flex; align-items: center; gap: 8px; font: 700 11px/1 Inter, system-ui, sans-serif; letter-spacing: .22em; text-transform: uppercase; color: #d2e1ff; }
    .st-title .kicker i { width: 7px; height: 7px; border-radius: 50%; background: #ff5d5d; box-shadow: 0 0 0 0 rgba(255,93,93,.6); animation: st-live 1.6s infinite; }
    @keyframes st-live { 0% { box-shadow: 0 0 0 0 rgba(255,93,93,.6); } 80%,100% { box-shadow: 0 0 0 8px rgba(255,93,93,0); } }
    .st-title h3 { margin: 6px 0 2px; font: 800 clamp(34px, 5.6vw, 76px)/1 Inter, system-ui, sans-serif; letter-spacing: -.02em; }
    .st-title .sub { display: inline-flex; align-items: center; gap: 8px; color: #dfe6ee; font-size: 15px; font-weight: 600; }
    .st-title .coords { margin-top: 6px; color: #dce6f3; font: 600 12px ui-monospace, Menlo, monospace; }
    .st-title.swap { animation: st-title .6s ease both; }
    @keyframes st-title { from { opacity: 0; transform: translateY(10px); filter: blur(4px); } to { opacity: 1; transform: none; filter: none; } }
    .st-loading { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px; background: #142337; color: #e9eff8; font-size: 12px; }
    .st-loading[hidden] { display: none; }
    .st-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); border-top-color: var(--accent); animation: st-spin .8s linear infinite; }
    @keyframes st-spin { to { transform: rotate(360deg); } }
    #sim-start kbd { padding: 2px 5px; background: #eaf0f8; border: 1px solid #cbd5e3; border-radius: 4px; color: #46566e; }
    #sim-start .primary kbd { background: #ffffff18; border-color: #ffffff66; color: #fff; }
    #sim-start input::placeholder { color: #5b6980; opacity: 1; }
    #sim-start .st-seg button.on:hover { background: #1946af; }
    @media (prefers-reduced-motion: reduce) { #sim-start *, #sim-start *::before { animation: none !important; transition: none !important; } }
    /* Flight preparation: compact aircraft summary, meaningful conditions, optional guidance. */
    .st-eyebrow { color: var(--accent); font-size: 10px; font-weight: 750; letter-spacing: .14em; margin-bottom: 8px; }
    .st-brief h1 { font-size: 29px; letter-spacing: -.035em; }
    .st-brief .lede { font-size: 13px; margin-bottom: 20px; }
    .st-aircraft-summary { display: grid; grid-template-columns: 132px 1fr; gap: 0 16px; border: 1px solid var(--line); border-radius: 14px; background: #f7f9fc; overflow: hidden; }
    .st-aircraft-image { background: radial-gradient(ellipse at 50% 35%, #647c99, #253951); min-height: 126px; display: grid; place-items: center; color: #fff; }
    .st-aircraft-image img { width: 100%; height: 116px; object-fit: contain; }
    .st-aircraft-copy { padding: 14px 12px 12px 0; }
    .st-overline { font-size: 10px; font-weight: 750; letter-spacing: .08em; color: var(--muted); }
    .st-aircraft-copy h2 { font-size: 23px; line-height: 1.2; margin: 4px 0; letter-spacing: -.025em; }
    .st-aircraft-copy p { color: var(--muted); font-size: 12px; margin: 0; }
    .st-text-btn { border: 0; background: transparent; color: var(--accent); padding: 0; margin-top: 10px; font: 650 12px Inter,system-ui,sans-serif; cursor: pointer; }
    .st-text-btn:hover { text-decoration: underline; }
    .st-aircraft-specs { grid-column: 1 / -1; display: flex; gap: 22px; padding: 10px 14px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .st-aircraft-specs b { margin-left: 6px; color: var(--text); font-weight: 650; }
    .st-departure { display: flex; align-items: flex-start; gap: 12px; padding: 18px 0; border-bottom: 1px solid #e1e7ef; }
    .st-departure-icon { flex: none; display: grid; place-items: center; width: 35px; height: 35px; border-radius: 50%; background: #edf3ff; color: var(--accent); }
    .st-departure-icon svg { width: 19px; height: 19px; }
    .st-departure strong { display: block; font-size: 14px; margin: 4px 0 2px; }
    .st-departure p { margin: 0; color: var(--muted); font-size: 12px; }
    .st-departure .st-start-state { margin-top: 5px; font-size: 11px; }
    .st-section-head { display: flex; align-items: center; justify-content: space-between; margin: 18px 0 12px; }
    .st-section-head h2 { font-size: 15px; margin: 0; }
    .st-section-head>span { color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 2px 6px; font-size: 10px; }
    .st-condition-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .st-condition-fields label>span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .st-condition-fields select { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 8px; border: 1px solid #b7c5d8; border-radius: 9px; background: #fff; color: var(--text); font: 600 12px Inter,system-ui,sans-serif; cursor: pointer; }
    #sim-start select:focus-visible, #sim-start summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .st-condition-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 8px; margin-top: 12px; }
    .st-condition-metrics>div { background: #edf3f9; border-radius: 10px; padding: 10px; }
    .st-condition-metrics span { display: block; font-size: 11px; font-weight: 600; color: var(--muted); }
    .st-condition-metrics strong { display: block; font-size: 21px; font-weight: 750; margin: 4px 0; white-space: nowrap; letter-spacing: -.02em; }
    .st-condition-metrics small { font-size: 11px; font-weight: 550; color: var(--muted); }
    .st-condition-metrics em { font-size: 10px; color: var(--muted); font-style: normal; }
    .st-condition-note { color: var(--muted); font-size: 11px; line-height: 1.5; margin: 10px 0 16px; }
    .st-condition-note.caution { color: #85430b; background: #fff3e2; padding: 9px 11px; border-radius: 8px; }
    .st-controls { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .st-controls summary { display: flex; align-items: center; justify-content: space-between; padding: 13px 0; cursor: pointer; font-size: 12px; font-weight: 650; list-style: none; }
    .st-controls summary::-webkit-details-marker { display: none; }
    .st-controls summary>span:first-child { display: flex; align-items: center; gap: 8px; }
    .st-controls summary svg { width: 16px; height: 16px; color: var(--muted); }
    .st-controls[open] .st-disclosure { transform: rotate(180deg); }
    .st-controls .st-list { margin: 14px 0; }
    .st-quick-keys { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 12px; color: var(--muted); font-size: 10px; }
    .st-quick-keys kbd { font-size: 9px; padding: 1px 3px !important; }
    #sim-start[data-step="brief"] .st-foot { margin-top: 18px; }
    .st-readiness { display: inline-flex; align-items: center; gap: 6px; font-size: 11px !important; }
    .st-readiness i { width: 6px; height: 6px; border-radius: 50%; background: #738199; }
    .st-readiness i.ready { background: #24854e; box-shadow: 0 0 0 3px #e0f3e6; }
    .st-title h3 { font-size: clamp(32px,4vw,54px); }
    .st-title .sub { font-size: 13px; }
    @media(max-width:500px) { .st-aircraft-summary { grid-template-columns: 112px 1fr; gap: 0 12px; } .st-condition-metrics>div { padding: 9px 7px; } .st-condition-metrics strong { font-size: 19px; } .st-aircraft-specs { gap: 15px; } }
    /* Deploying: letterbox bars and a title card while the camera flies to the start. */
    #sim-deploy { position: fixed; inset: 0; z-index: 55; pointer-events: none; color: var(--text); font: 13px/1.4 Inter, system-ui, sans-serif; }
    #sim-deploy[hidden] { display: none; }
    #sim-deploy::before, #sim-deploy::after { content: ""; position: absolute; left: 0; right: 0; height: 9vh; background: #05070b; transition: transform .6s cubic-bezier(.2,.8,.2,1); }
    #sim-deploy::before { top: 0; transform: translateY(-100%); }
    #sim-deploy::after { bottom: 0; transform: translateY(100%); }
    #sim-deploy.on::before, #sim-deploy.on::after { transform: none; }
    #sim-deploy .card { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); min-width: 320px; padding: 18px 28px 20px; border-radius: 16px; background: rgba(8,12,18,.62); border: 1px solid var(--line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); text-align: center; text-shadow: 0 2px 16px rgba(0,0,0,.6); opacity: 0; transition: opacity .4s; }
    #sim-deploy.on .card { opacity: 1; }
    #sim-deploy .k { font: 700 11px/1 Inter, system-ui, sans-serif; letter-spacing: .3em; color: var(--accent); }
    #sim-deploy h3 { margin: 8px 0 2px; font: 800 36px/1.1 Inter, system-ui, sans-serif; }
    #sim-deploy p { margin: 0; color: #dfe6ee; font-size: 14px; }
    #sim-deploy .bar { width: 240px; height: 3px; margin: 14px auto 0; border-radius: 2px; background: rgba(255,255,255,.15); overflow: hidden; }
    #sim-deploy .bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s linear; }
    /* The first keys after launch: tucked into the bottom-left corner, clear of the view and the HUD. */
    #sim-toast { position: fixed; left: 10px; bottom: 30px; z-index: 30; width: max-content; max-width: min(300px, calc(100vw - 20px)); display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 12px; background: rgba(8,12,18,.42); border: 1px solid var(--line); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); color: var(--text); font: 12px/1.4 Inter, system-ui, sans-serif; transition: opacity .5s, transform .5s; }
    #sim-toast[hidden] { display: none; }
    #sim-toast.out { opacity: 0; transform: translateX(-10px); }
    #sim-toast b { font-size: 13px; }
    #sim-toast .keys { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 4px 10px; color: #c8d2de; }
    #sim-toast .keys kbd { justify-self: start; }
    #sim-toast .go { color: var(--muted); font-size: 11px; }
    @media (max-width: 860px) {
      #sim-start .st-panel { top: 10px; left: 10px; width: min(460px, calc(100vw - 20px)); max-height: calc(100dvh - 64px); padding: 20px; }
      #sim-start .st-shade { background: #14263c44; }
      .st-title { display: none; }
      .st-modes, .st-keys { grid-template-columns: 1fr; }
      .st-hero { grid-template-columns: 110px 1fr; }
      .st-steps { gap: 2px; flex-wrap: wrap; }
      .st-steps li { gap: 4px; padding: 4px; font-size: 11px; }
      .st-body h1 { font-size: 25px; }
      .st-mode { grid-template-columns: 34px 1fr 18px; gap: 10px; padding: 14px 12px; }
      .st-mode .ico { width: 34px; height: 34px; }
      .st-foot .grow { font-size: 11px; }
    }
    @media (max-width: 500px) {
      .st-foot .grow { display: none; }
      .st-foot { justify-content: space-between; }
      .st-foot .primary { margin-left: auto; }
      .st-btn { white-space: nowrap; }
      .st-hero { grid-template-columns: 1fr; }
      .st-hero .pic { max-height: 130px; width: 100%; }
      .st-loading { bottom: 10px; }
    }
  `;

  // ---- DOM -------------------------------------------------------------------------------------------------------
  const root = el(`
    <div id="sim-start" role="dialog" aria-modal="true" aria-label="Start" hidden>
      <div class="st-shade"></div>
      <section class="st-panel">
        <header class="st-head">
          <button class="st-brand" aria-label="Welcome to Flight Simulator"><img class="st-brand-symbol" src="assets/ui/brand.svg" width="48" height="48" alt=""/><span class="st-wordmark">FLIGHT <b>SIMULATOR</b></span></button><button class="st-home-nav">Welcome</button>
          <ol class="st-steps">
            <li data-step="city"><i>1</i><span>Location</span></li>
            <li data-step="mode"><i>2</i><span>Mode</span></li>
            <li data-step="vehicle"><i>3</i><span>Aircraft</span></li>
            <li data-step="brief"><i>4</i><span>Briefing</span></li>
          </ol>
        </header>
        <div class="st-body"></div>
      </section>
      <section class="st-overview" aria-label="Flight setup summary"><aside class="st-title"></aside><footer class="st-foot"></footer></section>
      <div class="st-loading" hidden><span class="st-spin"></span><span>Loading the world…</span></div>
    </div>`);
  const deploy = el(`<div id="sim-deploy" hidden><div class="card" role="status" aria-live="polite"><div class="k"><img class="deploy-brand" src="assets/ui/brand.svg" alt=""/> STARTING FLIGHT</div><h3></h3><p></p><div class="bar"><i></i></div></div></div>`);
  const toast = el(`<div id="sim-toast" hidden></div>`);
  const body = root.querySelector(".st-body");
  const foot = root.querySelector(".st-foot");
  const title = root.querySelector(".st-title");
  const loading = root.querySelector(".st-loading");

  function mount() {
    document.head.append(el(`<style>${CSS}</style>`));
    document.body.append(root, deploy, toast);
    root.querySelector(".st-brand").onclick = () => go("welcome");
    root.querySelector(".st-home-nav").onclick = () => go("welcome");
    root.querySelectorAll(".st-steps li").forEach(li => {
      li.setAttribute("role", "button"); li.tabIndex = 0;
      const activate = () => { if(li.dataset.step === "vehicle" || li.dataset.step === "brief") pick.mode="vehicle"; go(li.dataset.step); };
      li.onclick = activate;
      li.onkeydown = e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); activate(); } };
    });
    addEventListener("sim:start-open", () => show(false));
    // The bar's FLIGHT SIMULATOR mark (ui.js) opens the start screen again.
    document.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("#sim-bar .brand")) show(false);
    });
    root.addEventListener("dblclick", (e) => {
      if (e.target instanceof Element && e.target.closest(".st-city, .st-mode, .st-veh:not(:disabled)")) next();
    });
    if (!params.get("join")) show(true);
    setInterval(tick, 500);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  function show(atBoot) {
    if (deploying) return;
    boot = atBoot;
    open = true;
    step = "welcome";
    flownTo = null;
    root.hidden = false;
    root.classList.remove("leaving");
    document.documentElement.classList.add("starting");
    document.exitPointerLock?.();
    send({ type: "menu", open: true });
    render();
    // At page load the backdrop flies to the last city; opened later, it waits for a pick.
    if (atBoot) flyBackdrop(pick.city);
    renderTitle(true);
  }
  function hide() {
    open = false;
    root.classList.add("leaving");
    document.documentElement.classList.remove("starting");
    send({ type: "menu", open: false });
    setTimeout(() => {
      if (!open) root.hidden = true;
    }, 450);
  }

  function flyBackdrop(c) {
    if (flownTo === c) return;
    flownTo = c;
    send({ type: "flyto", lat: c.lat, lon: c.lon, height: c.view ?? 1500, name: c.name, orbit: true });
  }

  // ---- steps -----------------------------------------------------------------------------------------------------
  const STEPS = ["city", "mode", "vehicle", "brief"];
  const flow = () => STEPS.filter((s) => (s !== "vehicle" || pick.mode === "vehicle") && (s !== "brief" || pick.mode !== "airports"));

  function go(to) {
    step = to;
    render();
  }
  function next() {
    if (step === "welcome") return go("city");
    const f = flow();
    if (step === "mode" && pick.mode === "airports") return flyAirports();
    if (step === "brief") return launch();
    if (step === "vehicle" && unavailable(asset())) return;
    go(f[f.indexOf(step) + 1]);
  }
  /** The flight planner (flight.js) takes over, departing from the airport nearest the chosen city. */
  function flyAirports() {
    const c = pick.city;
    send({ type: "flycancel" });
    flownTo = null;
    hide();
    window.__flightOpen?.({ lat: c.lat, lon: c.lon, name: c.name });
  }

  function back() {
    if (step === "city") return go("welcome");
    const f = flow();
    const i = f.indexOf(step);
    if (i > 0) go(f[i - 1]);
    else if (!boot) {
      send({ type: "flycancel" });
      flownTo = null;
      hide();
      document.getElementById("canvas")?.focus({ preventScroll: true });
    }
  }

  function render() {
    const f = flow();
    root.dataset.step=step;
    root.querySelector(".st-home-nav").classList.toggle("on",step === "welcome");
    root.querySelector(".st-home-nav").setAttribute("aria-current",step === "welcome" ? "page" : "false");
    renderTitle(true);
    root.querySelectorAll(".st-steps li").forEach((li) => {
      const s = li.dataset.step;
      li.hidden = false;
      li.classList.toggle("on", s === step);
      if(s === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
      li.classList.toggle("done", f.indexOf(s) < f.indexOf(step));
      li.querySelector("i").textContent = String(STEPS.indexOf(s) + 1);
    });
    const view = { welcome: welcomeStep, city: cityStep, mode: modeStep, vehicle: vehicleStep, brief: briefStep }[step]();
    view.classList.add("st-anim");
    body.replaceChildren(view);
    body.scrollTop = 0;
    renderFoot();
    // The keyboard (and the pad) start on the current choice.
    requestAnimationFrame(() => (step === "brief" ? foot.querySelector(".primary:not(:disabled)") : body.querySelector(".on:not(:disabled)") ?? body.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true }));
  }

  function renderFoot() {
    const first = step === "welcome";
    const ready = !!window.__hudState;
    const label = { welcome: "Plan a flight", city: "Continue", mode: pick.mode === "airports" ? "Open the planner" : "Continue", vehicle: "Continue", brief: ready ? (pick.mode === "free" ? "Start exploring" : "Start flight") : "Loading scenery…" }[step];
    const hint = step === "welcome" ? `<span class="grow">Your next departure starts here</span>` : step === "brief" ? `<span class="grow st-readiness"><i class="${ready ? "ready" : ""}"></i>${ready ? "Ready to fly" : "Preparing the world"}</span>` : step === "city" ? `<span class="grow">Enter continues${boot ? "" : " · Esc returns to the game"}</span>` : `<span class="grow">Enter continues · Esc goes back</span>`;
    foot.innerHTML = `
      ${first && boot ? "" : `<button class="st-btn st-back">${ICON.back}${first ? "Back to the game" : "Back"}</button>`}
      ${hint}
      <button class="st-btn primary ${step === "brief" ? "launch" : ""}" ${step === "brief" && !ready ? "disabled" : ""}>${label}${step === "brief" ? ICON.play : ICON.next}</button>`;
    foot.querySelector(".st-back")?.addEventListener("click", back);
    foot.querySelector(".primary").onclick = next;
  }

  const flagImg = (cc) => (cc ? `<img class="flag" src="assets/flags/${cc}.svg" alt="" onerror="this.remove()" />` : "");
  const cap = (d, on, label) => `<span class="st-cap${on ? "" : " off"}">${ICON[d]}${label}</span>`;

  function welcomeStep() {
    const v = el(`<div class="st-welcome"><div class="st-welcome-heading"><div><div class="st-eyebrow">THE SKY IS YOURS</div><h1>Where will you go next?</h1><p class="lede">Discover the world. Find your aircraft. Take the controls.</p></div><span class="st-welcome-tag"><i></i> A WORLD OF POSSIBILITIES</span></div><div class="st-dashboard">
      <button class="st-tile st-tile-world" data-action="world"><img src="assets/ui/aviation/world.jpg" alt="Earth from orbit with textured continents and cloud systems"/><span class="st-tile-tag">CHOOSE YOUR DEPARTURE</span><span class="st-tile-caption"><span class="st-tile-arrow">↗</span><span><strong>World map</strong><small>Choose a destination · create your next flight</small></span></span></button>
      <button class="st-tile st-tile-local" data-action="local"><img src="assets/ui/aviation/c172.jpg" alt="Light aircraft flying over a sunlit alpine lake"/><span class="st-tile-tag">JUMP INTO THE PILOT'S SEAT</span><span class="st-tile-caption"><span class="st-tile-arrow">↗</span><span><strong>Free flight</strong><small>${esc(pick.city.name)} · start airborne in the C172</small></span></span></button>
      <button class="st-tile" data-action="hangar"><img src="assets/ui/aviation/airliner.jpg" alt="Passenger airliner in flight above a sunlit coast"/><span class="st-tile-caption"><span class="st-tile-arrow">↗</span><span><strong>Your hangar</strong><small>Explore the three aircraft</small></span></span></button>
      <button class="st-tile" data-action="glider"><img src="assets/ui/aviation/glider.jpg" alt="Sailplane soaring above a green river valley"/><span class="st-tile-caption"><span class="st-tile-arrow">↗</span><span><strong>Unpowered flight</strong><small>Take the sailplane above ${esc(pick.city.name)}</small></span></span></button>
      <button class="st-tile st-tile-conditions" data-action="conditions"><img src="assets/ui/aviation/weather.jpg" alt="Sun shafts and distant rain beneath towering cumulus clouds"/><span class="st-weather-atmosphere" aria-hidden="true"></span><span class="st-tile-caption"><span class="st-tile-arrow">↗</span><span><strong>Flight conditions</strong><small>Set the weather and time of day</small></span></span></button>
    </div></div>`);
    v.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{
      const action=b.dataset.action;
      if(action==='world'){cityView='map';return go('city');}
      pick.mode='vehicle';
      if(action==='hangar')return go('vehicle');
      if(action==='local')pick.asset='c172';
      if(action==='glider')pick.asset='glider';
      go('brief');
      if(action==='conditions')body.querySelector('.st-weather')?.focus();
    });
    return v;
  }

  function cityStep() {
    const v = el(`<div>
      <div class="st-eyebrow">FLIGHT PLANNING / 01</div><h1>A world of possibilities.</h1>
      <p class="lede">Choose a destination and explore it from the air.</p>
    </div>`);
    // Last time's choice, one click away.
    const lastCity = CITIES.find((c) => c.id === last?.city);
    const lastAsset = assets().find((a) => a.id === last?.asset);
    if (boot && lastCity && (last.mode === "free" || (lastAsset && !unavailable(lastAsset, lastCity)))) {
      const what = last.mode === "free" ? "Free flight" : lastAsset.name;
      const q = el(`<button class="st-quick">${last.mode === "free" ? `<span style="flex:none;color:var(--accent)">${ICON.free}</span>` : `<img src="assets/thumbs/${lastAsset.id}.png" alt="" />`}<span><small>Continue where you left off</small><b>${esc(lastCity.name)} · ${esc(what)}</b></span><em>Briefing ${ICON.next}</em></button>`);
      q.onclick = () => {
        selectCity(lastCity);
        pick.mode = last.mode;
        if (last.mode === "vehicle") pick.asset = last.asset;
        go("brief");
      };
      v.append(q);
    }
    const tools=el(`<div class="st-location-tools"><div class="st-location-search"></div><div class="st-view-switch" aria-label="Destination view"><button data-view="map" aria-pressed="${cityView==='map'}">Map view</button><button data-view="grid" aria-pressed="${cityView==='grid'}">Destinations</button></div></div>`);
    tools.querySelector('.st-location-search').append(searchBox());
    tools.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{cityView=b.dataset.view;render();});
    v.append(tools);
    if(cityView==='map'){
      const map=el(`<div class="st-world-map" aria-label="Choose a departure on the world map"><div class="st-map-canvas"><img src="assets/ui/world-map.svg" alt="World map"/><div class="st-map-heading"><span>WORLD MAP</span><small>Select a departure marker</small></div></div><div class="st-map-detail"><span>SELECTED DEPARTURE</span><strong>${esc(pick.city.name)}</strong><small>${esc(pick.city.tagline || pick.city.country)}</small></div></div>`);
      for(const c of (pick.city.custom?[pick.city,...CITIES]:CITIES)){
        const marker=el(`<button class="st-map-marker${pick.city===c?' on':''}" style="left:${(c.lon+180)/360*100}%;top:${(90-c.lat)/180*100}%" aria-label="Depart from ${esc(c.name)}" aria-pressed="${pick.city===c}"><i></i><span>${esc(c.name)}</span></button>`);
        marker.onclick=()=>{selectCity(c);map.querySelectorAll('.st-map-marker').forEach(b=>{b.classList.toggle('on',b===marker);b.setAttribute('aria-pressed',String(b===marker));});map.querySelector('.st-map-detail strong').textContent=c.name;map.querySelector('.st-map-detail small').textContent=c.tagline||c.country;};map.querySelector(".st-map-canvas").append(marker);
      }
      v.append(map);
      const note=el(`<p class="st-map-note">Select a marker, search anywhere on Earth, or browse the destination list.</p>`);v.append(note);
      return v;
    }
    const grid = el(`<div class="st-cities"></div>`);
    const list = pick.city.custom ? [pick.city, ...CITIES] : CITIES;
    for (const c of list) {
      const card = el(`
        <button aria-pressed="${pick.city === c}" class="st-city${pick.city === c ? " on" : ""}">
          <span class="st-city-region">${esc(c.country)}<span class="st-selection-mark" aria-hidden="true">✓ Selected</span></span><span class="top">${flagImg(c.cc)}<b>${esc(c.name)}</b><span class="time" data-tz="${c.id}">${localTime(c)}</span></span>
          <p>${esc(c.tagline ?? c.country)}</p><span class="st-city-position">${fmtCoord(c.lat,c.lon)}</span>
          
        </button>`);
      card.onclick = () => {
        selectCity(c);
        grid.querySelectorAll(".st-city").forEach((b) => { b.classList.toggle("on", b === card); b.setAttribute("aria-pressed", String(b === card)); });
      };
      grid.append(card);
    }
    v.append(grid);
    return v;
  }

  function selectCity(c) {
    pick.city = c;
    flyBackdrop(c);
    renderTitle(true);
  }

  /** Any place on Earth (the search box of place.js): air and free flight only. */
  function searchBox() {
    const box = el(`
      <div class="st-search">
        <form>${ICON.search}<input type="search" placeholder="Search a city, landmark or place…" aria-label="Search for a place" autocomplete="off" spellcheck="false" /><kbd>Enter</kbd></form>
        <div class="st-msg"></div>
        <div class="st-results"></div>
      </div>`);
    const input = box.querySelector("input");
    const msg = box.querySelector(".st-msg");
    const results = box.querySelector(".st-results");
    let ctl = null;
    box.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || !window.__placeSearch) return;
      ctl?.abort();
      ctl = new AbortController();
      msg.textContent = "Searching…";
      results.replaceChildren();
      try {
        const found = await window.__placeSearch(q, ctl.signal);
        msg.textContent = found.length ? "" : `Nothing found for “${q}”.`;
        for (const r of found.slice(0, 5)) {
          const b = el(`<button type="button"><b>${esc(r.label)}</b><span class="st-cap">${esc(r.type || "place")}</span><small>${esc(r.detail)}</small></button>`);
          b.onclick = () => {
            const custom = {
              id: `custom:${r.lat.toFixed(4)},${r.lon.toFixed(4)}`, custom: true, name: r.label, country: r.detail.split(", ").pop() ?? "", lat: r.lat, lon: r.lon,
              view: Math.min(Math.max(r.height ?? 1500, 700), 20000), elev: 0, tagline: r.detail,
              air: { heading: 0, back: 3000, name: `Near ${r.label}`, detail: "northbound over it" },
              noLand: "Road starts are hand-picked: pick one of the cities, or spawn it in free flight (Tab).",
              noSea: "Water starts are hand-picked: pick one of the cities, or spawn it in free flight (Tab).",
            };
            selectCity(custom);
            render();
          };
          results.append(b);
        }
        results.querySelector("button")?.focus();
      } catch (err) {
        if (err.name !== "AbortError") msg.textContent = `Search unavailable: ${err.message}`;
      }
    };
    return box;
  }

  function modeStep() {
    const c = pick.city;
    const n = assets().filter((a) => !unavailable(a)).length;
    const v = el(`<div>
      <div class="st-eyebrow">FLIGHT PLANNING / 02</div><h1>Make the flight yours.</h1>
      <p class="lede">Start in ${esc(c.name)}. Choose an experience to get ready for your flight.</p>
      <div class="st-modes"></div>
    </div>`);
    const modes = [
      ["free", ICON.free, "Explore the world", "Free camera", "Move freely over the scenery. Take a closer look or climb for a wider view."],
      ["vehicle", ICON.vehicle, "Fly an aircraft", "Start airborne", `Choose from ${n} civilian aircraft and explore ${c.name}. Start in the air, ready to fly.`],
    ];
    if (window.__flightOpen) modes.push(["airports", ICON.vehicle, "Fly between airports", "Plan a flight, then fly it", "Set your departure, destination and weather. Start on a runway, in cruise or on final approach."]);
    const box = v.querySelector(".st-modes");
    for (const [id, icon, name, sub, description] of modes) {
      const b = el(`<button class="st-mode${pick.mode === id ? " on" : ""}" aria-pressed="${pick.mode === id}"><img class="st-mode-art" src="assets/ui/aviation/${id === "free" ? "world" : id === "airports" ? "airliner" : "c172"}.jpg" alt=""/><span class="ico" aria-hidden="true">${icon}</span><span class="mode-copy"><span class="mode-name">${name}</span><span class="mode-sub">${sub}</span><span class="mode-description">${esc(description)}</span></span><span class="mode-check st-card-selection" aria-hidden="true"><span>✓</span>Selected</span></button>`);
      b.onclick = () => {
        pick.mode = id;
        box.querySelectorAll(".st-mode").forEach((x) => x.classList.toggle("on", x === b));
        render();
      };
      box.append(b);
    }
    return v;
  }

  function vehicleStep() {
    const c = pick.city;
    const all = assets();
    pick.cat ??= asset()?.cat ?? "air";
    // Last time's vehicle may not fit this city (a ship in Berlin): the first one that does.
    if (!asset() || unavailable(asset())) pick.asset = (all.find((a) => a.cat === pick.cat && !unavailable(a)) ?? all.find((a) => !unavailable(a)))?.id ?? pick.asset;
    const v = el(`<div>
      <div class="st-eyebrow">YOUR HANGAR / 03</div><h1>Find your kind of flying.</h1>
      <p class="lede">Three aircraft. Three ways to experience ${esc(c.name)}.</p>
      <div class="st-chips"></div>
      <div class="st-vehicles"></div>
      <p class="st-note"></p>
    </div>`);
    const chips = v.querySelector(".st-chips");
    for (const [id, label] of CATS) {
      const off = all.filter((a) => a.cat === id).every((a) => unavailable(a));
      const b = el(`<button class="st-chip${pick.cat === id ? " on" : ""}${off ? " off" : ""}">${ICON[DOMAIN[id]]}${label}</button>`);
      b.onclick = () => {
        pick.cat = id;
        // The selection follows the category: else the note still describes a vehicle from another one.
        if (asset()?.cat !== id) pick.asset = all.find((a) => a.cat === id && !unavailable(a))?.id ?? pick.asset;
        render();
      };
      chips.append(b);
    }
    const grid = v.querySelector(".st-vehicles");
    const list = all.filter((a) => a.cat === pick.cat);
    for (const a of list) {
      const why = unavailable(a);
      const b = el(`<button aria-pressed="${pick.asset === a.id && !why}" class="st-veh${pick.asset === a.id && !why ? " on" : ""}" ${why ? "disabled" : ""} title="${esc(why || a.role)}"><img src="assets/ui/aviation/${a.id}.jpg" alt="" loading="lazy" /><b>${esc(a.name)}</b><small>${esc(a.cls)}</small><span class="st-card-selection" aria-hidden="true"><span>✓</span>Selected</span><span class="st-veh-role">${esc(a.role)}</span><span class="st-veh-specs">${a.specs.slice(0,2).map(([k,v])=>`<span>${esc(k)}<strong>${esc(v)}</strong></span>`).join("")}</span>${why ? `<span class="why">${esc(why)}</span>` : ""}</button>`);
      b.onclick = () => {
        pick.asset = a.id;
        grid.querySelectorAll(".st-veh").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed",String(x === b)); });
        note();
        renderTitle(true);
      };
      grid.append(b);
    }
    const note = () => {
      const a = asset();
      const why = a && a.cat === pick.cat ? unavailable(a) : "";
      const spot = a && !why ? startSpot(c, a) : null;
      v.querySelector(".st-note").textContent = why || (spot ? `${a.name}: ${a.role}. Starts at ${spot.name}${spot.detail ? `, ${spot.detail}` : ""}.` : "Pick one.");
    };
    note();
    return v;
  }

  function briefStep() {
    const c = pick.city;
    const free = pick.mode === "free";
    const a = asset();
    const kind = free ? KINDS.free : KINDS[KIND_OF[a?.id]] ?? KINDS.jet;
    const spot = free ? null : startSpot(c, a);
    const startState = free ? "Free camera" : (KINDS[KIND_OF[a.id]]?.start?.[a.id] ?? "Ready");
    const v = el(`<div class="st-brief">
      <div class="st-eyebrow">PRE-FLIGHT BRIEFING</div>
      <h1>Fly over ${esc(c.name)}.</h1>
      <p class="lede">${free ? "A new perspective. Explore at your own pace." : "Your aircraft, your conditions. Ready when you are."}</p>
      <section class="st-aircraft-summary" aria-label="Selected aircraft">
        <div class="st-aircraft-image">${free ? ICON.free : `<img src="assets/thumbs/${a.id}.png" alt="${esc(a.name)}" />`}</div>
        <div class="st-aircraft-copy"><span class="st-overline">${free ? "EXPLORATION" : "YOUR AIRCRAFT"}</span><h2>${free ? "Free camera" : esc(a.name)}</h2><p>${free ? "Unrestricted view of the world" : esc(a.cls)}</p><button class="st-text-btn st-change">Change ${free ? "mode" : "aircraft"} <span aria-hidden="true">↗</span></button></div>
        ${free ? "" : `<div class="st-aircraft-specs">${a.specs.slice(0,2).map(([k,x])=>`<span>${esc(k)} <b>${esc(x)}</b></span>`).join("")}</div>`}
      </section>
      <section class="st-departure" aria-label="Starting position"><div class="st-departure-icon" aria-hidden="true">${ICON.vehicle}</div><div><span class="st-overline">${free ? "EXPLORING FROM" : "AIRBORNE START"}${spot ? ` · ${String(Math.round(spot.heading)).padStart(3,"0")}° ${compass(spot.heading)}` : ""}</span><strong>${esc(free ? c.name : spot.name)}</strong><p>${esc(free ? "Free camera above the city" : spot.detail || startState)}</p>${free ? "" : `<p class="st-start-state">${esc(startState)}</p>`}</div></section>
      <section class="st-conditions" aria-label="Flight conditions">
        <div class="st-section-head"><h2>Flight conditions</h2><span>Simulation</span></div>
        <div class="st-condition-fields"><label><span>Time of day</span><select class="st-time" aria-label="Time of day"></select></label><label><span>Weather</span><select class="st-weather" aria-label="Weather"></select></label></div>
        <div class="st-condition-metrics" aria-live="polite"></div>
        <p class="st-condition-note"></p>
      </section>
      <details class="st-controls"><summary><span>${ICON.free} Controls & flying tips</span><span class="st-disclosure" aria-hidden="true">⌄</span></summary><div class="st-keys">${kind.keys.map(([k,x])=>`<div><span>${esc(x)}</span><kbd>${esc(k)}</kbd></div>`).join("")}<div><span>Free the mouse</span><kbd>Esc</kbd></div></div><ul class="st-list">${kind.expect.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></details>
      <div class="st-quick-keys">${(free ? [["Move","W A S D"],["Look","Mouse"]] : [["Steer","Mouse / arrows"],["Cockpit","V"],["Look","Right drag"]]).map(([x,k])=>`<span>${x} <kbd>${k}</kbd></span>`).join("")}</div>
    </div>`);
    v.querySelector('.st-change').onclick=()=>go(free?'mode':'vehicle');
    const current=window.__weatherState?.() ?? {};
    const times=[[`Keep current · ${fmtHour(current.hour??14)}`,""],[`Local sun time · ${fmtHour(solarNow(c.lon))}`,"now"],...TIMES];
    const timeRow=v.querySelector('.st-time');
    for(const [label,value] of times)timeRow.append(el(`<option value="${value}" ${String(pick.time??"")===String(value)?"selected":""}>${esc(label)}</option>`));
    timeRow.onchange=()=>{pick.time=timeRow.value===""?null:timeRow.value==="now"?"now":Number(timeRow.value);};
    const weatherRow=v.querySelector('.st-weather');
    for(const name of ["",...WEATHER])weatherRow.append(el(`<option value="${name}" ${(pick.weather??"")===name?"selected":""}>${name||"Current conditions"}</option>`));
    const conditions=()=>{
      const w={...window.__weatherState?.(),...(window.__simCatalog?.presets?.find(([n])=>n===pick.weather)?.[1]??{})};
      const value=(n,scale=1)=>Number.isFinite(n)?Math.round(n*scale).toLocaleString('en-GB'):"—";
      v.querySelector('.st-condition-metrics').innerHTML=`<div><span>Wind</span><strong>${value(w.windSpeed,1.943844)} <small>kt</small></strong><em>${Number.isFinite(w.windFrom)?`${String(Math.round(w.windFrom)).padStart(3,"0")}° ${compass(w.windFrom)}`:"Direction unavailable"}</em></div><div><span>Visibility</span><strong>${Number.isFinite(w.visibility)?(w.visibility<1000?(w.visibility/1000).toFixed(1):value(w.visibility,.001)):"—"} <small>km</small></strong><em>Horizontal</em></div><div><span>Cloud base</span><strong>${value(w.cloudBase)} <small>m</small></strong><em>Above terrain</em></div>`;
      const caution=w.visibility<5000||w.lightning||w.precipitation>.5;
      const note=v.querySelector('.st-condition-note');note.classList.toggle('caution',caution);
      note.textContent=caution?"Reduced visual conditions. Watch visibility and cloud clearance.":a?.id==='glider'&&!free?"Unpowered flight. Keep a landing area within gliding range.":"Conditions apply when you start. You can change them during flight.";
    };
    weatherRow.onchange=()=>{pick.weather=weatherRow.value||null;conditions();};
    conditions();
    return v;
  }

  // ---- the title over the world -----------------------------------------------------------------------------------
  let titleFor = null;
  function renderTitle(animate) {
    const c = pick.city;
    if (titleFor !== c || animate) {
      titleFor = c;
      title.innerHTML = `<img class="st-summary-plane" src="assets/thumbs/${esc(pick.asset)}.png" alt=""/><div class="st-selection"><span class="st-summary-label">${step === "welcome" ? "CURRENT FLIGHT SETUP" : "SELECTED DEPARTURE"}</span><h3>${esc(c.name)} <span> / ${pick.mode === "free" ? "Explore" : esc(asset()?.name || pick.asset.toUpperCase())}</span></h3><div class="sub">${flagImg(c.cc)}<span>${esc(c.country)}</span><span>·</span><span class="t">${localTime(c)}</span><span>local</span></div></div>`;

    }
  }

  function tick() {
    if (open) {
      const ready = !!window.__hudState;
      loading.hidden = ready;
      // Clocks, and the launch button once the world is there.
      title.querySelector(".t")?.replaceChildren(localTime(pick.city));
      body.querySelectorAll(".st-city .time").forEach((t) => {
        const c = CITIES.find((x) => x.id === t.dataset.tz) ?? pick.city;
        t.textContent = localTime(c);
      });
      const launchBtn = foot.querySelector(".launch");
      if (launchBtn && launchBtn.disabled === ready) renderFoot();
    }
  }

  // ---- keys ------------------------------------------------------------------------------------------------------
  window.addEventListener(
    "keydown",
    (e) => {
      if (!open) {
        // While deploying, the flight shouldn't be interrupted by a stray key.
        if (deploying && !e.metaKey && !e.ctrlKey) {
          e.stopImmediatePropagation();
          if (e.code === "Tab") e.preventDefault();
        }
        return;
      }
      // Nothing reaches the game or the other menus (they listen on window too, registered after this).
      e.stopImmediatePropagation();
      // Preserve native select and disclosure keyboard behavior without passing keys to the game.
      if (e.target instanceof Element && e.target.closest("select, summary")) return;
      const stepTab = e.target instanceof Element && e.target.closest(".st-steps li");
      if (stepTab && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); stepTab.click(); return; }
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === "Escape") {
        e.preventDefault();
        if (typing && e.target.value) e.target.value = "";
        else back();
      } else if (e.key === "Enter" && !typing) {
        e.preventDefault();
        const a = document.activeElement;
        // Enter on a choice picks it and moves on; on any other button it presses it.
        if (!(a instanceof HTMLButtonElement) || !root.contains(a)) next();
        else if (a.matches(".st-city, .st-mode, .st-veh")) {
          a.click();
          next();
        } else a.click();
      } else if (e.key === "Backspace" && !typing) {
        e.preventDefault();
        back();
      } else if (!typing && e.key.startsWith("Arrow")) {
        e.preventDefault();
        move(e.key.slice(5).toLowerCase());
      }
    },
    true,
  );
  for (const type of ["keyup", "keypress"]) window.addEventListener(type, (e) => open && e.stopImmediatePropagation(), true);
  // The pad (pad.js): B or Menu goes back.
  addEventListener("sim:menu-close", () => open && back());
  // Closed from outside, even at boot: the flight planner (flight.js) opening, or a flight starting.
  addEventListener("sim:start-hide", () => {
    if (!open) return;
    send({ type: "flycancel" });
    flownTo = null;
    hide();
  });

  /** Arrow keys: the nearest control in that direction. */
  function move(dir) {
    const items = [...root.querySelectorAll("button, input, select, summary")].filter((x) => x.offsetParent !== null && !x.disabled);
    const cur = document.activeElement;
    if (!cur || !root.contains(cur)) return items[0]?.focus();
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const x of items) {
      if (x === cur) continue;
      const b = x.getBoundingClientRect();
      const dx = b.left + b.width / 2 - ax;
      const dy = b.top + b.height / 2 - ay;
      const along = { up: -dy, down: dy, left: -dx, right: dx }[dir];
      if (along <= 4) continue;
      const across = dir === "up" || dir === "down" ? Math.abs(dx) : Math.abs(dy);
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = x;
      }
    }
    best?.focus();
    best?.scrollIntoView({ block: "nearest" });
  }

  // ---- launch ----------------------------------------------------------------------------------------------------
  /** Resolves once the camera's flight is over (it has begun and ended), or after `timeout` ms. */
  function arrival(timeout) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let seen = false;
      const id = setInterval(() => {
        const travel = window.__hudState?.base?.travel;
        const bar = deploy.querySelector(".bar i");
        if (travel) {
          seen = true;
          bar.style.width = `${Math.round(Math.min(1, travel.progress) * 85)}%`;
        }
        const waited = performance.now() - t0;
        if ((seen && !travel) || waited > timeout || (!seen && waited > 2000)) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function applyConditions(c) {
    const patch = {};
    if (pick.time === "now") Object.assign(patch, { hour: solarNow(c.lon), day: dayOfYear() });
    else if (typeof pick.time === "number") patch.hour = pick.time;
    if (pick.weather) Object.assign(patch, window.__simCatalog?.presets?.find(([n]) => n === pick.weather)?.[1] ?? {});
    // ui.js applies it, keeps it and updates its menu.
    if (Object.keys(patch).length) dispatchEvent(new CustomEvent("sim:set-weather", { detail: patch }));
  }

  async function launch() {
    if (deploying || !window.__hudState) return;
    const c = pick.city;
    const free = pick.mode === "free";
    const a = asset();
    if (!free && (!a || unavailable(a))) return go("vehicle");
    if (!c.custom) save({ city: c.id, mode: pick.mode, asset: pick.asset });
    applyConditions(c);
    deploying = true;
    hide();
    document.documentElement.classList.add("deploying");
    const spot = free ? { lat: c.lat, lon: c.lon, height: 450, name: c.name, detail: "Free flight" } : startSpot(c, a);
    deploy.querySelector("h3").textContent = spot.name;
    deploy.querySelector("p").textContent = free ? `Free flight · ${c.name}` : `${a.name} · ${c.name}`;
    deploy.querySelector(".bar i").style.width = "0";
    deploy.hidden = false;
    requestAnimationFrame(() => deploy.classList.add("on"));
    send({ type: "flyto", lat: spot.lat, lon: spot.lon, height: spot.height, name: spot.name });
    await arrival(12000);
    if (!free) {
      // A moment for the tiles at the start to sharpen (the ground there decides where it sits).
      await wait(900);
      send({ type: "spawn", id: a.id, enter: true, ground: false, lat: spot.lat, lon: spot.lon, heading: spot.heading, elev: c.elev ?? 0 });
      const t0 = performance.now();
      while (window.__hudState?.mode === "free" && performance.now() - t0 < 5000) await wait(100);
    }
    deploy.querySelector(".bar i").style.width = "100%";
    await wait(250);
    deploy.classList.remove("on");
    document.documentElement.classList.remove("deploying");
    deploying = false;
    setTimeout(() => !deploying && (deploy.hidden = true), 650);
    document.getElementById("canvas")?.focus({ preventScroll: true });
    showToast(free, a, spot);
  }

  let toastTimer = 0;
  function showToast(free, a, spot) {
    const kind = free ? KINDS.free : KINDS[KIND_OF[a.id]] ?? KINDS.jet;
    toast.innerHTML = `
      <b>${free ? `Free flight · ${esc(pick.city.name)}` : `${esc(a.name)} · ${esc(spot.name)}`}</b>
      <div class="keys">${kind.keys.slice(0, 5).map(([k, x]) => `<kbd>${esc(k)}</kbd><span>${esc(x)}</span>`).join("")}</div>
      <div class="go">H shows every key. The FLIGHT SIMULATOR mark takes you back to the start.</div>`;
    toast.hidden = false;
    toast.classList.remove("out");
    clearTimeout(toastTimer);
    const started = performance.now();
    const fade = () => {
      // Once the mouse is taken, a few more seconds; otherwise until it is (up to 20 s).
      if (performance.now() - started < 20000 && !document.pointerLockElement) return (toastTimer = setTimeout(fade, 500));
      toastTimer = setTimeout(() => {
        toast.classList.add("out");
        toastTimer = setTimeout(() => (toast.hidden = true), 500);
      }, 5000);
    };
    toastTimer = setTimeout(fade, 1500);
  }
})();
