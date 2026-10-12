/**
 * Minimal glTF 2.0 binary (GLB) writer: meshes with POSITION/NORMAL/TEXCOORD_0 + indices, PBR
 * metallic-roughness materials, embedded PNG textures and a node hierarchy.
 */

export type GlbPrimitive = {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint16Array | Uint32Array;
  material: number;
};

export type GlbNode = {
  name: string;
  extras?: Record<string, unknown>;
  primitives?: GlbPrimitive[];
  children?: number[];
  /** column-major 4x4 */
  matrix?: number[];
};

export type GlbMaterial = {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
  alphaMode?: "OPAQUE" | "BLEND" | "MASK";
  alphaCutoff?: number;
  doubleSided?: boolean;
  emissive?: [number, number, number];
  /** index into the textures list */
  texture?: number;
};

export type GlbImage = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" };

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export function writeGlb(opts: { nodes: GlbNode[]; root: number; materials: GlbMaterial[]; images?: GlbImage[] }): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const pushView = (data: ArrayBufferView, target?: number) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    const view: Record<string, unknown> = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    byteLength += bytes.byteLength;
    bufferViews.push(view);
    return bufferViews.length - 1;
  };

  const pushAccessor = (data: Float32Array | Uint16Array | Uint32Array, type: "VEC3" | "VEC2" | "SCALAR", target: number, minmax = false) => {
    const view = pushView(data, target);
    const comps = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
    const componentType = data instanceof Float32Array ? 5126 : data instanceof Uint16Array ? 5123 : 5125;
    const acc: Record<string, unknown> = { bufferView: view, componentType, count: data.length / comps, type };
    if (minmax) {
      const min = new Array(comps).fill(Infinity);
      const max = new Array(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % comps;
        const v = data[i]!;
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const meshes: Record<string, unknown>[] = [];
  const nodes = opts.nodes.map((n) => {
    const node: Record<string, unknown> = { name: n.name };
    if(n.extras) node.extras = n.extras;
    if (n.children?.length) node.children = n.children;
    if (n.matrix) node.matrix = n.matrix;
    const prims = (n.primitives ?? []).filter((p) => p.indices.length > 0);
    if (prims.length) {
      meshes.push({
        name: n.name,
        primitives: prims.map((p) => {
          const attributes: Record<string, number> = {
            POSITION: pushAccessor(p.positions, "VEC3", ARRAY_BUFFER, true),
            NORMAL: pushAccessor(p.normals, "VEC3", ARRAY_BUFFER),
          };
          if (p.uvs) attributes.TEXCOORD_0 = pushAccessor(p.uvs, "VEC2", ARRAY_BUFFER);
          return { attributes, indices: pushAccessor(p.indices, "SCALAR", ELEMENT_ARRAY_BUFFER), material: p.material, mode: 4 };
        }),
      });
      node.mesh = meshes.length - 1;
    }
    return node;
  });

  const images = (opts.images ?? []).map((img) => ({ bufferView: pushView(img.bytes), mimeType: img.mimeType }));

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "dwd-flight glider builder" },
    scene: 0,
    scenes: [{ nodes: [opts.root] }],
    nodes,
    meshes,
    materials: opts.materials.map((m) => {
      const out: Record<string, unknown> = {
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: m.baseColor,
          metallicFactor: m.metallic,
          roughnessFactor: m.roughness,
          ...(m.texture !== undefined ? { baseColorTexture: { index: m.texture } } : {}),
        },
      };
      if (m.alphaMode && m.alphaMode !== "OPAQUE") out.alphaMode = m.alphaMode;
      if (m.alphaMode === "MASK") out.alphaCutoff = m.alphaCutoff ?? 0.5;
      if (m.doubleSided) out.doubleSided = true;
      if (m.emissive) out.emissiveFactor = m.emissive;
      return out;
    }),
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (images.length) {
    json.images = images;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    json.textures = images.map((_, i) => ({ source: i, sampler: 0 }));
  }

  const binPad = (4 - (byteLength % 4)) % 4;
  const binLength = byteLength + binPad;
  (json.buffers as { byteLength: number }[])[0]!.byteLength = binLength;

  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }

  const total = 12 + 8 + jsonBytes.length + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, binLength, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
