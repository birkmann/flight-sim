// Live airport weather for the Bevy sandbox's flights: the latest METAR of up to eight airports from the Aviation
// Weather Center's public data API (aviationweather.gov), which sends no CORS headers, so the page asks here. Reports
// are cached for five minutes per airport; the answer is the parts a simulator uses, plus the raw report.
//
//   GET /api/sim/metar?ids=EDDB,EDDH   -> { metars: [{ icao, raw, time, windFrom, windKt, gustKt, visibilityM, qnh,
//                                                        temp, dew, clouds: [{ cover, baseFt }], wx }] }
import { json } from "./handler.mjs";

const UPSTREAM = "https://aviationweather.gov/api/data/metar";
const TTL_MS = 5 * 60_000;
const ICAO = /^[A-Z0-9]{3,4}$/;
const MAX_IDS = 8;

/** The report's parts. `visib` is statute miles ("6+" is ten or more); `altim` hectopascals. */
export function parseMetar(/** @type {any} */ m) {
  const visib = typeof m.visib === "string" ? (m.visib.endsWith("+") ? 10 : parseFloat(m.visib)) : Number(m.visib);
  return {
    icao: String(m.icaoId ?? ""),
    raw: String(m.rawOb ?? ""),
    time: m.reportTime ?? null,
    windFrom: typeof m.wdir === "number" ? m.wdir : null,
    windKt: Number(m.wspd ?? 0) || 0,
    gustKt: m.wgst == null ? null : Number(m.wgst),
    visibilityM: Number.isFinite(visib) ? Math.round(Math.min(visib, 10) * 1609.34) : null,
    qnh: m.altim == null ? null : Number(m.altim),
    temp: m.temp ?? null,
    dew: m.dewp ?? null,
    clouds: Array.isArray(m.clouds) ? m.clouds.map((/** @type {any} */ c) => ({ cover: String(c.cover), baseFt: c.base == null ? null : Number(c.base) })) : [],
    wx: m.wxString ?? null,
  };
}

/**
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [opts]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createMetarHandler(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  /** @type {Map<string, { at: number, metar: ReturnType<typeof parseMetar> | null }>} */
  const cache = new Map();
  return async function metar(req, res) {
    if (req.method !== "GET") return json(res, 405, { error: "GET only", status: 405 });
    const ids = [...new Set((new URL(req.url ?? "/", "http://gateway.local").searchParams.get("ids") ?? "").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length || ids.length > MAX_IDS || !ids.every((id) => ICAO.test(id))) return json(res, 400, { error: `ids: 1 to ${MAX_IDS} ICAO codes, comma-separated`, status: 400 });
    const stale = ids.filter((id) => !(now() - (cache.get(id)?.at ?? -Infinity) < TTL_MS));
    if (stale.length) {
      try {
        const r = await fetchImpl(`${UPSTREAM}?ids=${stale.join(",")}&format=json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        const list = r.ok && r.status !== 204 ? await r.json() : [];
        for (const id of stale) cache.set(id, { at: now(), metar: null });
        for (const m of Array.isArray(list) ? list : []) {
          const p = parseMetar(m);
          if (stale.includes(p.icao)) cache.set(p.icao, { at: now(), metar: p });
        }
      } catch {
        if (!ids.some((id) => cache.get(id)?.metar)) return json(res, 502, { error: "Weather service unavailable", status: 502 });
      }
    }
    res.setHeader("cache-control", "public, max-age=120");
    return json(res, 200, { metars: ids.map((id) => cache.get(id)?.metar).filter(Boolean) });
  };
}
