// Actual WebGPU gameplay captures. No mock terrain, artwork, or compositing.
// Run npm start, then npm run capture:flights. Requires access to the terrain API.
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const origin = process.argv[2] || 'http://127.0.0.1:5197/';
const directory = fileURLToPath(new URL('../docs/screenshots/flights/', import.meta.url));
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({
 headless: process.env.HEADLESS !== '0',
 ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}),
 args: ['--no-sandbox', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', ...(process.env.HEADLESS === '0' ? ['--use-angle=gl'] : [])],
});
const shots = [
 {name:'san-francisco-afternoon', city:'sanfrancisco', aircraft:'c172', orbit:[-300,65], weather:{hour:15.5,day:180,clouds:0.48,cloudBase:1800,visibility:65000}},
 {name:'sydney-golden-hour', city:'sydney', aircraft:'c172', orbit:[260,65], weather:{hour:17.8,day:15,clouds:0.35,cloudBase:1700,visibility:35000}},
 {name:'alpine-clouds', city:'matterhorn', aircraft:'glider', orbit:[-220,45], weather:{hour:10,day:180,clouds:0.58,cloudBase:4800,visibility:80000}},
];
const manifest = process.env.SHOT ? JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8').catch(() => '[]')) : [];
try {
 for (const shot of shots.filter(s => !process.env.SHOT || s.name === process.env.SHOT)) {
  const page = await browser.newPage({ viewport: {width:1920,height:1080}, deviceScaleFactor:1 });
  const errors=[];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {if(m.type()==='error' || /%cERROR|panicked|DeviceLost/.test(m.text())) { const text=m.text().replace(/key=[^&\s]+/g,'key=REDACTED'); errors.push(text); console.error(text.slice(0,3000)); }});
  await page.addInitScript(({city,aircraft,weather})=>{
   const requestAdapter = navigator.gpu?.requestAdapter.bind(navigator.gpu);
   if (requestAdapter) navigator.gpu.requestAdapter = async (...args) => {
    const adapter = await requestAdapter(...args);
    window.__captureGpu = adapter ? {vendor:adapter.info.vendor,architecture:adapter.info.architecture} : null;
    return adapter;
   };
   localStorage.setItem('flight-simulator.start',JSON.stringify({city,mode:'vehicle',asset:aircraft}));
   localStorage.setItem('sandbox.weather',JSON.stringify({...weather,precipitation:0,lightning:false,snow:false,timeRate:0,windSpeed:2,atmosphere:true,cloudLayer:true}));
   localStorage.setItem('sandbox.options',JSON.stringify({fov:50,detail:0.7}));
  },shot);
  console.log('Loading',shot.name);
  await page.goto(origin, {waitUntil:'domcontentloaded'});
  try {
   await page.waitForFunction(()=>window.__hudState, null, {timeout:120000});
   await page.waitForFunction(()=>window.__hudState?.base && !window.__hudState.base.travel, null, {timeout:120000});
   await page.waitForTimeout(5000);
   console.log('Renderer ready');
   await page.locator('.st-steps [data-step="brief"]').click();
   await page.locator('.st-btn.launch').click();
   await page.waitForFunction(()=>window.__hudState?.mode !== 'free' && window.__hudState?.label, null, {timeout:90000});
   console.log('Aircraft spawned');
   await page.waitForFunction(()=>window.__tileStats?.tiles > 30 && window.__tileStats?.residentMB > 10, null, {timeout:120000});
   await page.waitForTimeout(15000);
   await page.keyboard.press('F10');
   await page.bringToFront();
   await page.locator('#canvas').click({position:{x:960,y:540}});
   await page.waitForFunction(()=>window.__hudState?.base?.locked);
   await page.mouse.move(980,520);
   await page.mouse.down({button:'right'});
   await page.mouse.move(980 + shot.orbit[0],520 + shot.orbit[1],{steps:30});
   await page.mouse.up({button:'right'});

   await page.waitForTimeout(3000);
   if(errors.length) throw new Error(errors.join('\n').slice(0,10000));
   const state=await page.evaluate(()=>({hud:window.__hudState,terrain:window.__tileStats,gpu:window.__captureGpu}));
   if(state.hud.alt < 50 || state.hud.base.alt < 50 || state.terrain.residentMB < 10 || state.hud.mode === 'free') throw new Error('Flight or terrain did not remain capture-ready');
   await page.screenshot({path:`${directory}/${shot.name}.jpg`,type:'jpeg',quality:94});
   const previous = manifest.findIndex(item => item.name === shot.name);
   if (previous >= 0) manifest.splice(previous, 1);
   manifest.push({...shot,capturedAt:new Date().toISOString(),viewport:[1920,1080],...state});
   await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
   console.log('Captured',shot.name,JSON.stringify(state.terrain));
   if (process.env.CHECK_WEATHER === '1' && shot === shots[0]) {
    const presets = await page.evaluate(()=>window.__simCatalog.presets);
    for (const [name, weather] of [...presets, ['Night', {hour:23.5,clouds:0.3,precipitation:0,lightning:false}]]) {
     await page.evaluate(weather=>dispatchEvent(new CustomEvent('sim:set-weather',{detail:weather})),weather);
     await page.waitForTimeout(2500);
     if(errors.length) throw new Error(errors.join('\n').slice(0,10000));
     await page.screenshot({path:`/tmp/weather-${name.toLowerCase().replaceAll(' ','-')}.png`});
     console.log('Weather rendered:',name);
    }
    await page.keyboard.press('KeyF');
    await page.waitForFunction(()=>window.__hudState?.mode === 'free');
    for (const [name, height, pitch] of [['below',1000,10], ['inside',2200,0], ['above',5000,-20]]) {
     await page.evaluate(({height,pitch})=>{
      dispatchEvent(new CustomEvent('sim:set-weather',{detail:{hour:12,clouds:1,cloudBase:1500,precipitation:0,snow:false,lightning:false,visibility:60000}}));
      window.__cmds.push(JSON.stringify({type:'camera',height,pitch}));
     },{height,pitch});
     await page.waitForTimeout(2500);
     if(errors.length) throw new Error(errors.join('\n').slice(0,10000));
     await page.screenshot({path:`/tmp/weather-${name}-cloud.png`});
     console.log('Cloud altitude rendered:',name);
    }
   }
  } catch(error) {
   await page.screenshot({path:`/tmp/${shot.name}-failure.png`});
   console.error('Graphics errors:',errors.join('\n').slice(0,16000));
   throw error;
  } finally {await page.close();}
 }
 await writeFile(`${directory}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
} finally {await browser.close();}
