/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const esbuild = require('esbuild');

const file = path.resolve(__dirname, '..', 'media', 'rendering.bundle.js');
if (!fs.existsSync(file)) throw new Error('Build media/rendering.bundle.js first');
const source = fs.readFileSync(file);
const text = source.toString('utf8');
const gzipBytes = zlib.gzipSync(source, { level: 9 }).byteLength;
const forbidden = [
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bhttps?:\/\//i, 'remote URL'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\b(?:React|Vue|Svelte|Angular)\b/, 'framework'],
];
for (const [pattern, label] of forbidden) {
  if (pattern.test(text)) throw new Error(`Forbidden ${label} in rendering bundle`);
}
if (source.byteLength > 75 * 1024) throw new Error(`Bundle exceeds 75 KiB: ${source.byteLength}`);
if (gzipBytes > 25 * 1024) throw new Error(`Gzip exceeds 25 KiB: ${gzipBytes}`);
if (!text.includes('__ocRendering')) throw new Error('Versioned rendering facade is missing');

async function verifySingleTanStackCore() {
  const root = path.resolve(__dirname, '..');
  const analysis = await esbuild.build({
    entryPoints: [path.join(root, 'webview-src', 'rendering', 'index.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const normalizedInputs = Object.keys(analysis.metafile.inputs).map((input) => input.replace(/\\/g, '/'));
  const coreMarker = 'node_modules/@tanstack/virtual-core/';
  const coreInputs = normalizedInputs.filter((input) => input.includes(coreMarker));
  const implementationEntries = coreInputs.filter((input) => /\/dist\/(?:esm|cjs)\/index\.js$/.test(input));
  const packageRoots = new Set(coreInputs.map((input) => {
    const markerStart = input.indexOf(coreMarker);
    return input.slice(0, markerStart + 'node_modules/@tanstack/virtual-core'.length);
  }));
  if (coreInputs.length === 0) throw new Error('TanStack virtual-core is absent from the rendering bundle graph');
  if (implementationEntries.length !== 1 || packageRoots.size !== 1) {
    throw new Error(`Expected exactly one bundled TanStack core implementation/copy; entries=${implementationEntries.length} roots=${packageRoots.size}`);
  }
  return { tanstackCoreImplementationEntries: implementationEntries.length, tanstackCorePackageCopies: packageRoots.size };
}

verifySingleTanStackCore().then((core) => {
  console.log(JSON.stringify({ minifiedBytes: source.byteLength, gzipBytes, limits: { minified: 76800, gzip: 25600 }, ...core }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
