import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {createApp} from '../server/serve.mjs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
(async()=>{const server=createServer(createApp());await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin+'/',async r=>r.fulfill({contentType:'text/html',body:await fs.readFile(root+'bevy/index.html','utf8')}));
 await page.route(/\/[^/]+\.(js|css)$/,async r=>{const n=new URL(r.request().url()).pathname.slice(1);const f=n==='bench.js'?root+'bench.js':n==='shims.js'?root+'bevy/vendor/shims.js':root+'bevy/'+n;await r.fulfill({contentType:n.endsWith('css')?'text/css':'text/javascript',body:await fs.readFile(f,'utf8')});});
 await page.route('**/api/sim/metar?*',r=>r.fulfill({json:{metars:[{icao:'EDDB',time:'2026-10-12T12:00:00Z',raw:'EDDB TEST OBSERVATION',windFrom:270,windKt:10,gustKt:18,qnh:1017,temp:14,dew:8,clouds:[]}]}}));
 await page.addInitScript(()=>{
  window.__testWarningTones=[];
  const create=AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator=function(){const osc=create.call(this);const start=osc.start.bind(osc);osc.start=(...args)=>{if(osc.frequency.value===880||osc.frequency.value===620)window.__testWarningTones.push(osc.frequency.value);return start(...args);};return osc;};
 });
 const menu=async()=>{if(!await page.locator('#flight-pause').count()){if(await page.locator('.deck-briefing').count())await page.getByRole('button',{name:'Close briefing'}).click();await page.keyboard.press('Escape');await page.waitForSelector('#flight-pause');await page.waitForTimeout(250);}};
 await page.goto(origin+'/',{waitUntil:'networkidle'});await page.screenshot({path:'/tmp/flight-new-start.png'});
 // Welcome tiles perform real navigation, including direct access to aircraft and conditions.
 for(const [action,step] of [['hangar','vehicle'],['local','brief'],['glider','brief'],['conditions','brief'],['world','city']]){
  await page.locator(`[data-action="${action}"]`).click();
  assert.equal(await page.locator('#sim-start').getAttribute('data-step'),step);
  if(action==='glider')assert.match(await page.locator('.st-aircraft-copy').innerText(),/Sailplane/i);
  await page.locator('.st-home-nav').click();
 }

 for(const viewport of [{width:1280,height:720},{width:1920,height:1080}]){
  await page.setViewportSize(viewport);await page.locator('.st-home-nav').click();await page.waitForTimeout(400);
  assert.ok(await page.evaluate(()=>{const body=document.querySelector('.st-body').getBoundingClientRect();return [...document.querySelectorAll('.st-tile')].every(n=>n.getBoundingClientRect().bottom<=body.bottom+1);}), 'Dashboard tiles must fit on desktop without a clipped bottom row');
  await page.screenshot({path:`/tmp/flight-welcome-${viewport.width}.png`});
 }
 // Exercise the real wizard at an embedded-browser size and on a phone.
 const contrast = async (selector) => {
  const failures = await page.locator(selector).evaluateAll(nodes => {
   const rgb = s => (s.match(/[\d.]+/g)||[]).map(Number);
   const luminance = c => c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
   return nodes.filter(n=>n.getClientRects().length).flatMap(n=>{
    const layers=[];for(let el=n;el;el=el.parentElement)layers.unshift(rgb(getComputedStyle(el).backgroundColor));
    const bg=layers.reduce((b,c)=>b.map((v,i)=>(c[i]||0)*(c[3]??1)+v*(1-(c[3]??1))),[255,255,255]);
    const fg=rgb(getComputedStyle(n).color),a=luminance(fg),b=luminance(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    return ratio<4.5?[`${n.className||n.tagName}: ${n.textContent.slice(0,40)} (${ratio.toFixed(2)}:1)`]:[];
   });
  });
  assert.deepEqual(failures,[], 'Text contrast must be at least 4.5:1');
 };
 for(const viewport of [{width:1045,height:1280},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  await page.reload({waitUntil:'networkidle'});
  await page.waitForSelector('.st-dashboard');
  await page.screenshot({path:`/tmp/flight-welcome-${viewport.width}.png`});
  await page.getByRole('button',{name:/World map/}).click();
  await page.waitForSelector('.st-world-map');
  await page.getByRole('button',{name:'Depart from Sydney',exact:true}).click();
  assert.match(await page.locator('.st-map-detail').innerText(),/Sydney/);
  await page.waitForTimeout(400);
  await page.screenshot({path:`/tmp/flight-world-map-${viewport.width}.png`});
  await page.getByRole('button',{name:'Destinations',exact:true}).click();
  await page.waitForSelector('.st-cities');
  await page.locator('.st-steps [data-step="mode"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#sim-start').getAttribute('data-step'),'mode');
  await page.locator('.st-steps [data-step="city"]').click();
  await page.waitForTimeout(400);
  await contrast('.st-city p, .st-city b, .st-city .time, .st-body .lede, .st-foot .primary, .st-steps li');
  await page.screenshot({path:`/tmp/flight-start-location-${viewport.width}.png`});
  await page.locator('.st-foot .primary').click();
  await page.getByRole('button',{name:/Fly an aircraft/}).click();
  await page.waitForTimeout(400);
  await contrast('.mode-name, .mode-sub, .mode-description, .st-foot .grow');
  assert.equal(await page.locator('.st-mode[aria-pressed="true"]').count(),1);
  await page.screenshot({path:`/tmp/flight-start-mode-${viewport.width}.png`});
  await page.locator('.st-foot .primary').click();
  await contrast('.st-veh b, .st-veh small, .st-chip, .st-note');
  await page.waitForTimeout(400);
  await page.screenshot({path:`/tmp/flight-start-aircraft-${viewport.width}.png`});
  await page.locator('.st-foot .primary').click();
  await page.getByRole('combobox',{name:'Weather',exact:true}).selectOption('Clear');
  assert.match(await page.locator('.st-condition-metrics').innerText(),/80 km/);
  await page.getByRole('combobox',{name:'Weather',exact:true}).selectOption('Fog');
  assert.match(await page.locator('.st-condition-metrics').innerText(),/0.5/);
  assert.match(await page.locator('.st-condition-note').innerText(),/Reduced visual/);
  await page.getByRole('combobox',{name:'Weather',exact:true}).selectOption('Clear');
  await page.getByRole('combobox',{name:'Time of day',exact:true}).selectOption('12');
  await page.getByRole('combobox',{name:'Time of day',exact:true}).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#sim-start').getAttribute('data-step'),'brief','Native select keys must not advance the wizard');
  await page.getByRole('combobox',{name:'Time of day',exact:true}).selectOption('12');
  await page.waitForTimeout(400);
  await contrast('.st-condition-metrics span, .st-condition-metrics small, .st-condition-metrics em, .st-condition-note, .st-overline, .st-aircraft-copy p, .st-text-btn, .st-condition-fields select');
  await page.locator('.st-controls summary').click();
  await contrast('.st-list li, .st-keys span, .st-keys kbd');
  await page.screenshot({path:`/tmp/flight-start-briefing-controls-${viewport.width}.png`});
  await page.locator('.st-controls summary').click();
  await page.locator('.st-body').evaluate(el=>el.scrollTop=0);
  await page.evaluate(()=>{window.__hudState={mode:'free',base:{}};});
  await page.waitForSelector('.st-foot .launch:not(:disabled)');
  assert.equal((await page.locator('.st-foot .launch').textContent()).trim(),'Start flight');
  await page.screenshot({path:`/tmp/flight-start-briefing-${viewport.width}.png`});
  await page.getByRole('button',{name:/Change aircraft/}).click();
  await page.locator('.st-foot .primary').click();
  assert.equal(await page.getByRole('combobox',{name:'Weather',exact:true}).inputValue(),'Clear');
  assert.equal(await page.getByRole('combobox',{name:'Time of day',exact:true}).inputValue(),'12');
  await page.waitForTimeout(150);
  await page.locator('.st-controls summary').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('.st-controls').getAttribute('open'),'');
  await page.keyboard.press('Enter');
  const fits=await page.evaluate(()=>{
   const p=document.querySelector('.st-panel').getBoundingClientRect(),f=document.querySelector('.st-foot').getBoundingClientRect();
   const h=document.querySelector('.st-head').getBoundingClientRect();
   return h.top>=0&&h.bottom<=p.top&&p.right<=innerWidth&&p.bottom<=innerHeight&&f.bottom<=innerHeight&&document.querySelector('.st-body').scrollWidth<=document.querySelector('.st-body').clientWidth;
  });
  assert.ok(fits,'Wizard content must fit the viewport with the footer visible');
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(()=>{dispatchEvent(new Event('sim:start-hide'));window.__cmds=[];});await page.waitForTimeout(700);
 for(const [id,label] of [['glider','SAILPLANE'],['c172','C172'],['airliner','AIRLINER']]){
  await page.evaluate(({id,label})=>{window.__hud(JSON.stringify({id,mode:'jet',label,speed:50,gs:49,vs:1.2,alt:1300,heading:29,pitch:3,bank:6,throttle:.65,g:1,beta:1,base:{view:'cockpit',lat:53.31,lon:12.75,alt:1300,fov:1.25,locked:false,headLook:[0,0],contacts:[],fx:{flash:0,daylight:1,weather:{hour:14,cloudBase:1650,windFrom:270,windSpeed:5,visibility:30000,clouds:.4}}}}));},{id,label});
  await page.waitForTimeout(800);await page.screenshot({path:`/tmp/flight-deck-${id}.png`});
  assert.equal(await page.locator('.deck-toolbar').count(),1);
  assert.equal(await page.locator('.ck-panel, .deck-dashboard').count(),0,'Cockpit must use the model surfaces, never a floating panel');
  if(id==='c172'){
   const radio=await page.evaluate(()=>Array.from(window.__display('radio').filter((_,i)=>i%97===0)));
   assert.equal(await page.evaluate(()=>window.__display('radio').length),512*1024*4);
   await page.evaluate(()=>{window.__hudState={...window.__hudState,rpm:2450,terrainTti:9,agl:800,vs:0};});
   await page.waitForSelector('.deck-hazard.caution');
   assert.match(await page.locator('.deck-hazard').innerText(),/TERRAIN AHEAD/);
   assert.notDeepEqual(await page.evaluate(()=>Array.from(window.__display('radio').filter((_,i)=>i%97===0))),radio,'Radio stack engine display follows RPM');
   await page.evaluate(()=>{window.__hudState={...window.__hudState,terrainTti:3};});
   await page.waitForSelector('.deck-hazard.warning');
   assert.match(await page.locator('.deck-hazard').innerText(),/PULL UP/);
   await page.waitForFunction(()=>window.__testWarningTones.includes(880));
   await menu();await page.getByRole('button',{name:'Mute warning audio'}).click();
   const tones=await page.evaluate(()=>window.__testWarningTones.length);
   await page.waitForTimeout(2600);
   assert.equal(await page.evaluate(()=>window.__testWarningTones.length),tones,'Muted alerts must not schedule new warning tones');
   assert.equal(await page.getByRole('button',{name:'Mute warning audio'}).getAttribute('aria-pressed'),'true');
   await page.getByRole('button',{name:'Resume flight',exact:true}).click();
   assert.equal(await page.locator('.deck-hazard.warning').count(),1,'Muting never removes the visual warning');
   await page.screenshot({path:'/tmp/flight-terrain-warning.png'});
   await page.evaluate(()=>{window.__hudState={...window.__hudState,terrainTti:null,stall:true};});
   await page.waitForFunction(()=>document.querySelector('.deck-hazard strong')?.textContent==='STALL');
   await page.evaluate(()=>{window.__hudState={...window.__hudState,stall:false};});
   await page.waitForSelector('.deck-hazard',{state:'detached'});
   await menu();await page.getByRole('button',{name:'Mute warning audio'}).click();await page.getByRole('button',{name:'Resume flight',exact:true}).click();
  }
  if(id!=='airliner'){
   const name=id==='glider'?'glider':'ga',length=id==='glider'?1024*576*4:1280*512*4;
   await page.waitForFunction(({name,length})=>window.__cockpitTexture?.(name)?.length===length,{name,length});
   assert.ok(await page.evaluate(name=>{const p=window.__display(name);return p.some((v,i)=>i%4!==3&&v>100);},name),'Instrument texture contains drawn gauges');
   const sample=await page.evaluate(name=>Array.from(window.__display(name).filter((_,i)=>i%97===0)),name);
   await page.evaluate(()=>{window.__hudState={...window.__hudState,alt:1650,speed:65,heading:95};});
   await page.waitForTimeout(500);
   assert.notDeepEqual(await page.evaluate(name=>Array.from(window.__display(name).filter((_,i)=>i%97===0)),name),sample,'Live instruments must react to changing telemetry');
  }
 }
 await menu();await page.getByRole('button',{name:'Weather',exact:true}).click();await page.waitForSelector('.deck-briefing');await page.screenshot({path:'/tmp/flight-deck-weather.png'});
 await contrast('.deck-metric>span, .deck-metric small, .deck-section-label, .deck-source');
 assert.match(await page.locator('.deck-briefing').innerText(),/1,650/);await page.getByRole('combobox').selectOption('Fog');assert.ok(await page.evaluate(()=>window.__cmds.some(s=>JSON.parse(s).type==='weather'&&JSON.parse(s).weather.visibility===450)));
 await page.getByRole('button',{name:'Close briefing'}).click();await menu();await page.getByRole('button',{name:'Chase',exact:true}).click();assert.ok(await page.evaluate(()=>window.__cmds.some(s=>JSON.parse(s).type==='view'&&JSON.parse(s).view==='chase')));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);await menu();await page.getByRole('button',{name:'Flight details',exact:true}).click();await page.screenshot({path:'/tmp/flight-deck-mobile.png'});

 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Close briefing'}).click();
 await page.evaluate(()=>{
  const s=window.__hudState;
  s.base.flight={type:'airliner',label:'A320 CLASS',panel:'airliner',phase:'cruise',ias:240,tas:280,gs:270,alt:15000,vs:0,ra:14000,hdg:29,trk:29,pitch:2,bank:0,beta:0,g:1,mach:.45,
   lat:53.31,lon:12.75,onGround:false,time:1800,distance:110,wind:{from:270,kt:18,head:4},eng:{count:2,n1:72,rpm:0,egt:610,ff:2100,lever:.6,rev:0},fuel:6200,gw:62000,mtow:78000,
   flap:{lever:0,pos:0,label:'0',max:5,labels:['0','1','1+F','2','3','FULL']},gear:0,gearLever:false,retracts:true,spoiler:0,speedbrake:0,hasSpoilers:true,trim:.05,park:false,rate:1,
   ap:{ap:true,fd:true,athr:true,lat:'NAV',vert:'ALT',thr:'SPEED',spd:240,hdg:29,alt:15000,vs:0,target:240,targetMach:false,fdPitch:2,fdBank:0},
   route:{wpts:[{id:'EDDH',lat:53.63,lon:9.99},{id:'FIX1',lat:53.4,lon:12.1},{id:'EDDB',lat:52.36,lon:13.51}],active:1},wp:{id:'FIX1',dist:26,brg:240,xtk:0},dtg:95,cruise:15000,
   dep:{icao:'EDDH',name:'Hamburg',rwy:'23',lat:53.63,lon:9.99},arr:{icao:'EDDB',name:'Berlin Brandenburg',rwy:'25R',lat:52.36,lon:13.51,elev:157},vspeeds:{},warnings:[],notes:[]};
  window.__hudState={...s};window.__cmds=[];
 });
 await menu();await page.locator('.flight-menu-autopilot summary').click();await page.waitForSelector('.deck-fcu');
 await page.getByRole('button',{name:'Increase ALTITUDE',exact:true}).click();
 assert.ok(await page.evaluate(()=>window.__cmds.some(s=>{const c=JSON.parse(s);return c.type==='fcu'&&c.fcu==='alt'&&c.delta===100;})));
 await menu();await page.getByRole('button',{name:'Flight details',exact:true}).click();
 assert.match(await page.locator('.deck-briefing').innerText(),/95 NM/);
 await page.screenshot({path:'/tmp/flight-deck-route.png'});
 await menu();await page.getByRole('button',{name:'Weather',exact:true}).click();
 await page.waitForSelector('.deck-metar');assert.match(await page.locator('.deck-metar').innerText(),/EDDB TEST/);
 await page.getByRole('button',{name:'Close briefing'}).click();
 await page.evaluate(()=>window.__flightOpen());await page.waitForSelector('.fp-types button[data-id="glider"]');
 await page.locator('.fp-types button[data-id="glider"]').click();
 assert.equal(await page.locator('.fp-launch').count(),1,'Planner must keep exactly one launch footer after changing aircraft');
 assert.equal(await page.locator('.fuel').isDisabled(),true);
 assert.equal(await page.locator('[data-s="runway"]').count(),0);
 assert.equal(await page.locator('[data-s="cruise"].on').count(),1);
 await contrast('#sim-flight .hint, #sim-flight h3, #sim-flight .fp-stats dt, .fp-weather-cards small, .fp-note');
 await page.screenshot({path:'/tmp/flight-deck-planner.png'});

 await page.locator('#sim-flight header .close').click();
 await page.evaluate(()=>{window.__hudState={...window.__hudState,base:{...window.__hudState.base,view:'chase'}};});
 for(const viewport of [{width:1440,height:1000},{width:1045,height:1280},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(300);
  await menu();await page.getByRole('button',{name:'Flight details',exact:true}).click();
  await page.waitForSelector('.deck-briefing');
  const layout = await page.evaluate(()=>{
   const toolbar=document.querySelector('.deck-toolbar').getBoundingClientRect(),panel=document.querySelector('.deck-briefing').getBoundingClientRect(),gauge=document.querySelector('.flight-gauge-right').getBoundingClientRect();
   return {ok:toolbar.width<220&&panel.top>=toolbar.bottom&&panel.bottom<=gauge.top&&gauge.right<=innerWidth&&panel.left>=0,toolbar:toolbar.toJSON(),panel:panel.toJSON(),gauge:gauge.toJSON()};
  });
  assert.ok(layout.ok,`Flight panels overlap at ${viewport.width}: ${JSON.stringify(layout)}`);
  await page.getByRole('button',{name:'Close briefing'}).click();
  await page.screenshot({path:`/tmp/flight-chase-ui-${viewport.width}.png`});
 }
 // Clean view is reversible with keyboard, touch and controller menu events.
 await page.keyboard.press('F10');await page.waitForSelector('body.immersive-hidden');
 assert.equal(await page.locator('.flight-hud,.deck-toolbar,.deck-hazard').count(),0);
 await menu();assert.ok(await page.locator('.flight-menu').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),'Flight menu fits the phone');await page.screenshot({path:'/tmp/flight-menu-mobile.png'});
 await page.getByRole('button',{name:'Minimal',exact:true}).click();await page.getByRole('button',{name:'Resume flight',exact:true}).click();
 await page.waitForSelector('.flight-hud.minimal');assert.equal(await page.locator('.flight-gauge-left').count(),0);
 await page.keyboard.press('F10');await page.keyboard.press('F10');await page.waitForSelector('.flight-hud.minimal');
 await menu();await page.getByRole('button',{name:'Hide all UI',exact:true}).click();
 await page.evaluate(()=>document.body.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));await page.waitForSelector('.flight-hud.minimal');
 await page.setViewportSize({width:1440,height:1000});
 await page.evaluate(()=>dispatchEvent(new Event('sim:flight-menu')));await page.waitForSelector('#flight-pause');
 await page.getByRole('button',{name:'Instruments',exact:true}).click();
 await page.screenshot({path:'/tmp/flight-menu-desktop.png'});
 await page.getByRole('button',{name:'Resume flight',exact:true}).focus();await page.keyboard.press('Shift+Tab');
 assert.ok(await page.evaluate(()=>document.activeElement.closest('#flight-pause')!==null),'Menu must trap keyboard focus');
 await page.evaluate(()=>dispatchEvent(new Event('sim:menu-close')));await page.waitForSelector('#flight-pause',{state:'detached'});
 // Exercise the actual gamepad poll and menu loop using a standard controller.
 await page.evaluate(()=>{
  window.__testPad={id:'DualSense test',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))};
  Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__testPad]});
  window.__padPoll();window.__testPad.buttons[9]={pressed:true,value:1};window.__padPoll();
 });await page.waitForSelector('#flight-pause');await page.waitForTimeout(100);
 await page.evaluate(()=>window.__testPad.buttons[9]={pressed:false,value:0});await page.waitForTimeout(100);
 await page.evaluate(()=>window.__testPad.buttons[13]={pressed:true,value:1});await page.waitForTimeout(100);
 assert.ok(await page.evaluate(()=>document.activeElement.closest('#flight-pause')!==null),'Controller focus stays inside flight menu');
 await page.evaluate(()=>{window.__testPad.buttons[13]={pressed:false,value:0};window.__testPad.buttons[1]={pressed:true,value:1};});await page.waitForSelector('#flight-pause',{state:'detached'});
 await page.evaluate(()=>{delete navigator.getGamepads;delete window.__testPad;});
 // UI off must not stop rendering instrument textures on actual cockpit surfaces.
 await page.evaluate(()=>{const s=window.__hudState;delete s.base.flight;window.__hudState={...s,id:'c172',label:'C172',base:{...s.base,view:'cockpit'}};});
 await page.waitForFunction(()=>window.__cockpitTexture?.('ga')?.length===1280*512*4);
 await page.keyboard.press('F10');await page.waitForSelector('body.immersive-hidden');
 const cleanPixels=await page.evaluate(()=>Array.from(window.__display('ga').filter((_,i)=>i%97===0)));
 await page.evaluate(()=>{window.__hudState={...window.__hudState,alt:2200,vs:-3};});await page.waitForTimeout(500);
 assert.notDeepEqual(await page.evaluate(()=>Array.from(window.__display('ga').filter((_,i)=>i%97===0))),cleanPixels);
 await menu();await page.getByRole('button',{name:'Weather',exact:true}).click();await page.waitForSelector('.deck-briefing');
 await page.getByRole('button',{name:'Close briefing'}).click();
 await menu();await page.getByRole('button',{name:'Flight setup',exact:true}).click();
 await page.waitForSelector('#sim-start:not([hidden])');
 assert.equal(await page.locator('#sim-start').getAttribute('data-step'),'welcome');
 assert.deepEqual(errors,[]);console.log('Verified wizard layout and 4.5:1 text contrast at desktop/mobile sizes, three cockpit layouts, route details, METAR widget, autopilot commands, unpowered planner and mobile briefing without browser errors.');
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1});
