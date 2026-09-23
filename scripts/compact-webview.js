'use strict';
const fs = require('fs');
const path = require('path');
const uglify = require('uglify-js');
// Only implementation-private TanStack fields, never adapter/public/protocol keys.
const PRIVATE_CORE_FIELDS = Object.freeze([
  'unsubs', 'scrollState', '_flatMeasurements', 'itemSizeCacheVersion', 'laneAssignments',
  'pendingMin', 'prevLanes', 'lanesChangedFlag', 'lanesSettling', 'pendingScrollAnchor',
  '_iosDeferredAdjustment', '_iosTouching', '_iosJustTouchEnded', '_iosTouchEndTimerId',
  '_intendedScrollOffset', 'applyScrollAdjustment', 'maybeNotify', '_flushIosDeferredIfReady',
  'scheduleScrollReconcile', 'reconcileScroll', 'getMeasurementOptions', 'getMeasurements',
  'shouldMeasureDuringScroll', 'getMaxScrollOffset', 'getVirtualDistanceFromEnd', '_scrollToOffset',
]);
function assertPrivateBoundary(declaration, consumers) {
  for (const field of PRIVATE_CORE_FIELDS) {
    if (!new RegExp('private ' + field + ';').test(declaration)) throw Error('Core field is no longer private: ' + field);
    for (const [file, source] of consumers) {
      if (new RegExp('\\b' + field + '\\b').test(source)) throw Error('Private minification field escaped into consumer: ' + file + ':' + field);
    }
  }
}
function validateCoreBoundary(root) {
  const core = path.join(root, 'node_modules', '@tanstack', 'virtual-core');
  if (JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')).version !== '3.17.4') throw Error('Review private field boundary on TanStack upgrade');
  const consumers = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '__tests__') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith('.ts')) consumers.push([file, fs.readFileSync(file, 'utf8')]);
    }
  }
  visit(path.join(root, 'webview-src'));
  consumers.push(['media/main.js', fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8')]);
  assertPrivateBoundary(fs.readFileSync(path.join(core, 'dist', 'esm', 'index.d.ts'), 'utf8'), consumers);
}
function compact(source, rendering = false) {
  const result = uglify.minify(source, {
    compress: {passes: 5, hoist_vars: true, hoist_funs: true, pure_getters: false, unsafe: false},
    mangle: rendering ? {properties: {regex: new RegExp('^(' + PRIVATE_CORE_FIELDS.join('|') + ')$')}} : true,
    output: {comments: false, ascii_only: false},
  });
  if (result.error) throw result.error;
  return result.code + '\n';
}
function compactProductionBundles(root) {
  validateCoreBoundary(root);
  for (const name of ['rendering', 'continuation']) {
    const file = path.join(root, 'media', name + '.bundle.js');
    fs.writeFileSync(file, compact(fs.readFileSync(file, 'utf8'), name === 'rendering'));
  }
}
module.exports = {compactProductionBundles, compact, assertPrivateBoundary, PRIVATE_CORE_FIELDS};
