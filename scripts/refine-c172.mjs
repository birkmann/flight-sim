// Refine the imported cabin in-place; all meshes and textures remain embedded.
// Coordinates inside the aircraft root: nose +X, up +Y, starboard +Z (metres).
import { readFile, writeFile } from 'node:fs/promises';
import { BufferGeometry, Float32BufferAttribute } from 'three';

const path = new URL('../bevy/assets/models/c172.glb', import.meta.url);
const file = await readFile(path);
const jsonLength = file.readUInt32LE(12);
const doc = JSON.parse(file.subarray(20, 20 + jsonLength));
const bin = Buffer.from(file.subarray(28 + jsonLength));
const revision = 'c172-cabin-clearance-v1';
if (doc.asset.extras?.cabinRevision === revision) {
  console.log('C172 cabin already refined.');
  process.exit(0);
}

function attribute(id) {
  const a = doc.accessors[id], v = doc.bufferViews[a.bufferView];
  if (a.type !== 'VEC3' || a.componentType !== 5126) throw Error('Expected float VEC3');
  const offset = (v.byteOffset || 0) + (a.byteOffset || 0), stride = v.byteStride || 12;
  return {
    read: () => Array.from({ length: a.count * 3 }, (_, i) => bin.readFloatLE(offset + Math.floor(i / 3) * stride + i % 3 * 4)),
    write: values => {
      values.forEach((value, i) => bin.writeFloatLE(value, offset + Math.floor(i / 3) * stride + i % 3 * 4));
      if (a.min) a.min = [0, 1, 2].map(k => Math.min(...values.filter((_, i) => i % 3 === k)));
      if (a.max) a.max = [0, 1, 2].map(k => Math.max(...values.filter((_, i) => i % 3 === k)));
    },
  };
}

const cabin = doc.nodes.find(n => n.name === 'crew-station-cabin');
const lining = cabin.children.flatMap(i => doc.meshes[doc.nodes[i].mesh]?.primitives || [])
  .find(p => doc.materials[p.material].name === 'paint-radome');
if (!lining || lining.indices !== undefined) throw Error('Unexpected C172 liner topology');
const positions = attribute(lining.attributes.POSITION), points = positions.read();
const smooth = (lo, hi, x) => { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
// The original squircle liner folds inward above the tapering nose section,
// crossing the airspeed indicator. Fair it outside the panel's 0.487 m edge,
// blending back into the original floor, door and firewall.
for (let i = 0; i < points.length; i += 3) {
  const [x, y, z] = points.slice(i, i + 3);
  if (y > 1.621 || Math.abs(z) < .1) continue;
  const blend = smooth(.05, .45, x) * (1 - smooth(.91, 1.02, x)) * smooth(.95, 1.3, y);
  points[i + 2] = Math.sign(z) * Math.max(Math.abs(z), .505 * blend);
}
positions.write(points);
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
geometry.computeVertexNormals();
attribute(lining.attributes.NORMAL).write(Array.from(geometry.attributes.normal.array));
geometry.dispose();

// Align with the instrument cluster, slightly aft of the original eye position.
// Keep the seat offset and the panel's perspective, including when looking around.
const eye = doc.nodes.find(n => n.name === 'crew-eye');
eye.matrix.splice(12, 3, -.12, 1.76, -.225);
for (const material of doc.materials) {
  if (!material.name?.endsWith('|interior') || !material.normalTexture) continue;
  // Fine upholstery/paint grain, rather than the original coarse embossed finish.
  material.normalTexture.scale = material.name.startsWith('metal') ? .04 : .18;
}
doc.asset.extras = { ...doc.asset.extras, cabinRevision: revision };
const json = Buffer.from(JSON.stringify(doc));
const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20); json.copy(padded);
const output = Buffer.alloc(28 + padded.length + bin.length);
output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
output.writeUInt32LE(bin.length, 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(output, 28 + padded.length);
await writeFile(path, output);
console.log('C172: refined cabin clearance, pilot eye and interior surface grain.');
