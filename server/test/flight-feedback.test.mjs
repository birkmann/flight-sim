import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:[new URL('../../bevy/deck/hazards.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm'});
const {flightHazard}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const flight={onGround:false,phase:'local flight',warnings:[]};
test('terrain warning covers level flight into a mountain, escalates, and clears when safe',()=>{
 assert.equal(flightHazard({terrainTti:9,vs:0,agl:800},flight).title,'TERRAIN AHEAD');
 assert.equal(flightHazard({terrainTti:4,vs:0,agl:800},flight).title,'PULL UP');
 assert.equal(flightHazard({terrainTti:null,vs:0,agl:800},flight),null);
 assert.equal(flightHazard({terrainTti:4,onGround:true},flight),null);
 assert.equal(flightHazard({terrainTti:4},{...flight,phase:'crashed'}),null);
});
test('stall, steep descent and gear warnings work in local flights without a flight plan',()=>{
 assert.equal(flightHazard({stall:true},flight).id,'stall');
 assert.equal(flightHazard({agl:40,vs:-6},flight).id,'sink');
 assert.equal(flightHazard({gearWarning:true},flight).id,'gear');
 assert.equal(flightHazard({agl:30,vs:-2,gear:true},flight),null,'gentle landing is not a sink-rate alert');
 assert.equal(flightHazard({agl:null,vs:-12},flight),null,'unknown ground cannot produce a fabricated closure warning');
 assert.equal(flightHazard({pullUp:true,stall:true},flight).id,'terrain','imminent terrain has priority');
});
