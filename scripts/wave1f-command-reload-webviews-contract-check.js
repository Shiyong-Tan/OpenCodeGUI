/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'SidebarProvider.ts'), 'utf8');
const commandId = 'workbench.action.webview.reloadWebviewAction';

function assertContains(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Wave1f command reload contract failed: ${label}`);
}
function assertNotContains(source, needle, label) {
  if (source.includes(needle)) throw new Error(`Wave1f command reload contract failed: ${label}`);
}
function assertOrder(source, before, after, label) {
  const a = source.indexOf(before);
  const b = source.indexOf(after);
  if (a < 0 || b < 0 || a >= b) throw new Error(`Wave1f command reload contract failed: ${label}`);
}
function method(name, next) {
  const start = sidebar.indexOf(name);
  const end = sidebar.indexOf(next, start + 1);
  if (start < 0 || end < 0) throw new Error(`Wave1f command reload contract failed: missing method ${name}`);
  return sidebar.slice(start, end);
}

const hardFailure = method('private finishWebviewHardRescueFailure', 'private isWebviewCommandReloadCurrent');
const begin = method('private async beginWebviewCommandReload', 'private async handleWebviewCommandReloadReady');
const ready = method('private async handleWebviewCommandReloadReady', 'private beginWebviewHardRescue');
const sendInit = method('private async sendInit', 'private async saveClipboardImage');
const readyCaseStart = sidebar.indexOf('case "webviewReady"');
const readyCaseEnd = sidebar.indexOf('case "webviewLivenessAck"', readyCaseStart);
const readyCase = sidebar.slice(readyCaseStart, readyCaseEnd);

assertContains(hardFailure, 'this.webviewHardRescuePending = undefined;', 'HTML hard pending cleanup precedes escalation');
assertOrder(hardFailure, 'this.webviewHardRescuePending = undefined;', 'void this.beginWebviewCommandReload', 'command escalation is terminal-hard-rescue-only');
assertContains(begin, 'this.webviewCommandReloadEpisodeIds.add(episodeId);', 'episode gate exists');
assertOrder(begin, 'this.webviewCommandReloadEpisodeIds.add(episodeId);', 'await vscode.commands.getCommands(true)', 'consumed gate is set before first await');
assertContains(sidebar, 'webviewCommandReloadTimeoutMs = 15000', '15 second timeout exists');
assertContains(begin, 'vscode.commands.getCommands(true)', 'exact command availability lookup exists');
assertContains(begin, "commands.includes(commandId)", 'availability checks exact command membership');
assertContains(begin, 'webviewCommandReload.unavailable', 'absent command marker exists');
assertContains(begin, 'webviewCommandReload.executeFailed', 'execute failure marker exists');
assertContains(begin, 'await vscode.commands.executeCommand(commandId);', 'single command invocation exists');
assertContains(begin, 'resultIsNotSuccess=true', 'command resolution is not success');
assertContains(begin, 'webviewCommandReload.invoked', 'invocation marker exists');
assertContains(begin, 'webviewCommandReload.available', 'availability marker exists');
assertContains(sidebar, 'webviewCommandReload.${marker}', 'timeout terminal marker exists');
assertNotContains(begin, 'workbench.action.reloadWindow', 'no automatic Reload Window fallback in command lifecycle');

assertOrder(readyCase, 'handleWebviewCommandReloadReady', 'const pending = this.webviewHardRescuePending;', 'command ready branch precedes hard/normal branch');
assertContains(ready, 'newWebviewInstanceId === pending.oldWebviewInstanceId', 'same ID is rejected');
assertContains(ready, 'session-mismatch', 'stale session is rejected');
assertContains(ready, 'selection-epoch-changed', 'stale epoch is rejected');
assertContains(ready, 'active-turn-changed', 'active-turn drift is rejected');
assertContains(ready, 'webviewCommandReload.handshake.rejected', 'rejected handshake marker exists');
assertContains(ready, 'webviewCommandReload.handshake.accepted', 'accepted handshake marker exists');
assertOrder(ready, "if (rejectionReason)", 'pending.newWebviewInstanceId = newWebviewInstanceId;', 'identity is validated before synchronous adoption');
assertContains(ready, 'tokenAuthoritative=false', 'hard token is non-authoritative');
assertContains(ready, 'commandReloadGuard', 'async work is generation gated');
assertContains(ready, 'webviewCommandReload.hydration.mode', 'hydration marker exists');
assertContains(ready, 'webviewCommandReload.complete', 'completion marker exists');
assertOrder(ready, 'await this.sendInit', "type: 'webviewReadyAck'", 'init precedes readyAck');

assertContains(sidebar, 'commandReload?: {', 'command reload has distinct sendInit option');
assertContains(sendInit, 'const rescueHydration = options.hardRescue || options.commandReload;', 'command reload reuses guarded hydration only');
assertContains(sendInit, 'if (options.commandReload?.activeTurn.fresh)', 'fresh command reload hydration gate exists');
const freshStart = sendInit.indexOf('if (options.commandReload?.activeTurn.fresh)');
const freshEnd = sendInit.indexOf('let snapshotLoaded', freshStart);
const fresh = sendInit.slice(freshStart, freshEnd);
assertContains(fresh, 'postLiveTurnHistoryForSendInitGuardDefer', 'fresh hydration posts live history');
assertContains(fresh, 'postLiveTurnResumeForSendInitGuardDefer', 'fresh hydration posts live resume');
assertNotContains(fresh, "type: 'sessionData'", 'fresh command reload sends no sessionData');
assertOrder(fresh, 'postLiveTurnHistoryForSendInitGuardDefer', 'postLiveTurnResumeForSendInitGuardDefer', 'live history precedes resume');
assertContains(ready, "'idle-normal-hydration'", 'idle path remains normal hydration');

const commandOccurrences = (sidebar.match(new RegExp(commandId.replace(/\./g, '\\.'), 'g')) || []).length;
if (commandOccurrences !== 1) throw new Error(`Wave1f command reload contract failed: expected one exact command literal, found ${commandOccurrences}`);
assertContains(sidebar, 'case "reloadWindow"', 'existing user-originated reloadWindow action remains present');
console.log('Wave1f command Reload Webviews contract: PASS');
