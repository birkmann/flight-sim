// Menu artwork rendered from the same aircraft that the simulator loads.
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import geography from './world.json';
const renderer = new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
renderer.setSize(1600,900);renderer.setPixelRatio(1);
renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
document.body.style.margin='0';document.body.append(renderer.domElement);
const material=(color,roughness=.6,metalness=.2)=>new T.MeshStandardMaterial({color,roughness,metalness});
function box(scene,size,pos,mat){const m=new T.Mesh(new T.BoxGeometry(...size),mat);m.position.set(...pos);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;}
window.renderGallery=async id=>{
 const scene=new T.Scene();scene.background=new T.Color('#243647');scene.fog=new T.Fog('#243647',55,150);
 const camera=new T.PerspectiveCamera(38,1600/900,.05,500);
 scene.add(new T.HemisphereLight('#d9f1ff','#465461',2));
 const key=new T.DirectionalLight('#fff0d8',4);key.position.set(-12,25,14);key.castShadow=true;
 key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-30;key.shadow.camera.right=30;key.shadow.camera.top=30;key.shadow.camera.bottom=-30;key.shadow.bias=-.0005;scene.add(key);
 const rim=new T.DirectionalLight('#75baff',3);rim.position.set(10,8,-15);scene.add(rim);
 if(id==='world'){
  scene.background=new T.Color('#061320');scene.fog=null;
  const c=document.createElement('canvas');c.width=2048;c.height=1024;const ctx=c.getContext('2d');
  ctx.fillStyle='#143449';ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle='#6c9a9b';ctx.strokeStyle='#95b8b8';ctx.lineWidth=.6;
  for(const f of geography.features){const polys=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;for(const rings of polys){ctx.beginPath();for(const ring of rings){ring.forEach(([lon,lat],i)=>ctx[i?'lineTo':'moveTo']((lon+180)/360*c.width,(90-lat)/180*c.height));ctx.closePath();}ctx.fill('evenodd');ctx.stroke();}}
  ctx.strokeStyle='#add9ec22';ctx.lineWidth=1;
  for(let lon=0;lon<=360;lon+=15){ctx.beginPath();ctx.moveTo(lon/360*c.width,0);ctx.lineTo(lon/360*c.width,c.height);ctx.stroke();}
  for(let lat=0;lat<=180;lat+=15){ctx.beginPath();ctx.moveTo(0,lat/180*c.height);ctx.lineTo(c.width,lat/180*c.height);ctx.stroke();}
  const tx=new T.CanvasTexture(c);tx.colorSpace=T.SRGBColorSpace;
  const globe=new T.Mesh(new T.SphereGeometry(4,128,64),new T.MeshStandardMaterial({map:tx,roughness:.92}));globe.rotation.y=-Math.PI*.58;globe.rotation.z=-.2;scene.add(globe);
  const atmosphere=new T.Mesh(new T.SphereGeometry(4.07,128,64),new T.MeshBasicMaterial({color:'#48bfff',transparent:true,opacity:.1,side:T.BackSide}));scene.add(atmosphere);
  camera.position.set(0,1,12);camera.lookAt(.8,.5,0);
 }else{
  const floor=box(scene,[180,.15,180],[0,-.15,0],material('#647681',.4,.35));
  const beam=material('#24323e');
  for(let z=-48;z<30;z+=12){box(scene,[.5,19,.5],[-24,9,z],beam);box(scene,[.5,19,.5],[24,9,z],beam);box(scene,[49,.55,.5],[0,18,z],beam);}
  box(scene,[55,20,.5],[0,9,-38],material('#314452'));
  for(let x=-24;x<25;x+=4){box(scene,[.12,20,.4],[x,9,-37.5],beam);box(scene,[3.4,5,.12],[x+1.8,13,-37.2],new T.MeshBasicMaterial({color:'#9cb3c0'}));}
  for(let x=-24;x<26;x+=8)box(scene,[.12,.015,110],[x,-.06,-15],material('#adc5d0'));
  for(let z=-35;z<40;z+=9)box(scene,[.25,.02,3],[0,-.05,z],material('#e0cb86'));
  const craft=(await new GLTFLoader().loadAsync('/assets/models/'+id+'.glb')).scene;
  craft.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}if(n.name==='crew-station')n.visible=false;if(n.name.startsWith('rotor-disc')||n.name.startsWith('aircraft-lamp-'))n.visible=false;});
  craft.rotation.y=.4;craft.updateMatrixWorld(true);const b=new T.Box3().setFromObject(craft),size=b.getSize(new T.Vector3());
  const scale=13/Math.max(size.x,size.z);craft.scale.setScalar(scale);craft.updateMatrixWorld(true);const bounds=new T.Box3().setFromObject(craft);const center=bounds.getCenter(new T.Vector3());craft.position.set(-center.x,-bounds.min.y,-center.z);scene.add(craft);
  camera.position.set(10,4.5,12);camera.lookAt(0,1.2,0);
 }
 renderer.render(scene,camera);await new Promise(r=>setTimeout(r,100));renderer.render(scene,camera);
};
