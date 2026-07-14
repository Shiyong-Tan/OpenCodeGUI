/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'media', 'rendering.bundle.js');
const mapFile = `${bundle}.map`;
const originalBundle = fs.existsSync(bundle) ? fs.readFileSync(bundle) : undefined;
let failure;

try {
  const build = spawnSync(process.execPath, ['scripts/build-rendering.js', '--development'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || build.stdout);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  if (!map.sources.some((source) => source.replace(/\\/g, '/').endsWith('webview-src/rendering/index.ts'))) {
    throw new Error('Development map does not reference webview-src/rendering/index.ts');
  }
  const probe = "global.window=globalThis;require('./media/rendering.bundle.js');window.__ocRendering.throwSourceMapTestError()";
  const result = spawnSync(process.execPath, ['--enable-source-maps', '-e', probe], { cwd: root, encoding: 'utf8' });
  const stack = `${result.stdout}\n${result.stderr}`.replace(/\\/g, '/');
  if (result.status === 0 || !stack.includes('webview-src/rendering/index.ts')) {
    throw new Error(`Intentional error was not mapped to webview-src:\n${stack}`);
  }
} catch (error) {
  failure = error;
} finally {
  fs.rmSync(mapFile, { force: true });
  const production = spawnSync(process.execPath, ['scripts/build-rendering.js'], { cwd: root, encoding: 'utf8' });
  if (production.status !== 0) {
    if (originalBundle) fs.writeFileSync(bundle, originalBundle);
    else fs.rmSync(bundle, { force: true });
    failure ||= new Error(production.stderr || production.stdout || 'Failed to restore production bundle');
  }
}

if (failure) throw failure;
console.log('Source-map smoke: PASS (intentional error mapped to webview-src/rendering/index.ts)');
