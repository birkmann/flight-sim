import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('finished airliner shell faces outwards and retains animated controls and a separate cockpit',async()=>{
 const file=await readFile(new URL('../../bevy/assets/models/airliner.glb',import.meta.url));
 const length=file.readUInt32LE(12),doc=JSON.parse(file.subarray(20,20+length));
 const shell=doc.meshes[0].primitives[0];
 const read=id=>{const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],offset=28+length+(v.byteOffset||0)+(a.byteOffset||0);
  return Array.from({length:a.count},(_,i)=>[0,1,2].map(k=>file.readFloatLE(offset+i*(v.byteStride||12)+k*4)));};
 const p=read(shell.attributes.POSITION),n=read(shell.attributes.NORMAL);
 // A rewound loft can look correct in a double-sided preview but disappear in Bevy.
 let checked=0;
 for(let i=0;i<p.length;i+=3){
  if(p[i][0]<-9||p[i][0]>12)continue;
  const [a,b,c]=p.slice(i,i+3),u=b.map((v,k)=>v-a[k]),v=c.map((v,k)=>v-a[k]);
  const face=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  assert.ok(face[1]*(a[1]-3.43)+face[2]*a[2]>0,'shell triangles face outwards');
  assert.ok(n[i][1]*(a[1]-3.43)+n[i][2]*a[2]>0,'shell shading normals face outwards');checked++;
 }
 assert.ok(checked>1000);
 assert.equal(doc.nodes.find(n=>n.name==='fuselage').extras.cockpitHidden,true);
 assert.ok(doc.nodes.some(n=>n.name==='crew-eye'));
 for(const role of ['aileron','elevator','rudder','flap'])assert.ok(doc.nodes.some(n=>n.extras?.role===role),role);
 for(const i of [12,20,31,32])assert.equal(doc.materials[doc.meshes[i].primitives[0].material].name,'exterior-navy-blue');
});
