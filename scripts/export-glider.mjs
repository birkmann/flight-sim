import { build } from 'esbuild';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const bundle=await build({entryPoints:['bevy/tools/glider/export.ts'],bundle:true,format:'iife',write:false});
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
try {
 const page=await browser.newPage(); await page.setContent('<html><body></body></html>');
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const bytes=await page.evaluate(async()=>Array.from(await window.exportGlider()));
 await writeFile('bevy/assets/models/glider.glb',new Uint8Array(bytes));
 console.log(`Exported glider: ${bytes.length} bytes`);
}finally {await browser.close();}
