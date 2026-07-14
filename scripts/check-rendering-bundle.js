/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
console.log(JSON.stringify({ minifiedBytes: source.byteLength, gzipBytes, limits: { minified: 76800, gzip: 25600 } }));
