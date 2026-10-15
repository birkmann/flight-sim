import {useEffect,useRef} from 'react';
import {CockpitDefs,Gauge,Asi,Altimeter,Compass,Vario,SlipBall} from './cockpit/instruments';
import {Dial,Attitude} from './Panels';
import {flightHazard} from './hazards';
const win=window as any;

/** Conventional signed VSI: zero to the left, climb above and descent below. */
function VerticalSpeed({value}:{value:number}){
 const point=(v:number,r:number)=>{const a=(-90+Math.max(-2000,Math.min(2000,v))/2000*160)*Math.PI/180;return [Math.sin(a)*r,-Math.cos(a)*r];};
 return <g>
  <g data-layer="base">{Array.from({length:41},(_,i)=>{const v=(i-20)*100,a=point(v,i%5===0?69:76),b=point(v,85),t=point(v,57);return <g key={i}><path d={`M${a}L${b}`} stroke="#e7e5dc" strokeWidth={i%5===0?2.3:1}/>{i%5===0&&<text x={t[0]} y={t[1]+4} textAnchor="middle" fill="#e7e5dc" fontSize="12">{Math.abs(v)/100}</text>}</g>;})}
  <text y="-29" textAnchor="middle" fill="#c8d0d1" fontSize="9">VERTICAL SPEED</text><text y="35" textAnchor="middle" fill="#c8d0d1" fontSize="10">100 FEET / MIN</text>
  <text x="34" y="-8" fill="#b8c3c7" fontSize="9">UP</text><text x="34" y="16" fill="#b8c3c7" fontSize="9">DN</text></g>
  <g transform={`rotate(${Math.max(-2000,Math.min(2000,value))/2000*160})`}><path d="M-83 0L5 -4L20 0L5 4Z" fill="#eeeade" stroke="#15191c" strokeWidth="1.5"/></g><circle r="9" fill="#101519" stroke="#6a7277" strokeWidth="2"/>
 </g>;
}

/** Rasterize live SVG instrument faces into the UV-mapped surfaces of the actual cockpit.
 * The aircraft mesh supplies perspective, depth, occlusion and head-look motion.
 *
 * The panel is rasterized in three layers, composited in paint order: the static `base` (panel, wells, bezels and
 * fixed dial faces: most of the gradient-filled area and of the markings), the moving parts (`data-layer` unset:
 * needles, cards, the attitude ball, live text), and the static `glass` over each dial. The two static layers are rasterized again only when their markup
 * changes, so each update rasterizes just the moving parts. The dials stand apart, so nothing of one layer lies under
 * an element of an earlier one: the result is the panel painted in one go. An unchanged panel is not redrawn. */
const layerMarkup=(root:SVGSVGElement,keep:'base'|'glass'|'moving')=>{
 const c=root.cloneNode(true) as SVGSVGElement;
 if(keep==='moving')c.querySelectorAll('[data-layer]').forEach(e=>e.remove());
 else{
  // Hidden but for the layer; paint servers (the panel's grain pattern) keep their content visible.
  c.setAttribute('visibility','hidden');
  c.querySelectorAll('defs').forEach(e=>e.setAttribute('visibility','visible'));
  c.querySelectorAll('[data-layer]').forEach(e=>{if(e.getAttribute('data-layer')===keep)e.setAttribute('visibility','visible');else e.remove();});
 }
 return new XMLSerializer().serializeToString(c);
};
/** What the static layers look like: their markup and where they are placed. */
const staticKey=(root:SVGSVGElement)=>{
 let key=root.getAttribute('viewBox')||'';
 root.querySelectorAll('[data-layer]').forEach(e=>{key+=(e.parentElement?.getAttribute('transform')||'')+e.outerHTML;});
 return key;
};
const loadSvg=(markup:string)=>new Promise<HTMLImageElement>((resolve,reject)=>{
 const url=URL.createObjectURL(new Blob([markup],{type:'image/svg+xml'}));
 const image=new Image();
 image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
 image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('instrument raster failed'));};
 image.src=url;
});
export function InstrumentTexture({f}:{f:any}) {
 const svg=useRef<SVGSVGElement>(null),current=useRef(f);current.current=f;
 const hazard=flightHazard(win.__hudState,f);
 const glider=f.type==='glider',name=glider?'glider':'ga',w=glider?1024:1280,h=glider?576:512;
 useEffect(()=>{
  if(f.type==='airliner')return;
  let disposed=false,busy=false,pixels:Uint8ClampedArray|undefined,lastKey='',layersKey='';
  // CPU-backed canvases throughout: the pixels are read back, and a GPU canvas drawn into a CPU one is a readback too.
  const surface=(cw:number,ch:number)=>{const c=document.createElement('canvas');c.width=cw;c.height=ch;return [c,c.getContext('2d',{willReadFrequently:true})!] as const;};
  const [,ctx]=surface(w,h),[base,baseCtx]=surface(w,h),[glass,glassCtx]=surface(w,h),[nav,ng]=surface(512,512);
  const get=(key:string)=>key===name?pixels:undefined;
  win.__cockpitTexture=get;
  // One decode at a time. No screenshots or GPU readbacks are used for the instruments.
  const draw=async()=>{
   const root=svg.current;
   if(busy||disposed||!root)return;
   const statics=staticKey(root),moving=layerMarkup(root,'moving');
   // The moving parts, the static layers, the navigator's map (its arrival time is in minutes) and a slow tick.
   const key=moving+statics+JSON.stringify(current.current)+Math.floor(Date.now()/500);
   if(key===lastKey&&pixels)return;
   busy=true;
   try{
    const fresh=statics!==layersKey;
    const [movingImage,baseImage,glassImage]=await Promise.all([loadSvg(moving),...(fresh?[loadSvg(layerMarkup(root,'base')),loadSvg(layerMarkup(root,'glass'))]:[])]);
    if(disposed)return;
    if(baseImage&&glassImage){
     baseCtx.clearRect(0,0,w,h);baseCtx.drawImage(baseImage,0,0,w,h);
     glassCtx.clearRect(0,0,w,h);glassCtx.drawImage(glassImage,0,0,w,h);
     layersKey=statics;
    }
    ctx.clearRect(0,0,w,h);
    ctx.drawImage(base,0,0);
    ctx.drawImage(movingImage,0,0,w,h);
    ctx.drawImage(glass,0,0);
    win.__flightScreens?.('nd',ng,512,512,current.current,.05);
    if(glider)ctx.drawImage(nav,354,292,280,264);
    else ctx.drawImage(nav,807,102,335,335);
    pixels=ctx.getImageData(0,0,w,h).data;
    lastKey=key;
   }catch{/* the next tick tries again */}
   finally{busy=false;}
  };
  draw();const timer=setInterval(draw,50);
  return()=>{disposed=true;clearInterval(timer);if(win.__cockpitTexture===get)delete win.__cockpitTexture;};
 },[f.type,name,w,h]);
 if(f.type==='airliner')return null;
 return <svg ref={svg} className="deck-texture-source" xmlns="http://www.w3.org/2000/svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{'--ck-dial-font':'Arial, sans-serif','--ck-mono-font':'monospace'} as any} aria-hidden="true">
  <CockpitDefs/>
  <defs><pattern id="panel-grain" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#23282d"/><path d="M0 1H2M3 4H5" stroke="#30363b" strokeWidth=".7"/></pattern></defs>
  <rect width={w} height={h} fill="url(#panel-grain)" data-layer="base"/>
  {glider?<>
   <Gauge x={130} y={154} size={216}><Asi kmh={f.ias*1.852}/></Gauge>
   <Gauge x={383} y={154} size={216}><Vario ms={f.vs/196.8504} avg={f.vs/196.8504} netto={f.vs/196.8504}/></Gauge>
   <Gauge x={639} y={154} size={216}><Altimeter m={f.alt*.3048}/></Gauge>
   <Gauge x={893} y={154} size={216}><Compass headingDeg={f.hdg} relBrg={(f.wp?.brg??f.hdg)-f.hdg}/></Gauge>
   <g transform="translate(165 365) scale(1.3)"><SlipBall slip={(f.beta??0)/10}/></g>
   <rect x="341" y="278" width="306" height="289" rx="14" fill="#101519" stroke="#58616a" strokeWidth="4" data-layer="base"/>
   <text x="165" y="435" fill="#e6e4d9" textAnchor="middle" fontSize="18" fontFamily="monospace">AIRBRAKES · BLUE</text>
   <text x="165" y="470" fill="#c4d2df" textAnchor="middle" fontSize="16" fontFamily="monospace">TRIM · GREEN</text>
   <rect x="700" y="317" width="284" height="96" rx="8" fill="#0a0f12" stroke="#62666a" strokeWidth="3"/>
   <text x="720" y="345" fill="#aeb5b8" fontSize="14" fontFamily="monospace">COM 1 · {f.dep?.icao||'LOCAL'}</text>
   <text x="720" y="389" fill="#ffc26c" fontSize="30" fontFamily="monospace">{win.__flightInfo?.dep?.freqs?.[0]?.[1]||'—'}</text>
   <text x="835" y="475" fill="#e6e4d9" fontSize="17" textAnchor="middle" fontFamily="monospace">SAILPLANE · D-1501</text>
   <text x="835" y="508" fill="#abb5bc" fontSize="14" textAnchor="middle" fontFamily="monospace">AIRSPEED km/h · ALTITUDE m</text>
  </>:<>
   <Gauge x={132} y={135} size={218}><Dial value={f.ias} max={200} label="AIRSPEED" unit="KNOTS"/></Gauge>
   <Gauge x={382} y={135} size={218}><Attitude f={f}/></Gauge>
   <Gauge x={632} y={135} size={218}><Altimeter m={f.alt} unit="ft"/></Gauge>
   <Gauge x={132} y={380} size={218}><Compass headingDeg={f.hdg} relBrg={(f.wp?.brg??f.hdg)-f.hdg}/></Gauge>
   <Gauge x={382} y={380} size={218}><g transform="translate(0 35)"><SlipBall slip={(f.beta??0)/10}/></g><g transform={`rotate(${-f.bank})`}><path d="M-68 -10H-20L0 -20L20 -10H68M0 -35V10" stroke="#f0eade" fill="none" strokeWidth="5"/></g><text y="65" textAnchor="middle" fill="#eee8da" fontSize="10">TURN COORDINATOR</text></Gauge>
   <Gauge x={632} y={380} size={218}><VerticalSpeed value={f.vs}/></Gauge>
   <rect x="791" y="84" width="367" height="372" rx="14" fill="#11171b" stroke="#737b83" strokeWidth="4" data-layer="base"/>
   <text x="977" y="57" textAnchor="middle" fill="#d8dfdf" fontFamily="monospace" fontSize="20">FLIGHT NAVIGATOR</text>
   {[["STALL",hazard?.id==='stall','#ff6756'],['TERRAIN',hazard?.id==='terrain','#ff6756'],['AP',f.ap?.ap,'#88e8ae'],['GEAR',f.gear>.95,'#88e8ae']].map(([label,on,color],i)=><g key={String(label)}><rect x="1174" y={120+i*70} width="85" height="34" rx="4" fill={on?String(color):'#111a20'} stroke={on?String(color):'#47515a'}/><text x="1216" y={141+i*70} textAnchor="middle" fill={on?'#151c20':'#7e8b95'} fontSize="11" fontWeight="bold" fontFamily="Arial">{label}</text></g>)}
   <text x="977" y="486" textAnchor="middle" fill="#edc080" fontFamily="monospace" fontSize="20">RPM {Math.round(f.eng.rpm)} · FUEL {f.fuel==null?'—':Math.round(f.fuel)+' kg'}</text>
  </>}
  {[16,w-16].flatMap(x=>[16,h-16].map(y=><g key={`${x}-${y}`}><circle cx={x} cy={y} r="6" fill="#82888c"/><path d={`M${x-3} ${y+3}l6 -6`} stroke="#15191c" strokeWidth="2"/></g>))}
 </svg>;
}
