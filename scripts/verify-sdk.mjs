import { readFile, realpath } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.dependencies['@taskasaur/platform'] !== 'file:packages/platform') throw Error('Use the in-repository platform workspace');
const target = await realpath('node_modules/@taskasaur/platform');
if (target !== await realpath('packages/platform')) throw Error('Run npm install to link the platform workspace');
console.log('In-repository platform workspace verified.');
