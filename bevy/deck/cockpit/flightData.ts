// Instrument calculations use the Bevy snapshot, not the source project's demo scenario.
import {useRef} from 'react';
import {ROUTES,AIRFIELD,bearing,distance} from '../route';
export const de=(v:number,d=0)=>Number.isFinite(v)?v.toLocaleString('en-GB',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
export const signed=(v:number,d=1)=>(v>0?'+':'')+de(v,d);
export const clock=(h:number)=>`${String(Math.floor(h)%24).padStart(2,'0')}:${String(Math.floor(h*60)%60).padStart(2,'0')}`;
export const norm360=(v:number)=>(v%360+360)%360;
export const norm180=(v:number)=>norm360(v+180)-180;
export const compassName=(d:number)=>['N','NE','E','SE','S','SW','W','NW'][Math.round(norm360(d)/45)%8];
export const slipOf=(s:any)=>Math.max(-1,Math.min(1,(s.slip??0)/0.12));
export type FlightData = ReturnType<typeof calculate>;
function calculate(snap:any,trail:any[],avgClimb:number) {
 const s=snap.state, f=snap.flight, route=ROUTES.live, wpIndex=Math.min(f.route?.active??0,route.waypoints.length-1);
 const wp=route.waypoints[wpIndex], here:[number,number]=[s.lon,s.lat];
 const dist=f.wp?.dist!=null?f.wp.dist*1852:distance(here,wp.at);
 const brg=f.wp?.brg??bearing(here,wp.at), headingDeg=f.hdg, trackDeg=f.trk;
 const above=s.altMsl-AIRFIELD.elevation, tailwind=-(f.wind?.head??0)*1.852;
 const gs=Math.max(0,f.gs??0)*0.514444;
 const sink=0.58+0.00012*(Math.max(80,f.ias*1.852)-80)**2;
 const ld=Math.max(1,gs/sink);
 return {wp,wpIndex,isFinish:wpIndex===route.waypoints.length-1,dist,brg,relBrg:norm180(brg-headingDeg),headingDeg,trackDeg,
 reqLD:!f.local&&above>1?dist/above:Infinity,arrival:f.local?NaN:above-dist/ld,etaHour:gs>1?s.hour+dist/gs/3600:null,
 avgClimb,netto:s.vario+sink,taskSpeed:f.time>0?(f.distance??0)*1.852/(f.time/3600):null,
 wind:{fromDeg:f.wind?.from??0,kmh:(f.wind?.kt??0)*1.852},windRelDeg:norm180((f.wind?.from??0)+180-headingDeg),tailwind,
 cloudBase:snap.weather?.cloudBase??0,progress:route.km?Math.max(0,Math.min(1,1-(f.dtg??0)*1.852/route.km)):0,
 taskKm:route.km,legKm:[],trail};
}
export function useFlightData(snap:any) {
 const memory=useRef({trail:[] as any[],samples:[] as any[],t:-1,key:''});
 const m=memory.current,f=snap.flight,t=f.time??0,key=`${f.type}:${f.dep?.icao}:${f.arr?.icao}`;
 if(t<m.t||key!==m.key){m.trail=[];m.samples=[];m.t=-1;m.key=key;}
 if(t-m.t>=1) {m.trail.push({lon:f.lon,lat:f.lat,vario:snap.state.vario});m.trail=m.trail.slice(-160);m.samples.push({t,v:snap.state.vario});m.samples=m.samples.filter(p=>t-p.t<30);m.t=t;}
 return calculate(snap,m.trail,m.samples.length?m.samples.reduce((a,p)=>a+p.v,0)/m.samples.length:snap.state.vario);
}
