/**
 * The glider's shape: a modern 15 m single-seater (Discus / LS8 class), built procedurally.
 *
 * Model frame (= glTF node space, loaded with upAxis Z / forwardAxis X so Cesium uses it as is):
 *   x forward, y LEFT, z up, metres, origin at the centre of gravity.
 * (The shared body frame in types.ts has y to the right; `eye` is converted on export.)
 *
 * Fuselage stations `s` run aft from the nose tip; X(s) converts to model x.
 */
import {
  Mesh, add, clamp, cross, curve, dot, ellipsoid, fan, grid, len, lerp3, limb, madd, norm, quad, rotate, samples, scale,
  smoothstep, sub, surfaceNormal, type V3,
} from "./mesh";

export const S_CG = 2.62;
export const X = (s: number) => S_CG - s;

/* ------------------------------------------------------------------ fuselage */

const L_FUS = 6.36;
const NOSE_R = 0.85;
const TAIL_R = 0.12;
// Nose kept low: everything opaque ahead of the pilot stays > 10.5° below the eye line (the 2D panel covers it).
const zcT = curve([[0, -0.19], [0.3, -0.185], [0.6, -0.17], [1.0, -0.15], [1.4, -0.135], [2.2, -0.13], [2.8, -0.12], [3.4, -0.09], [4.0, -0.04], [5.0, 0.0], [6.0, 0.03], [6.36, 0.035]]);
const htT = curve([[0, 0.07], [0.1, 0.075], [0.3, 0.068], [0.5, 0.082], [0.8, 0.115], [1.0, 0.15], [1.1, 0.2], [1.2, 0.265], [1.4, 0.39], [1.6, 0.47], [1.9, 0.45], [2.2, 0.36], [2.6, 0.27], [3.2, 0.22], [3.6, 0.2], [4.5, 0.11], [5.5, 0.075], [6.36, 0.068]]);
const hbT = curve([[0, 0.12], [0.1, 0.128], [0.3, 0.217], [0.5, 0.258], [0.7, 0.3], [1.2, 0.388], [2.0, 0.42], [2.6, 0.41], [3.2, 0.3], [3.8, 0.16], [4.5, 0.1], [5.5, 0.077], [6.36, 0.07]]);
const wT = curve([[0, 0.14], [0.1, 0.15], [0.3, 0.165], [0.5, 0.2], [0.7, 0.24], [0.85, 0.26], [1.2, 0.3], [1.7, 0.31], [2.3, 0.3], [2.8, 0.265], [3.3, 0.2], [3.8, 0.13], [4.5, 0.088], [5.5, 0.075], [6.36, 0.07]]);
const nBotT = curve([[0, 2.0], [0.5, 2.0], [1.2, 2.3], [2.4, 2.35], [3.6, 2.1], [4.5, 2.0]]);

function roundEnd(t: number) {
  return t >= 1 ? 1 : Math.sqrt(Math.max(0, t * (2 - t)));
}
const fusE = (s: number) => roundEnd(s / NOSE_R) * roundEnd((L_FUS - s) / TAIL_R);

export function fusDims(s: number, inset = 0) {
  const e = fusE(s);
  return {
    zc: zcT(s),
    w: Math.max(0.002, wT(s) * e - inset),
    a: Math.max(0.002, htT(s) * e - inset),
    b: Math.max(0.002, hbT(s) * e - inset),
    nb: nBotT(s),
  };
}

/** Fuselage surface: φ = 0 on top, +π/2 on the left side (+y), π underneath. */
export function fusPhi(s: number, phi: number, inset = 0): V3 {
  const d = fusDims(s, inset);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const n = cp >= 0 ? 2 : d.nb;
  const y = d.w * Math.sign(sp) * Math.pow(Math.abs(sp), 2 / n);
  const z = d.zc + (cp >= 0 ? d.a : d.b) * Math.sign(cp) * Math.pow(Math.abs(cp), 2 / n);
  return [X(s), y, z];
}

/* canopy outline in (s, φ): |φ| < canopyPhi(s) */
export const CANOPY_A = 0.48;
export const CANOPY_B = 2.13;
const FRAME_W = 0.018;
const TUB_INSET = 0.022;
const phiSideT = curve([[0.48, 1.4], [0.9, 1.6], [1.4, 1.6], [1.85, 1.42], [2.13, 1.22]]);
function canopyPhi(s: number) {
  if (s <= CANOPY_A || s >= CANOPY_B) return 0;
  const tf = (s - CANOPY_A) / 0.62;
  const tr = (CANOPY_B - s) / 0.2;
  const rf = tf >= 1 ? 1 : Math.pow(Math.max(0, 1 - Math.pow(1 - tf, 1.7)), 1 / 1.7);
  const rr = tr >= 1 ? 1 : Math.pow(Math.max(0, 1 - Math.pow(1 - tr, 3)), 1 / 3);
  return phiSideT(s) * rf * rr;
}
function inCanopy(s: number, phi: number) {
  const c = canopyPhi(s);
  if (c <= 0) return false;
  const p = Math.atan2(Math.sin(phi), Math.cos(phi));
  return Math.abs(p) < c;
}
const NA = 160; // segments around the fuselage

/* ------------------------------------------------------------------ lifting surfaces */

type Section = { le: V3; c: V3; n: V3; chord: number; t: number; m: number; p: number; tau: number };
type Side = { breaks: (eta: number) => number[]; counts: number[] };
type Surface = { station: (eta: number) => Section; upper: Side; lower: Side };

function naca(f: number, s: Section, upper: boolean) {
  const x = clamp(f, 0, 1);
  const yt = 5 * s.t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
  const { m, p } = s;
  const yc = m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
  return yc + (upper ? 1 : -1) * yt * s.tau;
}
function camber(f: number, s: Section) {
  return (naca(f, s, true) + naca(f, s, false)) / 2;
}
export function airfoilPoint(s: Section, f: number, upper: boolean): V3 {
  const y = naca(f, s, upper);
  return add(add(s.le, scale(s.c, f * s.chord)), scale(s.n, y * s.chord));
}
function camberPoint(s: Section, f: number): V3 {
  return add(add(s.le, scale(s.c, f * s.chord)), scale(s.n, camber(f, s) * s.chord));
}

/** loop parameter u ∈ [-1, 1]: lower TE → LE (u = 0) → upper TE */
function sideQ(side: Side) {
  const total = side.counts.reduce((a, b) => a + b, 0);
  const qb = [0];
  let acc = 0;
  for (const c of side.counts) qb.push((acc += c) / total);
  return qb;
}
function fracOf(side: Side, qb: number[], q: number, eta: number) {
  const br = [0, ...side.breaks(eta), 1];
  let k = 0;
  while (k < qb.length - 2 && q > qb[k + 1]!) k++;
  const t = clamp((q - qb[k]!) / (qb[k + 1]! - qb[k]!), 0, 1);
  if (k === 0) return br[1]! * (1 - Math.cos((t * Math.PI) / 2));
  return br[k]! + (br[k + 1]! - br[k]!) * t;
}

function surfaceSampler(surf: Surface) {
  const qu = sideQ(surf.upper);
  const ql = sideQ(surf.lower);
  const us: number[] = [];
  const seg: { upper: boolean; k: number }[] = [];
  const nl = surf.lower.counts.reduce((a, b) => a + b, 0);
  const nu = surf.upper.counts.reduce((a, b) => a + b, 0);
  for (let i = nl; i > 0; i--) us.push(-i / nl);
  for (let i = 0; i <= nu; i++) us.push(i / nu);
  // segment info
  const kOf = (counts: number[], idx: number) => {
    let acc = 0;
    for (let k = 0; k < counts.length; k++) {
      acc += counts[k]!;
      if (idx < acc) return k;
    }
    return counts.length - 1;
  };
  for (let j = 0; j < nl; j++) seg.push({ upper: false, k: kOf(surf.lower.counts, nl - 1 - j) });
  for (let j = 0; j < nu; j++) seg.push({ upper: true, k: kOf(surf.upper.counts, j) });
  const frac = (u: number, eta: number) => (u < 0 ? fracOf(surf.lower, ql, -u, eta) : fracOf(surf.upper, qu, u, eta));
  const fn = (eta: number, u: number): V3 => airfoilPoint(surf.station(eta), frac(u, eta), u >= 0);
  const flip = (eta: number, u: number, p: V3, n: V3) => {
    const s = surf.station(eta);
    const dn = dot(n, s.n);
    if (Math.abs(dn) > 0.25) return dn * (u >= 0 ? 1 : -1) < 0;
    return dot(n, sub(p, camberPoint(s, 0.5))) < 0;
  };
  return { us, seg, fn, flip, frac, qu, ql };
}

/* wing */
const W_E1 = 7.36; // end of the straight panel (path length)
const W_R = 0.19; // winglet transition radius
const W_G0 = (3 * Math.PI) / 180;
const W_G1 = (80 * Math.PI) / 180;
const W_E2 = W_E1 + W_R * (W_G1 - W_G0);
const W_END = W_E2 + 0.29;
function wingSpine(eta: number): { y: number; z: number; g: number } {
  if (eta <= W_E1) return { y: eta * Math.cos(W_G0), z: eta * Math.sin(W_G0), g: W_G0 };
  const y1 = W_E1 * Math.cos(W_G0), z1 = W_E1 * Math.sin(W_G0);
  if (eta <= W_E2) {
    const g = W_G0 + (eta - W_E1) / W_R;
    return { y: y1 + W_R * (Math.sin(g) - Math.sin(W_G0)), z: z1 + W_R * (Math.cos(W_G0) - Math.cos(g)), g };
  }
  const y2 = y1 + W_R * (Math.sin(W_G1) - Math.sin(W_G0)), z2 = z1 + W_R * (Math.cos(W_G0) - Math.cos(W_G1));
  const d = eta - W_E2;
  return { y: y2 + d * Math.cos(W_G1), z: z2 + d * Math.sin(W_G1), g: W_G1 };
}
const wChord = curve([[0, 1.02], [0.6, 0.98], [3.3, 0.79], [5.7, 0.49], [W_E1, 0.235], [W_E2, 0.18], [W_END, 0.075]]);
const wTE = curve([[0, 3.27], [3.3, 3.22], [5.7, 3.15], [W_E1, 3.20], [W_E2, 3.27], [W_END, 3.40]]);
const wTwist = curve([[0, 1.0], [W_E1, -1.0], [W_END, -1.5]]);
const wThick = curve([[0, 0.145], [W_E1, 0.105], [W_END, 0.09]]);
const wCamber = curve([[0, 0.03], [W_E1, 0.022], [W_END, 0.012]]);
const W_CLOSE = 0.035;

const AB0 = 2.0, AB1 = 3.4; // airbrake span (path length)
const ABF0 = 0.49, ABF1 = 0.565; // airbrake chord fractions
const AL0 = 4.05, AL1 = 7.18; // aileron span
const AL_H = 0.775; // hinge chord fraction at both ends
const G_C = 0.007; // chordwise seam (fraction)
const G_S = 0.008; // spanwise seam (m)

function wingSection(eta: number, sy: number): Section {
  const sp = wingSpine(eta);
  const chord = wChord(eta);
  const te = wTE(eta);
  const leS = te - chord;
  const n0: V3 = [0, -sy * Math.sin(sp.g), Math.cos(sp.g)];
  const c0: V3 = [-1, 0, 0];
  const th = (wTwist(eta) * Math.PI) / 180;
  const c = sub(scale(c0, Math.cos(th)), scale(n0, Math.sin(th)));
  const n = add(scale(n0, Math.cos(th)), scale(c0, Math.sin(th)));
  const leRaw: V3 = [X(leS), sy * sp.y, sp.z];
  const q = madd(leRaw, c0, 0.25 * chord);
  const le = madd(q, c, -0.25 * chord);
  const dEnd = W_END - eta;
  const tau = dEnd >= W_CLOSE ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow(1 - dEnd / W_CLOSE, 2)));
  return { le, c, n, chord, t: wThick(eta), m: wCamber(eta), p: 0.45, tau };
}
function wingTangent(eta: number, sy: number): V3 {
  const g = wingSpine(eta).g;
  return [0, sy * Math.cos(g), Math.sin(g)];
}
/** hinge chord fraction on a straight hinge line between the aileron ends */
function wingHinge(eta: number) {
  const s0 = wTE(AL0) - wChord(AL0) * (1 - AL_H);
  const s1 = wTE(AL1) - wChord(AL1) * (1 - AL_H);
  const t = clamp((eta - AL0) / (AL1 - AL0), 0, 1);
  const hs = s0 + (s1 - s0) * t;
  const chord = wChord(eta);
  return clamp((hs - (wTE(eta) - chord)) / chord, 0.62, 0.86);
}

/* fin */
const Z_TOP = 1.16;
const FIN_Z0 = -0.075;
const RUD_Z1 = Z_TOP - 0.04;
const HINGE_FIN = 6.33;
const finLE = (z: number) => 5.86 + ((z - 0.1) * 0.30) / (Z_TOP - 0.1);
const finTE = (z: number) => 6.64 - ((z - FIN_Z0) * 0.12) / (Z_TOP - FIN_Z0);
function finSection(z: number): Section {
  const le = finLE(z);
  const chord = finTE(z) - le;
  const t = 0.1 + 0.02 * smoothstep(0.25, -0.02, z); // a little fuller at the root (fillet)
  return { le: [X(le), 0, z], c: [-1, 0, 0], n: [0, 1, 0], chord, t, m: 0, p: 0.4, tau: 1 };
}
const finHinge = (z: number) => clamp((HINGE_FIN - finLE(z)) / (finTE(z) - finLE(z)), 0.3, 0.95);

/* stabiliser */
const STAB_HALF = 1.06;
const HINGE_STAB = 6.33;
const STAB_TE = 6.545;
const EL_IN = 0.045;
function stabLE(eta: number) {
  let le = 5.93 + 0.17 * Math.pow(eta / STAB_HALF, 1.3);
  const t0 = STAB_HALF - 0.14;
  if (eta > t0) {
    const u = Math.min(1, (eta - t0) / 0.14);
    le += 0.13 * u * u * u;
  }
  return le;
}
function stabSection(eta: number, sy: number): Section {
  const le = stabLE(eta);
  const chord = STAB_TE - le;
  const dEnd = STAB_HALF - eta;
  const tau = dEnd >= 0.02 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow(1 - dEnd / 0.02, 2)));
  return { le: [X(le), sy * eta, Z_TOP], c: [-1, 0, 0], n: [0, 0, 1], chord, t: 0.105, m: 0, p: 0.4, tau };
}
const stabHinge = (eta: number) => clamp((HINGE_STAB - stabLE(eta)) / (STAB_TE - stabLE(eta)), 0.05, 0.95);

/* ------------------------------------------------------------------ build */

export type Hinge = { p: V3; axis: V3 };
export type GliderGeometry = {
  meshes: Record<NodeName, Mesh>;
  hinges: { aileronL: Hinge; aileronR: Hinge; elevator: Hinge; rudder: Hinge; stick: { p: V3 } };
  brakeDir: { L: V3; R: V3 };
  /** eye in the model frame (y left) */
  eye: V3;
  decal: { aspect: number };
};
export const NODE_NAMES = ["body", "aileronL", "aileronR", "elevator", "rudder", "brakeL", "brakeR", "stick", "pilot", "cockpit"] as const;
export type NodeName = (typeof NODE_NAMES)[number];

export const EYE_S = 1.62;
export const EYE_Z = 0.115;

export function buildGlider(): GliderGeometry {
  const meshes = Object.fromEntries(NODE_NAMES.map((n) => [n, new Mesh()])) as Record<NodeName, Mesh>;
  const body = meshes.body;

  /* ---------------- fuselage shell, canopy, cockpit tub */
  const step = (s: number) => {
    const dA = Math.abs(s - CANOPY_A), dB = Math.abs(s - CANOPY_B);
    if (s < 0.04) return 0.008;
    if (s < 0.25) return 0.025;
    if (dA < 0.05 || dB < 0.05) return 0.008;
    if (s > CANOPY_A && s < CANOPY_B) return 0.014;
    if (dA < 0.14 || dB < 0.12) return 0.016;
    if (s > L_FUS - 0.15) return 0.02;
    return 0.045;
  };
  const ss = samples(0, L_FUS, step, [CANOPY_A, CANOPY_B]);
  // columns evenly spaced by arc length around a reference section (the super-ellipse parameter
  // stretches near the side line, which would make the canopy cut-out ragged)
  const phis = (() => {
    const M = 4000;
    const cum = [0];
    let prev = fusPhi(1.5, 0);
    for (let k = 1; k <= M; k++) {
      const p = fusPhi(1.5, (2 * Math.PI * k) / M);
      cum.push(cum[k - 1]! + len(sub(p, prev)));
      prev = p;
    }
    const total = cum[M]!;
    const out = [0];
    let j = 0;
    for (let k = 1; k < NA; k++) {
      const target = (total * k) / NA;
      while (cum[j + 1]! < target) j++;
      const t = (target - cum[j]!) / (cum[j + 1]! - cum[j]!);
      out.push(((j + t) * 2 * Math.PI) / M);
    }
    out.push(2 * Math.PI);
    return out;
  })();
  const fusFlip = (s: number, _t: number, p: V3, n: V3) => {
    const sc = clamp(s, 0.35, L_FUS - 0.3);
    return dot(n, sub(p, [X(sc), 0, zcT(sc)])) < 0;
  };
  const inFlip = (s: number, t: number, p: V3, n: V3) => !fusFlip(s, t, p, n);
  const WHEEL_S = 2.42;
  grid(body, {
    as: ss,
    bs: phis,
    fn: fusPhi,
    wrapB: true,
    flip: fusFlip,
    mat: (i, j) => {
      const sm = (ss[i]! + ss[i + 1]!) / 2;
      const pm = (phis[j]! + phis[j + 1]!) / 2;
      if (inCanopy(sm, pm)) return null;
      const p = fusPhi(sm, pm);
      if (Math.abs(sm - WHEEL_S) < 0.23 && Math.abs(p[1]) < 0.07 && p[2] < zcT(sm) - 0.2) return "well";
      if (Math.abs(sm - 6.12) < 0.08 && Math.abs(p[1]) < 0.03 && p[2] < zcT(sm)) return "well";
      return "white";
    },
  });
  // canopy glass: its own grid over the outline, exactly on the fuselage surface
  {
    const gs = ss.filter((s) => s >= CANOPY_A - 1e-9 && s <= CANOPY_B + 1e-9);
    const vs = Array.from({ length: 49 }, (_, k) => -1 + (2 * k) / 48);
    const glass = (s: number, v: number) => fusPhi(s, v * canopyPhi(s));
    grid(body, { as: gs, bs: vs, fn: glass, flip: fusFlip, mat: () => "glassOut" });
    grid(body, { as: gs, bs: vs, fn: glass, flip: inFlip, mat: () => "glassIn" });
    // cockpit tub lining (inset), from the canopy edge around underneath to the other edge
    const vt = Array.from({ length: NA + 1 }, (_, k) => k / NA);
    grid(body, {
      as: gs,
      bs: vt,
      fn: (s, v) => {
        const c = canopyPhi(s);
        return fusPhi(s, c + v * (2 * Math.PI - 2 * c), TUB_INSET);
      },
      flip: inFlip,
      mat: () => "interior",
    });
    // bulkheads, kept well inside the shell
    const ringIn = (s: number) => phis.slice(0, NA).map((phi) => fusPhi(s, phi, TUB_INSET + 0.001));
    fan(body, "interior", ringIn(CANOPY_A + 0.01), [-1, 0, 0]);
    fan(body, "interior", ringIn(CANOPY_B - 0.025), [1, 0, 0]);
  }
  // canopy frame: a slightly raised dark seal ribbon along the outline + a wall down to the tub
  {
    const dense: [number, number][] = [];
    const N = 4000;
    for (let k = 0; k <= N; k++) {
      const s = CANOPY_A + ((CANOPY_B - CANOPY_A) * (1 - Math.cos((Math.PI * k) / N))) / 2;
      dense.push([s, canopyPhi(s)]);
    }
    for (let k = N - 1; k > 0; k--) {
      const s = CANOPY_A + ((CANOPY_B - CANOPY_A) * (1 - Math.cos((Math.PI * k) / N))) / 2;
      dense.push([s, -canopyPhi(s)]);
    }
    const pts = dense.map(([s, phi]) => fusPhi(s, phi));
    const cum = [0];
    for (let k = 1; k <= pts.length; k++) cum.push(cum[k - 1]! + len(sub(pts[k % pts.length]!, pts[k - 1]!)));
    const total = cum[cum.length - 1]!;
    const M = Math.round(total / 0.006);
    const params: [number, number][] = [];
    let seg = 0;
    for (let k = 0; k < M; k++) {
      const d = (total * k) / M;
      while (cum[seg + 1]! < d) seg++;
      const t = (d - cum[seg]!) / (cum[seg + 1]! - cum[seg]!);
      const a = dense[seg]!, b = dense[(seg + 1) % dense.length]!;
      params.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    const P = params.map(([s, phi]) => fusPhi(s, phi));
    const prim = body.get("frame");
    const rows: number[][] = [];
    for (let k = 0; k < M; k++) {
      const [s, phi] = params[k]!;
      const p = P[k]!;
      let n = surfaceNormal(fusPhi, s, phi, 0, L_FUS, -10, 10);
      if (fusFlip(s, 0, p, n)) n = scale(n, -1);
      const T = sub(P[(k + 1) % M]!, P[(k + M - 1) % M]!);
      const B = norm(cross(n, T));
      // project p ± B·h back onto the surface (a few Gauss-Newton steps in (s, φ))
      const onSurface = (h: number) => {
        const target = madd(p, B, h);
        let ss_ = s, pp = phi;
        const e = 1e-5;
        for (let it = 0; it < 6; it++) {
          const q = fusPhi(ss_, pp);
          const r = sub(target, q);
          const Ps = scale(sub(fusPhi(ss_ + e, pp), fusPhi(ss_ - e, pp)), 1 / (2 * e));
          const Pp = scale(sub(fusPhi(ss_, pp + e), fusPhi(ss_, pp - e)), 1 / (2 * e));
          const a11 = dot(Ps, Ps), a12 = dot(Ps, Pp), a22 = dot(Pp, Pp);
          const det = a11 * a22 - a12 * a12;
          const b1 = dot(Ps, r), b2 = dot(Pp, r);
          const ds = clamp((a22 * b1 - a12 * b2) / det, -0.02, 0.02);
          const dp = clamp((a11 * b2 - a12 * b1) / det, -0.05, 0.05);
          ss_ += ds;
          pp += dp;
          if (Math.abs(ds) < 1e-6 && Math.abs(dp) < 1e-6) break;
        }
        return fusPhi(ss_, pp);
      };
      const row = [
        prim.vertex(madd(onSurface(-FRAME_W / 2), n, 0.0008), n),
        prim.vertex(madd(p, n, 0.0024), n),
        prim.vertex(madd(onSurface(FRAME_W / 2), n, 0.0008), n),
      ];
      // wall from the seal down to the tub
      const bottom = fusPhi(s, phi, TUB_INSET + 0.002);
      const wn = norm(cross(T, sub(bottom, p)));
      row.push(prim.vertex(p, wn), prim.vertex(bottom, wn));
      rows.push(row);
    }
    for (let k = 0; k < M; k++) {
      const r0 = rows[k]!, r1 = rows[(k + 1) % M]!;
      for (const [x, y] of [[0, 1], [1, 2], [3, 4]] as const) {
        prim.tri(r0[x]!, r1[x]!, r1[y]!);
        prim.tri(r0[x]!, r1[y]!, r0[y]!);
      }
    }
  }

  /* ---------------- instrument panel coaming + panel */
  {
    const cm = meshes.cockpit;
    const s0 = 0.84, s1 = 1.13;
    const halfW = (s: number, z: number) => {
      const d = fusDims(s, 0.022);
      const r = clamp((z - d.zc) / (z > d.zc ? d.a : d.b), -1, 1);
      return d.w * Math.sqrt(Math.max(0, 1 - r * r));
    };
    const zTopH = (s: number) => -0.075 - (s1 - s) * 0.12;
    const zSide = -0.14;
    const hood = (s: number, v: number): V3 => {
      const z = zTopH(s) - (zTopH(s) - zSide) * v * v;
      return [X(s), v * halfW(s, z) * 0.995, z];
    };
    const as = Array.from({ length: 9 }, (_, i) => s0 + ((s1 - s0) * i) / 8);
    const bs = Array.from({ length: 25 }, (_, i) => -1 + (2 * i) / 24);
    grid(cm, { as, bs, fn: hood, mat: () => "coaming", flip: (_a, _b, _p, n) => n[2] < 0 });
    // rounded lip under the rear edge
    const lip = (v: number, a: number): V3 => {
      const p = hood(s1, v);
      return [p[0] - 0.012 * Math.sin(a), p[1], p[2] - 0.012 * (1 - Math.cos(a))];
    };
    grid(cm, { as: bs, bs: [0, 0.8, 1.6, 2.4, Math.PI], fn: lip, mat: () => "coaming", flip: (_a, _b, _p, n) => n[0] > 0 });
    // panel face (textured), tilted towards the pilot
    const top = zTopH(s1) - 0.024;
    const bot = -0.33;
    const sTop = s1 - 0.004, sBot = s1 + 0.07;
    const hw = 0.205;
    const prim = cm.get("panel");
    const nrm = norm([-(top - bot), 0, -(sTop - sBot)]);
    const v = (s: number, y: number, z: number, u: number, w: number) => prim.vertex([X(s), y, z], nrm, [u, w]);
    // The face leans toward the eye; its upper edge follows the curved glare shield.
    // Preserve planar UVs so round instrument faces stay round on the surface.
    for (let i = 0; i < 16; i++) {
      const edge = (u: number, upper: boolean) => {
        const y = hw * (1 - 2 * u);
        const z = upper ? top - 0.025 * (y / hw) ** 2 : bot;
        const t = (top - z) / (top - bot);
        return v(sTop + (sBot - sTop) * t, y, z, u, t);
      };
      const a=edge(i/16,true), b=edge((i+1)/16,true), c=edge((i+1)/16,false), d=edge(i/16,false);
      prim.tri(a,b,c);prim.tri(a,c,d);
    }
    // panel surround (fills the gap between the panel and the tub)
    for (const sy of [1, -1]) {
      const zs = [top - 0.025, (top + bot) / 2, bot];
      for (let k = 0; k < 2; k++) {
        const za = zs[k]!, zb = zs[k + 1]!;
        const sa = sTop + ((sBot - sTop) * (za - top)) / (bot - top);
        const sb = sTop + ((sBot - sTop) * (zb - top)) / (bot - top);
        quad(cm, "coaming", [X(sa), sy * hw, za], [X(sa), sy * halfW(sa, za), za], [X(sb), sy * halfW(sb, zb), zb], [X(sb), sy * hw, zb], [-1, 0, 0]);
      }
    }
  }

  /* ---------------- wings */
  const hinges = {} as GliderGeometry["hinges"];
  const brakeDir = {} as GliderGeometry["brakeDir"];
  const wingEtas = samples(0, W_END, (e) => (e < 0.4 ? 0.08 : e < 6.9 ? 0.1 : e < W_E1 ? 0.04 : e < W_E2 ? 0.012 : W_END - e < 0.05 ? 0.006 : 0.025), [
    AB0, AB0 + G_S, AB1 - G_S, AB1, AL0, AL0 + G_S, AL1 - G_S, AL1, W_E1, W_E2,
  ]);
  const wingSurf = (sy: number): Surface => ({
    station: (eta) => wingSection(eta, sy),
    upper: { breaks: (eta) => [ABF0, ABF0 + G_C, ABF1 - G_C, ABF1, wingHinge(eta), wingHinge(eta) + G_C], counts: [16, 1, 3, 1, 10, 1, 8] },
    lower: { breaks: (eta) => [wingHinge(eta), wingHinge(eta) + G_C], counts: [28, 1, 8] },
  });
  for (const sy of [1, -1]) {
    const surf = wingSurf(sy);
    const smp = surfaceSampler(surf);
    const ail = sy > 0 ? meshes.aileronL : meshes.aileronR;
    const brk = sy > 0 ? meshes.brakeL : meshes.brakeR;
    const inR = (e: number, a: number, b: number) => e > a && e < b;
    grid(body, {
      as: wingEtas,
      bs: smp.us,
      fn: smp.fn,
      flip: smp.flip,
      mat: (i, j) => {
        const e = (wingEtas[i]! + wingEtas[i + 1]!) / 2;
        const sg = smp.seg[j]!;
        if (sg.upper && sg.k >= 1 && sg.k <= 3 && inR(e, AB0, AB1)) {
          if (sg.k === 2 && inR(e, AB0 + G_S, AB1 - G_S)) return [brk, "whiteDS"];
          return "seam";
        }
        if (inR(e, AL0, AL1)) {
          const seamK = sg.upper ? 5 : 1;
          const ailK = sg.upper ? 6 : 2;
          if (sg.k === seamK) return "seam";
          if (sg.k === ailK) return inR(e, AL0 + G_S, AL1 - G_S) ? [ail, "white"] : "seam";
        }
        return e > W_E2 ? "navy" : "white";
      },
    });

    /* aileron nose + end caps */
    const ailEtas = wingEtas.filter((e) => e >= AL0 + G_S - 1e-9 && e <= AL1 - G_S + 1e-9);
    const hingeC = (eta: number) => {
      const s = wingSection(eta, sy);
      const f = wingHinge(eta) + G_C;
      const pu = airfoilPoint(s, f, true), pl = airfoilPoint(s, f, false);
      return { s, pu, pl, c: lerp3(pu, pl, 0.5), r: len(sub(pu, pl)) / 2, nh: norm(sub(pu, pl)) };
    };
    const noseFn = (eta: number, a: number): V3 => {
      const h = hingeC(eta);
      return add(add(h.c, scale(h.nh, h.r * Math.cos(a))), scale(h.s.c, -h.r * Math.sin(a)));
    };
    const alphas = Array.from({ length: 13 }, (_, i) => (Math.PI * i) / 12);
    grid(ail, { as: ailEtas, bs: alphas, fn: noseFn, mat: () => "white", flip: (eta, _a, p, n) => dot(n, sub(p, hingeC(eta).c)) < 0 });
    const capLoop = (eta: number) => {
      const lower: V3[] = [], upper: V3[] = [];
      for (const u of smp.us) {
        if (smp.frac(u, eta) >= wingHinge(eta) + G_C - 1e-6) (u < 0 ? lower : upper).push(smp.fn(eta, u));
      }
      const nose = alphas.slice(1, -1).map((a) => noseFn(eta, a)).reverse();
      return [...upper, ...lower, ...nose];
    };
    fan(ail, "white", capLoop(AL0 + G_S), scale(wingTangent(AL0, sy), -1));
    fan(ail, "white", capLoop(AL1 - G_S), wingTangent(AL1, sy));
    const h0 = hingeC(AL0 + G_S).c, h1 = hingeC(AL1 - G_S).c;
    let axis = norm(sub(h1, h0));
    // orient: positive rotation lifts the trailing edge
    const teP = airfoilPoint(wingSection((AL0 + AL1) / 2, sy), 1, true);
    const lifted = add(h0, rotate(sub(teP, h0), axis, 0.1));
    if (lifted[2] < teP[2]) axis = scale(axis, -1);
    hinges[sy > 0 ? "aileronL" : "aileronR"] = { p: h0, axis };

    /* airbrake: cap is in the brake mesh; blade below it; box in the wing */
    const brEtas = wingEtas.filter((e) => e >= AB0 + G_S - 1e-9 && e <= AB1 - G_S + 1e-9);
    const fA = ABF0 + G_C, fB = ABF1 - G_C;
    const DEPTH = 0.1;
    for (let k = 0; k < brEtas.length - 1; k++) {
      const e0 = brEtas[k]!, e1 = brEtas[k + 1]!;
      const s0 = wingSection(e0, sy), s1 = wingSection(e1, sy);
      const fm = (fA + fB) / 2;
      // blade (two faces, 3 mm apart)
      for (const off of [-0.0015, 0.0015]) {
        const a = madd(madd(airfoilPoint(s0, fm, true), s0.c, off), s0.n, -0.003);
        const b = madd(madd(airfoilPoint(s1, fm, true), s1.c, off), s1.n, -0.003);
        quad(brk, "metal", a, b, madd(b, s1.n, -DEPTH), madd(a, s0.n, -DEPTH), scale(s0.c, off));
      }
      // box walls fore/aft
      for (const [f, dir] of [[fA, 1], [fB, -1]] as const) {
        const a = airfoilPoint(s0, f, true), b = airfoilPoint(s1, f, true);
        quad(body, "cavity", a, b, madd(b, s1.n, -DEPTH), madd(a, s0.n, -DEPTH), scale(s0.c, dir));
      }
      // box floor
      const a = madd(airfoilPoint(s0, fA, true), s0.n, -DEPTH), b = madd(airfoilPoint(s1, fA, true), s1.n, -DEPTH);
      const c = madd(airfoilPoint(s1, fB, true), s1.n, -DEPTH), d = madd(airfoilPoint(s0, fB, true), s0.n, -DEPTH);
      quad(body, "cavity", a, b, c, d, s0.n);
    }
    for (const [e, dir] of [[AB0 + G_S, 1], [AB1 - G_S, -1]] as const) {
      const s = wingSection(e, sy);
      const T = scale(wingTangent(e, sy), dir);
      const a = airfoilPoint(s, fA, true), b = airfoilPoint(s, fB, true);
      quad(body, "cavity", a, b, madd(b, s.n, -DEPTH), madd(a, s.n, -DEPTH), T);
      const fm = (fA + fB) / 2;
      const p = madd(airfoilPoint(s, fm, true), s.n, -0.003);
      quad(brk, "metal", madd(p, s.c, -0.0015), madd(p, s.c, 0.0015), madd(madd(p, s.c, 0.0015), s.n, -DEPTH), madd(madd(p, s.c, -0.0015), s.n, -DEPTH), T);
    }
    brakeDir[sy > 0 ? "L" : "R"] = wingSection((AB0 + AB1) / 2, sy).n;
  }

  /* ---------------- fin + rudder */
  {
    const finZ = samples(FIN_Z0, Z_TOP, (z) => (z < 0.12 ? 0.02 : 0.05), [0.0, RUD_Z1]);
    const surf: Surface = {
      station: finSection,
      upper: { breaks: (z) => [finHinge(z), finHinge(z) + 0.012], counts: [18, 1, 9] },
      lower: { breaks: (z) => [finHinge(z), finHinge(z) + 0.012], counts: [18, 1, 9] },
    };
    const smp = surfaceSampler(surf);
    grid(body, {
      as: finZ,
      bs: smp.us,
      fn: smp.fn,
      flip: smp.flip,
      mat: (i, j) => {
        const z = (finZ[i]! + finZ[i + 1]!) / 2;
        const k = smp.seg[j]!.k;
        if (k === 2 && z < RUD_Z1) return [meshes.rudder, "white"];
        if (z < 0) return null;
        return k === 1 && z < RUD_Z1 ? "seam" : (z > 0.35 && k === 0 ? "navy" : "white");
      },
    });
    const rz = finZ.filter((z) => z <= RUD_Z1 + 1e-9);
    const hingeC = (z: number) => {
      const s = finSection(z);
      const f = finHinge(z) + 0.012;
      const pu = airfoilPoint(s, f, true), pl = airfoilPoint(s, f, false);
      return { s, c: lerp3(pu, pl, 0.5), r: len(sub(pu, pl)) / 2, nh: norm(sub(pu, pl)) };
    };
    const noseFn = (z: number, a: number): V3 => {
      const h = hingeC(z);
      return add(add(h.c, scale(h.nh, h.r * Math.cos(a))), scale(h.s.c, -h.r * Math.sin(a)));
    };
    const alphas = Array.from({ length: 13 }, (_, i) => (Math.PI * i) / 12);
    grid(meshes.rudder, { as: rz, bs: alphas, fn: noseFn, mat: () => "white", flip: (z, _a, p, n) => dot(n, sub(p, hingeC(z).c)) < 0 });
    const capLoop = (z: number) => {
      const lower: V3[] = [], upper: V3[] = [];
      for (const u of smp.us) {
        const f = smp.frac(u, z);
        if (f >= finHinge(z) + 0.012 - 1e-6) (u < 0 ? lower : upper).push(smp.fn(z, u));
      }
      const nose = alphas.slice(1, -1).map((a) => noseFn(z, a)).reverse();
      return [...upper, ...lower, ...nose];
    };
    fan(meshes.rudder, "white", capLoop(FIN_Z0), [0, 0, -1]);
    fan(meshes.rudder, "white", capLoop(RUD_Z1), [0, 0, 1]);
    const p = hingeC(0.5).c;
    let axis: V3 = [0, 0, 1];
    // positive rotation swings the trailing edge to the right (−y)
    const te: V3 = [X(6.7), 0, 0.5];
    if (add(p, rotate(sub(te, p), axis, 0.1))[1] > 0) axis = [0, 0, -1];
    hinges.rudder = { p, axis };
    // T-tail bullet fairing
    ellipsoid(body, "white", [X(6.29), 0, Z_TOP], [0.41, 0, 0], [0, 0.047, 0], [0, 0, 0.047], 32);
  }

  /* ---------------- stabiliser + elevator */
  {
    const etas = samples(0, STAB_HALF, (e) => (STAB_HALF - e < 0.03 ? 0.004 : STAB_HALF - e < 0.16 ? 0.012 : 0.05), [EL_IN]);
    for (const sy of [1, -1]) {
      const surf: Surface = {
        station: (e) => stabSection(e, sy),
        upper: { breaks: (e) => [stabHinge(e), stabHinge(e) + 0.012], counts: [16, 1, 9] },
        lower: { breaks: (e) => [stabHinge(e), stabHinge(e) + 0.012], counts: [16, 1, 9] },
      };
      const smp = surfaceSampler(surf);
      grid(body, {
        as: etas,
        bs: smp.us,
        fn: smp.fn,
        flip: smp.flip,
        mat: (i, j) => {
          const e = (etas[i]! + etas[i + 1]!) / 2;
          const k = smp.seg[j]!.k;
          if (k === 2) return e > EL_IN ? [meshes.elevator, "white"] : null;
          return k === 1 ? "seam" : "white";
        },
      });
      const elE = etas.filter((e) => e >= EL_IN - 1e-9);
      const hingeC = (e: number) => {
        const s = stabSection(e, sy);
        const f = stabHinge(e) + 0.012;
        const pu = airfoilPoint(s, f, true), pl = airfoilPoint(s, f, false);
        return { s, c: lerp3(pu, pl, 0.5), r: len(sub(pu, pl)) / 2, nh: norm(sub(pu, pl)) };
      };
      const noseFn = (e: number, a: number): V3 => {
        const h = hingeC(e);
        return add(add(h.c, scale(h.nh, h.r * Math.cos(a))), scale(h.s.c, -h.r * Math.sin(a)));
      };
      const alphas = Array.from({ length: 13 }, (_, i) => (Math.PI * i) / 12);
      grid(meshes.elevator, { as: elE, bs: alphas, fn: noseFn, mat: () => "white", flip: (e, _a, p, n) => dot(n, sub(p, hingeC(e).c)) < 0 });
      const lower: V3[] = [], upper: V3[] = [];
      for (const u of smp.us) {
        const f = smp.frac(u, EL_IN);
        if (f >= stabHinge(EL_IN) + 0.012 - 1e-6) (u < 0 ? lower : upper).push(smp.fn(EL_IN, u));
      }
      const nose = alphas.slice(1, -1).map((a) => noseFn(EL_IN, a)).reverse();
      fan(meshes.elevator, "white", [...upper, ...lower, ...nose], [0, -sy, 0]);
    }
    const s = stabSection(0, 1);
    const f = stabHinge(0) + 0.012;
    const p = lerp3(airfoilPoint(s, f, true), airfoilPoint(s, f, false), 0.5);
    let axis: V3 = [0, 1, 0];
    const te: V3 = [X(STAB_TE), 0, Z_TOP];
    if (add(p, rotate(sub(te, p), axis, 0.1))[2] < Z_TOP) axis = [0, -1, 0];
    hinges.elevator = { p, axis };
  }

  /* ---------------- wheels */
  const wheel = (s: number, zc: number, R: number, tube: number, halfW: number) => {
    const c: V3 = [X(s), 0, zc];
    const R0 = R - tube;
    const fn = (th: number, ps: number): V3 => {
      const r = R0 + tube * Math.cos(ps);
      return [c[0] + r * Math.cos(th), halfW * Math.sin(ps), c[2] + r * Math.sin(th)];
    };
    const ths = Array.from({ length: 41 }, (_, i) => (2 * Math.PI * i) / 40);
    const pss = Array.from({ length: 17 }, (_, i) => (2 * Math.PI * i) / 16);
    grid(body, {
      as: ths, bs: pss, fn, wrapB: true, mat: () => "tire",
      flip: (th, _ps, p, n) => dot(n, sub(p, [c[0] + R0 * Math.cos(th), 0, c[2] + R0 * Math.sin(th)])) < 0,
    });
    for (const sy of [1, -1]) {
      const loop = ths.slice(0, 40).map((th): V3 => [c[0] + R0 * Math.cos(th), sy * halfW * 0.75, c[2] + R0 * Math.sin(th)]);
      fan(body, "metal", loop, [0, sy, 0]);
    }
  };
  const zbAt = (s: number) => {
    const d = fusDims(s);
    return d.zc - d.b;
  };
  wheel(WHEEL_S, zbAt(WHEEL_S) + 0.065, 0.19, 0.06, 0.058);
  wheel(6.12, zbAt(6.12) - 0.012, 0.055, 0.02, 0.022);

  /* ---------------- pilot + stick */
  {
    const pm = meshes.pilot;
    const P = (s: number, y: number, z: number): V3 => [X(s), y, z + 0.055];
    ellipsoid(pm, "skin", P(1.7, 0, 0.085), [0.098, 0, 0], [0, 0.08, 0], [0, 0, 0.11], 28);
    const hairAxis = norm([0.55, 0, 1]);
    const hx = norm(cross(hairAxis, [0, 1, 0]));
    ellipsoid(pm, "hair", P(1.715, 0, 0.098), scale(hx, 0.1), [0, 0.086, 0], scale(hairAxis, 0.112), 28, { vTo: 1.75 });
    limb(pm, "skin", P(1.74, 0, -0.04), P(1.72, 0, 0.03), 0.048);
    ellipsoid(pm, "shirt", P(1.8, 0, -0.1), [0.085, 0, 0], [0, 0.2, 0], [0, 0, 0.075], 24);
    limb(pm, "shirt", P(1.8, 0, -0.12), P(1.42, 0, -0.38), 0.11, 0.17);
    for (const sy of [1, -1]) {
      limb(pm, "shirt", P(1.8, sy * 0.19, -0.12), P(1.56, sy * 0.2, -0.32), 0.046);
      limb(pm, "trousers", P(1.42, sy * 0.09, -0.41), P(1.0, sy * 0.1, -0.3), 0.064);
      limb(pm, "trousers", P(1.0, sy * 0.1, -0.3), P(0.7, sy * 0.11, -0.39), 0.05);
    }
    limb(pm, "shirt", P(1.56, 0.2, -0.32), P(1.3, 0.13, -0.31), 0.036);
    ellipsoid(pm, "skin", P(1.255, 0.12, -0.31), [0.04, 0, 0], [0, 0.03, 0], [0, 0, 0.018], 14);
    limb(pm, "shirt", P(1.56, -0.2, -0.32), P(1.33, -0.05, -0.27), 0.036);
    // stick (hinged at the floor) with the right hand on it
    const sm = meshes.stick;
    const base = P(1.24, 0, -0.52);
    const top = P(1.29, 0, -0.27);
    limb(sm, "stick", base, top, 0.011, 0.011, [1, 0, 0], 12);
    ellipsoid(sm, "stick", madd(top, [0, 0, 1], 0.02), [0.018, 0, 0], [0, 0.018, 0], [0, 0, 0.042], 14);
    ellipsoid(sm, "skin", madd(top, [0.004, -0.012, 1], 0.012), [0.035, 0, 0], [0, 0.028, 0], [0, 0, 0.034], 14);
    hinges.stick = { p: base };
  }

  return {
    meshes,
    hinges,
    brakeDir,
    eye: [X(EYE_S), 0, EYE_Z],
    decal: { aspect: DECAL.length / DECAL.height },
  };
}

/* ------------------------------------------------------------------ registration decals */

export const DECAL = { s0: 3.42, length: 1.0, zMid: -0.025, height: 0.13 };

/** Decal patches on both sides of the tail boom, slightly lifted off the gelcoat. */
export function buildDecals(mesh: Mesh) {
  const { s0, length, zMid, height } = DECAL;
  const z0 = zMid - height / 2, z1 = zMid + height / 2;
  const phiAt = (s: number, z: number, side: number) => {
    // z decreases monotonically from φ = 0 (top) to φ = π (bottom)
    let lo = 0.05, hi = Math.PI - 0.05;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (fusPhi(s, mid)[2] > z) lo = mid;
      else hi = mid;
    }
    return side * (lo + hi) / 2;
  };
  for (const side of [1, -1]) {
    const as = Array.from({ length: 41 }, (_, i) => s0 + (length * i) / 40);
    const bs = Array.from({ length: 9 }, (_, i) => z0 + (height * i) / 8);
    grid(mesh, {
      as,
      bs,
      fn: (s, z) => fusPhi(s, phiAt(s, z, side)),
      flip: (s, _z, p, n) => dot(n, sub(p, [X(s), 0, zcT(s)])) < 0,
      offset: 0.0015,
      mat: () => "decal",
      uv: (s, z) => {
        const u = (s - s0) / length;
        return [side > 0 ? u : 1 - u, (z1 - z) / height];
      },
    });
  }
}
