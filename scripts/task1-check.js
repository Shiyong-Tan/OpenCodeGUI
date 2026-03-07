/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, pattern, label) {
  const ok = typeof pattern === 'string' ? haystack.includes(pattern) : pattern.test(haystack);
  if (!ok) {
    throw new Error(`Task1 check failed: ${label}`);
  }
}

function run() {
  const client = read('src/OpenCodeClient.ts');
  const sidebar = read('src/SidebarProvider.ts');
  const webview = read('media/main.js');

  // SSE / final engine
  assertContains(client, /type NormalizedEvent\s*=\s*\{/, 'NormalizedEvent exists');
  assertContains(client, /classifyEventLane\(/, 'lane classifier exists');
  assertContains(client, /normalizeEvent\(/, 'normalizeEvent exists');
  assertContains(client, /shouldAcceptSubagentCompletionFinal\(/, 'subagent final engine exists');
  assertContains(client, /phase:\s*'assistant_progress'/, 'assistant_progress phase emitted');
  assertContains(client, /phase:\s*'assistant_final_candidate'/, 'assistant_final_candidate phase emitted');
  assertContains(client, /phase:\s*'assistant_final_accepted'/, 'assistant_final_accepted phase emitted');

  // Idempotency
  assertContains(client, /consumePhaseOnce\(/, 'phase idempotency function exists');
  assertContains(client, /assistant:\$\{phase\}/, 'assistant phase idempotency key used');

  // Metrics
  assertContains(client, /metrics\.task1/, 'client task1 metrics log exists');
  assertContains(sidebar, /metrics\.task1 done_visible_ms=/, 'sidebar done_visible_ms metrics log exists');

  // Subagent state machine / protocol
  assertContains(sidebar, /type SubagentLifecycleState = 'queued' \| 'running' \| 'finalizing' \| 'done' \| 'failed' \| 'cancelled' \| 'dismissed'/, 'subagent lifecycle states complete');
  assertContains(sidebar, /type: 'subagentStateDelta'/, 'subagentStateDelta emitted');
  assertContains(sidebar, /type: 'turnFinalizePhase'/, 'turnFinalizePhase emitted');

  // UI status / hydrate safety
  assertContains(webview, /running \/ \$\{finalizingCount\} finalizing/, 'header indicator running/finalizing');
  assertContains(webview, /Done just now/, 'header indicator done just now');
  assertContains(webview, /prevState/, 'hydrate merge keeps previous state');
  assertContains(webview, /case 'assistantPhase':/, 'webview receives assistantPhase');

  console.log('Task1 check passed.');
}

run();

