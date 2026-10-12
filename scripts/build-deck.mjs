import { build } from 'esbuild';
await build({entryPoints:['bevy/deck/main.tsx'],bundle:true,minify:true,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},outfile:'bevy/deck.js',legalComments:'eof'});
