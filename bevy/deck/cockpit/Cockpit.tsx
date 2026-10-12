/**
 * First-person cockpit overlay: glare shield + instrument panel (bottom ~31 % of the screen), cockpit
 * side walls, canopy vignette/reflections and the yaw string. Everything is "fixed in the cockpit":
 * when the pilot looks around (snap.look) it slides like the 3D world would, so the wings come into view.
 */
import { useRef } from "react";
import type { SimSnapshot } from "../types";
import { useTween, useViewport } from "./anim";
import { FlightComputer, FlightComputerCompact } from "./Computer";
import { slipOf, useFlightData } from "./flightData";
import { Altimeter, Asi, Clock, CockpitDefs, Compass, GMeter, Gauge, Placard, Radio, SlipBall, Switch, Vario, WhiskeyCompass } from "./instruments";

let noiseUrl: string | undefined;
/** 128² grain texture for the matte panel paint, generated once. */
function panelNoise() {
  if (noiseUrl !== undefined || typeof document === "undefined") return noiseUrl;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const img = g.createImageData(128, 128);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rnd() * 26);
    }
    g.putImageData(img, 0, 0);
    noiseUrl = c.toDataURL();
  } catch {
    noiseUrl = "";
  }
  return noiseUrl;
}

/* ------------------------------------------------------------------ panel geometry (desktop) */

const FACE = "M 20 372 L 40 178 C 150 -6, 1050 -6, 1160 178 L 1180 372 Z";
const COAMING_TOP = "M 40 178 C 150 -6, 1050 -6, 1160 178";
const COAMING_LOW = "M 50 200 C 160 30, 1040 30, 1150 200";
const COAMING = `${COAMING_TOP} L 1150 200 C 1040 30, 160 30, 50 200 Z`;
// side walls: sill line runs from the panel's top corners outward-down towards the screen corners
const WALL_L = "M 40 178 L -330 372 L 20 372 Z";
const WALL_R = "M 1160 178 L 1530 372 L 1180 372 Z";
const SILL_L = "M 44 174 L -340 376";
const SILL_R = "M 1156 174 L 1540 376";

function DesktopPanel({ snap }: { snap: SimSnapshot }) {
  const s = snap.state;
  const data = useFlightData(snap);
  const noise = panelNoise();
  return (
    <svg className="ck-panel" viewBox="-600 -50 2400 422" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <CockpitDefs noise={noise} />
      <defs>
        <linearGradient id="ck-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a9a8a2" />
          <stop offset="0.3" stopColor="#6f6e6a" />
          <stop offset="1" stopColor="#262626" />
        </linearGradient>
        <linearGradient id="ck-wall-shade-l" x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0.15" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ck-wall-shade-r" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0.15" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ck-panel-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2e33" />
          <stop offset="0.5" stopColor="#222428" />
          <stop offset="1" stopColor="#141518" />
        </linearGradient>
        <linearGradient id="ck-coaming" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24272b" />
          <stop offset="0.25" stopColor="#141518" />
          <stop offset="1" stopColor="#0a0b0c" />
        </linearGradient>
        <linearGradient id="ck-face-side" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.45" />
          <stop offset="0.12" stopColor="#000" stopOpacity="0" />
          <stop offset="0.88" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.5" />
        </linearGradient>
        <radialGradient id="ck-sheen">
          <stop offset="0" stopColor="#fff" stopOpacity="0.09" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id="ck-face-clip">
          <path d={FACE} />
        </clipPath>
      </defs>

      {/* cockpit side walls (white gelcoat tub) with the canopy sill rail */}
      <path d={WALL_L} fill="url(#ck-wall)" />
      <path d={WALL_L} fill="url(#ck-wall-shade-l)" />
      <path d={WALL_R} fill="url(#ck-wall)" />
      <path d={WALL_R} fill="url(#ck-wall-shade-r)" />
      <g strokeLinecap="round">
        <path d={SILL_L} stroke="#0d0e10" strokeWidth={16} />
        <path d={SILL_R} stroke="#0d0e10" strokeWidth={16} />
        <path d="M 40 170 L -344 370" stroke="#5a5f66" strokeWidth={2} opacity={0.8} />
        <path d="M 1160 170 L 1544 370" stroke="#5a5f66" strokeWidth={2} opacity={0.8} />
      </g>

      {/* panel face */}
      <path d={FACE} fill="#000" opacity={0.5} transform="translate(0 6)" />
      <path d={FACE} fill="url(#ck-panel-face)" />
      {noise && <path d={FACE} fill="url(#ck-noise)" />}
      <g clipPath="url(#ck-face-clip)">
        <rect x={0} y={0} width={1200} height={372} fill="url(#ck-face-side)" />
        {/* shadow cast by the glare shield onto the panel */}
        <path d={COAMING_LOW} stroke="#000" strokeWidth={70} fill="none" opacity={0.16} />
        <path d={COAMING_LOW} stroke="#000" strokeWidth={40} fill="none" opacity={0.18} />
        <path d={COAMING_LOW} stroke="#000" strokeWidth={16} fill="none" opacity={0.25} />
      </g>

      {/* instruments */}
      <Gauge x={172} y={216} size={150}>
        <Asi kmh={s.tas * 3.6} />
      </Gauge>
      <Gauge x={345} y={198} size={198}>
        <Vario ms={s.vario} avg={data.avgClimb} netto={data.netto} />
      </Gauge>
      <Gauge x={855} y={198} size={198}>
        <Altimeter m={s.altMsl} />
      </Gauge>
      <Gauge x={1028} y={216} size={150}>
        <Compass headingDeg={data.headingDeg} relBrg={data.relBrg} />
      </Gauge>
      <g transform="translate(450 92)">
        <FlightComputer snap={snap} data={data} />
      </g>

      <g transform="translate(172 324) scale(0.86)">
        <SlipBall slip={slipOf(s)} />
      </g>
      <g transform="translate(300 334)">
        <Switch label="NAV" />
      </g>
      <g transform="translate(345 334)">
        <Switch label="VARIO" />
      </g>
      <g transform="translate(390 334)">
        <Switch label="RADIO" />
      </g>
      <g transform="translate(782 304)">
        <Radio hour={s.hour} frequency={(window as any).__flightInfo?.dep?.freqs?.[0]?.[1]} />
      </g>
      <Gauge x={985} y={330} size={64} screws={false}>
        <Clock hour={s.hour} />
      </Gauge>
      <Gauge x={1065} y={330} size={64} screws={false}>
        <GMeter g={s.g} />
      </Gauge>
      <g transform="translate(531 340)">
        <Placard width={138} lines={["VNE 250 km/h · VA 180 km/h", "VFR · SIMULATION"]} />
      </g>

      {/* glare shield (coaming) */}
      <path d={COAMING} fill="url(#ck-coaming)" />
      {noise && <path d={COAMING} fill="url(#ck-noise)" opacity={0.8} />}
      <clipPath id="ck-coaming-clip">
        <path d={COAMING} />
      </clipPath>
      <g clipPath="url(#ck-coaming-clip)">
        <ellipse cx={360} cy={66} rx={260} ry={22} fill="url(#ck-sheen)" />
      </g>
      <path d={COAMING_TOP} stroke="#575d65" strokeWidth={2.2} fill="none" />
      <path d={COAMING_TOP} stroke="#fff" strokeOpacity={0.12} strokeWidth={6} fill="none" transform="translate(0 3)" />
      <path d={COAMING_LOW} stroke="#000" strokeWidth={3} fill="none" />
      <path d={COAMING_LOW} stroke="#3c4148" strokeWidth={1} fill="none" transform="translate(0 2)" />

      <g transform="translate(600 6)">
        <WhiskeyCompass headingDeg={data.headingDeg} />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ compact strip (phones) */

const M_FACE = "M -40 290 L -40 52 C 60 8, 340 8, 440 52 L 440 270 Z";
const M_COAMING_TOP = "M -40 52 C 60 8, 340 8, 440 52";
const M_COAMING_LOW = "M -40 66 C 60 26, 340 26, 440 66";

function MobilePanel({ snap }: { snap: SimSnapshot }) {
  const s = snap.state;
  const data = useFlightData(snap);
  const noise = panelNoise();
  return (
    <svg className="ck-panel ck-panel--compact" viewBox="0 -4 400 286" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
      <CockpitDefs noise={noise} />
      <defs>
        <linearGradient id="ck-panel-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2e33" />
          <stop offset="1" stopColor="#141518" />
        </linearGradient>
        <linearGradient id="ck-coaming" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24272b" />
          <stop offset="1" stopColor="#0a0b0c" />
        </linearGradient>
      </defs>
      <path d={M_FACE} fill="url(#ck-panel-face)" />
      {noise && <path d={M_FACE} fill="url(#ck-noise)" />}
      <path d={M_COAMING_LOW} stroke="#000" strokeWidth={26} fill="none" opacity={0.2} />
      <Gauge x={66} y={112} size={118}>
        <Asi kmh={s.tas * 3.6} />
      </Gauge>
      <Gauge x={200} y={104} size={136}>
        <Vario ms={s.vario} avg={data.avgClimb} netto={data.netto} />
      </Gauge>
      <Gauge x={334} y={112} size={118}>
        <Altimeter m={s.altMsl} />
      </Gauge>
      <g transform="translate(12 186)">
        <FlightComputerCompact snap={snap} data={data} w={376} h={90} />
      </g>
      <path d={`${M_COAMING_TOP} L 440 66 C 340 26, 60 26, -40 66 Z`} fill="url(#ck-coaming)" />
      <path d={M_COAMING_TOP} stroke="#575d65" strokeWidth={1.6} fill="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ yaw string (Wollfaden) */

function YawString({ slip, tas, paused }: { slip: number; tas: number; paused: boolean }) {
  const path = useRef<SVGPathElement>(null);
  const fuzz = useRef<SVGPathElement>(null);
  const live = useRef({ tas, paused });
  live.current = { tas, paused };
  const t0 = useRef(0);
  useTween(
    slip,
    (v, time) => {
      if (!live.current.paused) t0.current = time;
      const t = t0.current;
      const tas = live.current.tas;
      const speed = Math.min(1.5, tas / 28);
      const slack = tas < 14 ? 1 - tas / 14 : 0; // limp on the ground
      // travelling wave along the wool, growing towards the free end
      const A = (0.6 + 1.1 * speed) * (1 - slack * 0.7);
      const w = (k: number) => (Math.sin(t * 19 - k * 2.1) * 0.6 + Math.sin(t * 31 - k * 3.3 + 1.1) * 0.4) * A * k;
      const defl = Math.max(-1, Math.min(1, v)) * 30;
      const L = 78 * (1 - slack * 0.35);
      const x = (k: number) => 20 + defl * k * k * 0.9 + defl * k * 0.1 + w(k) * 3.2 + slack * k * k * 6;
      const y = (k: number) => 84 - L * k + slack * k * k * 14;
      const f = (n: number) => n.toFixed(2);
      const d = `M20 84 C${f(x(0.33))} ${f(y(0.33))} ${f(x(0.66))} ${f(y(0.66))} ${f(x(1))} ${f(y(1))}`;
      path.current?.setAttribute("d", d);
      fuzz.current?.setAttribute("d", d);
    },
    { tau: 0.25, continuous: true },
  );
  return (
    <svg className="ck-yawstring" viewBox="-20 0 80 90" aria-hidden="true">
      <path ref={fuzz} stroke="#ff5a3c" strokeOpacity={0.3} strokeWidth={3.6} strokeLinecap="round" fill="none" />
      <path ref={path} stroke="#d92b16" strokeWidth={1.7} strokeLinecap="round" fill="none" />
      <rect x={14} y={80} width={12} height={8} rx={1.2} fill="#e9eef2" opacity={0.5} />
      <rect x={14} y={80} width={12} height={2.5} rx={1.2} fill="#fff" opacity={0.55} />
    </svg>
  );
}

/* ------------------------------------------------------------------ overlay */

type Look = { yaw: number; pitch: number };
type LiveDebug = { viewer?: { camera?: { frustum?: { fov?: number } } }; scene?: { rig?: { look?: Look } } };
/** The simulator's live (per-frame) head look and camera fov, when running inside FlightSim. */
function liveCamera(): { look?: Look; fov?: number } {
  const d = (window as unknown as { __flight?: LiveDebug }).__flight;
  return { look: d?.scene?.rig?.look, fov: d?.viewer?.camera?.frustum?.fov };
}

export function CockpitOverlayView({ snap, fovDeg = 72, getLook }: { snap: SimSnapshot; fovDeg?: number; getLook?: () => Look }) {
  const vp = useViewport();
  const compact = vp.w < 700 || vp.w / vp.h < 0.85;
  const cabin = useRef<HTMLDivElement>(null);
  const smooth = useRef({ yaw: snap.look?.yaw ?? 0, pitch: snap.look?.pitch ?? 0, t: 0 });
  const last = useRef("");
  const live = useRef({ look: snap.look, vp, fovDeg, getLook });
  live.current = { look: snap.look, vp, fovDeg, getLook };
  // Every frame: follow the live head look (in sync with the 3D camera) or ease towards the snapshot's.
  useTween(
    0,
    (_v, time) => {
      const el = cabin.current;
      if (!el) return;
      const L = live.current;
      const cam = liveCamera();
      let look = L.getLook?.() ?? cam.look;
      const sm = smooth.current;
      if (!look) {
        const dt = sm.t ? Math.min(0.1, time - sm.t) : 0;
        const k = 1 - Math.exp(-dt / 0.07);
        sm.yaw += ((L.look?.yaw ?? 0) - sm.yaw) * k;
        sm.pitch += ((L.look?.pitch ?? 0) - sm.pitch) * k;
        look = sm;
      }
      sm.t = time;
      const fov = cam.fov && cam.fov > 0.2 ? cam.fov : (L.fovDeg * Math.PI) / 180;
      const f = L.vp.h / 2 / Math.tan(fov / 2);
      const yaw = Math.max(-1.4, Math.min(1.4, look.yaw));
      const pitch = Math.max(-0.5, Math.min(1.3, look.pitch));
      const x = -f * Math.tan(yaw);
      const y = f * Math.tan(pitch);
      const o = 1 - Math.min(1, Math.max(0, (Math.abs(yaw) - 1.0) / 0.3));
      const key = `${x.toFixed(1)}|${y.toFixed(1)}|${o.toFixed(2)}`;
      if (key === last.current) return;
      last.current = key;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      el.style.opacity = o.toFixed(2);
      el.style.visibility = o <= 0 || Math.abs(x) > L.vp.w * 1.6 || y > L.vp.h ? "hidden" : "visible";
    },
    { continuous: true },
  );
  const s = snap.state;
  return (
    <div className={`ck-root ck-cockpit${compact ? " ck-compact" : ""}`}>
      <div className="ck-canopy" />
      <div className="ck-cabin" ref={cabin}>
        <YawString slip={slipOf(s)} tas={s.tas} paused={snap.paused} />
        {compact ? <MobilePanel snap={snap} /> : <DesktopPanel snap={snap} />}
      </div>
    </div>
  );
}
