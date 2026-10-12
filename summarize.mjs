// Turns saved `window.__bench` results (<engine>-<units>.json) into the README's markdown tables.
// Usage: node summarize.mjs <results-dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node summarize.mjs <results-dir>");
const runs = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .sort((a, b) => a.units - b.units || a.engine.localeCompare(b.engine));

const s = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(1));
const leg = (r, name) => r.legs.find((l) => l.leg === name) ?? {};
const moving = (r, key) => ["orbit", "fly", "pullout"].map((n) => leg(r, n)[key] ?? "–").join(" / ");

console.log("| units | engine | cold start → first frame (s) | first tile on screen (s) | load leg settled after (s) | fps avg (orbit / fly / pullout) | 1% low fps (orbit / fly / pullout) | frames > 33 ms (total) | long tasks (ms, total) | tiles added | tile MB | JS heap MB | engine MB |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const t = r.total ?? {};
  console.log(
    `| ${r.units} | ${r.engine} | ${s(r.coldStartMs)} | ${s(r.firstTileMs)} | ${leg(r, "load").settledS ?? "not settled"} | ${moving(r, "fpsAvg")} | ${moving(r, "fps1Low")} | ${t.over33Ms} | ${t.longTaskMs} | ${t.tilesAdded} | ${t.tileMB} | ${r.jsHeapMB} | ${r.engineMemoryMB} |`,
  );
}
