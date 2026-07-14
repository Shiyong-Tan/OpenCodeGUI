const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sidebar = fs.readFileSync(path.join(root, 'src', 'SidebarProvider.ts'), 'utf8');
const main = fs.readFileSync(path.join(root, 'media', 'main.js'), 'utf8');

function assertContains(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Missing ${label}: ${needle}`);
}

function assertOrder(source, before, after, label) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`Invalid order for ${label}`);
  }
}

assertContains(sidebar, 'webviewHardRescueTimeoutMs = 15000', '15 second hard-rescue timeout');
assertContains(sidebar, '!attempt.receivedAckSeen', 'no-receipt trigger gate');
assertContains(sidebar, '!record.ackAt', 'no-current-ACK trigger gate');
assertContains(sidebar, 'webviewHardRescueEpisodeIds.has(episodeId)', 'one reset per episode gate');
assertContains(sidebar, 'liveWebview.html = this._getHtmlForWebview(liveWebview, generationToken);', 'single hard-rescue HTML assignment');
assertContains(sidebar, 'webviewHardRescue.html.assigned', 'HTML assignment marker');
assertContains(sidebar, 'data.hardRescueGenerationToken !== pending.generationToken', 'generation token validation');
assertContains(sidebar, 'newWebviewInstanceId === pending.oldWebviewInstanceId', 'new identity validation');
assertOrder(sidebar, 'data.hardRescueGenerationToken !== pending.generationToken', 'this._webviewInstanceId = newWebviewInstanceId;', 'identity validation precedes overwrite');
assertContains(sidebar, 'webviewHardRescue.handshake.rejected', 'rejected handshake marker');
assertContains(sidebar, 'webviewHardRescue.handshake.accepted', 'accepted handshake marker');
assertContains(sidebar, 'fresh-active-turn-metadata-live-resume', 'fresh hydration mode');
assertContains(sidebar, 'idle-normal-hydration', 'idle hydration mode');
assertContains(sidebar, 'postLiveTurnHistoryForSendInitGuardDefer', 'fresh live-turn history chain');
assertContains(sidebar, 'postLiveTurnResumeForSendInitGuardDefer', 'fresh live-turn resume chain');
assertContains(sidebar, 'postedSessionData=false', 'fresh hydration excludes sessionData');
assertContains(sidebar, 'webviewHardRescue.complete', 'completion marker');
assertContains(sidebar, 'webviewHardRescue.timeout', 'timeout marker');
assertContains(sidebar, 'nextAction=Reload Window', 'manual Reload Window guidance');
assertContains(sidebar, 'isStillCurrent: hardRescueGuard', 'stale async sendInit guard');
assertContains(sidebar, 'if (!isStillCurrent()) return Promise.resolve(false);', 'stale post suppression');
assertContains(sidebar, 'const isHardRescueSendInit = Boolean(options.hardRescue && options.isStillCurrent);', 'hard-rescue-only Proxy gate');
assertContains(sidebar, 'if (isHardRescueSendInit)', 'Proxy restricted to hard-rescue sendInit');
assertContains(sidebar, 'previousInitPosted: boolean;', 'captured pre-rescue initPosted state');
assertContains(sidebar, 'const previousInitPosted = this.initPosted;', 'initPosted capture before rescue override');
assertContains(sidebar, 'this.initPosted = pending.previousInitPosted;', 'initPosted restoration on failure');
assertContains(sidebar, 'initPostedRestored=${String(pending.previousInitPosted)}', 'initPosted restoration marker');

const sendInitStart = sidebar.indexOf('private async sendInit(');
const sendInitEnd = sidebar.indexOf('private async saveClipboardImage', sendInitStart);
const sendInit = sidebar.slice(sendInitStart, sendInitEnd);
const freshStart = sendInit.indexOf('if (options.hardRescue?.activeTurn.fresh)');
const freshEnd = sendInit.indexOf('let snapshotLoaded', freshStart);
const freshHydration = sendInit.slice(freshStart, freshEnd);
if (freshStart < 0 || freshEnd < 0) throw new Error('Missing isolated fresh hard-rescue hydration block');
if (freshHydration.includes("type: 'sessionData'")) throw new Error('Fresh hard-rescue hydration must not post sessionData');
assertOrder(freshHydration, 'postLiveTurnHistoryForSendInitGuardDefer', 'postLiveTurnResumeForSendInitGuardDefer', 'fresh live history precedes live resume');
assertOrder(sendInit, 'metadataOnly: true', 'if (options.hardRescue?.activeTurn.fresh)', 'metadata-only init precedes fresh live hydration');

const readyHandlerStart = sidebar.indexOf('case "webviewReady"');
const readyHandlerEnd = sidebar.indexOf('case "webviewLivenessAck"', readyHandlerStart);
const readyHandler = sidebar.slice(readyHandlerStart, readyHandlerEnd);
assertContains(readyHandler, 'await this.sendInit(liveWebview);', 'normal handshake uses unguarded sendInit');
assertContains(readyHandler, 'hardRescue: { sessionId: pending.sessionId, activeTurn: pending.activeTurn }', 'hard rescue uses guarded sendInit options');
const workspaceStart = sidebar.indexOf('private async switchWorkspaceRoot');
const workspaceEnd = sidebar.indexOf('private async resolvePendingUserUpgrade', workspaceStart);
const workspaceBlock = sidebar.slice(workspaceStart, workspaceEnd);
assertContains(workspaceBlock, 'await this.sendInit(liveWebview);', 'workspace refresh retains normal sendInit behavior');
if (workspaceBlock.includes('isStillCurrent:')) throw new Error('Workspace sendInit must not use the hard-rescue generation Proxy');

assertContains(sidebar, '<meta name="opencode-hard-rescue-generation"', 'escaped generation meta');
assertContains(main, "document.querySelector('meta[name=\"opencode-hard-rescue-generation\"]')", 'generation meta read');
assertContains(main, 'hardRescueGenerationToken', 'generation token in webviewReady');
assertContains(main, "vscode.postMessage({ type: 'webviewReady', webviewInstanceId, hardRescueGenerationToken });", 'tokenized ready handshake');

const listenerMatches = main.match(/window\.addEventListener\('message'/g) || [];
if (listenerMatches.length !== 1) throw new Error(`Expected one window message listener, found ${listenerMatches.length}`);
const hardAssignmentMatches = sidebar.match(/liveWebview\.html = this\._getHtmlForWebview\(liveWebview, generationToken\);/g) || [];
if (hardAssignmentMatches.length !== 1) throw new Error(`Expected one hard-rescue HTML assignment, found ${hardAssignmentMatches.length}`);

console.log('Wave1d hard-rescue contract: PASS');
