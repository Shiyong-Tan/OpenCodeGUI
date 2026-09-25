'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const text = fs.readFileSync(path.resolve(__dirname, '..', 'media', 'supervisor.bundle.js'), 'utf8');
const minifiedBytes = Buffer.byteLength(text), gzipBytes = zlib.gzipSync(text).length;
// Includes process rows, accessible health indicator and inline shield icon.
const limits = { minified: 26624, gzip: 9216 };
if (minifiedBytes > limits.minified || gzipBytes > limits.gzip) throw new Error('Supervisor bundle exceeds its fixed size budget');
if (!text.includes('supervisor-panel') || text.includes('Bearer ') || text.includes('serviceAuthorization')) throw new Error('Supervisor bundle boundary invalid');
console.log(JSON.stringify({ supervisor: { minifiedBytes, gzipBytes, limits } }));
