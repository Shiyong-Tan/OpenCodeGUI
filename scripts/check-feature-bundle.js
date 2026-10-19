/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.resolve(__dirname, '..', 'media', 'features.bundle.js');
if (!fs.existsSync(file)) throw new Error('Build media/features.bundle.js first');
const text = fs.readFileSync(file, 'utf8');
const minifiedBytes = Buffer.byteLength(text);
const gzipBytes = zlib.gzipSync(text).length;
// Local file URL normalization adds <1 KiB; see production-bundle-compaction.md.
const limits = { minified: 60416, gzip: 20480 };
if (!text.includes('__ocFeatures')) throw new Error('Versioned feature facade is missing');
if (minifiedBytes > limits.minified || gzipBytes > limits.gzip) {
  throw new Error(`Feature bundle exceeds size limit: ${JSON.stringify({ minifiedBytes, gzipBytes, limits })}`);
}
console.log(JSON.stringify({ minifiedBytes, gzipBytes, limits }));
