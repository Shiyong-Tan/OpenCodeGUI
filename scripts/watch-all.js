/* eslint-disable no-console */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const children = [];
let shuttingDown = false;

function launch(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`${label} watcher failed to start:`, error);
    terminate(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${label} watcher exited unexpectedly (${signal || code || 'unknown'})`);
    terminate(code && code > 0 ? code : 1);
  });
}

function terminate(exitCode, signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  setTimeout(() => process.exit(exitCode), 100).unref();
}

process.on('SIGINT', () => terminate(130, 'SIGINT'));
process.on('SIGTERM', () => terminate(143, 'SIGTERM'));
process.on('exit', () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

launch('extension', [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--watch', '-p', './']);
launch('webview', [path.join(root, 'scripts', 'build-rendering.js'), '--watch']);
