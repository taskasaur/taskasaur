import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function entries(directory) {
  return (await Promise.all((await readdir(directory, {withFileTypes:true})).map(e => e.isDirectory() ? entries(`${directory}/${e.name}`) : e.name.endsWith('.ts') ? [`${directory}/${e.name}`] : []))).flat();
}
await rm('packages/platform/dist', { recursive: true, force: true });
await build({ entryPoints: await entries('packages/platform/src'), outdir:'packages/platform/dist', outbase:'packages/platform/src', bundle:true, splitting:true, format:'esm', platform:'neutral', packages:'external', external:['node:*'], target:'es2022', sourcemap:true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc','-p','packages/platform/tsconfig.json'], {stdio:'inherit'});
