// Cesium ion asset resolver: GET /api/tiles/ion/:assetId answers the asset's tile endpoint and a short-lived,
// asset-scoped access token, which the 3D globe uses to stream the tiles. The account token (CESIUM_API_KEY /
// CESIUM_ION_TOKEN) stays in this process; only assets on the allowlist can be resolved.
import { json } from "./handler.mjs";

/** Cesium OSM Buildings (3D Tiles), Cesium World Terrain (heights under the buildings) and the photorealistic 3D mesh. */
export const DEFAULT_ION_ASSETS = [96188, 1, 2275207];

/** Endpoint tokens live about an hour; hand out a cached one for at most half of that. */
const CACHE_MS = 30 * 60_000;

/**
 * @param {{ token: string | null; host?: string; assets?: number[]; fetchImpl?: typeof fetch; now?: () => number }} opts
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createIonHandler(opts) {
  const host = (opts.host ?? "https://api.cesium.com").replace(/\/+$/, "");
  const allowed = new Set(opts.assets ?? DEFAULT_ION_ASSETS);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  /** @type {Map<number, { at: number; body: Promise<{ url: string; accessToken: string; type: string; attributions: { html: string }[] }> }>} */
  const cache = new Map();

  /** @param {number} id */
  const resolve = (id) => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < CACHE_MS) return hit.body;
    const body = fetchImpl(`${host}/v1/assets/${id}/endpoint`, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(10_000) })
      .then(async (r) => {
        if (!r.ok) throw Object.assign(new Error(`Cesium ion answered ${r.status}`), { status: r.status });
        const data = /** @type {any} */ (await r.json());
        // An external asset (`externalType`, e.g. the photorealistic 3D mesh) is not hosted by ion: it answers the
        // provider's own tileset URL, already carrying ion's credentials, and there is no asset-scoped token to renew.
        const url = typeof data?.url === "string" ? data.url : typeof data?.options?.url === "string" ? data.options.url : null;
        if (!url || (typeof data?.accessToken !== "string" && !data?.externalType)) throw new Error("Cesium ion returned no tile endpoint for this asset");
        return {
          url,
          accessToken: typeof data.accessToken === "string" ? data.accessToken : "",
          type: String(data.type ?? ""),
          attributions: Array.isArray(data.attributions) ? data.attributions.map((/** @type {any} */ a) => ({ html: String(a?.html ?? "") })) : [],
        };
      });
    cache.set(id, { at: now(), body });
    body.catch(() => cache.delete(id));
    return body;
  };

  return async (req, res) => {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed", status: 405 });
    const path = new URL(req.url ?? "/", "http://gateway.local").pathname;
    const match = /^\/api\/tiles\/ion\/(\d+)$/.exec(path);
    if (!match) return json(res, 404, { error: "Not found", status: 404 });
    if (!opts.token) return json(res, 503, { error: "3D tiles are not configured (set CESIUM_API_KEY on the gateway).", status: 503 });
    const id = Number(match[1]);
    if (!allowed.has(id)) return json(res, 403, { error: `Asset ${id} is not on this gateway's allowlist`, status: 403 });
    try {
      const body = await resolve(id);
      return json(res, 200, body);
    } catch (err) {
      const status = /** @type {any} */ (err)?.status;
      return json(res, 502, { error: status === 401 || status === 403 ? "The gateway's Cesium ion token was refused" : "Cesium ion is unreachable", status: 502 });
    }
  };
}
