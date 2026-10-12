import {useEffect,useRef} from 'react';
import {flightHazard} from './hazards';
export function FlightFeedback({s,f,muted,hidden}:{s:any;f:any;muted:boolean;hidden:boolean}){
 const hazard=flightHazard(s,f),current=useRef(hazard);current.current=hazard;
 const silent=useRef(muted);silent.current=muted;
 useEffect(()=>{
  let audio:AudioContext|undefined,last=0,lastId='';
  const unlock=()=>{audio??=new AudioContext();if(audio.state==='suspended')void audio.resume();};
  if(navigator.userActivation?.hasBeenActive)unlock();
  addEventListener('pointerdown',unlock);addEventListener('keydown',unlock);
  const timer=setInterval(()=>{
   const h=current.current;if(!h){lastId='';return;}
   if(silent.current||!audio||audio.state!=='running')return;
   const id=h.id+h.level,now=performance.now(),delay=h.level==='warning'?2400:6000;
   if(id===lastId&&now-last<delay)return;last=now;lastId=id;
   for(const offset of [0,.22]){const osc=audio.createOscillator(),gain=audio.createGain(),t=audio.currentTime+offset;osc.type='sine';osc.frequency.value=h.level==='warning'?880:620;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.11,t+.02);gain.gain.exponentialRampToValueAtTime(.001,t+.17);osc.connect(gain);gain.connect(audio.destination);osc.start(t);osc.stop(t+.19);osc.onended=()=>{osc.disconnect();gain.disconnect();};}
  },200);
  return()=>{clearInterval(timer);removeEventListener('pointerdown',unlock);removeEventListener('keydown',unlock);void audio?.close();};
 },[]);
 return <>
  {!hidden&&hazard&&<><div className={`deck-hazard-edge ${hazard.level}`} aria-hidden="true"/><div className={`deck-hazard ${hazard.level}`} role="alert"><span className="deck-hazard-icon" aria-hidden="true">!</span><div><strong>{hazard.title}</strong><p>{hazard.action}</p></div>{hazard.seconds!=null&&<span className="deck-hazard-time">≈ {Math.max(1,Math.ceil(hazard.seconds))} s<small>projected impact</small></span>}</div></>}

 </>;
}
