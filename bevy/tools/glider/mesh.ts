/**
 * Geometry helpers for the procedural glider: parametric surface grids with analytic-ish smooth
 * normals, flat caps/strips, ellipsoids. Everything is built once at load time.
 */
import type { GlbPrimitive } from "./glb";

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const madd = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Rotate v about unit axis k by angle (Rodrigues). */
export function rotate(v: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
}

/** Monotone cubic (Fritsch–Carlson) interpolation through a table of [x, y]; clamped outside. */
export function curve(table: [number, number][]) {
  const n = table.length;
  const xs = table.map((r) => r[0]);
  const ys = table.map((r) => r[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!;
  };
}

/** Sorted sample list: a base spacing plus exact breakpoints (near-duplicates of a breakpoint dropped). */
export function samples(from: number, to: number, step: (x: number) => number, breaks: number[] = []): number[] {
  const out: number[] = [];
  let x = from;
  while (x < to - 1e-9) {
    out.push(x);
    x += step(x);
  }
  out.push(to);
  const bs = breaks.filter((b) => b > from && b < to);
  const all = out.filter((v) => bs.every((b) => Math.abs(v - b) > Math.min(0.35 * step(v), 0.02)) || v === from || v === to).concat(bs);
  all.sort((a, b) => a - b);
  return all.filter((v, i) => i === 0 || v - all[i - 1]! > 1e-7);
}

class Prim {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  hasUv = false;
  vertex(p: V3, n: V3, uv?: [number, number]) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    if (uv) {
      this.hasUv = true;
      this.uv.push(uv[0], uv[1]);
    } else this.uv.push(0, 0);
    return this.pos.length / 3 - 1;
  }
  /** Triangle in parameter order (counter-clockwise in (a, b) ⇒ face normal ∂a × ∂b), reversed when `flip`. */
  triWound(a: number, b: number, c: number, flip: boolean) {
    const P = this.pos;
    const e1: V3 = [P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!];
    const e2: V3 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
    if (len(cross(e1, e2)) < 1e-12) return;
    if (flip) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  /** Adds a triangle, wound so its face normal agrees with the vertex normals. Degenerate ones are dropped. */
  tri(a: number, b: number, c: number) {
    const P = this.pos;
    const N = this.nrm;
    const ax = P[a * 3]!, ay = P[a * 3 + 1]!, az = P[a * 3 + 2]!;
    const e1: V3 = [P[b * 3]! - ax, P[b * 3 + 1]! - ay, P[b * 3 + 2]! - az];
    const e2: V3 = [P[c * 3]! - ax, P[c * 3 + 1]! - ay, P[c * 3 + 2]! - az];
    const g = cross(e1, e2);
    if (len(g) < 1e-12) return;
    const s: V3 = [N[a * 3]! + N[b * 3]! + N[c * 3]!, N[a * 3 + 1]! + N[b * 3 + 1]! + N[c * 3 + 1]!, N[a * 3 + 2]! + N[b * 3 + 2]! + N[c * 3 + 2]!];
    if (dot(g, s) < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
}

/** Geometry of one glTF node, one primitive per material. */
export class Mesh {
  prims = new Map<string, Prim>();
  get(mat: string) {
    let p = this.prims.get(mat);
    if (!p) {
      p = new Prim();
      this.prims.set(mat, p);
    }
    return p;
  }
  toPrimitives(materialIndex: (name: string) => number): GlbPrimitive[] {
    const out: GlbPrimitive[] = [];
    for (const [mat, p] of this.prims) {
      if (!p.idx.length) continue;
      const count = p.pos.length / 3;
      out.push({
        positions: new Float32Array(p.pos),
        normals: new Float32Array(p.nrm),
        uvs: p.hasUv ? new Float32Array(p.uv) : undefined,
        indices: count < 65536 ? new Uint16Array(p.idx) : new Uint32Array(p.idx),
        material: materialIndex(mat),
      });
    }
    return out;
  }
  vertexCount() {
    let n = 0;
    for (const p of this.prims.values()) n += p.pos.length / 3;
    return n;
  }
}

export type GridOpts = {
  as: number[];
  bs: number[];
  fn: (a: number, b: number) => V3;
  /** material for quad (i, j) spanning as[i]..as[i+1] × bs[j]..bs[j+1]; null = skip. A [mesh, material] pair sends it to another node. */
  mat: (i: number, j: number) => string | [Mesh, string] | null;
  /** return true when the raw normal (∂a × ∂b) at (a, b) must be flipped to point outward */
  flip?: (a: number, b: number, p: V3, n: V3) => boolean;
  uv?: (a: number, b: number, p: V3) => [number, number];
  /** push the surface along its normal (decals) */
  offset?: number;
  /** wrap b (closed ring): last b equals first */
  wrapB?: boolean;
};

/** Smooth surface normal by central differences, nudging inward at degenerate points. */
export function surfaceNormal(fn: (a: number, b: number) => V3, a: number, b: number, a0: number, a1: number, b0: number, b1: number, wrapB = false): V3 {
  const ea = (a1 - a0) * 2e-5;
  const eb = (b1 - b0) * 2e-5;
  let aa = a;
  let bb = b;
  for (let k = 0; k < 6; k++) {
    const am = Math.max(a0, aa - ea), ap = Math.min(a1, aa + ea);
    const bm = wrapB ? bb - eb : Math.max(b0, bb - eb), bp = wrapB ? bb + eb : Math.min(b1, bb + eb);
    const da = sub(fn(ap, bb), fn(am, bb));
    const db = sub(fn(aa, bp), fn(aa, bm));
    const n = cross(da, db);
    const l = len(n);
    const lalb = len(da) * len(db);
    if (lalb > 1e-24 && l / lalb > 1e-5) return scale(n, 1 / l);
    // degenerate (collapsed edge): step towards the interior
    aa = aa + (aa - a0 < a1 - aa ? 1 : -1) * (a1 - a0) * 1e-3 * (k + 1);
    if (!wrapB) bb = bb + (bb - b0 < b1 - bb ? 1 : -1) * (b1 - b0) * 1e-3 * (k + 1) * (k > 2 ? 1 : 0);
  }
  return [0, 0, 1];
}

export function grid(mesh: Mesh, o: GridOpts) {
  const { as, bs, fn } = o;
  const na = as.length;
  const nb = bs.length;
  const a0 = as[0]!, a1 = as[na - 1]!, b0 = bs[0]!, b1 = bs[nb - 1]!;
  const P: V3[] = new Array(na * nb);
  const N: V3[] = new Array(na * nb);
  // One orientation for the whole patch (majority vote of the outward test): robust at folds and tips.
  let votes = 0;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      const a = as[i]!, b = bs[j]!;
      const p = fn(a, b);
      const n = surfaceNormal(fn, a, b, a0, a1, b0, b1, o.wrapB);
      if (o.flip) votes += o.flip(a, b, p, n) ? 1 : -1;
      P[i * nb + j] = p;
      N[i * nb + j] = n;
    }
  }
  const flipAll = votes > 0;
  for (let k = 0; k < na * nb; k++) {
    if (flipAll) N[k] = scale(N[k]!, -1);
    if (o.offset) P[k] = madd(P[k]!, N[k]!, o.offset);
  }
  const maps = new Map<Mesh, Map<string, Int32Array>>();
  const vert = (m: Mesh, mat: string, i: number, j: number) => {
    let mm = maps.get(m);
    if (!mm) maps.set(m, (mm = new Map()));
    let map = mm.get(mat);
    if (!map) {
      map = new Int32Array(na * nb).fill(-1);
      mm.set(mat, map);
    }
    const k = i * nb + j;
    if (map[k]! < 0) map[k] = m.get(mat).vertex(P[k]!, N[k]!, o.uv?.(as[i]!, bs[j]!, P[k]!));
    return map[k]!;
  };
  for (let i = 0; i < na - 1; i++) {
    for (let j = 0; j < nb - 1; j++) {
      const r = o.mat(i, j);
      if (!r) continue;
      const [m, mat] = typeof r === "string" ? [mesh, r] : r;
      const prim = m.get(mat);
      const v00 = vert(m, mat, i, j), v10 = vert(m, mat, i + 1, j), v11 = vert(m, mat, i + 1, j + 1), v01 = vert(m, mat, i, j + 1);
      const d1 = len(sub(P[i * nb + j]!, P[(i + 1) * nb + j + 1]!));
      const d2 = len(sub(P[(i + 1) * nb + j]!, P[i * nb + j + 1]!));
      if (d1 <= d2) {
        prim.triWound(v00, v10, v11, flipAll);
        prim.triWound(v00, v11, v01, flipAll);
      } else {
        prim.triWound(v00, v10, v01, flipAll);
        prim.triWound(v10, v11, v01, flipAll);
      }
    }
  }
  return { P, N, na, nb };
}

/** Flat triangle fan closing a polygon; `towards` picks the face direction. */
export function fan(mesh: Mesh, mat: string, loop: V3[], towards: V3) {
  const c = scale(loop.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / loop.length);
  const n = norm(towards);
  const prim = mesh.get(mat);
  const ci = prim.vertex(c, n);
  const ids = loop.map((p) => prim.vertex(p, n));
  for (let k = 0; k < ids.length; k++) prim.tri(ci, ids[k]!, ids[(k + 1) % ids.length]!);
}

/** Flat quad a-b-c-d facing `towards` (or its own winding when omitted). */
export function quad(mesh: Mesh, mat: string, a: V3, b: V3, c: V3, d: V3, towards?: V3) {
  let n = norm(cross(sub(c, a), sub(d, b)));
  if (towards && dot(n, towards) < 0) n = scale(n, -1);
  const prim = mesh.get(mat);
  const ia = prim.vertex(a, n), ib = prim.vertex(b, n), ic = prim.vertex(c, n), id = prim.vertex(d, n);
  prim.tri(ia, ib, ic);
  prim.tri(ia, ic, id);
}

/** Ellipsoid with centre c and semi-axis vectors ex, ey, ez. */
export function ellipsoid(mesh: Mesh, mat: string, c: V3, ex: V3, ey: V3, ez: V3, seg = 28, opts: { vFrom?: number; vTo?: number; uFrom?: number; uTo?: number } = {}) {
  const segV = Math.max(8, Math.round(seg * 0.6));
  const vFrom = opts.vFrom ?? 0, vTo = opts.vTo ?? Math.PI;
  const uFrom = opts.uFrom ?? 0, uTo = opts.uTo ?? Math.PI * 2;
  const as = Array.from({ length: segV + 1 }, (_, i) => vFrom + ((vTo - vFrom) * i) / segV);
  const bs = Array.from({ length: seg + 1 }, (_, i) => uFrom + ((uTo - uFrom) * i) / seg);
  const fn = (v: number, u: number): V3 => {
    const sv = Math.sin(v);
    return add(add(add(c, scale(ex, sv * Math.cos(u))), scale(ey, sv * Math.sin(u))), scale(ez, Math.cos(v)));
  };
  grid(mesh, { as, bs, fn, mat: () => mat, flip: (_a, _b, p, n) => dot(n, sub(p, c)) < 0, wrapB: uTo - uFrom > 6.28 });
}

/** Elongated ellipsoid ("limb") from p0 to p1 with radii r (and optionally a different r2 across). */
export function limb(mesh: Mesh, mat: string, p0: V3, p1: V3, r: number, r2 = r, up: V3 = [0, 0, 1], seg = 20) {
  const axis = sub(p1, p0);
  const L = len(axis);
  const ax = norm(axis);
  let side = cross(ax, up);
  if (len(side) < 1e-6) side = cross(ax, [1, 0, 0]);
  side = norm(side);
  const up2 = norm(cross(side, ax));
  const c = scale(add(p0, p1), 0.5);
  ellipsoid(mesh, mat, c, scale(side, r2), scale(up2, r), scale(ax, L / 2 + r * 0.6), seg);
}
