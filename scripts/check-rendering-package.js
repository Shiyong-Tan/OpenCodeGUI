/* eslint-disable no-console */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const command = process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npx.cmd --yes @vscode/vsce@3.6.2 ls'] }
  : { file: 'npx', args: ['--yes', '@vscode/vsce@3.6.2', 'ls'] };
const result = spawnSync(command.file, command.args, {
  cwd: root,
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error(String(result.error || result.stderr || result.stdout));
const files = result.stdout.split(/\r?\n/).map((file) => file.trim().replace(/\\/g, '/')).filter(Boolean);
if (!files.some((file) => file.endsWith('media/rendering.bundle.js'))) {
  throw new Error('VSIX package contents omit media/rendering.bundle.js');
}
if (!files.some((file) => file.endsWith('media/features.bundle.js'))) {
  throw new Error('VSIX package contents omit media/features.bundle.js');
}
for (const file of files) {
  if (file.includes('webview-src/') || file.endsWith('rendering.bundle.js.map') || file.endsWith('features.bundle.js.map')) {
    throw new Error(`Development-only file would be packaged: ${file}`);
  }
}
console.log('VSIX content policy: PASS (bundle included; webview-src and source map excluded)');
