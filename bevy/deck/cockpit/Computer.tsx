/**
 * LX/Oudie-style colour flight computer: track-up moving map (task, turnpoints, airspaces, thermal
 * hotspots, vario-coloured snail trail) and the navigation boxes a pilot reads on a cross-country task.
 * Drawn in its own unit box; the caller translates/scales it into the panel.
 */
import { memo, useRef, type ReactNode } from "react";
import { AIRFIELD, AIRSPACES, ROUTES, THERMALS, airspaceActive, type LonLat } from "../route";
import type { SimSnapshot } from "../types";
import { clock, de, norm360, signed, type FlightData } from "./flightData";

const RAD = Math.PI / 180;
const M_PER_DEG_LAT = 110_540;

type Proj = (p: LonLat) => [number, number];

function makeProj(lon0: number, lat0: number, trackDeg: number, scale: number, cx: number, cy: number): Proj {
  const kx = 111_320 * Math.cos(lat0 * RAD);
  const c = Math.cos(-trackDeg * RAD);
  const s = Math.sin(-trackDeg * RAD);
  return ([lon, lat]) => {
    const e = (lon - lon0) * kx * scale;
    const n = (lat - lat0) * M_PER_DEG_LAT * scale;
    // rotate so that the track points up (screen y down)
    const x = e * c - n * s;
    const y = e * s + n * c;
    return [Math.round((cx + x) * 10) / 10, Math.round((cy - y) * 10) / 10];
  };
}

const TRAIL_COLORS = ["#8f1d2c", "#e0533d", "#8b93a1", "#9be27a", "#4fd36b", "#e9ff5c"];
function trailBucket(v: number) {
  return v < -2 ? 0 : v < -0.5 ? 1 : v < 0.4 ? 2 : v < 1.4 ? 3 : v < 2.4 ? 4 : 5;
}

function Arrow({ deg, size, color, stroke = "#000" }: { deg: number; size: number; color: string; stroke?: string }) {
  const s = size / 20;
  return (
    <path
      d="M0 -10 L7 6 L0 2.5 L-7 6 Z"
      transform={`rotate(${deg.toFixed(1)}) scale(${s})`}
      fill={color}
      stroke={stroke}
      strokeWidth={0.8 / s}
      strokeLinejoin="round"
    />
  );
}

/** Map pane: w×h at (0,0). */
function MovingMap({ snap, data, w, h, glider = [0.5, 0.66] }: { snap: SimSnapshot; data: FlightData; w: number; h: number; glider?: [number, number] }) {
  const s = snap.state;
  const circling = Math.abs(s.roll) > 0.3 || /kreis/i.test(s.phase);
  // thermal zoom: ~3 km across while circling, ~22 km in cruise; eased between renders
  const zoom = useRef(circling ? w / 3000 : w / 22000);
  const target = circling ? w / 3200 : w / 22000;
  zoom.current += (target - zoom.current) * 0.12;
  const scale = zoom.current;
  const cx = w * glider[0];
  const cy = h * glider[1];
  const P = makeProj(s.lon, s.lat, data.trackDeg, scale, cx, cy);
  const wps = ROUTES[s.route].waypoints;
  const task = wps.map((w) => P(w.at));
  const taskD = task.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("");
  const nextP = P(data.wp.at);

  // snail trail, grouped by colour → ≤ 6 paths
  const paths = ["", "", "", "", "", ""];
  const tr = data.trail;
  for (let i = 1; i < tr.length; i++) {
    const a = P([tr[i - 1]!.lon, tr[i - 1]!.lat]);
    const b = P([tr[i]!.lon, tr[i]!.lat]);
    paths[trailBucket(tr[i]!.vario)] += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
  }
  if (tr.length) {
    const a = P([tr[tr.length - 1]!.lon, tr[tr.length - 1]!.lat]);
    paths[trailBucket(s.vario)] += `M${a[0]} ${a[1]}L${cx} ${cy}`;
  }

  // range ring: a round distance near a third of the map width
  const ringKm = [0.5, 1, 2, 5, 10, 20].find((km) => km * 1000 * scale > w * 0.22) ?? 20;
  const ringR = ringKm * 1000 * scale;
  const windTo = data.wind.fromDeg + 180 - data.trackDeg;
  const northDeg = -data.trackDeg;
  const hour = s.hour;
  return (
    <g>
      <clipPath id="ck-map-clip">
        <rect width={w} height={h} />
      </clipPath>
      <g clipPath="url(#ck-map-clip)">
        <rect width={w} height={h} fill="#0d1d17" />
        <rect width={w} height={h} fill="url(#ck-map-grad)" />
        {AIRSPACES.map((a) => {
          const d = a.poly.map((p, i) => `${i ? "L" : "M"}${P(p).join(" ")}`).join("") + "Z";
          const active = airspaceActive(a, hour);
          const col = a.kind === "restricted" ? "#ff4d5e" : "#5aa9ff";
          return (
            <g key={a.id} opacity={active ? 1 : 0.45}>
              <path d={d} fill={col} fillOpacity={0.1} stroke={col} strokeWidth={a.kind === "restricted" ? 1.6 : 1.1} strokeDasharray={a.kind === "tmz" ? "4 3" : undefined} />
            </g>
          );
        })}
        {THERMALS.map((t, i) => {
          const [x, y] = P(t.at);
          if (x < -10 || y < -10 || x > w + 10 || y > h + 10) return null;
          return (
            <g key={i} transform={`translate(${x} ${y})`} opacity={0.85}>
              <circle r={Math.max(2.4, t.radius * scale)} fill="#ffd23f" fillOpacity={0.16} stroke="#ffd23f" strokeOpacity={0.6} strokeWidth={0.8} />
              <path d="M-3 1 a2.2 2.2 0 0 1 2-3 a2.8 2.8 0 0 1 5 1 a1.8 1.8 0 0 1 0 3.4 h-6.5 a1.7 1.7 0 0 1 -0.5 -1.4z" fill="#fff" opacity={0.85} />
            </g>
          );
        })}
        {paths.map((d, i) => d && <path key={i} d={d} stroke={TRAIL_COLORS[i]} strokeWidth={circling ? 2.6 : 2} strokeLinecap="round" fill="none" />)}
        <path d={taskD} stroke="#ff4fd8" strokeWidth={2.2} fill="none" strokeLinejoin="round" opacity={0.95} />
        {wps.map((w, i) => {
          const [x, y] = task[i]!;
          const r = Math.max(3, w.radius * scale);
          const isNext = i === data.wpIndex;
          return (
            <g key={`${w.id}${i}`}>
              <circle cx={x} cy={y} r={r} fill={isNext ? "#ff4fd8" : "none"} fillOpacity={0.15} stroke="#ff4fd8" strokeWidth={isNext ? 1.6 : 1} />
            </g>
          );
        })}
        {/* airfield */}
        {(() => {
          const [x, y] = P(AIRFIELD.at);
          return (
            <g transform={`translate(${x} ${y})`}>
              <circle r={5.5} fill="none" stroke="#7fd0ff" strokeWidth={1.4} />
              <path d="M-7.5 2.5 L7.5 -2.5" stroke="#7fd0ff" strokeWidth={2.4} transform={`rotate(${northDeg})`} />
            </g>
          );
        })()}
        {/* bearing line to the next waypoint */}
        <path d={`M${cx} ${cy}L${nextP[0]} ${nextP[1]}`} stroke="#fff3a8" strokeWidth={1.2} strokeDasharray="5 3" opacity={0.9} />
        <circle cx={cx} cy={cy} r={ringR} fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={0.8} strokeDasharray="2 3" />
        <text x={cx + ringR * 0.72 + 2} y={cy - ringR * 0.72} fontSize={8.5} fill="#cfe" opacity={0.75}>
          {ringKm < 1 ? `${ringKm * 1000} m` : `${ringKm} km`}
        </text>
        {/* glider symbol: track up */}
        <g transform={`translate(${cx} ${cy}) rotate(${(data.headingDeg - data.trackDeg).toFixed(1)}) scale(0.36)`}>
          <path
            d="M0 -26 C2 -26 2.6 -20 2.6 -12 L2.6 -6 L44 -3.5 L44 0 L2.4 1.5 L1.6 20 L10 21 L10 24 L0 24.6 L-10 24 L-10 21 L-1.6 20 L-2.4 1.5 L-44 0 L-44 -3.5 L-2.6 -6 L-2.6 -12 C-2.6 -20 -2 -26 0 -26 Z"
            fill="#fff"
            stroke="#000"
            strokeWidth={3}
          />
        </g>
        {/* wind widget */}
        <g transform="translate(17 17)">
          <circle r={13} fill="#000" fillOpacity={0.45} stroke="#7fd0ff" strokeOpacity={0.5} strokeWidth={0.8} />
          <Arrow deg={windTo} size={17} color="#7fd0ff" />
        </g>
        <text x={33} y={14} fontSize={8} fill="#7fd0ff" fontWeight={700}>
          {Math.round(data.wind.kmh)}
        </text>
        <text x={33} y={23} fontSize={6.5} fill="#7fd0ff" opacity={0.8}>
          km/h
        </text>
        {/* north arrow */}
        <g transform={`translate(${w - 12} 13) rotate(${northDeg.toFixed(1)})`}>
          <path d="M0 -8 L4 4 L0 1.5 L-4 4 Z" fill="#ff8a3d" />
          <text y={13} fontSize={7} textAnchor="middle" fill="#fff" transform={`rotate(${(-northDeg).toFixed(1)} 0 9)`}>
            N
          </text>
        </g>
      </g>
    </g>
  );
}

const MapGrad = memo(function MapGrad() {
  return (
    <defs>
      <radialGradient id="ck-map-grad" cx="50%" cy="60%" r="75%">
        <stop offset="0" stopColor="#1b3a2a" stopOpacity="0.9" />
        <stop offset="1" stopColor="#081410" stopOpacity="0.9" />
      </radialGradient>
      <linearGradient id="ck-screen-glare" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.13" />
        <stop offset="0.35" stopColor="#fff" stopOpacity="0.03" />
        <stop offset="0.36" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
});

function Field({ x, y, w, h, label, value, unit, color = "#fff", children }: {
  x: number; y: number; w: number; h: number; label: string; value: string; unit?: string; color?: string; children?: ReactNode;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} fill="#0a0f16" stroke="#1d2a38" strokeWidth={0.8} />
      <text x={4} y={9} fontSize={7.4} fill="#8fa3b8" fontWeight={700} letterSpacing={0.4}>
        {label}
      </text>
      <text x={w - 4} y={h - 5} fontSize={h > 26 ? 17 : 15} fontWeight={700} textAnchor="end" fill={color}>
        {value}
        {unit && (
          <tspan fontSize={8} fill="#8fa3b8" dx={2}>
            {unit}
          </tspan>
        )}
      </text>
      {children}
    </g>
  );
}

function fmtLD(ld: number) {
  return !Number.isFinite(ld) || ld > 199 ? "––" : de(ld, 0);
}

/** Full-size unit: case 300 × 232 including the knob strip. */
export function FlightComputer({ snap, data }: { snap: SimSnapshot; data: FlightData }) {
  const s = snap.state;
  const W = 280;
  const H = 178;
  const mapW = 164;
  const top = 20;
  const bottom = 18;
  const mapH = H - top - bottom;
  const fx = mapW;
  const fw = W - mapW;
  const fh = mapH / 6;
  const arrivalCol = data.arrival >= 150 ? "#7dff9c" : data.arrival >= 0 ? "#ffd23f" : "#ff6b5e";
  const ldCol = data.reqLD < 30 ? "#7dff9c" : data.reqLD < 45 ? "#ffd23f" : "#ff6b5e";
  return (
    <g fontFamily="var(--ck-screen-font)">
      <MapGrad />
      {/* case */}
      <rect x={-6} y={-6} width={312} height={244} rx={16} fill="#000" opacity={0.45} transform="translate(3 5)" />
      <rect x={-6} y={-6} width={312} height={244} rx={16} fill="url(#ck-plastic)" stroke="#3d434b" strokeWidth={1.2} />
      <rect x={-5} y={-5} width={310} height={242} rx={15} fill="none" stroke="#fff" strokeOpacity={0.08} strokeWidth={1} />
      <g transform="translate(10 8)">
        <rect x={-2} y={-2} width={W + 4} height={H + 4} rx={3} fill="#000" />
        {/* top bar */}
        <rect width={W} height={top} fill="#13263d" />
        <text x={6} y={14} fontSize={11.5} fontWeight={700} fill="#fff">
          <tspan fill="#ff4fd8">▶ </tspan>
          {data.wp.name}
        </text>
        <text x={W - 6} y={14} fontSize={11.5} fontWeight={700} fill="#e7f0ff" textAnchor="end">
          {clock(s.hour)}
        </text>
        <g transform={`translate(0 ${top})`}>
          <MovingMap snap={snap} data={data} w={mapW} h={mapH} />
        </g>
        <g transform={`translate(${fx} ${top})`}>
          <Field x={0} y={0} w={fw} h={fh} label="DIST" value={de(data.dist / 1000, data.dist < 10_000 ? 1 : 0)} unit="km" />
          <Field x={0} y={fh} w={fw} h={fh} label="BRG" value={`${String(Math.round(norm360(data.brg))).padStart(3, "0")}°`}>
            <g transform={`translate(14 ${fh - 9})`}>
              <Arrow deg={data.relBrg} size={13} color="#c4f06a" />
            </g>
          </Field>
          <Field x={0} y={fh * 2} w={fw} h={fh} label="REQ. L/D" value={fmtLD(data.reqLD)} color={ldCol} />
          <Field x={0} y={fh * 3} w={fw} h={fh} label="ARRIVAL" value={signed(Math.round(data.arrival / 10) * 10, 0)} unit="m" color={arrivalCol} />
          <Field x={0} y={fh * 4} w={fw} h={fh} label="AVG CLIMB" value={signed(data.avgClimb)} unit="m/s" color={data.avgClimb >= 0 ? "#7dff9c" : "#ff8b7a"} />
          <Field x={0} y={fh * 5} w={fw} h={fh} label="AVG SPEED" value={data.taskSpeed == null ? "––" : de(Math.max(0, data.taskSpeed))} unit="km/h" />
        </g>
        {/* status bar */}
        <g transform={`translate(0 ${H - bottom})`}>
          <rect width={W} height={bottom} fill="#0c1520" />
          {s.autopilot ? (
            <g>
              <rect x={4} y={3} width={58} height={12} rx={6} fill="#c4f06a" />
              <text x={33} y={12} fontSize={8} fontWeight={700} textAnchor="middle" fill="#14200a" letterSpacing={0.6}>
                AUTOPILOT
              </text>
            </g>
          ) : (
            <g>
              <rect x={4} y={3} width={58} height={12} rx={6} fill="none" stroke="#5b6b7d" strokeWidth={0.8} />
              <text x={33} y={12} fontSize={8} fontWeight={700} textAnchor="middle" fill="#9fb0c2" letterSpacing={0.6}>
                MANUAL
              </text>
            </g>
          )}
          <text x={68} y={12.5} fontSize={9} fill="#dce6f2">
            {s.phase.length > 34 ? s.phase.slice(0, 33) + "…" : s.phase}
          </text>
          <circle cx={W - 46} cy={9} r={3} fill="#5dff8a" />
          <text x={W - 6} y={12.5} fontSize={8} textAnchor="end" fill="#9fb0c2" fontWeight={700}>
            NAV
          </text>
        </g>
        <rect width={W} height={H} fill="url(#ck-screen-glare)" pointerEvents="none" />
      </g>
      {/* knobs & buttons */}
      <g transform="translate(0 205)">
        {[34, 266].map((x) => (
          <g key={x} transform={`translate(${x} 0)`}>
            <circle r={13} fill="#000" opacity={0.4} transform="translate(1.5 2.5)" />
            <circle r={13} fill="url(#ck-knob)" stroke="#000" strokeWidth={1} />
            <circle r={13} fill="none" stroke="#fff" strokeOpacity={0.12} strokeDasharray="1.5 2" strokeWidth={2} />
            <path d="M0 -11 V-5" stroke="#cfd3d8" strokeWidth={1.6} strokeLinecap="round" />
          </g>
        ))}
        {[88, 128, 172, 212].map((x, i) => (
          <g key={x} transform={`translate(${x} 0)`}>
            <rect x={-15} y={-7} width={30} height={14} rx={4} fill="#1e2226" stroke="#000" strokeWidth={1} />
            <rect x={-14} y={-6} width={28} height={5} rx={3} fill="#fff" opacity={0.07} />
            <text y={3} fontSize={7} textAnchor="middle" fill="#9aa3ad" fontWeight={700}>
              {["NAV", "TSK", "WP", "INF"][i]}
            </text>
          </g>
        ))}
      </g>
    </g>
  );
}

/** Compact unit for the mobile strip: w × h screen only (no knobs). */
export function FlightComputerCompact({ snap, data, w, h }: { snap: SimSnapshot; data: FlightData; w: number; h: number }) {
  const s = snap.state;
  const mapW = h - 4;
  const x0 = mapW + 8;
  const cw = (w - x0 - 4) / 3;
  const arrivalCol = data.arrival >= 150 ? "#7dff9c" : data.arrival >= 0 ? "#ffd23f" : "#ff6b5e";
  const cells: [string, string, string?, string?][] = [
    ["DIST", de(data.dist / 1000, data.dist < 10_000 ? 1 : 0), "km"],
    ["REQ. L/D", fmtLD(data.reqLD)],
    ["ARRIVAL", signed(Math.round(data.arrival / 10) * 10, 0), "m", arrivalCol],
    ["Ø STEIG.", signed(data.avgClimb), "m/s", data.avgClimb >= 0 ? "#7dff9c" : "#ff8b7a"],
    ["WIND", `${Math.round(data.wind.kmh)}`, "km/h"],
    ["UHR", clock(s.hour)],
  ];
  return (
    <g fontFamily="var(--ck-screen-font)">
      <MapGrad />
      <rect x={-4} y={-4} width={w + 8} height={h + 8} rx={9} fill="url(#ck-plastic)" stroke="#3d434b" strokeWidth={1} />
      <rect width={w} height={h} rx={3} fill="#000" />
      <g transform="translate(2 2)">
        <MovingMap snap={snap} data={data} w={mapW} h={h - 4} glider={[0.5, 0.6]} />
      </g>
      <g transform={`translate(${x0} 0)`}>
        <text x={0} y={12} fontSize={10} fontWeight={700} fill="#fff">
          <tspan fill="#ff4fd8">▶ </tspan>
          {data.wp.name}
        </text>
        <g transform={`translate(${w - x0 - 12} 8)`}>
          <Arrow deg={data.relBrg} size={13} color="#c4f06a" />
        </g>
        {cells.map(([label, value, unit, color], i) => {
          const cx = (i % 3) * cw;
          const cy = 19 + Math.floor(i / 3) * 27;
          return (
            <g key={label} transform={`translate(${cx} ${cy})`}>
              <text y={8} fontSize={6.6} fill="#8fa3b8" fontWeight={700}>
                {label}
              </text>
              <text y={21} fontSize={13} fontWeight={700} fill={color ?? "#fff"}>
                {value}
                {unit && (
                  <tspan fontSize={7} fill="#8fa3b8" dx={1.5}>
                    {unit}
                  </tspan>
                )}
              </text>
            </g>
          );
        })}
        <g transform={`translate(0 ${h - 15})`}>
          {s.autopilot && (
            <>
              <rect y={1} width={22} height={11} rx={5.5} fill="#c4f06a" />
              <text x={11} y={9.5} fontSize={7} fontWeight={700} textAnchor="middle" fill="#14200a">
                AP
              </text>
            </>
          )}
          <text x={s.autopilot ? 27 : 0} y={10} fontSize={8.5} fill="#dce6f2">
            {s.phase.length > 30 ? s.phase.slice(0, 29) + "…" : s.phase}
          </text>
        </g>
      </g>
      <rect width={w} height={h} fill="url(#ck-screen-glare)" pointerEvents="none" />
    </g>
  );
}
