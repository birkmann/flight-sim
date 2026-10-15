/**
 * Analogue glider instruments drawn in SVG. Every dial uses a unit system: face radius 97, bezel 110,
 * mounting screws at the corners (±90, ±90); the caller places it with <Gauge x y size>.
 * Light comes from above-left (sun through the canopy): highlights top-left, shadows bottom-right.
 * Static faces are memoised elements, only needles/cards move (via useTween → direct DOM writes).
 */
import { memo, useRef, type ReactNode } from "react";
import { useTween } from "./anim";

const RAD = Math.PI / 180;
const f2 = (n: number) => Math.round(n * 100) / 100;
/** point at `deg` clockwise from 12 o'clock, radius r */
export const pt = (deg: number, r: number): [number, number] => [f2(Math.sin(deg * RAD) * r), f2(-Math.cos(deg * RAD) * r)];
export function arcD(r: number, a0: number, a1: number) {
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a1, r);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${x0} ${y0}A${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}
export function ticksD(angles: number[], r0: number, r1: number) {
  let d = "";
  for (const a of angles) {
    const [x0, y0] = pt(a, r0);
    const [x1, y1] = pt(a, r1);
    d += `M${x0} ${y0}L${x1} ${y1}`;
  }
  return d;
}
const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
};

const INK = "#efeadf";
const INK_DIM = "#a9a59c";

/* ------------------------------------------------------------------ shared defs */

/** Gradients used by all instruments; render once inside each <svg>. */
export const CockpitDefs = memo(function CockpitDefs({ noise }: { noise?: string }) {
  return (
    <defs>
      <radialGradient id="ck-face" cx="42%" cy="30%" r="80%">
        <stop offset="0" stopColor="#24282e" />
        <stop offset="0.6" stopColor="#121519" />
        <stop offset="1" stopColor="#08090b" />
      </radialGradient>
      <radialGradient id="ck-faceshade" cx="50%" cy="64%" r="58%">
        <stop offset="0.82" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.7" />
      </radialGradient>
      <linearGradient id="ck-bezel" x1="0.2" y1="0" x2="0.6" y2="1">
        <stop offset="0" stopColor="#8a9099" />
        <stop offset="0.28" stopColor="#3b4047" />
        <stop offset="0.7" stopColor="#16191d" />
        <stop offset="1" stopColor="#25292f" />
      </linearGradient>
      <linearGradient id="ck-bezel-in" x1="0.3" y1="0" x2="0.5" y2="1">
        <stop offset="0" stopColor="#030405" />
        <stop offset="0.75" stopColor="#1b1e22" />
        <stop offset="1" stopColor="#4a5058" />
      </linearGradient>
      <radialGradient id="ck-dropshadow">
        <stop offset="0.8" stopColor="#000" stopOpacity="0.75" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="ck-glare" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.30" />
        <stop offset="0.5" stopColor="#fff" stopOpacity="0.06" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      <radialGradient id="ck-screw" cx="38%" cy="32%" r="75%">
        <stop offset="0" stopColor="#d6dbe1" />
        <stop offset="0.45" stopColor="#7d838b" />
        <stop offset="1" stopColor="#24272b" />
      </radialGradient>
      <radialGradient id="ck-hub" cx="38%" cy="32%" r="70%">
        <stop offset="0" stopColor="#5c626a" />
        <stop offset="0.6" stopColor="#1b1d21" />
        <stop offset="1" stopColor="#050506" />
      </radialGradient>
      <linearGradient id="ck-lcd" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#0a1a14" />
        <stop offset="1" stopColor="#06110d" />
      </linearGradient>
      <linearGradient id="ck-plastic" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#2c3036" />
        <stop offset="0.08" stopColor="#1a1d21" />
        <stop offset="1" stopColor="#0c0d0f" />
      </linearGradient>
      <linearGradient id="ck-glass-tube" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f4e9c4" stopOpacity="0.55" />
        <stop offset="0.5" stopColor="#c9b98a" stopOpacity="0.3" />
        <stop offset="1" stopColor="#3b3526" stopOpacity="0.55" />
      </linearGradient>
      <radialGradient id="ck-knob" cx="40%" cy="30%" r="80%">
        <stop offset="0" stopColor="#4c5158" />
        <stop offset="0.55" stopColor="#1e2125" />
        <stop offset="1" stopColor="#070809" />
      </radialGradient>
      {noise && (
        <pattern id="ck-noise" patternUnits="userSpaceOnUse" width="128" height="128">
          <image href={noise} width="128" height="128" />
        </pattern>
      )}
    </defs>
  );
});

/* ------------------------------------------------------------------ mounting, bezel, glass */

function Screw({ x, y, a }: { x: number; y: number; a: number }) {
  const [dx, dy] = pt(a, 4.6);
  return (
    <g>
      <circle cx={x + 0.8} cy={y + 1.4} r={7} fill="#000" opacity={0.45} />
      <circle cx={x} cy={y} r={6.2} fill="url(#ck-screw)" />
      <path d={`M${x - dx} ${y - dy}L${x + dx} ${y + dy}`} stroke="#1a1c1f" strokeWidth={1.6} strokeLinecap="round" />
    </g>
  );
}

const SCREW_ANGLES = [17, 62, 133, 101];
/** Instrument well, bezel, face background. */
const Mount = memo(function Mount({ screws = true }: { screws?: boolean }) {
  // data-layer: the static layers InstrumentTexture rasterizes once (see there).
  return (
    <g data-layer="base">
      <circle cx={3} cy={6} r={121} fill="url(#ck-dropshadow)" />
      {screws &&
        [
          [-90, -90],
          [90, -90],
          [-90, 90],
          [90, 90],
        ].map(([x, y], i) => <Screw key={i} x={x!} y={y!} a={SCREW_ANGLES[i]!} />)}
      <circle r={110} fill="url(#ck-bezel)" />
      <circle r={103.5} fill="url(#ck-bezel-in)" />
      <circle r={98} fill="url(#ck-face)" />
    </g>
  );
});

/** Face shading + glass reflection, drawn above needles. */
const Glass = memo(function Glass() {
  return (
    <g pointerEvents="none" data-layer="glass">
      <circle r={98} fill="url(#ck-faceshade)" />
      <path d="M -86 -30 A 92 92 0 0 1 30 -88 A 120 120 0 0 0 -86 -30 Z" fill="#fff" opacity={0.16} />
      <ellipse cx={-34} cy={-48} rx={62} ry={22} transform="rotate(-38 -34 -48)" fill="url(#ck-glare)" opacity={0.7} />
      <path d="M 52 70 A 92 92 0 0 1 20 88" stroke="#fff" strokeOpacity={0.1} strokeWidth={3} fill="none" strokeLinecap="round" />
    </g>
  );
});

export function Gauge({ x, y, size, children, screws = true }: { x: number; y: number; size: number; children: ReactNode; screws?: boolean }) {
  // size = bezel diameter in the parent's units
  const s = size / 220;
  return (
    <g transform={`translate(${x} ${y}) scale(${f2(s * 1000) / 1000})`}>
      <Mount screws={screws} />
      {children}
      <Glass />
    </g>
  );
}

/* ------------------------------------------------------------------ needles */

const NEEDLE = "M -3.4 22 L -2.5 -58 L -0.9 -86 L 0.9 -86 L 2.5 -58 L 3.4 22 Z";
const NEEDLE_TAIL = "M -5 18 L 5 18 L 4 34 L -4 34 Z";

/** White pointer with drop shadow and hub, rotated to `deg` (eased). */
export function Needle({
  deg,
  tau = 0.12,
  wrap,
  shape = NEEDLE,
  tail = true,
  color = "#f4f1ea",
  hub = true,
}: {
  deg: number;
  tau?: number;
  wrap?: number;
  shape?: string;
  tail?: boolean;
  color?: string;
  hub?: boolean;
}) {
  const a = useRef<SVGGElement>(null);
  const b = useRef<SVGGElement>(null);
  useTween(
    deg,
    (v) => {
      const t = `rotate(${v.toFixed(2)})`;
      a.current?.setAttribute("transform", t);
      b.current?.setAttribute("transform", t);
    },
    { tau, wrap },
  );
  return (
    <g>
      <g transform="translate(2.6 4.2)" opacity={0.42}>
        <g ref={a}>
          <path d={shape} fill="#000" />
          {tail && <path d={NEEDLE_TAIL} fill="#000" />}
        </g>
      </g>
      <g ref={b}>
        <path d={shape} fill={color} stroke="#000" strokeWidth={0.7} strokeOpacity={0.6} />
        {tail && <path d={NEEDLE_TAIL} fill="#1a1c1f" />}
      </g>
      {hub && (
        <g>
          <circle r={10} fill="url(#ck-hub)" stroke="#4a4f56" strokeWidth={0.8} />
          <circle r={3} fill="#0a0b0c" />
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ Fahrtmesser (ASI) */

/** km/h → dial angle; expanded between 60 and 160 km/h where the glider lives. */
const ASI_PTS: [number, number][] = [
  [0, -150],
  [40, -128],
  [60, -96],
  [100, -18],
  [150, 66],
  [200, 120],
  [250, 158],
  [280, 178],
];
export function asiAngle(kmh: number) {
  const v = Math.max(0, Math.min(280, kmh));
  for (let i = 1; i < ASI_PTS.length; i++) {
    const [v1, a1] = ASI_PTS[i]!;
    const [v0, a0] = ASI_PTS[i - 1]!;
    if (v <= v1) return a0 + ((v - v0) / (v1 - v0)) * (a1 - a0);
  }
  return 178;
}

const AsiFace = memo(function AsiFace() {
  const minor = range(40, 270, 5).map(asiAngle);
  const major = range(40, 250, 10).map(asiAngle);
  const labels = [60, 80, 100, 120, 140, 160, 200, 250];
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK} data-layer="base">
      <path d={arcD(91, asiAngle(70), asiAngle(180))} stroke="#2fb24c" strokeWidth={7} fill="none" />
      <path d={arcD(91, asiAngle(180), asiAngle(250))} stroke="#f2c230" strokeWidth={7} fill="none" />
      <path d={arcD(91, asiAngle(55), asiAngle(70))} stroke="#f4f1ea" strokeWidth={3} fill="none" opacity={0.85} />
      <path d={ticksD([asiAngle(250)], 76, 96)} stroke="#e8352e" strokeWidth={4.5} />
      <path d={ticksD(minor, 82, 88)} stroke={INK} strokeWidth={1.3} />
      <path d={ticksD(major, 76, 88)} stroke={INK} strokeWidth={2.6} />
      {/* approach speed: yellow triangle */}
      <path
        d={(() => {
          const a = asiAngle(95);
          const [x0, y0] = pt(a, 95);
          const [x1, y1] = pt(a - 4, 104);
          const [x2, y2] = pt(a + 4, 104);
          return `M${x0} ${y0}L${x1} ${y1}L${x2} ${y2}Z`;
        })()}
        fill="#f2c230"
      />
      {labels.map((v) => {
        const [x, y] = pt(asiAngle(v), 62);
        return (
          <text key={v} x={x} y={y} fontSize={v >= 100 ? 15.5 : 17} fontWeight={600} textAnchor="middle" dominantBaseline="central" letterSpacing={-0.6}>
            {v}
          </text>
        );
      })}
      <text y={-30} fontSize={11.5} textAnchor="middle" fill={INK_DIM} letterSpacing={0.5}>
        km/h
      </text>
      <text y={38} fontSize={9} textAnchor="middle" fill={INK_DIM} letterSpacing={2}>
        FAHRT
      </text>
    </g>
  );
});

export function Asi({ kmh }: { kmh: number }) {
  return (
    <>
      <AsiFace />
      <Needle deg={asiAngle(kmh)} />
    </>
  );
}

/* ------------------------------------------------------------------ Variometer */

export const varioAngle = (ms: number) => -90 + Math.max(-5.25, Math.min(5.25, ms)) * 33;

const VarioFace = memo(function VarioFace() {
  const minor = range(-5, 5, 0.2).map(varioAngle);
  const half = range(-4.5, 4.5, 1).map(varioAngle);
  const major = range(-5, 5, 1).map(varioAngle);
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK} data-layer="base">
      <path d={arcD(94, varioAngle(0), varioAngle(5))} stroke="#38c46a" strokeWidth={3.2} fill="none" opacity={0.85} />
      <path d={arcD(94, varioAngle(-5), varioAngle(0))} stroke="#e8483c" strokeWidth={3.2} fill="none" opacity={0.85} />
      <path d={ticksD(minor, 84, 90)} stroke={INK} strokeWidth={1.1} />
      <path d={ticksD(half, 80, 90)} stroke={INK} strokeWidth={1.8} />
      <path d={ticksD(major, 74, 90)} stroke={INK} strokeWidth={3} />
      {range(-5, 5, 1).map((v) => {
        const [x, y] = pt(varioAngle(v), 62);
        return (
          <text key={v} x={x} y={y} fontSize={v === 0 ? 22 : 19} fontWeight={600} textAnchor="middle" dominantBaseline="central">
            {Math.abs(v)}
          </text>
        );
      })}
      <text x={-30} y={-40} fontSize={13} fontWeight={700} textAnchor="middle" fill="#38c46a">
        +
      </text>
      <text x={-30} y={44} fontSize={15} fontWeight={700} textAnchor="middle" fill="#e8483c">
        −
      </text>
      <text x={0} y={-36} fontSize={11.5} textAnchor="middle" fill={INK_DIM}>
        m/s
      </text>
      {/* two-line LCD below the hub */}
      <rect x={-29} y={19} width={58} height={31} rx={3.5} fill="url(#ck-lcd)" stroke="#000" strokeWidth={1.5} />
      <rect x={-29} y={19} width={58} height={31} rx={3.5} fill="none" stroke="#fff" strokeOpacity={0.08} strokeWidth={0.8} transform="translate(0 1)" />
    </g>
  );
});

function lcdColor(v: number) {
  return v >= 0.2 ? "#7dffa8" : v <= -0.2 ? "#ff8b7a" : "#cfe9dc";
}

export function Vario({ ms, avg, netto }: { ms: number; avg: number; netto: number }) {
  const bugRef = useRef<SVGGElement>(null);
  useTween(varioAngle(avg), (v) => bugRef.current?.setAttribute("transform", `rotate(${v.toFixed(2)})`), { tau: 0.6 });
  return (
    <>
      <VarioFace />
      <g fontFamily="var(--ck-screen-font)" fontSize={11.5} fontWeight={700}>
        <text x={-25} y={31.5} fill="#8fb7a3" fontSize={8.5}>
          Ø
        </text>
        <text x={25} y={31.5} textAnchor="end" fill={lcdColor(avg)}>
          {signed1(avg)}
        </text>
        <text x={-25} y={45.5} fill="#8fb7a3" fontSize={8.5}>
          N
        </text>
        <text x={25} y={45.5} textAnchor="end" fill={lcdColor(netto)}>
          {signed1(netto)}
        </text>
      </g>
      {/* averager bug on the rim */}
      <g ref={bugRef}>
        <path d="M0 -92 L-6 -103 L6 -103 Z" fill="#ffb238" stroke="#000" strokeWidth={0.8} />
      </g>
      <Needle deg={varioAngle(ms)} tau={0.18} />
    </>
  );
}

function signed1(v: number) {
  const r = Math.round(v * 10) / 10;
  if (r === 0) return "0,0";
  return (r > 0 ? "+" : "−") + Math.abs(r).toFixed(1).replace(".", ",");
}

/* ------------------------------------------------------------------ Höhenmesser */

const AltFace = memo(function AltFace({unit}: {unit:string}) {
  const minor = range(0, 980, 20).map((m) => (m / 1000) * 360);
  const major = range(0, 900, 100).map((m) => (m / 1000) * 360);
  const half = range(50, 950, 100).map((m) => (m / 1000) * 360);
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK} data-layer="base">
      <path d={ticksD(minor, 84, 90)} stroke={INK} strokeWidth={1.2} />
      <path d={ticksD(half, 80, 90)} stroke={INK} strokeWidth={1.8} />
      <path d={ticksD(major, 74, 90)} stroke={INK} strokeWidth={3} />
      {range(0, 9, 1).map((d) => {
        const [x, y] = pt(d * 36, 63);
        return (
          <text key={d} x={x} y={y} fontSize={22} fontWeight={600} textAnchor="middle" dominantBaseline="central">
            {d}
          </text>
        );
      })}
      <text y={-34} fontSize={9} textAnchor="middle" fill={INK_DIM} letterSpacing={0.8}>
        ×100 {unit}
      </text>
      {/* drum counter window */}
      <rect x={-31} y={22} width={62} height={22} rx={2.5} fill="#020203" stroke="#555b63" strokeWidth={1} />
      {/* QNH window */}
      <rect x={30} y={-9} width={34} height={18} rx={2} fill="#020203" stroke="#555b63" strokeWidth={0.8} />
      <text x={47} y={0.5} fontSize={11} textAnchor="middle" dominantBaseline="central" fill="#e9e3d3" fontFamily="var(--ck-mono-font)">
        STD
      </text>
      <text x={47} y={18} fontSize={7} textAnchor="middle" fill={INK_DIM}>
        hPa
      </text>
    </g>
  );
});

const SHORT_HAND = "M -6 14 L -5 -30 L 0 -52 L 5 -30 L 6 14 Z";

export function Altimeter({ m, unit="m" }: { m: number; unit?:string }) {
  const alt = Math.max(0, m);
  const digits = String(Math.round(alt)).padStart(5, "0");
  return (
    <>
      <AltFace unit={unit}/>
      <g fontFamily="var(--ck-mono-font)" fontSize={15} fontWeight={700} fill="#f4f1ea">
        {digits.split("").map((d, i) => (
          <g key={i}>
            <rect x={-29 + i * 11.6} y={24} width={10.4} height={18} fill={i < 2 ? "#151719" : "#0c0d0e"} />
            <text x={-23.8 + i * 11.6} y={33.6} textAnchor="middle" dominantBaseline="central" fill={i < 2 ? "#cfc9bb" : "#f4f1ea"}>
              {d}
            </text>
          </g>
        ))}
        <rect x={-31} y={22} width={62} height={7} fill="#000" opacity={0.45} />
        <rect x={-31} y={37} width={62} height={7} fill="#000" opacity={0.45} />
        <text x={38} y={34} fontSize={9} fill={INK_DIM} fontFamily="var(--ck-dial-font)" dominantBaseline="central">
          {unit}
        </text>
      </g>
      <Needle deg={(alt / 10000) * 360} shape={SHORT_HAND} tail={false} hub={false} tau={0.15} />
      <Needle deg={(alt / 1000) * 360} tau={0.15} />
    </>
  );
}

/* ------------------------------------------------------------------ Kurs (heading-up compass rose + waypoint pointer) */

const COMPASS_LABELS: Record<number, string> = { 0: "N", 90: "O", 180: "S", 270: "W" };
const CompassCard = memo(function CompassCard() {
  const minor = range(0, 355, 5);
  const major = range(0, 350, 10);
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK}>
      <path d={ticksD(minor, 84, 90)} stroke={INK} strokeWidth={1.1} />
      <path d={ticksD(major, 77, 90)} stroke={INK} strokeWidth={2.2} />
      {range(0, 330, 30).map((a) => {
        const [x, y] = pt(a, 64);
        const label = COMPASS_LABELS[a] ?? String(a / 10);
        return (
          <text
            key={a}
            x={x}
            y={y}
            fontSize={COMPASS_LABELS[a] ? 21 : 16}
            fontWeight={COMPASS_LABELS[a] ? 700 : 600}
            fill={a === 0 ? "#ff8a3d" : INK}
            textAnchor="middle"
            dominantBaseline="central"
            transform={`rotate(${a} ${x} ${y})`}
          >
            {label}
          </text>
        );
      })}
    </g>
  );
});

const GLIDER_ICON =
  "M0 -26 C2 -26 2.6 -20 2.6 -12 L2.6 -6 L44 -3.5 L44 0 L2.4 1.5 L1.6 20 L10 21 L10 24 L0 24.6 L-10 24 L-10 21 L-1.6 20 L-2.4 1.5 L-44 0 L-44 -3.5 L-2.6 -6 L-2.6 -12 C-2.6 -20 -2 -26 0 -26 Z";

export function Compass({ headingDeg, relBrg }: { headingDeg: number; relBrg: number }) {
  const card = useRef<SVGGElement>(null);
  useTween(-headingDeg, (v) => card.current?.setAttribute("transform", `rotate(${v.toFixed(2)})`), { tau: 0.15, wrap: 360 });
  const ptr = useRef<SVGGElement>(null);
  useTween(relBrg, (v) => ptr.current?.setAttribute("transform", `rotate(${v.toFixed(2)})`), { tau: 0.2, wrap: 360 });
  return (
    <>
      <g ref={card}>
        <CompassCard />
      </g>
      {/* fixed 45° index marks and lubber line */}
      <path d={ticksD([45, 135, 225, 315], 92, 98)} stroke={INK_DIM} strokeWidth={2.4} />
      <path d="M0 -76 L-6 -97 L6 -97 Z" fill="#ff8a3d" stroke="#000" strokeWidth={0.8} />
      {/* waypoint pointer (RMI style) */}
      <g ref={ptr}>
        <g transform="translate(2 3.5)" opacity={0.35}>
          <path d="M0 -74 L-9 -56 L-2.4 -56 L-2.4 70 L2.4 70 L2.4 -56 L9 -56 Z" fill="#000" />
        </g>
        <path d="M0 -74 L-9 -56 L-2.4 -56 L-2.4 70 L2.4 70 L2.4 -56 L9 -56 Z" fill="#c4f06a" stroke="#203000" strokeWidth={0.8} />
        <path d="M-6 58 L0 50 L6 58 L6 70 L-6 70 Z" fill="#c4f06a" stroke="#203000" strokeWidth={0.8} />
      </g>
      <path d={GLIDER_ICON} fill="#f4f1ea" stroke="#000" strokeWidth={0.8} transform="translate(0 -2) scale(0.92)" />
      <text y={44} fontSize={9} textAnchor="middle" fill={INK_DIM} fontFamily="var(--ck-dial-font)" letterSpacing={1.5}>
        KURS
      </text>
    </>
  );
}

/* ------------------------------------------------------------------ Uhr (small clock) */

const ClockFace = memo(function ClockFace() {
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK}>
      <path d={ticksD(range(0, 354, 6), 84, 90)} stroke={INK} strokeWidth={1.4} />
      <path d={ticksD(range(0, 330, 30), 74, 90)} stroke={INK} strokeWidth={4} />
      {[12, 3, 6, 9].map((h) => {
        const [x, y] = pt(h * 30, 56);
        return (
          <text key={h} x={x} y={y} fontSize={30} fontWeight={600} textAnchor="middle" dominantBaseline="central">
            {h}
          </text>
        );
      })}
    </g>
  );
});
const HOUR_HAND = "M -5 12 L -4 -36 L 0 -50 L 4 -36 L 5 12 Z";
const MIN_HAND = "M -3.5 14 L -2.6 -64 L 0 -80 L 2.6 -64 L 3.5 14 Z";
export function Clock({ hour }: { hour: number }) {
  return (
    <>
      <ClockFace />
      <Needle deg={(hour % 12) * 30} shape={HOUR_HAND} tail={false} hub={false} tau={0.3} wrap={360} />
      <Needle deg={(hour * 60 % 60) * 6} shape={MIN_HAND} tail={false} tau={0.3} wrap={360} />
    </>
  );
}

/* ------------------------------------------------------------------ G-Messer (small) */

const gAngle = (g: number) => -135 + ((Math.max(-2.2, Math.min(6.2, g)) + 2) / 8) * 270;
const GFace = memo(function GFace() {
  return (
    <g fontFamily="var(--ck-dial-font)" fill={INK}>
      <path d={arcD(90, gAngle(5.3), gAngle(6))} stroke="#e8352e" strokeWidth={8} fill="none" />
      <path d={ticksD(range(-2, 6, 0.5).map(gAngle), 82, 90)} stroke={INK} strokeWidth={2} />
      <path d={ticksD(range(-2, 6, 1).map(gAngle), 72, 90)} stroke={INK} strokeWidth={4} />
      {[-2, 0, 2, 4, 6].map((g) => {
        const [x, y] = pt(gAngle(g), 54);
        return (
          <text key={g} x={x} y={y} fontSize={26} fontWeight={600} textAnchor="middle" dominantBaseline="central">
            {g < 0 ? `−${-g}` : g}
          </text>
        );
      })}
      <text y={40} fontSize={22} textAnchor="middle" fill={INK_DIM}>
        g
      </text>
    </g>
  );
});
export function GMeter({ g }: { g: number }) {
  return (
    <>
      <GFace />
      <Needle deg={gAngle(g)} tau={0.1} />
    </>
  );
}

/* ------------------------------------------------------------------ Libelle (slip ball) */

/** Curved glass tube with the ball; `slip` −1…1 (+ = skid right → ball rolls left). Units: ~130 wide. */
export function SlipBall({ slip }: { slip: number }) {
  const ball = useRef<SVGGElement>(null);
  useTween(-slip * 17, (v) => ball.current?.setAttribute("transform", `rotate(${v.toFixed(2)} 0 -150)`), { tau: 0.35 });
  return (
    <g>
      <rect x={-68} y={-24} width={136} height={46} rx={11} fill="#000" opacity={0.4} transform="translate(1.5 3)" />
      <rect x={-68} y={-24} width={136} height={46} rx={11} fill="url(#ck-plastic)" stroke="#3a3f46" strokeWidth={1} />
      <circle cx={-58} cy={-1} r={4} fill="url(#ck-screw)" />
      <circle cx={58} cy={-1} r={4} fill="url(#ck-screw)" />
      <path d="M -50 -3 A 158 158 0 0 0 50 -3" stroke="#000" strokeWidth={20} strokeLinecap="round" fill="none" />
      <path d="M -50 -3 A 158 158 0 0 0 50 -3" stroke="url(#ck-glass-tube)" strokeWidth={16} strokeLinecap="round" fill="none" />
      <path d="M -9 -4 L -9 18 M 9 -4 L 9 18" stroke="#111" strokeWidth={1.6} />
      <g ref={ball}>
        <circle cx={0} cy={8} r={7.4} fill="#050505" />
        <circle cx={-2.4} cy={5.4} r={2.2} fill="#fff" opacity={0.55} />
      </g>
      <path d="M -48 -8 A 158 158 0 0 0 48 -8" stroke="#fff" strokeOpacity={0.35} strokeWidth={1.6} fill="none" />
    </g>
  );
}

/* ------------------------------------------------------------------ Kompass on the glare shield (whiskey compass) */

const TAPE_K = 1.7; // px per degree
const CompassTape = memo(function CompassTape() {
  const els: ReactNode[] = [];
  for (let a = -90; a <= 450; a += 5) {
    const x = a * TAPE_K;
    const d = ((a % 360) + 360) % 360;
    if (d % 30 === 0) {
      const label = COMPASS_LABELS[d] ?? String(d / 10);
      els.push(
        <text key={`t${a}`} x={x} y={-1} fontSize={COMPASS_LABELS[d] ? 13 : 11} fontWeight={700} textAnchor="middle" fill={d === 0 ? "#ff8a3d" : "#f2eee6"}>
          {label}
        </text>,
      );
      els.push(<path key={`m${a}`} d={`M${x} 3V11`} stroke="#f2eee6" strokeWidth={1.4} />);
    } else els.push(<path key={`m${a}`} d={`M${x} ${d % 10 === 0 ? 5 : 7}V11`} stroke="#f2eee6" strokeWidth={0.9} />);
  }
  return <g fontFamily="var(--ck-dial-font)">{els}</g>;
});

/** Liquid compass sitting on the glare shield; the card shows the heading under the lubber line. */
export function WhiskeyCompass({ headingDeg }: { headingDeg: number }) {
  const tape = useRef<SVGGElement>(null);
  useTween(
    headingDeg,
    (v) => {
      const h = ((v % 360) + 360) % 360;
      tape.current?.setAttribute("transform", `translate(${(-h * TAPE_K).toFixed(2)} 0)`);
    },
    { tau: 0.4, wrap: 360 },
  );
  return (
    <g>
      <path d="M -40 26 L 40 26 L 34 34 L -34 34 Z" fill="#0b0c0e" />
      <rect x={-50} y={-20} width={100} height={46} rx={10} fill="#000" opacity={0.4} transform="translate(2 4)" />
      <rect x={-50} y={-20} width={100} height={46} rx={10} fill="url(#ck-plastic)" stroke="#3b4048" strokeWidth={1} />
      <clipPath id="ck-wc-clip">
        <rect x={-38} y={-12} width={76} height={28} rx={9} />
      </clipPath>
      <rect x={-38} y={-12} width={76} height={28} rx={9} fill="#14181c" />
      <g clipPath="url(#ck-wc-clip)">
        <g transform="translate(0 6)">
          <g ref={tape}>
            <CompassTape />
          </g>
        </g>
        <rect x={-38} y={-12} width={18} height={28} fill="#000" opacity={0.55} />
        <rect x={20} y={-12} width={18} height={28} fill="#000" opacity={0.55} />
        <rect x={-38} y={-12} width={76} height={10} fill="#fff" opacity={0.06} />
      </g>
      <path d="M0 -12 V16" stroke="#ff7a2f" strokeWidth={1.6} />
      <rect x={-38} y={-12} width={76} height={28} rx={9} fill="none" stroke="#000" strokeWidth={2} />
      <path d="M -32 -9 Q 0 -14 32 -9" stroke="#fff" strokeOpacity={0.35} strokeWidth={1.2} fill="none" />
    </g>
  );
}

/* ------------------------------------------------------------------ decorative: radio, switches, placard */

export function Radio({ hour, frequency }: { hour: number; frequency?: string }) {
  const blink = Math.floor(hour * 3600) % 4 < 2;
  return (
    <g>
      <rect x={2} y={3} width={150} height={48} rx={6} fill="#000" opacity={0.45} />
      <rect width={150} height={48} rx={6} fill="url(#ck-plastic)" stroke="#3a3f46" strokeWidth={1} />
      <rect x={9} y={7} width={92} height={34} rx={3} fill="#120c02" stroke="#000" strokeWidth={1.4} />
      <g fontFamily="var(--ck-mono-font)" fill="#ffb238">
        <text x={14} y={22} fontSize={13.5} fontWeight={700} fontFamily="var(--ck-screen-font)" letterSpacing={0.4}>
          {frequency || "— — —"}
        </text>
        <text x={14} y={35} fontSize={7.6} opacity={0.85} fontFamily="var(--ck-screen-font)">
          COM ACTIVE
        </text>
        <text x={96} y={21} fontSize={7} textAnchor="end" opacity={blink ? 0.9 : 0.25}>
          COM
        </text>
      </g>
      <circle cx={126} cy={24} r={14} fill="url(#ck-knob)" stroke="#000" strokeWidth={1} />
      <circle cx={126} cy={24} r={8} fill="url(#ck-knob)" stroke="#000" strokeWidth={0.8} />
      <path d="M126 12V17" stroke="#ddd" strokeWidth={1.4} />
    </g>
  );
}

export function Switch({ label, on = true, led = "#5dff8a" }: { label: string; on?: boolean; led?: string }) {
  return (
    <g>
      <circle r={7.5} fill="url(#ck-screw)" />
      <circle r={4.4} fill="#25282c" />
      <path d={on ? "M0 0 L0 -14" : "M0 0 L0 14"} stroke="#000" strokeWidth={4.4} strokeLinecap="round" opacity={0.4} transform="translate(1.5 2)" />
      <path d={on ? "M0 0 L0 -14" : "M0 0 L0 14"} stroke="#c9cdd2" strokeWidth={3.6} strokeLinecap="round" />
      <circle cy={on ? -15 : 15} r={2.8} fill="#eef0f2" />
      <circle cx={0} cy={-26} r={2.6} fill={on ? led : "#222"} />
      {on && <circle cx={0} cy={-26} r={6} fill={led} opacity={0.18} />}
      <text y={22} fontSize={8} textAnchor="middle" fill="#bdb8ad" fontFamily="var(--ck-dial-font)" letterSpacing={0.8}>
        {label}
      </text>
    </g>
  );
}

export const Placard = memo(function Placard({ lines, width = 120 }: { lines: string[]; width?: number }) {
  const h = 8 + lines.length * 9.5;
  return (
    <g>
      <rect width={width} height={h} rx={2} fill="#e9e4d6" opacity={0.92} />
      <rect x={2} y={2} width={width - 4} height={h - 4} rx={1.5} fill="none" stroke="#111" strokeWidth={0.6} />
      {lines.map((l, i) => (
        <text key={i} x={width / 2} y={11.5 + i * 9.5} fontSize={7.4} textAnchor="middle" fill="#111" fontFamily="var(--ck-dial-font)" fontWeight={600} letterSpacing={0.3}>
          {l}
        </text>
      ))}
    </g>
  );
});
