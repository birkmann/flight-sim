// Keep the panel bearings stationary and the sliding shafts engaged at full travel.
// Imported coordinates: +X forward, +Y up, ±Z across the cockpit.
import {readFile,writeFile} from 'node:fs/promises';
import {BufferGeometry,Float32BufferAttribute,TorusGeometry} from 'three';
const path=new URL('../bevy/assets/models/c172.glb',import.meta.url),file=await readFile(path);
const jsonLength=file.readUInt32LE(12),doc=JSON.parse(file.subarray(20,20+jsonLength));
if(doc.asset.extras?.yokeMountRevision===1){console.log('C172 yoke mounts already repaired.');process.exit(0);}
if(doc.asset.extras?.animatedCabin!==1)throw Error('Install the C172 animation rig first.');
const chunks=[Buffer.from(file.subarray(28+jsonLength))];let length=chunks[0].length;
function append(data){const offset=length;chunks.push(data);length+=data.length;const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}return offset;}
function accessor(values,size){
 const array=new Float32Array(values),data=Buffer.from(array.buffer),min=Array(size).fill(Infinity),max=Array(size).fill(-Infinity);
 array.forEach((v,i)=>{min[i%size]=Math.min(min[i%size],v);max[i%size]=Math.max(max[i%size],v);});
 const view=doc.bufferViews.push({buffer:0,byteOffset:append(data),byteLength:data.length,target:34962})-1;
 return doc.accessors.push({bufferView:view,componentType:5126,count:array.length/size,type:{2:'VEC2',3:'VEC3'}[size],min,max})-1;
}
function read(id){const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],size={VEC2:2,VEC3:3}[a.type];if(a.componentType!==5126||!size)throw Error('Expected float vector');return {size,values:Array.from({length:a.count*size},(_,i)=>chunks[0].readFloatLE((v.byteOffset||0)+(a.byteOffset||0)+Math.floor(i/size)*(v.byteStride||size*4)+i%size*4))};}
function attributes(geometry){if(geometry.index)geometry=geometry.toNonIndexed();return Object.fromEntries(Object.entries(geometry.attributes).filter(([k])=>['position','normal','uv'].includes(k)).map(([k,a])=>[{position:'POSITION',normal:'NORMAL',uv:'TEXCOORD_0'}[k],accessor(a.array,a.itemSize)]));}
function geometry(attrs,ids){const g=new BufferGeometry();for(const [semantic,a] of Object.entries(attrs))g.setAttribute({POSITION:'position',NORMAL:'normal',TEXCOORD_0:'uv'}[semantic],new Float32BufferAttribute(ids.flatMap(i=>a.values.slice(i*a.size,(i+1)*a.size)),a.size));return g;}
function node(name,attrs,material){const mesh=doc.meshes.push({primitives:[{attributes:attrs,material,mode:4}]})-1;return doc.nodes.push({name,mesh})-1;}
const controls=doc.nodes.find(n=>n.name==='crew-station-controls');
for(const side of ['left','right']){
 const yoke=doc.nodes.find(n=>n.name===`cockpit-yoke-${side}`),fixed=[];
 let mountTriangles=0,shaftVertices=0;
 for(const id of yoke.children){
  const child=doc.nodes[id];if(child.mesh===undefined)continue;
  for(const p of doc.meshes[child.mesh].primitives){
   const finish=doc.materials[p.material].name;
   if(!['paint-matte|interior','metal|interior'].includes(finish))continue;
   if(p.indices!==undefined)throw Error('Unexpected indexed control mesh');
   const attrs=Object.fromEntries(Object.entries(p.attributes).map(([k,id])=>[k,read(id)]));
   if(finish==='paint-matte|interior'){
    const moving=[],stationary=[];
    for(let i=0;i<attrs.POSITION.values.length/3;i+=3){const tri=[i,i+1,i+2];(tri.every(j=>attrs.POSITION.values[j*3]>.75)?stationary:moving).push(...tri);}
    if(!stationary.length)continue;
    mountTriangles+=stationary.length/3;
    fixed.push(node(`yoke-panel-socket-${side}`,attributes(geometry(attrs,stationary)),p.material));
    p.attributes=attributes(geometry(attrs,moving));
   }else{
    // Original shaft ends at x≈.810. Extend its buried end by 90 mm:
    // even a full 55 mm aft stroke keeps 35 mm of engagement behind the panel.
    const points=attrs.POSITION.values;
    for(let i=0;i<points.length;i+=3)if(points[i]>.79){points[i]+=.09;shaftVertices++;}
    p.attributes.POSITION=accessor(points,3);child.name=`yoke-sliding-shaft-${side}`;
   }
  }
 }
 if(!mountTriangles||!shaftVertices)throw Error(`Could not identify ${side} mounting parts`);
 const [,y,z]=yoke.extras.controlPivot;
 const rubber=doc.materials.findIndex(m=>m.name==='rubber|interior');
 // Rounded fixed seal disguises the bearing seam while the shaft slides through it.
 fixed.push(node(`yoke-bearing-seal-${side}`,attributes(new TorusGeometry(.020,.004,12,32).rotateY(Math.PI/2).translate(.791,y,z)),rubber));
 controls.children.push(doc.nodes.push({name:`yoke-fixed-mount-${side}`,children:fixed})-1);
 console.log(`${side}: fixed ${mountTriangles} socket triangles; extended ${shaftVertices} shaft vertices`);
}
doc.asset.extras={...doc.asset.extras,yokeMountRevision:1};doc.buffers[0].byteLength=length;
const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+padded.length+length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(length);bh.writeUInt32LE(0x004e4942,4);
await writeFile(path,Buffer.concat([header,padded,bh,...chunks]));
