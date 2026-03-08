/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, pattern, label) {
  const ok = typeof pattern === 'string' ? haystack.includes(pattern) : pattern.test(haystack);
  if (!ok) {
    throw new Error(`Task13 check failed: ${label}`);
  }
}

function writeEvidence(rel, content) {
  const full = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function run() {
  const client = read('src/OpenCodeClient.ts');
  const sidebar = read('src/SidebarProvider.ts');

  // Flag-off legacy behavior
  assertContains(client, /private readonly groupedResyncActivityEnabled = false;/, 'grouped resync flag defaults to false');

  // Grouped guards retain legacy path
  assertContains(client, /groupedResyncActivityEnabled\s*\?\s*this\.getRelatedSessionIds\(rootSessionId\)\s*:\s*\[sessionId\]/, 'grouped replay guard keeps legacy single-session path');
  assertContains(client, /if \(!this\.groupedResyncActivityEnabled\) \{\s*\n\s*return this\.lastSseAtBySession\.get\(sessionId\)/s, 'grouped SSE freshness guard preserves session-local path');
  assertContains(client, /if \(!this\.groupedResyncActivityEnabled\) \{\s*\n\s*return this\.lastProgressAtBySession\.get\(sessionId\)/s, 'grouped progress freshness guard preserves session-local path');

  // Rollback safety: replay suppression + live path still intact
  assertContains(client, /source === 'resync'\) return;/, 'replay skip in mirrorChangesToParentSession');
  assertContains(sidebar, /const isReplay = event\.source === 'resync';/, 'sidebar replay detection exists');
  assertContains(sidebar, /if \(!isReplay\) \{\s*\n\s*this\.client\.queueSubagentChanges/s, 'sidebar live-only queueSubagentChanges path');

  // Evidence output (two scenarios)
  writeEvidence('.sisyphus/evidence/task-13-rollout-check.txt', [
    'Task 13 rollout validation',
    '- flag defaults to off (legacy mode)',
    '- grouped guards keep session-local paths available',
    '',
    `timestamp=${new Date().toISOString()}`
  ].join('\n'));

  writeEvidence('.sisyphus/evidence/task-13-rollback-check.txt', [
    'Task 13 rollback validation',
    '- replay suppression guards present',
    '- live-only queue path remains (SidebarProvider)',
    '',
    `timestamp=${new Date().toISOString()}`
  ].join('\n'));

  console.log('Task13 check passed.');
}

run();
