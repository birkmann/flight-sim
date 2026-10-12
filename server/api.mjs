import { createIonHandler } from "./ion.mjs";
import { createMetarHandler } from "./metar.mjs";
import { createMemorySignalStore, createRedisSignalStore, createSignalHandler } from "./signal.mjs";
import { json } from "./handler.mjs";

export function createApiHandler({ env = process.env, fetchImpl = fetch, dev = false, serverless = false } = {}) {
  const ion = createIonHandler({ token: env.CESIUM_API_KEY || env.CESIUM_ION_TOKEN || null, assets: [2275207], fetchImpl });
  const metar = createMetarHandler({ fetchImpl });
  const url = env.KV_REST_API_URL || env.EU_UI_OSINT_REDIS_URL;
  const token = env.KV_REST_API_TOKEN || env.EU_UI_OSINT_REDIS_TOKEN;
  const store = url && token ? createRedisSignalStore({ url, token, prefix: "flight-sim:signal:", fetchImpl }) : serverless ? null : createMemorySignalStore();
  const signal = createSignalHandler({ store, anyOrigin: dev, notConfigured: "Set KV_REST_API_URL and KV_REST_API_TOKEN to enable multiplayer on this deployment." });
  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // Trunk forwards /api to :5197 while its page runs on :5198. Allow only those local dev origins.
    if (dev && req.headers.origin && !["http://127.0.0.1:5198", "http://localhost:5198", `http://${req.headers.host}`].includes(req.headers.origin)) {
      return json(res, 403, { error: "Origin not allowed." });
    }
    if (/^\/api\/(?:marketing\/)?tiles\/ion\//.test(path)) {
      req.url = req.url.replace("/api/marketing/tiles/ion/", "/api/tiles/ion/");
      return ion(req, res);
    }
    if (path === "/api/sim/metar") return metar(req, res);
    if (path === "/api/sim/signal" || path.startsWith("/api/sim/signal/")) return signal(req, res);
    return json(res, 404, { error: "Not found" });
  };
}
