// Live route adapter for the cockpit imported from dwd-hack-26.
// No reference-demo airspaces, thermals, or weather forecasts are displayed here.
export type LonLat = [number, number];
export type Waypoint = {id:string; name:string; radius:number; at:LonLat};
export const AIRFIELD = {at:[0,0] as LonLat,elevation:0};
export const AIRSPACES: any[] = [];
export const THERMALS: any[] = [];
export const airspaceActive = (..._args:any[]) => false;
export const ROUTES: Record<string,{waypoints:Waypoint[];km:number}> = {live:{waypoints:[],km:0}};
const rad=(v:number)=>v*Math.PI/180;
export function distance(a:LonLat,b:LonLat) {
 const h=Math.sin(rad(b[1]-a[1])/2)**2+Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(rad(b[0]-a[0])/2)**2;
 return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}
export function bearing(a:LonLat,b:LonLat) { const d=rad(b[0]-a[0]); return (Math.atan2(Math.sin(d)*Math.cos(rad(b[1])),Math.cos(rad(a[1]))*Math.sin(rad(b[1]))-Math.sin(rad(a[1]))*Math.cos(rad(b[1]))*Math.cos(d))*180/Math.PI+360)%360; }
export function updateRoute(f:any) {
 const w=f.route?.wpts?.map((p:any)=>({id:p.id,name:p.id,radius:0,at:[p.lon,p.lat]})) || [];
 ROUTES.live.waypoints=w.length?w:[{id:'LOCAL',name:'Local flight',radius:0,at:[f.lon,f.lat]}];
 ROUTES.live.km=w.slice(1).reduce((d:number,p:any,i:number)=>d+distance(w[i].at,p.at)/1000,0);
 AIRFIELD.at=[f.arr?.lon??f.lon,f.arr?.lat??f.lat];
 AIRFIELD.elevation=(f.arr?.elev??0)/3.28084;
}
