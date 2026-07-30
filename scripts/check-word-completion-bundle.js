/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.resolve(__dirname, '..', 'media', 'word-completion.bundle.js');
if (!fs.existsSync(file)) throw new Error('Build media/word-completion.bundle.js first');
const text = fs.readFileSync(file, 'utf8');
const minifiedBytes = Buffer.byteLength(text);
const gzipBytes = zlib.gzipSync(text).length;
// The bundle intentionally embeds a ranked, offline English lexicon. Keep a
// dedicated ceiling so accidental logic growth remains visible.
const limits = { minified: 65536, gzip: 24576 };
if (!text.includes('__ocWordCompletion')) throw new Error('Word completion facade is missing');
if (minifiedBytes > limits.minified || gzipBytes > limits.gzip) {
  throw new Error(`Word completion bundle exceeds size limit: ${JSON.stringify({ minifiedBytes, gzipBytes, limits })}`);
}
console.log(JSON.stringify({ minifiedBytes, gzipBytes, limits }));
