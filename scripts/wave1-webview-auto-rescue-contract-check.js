/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, needle, label) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    throw new Error(`Wave1 webview auto-rescue contract check failed: ${label}`);
  }
}

function run() {
  const sidebar = read('src/SidebarProvider.ts');
  const webview = read('media/main.js');

  assertContains(sidebar, 'selectedAction=${selected}', 'extension notification action includes selectedAction');
  assertContains(sidebar, 'currentToken=${String(currentSameToken)}', 'extension notification action includes current token status');
  assertContains(sidebar, 'branch=fresh-active-turn-command', 'extension fresh active turn branch marker');
  assertContains(sidebar, "type: 'webviewAutoRescueRenderCurrentState'", 'extension posts narrow fresh active turn command');
  assertContains(sidebar, "rescueRenderMode: 'render-current-state-once'", 'fresh active turn command render mode');
  assertContains(sidebar, "rescueRenderMode: 'force-full-render-once'", 'sessionData rescue render mode');
  assertContains(sidebar, 'branch=not-fresh-sessionData', 'extension not-fresh sessionData branch marker');
  assertContains(sidebar, 'postedSessionData=false', 'fresh branch documents no sessionData repost');

  assertContains(webview, "case 'webviewAutoRescueRenderCurrentState'", 'WebView command handler exists');
  assertContains(webview, 'webviewAutoRescueProcessedAttemptIds', 'WebView rescue idempotence set exists');
  assertContains(webview, 'rescue-command-received', 'WebView command receive marker');
  assertContains(webview, 'rescue-sessionData-received', 'WebView sessionData receive marker');
  assertContains(webview, 'rescue-force-render-start', 'WebView force render start marker');
  assertContains(webview, 'rescue-force-render-done', 'WebView force render done marker');
  assertContains(webview, 'rescue-force-render-skip', 'WebView force render skip marker');
  assertContains(webview, 'reason=duplicate-attempt', 'WebView duplicate attempt skip marker');
  assertContains(webview, 'webviewAutoRescue-render-current-state-once', 'WebView current-state render reason');
  assertContains(webview, 'webviewAutoRescue-force-full-render-once', 'WebView force-full rescue render reason');

  console.log('Wave1 webview auto-rescue contract check passed.');
}

run();
