// Engine-neutral benchmark harness, loaded as a plain script by both spike pages (Bevy and Cesium). The engine calls
// three hooks; everything else is measured here from the browser's side, the same way for both:
//   __benchStart()    once, on the engine's first frame: scenario time 0 (the camera path and units start here)
//   __benchTile()     each time a tile's content is added to the scene
//   __benchMem(bytes) optionally, the engine's own memory: Bevy's wasm linear memory, Cesium's tileset memory
// Results: window.__bench (JSON, `done: true` after the last leg), an on-screen overlay, and one console line.
(function () {
  if (document.documentElement.dataset.bench === "off") return;
  const engine = document.documentElement.dataset.engine || "unknown";
  // [{ name, from, to }] in seconds, and the default unit count, from scenario.json next to the page.
  // A bundling page hands it over as window.__benchScenario; a static page serves it next to itself.
  let legs = null;
  let units = Number(new URLSearchParams(location.search).get("n")) || 0;
  const useScenario = (s) => {
    legs = s.legs;
    units ||= s.units;
  };
  if (window.__benchScenario) useScenario(window.__benchScenario);
  else fetch("scenario.json").then((r) => r.json()).then(useScenario);
  const TILE_HOST = "tile.googleapis.com";

  let t0 = null; // performance.now() at scenario start
  const frames = []; // [sceneSeconds, frameMs]
  const tiles = []; // sceneSeconds (may be negative: before the first frame)
  const requests = []; // { start, end, bytes, glb } in scene seconds
  const longTasks = []; // [sceneSeconds, durationMs]
  let engineBytes = 0;
  let firstTileMs = null;

  const sceneS = (ms) => (t0 == null ? -1e9 : (ms - t0) / 1000);

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.name.includes(TILE_HOST)) continue;
      const glb = /\.glb(\?|$)/.test(e.name);
      requests.push({ start: sceneS(e.startTime), end: sceneS(e.responseEnd), bytes: e.encodedBodySize || e.transferSize || 0, glb });
    }
  }).observe({ type: "resource", buffered: true });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push([sceneS(e.startTime), e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* not supported */
  }

  window.__benchStart = () => {
    if (t0 != null) return;
    t0 = performance.now();
    let last = t0;
    requestAnimationFrame(function tick(now) {
      frames.push([(now - t0) / 1000, now - last]);
      last = now;
      requestAnimationFrame(tick); // keeps counting after the last leg, so the live fps stays true
    });
  };
  window.__benchTile = () => {
    const now = performance.now();
    if (firstTileMs == null) firstTileMs = now;
    tiles.push(sceneS(now));
  };
  window.__benchMem = (bytes) => (engineBytes = bytes);

  const round = (v, d = 1) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

  function frameStats(from, to) {
    const ms = frames.filter(([s]) => s >= from && s < to).map(([, d]) => d);
    if (!ms.length) return null;
    const sorted = [...ms].sort((a, b) => a - b);
    const worst = sorted.slice(Math.floor(sorted.length * 0.99));
    const worstMean = worst.reduce((a, b) => a + b, 0) / worst.length;
    return {
      frames: ms.length,
      fpsAvg: round(ms.length / (to - from)),
      fps1Low: round(1000 / worstMean),
      p50Ms: round(pct(sorted, 50)),
      p95Ms: round(pct(sorted, 95)),
      p99Ms: round(pct(sorted, 99)),
      maxMs: round(sorted[sorted.length - 1]),
      over33Ms: ms.filter((d) => d > 33.4).length,
      over100Ms: ms.filter((d) => d > 100).length,
    };
  }

  function legStats(leg) {
    const inLeg = (s) => s >= leg.from && s < leg.to;
    const legTiles = tiles.filter(inLeg);
    // Settled: the last tile added in this leg, if the leg then stayed quiet for its last 1.5 s.
    const lastTile = legTiles.length ? legTiles[legTiles.length - 1] : null;
    const settledS = lastTile != null && lastTile < leg.to - 1.5 ? lastTile - leg.from : lastTile == null ? 0 : null;
    const reqs = requests.filter((r) => inLeg(r.start));
    return {
      leg: leg.name,
      ...frameStats(leg.from, leg.to),
      tilesAdded: legTiles.length,
      settledS: round(settledS, 2),
      tileRequests: reqs.length,
      tileMB: round(reqs.reduce((a, r) => a + r.bytes, 0) / 1e6, 2),
      longTaskMs: Math.round(longTasks.filter(([s]) => inLeg(s)).reduce((a, [, d]) => a + d, 0)),
    };
  }

  function downloadSize() {
    // The page's own code (script + wasm), same origin, as the server sent it.
    const own = performance
      .getEntriesByType("resource")
      .filter((e) => e.name.startsWith(location.origin) && /\.(m?js|wasm)(\?|$)/.test(e.name));
    return {
      files: own.length,
      transferMB: round(own.reduce((a, e) => a + (e.transferSize || 0), 0) / 1e6, 2),
      decodedMB: round(own.reduce((a, e) => a + (e.decodedBodySize || 0), 0) / 1e6, 2),
    };
  }

  const result = (window.__bench = { engine, units, done: false });

  function update() {
    if (!legs) return;
    const now = t0 == null ? -1 : (performance.now() - t0) / 1000;
    const leg = legs.find((l) => now >= l.from && now < l.to);
    Object.assign(result, {
      engine,
      units,
      devicePixelRatio: window.devicePixelRatio,
      viewport: [innerWidth, innerHeight],
      userAgent: navigator.userAgent,
      coldStartMs: t0 == null ? null : Math.round(t0), // navigation start → engine's first frame
      firstTileMs: firstTileMs == null ? null : Math.round(firstTileMs), // navigation start → first tile in the scene
      firstGlbResponseMs: (() => {
        const g = requests.filter((r) => r.glb).sort((a, b) => a.end - b.end)[0];
        return g && t0 != null ? Math.round(g.end * 1000 + t0) : null;
      })(),
      download: downloadSize(),
      jsHeapMB: performance.memory ? round(performance.memory.usedJSHeapSize / 1e6) : null,
      engineMemoryMB: engineBytes ? round(engineBytes / 1e6) : null,
      legs: legs.filter((l) => now >= l.to).map(legStats),
      total: now >= legs[legs.length - 1].to ? legStats({ name: "total", from: legs[0].from, to: legs[legs.length - 1].to }) : null,
    });
    const live = frameStats(Math.max(0, now - 1), now);
    overlay.textContent =
      `${engine} · ${units} units · ${leg ? leg.name : t0 == null ? "starting" : "done"} ${now >= 0 ? now.toFixed(0) + " s" : ""}\n` +
      `fps ${live ? live.fpsAvg : "–"} · tiles ${tiles.length} · req ${requests.length}` +
      (result.jsHeapMB ? ` · heap ${result.jsHeapMB} MB` : "") +
      (result.engineMemoryMB ? ` · engine ${result.engineMemoryMB} MB` : "");
    if (t0 != null && now >= legs[legs.length - 1].to && !result.done) {
      result.done = true;
      console.log("[bench]", JSON.stringify(result));
    }
  }

  const overlay = document.createElement("pre");
  overlay.id = "bench-overlay";
  overlay.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:20;margin:0;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font:12px/1.4 ui-monospace,monospace;pointer-events:none;white-space:pre";
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(overlay));
  if (document.body) document.body.appendChild(overlay);
  setInterval(update, 500);
})();
