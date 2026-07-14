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

async function run() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log('Watching webview rendering seam...');
    return;
  }
  if (!development) {
    fs.rmSync(`${options.outfile}.map`, { force: true });
  }
  await esbuild.build(options);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
