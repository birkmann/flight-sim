#!/usr/bin/env node
// Builds the flight planner's airport and navaid tables from OurAirports (public domain,
// https://ourairports.com/data/). The CSVs are large and loosely curated, so this keeps only large and
// medium airports with at least one paved runway of 1200 m or more, repairs the runway geometry the sim
// depends on (threshold positions, true headings, reciprocal ends) and writes two compact, minified
// JSON files into assets/data/. Rows are positional arrays rather than objects to keep the download small;
// the column order is documented next to each writer below.
//
//   node tools/airports.mjs            download fresh CSVs (cached in tools/.cache/) and rebuild the JSON
//   node tools/airports.mjs --offline  reuse the cached CSVs when present instead of downloading
//   node tools/airports.mjs --check    sanity-check the generated JSON (no network needed)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".cache");
const OUT = join(HERE, "..", "assets", "data");
const AIRPORTS_JSON = join(OUT, "airports.json");
const NAVAIDS_JSON = join(OUT, "navaids.json");
const BASE = "https://davidmegginson.github.io/ourairports-data/";
const FILES = ["airports.csv", "runways.csv", "navaids.csv", "airport-frequencies.csv"];

const R = 6371000; // spherical Earth, metres
const FT = 0.3048;
const MIN_LENGTH_FT = 3900; // 1200 m
const MAX_FREQS = 8;
// A runway whose midpoint lies further than this from its airport's reference point is bad data.
const MAX_OFFSET_M = 20000;

const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------------------
// Download and parse.

async function load(name) {
  const path = join(CACHE, name);
  if (args.has("--offline") && existsSync(path)) return readFileSync(path, "utf8");
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`GET ${BASE + name}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, text);
  return text;
}

// RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. Returns an array of objects
// keyed by the header row.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const num = (s) => (s === undefined || s.trim() === "" ? NaN : Number(s));
const known = (x) => Number.isFinite(x);

// ---------------------------------------------------------------------------------------------------------
// Spherical geometry (degrees in, degrees out).

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(deg(Math.atan2(y, x)));
}

function destination(lat, lon, hdg, metres) {
  const p1 = rad(lat);
  const l1 = rad(lon);
  const th = rad(hdg);
  const d = metres / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

// ---------------------------------------------------------------------------------------------------------
// Runways.

// Paved surfaces: asphalt, concrete, bitumen, porous European mix and plain "paved", in the many spellings
// the data uses (ASP, ASPH-G, Asphalt, CONC-TURF, BIT, PEM, PAVED, ...).
const HARD = /^\s*(asp|con|bit|pem|pav)/i;

const stats = { kept: 0, derivedOne: 0, derivedBoth: 0, endRecomputed: 0, headingMissing: 0, headingCorrected: 0,
  reciprocalFixed: 0, droppedNoGeometry: 0, droppedBadLength: 0, droppedFarAway: 0 };

// Turns one runways.csv row into the output tuple, or null when it is unusable or unrepairable.
function runway(r, ap) {
  if (r.closed === "1") return null;
  if (!HARD.test(r.surface)) return null;
  const lengthFt = num(r.length_ft);
  if (!(lengthFt >= MIN_LENGTH_FT)) return null;
  const lengthM = lengthFt * FT;

  let le = [num(r.le_latitude_deg), num(r.le_longitude_deg)];
  let he = [num(r.he_latitude_deg), num(r.he_longitude_deg)];
  const leKnown = known(le[0]) && known(le[1]);
  const heKnown = known(he[0]) && known(he[1]);
  let leHdg = num(r.le_heading_degT);
  let heHdg = num(r.he_heading_degT);
  // A heading on either end gives the runway's axis.
  if (!known(leHdg) && known(heHdg)) leHdg = norm360(heHdg + 180);

  if (leKnown && heKnown) {
    const d = distance(le[0], le[1], he[0], he[1]);
    if (Math.abs(d - lengthM) > 0.25 * lengthM) {
      // The ends disagree with the published length (usually stale positions after an extension, sometimes
      // both ends on one point). Trust the low end and its heading, unless the low end is the one that is
      // nowhere near the airport.
      if (!known(leHdg)) {
        stats.droppedBadLength++;
        return null;
      }
      const far = (p) => known(ap.lat) && distance(ap.lat, ap.lon, p[0], p[1]) > lengthM + 5000;
      if (far(le) && !far(he)) le = destination(he[0], he[1], leHdg + 180, lengthM);
      else he = destination(le[0], le[1], leHdg, lengthM);
      stats.endRecomputed++;
    }
  } else if (leKnown || heKnown) {
    if (!known(leHdg)) {
      stats.droppedNoGeometry++;
      return null;
    }
    if (leKnown) he = destination(le[0], le[1], leHdg, lengthM);
    else le = destination(he[0], he[1], leHdg + 180, lengthM);
    stats.derivedOne++;
  } else {
    if (!known(leHdg) || !known(ap.lat) || !known(ap.lon)) {
      stats.droppedNoGeometry++;
      return null;
    }
    le = destination(ap.lat, ap.lon, leHdg + 180, lengthM / 2);
    he = destination(ap.lat, ap.lon, leHdg, lengthM / 2);
    stats.derivedBoth++;
  }

  // The thresholds are final now, so the headings come from them: published headings are whole degrees at
  // best and sometimes magnetic, while the sim wants the axis the runway is actually drawn along.
  const leTrue = bearing(le[0], le[1], he[0], he[1]);
  if (!known(leHdg)) stats.headingMissing++;
  else if (angleDiff(leHdg, leTrue) > 1) stats.headingCorrected++;
  if (known(heHdg) && angleDiff(heHdg, norm360(leHdg + 180)) > 5) stats.reciprocalFixed++;
  leHdg = leTrue;
  heHdg = bearing(he[0], he[1], le[0], le[1]);

  if (known(ap.lat)) {
    const mid = destination(le[0], le[1], leHdg, lengthM / 2);
    if (distance(ap.lat, ap.lon, mid[0], mid[1]) > MAX_OFFSET_M) {
      stats.droppedFarAway++;
      return null;
    }
  }

  const elev = (s) => Math.round(known(num(s)) ? num(s) : ap.elev);
  const disp = (s) => Math.round(known(num(s)) ? num(s) : 0);
  const width = num(r.width_ft);
  stats.kept++;
  return [
    r.le_ident.trim(),
    r.he_ident.trim(),
    Math.round(lengthFt),
    Math.round(known(width) && width > 0 ? width : 150),
    1,
    r.lighted === "1" ? 1 : 0,
    round6(le[0]),
    round6(le[1]),
    elev(r.le_elevation_ft),
    round1(norm360(leHdg)),
    disp(r.le_displaced_threshold_ft),
    round6(he[0]),
    round6(he[1]),
    elev(r.he_elevation_ft),
    round1(norm360(heHdg)),
    disp(r.he_displaced_threshold_ft),
  ];
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const round1 = (x) => {
  const r = Math.round(x * 10) / 10;
  return r >= 360 ? r - 360 : r;
};

// ---------------------------------------------------------------------------------------------------------
// Frequencies. Types are upper-cased and a few synonyms folded together; the most useful ones for a pilot
// come first so the per-airport cap drops the long tail (MISC, PMSV, OPS, ...).

const FREQ_ALIAS = { CNTR: "CTR", ACC: "CTR", CLD: "DEL", UNICOM: "UNIC", RADIO: "RDO" };
const FREQ_ORDER = ["ATIS", "DEL", "GND", "TWR", "APP", "DEP", "CTR", "AFIS", "A/D", "CTAF", "UNIC", "INFO", "RDO"];
const freqRank = (t) => {
  const i = FREQ_ORDER.indexOf(t);
  return i < 0 ? FREQ_ORDER.length : i;
};

// ---------------------------------------------------------------------------------------------------------
// Build.

async function build() {
  const [airportsCsv, runwaysCsv, navaidsCsv, freqsCsv] = await Promise.all(FILES.map(load));

  const runwaysBy = new Map();
  for (const r of parseCsv(runwaysCsv)) {
    const list = runwaysBy.get(r.airport_ident) ?? [];
    list.push(r);
    runwaysBy.set(r.airport_ident, list);
  }

  const freqsBy = new Map();
  for (const f of parseCsv(freqsCsv)) {
    const mhz = num(f.frequency_mhz);
    if (!(mhz > 0)) continue;
    let type = f.type.trim().toUpperCase();
    type = FREQ_ALIAS[type] ?? type;
    if (!type) continue;
    const list = freqsBy.get(f.airport_ident) ?? [];
    list.push([type, Math.round(mhz * 1000) / 1000]);
    freqsBy.set(f.airport_ident, list);
  }

  const airports = [];
  let candidates = 0;
  let freqsCut = 0;
  for (const a of parseCsv(airportsCsv)) {
    const type = a.type === "large_airport" ? 1 : a.type === "medium_airport" ? 2 : 0;
    if (!type) continue;
    candidates++;
    const ap = { lat: num(a.latitude_deg), lon: num(a.longitude_deg), elev: num(a.elevation_ft) };
    if (!known(ap.elev)) ap.elev = 0;
    const runways = (runwaysBy.get(a.ident) ?? []).map((r) => runway(r, ap)).filter(Boolean);
    if (!runways.length || !known(ap.lat) || !known(ap.lon)) continue;

    const seen = new Set();
    const freqs = (freqsBy.get(a.ident) ?? [])
      .filter(([t, m]) => {
        const key = `${t} ${m}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((x, y) => freqRank(x[0]) - freqRank(y[0]) || x[1] - y[1]);
    if (freqs.length > MAX_FREQS) freqsCut += freqs.length - MAX_FREQS;

    // Airport columns: ident, iata, name, municipality, iso_country, lat, lon, elev_ft, type (1 large,
    // 2 medium), runways, freqs ([type, mhz] pairs). Runway columns: le_ident, he_ident, length_ft, width_ft,
    // surface (1 paved), lighted, then lat, lon, elev_ft, true heading and displaced threshold (ft) for the
    // low end and again for the high end.
    airports.push([
      a.ident,
      a.iata_code.trim(),
      a.name.trim(),
      a.municipality.trim(),
      a.iso_country,
      round6(ap.lat),
      round6(ap.lon),
      Math.round(ap.elev),
      type,
      runways,
      freqs.slice(0, MAX_FREQS),
    ]);
  }
  airports.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  // Navaid columns: ident, name, type, lat, lon, freq_khz, elev_ft, iso_country.
  const NAV_TYPES = { VOR: 1, "VOR-DME": 2, VORTAC: 3, NDB: 4, "NDB-DME": 5, DME: 6, TACAN: 7 };
  const navaids = [];
  for (const n of parseCsv(navaidsCsv)) {
    const type = NAV_TYPES[n.type];
    const lat = num(n.latitude_deg);
    const lon = num(n.longitude_deg);
    if (!type || !known(lat) || !known(lon)) continue;
    const khz = num(n.frequency_khz);
    const elev = num(n.elevation_ft);
    navaids.push([
      n.ident.trim(),
      n.name.trim(),
      type,
      round6(lat),
      round6(lon),
      known(khz) ? Math.round(khz) : 0,
      known(elev) ? Math.round(elev) : 0,
      n.iso_country,
    ]);
  }
  navaids.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0) || x[7].localeCompare(y[7]));

  mkdirSync(OUT, { recursive: true });
  const airportsText = JSON.stringify({ v: 1, src: "OurAirports (public domain)", airports });
  const navaidsText = JSON.stringify({ v: 1, navaids });
  writeFileSync(AIRPORTS_JSON, airportsText);
  writeFileSync(NAVAIDS_JSON, navaidsText);

  const runwayCount = airports.reduce((n, a) => n + a[9].length, 0);
  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB raw, ${(gzipSync(s).length / 1024).toFixed(0)} KB gzip`;
  console.log(`airports.json: ${airports.length} airports (of ${candidates} large/medium), ${runwayCount} runways, ` +
    `${airports.reduce((n, a) => n + a[10].length, 0)} frequencies (${freqsCut} over the cap of ${MAX_FREQS} dropped); ${kb(airportsText)}`);
  console.log(`navaids.json: ${navaids.length} navaids; ${kb(navaidsText)}`);
  console.log("runway repairs:", JSON.stringify(stats));
}

// ---------------------------------------------------------------------------------------------------------
// Check. Spot-checks well-known airports and re-validates every runway's geometry.

function check() {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  let data;
  try {
    data = JSON.parse(readFileSync(AIRPORTS_JSON, "utf8"));
    JSON.parse(readFileSync(NAVAIDS_JSON, "utf8"));
  } catch (e) {
    console.error(`check failed: cannot read the generated JSON (${e.message}); run without --check first`);
    return false;
  }
  const byIdent = new Map(data.airports.map((a) => [a[0], a]));
  const findRunway = (ap, le, he) => ap[9].find((r) => (r[0] === le && r[1] === he) || (r[0] === he && r[1] === le));
  const expect = (ident, pairs) => {
    const ap = byIdent.get(ident);
    if (!ap) return fail(`${ident} is missing`);
    for (const [le, he] of pairs) if (!findRunway(ap, le, he)) fail(`${ident} has no runway ${le}/${he}`);
    return ap;
  };

  // BER renamed its runways from 07/25 to 06/24 as the magnetic variation grew; accept either name.
  const eddb = byIdent.get("EDDB");
  if (!eddb) fail("EDDB is missing");
  else {
    const either = (a, b) => findRunway(eddb, ...a) ?? findRunway(eddb, ...b);
    const north = either(["07L", "25R"], ["06L", "24R"]);
    const south = either(["07R", "25L"], ["06R", "24L"]);
    if (!north) fail("EDDB has no runway 07L/25R (or 06L/24R)");
    if (!south) fail("EDDB has no runway 07R/25L (or 06R/24L)");
    const hdg = north && (/^2/.test(north[1]) ? north[14] : north[9]);
    if (north && !(hdg >= 247 && hdg <= 249)) fail(`EDDB 25R/24R true heading is ${hdg}, expected 247-249`);
  }
  expect("EGLL", [["09L", "27R"], ["09R", "27L"]]);
  expect("KJFK", [["04L", "22R"], ["13R", "31L"]]);
  expect("RJTT", []);
  expect("YSSY", []);
  expect("EDDH", [["05", "23"], ["15", "33"]]);

  let runways = 0;
  for (const ap of data.airports) {
    for (const r of ap[9]) {
      runways++;
      const name = `${ap[0]} ${r[0]}/${r[1]}`;
      const d = distance(r[6], r[7], r[11], r[12]);
      const len = r[2] * FT;
      if (Math.abs(d - len) > 0.25 * len) fail(`${name}: thresholds ${d.toFixed(0)} m apart, length ${len.toFixed(0)} m`);
      const off = angleDiff(r[9], norm360(r[14] + 180));
      if (off > 2) fail(`${name}: headings ${r[9]} and ${r[14]} are ${off.toFixed(1)} degrees off reciprocal`);
    }
  }

  if (failures.length) {
    console.error(`check failed (${failures.length}):\n  ${failures.slice(0, 50).join("\n  ")}`);
    return false;
  }
  console.log(`check passed: ${data.airports.length} airports, ${runways} runways`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------

if (args.has("--check")) process.exit(check() ? 0 : 1);
await build();
