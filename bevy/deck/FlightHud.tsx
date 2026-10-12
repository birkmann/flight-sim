/** Peripheral instruments leave the aircraft and horizon unobstructed. */
function ArcDial({value,max,label,unit}:{value:number;max:number;label:string;unit:string}){
 const angle=-125+Math.max(0,Math.min(1,value/max))*250;
 return <svg viewBox="0 0 150 150" role="img" aria-label={`${label} ${Math.round(value)} ${unit}`}>
  <circle cx="75" cy="75" r="67" fill="#0a1c2b99" stroke="#e4f4ff44"/>
  {Array.from({length:31},(_,i)=>{const a=(-125+i*250/30)*Math.PI/180,major=i%5===0;return <line key={i} x1={75+Math.sin(a)*(major?51:57)} y1={75-Math.cos(a)*(major?51:57)} x2={75+Math.sin(a)*63} y2={75-Math.cos(a)*63} stroke="#e7f3fc" strokeWidth={major?2:1} opacity={major?1:.55}/>;})}
  <g transform={`rotate(${angle} 75 75)`}><path d="M75 13L71 26H79Z" fill="#83e1fa"/></g>
  <text x="75" y="62" textAnchor="middle" fill="#d2e1eb" fontSize="9" letterSpacing="1">{label}</text>
  <text x="75" y="90" textAnchor="middle" fill="white" fontSize="27" fontWeight="600">{Math.round(value).toLocaleString('en-GB')}</text>
  <text x="75" y="107" textAnchor="middle" fill="#c4d8e7" fontSize="10">{unit}</text>
 </svg>;
}
export function FlightHud({f,minimal}:{f:any;minimal:boolean}){
 const heading=((Math.round(f.hdg)%360)+360)%360;
 return <div className={`flight-hud ${minimal?'minimal':''}`} aria-label="Flight instruments">
  <div className="flight-compass"><span>N</span><i style={{transform:`rotate(${-heading}deg)`}}>↑</i><strong>{String(heading).padStart(3,'0')}°</strong><small>{f.wp?.id||'FREE FLIGHT'}</small></div>
  {!minimal&&<><div className="flight-gauge-left"><ArcDial value={f.ias} max={f.type==='airliner'?400:200} label="AIRSPEED" unit="KNOTS"/><div className="flight-mini-data"><span>{f.type==='glider'?'GLIDE':'POWER'}<b>{f.type==='glider'?'UNPOWERED':`${Math.round((f.eng?.lever??0)*100)}%`}</b></span><span>WIND<b>{Math.round(f.wind?.from??0)}° / {Math.round(f.wind?.kt??0)} kt</b></span></div></div>
  <div className="flight-gauge-right"><div className="flight-mini-data"><span>VERTICAL SPEED<b>{f.vs>0?'+':''}{Math.round(f.vs).toLocaleString('en-GB')} <small>ft/min</small></b></span><span>FLAPS<b>{f.flap?.label??'—'}</b></span></div><ArcDial value={f.alt} max={f.type==='airliner'?40000:10000} label="ALTITUDE" unit="FEET MSL"/></div></>}
 </div>;
}
