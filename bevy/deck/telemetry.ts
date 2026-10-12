// All cockpit units are converted explicitly at this boundary.
export function telemetry(s:any) {
 if(s?.base?.flight?.ap)return s.base.flight;
 if(s?.mode!=='jet')return null;
 const b=s.base||{},w=b.fx?.weather||{},glider=s.label==='SAILPLANE',jet=s.label==='AIRLINER';
 const kt=1.943844,ft=3.28084;
 return {type:glider?'glider':jet?'airliner':'c172',label:s.label,panel:glider?'glider':jet?'airliner':'ga',
 phase:'local flight',ias:(s.ias??s.speed??0)*kt,tas:(s.tas??s.speed??0)*kt,gs:(s.gs??s.speed??0)*kt,alt:(s.alt??b.alt??0)*ft,ra:s.agl==null?null:s.agl*ft,
 vs:(s.vs??0)*ft*60,hdg:s.heading??0,trk:s.track??s.heading??0,pitch:s.pitch??0,bank:s.bank??0,beta:s.beta??0,g:s.g??1,
 lat:s.lat??b.lat??0,lon:s.lon??b.lon??0,mach:s.mach??0,onGround:!!s.onGround,time:0,distance:0,
 wind:{from:w.windFrom??0,kt:(w.windSpeed??0)*kt,head:0},eng:{count:glider?0:jet?2:1,n1:jet?(s.throttle??0)*100:0,rpm:!jet&&!glider?(s.rpm??(s.throttle??0)*2700):0,ff:0,egt:0,lever:s.throttle??0,rev:0},
 fuel:null,gw:null,gear:s.gear?1:0,gearLever:!!s.gear,retracts:!(!jet&&!glider),flap:{lever:0,label:'0',pos:0,max:0},spoiler:0,trim:0,
 ap:{ap:false,fd:false,athr:false,lat:'MANUAL',vert:'MANUAL',thr:'',spd:0,hdg:0,alt:0,vs:0,target:0,fdBank:0,fdPitch:0},route:{wpts:[],active:0},warnings:[s.pullUp?'PULL UP':null,s.stall?'STALL':null,s.gearWarning?'GEAR':null].filter(Boolean),notes:[],vmax:jet?350:glider?135:163,vls:glider?38:jet?130:45,vstall:glider?34:jet?120:40,vspeeds:{},local:true};
}
export function snapshot(s:any,f:any) {
 const weather=s.base?.fx?.weather??{};
 return {flight:f,weather,camera:s.base?.view,stage:'flying',paused:false,look:{yaw:s.base?.headLook?.[0]??0,pitch:s.base?.headLook?.[1]??0},
 state:{lon:f.lon,lat:f.lat,altMsl:f.alt/3.28084,tas:f.ias*0.514444,vario:f.vs/196.8504,heading:f.hdg*Math.PI/180,track:f.trk*Math.PI/180,roll:f.bank*Math.PI/180,
 pitch:f.pitch*Math.PI/180,slip:(f.beta??0)*Math.PI/180,g:f.g??1,hour:weather.hour??12,route:'live',target:f.route?.active??0,taskDistance:(f.distance??0)*1852,
 onGround:f.onGround,autopilot:f.ap?.ap??false,phase:f.phase,controls:{aileron:0,rudder:0,elevator:0,airbrake:f.spoiler??0}}};
}
