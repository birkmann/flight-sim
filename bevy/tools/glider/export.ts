import { buildGlider, buildDecals, NODE_NAMES } from './design';
import { writeGlb, type GlbMaterial, type GlbNode } from './glb';
import { panelTexture, registrationTexture } from './textures';
const MATERIALS: Record<string, Omit<GlbMaterial, "name">> = {
  white: { baseColor: [0.93, 0.935, 0.94, 1], metallic: 0, roughness: 0.24 },
  whiteDS: { baseColor: [0.93, 0.935, 0.94, 1], metallic: 0, roughness: 0.3, doubleSided: true },
  seam: { baseColor: [0.48, 0.49, 0.5, 1], metallic: 0, roughness: 0.6 },
  frame: { baseColor: [0.035, 0.037, 0.04, 1], metallic: 0, roughness: 0.45, doubleSided: true },
  glassOut: { baseColor: [0.05, 0.08, 0.11, 0.68], metallic: 0.2, roughness: 0.03, alphaMode: "BLEND" },
  glassIn: { baseColor: [0.16, 0.2, 0.24, 0.1], metallic: 0, roughness: 0.05, alphaMode: "BLEND" },
  interior: { baseColor: [0.1, 0.105, 0.11, 1], metallic: 0, roughness: 0.9 },
  coaming: { baseColor: [0.045, 0.047, 0.05, 1], metallic: 0, roughness: 0.92, doubleSided: true },
  panel: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.55 },
  well: { baseColor: [0.12, 0.125, 0.13, 1], metallic: 0, roughness: 0.85 },
  cavity: { baseColor: [0.07, 0.07, 0.075, 1], metallic: 0, roughness: 0.9, doubleSided: true },
  tire: { baseColor: [0.035, 0.035, 0.04, 1], metallic: 0, roughness: 0.85 },
  metal: { baseColor: [0.66, 0.67, 0.69, 1], metallic: 0.75, roughness: 0.35, doubleSided: true },
  stick: { baseColor: [0.04, 0.04, 0.045, 1], metallic: 0, roughness: 0.6 },
  skin: { baseColor: [0.78, 0.59, 0.48, 1], metallic: 0, roughness: 0.7 },
  hair: { baseColor: [0.2, 0.15, 0.11, 1], metallic: 0, roughness: 0.85 },
  shirt: { baseColor: [0.4, 0.5, 0.6, 1], metallic: 0, roughness: 0.85 },
  trousers: { baseColor: [0.5, 0.46, 0.39, 1], metallic: 0, roughness: 0.9 },
  decal: { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.35, alphaMode: "BLEND" },
};


export async function exportGlider() {
 const geo = buildGlider(); buildDecals(geo.meshes.body);
 const names = Object.keys(MATERIALS);
 const materials = names.map(name => ({name, ...MATERIALS[name]}));
 materials[names.indexOf('decal')].texture=0;
 materials[names.indexOf('panel')].texture=1;
 const nodes: GlbNode[] = [{ name:'glider', children: NODE_NAMES.map((_,i)=>i+1) }];
 for(const name of NODE_NAMES) {
  const primitives=geo.meshes[name].toPrimitives(n=>names.indexOf(n));
  // Source is X forward / Y left / Z up; our models are Z forward / X left / Y up.
  for(const p of primitives) for(const values of [p.positions,p.normals])
   for(let i=0;i<values.length;i+=3) {const [x,y,z]=values.slice(i,i+3); values.set([y,z,x],i);}
  const hinge = geo.hinges[name];
  const transform = (v:number[]) => [v[1],v[2],v[0]];
  if(hinge?.axis) {
   const role = name.startsWith('aileron')?'aileron':name;
   const maxDeg = role==='aileron'?(name==='aileronL'?-20:20):role==='rudder'?-25:18;
   nodes.push({name:'glider-hinge-'+name,primitives,extras:{role,maxDeg,axis:transform(hinge.axis),pivot:transform(hinge.p)}});
  } else if(name.startsWith('brake')) {
   nodes.push({name:'glider-brake-'+name,primitives,extras:{axis:transform(geo.brakeDir[name==='brakeL'?'L':'R'])}});
  } else nodes.push({name,primitives, ...(name === 'pilot' ? {extras:{cockpitHidden:true}} : {})});
 }
 nodes[0].children!.push(nodes.length);
 const [x,y,z]=geo.eye;
 nodes.push({name:'crew-eye', extras:{pitchDeg:-10}, matrix:[1,0,0,0,0,1,0,0,0,0,1,0,y,z,x,1]});
 // Keep the modeled tub, canopy, controls and coaming visible from the pilot's seat.
 // The panel's original UVs place the live 2D instruments on the tilted 3D face.
 const cockpit=nodes.find(n=>n.name==='cockpit')!;
 const panel=cockpit.primitives!.filter(p=>p.material===names.indexOf('panel'));
 cockpit.primitives=cockpit.primitives!.filter(p=>p.material!==names.indexOf('panel'));
 // Outside views retain the original static panel; only the inside face is animated.
 nodes[0].children!.push(nodes.length);
 nodes.push({name:'glider-static-panel',primitives:panel,extras:{cockpitHidden:true}});
 const display=nodes.length;
 nodes.push({name:'display-glider',primitives:panel});
 nodes[0].children!.push(nodes.length);
 nodes.push({name:'crew-station',children:[display]});
 return writeGlb({nodes,root:0,materials,images:[
  {bytes:await registrationTexture('D-1501',geo.decal.aspect),mimeType:'image/png'},
  {bytes:await panelTexture(),mimeType:'image/png'}
 ]});
}
(window as any).exportGlider=exportGlider;
