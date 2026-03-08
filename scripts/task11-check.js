/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, pattern, label) {
  const ok = typeof pattern === 'string' ? haystack.includes(pattern) : pattern.test(haystack);
  if (!ok) {
    throw new Error(`Task11 check failed: ${label}`);
  }
}

function run() {
  const client = read('src/OpenCodeClient.ts');
  const sidebar = read('src/SidebarProvider.ts');

  // Grouped liveness helpers + usage (positive/negative coverage)
  assertContains(client, /getGroupedSseFreshness\(/, 'grouped SSE freshness helper exists');
  assertContains(client, /getGroupedProgressFreshness\(/, 'grouped progress freshness helper exists');
  assertContains(client, /subagentToParentSessionMap\.has\(sessionId\).*return this\.lastSseAtBySession\.get\(sessionId\)/s, 'subagent uses session-local SSE freshness');
  assertContains(client, /subagentToParentSessionMap\.has\(sessionId\).*return this\.lastProgressAtBySession\.get\(sessionId\)/s, 'subagent uses session-local progress freshness');
  assertContains(client, /rescue\.defer \| sessionId=.*reason=grouped-activity/, 'grouped activity defers rescue timer');
  assertContains(client, /rescue\.defer\.override \| sessionId=.*reason=root-stale/, 'grouped defer override when root stale');
  assertContains(client, /const sseSilent = !lastSseAppliedAt/, 'settle uses session-local SSE silence');

  // Replay filter skip/accept behavior
  assertContains(client, /shouldReplayResyncMessage\(/, 'resync replay filter exists');
  assertContains(client, /summary=true/, 'replay filter skips summary messages');
  assertContains(client, /mode=compaction/, 'replay filter skips compaction messages');
  assertContains(client, /currentTurnUserMsgIdBySession/, 'replay filter anchor priority uses current turn user msg');
  assertContains(client, /pendingUserMsgIdBySession/, 'replay filter anchor priority uses pending user msg');

  // Replay source tagging presence
  assertContains(client, /source: 'resync'/, 'replay events tagged with source=resync');
  assertContains(client, /mapServerEventToChatEvents\(.*source: EventSource = 'sse'/s, 'live events default to source=sse');

  // Flag-off legacy behavior
  assertContains(client, /private readonly groupedResyncActivityEnabled = false;/, 'grouped resync flag defaults to false');

  // Sidebar replay firewall (restore-only behavior)
  assertContains(sidebar, /const isReplay = event\.source === 'resync';/, 'sidebar identifies replay source');
  assertContains(sidebar, /if \(!isReplay\) \{\s*\n\s*this\.client\.queueSubagentChanges/s, 'sidebar skips queueSubagentChanges on replay');

  console.log('Task11 check passed.');
}

run();
