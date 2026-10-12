export type FlightHazard={id:string;level:'warning'|'caution';title:string;action:string;seconds?:number};
/** Uses measured terrain intersections, never an invented ground elevation. */
export function flightHazard(s:any,f:any):FlightHazard|null {
 if(!s||!f||f.onGround||s.onGround||['crashed','loading'].includes(f.phase))return null;
 const warnings=f.warnings||[],tti=Number.isFinite(s.terrainTti)?s.terrainTti:null;
 if(s.pullUp||warnings.includes('PULL UP')||(tti!==null&&tti<=5))return {id:'terrain',level:'warning',title:'PULL UP',action:'Terrain ahead · climb immediately',...(tti!==null?{seconds:tti}:{})};
 if(s.stall||warnings.includes('STALL'))return {id:'stall',level:'warning',title:'STALL',action:'Lower the nose · regain airspeed'};
 if(tti!==null&&tti<=12)return {id:'terrain',level:'caution',title:'TERRAIN AHEAD',action:'Climb or turn away from rising terrain',seconds:tti};
 // Vertical closure supplements the forward ray when descending steeply.
 const height=s.agl,descent=-(s.vs??0);
 if(Number.isFinite(height)&&height>0&&descent>3&&height/descent<10)return {id:'sink',level:'caution',title:'SINK RATE',action:'Reduce descent · check terrain clearance',seconds:height/descent};
 if(s.gearWarning||warnings.includes('GEAR'))return {id:'gear',level:'caution',title:'LANDING GEAR',action:'Check gear before landing'};
 if(warnings.length)return {id:'systems',level:'caution',title:warnings[0],action:'Check aircraft systems and flight conditions'};
 return null;
}
