import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../serve.mjs";

async function serve(t, options = {}) {
  const server = createServer(createApp({ env: {}, ...options }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}

const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("serves the complete browser bundle and every runtime asset", async (t) => {
  const call = await serve(t);
  const root = await call("/?bench", { redirect: "manual" });
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("location"), null);
  const page = await call("/");
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Flight Simulator/);
  const files = await readdir(new URL("../../prebuilt/", import.meta.url));
  const assets = await readdir(new URL("../../bevy/assets/", import.meta.url), { recursive: true, withFileTypes: true });
  for (const file of files) {
    const res = await call(`/${file}`, { method: "HEAD" });
    assert.equal(res.status, 200, file);
    if (file.endsWith(".wasm")) assert.equal(res.headers.get("content-type"), "application/wasm");
  }
  const assetRoot = new URL("../../bevy/assets/", import.meta.url).pathname;
  for (const file of assets.filter((entry) => entry.isFile())) {
    const path = `${file.parentPath}/${file.name}`.slice(assetRoot.length);
    assert.equal((await call(`/assets/${path}`, { method: "HEAD" })).status, 200, path);
  }
  const html = await readFile(new URL("../../bevy/index.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<link data-trunk rel="copy-file" href="([^"]+)"/g)) {
    assert.equal((await call(`/${match[1].split("/").at(-1)}`, { method: "HEAD" })).status, 200, match[1]);
  }
});

test("does not serve source, credentials, missing assets, or traversal paths", async (t) => {
  const call = await serve(t);
  for (const path of ["/.env", "/bevy/Cargo.toml", "/server/serve.mjs", "/assets/missing.glb", "/assets/..%2f..%2f.env"]) {
    assert.ok([403, 404].includes((await call(path)).status), path);
  }
  assert.equal((await call("/%FF")).status, 400);
  assert.equal((await call("/", post({}))).status, 405);
});

test("terrain route uses server credentials, restricts assets, and caches endpoints", async (t) => {
  let requests = 0;
  const call = await serve(t, {
    env: { CESIUM_ION_TOKEN: "private-account-token" },
    fetchImpl: async (url, init) => {
      requests++;
      assert.equal(url, "https://api.cesium.com/v1/assets/2275207/endpoint");
      assert.equal(init.headers.authorization, "Bearer private-account-token");
      return Response.json({ externalType: "GOOGLE_3D_TILES", options: { url: "https://tiles.example/root.json" }, attributions: [{ html: "Provider" }] });
    },
  });
  for (let i = 0; i < 2; i++) {
    const res = await call("/api/marketing/tiles/ion/2275207");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, "https://tiles.example/root.json");
    assert.ok(!JSON.stringify(body).includes("private-account-token"));
  }
  assert.equal(requests, 1);
  assert.equal((await call("/api/marketing/tiles/ion/1")).status, 403);
});

test("weather route parses upstream METAR and rejects invalid airport codes", async (t) => {
  const call = await serve(t, { fetchImpl: async () => Response.json([{ icaoId: "EDDB", wdir: 250, wspd: 12, visib: 6, altim: 1009 }]) });
  const res = await call("/api/sim/metar?ids=EDDB");
  assert.equal(res.status, 200);
  const { metars } = await res.json();
  assert.equal(metars[0].windKt, 12);
  assert.equal(metars[0].qnh, 1009);
  assert.equal((await call("/api/sim/metar?ids=invalid")).status, 400);
});

test("multiplayer completes the offer/answer handshake and enforces origin checks", async (t) => {
  const call = await serve(t);
  const base = "/api/sim/signal";
  const made = await call(base, post({}));
  assert.equal(made.status, 201);
  const { id, code, hostToken } = await made.json();
  const peer = "abcdef012345";
  assert.equal((await call(`${base}/${id}/offer`, post({ code, peer, sdp: "v=0 offer" }))).status, 202);
  assert.deepEqual(await (await call(`${base}/${id}/offers?token=${hostToken}`)).json(), { offers: [{ peer, sdp: "v=0 offer" }] });
  assert.equal((await call(`${base}/${id}/answer`, post({ token: hostToken, peer, sdp: "v=0 answer" }))).status, 202);
  assert.deepEqual(await (await call(`${base}/${id}/answer?peer=${peer}&code=${code}`)).json(), { sdp: "v=0 answer" });
  assert.equal((await call(base, post({}, { origin: "https://other.example" }))).status, 403);
});

test("development accepts Trunk's origin while serverless requires shared storage", async (t) => {
  const dev = await serve(t, { dev: true });
  assert.equal((await dev("/api/sim/signal", post({}, { origin: "http://127.0.0.1:5198" }))).status, 201);
  assert.equal((await dev("/api/sim/signal", post({}, { origin: "https://other.example" }))).status, 403);
  const hosted = await serve(t, { serverless: true });
  assert.equal((await hosted("/api/sim/signal", post({}))).status, 503);
  assert.equal((await hosted("/api/marketing/tiles/ion/2275207")).status, 503);
  assert.equal((await hosted("/api/unknown")).status, 404);
});
