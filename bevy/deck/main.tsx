import {useEffect,useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {AutopilotControls} from './Panels';
import {InstrumentTexture} from './InstrumentTexture';
import {telemetry} from './telemetry';
import {FlightHud} from './FlightHud';
import {FlightFeedback} from './FlightFeedback';
import {updateRoute} from './route';
import './cockpit/cockpit.css';
import './style.css';
const win=window as any;
const send=(c:any)=>{win.__cmds=win.__cmds||[];win.__cmds.push(JSON.stringify(c));};
const fmt=(n:any,d=0)=>Number.isFinite(n)?n.toLocaleString('en-GB',{maximumFractionDigits:d}):'—';
const clock=(sec:number)=>`${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor(sec/60)%60).padStart(2,'0')}`;
function Metric({label,value,unit}:{label:string;value:any;unit?:string}){return <div className="deck-metric"><span>{label}</span><strong>{value} <small>{unit}</small></strong></div>}
function RouteMap({f}:{f:any}){
 const pts=f.route?.wpts||[];if(!pts.length)return <div className="deck-empty">Local exploration flight<br/><small>Open the planner to add an airport route.</small></div>;
 const all=[...pts,{lat:f.lat,lon:f.lon}],xs=all.map(p=>p.lon*Math.cos(f.lat*Math.PI/180)),ys=all.map(p=>p.lat),minX=Math.min(...xs),minY=Math.min(...ys),dx=Math.max(...xs)-minX,dy=Math.max(...ys)-minY,k=Math.min(330/(dx||.001),135/(dy||.001));
 const xy=(p:any)=>[25+(p.lon*Math.cos(f.lat*Math.PI/180)-minX)*k,160-(p.lat-minY)*k];
 const here=xy(f);
 return <svg className="deck-route-map" viewBox="0 0 380 180" aria-label="Active flight route"><defs><pattern id="route-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#d7e4e0" strokeWidth=".6"/></pattern></defs><rect width="380" height="180" fill="#edf3ec"/><rect width="380" height="180" fill="url(#route-grid)"/><polyline points={pts.map(p=>xy(p).join(',')).join(' ')} stroke="#2764ed" fill="none" strokeWidth="2"/>{pts.map((p:any,i:number)=>{const [x,y]=xy(p);return <g key={i}><circle cx={x} cy={y} r={i===f.route.active?5:3} fill={i===f.route.active?'#2764ed':'white'} stroke="#2764ed"/><text x={x+5} y={y-7} fontSize="9" fill="#465c6b">{p.id}</text></g>})}<path d="M0 -8L5 7L0 4L-5 7Z" transform={`translate(${here.join(' ')}) rotate(${f.hdg})`} fill="#162f3c"/></svg>;
}
function Weather({s,f}:{s:any;f:any}) {
 const w=s.base?.fx?.weather??{},airport=f.arr?.icao||f.dep?.icao;
 const [report,setReport]=useState<any>(null),[status,setStatus]=useState('');
 useEffect(()=>{let live=true;setReport(null);setStatus(airport?'Loading airport observation…':'No airport observation for a local flight');if(airport)fetch(`/api/sim/metar?ids=${encodeURIComponent(airport)}`).then(r=>{if(!r.ok)throw Error('Weather service unavailable');return r.json();}).then(data=>{if(live){setReport(data.metars?.[0]??null);setStatus(data.metars?.length?'':'No airport report available');}}).catch(()=>live&&setStatus('Airport observation unavailable'));return()=>{live=false;};},[airport]);
 const changing=(patch:any)=>dispatchEvent(new CustomEvent('sim:set-weather',{detail:patch}));
 const wind=f.wind,age=report?.time?(Date.now()-Date.parse(report.time))/3600000:0;
 return <><div className="deck-section-label">CURRENT SIMULATION CONDITIONS</div><div className="deck-weather-grid"><Metric label="Wind at aircraft" value={`${fmt(wind?.from)}° / ${fmt(wind?.kt)}`} unit="kt"/><Metric label="Cloud base" value={fmt(w.cloudBase)} unit="m"/><Metric label="Visibility" value={fmt((w.visibility??0)/1000,1)} unit="km"/><Metric label="Cloud cover" value={fmt((w.clouds??0)*100)} unit="%"/></div>
 <div className="deck-wind"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="32" fill="none" stroke="#d7deeb"/>{['N','E','S','W'].map((t,i)=><text key={t} x={45+Math.sin(i*Math.PI/2)*41} y={48-Math.cos(i*Math.PI/2)*40} textAnchor="middle" fontSize="9" fill="#637389">{t}</text>)}<g transform={`translate(45 45) rotate(${(wind?.from??0)+180})`}><path d="M0 -24L8 -10H3V24H-3V-10H-8Z" fill="#2864ed"/></g></svg><div><b>{w.lightning?'Thunderstorm':w.precipitation>.05?(w.snow?'Snow':'Rain'):w.visibility<1000?'Fog':w.clouds>.8?'Overcast':w.clouds>.2?'Partly cloudy':'Clear skies'}</b><p>{f.type==='glider'?'Unpowered glide · manage height and airspeed':'Wind direction is true · cloud base above terrain'}</p></div></div>
 {(w.visibility<5000||w.lightning||w.precipitation>.5)&&<p className="deck-caution">Reduced visual flying conditions. Check visibility and cloud clearance.</p>}
 <label className="deck-field">Weather preset<select value="" onChange={e=>{const p=win.__simCatalog?.presets.find((p:any)=>p[0]===e.target.value);if(p)changing(p[1]);}}><option value="">Choose conditions…</option>{win.__simCatalog?.presets.map((p:any)=><option key={p[0]}>{p[0]}</option>)}</select></label>
 <div className="deck-section-label">AIRPORT OBSERVATION · {airport||'NO AIRPORT'}</div>{report?<><div className="deck-source">METAR · {report.time?new Date(report.time).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'}):'Time unavailable'} UTC{age>2?' · Older than 2 hours':''}</div><div className="deck-weather-grid"><Metric label="Temperature" value={fmt(report.temp)} unit="°C"/><Metric label="QNH" value={fmt(report.qnh)} unit="hPa"/><Metric label="Surface wind" value={`${report.windFrom==null?'VRB':fmt(report.windFrom)+'°'} / ${fmt(report.windKt)}`} unit="kt"/><Metric label="Gusts" value={fmt(report.gustKt)} unit="kt"/></div><code className="deck-metar">{report.raw}</code><small className="deck-source">Observation shown separately; use Live METAR in the planner to apply it.</small></>:<p className="deck-source">{status}</p>}</>;
}
function Briefing({s,f,tab,onClose}:{s:any;f:any;tab:string;onClose:()=>void}) {
 const gs=f.gs||0,eta=f.dtg!=null&&gs>5?f.dtg/gs*3600:null;
 return <aside className="deck-briefing" aria-label="Flight briefing"><header><div><small>FLIGHT SIMULATOR · LIVE BRIEFING</small><h2>{tab==='weather'?'Weather & conditions':'Your flight'}</h2><p>{f.label}</p></div><button aria-label="Close briefing" onClick={onClose}>×</button></header><div className="deck-briefing-body">{tab==='weather'?<Weather s={s} f={f}/>:<><div className="deck-route-title"><b>{f.dep?.icao||'LOCAL'}</b><span>→</span><b>{f.arr?.icao||'EXPLORE'}</b></div><p className="deck-source">{f.dep?.name||'Explore the scenery'}{f.arr&&` → ${f.arr.name}`}</p><RouteMap f={f}/><div className="deck-weather-grid"><Metric label="Remaining" value={fmt(f.dtg,1)} unit="NM"/><Metric label="Estimated time" value={eta==null?'—':clock(eta)} unit="hh:mm"/><Metric label="Ground speed" value={fmt(f.gs)} unit="kt"/><Metric label="Airborne time" value={f.local?'—':clock(f.time??0)} unit="hh:mm"/></div><div className="deck-section-label">FLIGHT DETAILS</div><dl className="deck-details"><div><dt>Next waypoint</dt><dd>{f.wp?.id||'No route selected'}</dd></div><div><dt>Altitude / vertical speed</dt><dd>{fmt(f.alt)} ft / {fmt(f.vs)} ft/min</dd></div><div><dt>Departure runway</dt><dd>{f.dep?.rwy||'—'}</dd></div><div><dt>Arrival runway</dt><dd>{f.arr?.rwy||'—'}</dd></div><div><dt>{f.type==='glider'?'Propulsion':'Fuel / endurance'}</dt><dd>{f.type==='glider'?'Unpowered':`${fmt(f.fuel)} kg / ${f.eng.ff>0?clock(f.fuel/f.eng.ff*3600):'—'}`}</dd></div><div><dt>Flight guidance</dt><dd>{f.ap.ap?`${f.ap.lat} · ${f.ap.vert}`:'Manual control'}</dd></div></dl>{f.type==='glider'&&<p className="deck-caution">Airborne release. No tow or winch launch; choose a landing site within gliding range. Weather widgets show conditions, not a soaring forecast.</p>}{f.warnings?.length>0&&<p className="deck-caution">{f.warnings.join(' · ')}</p>}<button className="deck-primary" onClick={()=>{onClose();win.__flightOpen?.();}}>Edit flight plan <span>↗</span></button><div className="deck-section-label">WEATHER AT AIRCRAFT</div><div className="deck-weather-grid"><Metric label="Wind" value={`${fmt(f.wind?.from)}° / ${fmt(f.wind?.kt)}`} unit="kt"/><Metric label="Cloud base" value={fmt(s.base?.fx?.weather?.cloudBase)} unit="m"/></div></>}</div><footer><i/> Live simulation data <span>{fmt(s.base?.lat,2)}° · {fmt(s.base?.lon,2)}°</span></footer></aside>;
}
function App(){
 const [s,setS]=useState<any>(win.__hudState),[tab,setTab]=useState(''),[instruments,setInstruments]=useState(false),[menu,setMenuState]=useState(false),[quiet,setQuiet]=useState(false);
 const [hud,setHud]=useState<'instruments'|'minimal'|'off'>(()=>{try{const v=localStorage.getItem('flight-simulator.hud');return ['instruments','minimal','off'].includes(v||'')?v as any:'instruments';}catch{return 'instruments';}});
 const [muted,setMuted]=useState(()=>{try{return localStorage.getItem('flight-simulator.warning-audio')==='off';}catch{return false;}});
 const previousHud=useRef<'instruments'|'minimal'>(hud==='minimal'?'minimal':'instruments'),dialog=useRef<HTMLDivElement>(null);
 const f=telemetry(s),startOpen=!!document.querySelector('#sim-start:not([hidden])');
 const active=!!f&&!startOpen&&f.phase!=='loading'&&f.phase!=='crashed'&&!document.documentElement.classList.contains('deploying')&&s.mode!=='free';
 const setMenu=(value:boolean)=>{setMenuState(value);win.__immersiveMenuOpen=value;send({type:'menu',open:value});if(value){document.exitPointerLock?.();setTab('');}else document.getElementById('canvas')?.focus({preventScroll:true});};
 const setHudMode=(value:'instruments'|'minimal'|'off')=>{setHud(value);if(value!=='off')previousHud.current=value;try{localStorage.setItem('flight-simulator.hud',value);}catch{}if(value==='off'){setTab('');setInstruments(false);setMenu(false);}};
 const toggleMute=()=>setMuted(v=>{try{localStorage.setItem('flight-simulator.warning-audio',v?'on':'off');}catch{}return !v;});
 useEffect(()=>{const t=setInterval(()=>setS(win.__hudState),100);return()=>clearInterval(t);},[]);
 useEffect(()=>{
  document.body.classList.toggle('deck-active',active);document.body.classList.toggle('immersive-hidden',active&&hud==='off');
  document.documentElement.style.setProperty('--flight-toolbar-height','0px');document.documentElement.style.setProperty('--flight-ribbon-height',hud==='instruments'&&s?.base?.view!=='cockpit'?'150px':'0px');
  if(!active){setMenuState(false);win.__immersiveMenuOpen=false;}
  return()=>{document.body.classList.remove('deck-active','immersive-hidden');};
 },[active,hud,s?.base?.view]);
 useEffect(()=>{
  if(!active)return;
  let timer:ReturnType<typeof setTimeout>;
  const wake=()=>{setQuiet(false);clearTimeout(timer);timer=setTimeout(()=>setQuiet(true),4000);};wake();
  const pointer=(e:PointerEvent)=>{if(!document.pointerLockElement&&e.clientY<100)wake();};
  const key=(e:KeyboardEvent)=>{
   if((['INPUT','SELECT','TEXTAREA'].includes((e.target as Element)?.tagName)&&!['Escape','F10'].includes(e.code))||e.metaKey||e.ctrlKey||e.altKey)return;
   if(document.querySelector('#sim-menu:not([hidden]),#sim-flight:not([hidden])'))return;
   if(e.code==='F10'){e.preventDefault();e.stopImmediatePropagation();if(!e.repeat)setHudMode(hud==='off'?previousHud.current:'off');}
   else if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!e.repeat){if(tab)setTab('');else setMenu(!menu);}}
   else if(e.code==='KeyI'&&!menu&&hud!=='off'){setInstruments(v=>!v);}
   else if(menu&&e.key==='Tab'){
    const buttons=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button,select,input,summary')).filter(b=>!(b as HTMLButtonElement).disabled&&b.getClientRects().length>0);
    const i=buttons.indexOf(document.activeElement as HTMLElement);e.preventDefault();e.stopImmediatePropagation();buttons[(i+(e.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
   }else if(menu&&e.key.startsWith('Arrow')){
    if(document.activeElement instanceof HTMLSelectElement)return;
    const buttons=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button,select,summary')).filter(b=>b.getClientRects().length>0);const i=buttons.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();e.stopImmediatePropagation();buttons[(i+(['ArrowUp','ArrowLeft'].includes(e.key)?-1:1)+buttons.length)%buttons.length]?.focus();
   }
  };
  const openMenu=()=>setMenu(true),closeMenu=()=>{if(menu)setMenu(false);};
  const restore=(e:Event)=>{if(hud==='off'&&!(e.target as Element)?.closest('#flight-pause'))setHudMode(previousHud.current);};
  addEventListener('pointermove',pointer);addEventListener('keydown',key,true);addEventListener('dblclick',restore);addEventListener('sim:flight-menu',openMenu);addEventListener('sim:menu-close',closeMenu);
  return()=>{clearTimeout(timer);removeEventListener('pointermove',pointer);removeEventListener('keydown',key,true);removeEventListener('dblclick',restore);removeEventListener('sim:flight-menu',openMenu);removeEventListener('sim:menu-close',closeMenu);};
 },[active,menu,hud,tab]);
 useEffect(()=>{if(menu)dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();},[menu]);
 if(!active)return null;
 updateRoute(f);win.__deckFlight=f;
 const cockpit=s.base.view==='cockpit';
 const open=(v:string)=>{if(hud==='off')setHudMode(previousHud.current);setMenu(false);document.exitPointerLock?.();setTab(v);};
 const external=(action:()=>void)=>{setMenu(false);setTab('');action();};
 return <>
  {hud!=='off'&&!menu&&<div className={`deck-toolbar ${quiet?'quiet':''}`}><button aria-label="Open flight menu" onClick={()=>setMenu(true)}><span aria-hidden="true">☰</span><span>Flight menu</span><kbd>Esc</kbd></button></div>}
  <FlightFeedback s={s} f={f} muted={muted} hidden={hud==='off'}/>
  {cockpit&&<InstrumentTexture f={f}/>}
  {cockpit&&instruments&&!f.local&&hud!=='off'&&!menu&&<div className="deck-station-controls"><AutopilotControls f={f}/></div>}
  {tab&&hud!=='off'&&<Briefing s={s} f={f} tab={tab} onClose={()=>setTab('')}/>}
  {!cockpit&&hud!=='off'&&!menu&&<FlightHud f={f} minimal={hud==='minimal'}/>}
  {menu&&<div id="flight-pause" className="flight-menu-backdrop" onClick={e=>{if(e.target===e.currentTarget)setMenu(false);}}><div ref={dialog} className="flight-menu" role="dialog" aria-modal="true" aria-label="Flight menu">
   <header><div><small className="flight-menu-brand"><img src="assets/ui/brand.svg" alt=""/> FLIGHT SIMULATOR</small><h2>Your flight.</h2><p>{f.label} · {f.dep?.icao||'Local flight'}{f.arr?` → ${f.arr.icao}`:''}</p></div><button className="flight-menu-close" onClick={()=>setMenu(false)} aria-label="Resume flight">×</button></header>
   <div className="flight-menu-body"><div className="flight-menu-camera" aria-label="Camera view">{['chase','cockpit'].map(v=><button key={v} aria-label={v==='cockpit'?'Cockpit':'Chase'} aria-pressed={s.base.view===v} onClick={()=>{send({type:'view',view:v});setMenu(false);}}>{v==='cockpit'?'◉ Cockpit':'◌ Chase'}<small>{v==='cockpit'?'Inside the aircraft':'Follow your aircraft'}</small></button>)}</div>
   <div className="flight-menu-actions"><button aria-label="Flight details" onClick={()=>open('flight')}>Flight details <span>↗</span></button><button aria-label="Weather" onClick={()=>open('weather')}>☁ Weather <span>↗</span></button><button onClick={()=>external(()=>win.__flightOpen?.())} aria-label="Open flight planner">Flight planner <span>↗</span></button><button onClick={()=>external(()=>dispatchEvent(new CustomEvent('sim:menu',{detail:'controls'})))}>Controls <span>↗</span></button><button onClick={()=>external(()=>dispatchEvent(new CustomEvent('sim:menu',{detail:'assets'})))}>Aircraft <span>↗</span></button><button onClick={()=>external(()=>dispatchEvent(new CustomEvent('sim:menu',{detail:'options'})))}>Settings <span>↗</span></button></div>
   <div className="flight-menu-label">ON-SCREEN DISPLAY</div><div className="flight-menu-display">{[['instruments','Instruments'],['minimal','Minimal'],['off','Hide all UI']].map(([v,label])=><button key={v} aria-pressed={hud===v} onClick={()=>setHudMode(v as any)}>{label}</button>)}</div><p className="flight-menu-hint">F10 toggles the display. Esc opens this menu. Double-tap the view to restore hidden UI.</p>
   <button className="flight-menu-audio" aria-label="Mute warning audio" aria-pressed={muted} onClick={toggleMute}><span>Warning sounds<small>Terrain, stall and landing alerts</small></span><b>{muted?'Off':'On'}</b></button>
   {!f.local&&<><label className="flight-menu-rate">Simulation speed<select aria-label="Simulation speed" value={f.rate??1} onChange={e=>send({type:'simrate',rate:+e.target.value})}>{[1,2,4,8,16].map(r=><option key={r} value={r}>{r}×</option>)}</select></label>{f.type!=='glider'&&<details className="flight-menu-autopilot"><summary>Autopilot controls</summary><AutopilotControls f={f}/></details>}</>}
   </div><footer><button className="flight-menu-home" aria-label="Flight setup" onClick={()=>external(()=>dispatchEvent(new Event('sim:start-open')))}>Main menu</button><button className="flight-menu-resume" onClick={()=>setMenu(false)}>Return to flight <span>→</span></button></footer>
  </div></div>}
 </>;
}
win.__detailedCockpit=(s:any)=>s?.mode==='jet'&&s.base?.view==='cockpit';
if(!new URLSearchParams(location.search).has('bench'))addEventListener('DOMContentLoaded',()=>{const root=document.createElement('div');root.id='flight-deck';document.body.append(root);createRoot(root).render(<App/>);});
