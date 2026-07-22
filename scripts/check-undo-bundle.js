/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.resolve(__dirname, '..', 'media', 'undo.bundle.js');
if (!fs.existsSync(file)) throw new Error('Build media/undo.bundle.js first');
const text = fs.readFileSync(file, 'utf8');
const minifiedBytes = Buffer.byteLength(text);
const gzipBytes = zlib.gzipSync(text).length;
const limits = { minified: 51200, gzip: 18000 };
if (!text.includes('__ocUndo')) throw new Error('Versioned undo facade is missing');
if (minifiedBytes > limits.minified || gzipBytes > limits.gzip) {
  throw new Error(`Undo bundle exceeds size limit: ${JSON.stringify({ minifiedBytes, gzipBytes, limits })}`);
}
console.log(JSON.stringify({ minifiedBytes, gzipBytes, limits }));
