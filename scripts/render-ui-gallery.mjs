import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {createApp} from '../server/serve.mjs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const bundle=await build({entryPoints:['scripts/ui/gallery.js'],bundle:true,write:false,format:'iife'});
const server=createServer(createApp());await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1600,height:900}});
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route(origin+'/',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.goto(origin);await page.addScriptTag({content:bundle.outputFiles[0].text});
 await mkdir('bevy/assets/ui',{recursive:true});
 for(const id of ['c172','glider','airliner','world']){await page.evaluate(id=>window.renderGallery(id),id);await page.screenshot({path:`bevy/assets/ui/${id}.jpg`,type:'jpeg',quality:88});console.log('Rendered',id);}
 const geo=JSON.parse(await readFile('scripts/ui/world.json','utf8'));
 const paths=geo.features.flatMap(({geometry:g})=>(g.type==='Polygon'?[g.coordinates]:g.coordinates).map(poly=>poly.map(ring=>'M'+ring.map(([lon,lat])=>`${((lon+180)/360*1000).toFixed(1)},${((90-lat)/180*500).toFixed(1)}`).join(' L')+'Z').join(' ')));
 await writeFile('bevy/assets/ui/world-map.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect width="1000" height="500" fill="#122c3d"/><defs><pattern id="g" width="83.33" height="83.33" patternUnits="userSpaceOnUse"><path d="M83.33 0H0V83.33" fill="none" stroke="#8cd7ee" stroke-opacity=".1"/></pattern></defs><rect width="1000" height="500" fill="url(#g)"/><g fill="#34576a" stroke="#8ab0c3" stroke-width=".35" fill-rule="evenodd">${paths.map(d=>`<path d="${d}"/>`).join('')}</g></svg>`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
