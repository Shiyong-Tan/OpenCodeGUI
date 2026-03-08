/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, pattern, label) {
  const ok = typeof pattern === 'string' ? haystack.includes(pattern) : pattern.test(haystack);
  if (!ok) {
    throw new Error(`Task12 check failed: ${label}`);
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

  // Grouped rescue suppression markers
  assertContains(client, /rescue\.defer \| sessionId=.*reason=grouped-activity/, 'grouped rescue defer marker');
  assertContains(client, /rescue\.defer\.override \| sessionId=.*reason=root-stale/, 'grouped rescue defer override marker');
  assertContains(client, /getGroupedSseFreshness\(/, 'grouped SSE freshness helper present');
  assertContains(client, /const sseSilent = !lastSseAppliedAt/, 'settle uses session-local SSE silence');

  // Root-owned recovery gate markers
  assertContains(client, /resync\.root\.recover\.blocked \| rootSessionId=.*reason=subagent-final/, 'root recovery blocked on subagent final');
  assertContains(client, /resync\.root\.recover\.blocked \| rootSessionId=.*reason=subagent-sse/, 'root recovery blocked on subagent SSE');

  // Replay side-effect suppression markers
  assertContains(client, /resync\.subagent\.sideeffect\.suppressed/, 'resync side-effect suppression marker');
  assertContains(sidebar, /const isReplay = event\.source === 'resync';/, 'sidebar identifies replay');
  assertContains(sidebar, /if \(!isReplay\) \{\s*\n\s*this\.client\.queueSubagentChanges/s, 'sidebar suppresses queueSubagentChanges on replay');

  // Grouped replay markers
  assertContains(client, /resync\.group\.activity/, 'grouped replay activity marker');
  assertContains(client, /resync\.root\.recover\.blocked \| .*reason=subagent-resync-active/, 'grouped replay blocked marker');

  // Replay accept/skip and filter anchors
  assertContains(client, /shouldReplayResyncMessage\(/, 'replay filter exists');
  assertContains(client, /summary=true/, 'replay filter skip summary');
  assertContains(client, /mode=compaction/, 'replay filter skip compaction');
  assertContains(client, /currentTurnUserMsgIdBySession/, 'replay filter anchor priority current user');
  assertContains(client, /pendingUserMsgIdBySession/, 'replay filter anchor priority pending user');

  // Evidence output
  writeEvidence('.sisyphus/evidence/task-12-integration-check.txt', [
    'Task 12 integration verification',
    '- grouped rescue defer marker present',
    '- root-owned recovery gate markers present',
    '- replay side-effect suppression markers present',
    '- grouped replay activity/block markers present',
    '- replay filter skip/anchor markers present',
    '',
    `timestamp=${new Date().toISOString()}`
  ].join('\n'));

  console.log('Task12 check passed.');
}

run();
