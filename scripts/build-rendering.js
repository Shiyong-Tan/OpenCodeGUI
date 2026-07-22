/* eslint-disable no-console */
'use strict';

const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');
const development = watch || process.argv.includes('--development');
const options = {
  entryPoints: [path.join(root, 'webview-src', 'rendering', 'index.ts')],
  outfile: path.join(root, 'media', 'rendering.bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: !development,
  sourcemap: development ? 'linked' : false,
  sourcesContent: development,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

const featureOptions = {
  ...options,
  entryPoints: [path.join(root, 'webview-src', 'features', 'index.ts')],
  outfile: path.join(root, 'media', 'features.bundle.js'),
};

const undoOptions = {
  ...options,
  entryPoints: [path.join(root, 'webview-src', 'undo', 'index.ts')],
  outfile: path.join(root, 'media', 'undo.bundle.js'),
};

const continuationOptions = {
  ...options,
  entryPoints: [path.join(root, 'webview-src', 'continuation', 'index.ts')],
  outfile: path.join(root, 'media', 'continuation.bundle.js'),
};

async function run() {
  if (watch) {
    const [renderingContext, featureContext, undoContext, continuationContext] = await Promise.all([
      esbuild.context(options),
      esbuild.context(featureOptions),
      esbuild.context(undoOptions),
      esbuild.context(continuationOptions),
    ]);
    await Promise.all([renderingContext.watch(), featureContext.watch(), undoContext.watch(), continuationContext.watch()]);
    console.log('Watching webview rendering, feature, undo, and continuation seams...');
    return;
  }
  if (!development) {
    fs.rmSync(`${options.outfile}.map`, { force: true });
    fs.rmSync(`${featureOptions.outfile}.map`, { force: true });
    fs.rmSync(`${undoOptions.outfile}.map`, { force: true });
    fs.rmSync(`${continuationOptions.outfile}.map`, { force: true });
  }
  await Promise.all([esbuild.build(options), esbuild.build(featureOptions), esbuild.build(undoOptions), esbuild.build(continuationOptions)]);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
