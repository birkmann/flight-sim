import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('imported glider GLB preserves a 15 m span, embedded textures, eye point and moving control surfaces',async()=>{
 const file=await readFile(new URL('../../bevy/assets/models/glider.glb',import.meta.url));
 assert.equal(file.readUInt32LE(0),0x46546c67);assert.equal(file.readUInt32LE(8),file.length);
 const doc=JSON.parse(file.subarray(20,20+file.readUInt32LE(12)).toString());
 const station=doc.nodes.find(n=>n.name==='crew-station');
 assert.ok(station?.children.some(i=>doc.nodes[i].name==='display-glider'),'live instruments belong to the 3D crew station');
 assert.equal(doc.nodes.find(n=>n.name==='pilot').extras.cockpitHidden,true,'pilot head must not obstruct the eye');
 // A correctly named screen can still disappear if its triangles face away from the seat.
 const binStart=28+file.readUInt32LE(12);
 const readAccessor=id=>{
  const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],n={SCALAR:1,VEC2:2,VEC3:3}[a.type];
  const bytes=a.componentType===5123?2:4,read=a.componentType===5126?'readFloatLE':a.componentType===5123?'readUInt16LE':'readUInt32LE';
  const start=binStart+(v.byteOffset||0)+(a.byteOffset||0);
  return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,k)=>file[read](start+i*(v.byteStride||n*bytes)+k*bytes)));
 };
 const screen=doc.nodes.find(n=>n.name==='display-glider'),face=doc.meshes[screen.mesh].primitives[0];
 const positionsFace=readAccessor(face.attributes.POSITION),indices=readAccessor(face.indices).flat();
 const eye=doc.nodes.find(n=>n.name==='crew-eye').matrix.slice(12,15);
 for(let i=0;i<indices.length;i+=3){
  const [a,b,c]=indices.slice(i,i+3).map(k=>positionsFace[k]);
  const u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
  const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  assert.ok(normal.reduce((sum,n,k)=>sum+n*(eye[k]-a[k]),0)>0,'instrument face must face the pilot with backface culling enabled');
 }

 assert.equal(doc.images.length,2);assert.ok(doc.nodes.some(n=>n.name==='crew-eye'));
 const controls=doc.nodes.filter(n=>n.name.startsWith('glider-hinge-'));
 assert.equal(controls.length,4);
 for(const n of controls){assert.ok(n.extras.pivot.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...n.extras.axis)-1)<.001);assert.ok(n.extras.maxDeg!==0);}
 assert.equal(doc.nodes.filter(n=>n.name.startsWith('glider-brake-')).length,2);
 const positions=doc.meshes.flatMap(m=>m.primitives.map(p=>doc.accessors[p.attributes.POSITION]));
 const span=Math.max(...positions.map(a=>a.max[0]))-Math.min(...positions.map(a=>a.min[0]));
 assert.ok(span>14.8&&span<15.5,`span ${span}`);
 const binLength=file.readUInt32LE(20+file.readUInt32LE(12));
 for(const view of doc.bufferViews)assert.ok((view.byteOffset||0)+view.byteLength<=binLength);
 for(const t of doc.textures)assert.ok(doc.images[t.source]);
});
