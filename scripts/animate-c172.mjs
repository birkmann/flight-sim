// Split the imported controls into rigged parts and add detailed cockpit/exterior fittings.
import {readFile,writeFile} from 'node:fs/promises';
import {SphereGeometry,TorusGeometry,CylinderGeometry,BufferGeometry,Float32BufferAttribute} from 'three';
const path=new URL('../bevy/assets/models/c172.glb',import.meta.url),file=await readFile(path);
const jsonLength=file.readUInt32LE(12),doc=JSON.parse(file.subarray(20,20+jsonLength));
if(doc.asset.extras?.animatedCabin===1){console.log('C172 animation rig already installed.');process.exit(0);}
const chunks=[Buffer.from(file.subarray(28+jsonLength))];let length=chunks[0].length;
function append(data){const offset=length;chunks.push(data);length+=data.length;const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}return offset;}
function accessor(values,size){const array=new Float32Array(values),data=Buffer.from(array.buffer);const view=doc.bufferViews.push({buffer:0,byteOffset:append(data),byteLength:data.length,target:34962})-1;return doc.accessors.push({bufferView:view,componentType:5126,count:array.length/size,type:{2:'VEC2',3:'VEC3',4:'VEC4'}[size],min:Array.from({length:size},(_,k)=>Math.min(...array.filter((_,i)=>i%size===k))),max:Array.from({length:size},(_,k)=>Math.max(...array.filter((_,i)=>i%size===k)))})-1;}
function read(id){const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],size={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],bytes={5126:4,5125:4,5123:2}[a.componentType],method={5126:'readFloatLE',5125:'readUInt32LE',5123:'readUInt16LE'}[a.componentType];return {size,values:Array.from({length:a.count*size},(_,i)=>chunks[0][method]((v.byteOffset||0)+(a.byteOffset||0)+Math.floor(i/size)*(v.byteStride||size*bytes)+i%size*bytes))};}
function node(name,geometry,material,extras={}){if(geometry.index)geometry=geometry.toNonIndexed();const attributes={};for(const [key,a]of Object.entries(geometry.attributes)){const semantic={position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'}[key];if(semantic)attributes[semantic]=accessor(a.array,a.itemSize);}const mesh=doc.meshes.push({primitives:[{attributes,material,mode:4}]})-1;return doc.nodes.push({name,mesh,extras})-1;}
function material(name,color,emissive=0){const m={name,pbrMetallicRoughness:{baseColorFactor:[...color,1],metallicFactor:0.2,roughnessFactor:.55}};if(emissive){m.emissiveFactor=color;m.extensions={KHR_materials_emissive_strength:{emissiveStrength:emissive}};}return doc.materials.push(m)-1;}
const controls=doc.nodes.find(n=>n.name==='crew-station-controls'),groups={};
for(const id of controls.children)for(const p of doc.meshes[doc.nodes[id].mesh].primitives){
 const attrs=Object.fromEntries(Object.entries(p.attributes).map(([k,id])=>[k,read(id)]));
 const indices=p.indices===undefined?Array.from({length:attrs.POSITION.values.length/3},(_,i)=>i):read(p.indices).values;
 const partitions={};
 for(let i=0;i<indices.length;i+=3){const ids=indices.slice(i,i+3);const y=ids.reduce((n,j)=>n+attrs.POSITION.values[j*3+1],0)/3,z=ids.reduce((n,j)=>n+attrs.POSITION.values[j*3+2],0)/3;const side=z<0?'left':'right';const key=y>1.15?`yoke-${side}`:`pedal-${side}`;(partitions[key]??=[]).push(...ids);}
 for(const [key,ids]of Object.entries(partitions)){const g=new BufferGeometry();for(const [semantic,a]of Object.entries(attrs)){const key={POSITION:'position',NORMAL:'normal',TEXCOORD_0:'uv'}[semantic];if(key)g.setAttribute(key,new Float32BufferAttribute(ids.flatMap(i=>a.values.slice(i*a.size,(i+1)*a.size)),a.size));}const child=node('',g,p.material);(groups[key]??=[]).push(child);}
}
controls.children=Object.entries(groups).map(([key,children])=>doc.nodes.push({name:`cockpit-${key}`,children,extras:{controlPivot:[.57955,1.30055,key.endsWith('left')?-.27:.27],side:key.endsWith('left')?-1:1}})-1);
// A softer machined collar around each yoke shaft and a raised center emblem.
const metal=material('cockpit-brushed-aluminium',[.3,.34,.38]),dark=material('cockpit-satin-trim',[.025,.03,.036]);
for(const [key,children]of Object.entries(groups))if(key.startsWith('yoke')){
 const z=key.endsWith('left')?-.27:.27;
 const ring=new TorusGeometry(.022,.004,12,36).rotateY(Math.PI/2).translate(.575,1.30055,z);
 children.push(node('yoke-machined-collar',ring,metal));
 const badge=new CylinderGeometry(.018,.018,.004,32).rotateZ(Math.PI/2).translate(.539,1.294,z);
 children.push(node('yoke-center-badge',badge,metal));
}
const station=doc.nodes.find(n=>n.name==='crew-station');
// The radio stack is a perspective-correct live texture, seated over the old blank rectangles.
const rake=6*Math.PI/180,front=(z,y)=>[.795+(y-1.4)*Math.tan(rake),y,z];
const quad=new BufferGeometry();quad.setAttribute('position',new Float32BufferAttribute([front(.044,1.277),front(.214,1.277),front(.214,1.598),front(.044,1.598)].flat(),3));quad.setAttribute('uv',new Float32BufferAttribute([0,1,1,1,1,0,0,0],2));quad.setIndex([0,1,2,0,2,3]);quad.computeVertexNormals();
station.children.push(node('display-radio',quad,dark));
// Fasteners and instrument-panel dimmer have actual depth, even when the instruments are 2D.
for(const y of [1.365,1.583])for(const z of [-.47,-.22,.02])station.children.push(node('panel-fastener',new SphereGeometry(.004,12,8).scale(.4,1,1).translate(.798+(y-1.4)*Math.tan(rake),y,z),metal));
// Tail anti-collision beacon plus synchronized double-flash wingtip strobes.
const white=material('strobe-emitter',[1,.97,.87],12),red=material('beacon-emitter',[1,.02,.008],8);
for(const [name,point,phase,mat,radius]of [['left-strobe',[-.02,2.28,-5.5],0,white,.035],['right-strobe',[-.02,2.28,5.5],0,white,.035],['tail-beacon',[-5.42,2.735,0],.6,red,.03]]){
 const geometry=new SphereGeometry(radius,16,12).translate(...point);
 doc.nodes[0].children.push(node(`aircraft-lamp-${name}`,geometry,mat,{phase}));
}
// The original beacon lens remains visible between flashes, without emitting constantly.
const beacon=doc.nodes[112],primitive=doc.meshes[beacon.mesh].primitives[0];
const lens=structuredClone(doc.materials[primitive.material]);lens.name='beacon-lens';delete lens.emissiveFactor;delete lens.extensions;primitive.material=doc.materials.push(lens)-1;
const blur=doc.materials.find(m=>m.name==='rotor-disc');blur.pbrMetallicRoughness.baseColorFactor=[.22,.25,.28,.23];
doc.asset.extras={...doc.asset.extras,animatedCabin:1};doc.buffers[0].byteLength=length;
const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(length,0);bh.writeUInt32LE(0x004e4942,4);
await writeFile(path,Buffer.concat([header,padded,bh,...chunks]));console.log('C172: animated control rig, live radio stack, panel fittings and flashing lights.');
