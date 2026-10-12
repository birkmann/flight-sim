// Where you are and where to go: a card with the place under the camera (city, region, country, coordinates), and
// a search box (the bar's Search, or /) that flies the camera to a place (`flyto`, handled by src/sandbox/globe.rs).
// Places come from OpenStreetMap: Nominatim, as the app's own search box does (packages/geo/src/geocode.ts), one search
// per Enter and never per keystroke, and the name under the camera at most every 1.5 s, only once it has moved; and
// Photon (komoot's OSM geocoder, made for search-as-you-type), which forgives typos ("straight of hormuz") that
// Nominatim answers with nothing, for the suggestions while typing and alongside Nominatim on Enter.
(function () {
  if (new URLSearchParams(location.search).has("bench")) return;

  const NOMINATIM = "https://nominatim.openstreetmap.org";
  const PHOTON = "https://photon.komoot.io";
  const LANG = navigator.languages?.join(",") || navigator.language || "en";
  /** Photon names places in English, German or French only ("default" is the local script: تنگه هرمز). */
  const PHOTON_LANG = ["en", "de", "fr"].find((l) => (navigator.language || "en").toLowerCase().startsWith(l)) ?? "en";
  /** Famous places, one click away (the arrival height fits what there is to see). */
  const PICKS = [
    { label: "Brandenburg Gate", detail: "Berlin", lat: 52.5163, lon: 13.3777, height: 1200 },
    { label: "Eiffel Tower", detail: "Paris", lat: 48.8584, lon: 2.2945, height: 1200 },
    { label: "London", detail: "United Kingdom", lat: 51.5072, lon: -0.1276, height: 5000 },
    { label: "Manhattan", detail: "New York", lat: 40.758, lon: -73.9855, height: 3000 },
    { label: "Matterhorn", detail: "Swiss Alps", lat: 45.9763, lon: 7.6586, height: 4000 },
    { label: "Tokyo", detail: "Japan", lat: 35.6812, lon: 139.7671, height: 6000 },
    { label: "Sydney Harbour", detail: "Australia", lat: -33.8568, lon: 151.2153, height: 3000 },
    { label: "Europe from space", detail: "1,500 km up", lat: 50, lon: 10, height: 1500000 },
  ];

  window.__cmds = window.__cmds || [];
  const send = (cmd) => window.__cmds.push(JSON.stringify(cmd));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // ---- formatting ---------------------------------------------------------------------------------------------
  const fmtLat = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? "N" : "S"}`;
  const fmtLon = (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? "E" : "W"}`;
  const fmtAlt = (m) => (m >= 100000 ? `${Math.round(m / 1000).toLocaleString("en")} km` : m >= 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m).toLocaleString("en")} m`);
  /** The country's flag (assets/flags/, from flag-icons), or "" for no country. */
  const flag = (cc) => (cc && /^[a-z]{2}$/i.test(cc) ? `assets/flags/${cc.toLowerCase()}.svg` : "");
  /** Great-circle distance (m). */
  function distance(a, b) {
    const r = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ---- the place under the camera -----------------------------------------------------------------------------
  /** Nominatim's detail level for an altitude: the neighbourhood low down, the city, then the region, the country. */
  const zoomFor = (alt) => (alt < 4000 ? 14 : alt < 40000 ? 10 : alt < 400000 ? 5 : 3);
  const cache = new Map();
  let here = null; // { name, detail, cc, at } of the last answer, `at` being where it was asked
  let asked = null; // { lat, lon, zoom } of the last question answered
  let lastAsk = 0;
  let busy = false;
  let failures = 0;

  /** The address's parts, most specific first: "Mitte, Berlin" over "Berlin · Germany". */
  function describe(r, zoom) {
    const a = r?.address;
    if (!a) return null;
    const city = a.city || a.town || a.village || a.municipality || a.hamlet;
    const part = zoom >= 14 ? a.suburb || a.quarter || a.neighbourhood || a.city_district || a.borough : null;
    const region = a.state || a.region || a.province || a.county;
    let name = city ? (part && part !== city ? `${part}, ${city}` : city) : region || a.country;
    if (!name) name = r.name || r.display_name?.split(", ")[0];
    const detail = [city && region !== city ? region : null, a.country !== name ? a.country : null].filter(Boolean).join(" · ");
    return { name, detail, cc: a.country_code };
  }

  async function lookup(lat, lon, zoom) {
    const key = `${zoom}:${lat.toFixed(zoom >= 14 ? 3 : zoom >= 10 ? 2 : 1)},${lon.toFixed(zoom >= 14 ? 3 : zoom >= 10 ? 2 : 1)}`;
    if (cache.has(key)) return cache.get(key);
    const url = new URL(`${NOMINATIM}/reverse`);
    url.search = new URLSearchParams({ lat: lat.toFixed(5), lon: lon.toFixed(5), zoom, format: "jsonv2", addressdetails: 1, "accept-language": LANG });
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`reverse lookup answered ${res.status}`);
    const r = await res.json();
    // Nothing on land: open water (Nominatim has no seas).
    const place = describe(r, zoom) ?? { name: "Open water", detail: "", cc: "", water: true };
    cache.set(key, place);
    return place;
  }

  function maybeLookup(lat, lon, alt) {
    const zoom = zoomFor(alt);
    const moved = !asked || distance(asked, { lat, lon }) > Math.max(250, alt * 0.4) || asked.zoom !== zoom;
    // A question that went unanswered (Nominatim rate-limits) is asked again, less often each time it fails.
    if (!moved || busy || performance.now() - lastAsk < 1500 * 2 ** Math.min(failures, 4)) return;
    busy = true;
    lastAsk = performance.now();
    const q = { lat, lon, zoom };
    lookup(lat, lon, zoom)
      .then((p) => {
        here = { ...p, at: q };
        asked = q;
        failures = 0;
      })
      .catch(() => failures++)
      .finally(() => (busy = false));
  }

  /** The last answer, only while the camera is still near where it was asked: never a name from somewhere else. */
  function placeAt(lat, lon, alt) {
    return here && distance(here.at, { lat, lon }) <= Math.max(2000, alt * 1.5) ? here : null;
  }

  // ---- DOM ----------------------------------------------------------------------------------------------------
  const card = el(`
    <aside id="sim-place" aria-live="polite">
      <div class="kicker"><span class="k">Over</span><button class="cancel" hidden title="Stop the flight (or move)">Stop</button></div>
      <div class="name">—</div>
      <div class="sub" hidden><img class="flag" alt="" hidden /><span></span></div>
      <div class="bar" hidden><i></i></div>
      <div class="coords"></div>
    </aside>`);
  const panel = el(`
    <div id="sim-search" hidden>
      <form>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input type="search" placeholder="City, address, landmark or 52.52, 13.40" aria-label="Search for a place" autocomplete="off" spellcheck="false" />
        <kbd>Enter</kbd>
      </form>
      <div class="state"></div>
      <ol class="results"></ol>
    </div>`);
  const input = panel.querySelector("input");
  const list = panel.querySelector(".results");
  const state = panel.querySelector(".state");
  let results = [];
  let active = -1;
  let searching = null;
  let suggesting = null;
  let typed = 0;

  function mount() {
    document.body.append(card, panel);
    const bar = document.getElementById("sim-bar");
    const btn = el(`<button id="sim-search-btn" title="Search for a place and fly there"><span>Search</span><kbd>/</kbd></button>`);
    btn.onclick = () => (panel.hidden ? open() : close(true));
    bar?.insertBefore(btn, bar.querySelector(".clock"));
    card.querySelector(".cancel").onclick = () => {
      send({ type: "flycancel" });
      document.getElementById("canvas")?.focus({ preventScroll: true });
    };
    panel.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      if (active >= 0 && results[active]) go(results[active]);
      else search(input.value);
    };
    input.addEventListener("input", () => {
      // A new query: the old results no longer answer it. Suggestions follow once typing pauses.
      clearTimeout(typed);
      suggesting?.abort();
      const q = input.value.trim();
      if (!q) return showPicks();
      if (q.length >= 3 && !parseCoords(q)) typed = setTimeout(() => suggest(q), 300);
      else if (results.length && results !== PICKS) render([], "Enter to search");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!results.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        highlight();
      }
    });
    document.getElementById("canvas")?.addEventListener("pointerdown", () => !panel.hidden && close(false));
    setInterval(update, 250);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  function open() {
    panel.hidden = false;
    document.getElementById("sim-search-btn")?.classList.add("on");
    document.exitPointerLock?.();
    send({ type: "menu", open: true });
    if (!input.value.trim()) showPicks();
    input.focus();
    input.select();
  }
  function close(refocus) {
    panel.hidden = true;
    document.getElementById("sim-search-btn")?.classList.remove("on");
    searching?.abort();
    suggesting?.abort();
    clearTimeout(typed);
    send({ type: "menu", open: false });
    if (refocus) document.getElementById("canvas")?.focus({ preventScroll: true });
  }

  window.addEventListener(
    "keydown",
    (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
      if (panel.hidden) {
        // "/" is Shift+7 on some layouts: keep the 7 from reaching the game as a quick spawn.
        if (!typing && e.key === "/" && document.getElementById("sim-menu")?.hidden !== false) {
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.code === "Tab") {
        // The assets menu opens instead (ui.js).
        close(false);
      }
    },
    true,
  );

  // ---- search -------------------------------------------------------------------------------------------------
  /** "52.52, 13.40" (latitude first, as most sources print it), with optional hemisphere letters. */
  function parseCoords(q) {
    const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(q);
    if (!m) return null;
    const lat = Number(m[1]) * (m[2]?.toUpperCase() === "S" ? -1 : 1);
    const lon = Number(m[3]) * (m[4]?.toUpperCase() === "W" ? -1 : 1);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { label: `${fmtLat(lat)}, ${fmtLon(lon)}`, detail: "Coordinates", lat, lon, height: 1500, type: "point" };
  }

  /** The height to arrive at: a view that takes in the place (a building, a city, a country). */
  function heightFor(r, lat) {
    const bb = r.boundingbox?.map(Number);
    if (!bb || bb.length !== 4 || !bb.every(Number.isFinite)) return 1500;
    const [s, n, w, e] = bb;
    const span = Math.max((n - s) * 111320, (e - w) * 111320 * Math.cos((lat * Math.PI) / 180));
    return Math.min(1500000, Math.max(700, span * 0.35));
  }

  /** Nominatim's places for a query (exact, good at addresses, no typos). */
  async function nominatim(q, signal) {
    const url = new URL(`${NOMINATIM}/search`);
    url.search = new URLSearchParams({ q, format: "jsonv2", limit: 6, "accept-language": LANG });
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`the place search answered ${res.status}`);
    const rows = await res.json();
    return rows.flatMap((r) => {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const parts = r.display_name.split(", ");
      const label = r.name || parts[0];
      const osm = r.osm_type && r.osm_id ? `${r.osm_type[0].toUpperCase()}${r.osm_id}` : "";
      return [{ label, detail: (parts[0] === label ? parts.slice(1) : parts).join(", "), type: (r.addresstype ?? r.type ?? "").replace(/_/g, " "), lat, lon, height: heightFor(r, lat), osm }];
    });
  }

  /** Photon's places for a query (fuzzy, so typos still match), nearer the camera first among equals. */
  async function photon(q, signal) {
    const url = new URL(`${PHOTON}/api/`);
    const params = new URLSearchParams({ q, limit: 6, lang: PHOTON_LANG });
    const base = window.__hudState?.base;
    if (base && Number.isFinite(base.lat) && Number.isFinite(base.lon) && (base.alt ?? 0) < 400000) {
      params.set("lat", base.lat.toFixed(3));
      params.set("lon", base.lon.toFixed(3));
    }
    url.search = params;
    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`the place search answered ${res.status}`);
    const { features = [] } = await res.json();
    return features.flatMap((f) => {
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry?.coordinates ?? [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(" ") : null;
      const label = p.name || street || p.city || p.country;
      if (!label) return [];
      const detail = [street !== label ? street : null, p.district, p.city !== label ? p.city : null, p.state, p.country !== label ? p.country : null];
      // Photon's extent is [west, north, east, south]; heightFor takes Nominatim's [south, north, west, east].
      const e = p.extent;
      const boundingbox = e?.length === 4 ? [e[3], e[1], e[0], e[2]] : null;
      return [{
        label,
        detail: [...new Set(detail.filter(Boolean))].join(", "),
        type: (p.osm_value ?? p.type ?? "").replace(/_/g, " "),
        lat,
        lon,
        height: heightFor({ boundingbox }, lat),
        osm: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : "",
      }];
    });
  }

  /** Places matching a query (coordinates without a lookup), best first. The start screen (start.js) uses it too.
   * Both geocoders at once: Nominatim's answers first (its ranking is the better one), then those only Photon found. */
  async function find(query, signal) {
    const q = query.trim();
    const coords = parseCoords(q);
    if (coords) return [coords];
    const [a, b] = await Promise.allSettled([nominatim(q, signal), photon(q, signal)]);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    const found = [];
    for (const r of [...(a.value ?? []), ...(b.value ?? [])]) {
      // The same place from both: the same OSM object, or the same name within a kilometre.
      const same = found.some((o) => (r.osm && o.osm === r.osm) || (o.label === r.label && distance(o, r) < 1000));
      if (!same) found.push(r);
    }
    return found.slice(0, 8);
  }
  window.__placeSearch = find;

  async function search(query) {
    const q = query.trim();
    if (!q) return showPicks();
    if (parseCoords(q)) return render(await find(q), "");
    searching?.abort();
    suggesting?.abort();
    clearTimeout(typed);
    searching = new AbortController();
    render([], "Searching…");
    try {
      const found = await find(q, searching.signal);
      render(found, found.length ? "" : `Nothing found for “${esc(q)}”. Try another spelling, or coordinates like 26.57, 56.25.`);
      if (found.length) {
        active = 0;
        highlight();
      }
    } catch (err) {
      if (err.name !== "AbortError") render([], `<span class="error">Search unavailable: ${esc(err.message)}</span>`);
    }
  }

  /** Suggestions while typing (Photon only: Nominatim's usage policy rules out a search per keystroke). */
  async function suggest(q) {
    suggesting = new AbortController();
    try {
      const found = await photon(q, suggesting.signal);
      if (input.value.trim() !== q || panel.hidden) return;
      render(found, found.length ? "Suggestions · Enter to search" : "Enter to search");
    } catch {
      // A missed suggestion is nothing: Enter still searches.
    }
  }

  function showPicks() {
    render(PICKS, "Enter a place, or pick one:");
  }

  function render(items, message) {
    results = items;
    active = -1;
    state.innerHTML = message;
    list.replaceChildren(
      ...items.map((r, i) => {
        const li = el(`<li><button type="button"><b>${esc(r.label)}</b>${r.type ? `<span class="t">${esc(r.type)}</span>` : ""}<small>${esc(r.detail)}</small></button></li>`);
        li.querySelector("button").onclick = () => go(r);
        li.onmouseenter = () => ((active = i), highlight());
        return li;
      }),
    );
  }

  function highlight() {
    [...list.children].forEach((li, i) => li.classList.toggle("on", i === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function go(r) {
    close(true);
    // The command view has its own camera: back to the live view first.
    if (window.__hudState?.mode === "command") send({ type: "mode" });
    send({ type: "flyto", lat: r.lat, lon: r.lon, height: r.height, name: r.label });
  }

  // ---- the card -----------------------------------------------------------------------------------------------
  const sub = card.querySelector(".sub");
  const subFlag = sub.querySelector(".flag");
  subFlag.onerror = () => (subFlag.hidden = true);
  /** The line under the name, with the country's flag in front (a new image only when the country changes). */
  function setSub(text, cc) {
    sub.querySelector("span").textContent = text;
    sub.hidden = !text;
    const src = flag(cc);
    if (subFlag.getAttribute("src") !== src) {
      if (src) subFlag.src = src;
      else subFlag.removeAttribute("src");
      subFlag.hidden = !src;
    }
  }

  function update() {
    const s = window.__hudState;
    if (!s?.base) return;
    const { lat, lon, alt = 0, travel } = s.base;
    maybeLookup(lat, lon, alt);
    const place = placeAt(lat, lon, alt);
    const kicker = card.querySelector(".k");
    const bar = card.querySelector(".bar");
    card.querySelector(".cancel").hidden = !travel;
    bar.hidden = !travel;
    if (travel) {
      kicker.textContent = `Flying to · ${Math.max(0, travel.left).toFixed(1)} s`;
      card.querySelector(".name").textContent = travel.name;
      bar.querySelector("i").style.width = `${Math.round(Math.min(1, travel.progress) * 100)}%`;
      setSub(place ? `Over ${place.name}${place.detail ? ` · ${place.detail}` : ""}` : "", place?.cc);
    } else {
      kicker.textContent = place?.water ? "Over" : alt > 400000 ? "Above" : "Over";
      card.querySelector(".name").textContent = place ? `${place.name}` : "Locating…";
      setSub(place?.detail ?? "", place?.cc);
    }
    card.querySelector(".coords").textContent = `${fmtLat(lat)}  ${fmtLon(lon)}  ·  ${fmtAlt(alt)}`;
  }
})();
