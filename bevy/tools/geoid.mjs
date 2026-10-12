// Builds `src/geoid_egm96.bin`, the coarse EGM96 geoid grid behind `src/geoid.rs`.
// The source is GeographicLib's 5-arcminute EGM96 grid (egm96-5.pgm, public domain, from NGA's EGM96 model),
// downloaded once into tools/.cache/. The output is point samples every STEP degrees, lat 90..-90 (rows, north
// first) by lon 0..360-STEP (columns, east), as signed bytes in whole metres (EGM96 spans about -107..+86 m).
// 1° (65 KB) rather than 2° (16 KB): the 2° grid is off by 6 m over New Guinea and by more than 4 m over 1% of the
// globe; at 1° that is 0.09% (steep bumps over trenches and around Hawaii; `node tools/geoid.mjs 2 --dry` compares).
// It then measures the error of bilinear interpolation on that grid against every node of the source grid, and
// prints the full-resolution values at a few places for the Rust tests.
// Usage: node tools/geoid.mjs [step-degrees, default 1] [--dry] (--dry: report only, write nothing)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, ".cache");
const out = join(here, "../src/geoid_egm96.bin");
const URL = "https://sourceforge.net/projects/geographiclib/files/geoids-distrib/egm96-5.tar.bz2/download";
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const STEP = Number(args.find((a) => !a.startsWith("--")) ?? 1);
if (!(STEP > 0) || (180 / STEP) % 1 || (360 / STEP) % 1) throw new Error(`step must divide 180: ${STEP}`);

// --- source grid ---------------------------------------------------------------------------------------------
mkdirSync(cache, { recursive: true });
const tarball = join(cache, "egm96-5.tar.bz2");
const pgmPath = join(cache, "geoids/egm96-5.pgm");
if (!existsSync(pgmPath)) {
  if (!existsSync(tarball)) {
    console.log(`downloading ${URL}`);
    // SourceForge hands browsers an HTML countdown page; a non-browser agent gets the file via redirects.
    const res = await fetch(URL, { headers: { "user-agent": "curl/8" }, redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 3).toString() !== "BZh") throw new Error("download is not a bzip2 archive");
    writeFileSync(tarball, buf);
  }
  execFileSync("tar", ["-xjf", tarball, "-C", cache, "geoids/egm96-5.pgm"]);
}

const pgm = readFileSync(pgmPath);
// Header: "P5", "# Key value" comment lines (Offset, Scale), "width height", "maxval", then big-endian u16 samples.
let pos = 0;
const line = () => {
  const end = pgm.indexOf(10, pos);
  const s = pgm.subarray(pos, end).toString("latin1");
  pos = end + 1;
  return s;
};
if (line() !== "P5") throw new Error("not a binary PGM");
const meta = {};
let dims;
for (;;) {
  const l = line();
  if (l.startsWith("#")) {
    const [, k, v] = l.match(/^#\s*(\S+)\s+(.*)$/) ?? [];
    if (k) meta[k] = v;
  } else if (!dims) dims = l.split(/\s+/).map(Number);
  else break; // maxval
}
const [W, H] = dims;
const offset = Number(meta.Offset);
const scale = Number(meta.Scale);
if (W !== 4320 || H !== 2161 || !Number.isFinite(offset) || !Number.isFinite(scale)) {
  throw new Error(`unexpected grid ${W}x${H} offset ${offset} scale ${scale}`);
}
const RES = 360 / W; // degrees per source cell (5')
const src = (row, col) => offset + scale * pgm.readUInt16BE(pos + 2 * (row * W + col));

/** Bilinear on a north-first, lon-0-first grid of `rows` x `cols` nodes `step` degrees apart. */
const bilinear = (get, rows, cols, step, lat, lon) => {
  const r = Math.min(Math.max((90 - lat) / step, 0), rows - 1);
  const c = ((((lon % 360) + 360) % 360) / step) % cols;
  const r0 = Math.min(Math.floor(r), rows - 2);
  const c0 = Math.floor(c);
  const c1 = (c0 + 1) % cols;
  const fr = r - r0;
  const fc = c - c0;
  const n = get(r0, c0) * (1 - fc) + get(r0, c1) * fc;
  const s = get(r0 + 1, c0) * (1 - fc) + get(r0 + 1, c1) * fc;
  return n * (1 - fr) + s * fr;
};
const truth = (lat, lon) => bilinear(src, H, W, RES, lat, lon);

// --- coarse grid ---------------------------------------------------------------------------------------------
const rows = 180 / STEP + 1;
const cols = 360 / STEP;
const k = Math.round(STEP / RES);
const grid = new Int8Array(rows * cols);
let lo = Infinity;
let hi = -Infinity;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const v = src(r * k, c * k);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    grid[r * cols + c] = Math.round(v);
  }
}
const coarse = (r, c) => grid[r * cols + c];

// --- error of the coarse grid against every source node -------------------------------------------------------
let max = 0;
let at = null;
let sq = 0;
let n = 0;
const hist = [1, 2, 4, 8];
const over = hist.map(() => 0);
for (let r = 0; r < H; r++) {
  const lat = 90 - r * RES;
  for (let c = 0; c < W; c++) {
    const lon = c * RES;
    const e = Math.abs(bilinear(coarse, rows, cols, STEP, lat, lon) - src(r, c));
    sq += e * e;
    n++;
    hist.forEach((t, i) => (over[i] += e > t));
    if (e > max) [max, at] = [e, [lat, lon]];
  }
}

console.log(`source: egm96-5.pgm ${W}x${H}, offset ${offset}, scale ${scale}; sampled values ${lo.toFixed(2)}..${hi.toFixed(2)} m`);
console.log(`grid: ${STEP}° -> ${rows} x ${cols} = ${grid.length} bytes`);
console.log(
  `bilinear error vs all ${n} source nodes: max ${max.toFixed(2)} m at (${at[0].toFixed(3)}, ${at[1].toFixed(3)}), ` +
    `RMS ${Math.sqrt(sq / n).toFixed(2)} m; ` +
    hist.map((t, i) => `>${t} m: ${((100 * over[i]) / n).toFixed(2)}%`).join(", "),
);

const places = [
  ["berlin", 52.5, 13.4],
  ["hamburg", 53.63, 9.99],
  ["heathrow", 51.47, -0.45],
  ["jfk", 40.64, -73.78],
  ["sfo", 37.62, -122.38],
  ["haneda", 35.55, 139.78],
  ["sydney", -33.95, 151.18],
  ["denver", 39.86, -104.67],
  ["india_low", 5, 78],
  ["new_guinea_high", -5, 145],
];
console.log("\nplace             lat      lon     egm96 (5')  grid    diff");
for (const [name, lat, lon] of places) {
  const t = truth(lat, lon);
  const g = bilinear(coarse, rows, cols, STEP, lat, lon);
  console.log(
    `${name.padEnd(16)} ${String(lat).padStart(6)} ${String(lon).padStart(8)}  ${t.toFixed(2).padStart(9)}  ${g.toFixed(2).padStart(7)}  ${(g - t).toFixed(2).padStart(6)}`,
  );
}

if (!dry) {
  writeFileSync(out, grid);
  console.log(`\nwrote ${out}`);
}
