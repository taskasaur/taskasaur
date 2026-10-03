import {build} from 'esbuild';
await build({entryPoints:['apps/headless/main.ts'],outfile:'dist-peer/main.js',bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:true});
console.log('Built the headless application from the shared peer core.');
