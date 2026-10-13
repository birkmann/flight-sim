// Reproducible exterior finish. Preserve cabin meshes, node transforms and rigs.
import {readFile, writeFile} from 'node:fs/promises';
import {BufferGeometry, Float32BufferAttribute, ConeGeometry} from 'three';
import {toCreasedNormals} from 'three/addons/utils/BufferGeometryUtils.js';
import {build} from 'esbuild';
const bundle = await build({entryPoints:['bevy/tools/glider/mesh.ts'],bundle:true,format:'esm',write:false});
const {curve} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
for (const aircraft of ['c172','airliner']) {
 const path = `bevy/assets/models/${aircraft}.glb`;
 const file = await readFile(path), jl = file.readUInt32LE(12);
 const doc = JSON.parse(file.subarray(20,20+jl));
 if (doc.asset.extras?.exteriorRevision === 1) { console.log(`${aircraft}: exterior already finished`); continue; }
 const bin = file.subarray(28+jl), chunks = [bin]; let length = bin.length;
 function accessor(attribute) {
  const data = Buffer.from(new Float32Array(attribute.array).buffer), min=Array(attribute.itemSize).fill(Infinity), max=min.map(()=>-Infinity);
  attribute.array.forEach((v,i)=>{const k=i%attribute.itemSize;min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);});
  const bufferView=doc.bufferViews.push({buffer:0,byteOffset:length,byteLength:data.length,target:34962})-1;
  chunks.push(data);length+=data.length;
  return doc.accessors.push({bufferView,componentType:5126,count:attribute.count,type:{2:'VEC2',3:'VEC3'}[attribute.itemSize],min,max})-1;
 }
 function read(id) {
  const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],n={VEC2:2,VEC3:3}[a.type];
  if(a.componentType!==5126||!n)throw Error('Expected float vertex data');
  const offset=(v.byteOffset||0)+(a.byteOffset||0);
  return new Float32BufferAttribute(Array.from({length:a.count*n},(_,i)=>bin.readFloatLE(offset+Math.floor(i/n)*(v.byteStride||n*4)+(i%n)*4)),n);
 }
 function geometry(p) {
  if(p.indices!==undefined)throw Error('Expected triangle soup');
  const g=new BufferGeometry();
  for(const [key,semantic]of Object.entries({position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'}))if(p.attributes[semantic]!==undefined)g.setAttribute(key,read(p.attributes[semantic]));
  return g;
 }
 function primitive(g,material) {
  const attributes={};for(const [key,semantic]of Object.entries({position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'}))if(g.attributes[key])attributes[semantic]=accessor(g.attributes[key]);
  return {attributes,material,mode:4};
 }
 function paint(name,color,roughness,metallic=0) {
  return doc.materials.push({name,pbrMetallicRoughness:{baseColorFactor:[...color,1],roughnessFactor:roughness,metallicFactor:metallic}})-1;
 }
 const glass=doc.materials.find(m=>m.name==='glass')?.pbrMetallicRoughness;
 if(glass){glass.baseColorFactor=[.022,.055,.078,1];glass.metallicFactor=.25;glass.roughnessFactor=.12;}
 if(aircraft==='c172') {
  for(const m of doc.materials) {
   const p=m.pbrMetallicRoughness;
   if(m.name==='paint-white'){p.baseColorFactor=[.86,.88,.90,1];p.roughnessFactor=.28;}
   if(m.name==='paint-ua-blue'){p.baseColorFactor=[.008,.035,.10,1];p.roughnessFactor=.26;}
   if(m.name==='paint-navy-grey'){p.baseColorFactor=[.055,.10,.16,1];p.roughnessFactor=.32;}
   if(m.name==='metal')p.roughnessFactor=.22;
  }
  doc.meshes[28].primitives[0].material=paint('exterior-polished-spinner',[.65,.70,.75],.20,.72);
 } else {
  const white=paint('exterior-pearl-white',[.86,.88,.90],.28);
  const navy=paint('exterior-navy-blue',[.008,.028,.09],.26,.06);
  const wing=paint('exterior-wing-grey',[.57,.61,.66],.34);
  // The imported exterior was flat shaded with 18 sides around the fuselage.
  // Resample its measured stations; preserve the cockpit windshield stations
  // and full cabin radius so windows, eye position and gear remain aligned.
  const source=read(doc.meshes[0].primitives[0].attributes.POSITION), rings=new Map();
  for(let i=0;i<source.count;i++) {
   const x=source.getX(i),y=source.getY(i),z=source.getZ(i),r=rings.get(x)||[Infinity,-Infinity,0];
   r[0]=Math.min(r[0],y);r[1]=Math.max(r[1],y);r[2]=Math.max(r[2],Math.abs(z));rings.set(x,r);
  }
  const stations=[...rings].sort((a,b)=>a[0]-b[0]);
  const bottom=curve(stations.map(([x,r])=>[x,r[0]]));
  const top=curve(stations.map(([x,r])=>[x,r[1]]));
  const radius=curve(stations.map(([x,r])=>[x,r[2]/Math.cos(Math.PI/18)]));
  const min=stations[0][0],max=stations.at(-1)[0];
  const xs=[...new Set([...stations.map(s=>s[0]),...Array.from({length:181},(_,i)=>min+(max-min)*i/180)])].sort((a,b)=>a-b);
  function point(x,phi,offset=0) {
   const center=(top(x)+bottom(x))/2,half=(top(x)-bottom(x))/2;
   return [x,center+(half+offset)*Math.cos(phi),(radius(x)+offset)*Math.sin(phi)];
  }
  const positions=[];
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<96;j++) {
   const a=point(xs[i],j*Math.PI/48),b=point(xs[i+1],j*Math.PI/48),c=point(xs[i+1],(j+1)*Math.PI/48),d=point(xs[i],(j+1)*Math.PI/48);
   positions.push(...a,...c,...b,...a,...d,...c);
  }
  for(const [x,front] of [[min,false],[max,true]])for(let j=0;j<96;j++){
   const center=[x,(top(x)+bottom(x))/2,0],a=point(x,j*Math.PI/48),b=point(x,(j+1)*Math.PI/48);
   positions.push(...center,...(front?a:b),...(front?b:a));
  }
  let shell=new BufferGeometry().setAttribute('position',new Float32BufferAttribute(positions,3));shell.computeVertexNormals();
  shell=toCreasedNormals(shell,Math.PI/3);
  doc.meshes[0].primitives=[primitive(shell,white)];
  // Exterior-only materials and crease-aware normals retain hard trailing edges.
  for(let i=1;i<=36;i++)for(const p of doc.meshes[i].primitives) {
   if(p.material===0||p.material===1){p.material=[12,20,31,32].includes(i)?navy:p.material===1?wing:white;
    if(p.indices===undefined){const g=toCreasedNormals(geometry(p),Math.PI/4);p.attributes.NORMAL=accessor(g.attributes.normal);}}
  }
  // Recessed fan blades and hubs replace the featureless black intake disks.
  const fanMetal=paint('exterior-fan-titanium',[.12,.15,.18],.40,.65);
  const hubMetal=paint('exterior-fan-hub',[.19,.22,.25],.32,.6);
  const engines=doc.nodes.find(n=>n.name==='engines');
  function addEngine(name,g,material){
   if(g.index)g=g.toNonIndexed();
   const mesh=doc.meshes.push({name,primitives:[primitive(g,material)]})-1;
   engines.children.push(doc.nodes.push({name,mesh})-1);
  }
  for(const side of [-1,1]){
   const blades=[];
   for(let blade=0;blade<24;blade++)for(let segment=0;segment<5;segment++){
    const angle=blade*Math.PI/12;
    function pt(s,edge){const r=.18+s*.13,a=angle+s*.055+edge*.09;return [5.09+s*.009,1.35+r*Math.cos(a),side*5.8+r*Math.sin(a)];}
    const a=pt(segment,0),b=pt(segment+1,0),c=pt(segment+1,1),d=pt(segment,1);
    blades.push(...a,...b,...c,...a,...c,...d);
   }
   const g=new BufferGeometry().setAttribute('position',new Float32BufferAttribute(blades,3));g.computeVertexNormals();
   addEngine(`engine-fan-blades-${side}`,g,fanMetal);
   addEngine(`engine-fan-hub-${side}`,new ConeGeometry(.205,.40,40).rotateZ(-Math.PI/2).translate(5.09,1.35,side*5.8),hubMetal);
  }
  // Conformal swept cheatline, explicitly attached to the hidden exterior shell.
  const stripe=[];
  for(const side of [-1,1])for(let i=0;i<160;i++) {
   const x0=-16+i*32/160,x1=-16+(i+1)*32/160;
   function edge(x,k) {
    const taper=Math.min(1,(16-x)/4,(x+16)/3),y=3.17-.55*Math.pow(Math.max(0,x)/16,2)+k*.095*taper;
    const center=(top(x)+bottom(x))/2,half=(top(x)-bottom(x))/2;
    const phi=side*Math.acos(Math.max(-.95,Math.min(.95,(y-center)/half)));
    return point(x,phi,.008);
   }
   const a=edge(x0,-1),b=edge(x1,-1),c=edge(x1,1),d=edge(x0,1);
   stripe.push(...(side>0?[a,b,c,a,c,d]:[a,c,b,a,d,c]).flat());
  }
  const g=new BufferGeometry().setAttribute('position',new Float32BufferAttribute(stripe,3));g.computeVertexNormals();
  const mi=doc.meshes.push({name:'navy-fuselage-stripe',primitives:[primitive(g,navy)]})-1;
  doc.nodes.find(n=>n.name==='fuselage').children.push(doc.nodes.push({name:'navy-fuselage-stripe',mesh:mi})-1);
 }
 doc.asset.extras={...doc.asset.extras,exteriorRevision:1};doc.buffers[0].byteLength=length;
 const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
 const header=Buffer.alloc(20),bh=Buffer.alloc(8);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(length);bh.writeUInt32LE(0x004e4942,4);
 await writeFile(path,Buffer.concat([header,padded,bh,...chunks]));console.log(`${aircraft}: exterior finished`);
}
