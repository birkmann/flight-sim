import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as T from 'three';

// Read the actual shipped geometry, including node transforms and visibility.
// No browser/GPU is needed to check that the instrument faces are unobstructed.
async function cabin(path) {
  const file = await readFile(path), jsonLength = file.readUInt32LE(12);
  const doc = JSON.parse(file.subarray(20, 20 + jsonLength)), start = 28 + jsonLength;
  function attribute(id) {
    const a = doc.accessors[id], v = doc.bufferViews[a.bufferView];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const [bytes, read] = { 5121: [1, 'readUInt8'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] }[a.componentType];
    const offset = start + (v.byteOffset || 0) + (a.byteOffset || 0);
    const values = Array.from({ length: a.count * size }, (_, i) => file[read](offset + Math.floor(i / size) * (v.byteStride || size * bytes) + i % size * bytes));
    return a.componentType === 5126 ? new T.Float32BufferAttribute(values, size) : new T.Uint32BufferAttribute(values, size);
  }
  const nodes = doc.nodes.map(n => {
    const object = new T.Group(); object.name = n.name || '';
    object.visible = !n.extras?.cockpitHidden; object.userData = n.extras || {};
    if (n.matrix) object.applyMatrix4(new T.Matrix4().fromArray(n.matrix));
    else {
      if (n.translation) object.position.fromArray(n.translation);
      if (n.rotation) object.quaternion.fromArray(n.rotation);
      if (n.scale) object.scale.fromArray(n.scale);
    }
    for (const p of doc.meshes[n.mesh]?.primitives || []) {
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', attribute(p.attributes.POSITION));
      if (p.attributes.TEXCOORD_0 !== undefined) geometry.setAttribute('uv', attribute(p.attributes.TEXCOORD_0));
      if (p.indices !== undefined) geometry.setIndex(attribute(p.indices));
      const material = doc.materials[p.material];
      // Opaque cockpit surfaces block the view. Transparent glazing does not.
      if (material.alphaMode === 'BLEND') continue;
      object.add(new T.Mesh(geometry, new T.MeshBasicMaterial({ side: material.doubleSided ? T.DoubleSide : T.FrontSide })));
    }
    return object;
  });
  doc.nodes.forEach((n, i) => (n.children || []).forEach(child => nodes[i].add(nodes[child])));
  const root = new T.Group(); root.rotation.y = Math.PI; // Runtime airframe orientation.
  doc.scenes[doc.scene || 0].nodes.forEach(i => root.add(nodes[i])); root.updateMatrixWorld(true);
  return root;
}

test('C172 gauges remain unobstructed and framed at the default cockpit field of view', async () => {
  const root = await cabin(new URL('../../bevy/assets/models/c172.glb', import.meta.url));
  const seat = root.getObjectByName('crew-eye'), eye = seat.getWorldPosition(new T.Vector3());
  const screen = root.getObjectByName('display-ga').children[0];
  const pos = screen.geometry.attributes.position, uv = screen.geometry.attributes.uv;
  const corners = Array.from({ length: pos.count }, (_, i) => ({
    point: new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(screen.matrixWorld),
    u: uv.getX(i), v: uv.getY(i),
  }));
  const origin = corners.find(c => c.u === 0 && c.v === 0).point;
  const horizontal = corners.find(c => c.u === 1 && c.v === 0).point.clone().sub(origin);
  const vertical = corners.find(c => c.u === 0 && c.v === 1).point.clone().sub(origin);
  const targets = [];
  for (let u = .02; u < 1; u += .04) for (let v = .02; v < 1; v += .08) {
    const point = origin.clone().addScaledVector(horizontal, u).addScaledVector(vertical, v);
    const direction = point.clone().sub(eye);
    const ray = new T.Raycaster(eye, direction.clone().normalize(), .01, direction.length() - .003);
    const blocked = ray.intersectObject(root).filter(hit => {
      for (let n = hit.object; n; n = n.parent) if (!n.visible) return false;
      return true;
    });
    assert.equal(blocked.length, 0, `Cabin blocks instrument face at UV ${u.toFixed(2)}, ${v.toFixed(2)}`);
    targets.push(point);
  }
  for (const [width, height] of [[1045, 1280], [1440, 1000]]) {
    const camera = new T.PerspectiveCamera(50, width / height, .01, 1000);
    camera.position.copy(eye); camera.rotation.x = T.MathUtils.degToRad(seat.userData.pitchDeg);
    camera.updateMatrixWorld(true);
    for (const point of targets) {
      const p = point.clone().project(camera);
      assert.ok(Math.abs(p.x) < .98 && Math.abs(p.y) < .98 && p.z < 1,
        `Instrument cropped at ${width}×${height}: ${p.toArray()}`);
    }
  }
});

test('C172 rig separates moving controls, lights, propeller blur and a front-facing radio surface',async()=>{
 const root=await cabin(new URL('../../bevy/assets/models/c172.glb',import.meta.url));
 for(const name of ['cockpit-yoke-left','cockpit-yoke-right','cockpit-pedal-left','cockpit-pedal-right']){
  const part=root.getObjectByName(name);assert.ok(part,`${name} is present in scene`);
  assert.ok(part.children.length>0);assert.ok(part.userData.controlPivot.every(Number.isFinite));
 }
 const yoke=root.getObjectByName('cockpit-yoke-left');
 const before=new T.Box3().setFromObject(yoke).getCenter(new T.Vector3());
 const pivot=new T.Vector3().fromArray(yoke.userData.controlPivot),q=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),.65);
 yoke.position.copy(pivot).sub(pivot.clone().applyQuaternion(q)).add(new T.Vector3(-.055,0,0));yoke.quaternion.copy(q);root.updateMatrixWorld(true);
 assert.ok(new T.Box3().setFromObject(yoke).getCenter(new T.Vector3()).distanceTo(before)>.03,'rig has visible movement at full input');
 for(const side of ['left-strobe','right-strobe','tail-beacon'])assert.ok(root.getObjectByName('aircraft-lamp-'+side));
 assert.ok(root.getObjectByName('rotor-disc-0'));
 const face=root.getObjectByName('display-radio').children[0],p=face.geometry.attributes.position;
 const [a,b,c]=[0,1,2].map(i=>new T.Vector3().fromBufferAttribute(p,i).applyMatrix4(face.matrixWorld));
 const eye=root.getObjectByName('crew-eye').getWorldPosition(new T.Vector3());
 assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).dot(eye.clone().sub(a))>0,'radio front face points towards the pilot');
});

test('airliner windshield is clear of the unused close-up combiner frame', async () => {
  const root = await cabin(new URL('../../bevy/assets/models/airliner.glb', import.meta.url));
  assert.equal(root.getObjectByName('hud-combiner'), undefined);
  const eye = root.getObjectByName('crew-eye').getWorldPosition(new T.Vector3());
  // Sample the volume where the combiner and its supports previously crossed the view.
  for (const x of [-.09, 0, .09]) for (const y of [-.01, .06]) {
    const ray = new T.Raycaster(eye, new T.Vector3(x,y,-.34).normalize(), .02, .45);
    const hits = ray.intersectObject(root).filter(hit => {
      for (let node=hit.object;node;node=node.parent) if (!node.visible) return false;
      return true;
    });
    assert.equal(hits.length, 0, `Cockpit obstruction at ${x}, ${y}`);
  }
});

test('both C172 yokes stay seated in fixed panel bearings through full pitch and roll travel',async()=>{
 const root=await cabin(new URL('../../bevy/assets/models/c172.glb',import.meta.url));
 for(const side of ['left','right']){
  const yoke=root.getObjectByName(`cockpit-yoke-${side}`),mount=root.getObjectByName(`yoke-fixed-mount-${side}`),shaft=root.getObjectByName(`yoke-sliding-shaft-${side}`);
  assert.ok(mount&&shaft,'Separate fixed mounting socket and sliding shaft exist');
  assert.equal(mount.parent,yoke.parent,'Mount belongs to the stationary cockpit');
  const fixed=mount.matrixWorld.clone(),pivot=new T.Vector3().fromArray(yoke.userData.controlPivot);
  for(const pitch of [-1,0,1])for(const roll of [-1,0,1]){
   const q=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),-roll*.65);
   yoke.position.copy(pivot).sub(pivot.clone().applyQuaternion(q)).add(new T.Vector3(-pitch*.055,0,0));yoke.quaternion.copy(q);root.updateMatrixWorld(true);
   assert.deepEqual(mount.matrixWorld.elements,fixed.elements,'Dashboard bearing must never move with the controls');
   const inverse=yoke.parent.matrixWorld.clone().invert(),box=new T.Box3();
   shaft.traverse(n=>{if(!n.isMesh)return;const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)box.expandByPoint(new T.Vector3().fromBufferAttribute(a,i).applyMatrix4(n.matrixWorld).applyMatrix4(inverse));});
   assert.ok(box.min.x<.74&&box.max.x>.839,`${side} shaft loses panel engagement at pitch ${pitch}, roll ${roll}`);
   const axis=box.getCenter(new T.Vector3());
   assert.ok(Math.abs(axis.y-pivot.y)<.0001&&Math.abs(axis.z-pivot.z)<.0001,'Shaft stays concentric with its bearing');
  }
 }
});
