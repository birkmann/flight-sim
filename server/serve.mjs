import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiHandler } from "./api.mjs";
import { json } from "./handler.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary", ".css": "text/css; charset=utf-8",
};

export function createApp(options = {}) {
  const api = createApiHandler(options);
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) return await api(req, res);
      if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "GET or HEAD only" });
      let relative;
      try { relative = decodeURIComponent(url.pathname.slice(1)); }
      catch { return json(res, 400, { error: "Invalid path" }); }
      if (relative.split(/[\\/]/).some((part) => part.startsWith(".")) || relative.includes("\0")) {
        return json(res, 403, { error: "Invalid path" });
      }
      const assets = relative.startsWith("assets/");
      const root = resolve(ROOT, assets ? "bevy/assets" : "prebuilt");
      const file = resolve(root, assets ? relative.slice(7) : relative || "index.html");
      if (!file.startsWith(root + sep)) return json(res, 403, { error: "Invalid path" });
      let info;
      try { info = await stat(file); } catch { return json(res, 404, { error: "Not found" }); }
      if (!info.isFile()) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": info.size, "cache-control": "no-cache" });
      if (req.method === "HEAD") return res.end();
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      console.error(error.message);
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: "Server error" });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dev = process.argv.includes("--dev");
  const port = Number(process.env.PORT || 5197);
  const host = process.env.HOST || "127.0.0.1";
  createServer(createApp({ dev })).listen(port, host, () => {
    console.log(`Flight Simulator: http://${host}:${port}/`);
    if (!process.env.CESIUM_API_KEY && !process.env.CESIUM_ION_TOKEN) console.log("Terrain requires CESIUM_ION_TOKEN in .env (see .env.example).");
  });
}
