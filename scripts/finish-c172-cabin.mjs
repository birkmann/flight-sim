// Close the imported cabin's open footwells and finish its interior-only trim.
// Cabin coordinates: +X forward, +Y up, +Z starboard. Exterior and rig stay intact.
import {readFile, writeFile} from 'node:fs/promises';
import {BufferGeometry, Float32BufferAttribute, CylinderGeometry} from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

const path = new URL('../bevy/assets/models/c172.glb', import.meta.url);
const file = await readFile(path), jsonLength = file.readUInt32LE(12);
const doc = JSON.parse(file.subarray(20, 20 + jsonLength));
const revision = 1;
if (doc.asset.extras?.closedCabinRevision === revision) {
  console.log('C172 cabin enclosure and trim already finished.');
  process.exit(0);
}
const cabin = doc.nodes.find(n => n.name === 'crew-station-cabin');
if (!cabin || doc.asset.extras?.yokeMountRevision !== 1) throw Error('Refine and rig the cabin first.');
const chunks = [Buffer.from(file.subarray(28 + jsonLength))];
let length = chunks[0].length;
function append(data) {
  const offset = length;
  chunks.push(data); length += data.length;
  const pad = (4 - length % 4) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
  return offset;
}
function accessor(attribute) {
  const values = new Float32Array(attribute.array), data = Buffer.from(values.buffer);
  const min = Array(attribute.itemSize).fill(Infinity), max = min.map(() => -Infinity);
  values.forEach((v, i) => { const k = i % attribute.itemSize; min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); });
  const bufferView = doc.bufferViews.push({buffer:0, byteOffset:append(data), byteLength:data.length, target:34962}) - 1;
  return doc.accessors.push({bufferView, componentType:5126, count:attribute.count,
    type:{2:'VEC2',3:'VEC3'}[attribute.itemSize], min, max}) - 1;
}
function mesh(name, geometry, material) {
  if (geometry.index) geometry = geometry.toNonIndexed();
  const attributes = {};
  for (const [key, semantic] of Object.entries({position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'})) {
    if (geometry.attributes[key]) attributes[semantic] = accessor(geometry.attributes[key]);
  }
  const id = doc.meshes.push({name, primitives:[{attributes, material, mode:4}]}) - 1;
  cabin.children.push(doc.nodes.push({name, mesh:id}) - 1);
  geometry.dispose();
}
function material(name, color, roughness, source) {
  const m = source ? structuredClone(doc.materials.find(m => m.name === source)) : {};
  m.name = name;
  m.pbrMetallicRoughness = {...m.pbrMetallicRoughness, baseColorFactor:[...color,1], roughnessFactor:roughness, metallicFactor:0};
  if (m.normalTexture) m.normalTexture.scale = .07;
  return doc.materials.push(m) - 1;
}
function box(name, size, position, finish, radius = .006) {
  mesh(name, new RoundedBoxGeometry(...size, 2, radius).translate(...position), finish);
}
const carpet = material('cabin-charcoal-carpet|interior', [.012,.016,.02], 1, 'rubber|interior');
const lining = material('cabin-warm-grey-lining|interior', [.19,.175,.15], .94, 'trim|interior');
const inset = material('cabin-door-inset|interior', [.065,.072,.075], .94, 'paint-matte|interior');
const rubber = material('cabin-black-seal|interior', [.009,.012,.014], .95);
const satin = material('cabin-satin-hardware|interior', [.14,.16,.18], .48);

// Continuous floor and firewall. The old liner ended before the pedals, leaving
// open triangles to the scenery when the exterior fuselage is hidden in cockpit view.
box('cabin-continuous-floor', [3.20,.055,1.10], [-.51,.756,0], carpet);
box('cabin-closed-firewall', [.065,.82,1.10], [1.065,1.17,0], inset);
for (const side of [-1,1]) {
  const suffix = side < 0 ? 'left' : 'right';
  box(`cabin-footwell-${suffix}`, [.62,.75,.055], [.755,1.125,side*.53], inset);
  box(`cabin-lower-door-${suffix}`, [1.75,.72,.055], [-.405,1.115,side*.54], lining);
  box(`cabin-door-insert-${suffix}`, [.79,.26,.018], [-.04,1.27,side*.502], inset);
  box(`cabin-window-sill-${suffix}`, [1.72,.035,.06], [-.40,1.484,side*.52], rubber);
  box(`cabin-armrest-${suffix}`, [.45,.055,.085], [-.07,1.19,side*.467], inset, .014);
  box(`cabin-heel-mat-${suffix}`, [.41,.014,.36], [.67,.792,side*.274], rubber);
  for (let i=0; i<7; i++) {
    box(`cabin-heel-mat-rib-${suffix}-${i}`, [.31,.006,.009], [.67,.801,side*.274 + (i-3)*.038], inset, .002);
  }
  box(`cabin-door-pull-${suffix}`, [.14,.019,.025], [.19,1.31,side*.478], satin);
  for (const x of [-.32,.24]) {
    mesh(`cabin-door-fastener-${suffix}`, new CylinderGeometry(.004,.004,.003,12)
      .rotateX(Math.PI/2).translate(x,1.36,side*.489), satin);
  }
}

// Trim away the old curved lower liner where the new flat door panels sit.
// Clipping crossing triangles preserves the window frames without interpenetrating
// wall surfaces or jagged material patches beside the pilot's knees.
const oldLiner = doc.nodes[cabin.children[0]];
for (const p of doc.meshes[oldLiner.mesh].primitives) {
  if (p.indices !== undefined) throw Error('Unexpected indexed cabin liner');
  const streams = Object.fromEntries(Object.entries(p.attributes).map(([semantic,id]) => {
    const a = doc.accessors[id], v = doc.bufferViews[a.bufferView], size = {VEC2:2,VEC3:3}[a.type];
    if (a.componentType !== 5126 || !size) throw Error('Unexpected liner attribute');
    const offset = (v.byteOffset || 0) + (a.byteOffset || 0);
    return [semantic, {size, values:Array.from({length:a.count}, (_,i) =>
      Array.from({length:size}, (_,k) => chunks[0].readFloatLE(offset+i*(v.byteStride || size*4)+k*4)))}];
  }));
  const output = Object.fromEntries(Object.keys(streams).map(key => [key, []]));
  const cut = 1.49;
  for (let i=0; i<streams.POSITION.values.length; i+=3) {
    const input = [i,i+1,i+2].map(j => Object.fromEntries(Object.entries(streams).map(([key,s]) => [key,s.values[j]])));
    const polygon = [];
    for (let j=0; j<3; j++) {
      const a = input[j], b = input[(j+1)%3], insideA = a.POSITION[1] >= cut, insideB = b.POSITION[1] >= cut;
      if (insideA) polygon.push(a);
      if (insideA !== insideB) {
        const t = (cut-a.POSITION[1])/(b.POSITION[1]-a.POSITION[1]);
        polygon.push(Object.fromEntries(Object.keys(streams).map(key => [key,a[key].map((v,k) => v+(b[key][k]-v)*t)])));
      }
    }
    for (let j=1; j<polygon.length-1; j++) for (const vertex of [polygon[0],polygon[j],polygon[j+1]]) {
      for (const key of Object.keys(streams)) output[key].push(...vertex[key]);
    }
  }
  const geometry = new BufferGeometry();
  for (const [key,s] of Object.entries(streams)) {
    const attribute = new Float32BufferAttribute(output[key],s.size);
    if (key === 'NORMAL') for (let i=0; i<attribute.count; i++) {
      const norm = Math.hypot(attribute.getX(i),attribute.getY(i),attribute.getZ(i)) || 1;
      attribute.setXYZ(i,attribute.getX(i)/norm,attribute.getY(i)/norm,attribute.getZ(i)/norm);
    }
    geometry.setAttribute(key,attribute);
    p.attributes[key] = accessor(attribute);
  }
  geometry.dispose();
  p.material = lining;
}
doc.asset.extras = {...doc.asset.extras, closedCabinRevision:revision};
doc.buffers[0].byteLength = length;
const json = Buffer.from(JSON.stringify(doc)), padded = Buffer.alloc(Math.ceil(json.length/4)*4, 32);
json.copy(padded);
const header = Buffer.alloc(20), bh = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2,4);
header.writeUInt32LE(28+padded.length+length,8); header.writeUInt32LE(padded.length,12); header.writeUInt32LE(0x4e4f534a,16);
bh.writeUInt32LE(length); bh.writeUInt32LE(0x004e4942,4);
await writeFile(path, Buffer.concat([header,padded,bh,...chunks]));
console.log('C172: closed floor and footwells, upholstered doors, sills and cabin hardware.');
