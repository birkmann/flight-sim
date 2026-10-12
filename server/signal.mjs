// Sandbox sessions over WebRTC: the browsers talk to each other directly (data channels), and this only passes
// the connection handshakes between them. It needs no long-lived connection, so it runs as Vercel functions too,
// where the rooms' WebSockets (rooms.mjs) can't: the handshakes wait in a shared store (Upstash-compatible Redis
// over REST) until the other side polls for them. A single server may keep them in memory.
//
//   POST /api/sim/signal                       -> { id, code, hostToken }             (host a session)
//   POST /api/sim/signal/:id/offer              { code, peer, sdp } -> 202              (a guest's offer)
//   GET  /api/sim/signal/:id/offers?token=…     -> { offers: [{ peer, sdp }] }          (the host collects them)
//   POST /api/sim/signal/:id/answer             { token, peer, sdp } -> 202             (the host's answer)
//   GET  /api/sim/signal/:id/answer?peer=…&code=… -> { sdp } or 204                     (the guest collects it)
//
// Same origin only, rate-limited per address, bounded bodies; sessions expire after six hours, handshakes after two
// minutes.
import { randomBytes, timingSafeEqual } from "node:crypto";

import { json } from "./handler.mjs";

const SESSION_TTL_S = 6 * 3600;
const HANDSHAKE_TTL_S = 120;
const MAX_BODY = 24_000;
const MAX_SDP = 16_000;
const PEER = /^[a-f0-9]{8,32}$/;
const ID = /^[a-f0-9]{10}$/;

/**
 * @typedef {object} SignalStore
 * @property {(key: string, value: string, ttl: number) => Promise<void>} set
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string) => Promise<string | null>} take   Get and delete.
 * @property {(key: string, value: string, ttl: number) => Promise<void>} push
 * @property {(key: string, max: number) => Promise<string[]>} drain  Pop up to `max` from the front.
 */

/** One process's memory (the standalone server, the dev server, tests). @returns {SignalStore} */
export function createMemorySignalStore() {
  /** @type {Map<string, { value: string | string[]; until: number }>} */
  const m = new Map();
  const live = (/** @type {string} */ k) => {
    const e = m.get(k);
    if (e && e.until < Date.now()) m.delete(k);
    return m.get(k);
  };
  const sweep = () => {
    const now = Date.now();
    for (const [k, e] of m) if (e.until < now) m.delete(k);
  };
  return {
    set: async (k, value, ttl) => (sweep(), void m.set(k, { value, until: Date.now() + ttl * 1000 })),
    get: async (k) => {
      const e = live(k);
      return typeof e?.value === "string" ? e.value : null;
    },
    take: async (k) => {
      const e = live(k);
      m.delete(k);
      return typeof e?.value === "string" ? e.value : null;
    },
    push: async (k, value, ttl) => {
      const e = live(k);
      const list = Array.isArray(e?.value) ? e.value : [];
      list.push(value);
      m.set(k, { value: list, until: Date.now() + ttl * 1000 });
    },
    drain: async (k, max) => {
      const e = live(k);
      return Array.isArray(e?.value) ? e.value.splice(0, max) : [];
    },
  };
}

/**
 * Upstash-compatible Redis over REST, as osint-store.mjs uses it (Vercel's Upstash integration provisions it).
 * @param {{ url: string; token: string; prefix?: string; fetchImpl?: typeof fetch }} opts
 * @returns {SignalStore}
 */
export function createRedisSignalStore(opts) {
  const base = opts.url.replace(/\/+$/, "");
  const prefix = opts.prefix ?? "eu-ui:signal:";
  const fetchImpl = opts.fetchImpl ?? fetch;
  /** @param {unknown[][]} commands @returns {Promise<any[]>} */
  const pipeline = async (commands) => {
    const res = await fetchImpl(`${base}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" }, body: JSON.stringify(commands) });
    if (!res.ok) throw new Error(`Redis responded ${res.status}`);
    const out = /** @type {Array<{ result?: unknown; error?: string }>} */ (await res.json());
    return out.map((r) => {
      if (r.error) throw new Error(`Redis: ${r.error}`);
      return r.result;
    });
  };
  const key = (/** @type {string} */ k) => prefix + k;
  return {
    set: async (k, value, ttl) => void (await pipeline([["SET", key(k), value, "EX", ttl]])),
    get: async (k) => /** @type {string | null} */ ((await pipeline([["GET", key(k)]]))[0] ?? null),
    take: async (k) => /** @type {string | null} */ ((await pipeline([["GETDEL", key(k)]]))[0] ?? null),
    push: async (k, value, ttl) => void (await pipeline([["RPUSH", key(k), value], ["EXPIRE", key(k), ttl]])),
    drain: async (k, max) => {
      const r = (await pipeline([["LPOP", key(k), max]]))[0];
      return Array.isArray(r) ? r : typeof r === "string" ? [r] : [];
    },
  };
}

/** @param {string} a @param {string} b */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * @param {{ store: SignalStore | null; clientAddress?: (req: import("node:http").IncomingMessage) => string; notConfigured?: string; anyOrigin?: boolean }} opts
 *   Without a store the routes answer 503 with `notConfigured`. `anyOrigin` skips the same-origin check, for a
 *   local dev server behind a proxy that rewrites the Host header.
 * @returns {(req: import("node:http").IncomingMessage & { body?: unknown }, res: import("node:http").ServerResponse) => Promise<void>}
 */
export function createSignalHandler(opts) {
  const { store } = opts;
  const address = opts.clientAddress ?? ((req) => req.socket?.remoteAddress ?? "unknown");
  /** @type {Map<string, { at: number; count: number }>} */
  const buckets = new Map();

  /** @param {import("node:http").IncomingMessage & { body?: unknown }} req @returns {Promise<any>} */
  const readBody = async (req) => {
    if (req.body !== undefined) {
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (Buffer.byteLength(raw) > MAX_BODY) throw new Error("too large");
      return JSON.parse(raw);
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("too large");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };
  /** @param {string} id @returns {Promise<{ code: string; token: string } | null>} */
  const session = async (id) => {
    if (!ID.test(id) || !store) return null;
    try {
      return JSON.parse((await store.get(`s:${id}`)) ?? "null");
    } catch {
      return null;
    }
  };
  const sdpOf = (/** @type {any} */ b) => (typeof b?.sdp === "string" && b.sdp.length > 0 && b.sdp.length <= MAX_SDP ? b.sdp : null);

  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && !opts.anyOrigin) {
      try {
        if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: "Origin not allowed." });
      } catch {
        return json(res, 403, { error: "Origin not allowed." });
      }
    }
    if (!store) return json(res, 503, { error: opts.notConfigured ?? "Sessions are not configured for this deployment." });
    // Polling is part of it (the host every 1.5 s, a guest joining every 0.7 s), so the limit is generous.
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.at > 60_000) buckets.delete(k);
    const ip = address(req);
    const bucket = buckets.get(ip) ?? { at: now, count: 0 };
    if (++bucket.count > 240 || buckets.size > 5000) return json(res, 429, { error: "Too many requests. Please wait a minute." });
    buckets.set(ip, bucket);

    const url = new URL(req.url ?? "/", "http://signal.local");
    const parts = url.pathname.replace(/^\/api\/sim\/signal\/?/, "").split("/").filter(Boolean);
    try {
      if (parts.length === 0) {
        if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
        const id = randomBytes(5).toString("hex");
        const code = randomBytes(3).toString("hex").toUpperCase().slice(0, 5);
        const hostToken = randomBytes(16).toString("hex");
        await store.set(`s:${id}`, JSON.stringify({ code, token: hostToken }), SESSION_TTL_S);
        return json(res, 201, { id, code, hostToken });
      }
      const [id = "", what] = parts;
      const s = await session(id);
      if (!s) return json(res, 404, { error: "No such session (it may have ended)." });
      if (what === "offer" && req.method === "POST") {
        const b = await readBody(req);
        const sdp = sdpOf(b);
        if (typeof b?.code !== "string" || !same(b.code.toUpperCase(), s.code)) return json(res, 403, { error: "Wrong session code." });
        if (typeof b?.peer !== "string" || !PEER.test(b.peer) || !sdp) return json(res, 400, { error: "Invalid offer." });
        await store.push(`o:${id}`, JSON.stringify({ peer: b.peer, sdp }), HANDSHAKE_TTL_S);
        return json(res, 202, { ok: true });
      }
      if (what === "offers" && req.method === "GET") {
        if (!same(url.searchParams.get("token") ?? "", s.token)) return json(res, 403, { error: "Not the host." });
        const offers = (await store.drain(`o:${id}`, 20)).flatMap((raw) => {
          try {
            return [JSON.parse(raw)];
          } catch {
            return [];
          }
        });
        return json(res, 200, { offers });
      }
      if (what === "answer" && req.method === "POST") {
        const b = await readBody(req);
        const sdp = sdpOf(b);
        if (typeof b?.token !== "string" || !same(b.token, s.token)) return json(res, 403, { error: "Not the host." });
        if (typeof b?.peer !== "string" || !PEER.test(b.peer) || !sdp) return json(res, 400, { error: "Invalid answer." });
        await store.set(`a:${id}:${b.peer}`, sdp, HANDSHAKE_TTL_S);
        return json(res, 202, { ok: true });
      }
      if (what === "answer" && req.method === "GET") {
        const peer = url.searchParams.get("peer") ?? "";
        if (!same((url.searchParams.get("code") ?? "").toUpperCase(), s.code)) return json(res, 403, { error: "Wrong session code." });
        if (!PEER.test(peer)) return json(res, 400, { error: "Invalid peer." });
        const sdp = await store.take(`a:${id}:${peer}`);
        if (!sdp) return void res.writeHead(204).end();
        return json(res, 200, { sdp });
      }
      return json(res, 404, { error: "Not found." });
    } catch (e) {
      if (e instanceof SyntaxError || (e instanceof Error && e.message === "too large")) return json(res, 400, { error: "Invalid request." });
      return json(res, 502, { error: "The session store did not answer." });
    }
  };
}
