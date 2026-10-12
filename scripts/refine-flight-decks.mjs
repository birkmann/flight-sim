// Civilian flight deck finish and forward visibility. Preserves embedded textures,
// screen UVs and animation nodes; safely repeatable on the imported GLBs.
import {readFile,writeFile} from 'node:fs/promises';
const mask=JSON.parse(await readFile(new URL('./ui/airliner-hud-mask.json',import.meta.url),'utf8'));
// Exact vertices of headUp() from eu-ui/packages/globe/src/cockpits/airlinerCockpit.ts,
// evaluated at fuselage y=3.4. Matching whole triangles avoids cutting nearby panels.
for(const name of ['airliner','c172']){
 const path=new URL(`../bevy/assets/models/${name}.glb`,import.meta.url),file=await readFile(path);
 const len=file.readUInt32LE(12),doc=JSON.parse(file.subarray(20,20+len));let bin=Buffer.from(file.subarray(28+len));
 const revision='immersive-cabin-v1';if(doc.asset.extras?.finishRevision===revision){console.log(`${name}: already refined`);continue;}
 let removed=0;
 if(name==='airliner'){
  for(const node of doc.nodes){
   if(node.children)node.children=node.children.filter(i=>doc.nodes[i].name!=='hud-combiner');
   if(node.mesh===undefined)continue;
   for(const p of doc.meshes[node.mesh].primitives){
    const finish=doc.materials[p.material].name?.split('|')[0];if(!mask[finish])continue;
    const points=new Set(mask[finish]),a=doc.accessors[p.attributes.POSITION],v=doc.bufferViews[a.bufferView];
    const offset=(v.byteOffset||0)+(a.byteOffset||0),stride=v.byteStride||12;
    const match=i=>points.has([0,1,2].map(k=>bin.readFloatLE(offset+i*stride+k*4).toFixed(4)).join(','));
    let indices=Array.from({length:a.count},(_,i)=>i);
    if(p.indices!==undefined){const ia=doc.accessors[p.indices],iv=doc.bufferViews[ia.bufferView],io=(iv.byteOffset||0)+(ia.byteOffset||0);const bytes=ia.componentType===5125?4:2;indices=Array.from({length:ia.count},(_,i)=>bytes===4?bin.readUInt32LE(io+i*bytes):bin.readUInt16LE(io+i*bytes));}
    const kept=[];for(let i=0;i<indices.length;i+=3){const tri=indices.slice(i,i+3);if(tri.every(match))removed++;else kept.push(...tri);}
    if(kept.length===indices.length)continue;
    const start=Math.ceil(bin.length/4)*4,data=Buffer.alloc(kept.length*4);kept.forEach((n,i)=>data.writeUInt32LE(n,i*4));bin=Buffer.concat([bin,Buffer.alloc(start-bin.length),data]);
    p.indices=doc.accessors.length;doc.accessors.push({bufferView:doc.bufferViews.length,componentType:5125,count:kept.length,type:'SCALAR'});doc.bufferViews.push({buffer:0,byteOffset:start,byteLength:data.length,target:34963});
   }
  }
  if(removed<100)throw Error(`Expected the complete HUD frame, found only ${removed} triangles`);
 }
 for(const m of doc.materials){
  if(!m.name?.endsWith('|interior'))continue;
  if(m.normalTexture)m.normalTexture.scale=m.name.startsWith('metal')?.035:.09;
  if(m.name.startsWith('cockpit-faceplate'))m.pbrMetallicRoughness.roughnessFactor=.82;
  if(m.name.startsWith('cockpit-glareshield'))m.pbrMetallicRoughness.roughnessFactor=.96;
 }
 doc.asset.extras={...doc.asset.extras,finishRevision:revision};doc.buffers[0].byteLength=bin.length;
 const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
 const out=Buffer.alloc(28+padded.length+bin.length);out.writeUInt32LE(0x46546c67);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(padded.length,12);out.writeUInt32LE(0x4e4f534a,16);padded.copy(out,20);out.writeUInt32LE(bin.length,20+padded.length);out.writeUInt32LE(0x004e4942,24+padded.length);bin.copy(out,28+padded.length);
 await writeFile(path,out);console.log(`${name}: refined surface grain; ${removed} unused HUD triangles removed`);
}
