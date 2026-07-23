import * as fs from 'fs';
import * as path from 'path';

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  let parameterDepth = 0;
  let bodyStart = -1;
  for (let index = source.indexOf('(', start); index < source.length; index += 1) {
    if (source[index] === '(') {
      parameterDepth += 1;
    } else if (source[index] === ')') {
      parameterDepth -= 1;
    } else if (source[index] === '{' && parameterDepth === 0) {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) throw new Error(`missing body for ${signature}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

describe('cross-session runtime repository audit', () => {
  const main = read('media', 'main.js');
  const provider = read('src', 'SidebarProvider.ts');
  const handler = read('src', 'events', 'SidebarChatEventHandler.ts');
  const actorRouter = read('src', 'session-runtime', 'ChatEventActorRouter.ts');
  const lifecycle = read('webview-src', 'session-runtime', 'turn-lifecycle.ts');
  const selection = read('webview-src', 'session-runtime', 'session-selection-controller.ts');

  test('all production chat events enter the per-session actor queue', () => {
    expect(provider.match(/this\.handleChatEvent\(/g) || []).toHaveLength(1);
    expect(provider).toContain('void this.chatEventActorRouter.route(event);');
    expect(actorRouter).toContain("this.options.onDrop?.(event, 'missing-session-owner');");
    const missingOwnerBranch = actorRouter.slice(
      actorRouter.indexOf('if (!ownerSessionId) {'),
      actorRouter.indexOf('const sequence =', actorRouter.indexOf('if (!ownerSessionId) {')),
    );
    expect(missingOwnerBranch).not.toContain('this.options.handle(event)');
  });

  test('asynchronous extension events do not borrow the visible session owner', () => {
    expect(handler).not.toContain('event.sessionId || host.currentSessionId');
    expect(handler).not.toContain('host.client.getTurnAssistantMsgId(host.currentSessionId)');
    expect(handler).toContain('host.client.getTurnAssistantMsgId(sessionId)');
  });

  test('assistant identity binding is session-owned and index independent', () => {
    const upgrade = extractFunction(main, 'function attemptAssistantUpgrade(');
    expect(upgrade).not.toContain('messageIndexMap');
    expect(upgrade).not.toContain('lastAssistantUpgradeFallback');
    expect(upgrade).not.toContain('payloadSession === activeSessionId');
    expect(upgrade).toContain('replaceKeyEverywhere(currentKey, newKey, payloadSession, {');
    expect(upgrade).toContain(
      "allowCanonicalHandoff: candidateDecision.source === 'final-canonical-handoff'",
    );
    expect(upgrade).toContain("allowCanonicalHandoff: source === 'chatDone'");

    const rekey = extractFunction(main, 'function replaceKeyEverywhere(');
    expect(rekey).toContain(
      'messageRekeyController.rekey(session, oldId, newId, sessionId, options)',
    );
    expect(rekey).not.toContain('session.messagesById.delete');
    expect(rekey).not.toContain('session.timeline =');
    expect(main).not.toContain('session.messagesById.set(');
  });

  test('turn compatibility fields have one production writer', () => {
    expect(main).not.toMatch(/session\.(backendTurnInFlight|turnFullyFinalized|finalAssistantLock)\s*=(?!=)/);
    expect(lifecycle).toContain('session.backendTurnInFlight = state.backendInFlight;');
    expect(lifecycle).toContain("session.turnFullyFinalized = state.phase === 'effects-finalized'");
    expect(lifecycle).toContain('session.finalAssistantLock = state.canonicalAssistantId');
  });

  test('selection renders cached state immediately and only current hydration can commit', () => {
    const select = extractFunction(selection, 'function select(');
    const commit = extractFunction(selection, 'function commitHydration(');
    expect(select).toContain("options.renderSession(sessionId, 'session-selected');");
    expect(select).toContain('options.scrollSessionToBottom(sessionId, true);');
    expect(commit).toContain('if (!isCurrent(token)) return false;');
    expect(commit).toContain("options.renderSession(token.sessionId, 'session-hydrated');");
  });

  test('visible controls and background assistant routing do not use global busy state', () => {
    const compactGate = extractFunction(main, 'function isCompactDisabledForSession(');
    const assistantMetaStart = main.indexOf('function handleAssistantMeta(');
    const assistantChunkStart = main.indexOf('function handleChatChunk(', assistantMetaStart);
    const assistantDoneStart = main.indexOf('function handleChatDone(', assistantChunkStart);
    const assistantMeta = main.slice(assistantMetaStart, assistantChunkStart);
    const assistantChunk = main.slice(assistantChunkStart, assistantDoneStart);
    expect(compactGate).toContain('isSessionBusy(sessionId)');
    expect(compactGate).not.toContain('if (isBusy)');
    expect(assistantMeta).toContain('isSessionBusy(sessionId)');
    expect(assistantChunk).toContain('isSessionBusy(sessionId)');
    expect(main).not.toContain('busy: isBusy, appendHoverActive');
    expect(main).not.toContain("Undo unavailable: ${isBusy ? 'busy'");
    expect(main).not.toContain("segment.state === 'restorable' && !isBusy");
  });

  test('question and permission interactions remain owned by their background session', () => {
    const showQuestion = extractFunction(main, 'function showQuestionOverlay(');
    const showPermission = extractFunction(main, 'function showPermissionOverlay(');
    const activateOverlays = extractFunction(main, 'function activateSessionOverlays(');
    const sessionIdHandler = extractFunction(main, 'function handleSessionIdMessage(');

    expect(showQuestion).toContain('sessionOverlayStore.enqueueQuestion(sessionId, state)');
    expect(showQuestion).toContain("const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''");
    expect(showQuestion).not.toContain('payload.sessionId || activeSessionId');
    expect(showQuestion).not.toContain('reason=session-mismatch');
    expect(showPermission).toContain('sessionOverlayStore.setPermission(sessionId, {');
    expect(showPermission).toContain("const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''");
    expect(showPermission).not.toContain('payload.sessionId || activeSessionId');
    expect(showPermission).not.toContain('payload.sessionId !== activeSessionId');
    expect(activateOverlays).toContain('renderQuestionOverlayModal();');
    expect(activateOverlays).toContain('renderPermissionOverlayModal();');
    expect(sessionIdHandler).toContain('activateSessionOverlays(sessionId);');
    expect(sessionIdHandler).not.toContain("clearQuestionOverlay('session-change')");
    expect(sessionIdHandler).not.toContain("clearPermissionOverlay('session-change')");
  });

  test('conflict cards are stored and cleared by explicit session identity', () => {
    const conflictCaseStart = main.indexOf("case 'conflictCard':");
    const conflictCaseEnd = main.indexOf("case 'newSession':", conflictCaseStart);
    const conflictCase = main.slice(conflictCaseStart, conflictCaseEnd);
    const clearConflict = extractFunction(main, 'function clearOwnedConflictPayload(');

    expect(main).not.toContain('lastConflictPayload');
    expect(conflictCase).toContain("const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';");
    expect(conflictCase).toContain('sessionConflictStore.set(sessionId, message);');
    expect(conflictCase).toContain('if (sessionId === activeSessionId)');
    expect(clearConflict).toContain('sessionConflictStore.clear(sessionId, identity || undefined)');
    const openDiff = extractFunction(main, 'function postOpenGitDiff(');
    expect(openDiff).toContain("const ownerSessionId = typeof sessionId === 'string' ? sessionId : ''");
    expect(openDiff).not.toContain('activeSessionId');
  });

  test('background notices and stall prompts survive selection changes', () => {
    const activateStatus = extractFunction(main, 'function activateSessionTransientStatus(');
    const showStall = extractFunction(main, 'function showStallCard(');
    const sessionIdHandler = extractFunction(main, 'function handleSessionIdMessage(');
    const stallCaseStart = main.indexOf("case 'stallCard':");
    const stallCaseEnd = main.indexOf("case 'messageIndexMapDelta':", stallCaseStart);
    const stallCase = main.slice(stallCaseStart, stallCaseEnd);

    expect(activateStatus).toContain('sessionTransientStatusStore.get(sessionId)');
    expect(showStall).toContain('sessionTransientStatusStore.setStall(sessionId, payload)');
    expect(showStall).toContain('if (sessionId !== activeSessionId) return;');
    expect(stallCase).not.toContain('sessionId !== activeSessionId');
    expect(sessionIdHandler).toContain('activateSessionTransientStatus(sessionId);');
  });

  test('search state and asynchronous smart results remain session-owned', () => {
    const activateSearch = extractFunction(main, 'function activateSessionSearch(');
    const sessionIdHandler = extractFunction(main, 'function handleSessionIdMessage(');
    const smartResultStart = main.indexOf("case 'smartSessionSearchResult':");
    const smartResultEnd = main.indexOf("case 'smartSessionSearchError':", smartResultStart);
    const smartResult = main.slice(smartResultStart, smartResultEnd);

    expect(activateSearch).toContain('getSessionSearchState(sessionId, true)');
    expect(sessionIdHandler).toContain('activateSessionSearch(sessionId);');
    expect(smartResult).toContain("const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';");
    expect(smartResult).toContain('getSessionSearchState(sessionId, false)');
    expect(smartResult).toContain('if (sessionId === activeSessionId)');
    expect(smartResult).not.toContain('sessionSearch.acceptSmartSearchResponse');
  });

  test('composer drafts are captured on selection and restored only to their owner', () => {
    const transition = extractFunction(main, 'function transitionActiveSessionPresentationOwner(');
    const captureComposer = extractFunction(main, 'function captureSessionComposerState(');
    const restoreDraftStart = main.indexOf("case 'restoreDraft':");
    const restoreDraftEnd = main.indexOf("case 'userMessageUpgrade':", restoreDraftStart);
    const restoreDraft = main.slice(restoreDraftStart, restoreDraftEnd);

    expect(transition).toContain('captureSessionComposerState(previousSessionId);');
    expect(captureComposer).toContain('sessionComposerStore.capture(sessionId, {');
    expect(restoreDraft).toContain("const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';");
    expect(restoreDraft).toContain('sessionComposerStore.restoreDraft(sessionId, restoredText, restoredAttachments);');
    expect(restoreDraft).toContain('if (sessionId !== activeSessionId)');
    expect(restoreDraft).toContain("clearBusyForSession(sessionId, 'restoreDraft')");
    expect(restoreDraft).not.toContain('setBusy(false)');
  });

  test('asynchronous attachments and prefill context update only their composer owner', () => {
    const attachmentStart = main.indexOf("case 'attachmentAdded':");
    const attachmentEnd = main.indexOf("case 'attachmentError':", attachmentStart);
    const attachmentCase = main.slice(attachmentStart, attachmentEnd);
    const prefillStart = main.indexOf("case 'prefillInput':");
    const prefillEnd = main.indexOf("case 'workspaceFileResults':", prefillStart);
    const prefillCase = main.slice(prefillStart, prefillEnd);

    expect(attachmentCase).toContain("const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';");
    expect(attachmentCase).toContain('sessionComposerStore.addAttachment(sessionId, attachment)');
    expect(attachmentCase).toContain('if (sessionId === activeSessionId)');
    expect(prefillCase).toContain('sessionComposerStore.addContext(sessionId, contextItem)');
    expect(prefillCase).toContain('if (sessionId === activeSessionId)');

    const outputSelectionStart = provider.indexOf('public async sendOutputSelectionToChat()');
    const outputSelectionEnd = provider.indexOf('private sendPrefillInput(', outputSelectionStart);
    const outputSelection = provider.slice(outputSelectionStart, outputSelectionEnd);
    expect(outputSelection.indexOf('const sessionId = this.currentSessionId;')).toBeLessThan(
      outputSelection.indexOf('await vscode.commands.executeCommand'),
    );
    expect(outputSelection).toContain("this.sendPrefillInput(sessionId, 'vscode output'");
  });

  test('undo file semantics and segment history are stored per session', () => {
    const client = read('src', 'OpenCodeClient.ts');
    const webviewController = read('src', 'webview', 'SidebarWebviewController.ts');

    expect(client).toContain('private readonly revertedSegmentBySession = new Map<string, RevertedSegment>();');
    expect(client).not.toContain('private revertedSegment?: RevertedSegment;');
    expect(client).not.toMatch(/getRevertedSegment\(\)/);
    expect(client).not.toMatch(/discardRevertedSegment\(\)/);
    expect(client).toContain('options: { sessionId: string; force?: boolean;');
    expect(client).toContain("throw new Error('Missing session ID for undo.')");
    expect(client).not.toContain('const sessionId = explicitSessionId || this.currentSessionId;');
    expect(provider).toContain('private readonly revertedSegmentHistoryStore = new RevertedSegmentHistoryStore();');
    expect(provider).not.toContain('private revertedSegmentHistory:');
    expect(webviewController).not.toMatch(/client\.getRevertedSegment\(\)/);
    expect(webviewController).not.toMatch(/client\.discardRevertedSegment\(\)/);
  });

  test('optimistic user identity has no cross-session singleton fallback', () => {
    expect(provider).not.toContain('pendingClientMessageId');
    expect(handler).not.toContain('pendingClientMessageId');
    expect(read('src', 'webview', 'SidebarWebviewController.ts')).not.toContain('pendingClientMessageId');
    expect(provider).toContain('private pendingLocalKeyBySession = new Map<string, string>();');
  });

  test('aborted-message cleanup retains its captured session owner', () => {
    const controller = read('src', 'webview', 'SidebarWebviewController.ts');
    const cleanup = extractFunction(provider, 'private async handleAbortedMessage(');

    expect(cleanup).toContain('handleAbortedMessage(sessionId: string, messageId: string');
    expect(cleanup).toContain('this.pendingAssistantTmpKeyBySession.get(sessionId)');
    expect(cleanup).toContain("webview.postMessage({ type: 'removeMessage', messageId, sessionId })");
    expect(cleanup).not.toContain('this.currentSessionId');
    expect(handler).toContain('host.handleAbortedMessage(sessionId, pendingLocalKey, liveWebview)');
    expect(controller).not.toMatch(/handleAbortedMessage\([^,\n]+,\s*(?:liveWebview|activeWebview)\)/);
  });

  test('synthetic assistant responses never borrow the selected session', () => {
    const controller = read('src', 'webview', 'SidebarWebviewController.ts');
    const initializer = read('src', 'history', 'SidebarSessionInitializer.ts');
    const postResponseStart = provider.indexOf('private postAddResponse(');
    const postResponse = provider.slice(
      postResponseStart,
      provider.indexOf('private postMessageIndexMap(', postResponseStart),
    );

    expect(postResponseStart).toBeGreaterThanOrEqual(0);
    expect(postResponse).toContain('meta: { sessionId: string; operationId?: string }');
    expect(postResponse).toContain('const targetSessionId = meta.sessionId.trim();');
    expect(postResponse).not.toContain('this.currentSessionId');
    for (const source of [controller, initializer]) {
      for (const call of source.match(/host\.postAddResponse\([^\n]+/g) || []) {
        expect(call).toContain('sessionId');
      }
    }
  });

  test('owned Webview commands do not fall back to Extension selection', () => {
    const client = read('src', 'OpenCodeClient.ts');
    const controller = read('src', 'webview', 'SidebarWebviewController.ts');
    for (const command of [
      'compactSession',
      'undoSegmentUpsert',
      'undoSegmentRemove',
      'undoSegmentDelete',
      'openGitDiff',
      'toolResult',
      'permissionResult',
      'clipboardImage',
      'selectAttachments',
    ]) {
      const start = controller.indexOf(`case "${command}":`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = controller.indexOf('\n                case "', start + 10);
      const block = controller.slice(start, end > start ? end : undefined);
      expect(block).not.toContain(': host.currentSessionId');
      expect(block).not.toContain('|| host.currentSessionId');
    }
    expect(client).toContain('options: { model?: string; variant?: string; sessionId: string;');
    expect(client).toContain("const sessionId = options.sessionId.trim();");
    expect(client).toContain("const sessionId = payload.sessionId.trim();");
    expect(client).not.toContain('const sessionId = payload.sessionId || this.currentSessionId;');
  });

  test('sending to an owned session does not mutate session selection', () => {
    const controller = read('src', 'webview', 'SidebarWebviewController.ts');
    const sendStart = controller.indexOf('case "sendMessage":');
    const sendEnd = controller.indexOf('case "appendSnapshotMeta":', sendStart);
    const send = controller.slice(sendStart, sendEnd);

    expect(send).toContain('host.trackUserOwnedSession(payloadSessionId);');
    expect(send).not.toContain('host.currentSessionId = payloadSessionId');
    expect(send).not.toContain('host.client.setSessionId(payloadSessionId)');
  });

  test('transport session events never promote themselves to UI selection', () => {
    const sessionEventStart = handler.indexOf("if (event.type === 'session' && event.sessionId) {");
    const sessionEventEnd = handler.indexOf("if (event.type === 'message'", sessionEventStart);
    const sessionEvent = handler.slice(sessionEventStart, sessionEventEnd);

    expect(sessionEventStart).toBeGreaterThanOrEqual(0);
    expect(sessionEvent).not.toContain('host.currentSessionId =');
    expect(sessionEvent).not.toContain('host.client.setSessionId(');
    expect(sessionEvent).not.toContain("type: 'sessionId'");
  });

  test('owned liveness and overlay responses do not borrow visible session', () => {
    expect(main).not.toContain('message.sessionId || activeSessionId');
    const livenessStart = main.indexOf("case 'webviewLivenessPing':");
    const livenessEnd = main.indexOf("case 'liveTurnResume':", livenessStart);
    expect(main.slice(livenessStart, livenessEnd)).toContain(
      "const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';",
    );
  });
});
