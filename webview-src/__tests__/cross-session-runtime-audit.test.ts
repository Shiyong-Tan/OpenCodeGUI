import * as fs from 'fs';
import * as path from 'path';

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  let depth = 0;
  let entered = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      entered = true;
    } else if (source[index] === '}') {
      depth -= 1;
      if (entered && depth === 0) return source.slice(start, index + 1);
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
    expect(upgrade).toContain('replaceKeyEverywhere(currentKey, newKey, payloadSession);');

    const rekey = extractFunction(main, 'function replaceKeyEverywhere(');
    expect(rekey).toContain('messageRekeyController.rekey(session, oldId, newId, sessionId)');
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
    expect(showQuestion).not.toContain('reason=session-mismatch');
    expect(showPermission).toContain('sessionOverlayStore.setPermission(sessionId, {');
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
});
