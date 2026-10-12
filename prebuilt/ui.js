// The sandbox's menus: asset browser (with rendered previews), weather and time, options, controls. Everything the
// app should act on goes through window.__cmds (JSON strings the Bevy app drains every frame; see `apply_commands`
// in src/sandbox.rs). Weather and options persist per browser.
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  // ---- catalogue (ids match src/catalog.rs) --------------------------------------------------------------------
  const ASSETS = [
    { id: "glider", name: "Sailplane", cls: "15 m single-seat glider", cat: "air", role: "Quiet unpowered flight with a variometer and glide computer", flies: true, key: "3", specs: [["Span", "15 m"], ["Cruise", "110 km/h"], ["Engine", "None"], ["Start", "Airborne release"]] },
    { id: "c172", name: "C172", cls: "Light single-engine aircraft", cat: "air", role: "Local flights, sightseeing and basic flight training", flies: true, key: "1", specs: [["Cruise", "118 kt"], ["Engine", "180 hp"], ["Seats", "4"], ["Controls", "Conventional"]] },
    { id: "airliner", name: "Airliner", cls: "A320-class passenger jet", cat: "air", role: "Passenger flights with navigation, autopilot and approach guidance", flies: true, key: "2", specs: [["Cruise", "450 kt"], ["Engines", "2 turbofans"], ["Seats", "180"], ["Controls", "Fly-by-wire"]] },
  ];
  const CATS = [["all", "All aircraft"]];

  const PRESETS = [
    ["Clear", { clouds: 0.05, precipitation: 0, visibility: 40000, lightning: false, snow: false, cloudBase: 2200, windSpeed: 3 }],
    ["Few clouds", { clouds: 0.3, precipitation: 0, visibility: 40000, lightning: false, snow: false, cloudBase: 1800, windSpeed: 4 }],
    ["Scattered", { clouds: 0.55, precipitation: 0, visibility: 35000, lightning: false, snow: false, cloudBase: 1500, windSpeed: 6 }],
    ["Overcast", { clouds: 0.92, precipitation: 0, visibility: 22000, lightning: false, snow: false, cloudBase: 1100, windSpeed: 7 }],
    ["Rain", { clouds: 0.96, precipitation: 0.6, visibility: 40000, lightning: false, snow: false, cloudBase: 800, windSpeed: 9 }],
    ["Thunderstorm", { clouds: 1, precipitation: 1, visibility: 9000, lightning: true, snow: false, cloudBase: 700, windSpeed: 15 }],
    ["Snow", { clouds: 0.9, precipitation: 0.65, visibility: 8000, lightning: false, snow: true, cloudBase: 900, windSpeed: 5 }],
    ["Fog", { clouds: 0.6, precipitation: 0, visibility: 450, lightning: false, snow: false, cloudBase: 400, windSpeed: 1 }],
  ];
  const TIMES = [["Dawn", 4.9], ["Morning", 8.5], ["Noon", 12], ["Afternoon", 15.5], ["Dusk", 20.1], ["Night", 23.5]];
  const DETAIL = [["Low", 2.0], ["Medium", 1.4], ["High", 1.0], ["Ultra", 0.7]];
  // For the start screen (start.js): its vehicle list and weather choices.
  window.__simCatalog = { assets: ASSETS, presets: PRESETS };

  const load = (k, d) => {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v && typeof v === "object" ? { ...d, ...v } : d;
    } catch {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private window */
    }
  };

  const weather = load("sandbox.weather", { hour: 14, day: 180, timeRate: 0, clouds: 0.35, cloudBase: 1800, precipitation: 0, snow: false, visibility: 40000, windSpeed: 4, windFrom: 250, lightning: false, atmosphere: true, cloudLayer: true });
  const options = load("sandbox.options", { fov: 50, sensitivity: 1, invertY: false, detail: 1.0, hud: true });
  let ui = { open: false, tab: "assets", cat: "all", selected: "c172", ground: false };

  window.__cmds = window.__cmds || [];
  const send = (cmd) => window.__cmds.push(JSON.stringify(cmd));
  const sendWeather = (patch, fromHost = false) => {
    Object.assign(weather, patch);
    save("sandbox.weather", weather);
    send({ type: "weather", weather: patch });
    // In a session, the host's changes go to everyone (net.js).
    if (!fromHost) dispatchEvent(new CustomEvent("sim:weather", { detail: patch }));
  };
  window.__weatherState = () => ({ ...weather });
  addEventListener("sim:set-weather", (e) => {
    sendWeather(e.detail ?? {}, true);
    if (ui.open && ui.tab === "weather") render();
  });
  const sendOptions = (patch) => {
    Object.assign(options, patch);
    save("sandbox.options", options);
    send({ type: "settings", settings: patch });
    const hud = document.getElementById("hudcanvas");
    if (hud) hud.style.display = options.hud ? "" : "none";
  };
  // The app starts with the saved state.
  send({ type: "weather", weather: { ...weather } });
  send({ type: "settings", settings: { ...options } });

  // ---- DOM ----------------------------------------------------------------------------------------------------
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const bar = el(`
    <div id="sim-bar">
      <span class="brand">FLIGHT <b>SIMULATOR</b></span>
      <button data-tab="assets"><span>Aircraft</span><kbd>Tab</kbd></button>
      <button data-tab="weather"><span>Weather</span><kbd>K</kbd></button>
      <button data-tab="options"><span>Options</span><kbd>O</kbd></button>
      <button data-tab="controls"><span>Controls</span><kbd>H</kbd></button>
      <button data-tab="multiplayer" id="sim-mp"><span>Invite</span><kbd id="sim-mp-count">1</kbd></button>
      <button data-tab="controller" id="sim-pad" hidden title="Controller connected" aria-label="Controller connected"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10a4.5 4.5 0 0 1 4.4 5.5l-1 4.4a2.3 2.3 0 0 1-4 .9L14.6 16H9.4l-1.8 1.8a2.3 2.3 0 0 1-4-.9l-1-4.4A4.5 4.5 0 0 1 7 7z"/><path d="M8 10v3M6.5 11.5h3"/><circle cx="15.5" cy="10.5" r=".6" fill="currentColor"/><circle cx="17" cy="12.5" r=".6" fill="currentColor"/></svg></button>
      <span class="clock" id="sim-clock"></span>
    </div>`);
  const menu = el(`
    <div id="sim-menu" hidden>
      <div class="panel">
        <header>
          <nav>
            <button data-tab="assets">Aircraft</button>
            <button data-tab="weather">Weather &amp; time</button>
            <button data-tab="options">Options</button>
            <button data-tab="multiplayer">Multiplayer</button>
            <button data-tab="controller">Controller</button>
            <button data-tab="controls">Controls</button>
          </nav>
          <button class="close" title="Close (Esc)" aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </header>
        <section id="sim-body"></section>
      </div>
    </div>`);
  function mount() {
    document.body.append(bar, menu);
    bar.querySelectorAll("button[data-tab]").forEach((b) => (b.onclick = () => openMenu(b.dataset.tab)));
    menu.querySelectorAll("nav button").forEach((b) => (b.onclick = () => ((ui.tab = b.dataset.tab), render())));
    menu.querySelector(".close").onclick = () => closeMenu(true);
    menu.onclick = (e) => {
      if (e.target === menu) closeMenu(true);
    };
    sendOptions({});
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  const TABS = ["assets", "weather", "options", "multiplayer", "controller", "controls"];
  // Multiplayer: keep the bar's count and an open Multiplayer tab current; an invite link opens the tab.
  const netChanged = () => {
    const net = window.__netApi;
    const count = document.getElementById("sim-mp-count");
    if (net && count) {
      const s = net.session();
      count.textContent = s?.open ? String(net.players().length + 1) : "·";
      document.getElementById("sim-mp")?.classList.toggle("live", !!s?.open);
    }
    if (ui.open && ui.tab === "multiplayer" && !menu.contains(document.activeElement?.tagName === "INPUT" ? document.activeElement : null)) render();
  };
  const hookNet = () => (window.__netApi ? window.__netApi.onChange(netChanged) : setTimeout(hookNet, 200));
  hookNet();
  addEventListener("sim:invite", () => openMenu("multiplayer"));
  addEventListener("sim:menu", (e) => (ui.open && ui.tab === e.detail ? closeMenu(false) : openMenu(e.detail)));
  addEventListener("sim:menu-close", () => ui.open && closeMenu(false));
  addEventListener("sim:menu-tab", (e) => {
    if (!ui.open) return;
    ui.tab = TABS[(TABS.indexOf(ui.tab) + e.detail + TABS.length) % TABS.length];
    render();
    focusFirst();
  });
  addEventListener("sim:pads", (e) => {
    const b = document.getElementById("sim-pad");
    if (b) b.hidden = !e.detail;
  });
  /** With a controller, the focus starts on the first control of the tab. */
  function focusFirst() {
    if (!window.__padApi?.pad()) return;
    menu.querySelector("#sim-body button, #sim-body input")?.focus({ preventScroll: true });
  }

  function openMenu(tab) {
    ui.open = true;
    if (tab) ui.tab = tab;
    menu.hidden = false;
    document.exitPointerLock?.();
    send({ type: "menu", open: true });
    render();
    focusFirst();
  }
  function closeMenu(relock) {
    ui.open = false;
    menu.hidden = true;
    send({ type: "menu", open: false });
    // Keys go to the app's canvas: give it the focus back (a click in the menu took it). A click is also a user
    // gesture, so the mouse can be taken straight back.
    const canvas = document.getElementById("canvas");
    canvas?.focus({ preventScroll: true });
    if (relock) canvas?.requestPointerLock?.();
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (window.__immersiveMenuOpen) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (e.code === "Tab") {
        e.preventDefault();
        ui.open && ui.tab === "assets" ? closeMenu(false) : openMenu("assets");
      } else if (e.code === "Escape" && ui.open) {
        closeMenu(false);
      } else if (!typing && e.code === "KeyK") {
        ui.open && ui.tab === "weather" ? closeMenu(false) : openMenu("weather");
      } else if (!typing && e.code === "KeyO") {
        ui.open && ui.tab === "options" ? closeMenu(false) : openMenu("options");
      } else if (!typing && e.code === "KeyH") {
        ui.open && ui.tab === "controls" ? closeMenu(false) : openMenu("controls");
      }
    },
    true,
  );

  // ---- tabs ---------------------------------------------------------------------------------------------------
  const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthOf = (day) => MONTHS[Math.min(11, Math.floor((day - 1) / 30.44))];
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  function render() {
    menu.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === ui.tab));
    const body = menu.querySelector("#sim-body");
    body.className = `tab-${ui.tab}`;
    if (ui.tab === "assets") body.replaceChildren(assetsTab());
    else if (ui.tab === "weather") body.replaceChildren(weatherTab());
    else if (ui.tab === "options") body.replaceChildren(optionsTab());
    else if (ui.tab === "controller") body.replaceChildren(controllerTab());
    else if (ui.tab === "multiplayer") body.replaceChildren(multiplayerTab());
    else body.replaceChildren(controlsTab());
  }

  function assetsTab() {
    const root = el(`<div class="assets"><div class="left"><div class="chips"></div><div class="grid"></div></div><aside class="detail"></aside></div>`);
    const chips = root.querySelector(".chips");
    for (const [id, label] of CATS) {
      const b = el(`<button class="chip${ui.cat === id ? " on" : ""}">${label}</button>`);
      b.onclick = () => ((ui.cat = id), render());
      chips.append(b);
    }
    const grid = root.querySelector(".grid");
    for (const a of ASSETS.filter((a) => ui.cat === "all" || a.cat === ui.cat)) {
      const card = el(`
        <button class="card${ui.selected === a.id ? " on" : ""}">
          <img src="assets/thumbs/${a.thumb ?? a.id}.png" alt="" loading="lazy" />
          <span class="name">${a.name}${a.key ? `<kbd title="Press ${a.key} in free flight to spawn">${a.key}</kbd>` : ""}</span>
          <span class="cls">${a.cls}</span>
        </button>`);
      card.onclick = () => ((ui.selected = a.id), render());
      card.ondblclick = () => spawn(a, true);
      grid.append(card);
    }
    const a = ASSETS.find((x) => x.id === ui.selected) ?? ASSETS[0];
    const detail = root.querySelector(".detail");
    detail.append(
      el(`<div class="hero"><img src="assets/thumbs/${a.thumb ?? a.id}.png" alt="${a.name}" /></div>`),
      el(`<h2>${a.name} <small>${a.cls}</small></h2>`),
      el(`<p class="role">${a.role}</p>`),
      el(`<dl class="specs">${a.specs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`),
    );
    if (a.flies) {
      const t = el(`<label class="toggle"><input type="checkbox" ${ui.ground ? "checked" : ""}/> <span>Start on the ground</span></label>`);
      t.querySelector("input").onchange = (e) => (ui.ground = e.target.checked);
      detail.append(t);
    }
    const actions = el(`<div class="actions"><button class="primary">Fly this aircraft</button><button>Add aircraft</button></div>`);
    const [go, drop] = actions.querySelectorAll("button");
    go.onclick = () => spawn(a, true);
    drop.onclick = () => spawn(a, false);
    detail.append(actions, el(`<p class="hint">${a.key ? `Press ${a.key} in free camera mode to add this aircraft. ` : ""}F enters or leaves the aircraft · V changes the view · P opens the flight planner.</p>`));
    return root;
  }

  function spawn(a, enter) {
    send({ type: "spawn", id: a.id, ground: ui.ground, enter });
    closeMenu(true);
  }

  function slider(label, value, min, max, step, show, onInput) {
    const row = el(`<label class="slider"><span class="k">${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"/><span class="v">${show(value)}</span></label>`);
    const input = row.querySelector("input");
    const out = row.querySelector(".v");
    input.oninput = () => {
      const v = Number(input.value);
      out.textContent = show(v);
      onInput(v);
    };
    return row;
  }
  function toggle(label, value, onChange) {
    const row = el(`<label class="toggle"><input type="checkbox" ${value ? "checked" : ""}/> <span>${label}</span></label>`);
    row.querySelector("input").onchange = (e) => onChange(e.target.checked);
    return row;
  }
  function segmented(options, current, onPick) {
    const row = el(`<div class="segmented"></div>`);
    for (const [label, value] of options) {
      const b = el(`<button class="${current === value ? "on" : ""}">${label}</button>`);
      b.onclick = () => {
        onPick(value);
        render();
      };
      row.append(b);
    }
    return row;
  }

  function weatherTab() {
    const root = el(`<div class="settings"><div class="col"></div><div class="col"></div></div>`);
    const [a, b] = root.querySelectorAll(".col");
    a.append(el(`<h3>Conditions</h3>`));
    const presets = el(`<div class="presets"></div>`);
    for (const [name, values] of PRESETS) {
      const p = el(`<button>${name}</button>`);
      p.onclick = () => {
        sendWeather(values);
        render();
      };
      presets.append(p);
    }
    a.append(
      presets,
      slider("Cloud cover", weather.clouds, 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`, (v) => sendWeather({ clouds: v })),
      slider("Cloud base", weather.cloudBase, 200, 4000, 50, (v) => `${Math.round(v)} m`, (v) => sendWeather({ cloudBase: v })),
      slider("Precipitation", weather.precipitation, 0, 1, 0.01, (v) => (v < 0.02 ? "none" : `${Math.round(v * 100)} %`), (v) => sendWeather({ precipitation: v })),
      toggle("Snow instead of rain", weather.snow, (v) => sendWeather({ snow: v })),
      toggle("Lightning (in heavy cloud)", weather.lightning, (v) => sendWeather({ lightning: v })),
      slider("Visibility", Math.log10(weather.visibility), 2.3, 4.6, 0.01, (v) => (10 ** v >= 39000 ? "unlimited" : `${(10 ** v / 1000).toFixed(1)} km`), (v) => sendWeather({ visibility: 10 ** v })),
    );
    b.append(el(`<h3>Wind</h3>`));
    b.append(
      slider("Speed", weather.windSpeed, 0, 30, 0.5, (v) => `${v.toFixed(1)} m/s · ${Math.round(v * 1.944)} kt`, (v) => sendWeather({ windSpeed: v })),
      slider("From", weather.windFrom, 0, 359, 1, (v) => `${String(Math.round(v)).padStart(3, "0")}° ${compass(v)}`, (v) => sendWeather({ windFrom: v })),
    );
    b.append(el(`<h3>Time of day</h3>`));
    b.append(
      segmented(TIMES, null, (h) => sendWeather({ hour: h })),
      slider("Solar time", weather.hour, 0, 23.99, 0.05, fmtHour, (v) => sendWeather({ hour: v })),
      slider("Date", weather.day, 1, 365, 1, (v) => `${monthOf(v)} · day ${v}`, (v) => sendWeather({ day: v })),
    );
    b.append(el(`<div class="k-label">Clock</div>`), segmented([["Stopped", 0], ["Real time", 1], ["×60", 60], ["×600", 600]], weather.timeRate, (v) => sendWeather({ timeRate: v })));
    return root;
  }

  function optionsTab() {
    const root = el(`<div class="settings"><div class="col"></div><div class="col"></div></div>`);
    const [a, b] = root.querySelectorAll(".col");
    a.append(el(`<h3>View</h3>`));
    a.append(
      slider("Field of view", options.fov, 35, 95, 1, (v) => `${v}°`, (v) => sendOptions({ fov: v })),
      slider("Mouse sensitivity", options.sensitivity, 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`, (v) => sendOptions({ sensitivity: v })),
      toggle("Invert mouse Y", options.invertY, (v) => sendOptions({ invertY: v })),
      toggle("Show the HUD", options.hud, (v) => sendOptions({ hud: v })),
    );
    b.append(el(`<h3>Graphics</h3>`), el(`<div class="k-label">Terrain detail</div>`), segmented(DETAIL, options.detail, (v) => sendOptions({ detail: v })));
    b.append(
      toggle("Physical sky and haze", weather.atmosphere, (v) => sendWeather({ atmosphere: v })),
      toggle("Cloud layer", weather.cloudLayer, (v) => sendWeather({ cloudLayer: v })),
      el(`<p class="hint">Higher detail streams more tiles: sharper, but more download and memory.</p>`),
    );
    return root;
  }

  function multiplayerTab() {
    const net = window.__netApi;
    const root = el(`<div class="settings multiplayer"><div class="col"></div><div class="col"></div></div>`);
    const [a, b] = root.querySelectorAll(".col");
    if (!net) return root;
    const session = net.session();
    const offer = window.__netInvite;
    a.append(el(`<h3>You</h3>`));
    const name = el(`<label class="field"><span>Name</span><input type="text" maxlength="24" value="${net.me().name.replace(/"/g, "&quot;")}"/></label>`);
    name.querySelector("input").onchange = (e) => net.setName(e.target.value);
    a.append(name);

    a.append(el(`<h3>Session</h3>`));
    if (!session?.open && !(session && !session.error)) {
      if (offer) {
        const card = el(`<div class="invite-card"><b>You're invited</b><span>Session ${offer.id} · code ${offer.code}</span></div>`);
        const join = el(`<button class="primary-btn">Join session</button>`);
        join.onclick = () => net.join(offer.id, offer.code);
        card.append(join);
        a.append(card);
      }
      const host = el(`<button class="primary-btn">Host a session</button>`);
      host.onclick = () => net.host();
      a.append(host);
      const joinRow = el(`<div class="join-row"><input type="text" placeholder="Paste an invite link"/><button class="small">Join</button></div>`);
      joinRow.querySelector("button").onclick = () => {
        const text = joinRow.querySelector("input").value.trim();
        const url = (() => {
          try {
            return new URL(text);
          } catch {
            return null;
          }
        })();
        const id = url?.searchParams.get("join");
        const code = url?.searchParams.get("code");
        if (id && code) net.join(id, code);
      };
      a.append(joinRow);
      if (session?.error) a.append(el(`<p class="error">${session.error}</p>`));
    } else {
      const status = session.open ? (session.role === "host" ? "Hosting" : "Joined") : "Connecting…";
      a.append(el(`<div class="pad-status"><b>${status} · session ${session.id}</b><span>Fly together and see each other's aircraft. The host's weather applies to everyone.</span></div>`));
      if (session.open) {
        const link = net.invite();
        const box = el(`<div class="invite"><input type="text" readonly value="${link}"/><button class="small">Copy link</button></div>`);
        const copy = box.querySelector("button");
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(link);
            copy.textContent = "Copied";
          } catch {
            box.querySelector("input").select();
            copy.textContent = "Press ⌘C";
          }
          setTimeout(() => (copy.textContent = "Copy link"), 1800);
        };
        a.append(el(`<div class="k-label">Invite link</div>`), box);
        if (navigator.share) {
          const share = el(`<button class="small">Share…</button>`);
          share.onclick = () => navigator.share({ title: "Join my FLIGHT SIMULATOR session", url: link }).catch(() => {});
          a.append(share);
        }
        if (net.localOnly()) {
          a.append(el(`<p class="hint">This link points at ${location.hostname}, which only this computer can open. For other devices, start the servers on your network address (see the README) and open the page through it, then invite from there.</p>`));
        }
      }
      const leave = el(`<button class="small danger">Leave session</button>`);
      leave.onclick = () => net.leave();
      a.append(leave);
    }

    b.append(el(`<h3>Players</h3>`));
    const list = el(`<div class="players"></div>`);
    const row = (nm, what, badge) => el(`<div class="player"><span class="dot"></span><b>${nm}</b><span class="what">${what || "free flight"}</span>${badge ? `<span class="badge">${badge}</span>` : ""}</div>`);
    list.append(row(`${net.me().name} (you)`, window.__hudState?.label ?? "", session?.open ? (session.role === "host" ? "host" : "guest") : "offline"));
    for (const p of net.players()) list.append(row(p.name, p.what, ""));
    b.append(list);
    if (!session?.open) b.append(el(`<p class="hint">Host a session and send the link: whoever opens it joins your sky.</p>`));
    return root;
  }

  function controllerTab() {
    const api = window.__padApi;
    const root = el(`<div class="settings controller"><div class="col"></div><div class="col"></div></div>`);
    const [a, b] = root.querySelectorAll(".col");
    if (!api) return root;
    // Status and pad choice.
    a.append(el(`<h3>Controller</h3>`));
    const status = el(`<div class="pad-status"></div>`);
    a.append(status);
    const all = api.pads();
    if (all.length > 1) {
      a.append(segmented(all.map((p) => [p.id.split("(")[0].trim().slice(0, 22) || `Pad ${p.index}`, p.index]), api.settings().pad, (v) => api.setSettings({ pad: v })));
    }
    // Live tester: raw buttons and axes, and what the mapping makes of them.
    a.append(el(`<h3>Test</h3>`));
    const buttons = el(`<div class="pad-buttons"></div>`);
    const axes = el(`<div class="pad-axes"></div>`);
    const actions = el(`<div class="pad-axes"></div>`);
    a.append(buttons, el(`<div class="k-label">Axes</div>`), axes, el(`<div class="k-label">Actions (after mapping, deadzone and curve)</div>`), actions);
    const bar = (label) => {
      const row = el(`<div class="pad-axis"><span class="k">${label}</span><span class="track"><span class="fill"></span><span class="mid"></span></span><span class="v">0.00</span></div>`);
      return { row, fill: row.querySelector(".fill"), v: row.querySelector(".v"), set(x) { const c = Math.max(-1, Math.min(1, x)); this.fill.style.left = `${50 + Math.min(0, c) * 50}%`; this.fill.style.width = `${Math.abs(c) * 50}%`; this.v.textContent = c.toFixed(2); } };
    };
    const actionBars = ["stickX", "stickY", "lookX", "lookY", "trigger", "bumper"].map((id) => {
      const b = bar(api.ACTIONS.find((x) => x.id === id).label);
      actions.append(b.row);
      return [id, b];
    });
    const held = el(`<div class="pad-held"></div>`);
    actions.append(held);
    const vib = el(`<button class="small">Test vibration</button>`);
    vib.onclick = () => api.pad()?.vibrationActuator?.playEffect?.("dual-rumble", { duration: 400, strongMagnitude: 0.8, weakMagnitude: 0.8 }).catch(() => {});
    a.append(vib);
    let buttonEls = [];
    let axisBars = [];
    let shape = "";
    const tick = () => {
      if (!root.isConnected) return;
      requestAnimationFrame(tick);
      const p = api.pad();
      status.innerHTML = p
        ? `<b>${p.id.replace(/\(.*?\)/g, "").trim() || "Controller"}</b><span>${p.mapping === "standard" ? "Standard layout" : "Non-standard layout: map the buttons on the right"} · ${p.buttons.length} buttons · ${p.axes.length} axes${p.vibrationActuator ? " · vibration" : ""}</span>`
        : `<b>No controller</b><span>Connect one and press any button (browsers only report a pad after a press).</span>`;
      if (!p) return;
      const sig = `${p.buttons.length}/${p.axes.length}`;
      if (sig !== shape) {
        shape = sig;
        buttons.replaceChildren();
        axes.replaceChildren();
        buttonEls = p.buttons.map((_, i) => {
          const pill = el(`<span class="pad-btn"><span class="fill"></span><span class="t">${api.buttonName(i, p)}</span></span>`);
          buttons.append(pill);
          return pill;
        });
        axisBars = p.axes.map((_, i) => {
          const b = bar(api.axisName(i));
          axes.append(b.row);
          return b;
        });
      }
      p.buttons.forEach((btn, i) => {
        const v = btn.value || (btn.pressed ? 1 : 0);
        buttonEls[i].classList.toggle("on", btn.pressed);
        buttonEls[i].querySelector(".fill").style.height = `${v * 100}%`;
      });
      p.axes.forEach((v, i) => axisBars[i].set(v));
      const s = api.sample();
      for (const [id, b] of actionBars) b.set(s?.[id] ?? 0);
      held.textContent = api.ACTIONS.filter((x) => x.kind === "button" && s?.[x.id] > 0.5).map((x) => x.label).join(" · ") || "No buttons held";
    };
    requestAnimationFrame(tick);

    // Mapping editor.
    b.append(el(`<h3>Mapping</h3>`));
    const table = el(`<div class="pad-map"></div>`);
    for (const act of api.ACTIONS) {
      const row = el(`<div class="pad-row"><span class="k"><b>${act.label}</b><small>${act.hint}</small></span><span class="bind">${api.bindingLabel(api.mapping()[act.id])}</span><button class="small">Rebind</button></div>`);
      const bind = row.querySelector(".bind");
      const btn = row.querySelector("button");
      btn.onclick = async () => {
        if (!api.pad()) {
          bind.textContent = "Connect a controller first";
          return;
        }
        row.classList.add("capturing");
        btn.disabled = true;
        bind.textContent = act.kind === "axis" ? "Move the stick or trigger (toward positive), or press a button" : "Press a button";
        const result = await api.capture(act.id, (msg) => (bind.textContent = msg));
        row.classList.remove("capturing");
        btn.disabled = false;
        bind.textContent = result ? api.bindingLabel(result) : api.bindingLabel(api.mapping()[act.id]) + " (unchanged)";
      };
      table.append(row);
    }
    b.append(table);
    b.append(el(`<h3>Feel</h3>`));
    const ps = api.settings();
    b.append(
      slider("Deadzone", ps.deadzone, 0, 0.4, 0.01, (v) => `${Math.round(v * 100)} %`, (v) => api.setSettings({ deadzone: v })),
      slider("Look speed", ps.lookSpeed, 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`, (v) => api.setSettings({ lookSpeed: v })),
      slider("Response curve", ps.curve, 0, 1, 0.05, (v) => (v < 0.05 ? "linear" : v > 0.95 ? "cubic" : `${Math.round(v * 100)} % expo`), (v) => api.setSettings({ curve: v })),
      toggle("Invert look Y", ps.invertLook, (v) => api.setSettings({ invertLook: v })),
      toggle("Vibration", ps.vibration, (v) => api.setSettings({ vibration: v })),
    );
    const reset = el(`<button class="small danger">Reset mapping and settings</button>`);
    reset.onclick = () => {
      api.reset();
      render();
    };
    b.append(reset);
    return root;
  }

  function controlsTab() {
    const rows = [
      ["Menus", "P flight planner · Tab aircraft · K weather · O options · H controls · / search a place · Esc release the mouse"],
      ["Free camera", "Mouse look · WASD move · Space/C up/down · Shift faster · Wheel speed · 1 C172 · 2 airliner · Backspace remove last aircraft"],
      ["Aircraft", "Mouse or arrows: pitch and roll · W/S throttle · A/D rudder · G landing gear · B brakes · F enter/leave · V change view · Right-drag look around · Wheel chase distance"],
      ["Airport flights", "Use P to select airports, aircraft, fuel and payload. Follow the flight deck controls for flaps, autopilot, navigation and approach guidance."],
      ["Controller", "Left stick flight controls · Right stick look · RT/LT throttle · RB/LB rudder · B enter/leave · Y view · X gear · D-pad up/down zoom · RS brakes · Menu aircraft · View options"],
      ["Controller in menus", "D-pad or left stick move · A select · B or Menu close · LB/RB tabs · Left/right adjust sliders"],
    ];
    return el(`<div class="controls">${rows.map(([k, v]) => `<div><h4>${k}</h4><p>${v}</p></div>`).join("")}</div>`);
  }

  // The clock in the bar follows the app's (it can run): hud.js keeps the last state in window.__hudState.
  setInterval(() => {
    const w = window.__hudState?.base?.fx?.weather;
    const clock = document.getElementById("sim-clock");
    if (w && clock) {
      clock.textContent = `${fmtHour(w.hour)} · ${monthOf(w.day)}`;
      weather.hour = w.hour;
    }
  }, 500);
})();
