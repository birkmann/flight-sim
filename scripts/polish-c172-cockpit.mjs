// Finish the visible cabin shapes, retaining instrument UVs and control pivots.
// +X forward, +Y up, +Z starboard, in metres. Run after model:c172.
import {readFile, writeFile} from 'node:fs/promises';
import {BufferGeometry, Float32BufferAttribute, Vector3, CatmullRomCurve3, TubeGeometry, CylinderGeometry, SphereGeometry, PlaneGeometry, TorusGeometry} from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {toCreasedNormals, mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

const path = new URL('../bevy/assets/models/c172.glb', import.meta.url);
const file = await readFile(path), jsonLength = file.readUInt32LE(12);
const doc = JSON.parse(file.subarray(20, 20 + jsonLength));
if (doc.asset.extras?.cockpitPolishRevision === 1) {
  console.log('C172 cockpit already polished.'); process.exit(0);
}
if (doc.asset.extras?.closedCabinRevision !== 1) throw Error('Finish the enclosed cabin first.');
const chunks = [file.subarray(28 + jsonLength)]; let length = chunks[0].length;
function append(data) {
  const offset = length; chunks.push(data); length += data.length;
  const pad = (4 - length % 4) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
  return offset;
}
function accessor(a) {
  const values = new Float32Array(a.array), data = Buffer.from(values.buffer);
  const min = Array(a.itemSize).fill(Infinity), max = min.map(() => -Infinity);
  values.forEach((v, i) => { const k = i % a.itemSize; min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); });
  const bufferView = doc.bufferViews.push({buffer:0, byteOffset:append(data), byteLength:data.length, target:34962}) - 1;
  return doc.accessors.push({bufferView, componentType:5126, count:a.count, type:{2:'VEC2',3:'VEC3'}[a.itemSize], min,max}) - 1;
}
function read(id) {
  const a = doc.accessors[id], v = doc.bufferViews[a.bufferView], size = {VEC2:2,VEC3:3}[a.type];
  if (a.componentType !== 5126 || !size) throw Error('Expected float attribute');
  return new Float32BufferAttribute(Array.from({length:a.count*size}, (_,i) => chunks[0].readFloatLE(
    (v.byteOffset||0)+(a.byteOffset||0)+Math.floor(i/size)*(v.byteStride||size*4)+i%size*4)),size);
}
const semantics = {position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'};
function attributes(g) {
  if (g.index) g = g.toNonIndexed();
  return Object.fromEntries(Object.entries(semantics).filter(([k]) => g.attributes[k]).map(([k,s]) => [s,accessor(g.attributes[k])]));
}
function primitives(parts) {
  const groups = new Map();
  for (const {geometry,material} of parts) {
    if (!groups.has(material)) groups.set(material,[]);
    groups.get(material).push(geometry);
  }
  return [...groups].map(([material,geometries])=>{
    const merged=mergeGeometries(geometries);
    const p={attributes:attributes(merged),material,mode:4};
    merged.dispose();geometries.forEach(g=>g.dispose());return p;
  });
}
function add(parent,name,g,material) {
  const mesh = doc.meshes.push({name,primitives:[{attributes:attributes(g),material,mode:4}]})-1;
  parent.children.push(doc.nodes.push({name,mesh})-1); g.dispose();
}
function material(name,color,roughness,metallic=0,source) {
  const m = source ? structuredClone(doc.materials.find(m=>m.name===source)) : {};
  m.name = name;
  m.pbrMetallicRoughness = {...m.pbrMetallicRoughness,baseColorFactor:[...color,1],roughnessFactor:roughness,metallicFactor:metallic};
  if (m.normalTexture) m.normalTexture.scale = .008;
  return doc.materials.push(m)-1;
}
const black = material('cabin-moulded-charcoal|interior',[.018,.019,.020],.88,0,'rubber|interior');
const trim = material('cabin-sandstone-vinyl|interior',[.30,.267,.213],.84,0,'trim|interior');
const metal = material('cabin-satin-nickel|interior',[.35,.36,.37],.32,.72);
const seal = material('cabin-window-gasket|interior',[.008,.010,.011],.92);
const panelFinish = material('cabin-instrument-enamel|interior',[.115,.108,.094],.78,0,'paint-matte|interior');
const cabin = doc.nodes.find(n=>n.name==='crew-station-cabin');
const panel = doc.nodes.find(n=>n.name==='crew-station-panel');
function box(parent,name,size,position,finish,radius=.008) {
  add(parent,name,new RoundedBoxGeometry(...size,4,radius).translate(...position),finish);
}
function tube(parent,name,points,radius,finish,scale=[1,1,1]) {
  const curve = new CatmullRomCurve3(points.map(p=>new Vector3(...p)));
  add(parent,name,new TubeGeometry(curve,48,radius,12,false).scale(...scale),finish);
}
// Work on complete connected pieces so replacing a post never cuts adjacent roof,
// window or panel triangles. Shared positions join the imported unindexed faces.
function components(p) {
  if (p.indices !== undefined) throw Error('Expected unindexed imported cockpit');
  const streams = Object.fromEntries(Object.entries(semantics).filter(([,s])=>p.attributes[s]!==undefined).map(([k,s])=>[k,read(p.attributes[s])]));
  const pos = streams.position, parent = Array.from({length:pos.count},(_,i)=>i), seen = new Map();
  const root = i => { while (parent[i]!==i) {parent[i]=parent[parent[i]];i=parent[i];} return i; };
  for(let i=0;i<pos.count;i++) {
    const key = [pos.getX(i),pos.getY(i),pos.getZ(i)].map(v=>v.toFixed(5)).join(',');
    if (seen.has(key)) parent[root(i)] = root(seen.get(key)); else seen.set(key,i);
    parent[root(i)] = root(i-i%3);
  }
  const groups = new Map();
  for(let i=0;i<pos.count;i++) {const r=root(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(i);}
  return [...groups.values()].map(ids=>{
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    ids.forEach(i=>[pos.getX(i),pos.getY(i),pos.getZ(i)].forEach((v,k)=>{min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);}));
    const g=new BufferGeometry();
    for(const [key,a] of Object.entries(streams)) g.setAttribute(key,new Float32BufferAttribute(ids.flatMap(i=>Array.from(a.array.slice(i*a.itemSize,(i+1)*a.itemSize))),a.itemSize));
    return {g,min,max};
  });
}
// Replace broad polygonal front posts with moulded, smoothly swept members.
// Remove the old centre brace and square compass; the existing heading instrument
// remains live. A slender brace leaves the forward view open.
for(const id of [...cabin.children].filter(i=>!doc.nodes[i].name)) {
  const mesh=doc.meshes[doc.nodes[id].mesh], output=[];
  for(const p of mesh.primitives) for(const c of components(p)) {
    const name=doc.materials[p.material].name, {min,max}=c;
    const frontPost=name==='paint-navy-radome' && min[0]>.37;
    const compass=min[0]>.49 && min[1]>1.86 && min[2]>-.05 && max[2]<.05;
    const brace=min[0]>.49 && min[1]>1.63 && min[2]>-.015 && max[2]<.015;
    const vent=name==='metal|interior' && min[0]>.4 && min[1]>1.87;
    if(frontPost||compass||brace||vent) {c.g.dispose();continue;}
    let finish=p.material;
    if(['paint-navy-radome','cabin-warm-grey-lining|interior','trim|interior'].includes(name)) finish=trim;
    output.push({geometry:toCreasedNormals(c.g,Math.PI/3),material:finish});
  }
  mesh.primitives=primitives(output);
}
for(const side of [-1,1]) {
  tube(cabin,`windscreen-moulding-${side}`,[[.435,1.487,side*.527],[.441,1.64,side*.497],[.455,1.79,side*.444],[.491,1.936,side*.378]],.027,trim);
  tube(cabin,`windscreen-seal-${side}`,[[.467,1.51,side*.512],[.472,1.65,side*.483],[.488,1.80,side*.43],[.519,1.942,side*.362]],.006,seal);
}
tube(cabin,'windscreen-centre-brace',[[.938,1.628,0],[.745,1.79,0],[.48,2.025,0]],.0065,black);
// Soft dashboard lip. Keep its lower edge above all instruments.
for(const id of panel.children) {
  const mesh=doc.meshes[doc.nodes[id].mesh]; if(!mesh)continue;
  const output=[];
  for(const p of mesh.primitives) for(const c of components(p)) {
    const name=doc.materials[p.material].name;
    if(name==='paint-obsidian|interior' && c.min[1]>1.59) {c.g.dispose();continue;}
    // Old right-hand engine dials were static tick marks; replace the whole bank.
    if(c.min[2]>.24 && c.min[1]>1.48 && c.max[1]<1.58) {c.g.dispose();continue;}
    let finish=p.material;
    if(name==='paint-black|interior' && c.max[2]-c.min[2]>.9) finish=panelFinish;
    output.push({geometry:toCreasedNormals(c.g,Math.PI/3),material:finish});
  }
  mesh.primitives=primitives(output);
}
box(panel,'padded-glareshield',[.235,.041,.955],[.91,1.625,0],black,.017);
tube(panel,'glareshield-rounded-edge',[[.807,1.623,-.463],[.784,1.635,-.24],[.778,1.638,0],[.784,1.635,.24],[.807,1.623,.463]],.012,black);
// Continuous cast yokes with modest grip proportions instead of jointed bars.
// Shaft and fixed bearing remain untouched, including their tested engagement.
for(const side of ['left','right']) {
  const yoke=doc.nodes.find(n=>n.name===`cockpit-yoke-${side}`),[x,y,z]=yoke.extras.controlPivot;
  yoke.children=yoke.children.filter(i=>doc.nodes[i].name===`yoke-sliding-shaft-${side}`);
  box(yoke,`yoke-rounded-hub-${side}`,[.052,.050,.085],[x-.014,y,z],black,.013);
  for(const s of [-1,1]) {
    tube(yoke,`yoke-cast-arm-${side}-${s}`,[[x-.012,y-.009,z],[x-.013,y-.024,z+s*.047],[x-.004,y-.018,z+s*.105],[x+.005,y+.02,z+s*.136],[x+.008,y+.097,z+s*.136]],.012,black);
    tube(yoke,`yoke-contoured-grip-${side}-${s}`,[[x+.005,y+.013,z+s*.136],[x+.007,y+.044,z+s*.139],[x+.012,y+.08,z+s*.135],[x+.014,y+.107,z+s*.13]],.017,black);
    add(yoke,`yoke-grip-cap-${side}-${s}`,new SphereGeometry(.017,24,12).scale(1,.65,1).translate(x+.014,y+.107,z+s*.13),black);
    add(yoke,`yoke-thumb-switch-${side}-${s}`,new CylinderGeometry(.005,.005,.003,20).translate(x+.014,y+.124,z+s*.13),seal);
  }
  box(yoke,`yoke-inset-badge-${side}`,[.0015,.017,.042],[x-.041,y+.003,z],metal,.0007);
}
// Real engine indications on a recessed face, with physical bezels outside the
// readable dials. Local plane X becomes starboard and Y follows panel tilt.
const station=doc.nodes.find(n=>n.name==='crew-station');
const engineGeometry=new PlaneGeometry(.244,.087).rotateY(-Math.PI/2).rotateZ(-.10472).translate(.808,1.54,.358);
add(station,'display-engine',engineGeometry,black);
for(const z of [.278,.358,.438]) {
  add(panel,'engine-instrument-bezel',new TorusGeometry(.0345,.0024,12,64).rotateY(Math.PI/2).rotateZ(-.10472).translate(.805,1.54,z),black);
}
// Match the new warm trim on the lower doors, soften shiny imported hardware.
for(const m of doc.materials) {
  if(m.name==='cabin-warm-grey-lining|interior') m.pbrMetallicRoughness.baseColorFactor=[.30,.267,.213,1];
  if(m.name==='metal|interior') {
    m.pbrMetallicRoughness.baseColorFactor=[.45,.46,.47,1];m.pbrMetallicRoughness.roughnessFactor=.34;
    if(m.normalTexture)m.normalTexture.scale=.02;
  }
}
// Remove empty mesh nodes left by the compass replacement (valid glTF requires
// at least one primitive per mesh), without reindexing any animated scene nodes.
for(const n of doc.nodes) if(n.mesh!==undefined&&!doc.meshes[n.mesh].primitives.length) delete n.mesh;
const meshIds=new Map();
doc.meshes=doc.meshes.filter((m,i)=>{if(!m.primitives.length)return false;meshIds.set(i,meshIds.size);return true;});
for(const n of doc.nodes) if(n.mesh!==undefined)n.mesh=meshIds.get(n.mesh);
doc.asset.extras={...doc.asset.extras,cockpitPolishRevision:1};doc.buffers[0].byteLength=length;
const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const header=Buffer.alloc(20),bh=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
bh.writeUInt32LE(length);bh.writeUInt32LE(0x004e4942,4);
await writeFile(path,Buffer.concat([header,padded,bh,...chunks]));
console.log('C172: swept window mouldings, padded dashboard, cast yokes and warm interior finishes.');
