/* eslint-disable no-console */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'media', 'rendering.bundle.js');
function buildAndHash() {
  const result = spawnSync(process.execPath, ['scripts/build-rendering.js'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
}

const first = buildAndHash();
const second = buildAndHash();
if (first !== second) throw new Error(`Non-deterministic bundle hashes: ${first} != ${second}`);
console.log(`Deterministic production bundle SHA-256: ${first}`);
