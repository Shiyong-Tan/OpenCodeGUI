import * as fs from 'fs';
import * as path from 'path';

const topControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const sessionControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'SessionCommandController.ts'),
    'utf8',
);
const utilityControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'UtilityCommandController.ts'),
    'utf8',
);
const turnControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'TurnCommandController.ts'),
    'utf8',
);
const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
    'utf8',
);

function extractRange(startMarker: string, endMarker: string): string {
    const start = turnControllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = turnControllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return turnControllerSource.slice(start, end);
}

function expectOrder(source: string, markers: string[]): void {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker);
        expect(index).toBeGreaterThan(previous);
        previous = index;
    }
}

function extractProviderMethod(marker: string): string {
    const start = providerSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = providerSource.indexOf('{', start);
    expect(bodyStart).toBeGreaterThan(start);
    let depth = 0;
    for (let index = bodyStart; index < providerSource.length; index += 1) {
        if (providerSource[index] === '{') depth += 1;
        if (providerSource[index] === '}' && --depth === 0) {
            return providerSource.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed provider method: ${marker}`);
}

describe('turn command family characterization', () => {
    test('extracts every turn command behind the single top-level dispatcher', () => {
        for (const command of [
            'sendMessage',
            'appendMessage',
            'appendSnapshotMeta',
            'registerTmpKey',
            'registerPendingUserLocal',
            'cancel',
        ]) {
            expect(turnControllerSource).toContain(`case "${command}"`);
            expect(topControllerSource).not.toContain(`case "${command}"`);
            expect(sessionControllerSource).not.toContain(`case '${command}'`);
            expect(utilityControllerSource).not.toContain(`case '${command}'`);
        }
        expect(topControllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
        expect(topControllerSource).toContain(
            'const turnHandling = turnCommandHandler(data, activeWebview, webviewView.webview)'
        );
        expect(topControllerSource).toContain('turnHandling !== false && await turnHandling');
        expect(turnControllerSource).toContain('if (!TURN_COMMANDS.has(data?.type))');
        expect(turnControllerSource).toContain('return false;');
        expect(providerSource).toContain(
            'this.turnCommandHandler = createTurnCommandHandler({'
        );
        expect(providerSource).not.toContain('createTurnCommandHandler(this)');
    });

    test('captures the explicit send owner before asynchronous work and never reroutes it', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const currentSessionIdAtSend = host.getCurrentSessionId()',
            'if (!payloadSessionId && !host.getCurrentSessionId())',
            'const targetSessionId = payloadSessionId || host.getCurrentSessionId()',
            'host.isTurnCommandInFlight(targetSessionId)',
            '} = host.getTurnSelection()',
            'let activeSendSessionId: string | undefined = targetSessionId',
            'host.startTurnCommandState(',
            'await host.client.chat(',
        ]);
        expect(block).toContain('sessionId: targetSessionId');
        expect(block).toContain('host.client.waitForSessionIdleGate(targetSessionId');
        expect(block).toContain('host.client.finishTurn(targetSessionId)');
        expect(block).not.toContain('host.currentSessionId');
    });

    test('creates a session only when neither payload nor current selection owns the send', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        const createStart = block.indexOf('if (!payloadSessionId && !host.getCurrentSessionId())');
        const createEnd = block.indexOf("if (data.value.toLowerCase() === 'ping')", createStart);
        expect(createStart).toBeGreaterThanOrEqual(0);
        expect(createEnd).toBeGreaterThan(createStart);
        const createBlock = block.slice(createStart, createEnd);
        expect(createBlock).toContain('await host.createTurnSession()');
        expect(createBlock).toContain("type: 'sessionId'");
        expect(block.indexOf('if (payloadSessionId)')).toBeGreaterThan(createEnd);
        expect(block).toContain('host.trackUserOwnedSession(payloadSessionId)');

        const createSession = extractProviderMethod('private async createTurnSession(');
        expectOrder(createSession, [
            'await this.client.createSession()',
            'this.currentSessionId = sessionInfo.id',
            'this.trackUserOwnedSession(sessionInfo.id)',
            'this.client.setSessionId(sessionInfo.id)',
            'await this._context.globalState.update(',
            'return sessionInfo.id',
        ]);
    });

    test('binds local, temporary, and assistant identities before publishing turn messages', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        expectOrder(block, [
            'const clientMessageId = data.clientMessageId',
            'const tmpAssistantKey =',
            'host.startTurnCommandState(',
            'host.client.registerMessage(clientMessageId, targetSessionId)',
            "host.client.createInternalMessageId('assistant', targetSessionId)",
            'host.bindTurnAssistantMessage(targetSessionId, assistantMessageId)',
            "type: 'messageAppend'",
            "type: 'assistantMessageMeta'",
        ]);

        const startState = extractProviderMethod('private startTurnCommandState(');
        expectOrder(startState, [
            'this.rawUserTextByLocalKey.set(clientMessageId, userText)',
            'this.sendInFlightBySession.add(sessionId)',
            "this.markWebviewActiveTurnUpdated(sessionId, 'send:start')",
            'this.pendingLocalKeyBySession.set(sessionId, clientMessageId)',
            'this.pendingAssistantTmpKeyBySession.delete(sessionId)',
            'this.client.startTurnWithOp(sessionId, clientMessageId, operationId)',
            "this.assistantTextBufferBySession.set(sessionId, '')",
            'this.pendingAssistantTmpKeyBySession.set(sessionId, temporaryAssistantKey)',
            'this.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, temporaryAssistantKey)',
            'this.client.setPendingAssistantTmpKey(sessionId, temporaryAssistantKey)',
        ]);
        const bindAssistant = extractProviderMethod('private bindTurnAssistantMessage(');
        expectOrder(bindAssistant, [
            'this.pendingAssistantMessageIdBySession.set(sessionId, assistantMessageId)',
            "this.markWebviewActiveTurnUpdated(sessionId, 'send:assistant-message-bound')",
        ]);
    });

    test('preserves successful finalization and owner-scoped cleanup order', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        expectOrder(block, [
            'await host.client.waitForSessionIdleGate(targetSessionId',
            "type: 'chatDone'",
            "host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'stream_done')",
            'await host.commitPendingTurnChangesFromAuthoritativeFiles(preCommitIdentity)',
            "host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'commit_done')",
            'await host.resolvePendingUserUpgrade(targetSessionId, liveWebview)',
            "host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'upgrade_done')",
            'await host.emitDiffFileListWithRetry(finalizeIdentity, liveWebview)',
            'await host.writeFinalizeSnapshotFromCurrentTurn(finalizeIdentity)',
            'host.client.finishTurn(targetSessionId)',
            "host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'finalize_done')",
            'finally {',
            'host.finishTurnCommandState(activeSendSessionId)',
            "host.syncTurnInFlightAfterFinalize(activeSendSessionId, liveWebview, 'sendMessage.finally')",
        ]);

        const finishState = extractProviderMethod('private finishTurnCommandState(');
        expectOrder(finishState, [
            'this.pendingLocalKeyBySession.get(sessionId)',
            'this.rawUserTextByLocalKey.delete(pendingLocalKey)',
            'this.sendInFlightBySession.delete(sessionId)',
            'this.pendingLocalKeyBySession.delete(sessionId)',
            'this.pendingAssistantTmpKeyBySession.delete(sessionId)',
        ]);
    });

    test('routes append by payload owner and serializes append submission', () => {
        const block = extractRange('case "appendMessage"', 'case "appendSnapshotMeta"');
        expectOrder(block, [
            "const sessionId = typeof data.sessionId === 'string'",
            'const requestedRootUserMsgId =',
            'host.isTurnCommandInFlight(sessionId)',
            'host.client.canAppendToCurrentTurn(sessionId, requestedRootUserMsgId)',
            'host.isAppendSubmissionInFlight(sessionId)',
            'host.client.beginAppendPrompt(sessionId, clientMessageId, value, requestedRootUserMsgId)',
            'host.markAppendSubmissionStarted(sessionId)',
            'await host.client.appendPrompt(sessionId, value',
            "status: 'queued'",
            'catch (error) {',
            'host.client.failAppendPrompt(sessionId, clientMessageId)',
            'finally {',
            'host.markAppendSubmissionFinished(sessionId)',
        ]);
        const appendCatch = block.slice(block.indexOf('catch (error) {'));
        expect(appendCatch).toContain("status: 'failed'");
        expect(block).not.toContain('host.currentSessionId');
        expect(block).toContain(
            "currentSessionId=${host.getCurrentSessionId() || 'null'}"
        );
    });

    test('validates temporary identity registration and delegates snapshot metadata', () => {
        const snapshotBlock = extractRange('case "appendSnapshotMeta"', 'case "registerTmpKey"');
        expect(snapshotBlock).toContain('host.cacheAppendSnapshotMeta(data)');

        const tmpBlock = extractRange('case "registerTmpKey"', 'case "registerPendingUserLocal"');
        expectOrder(tmpBlock, [
            "typeof data.sessionId !== 'string'",
            "data.tmpKey.startsWith('tmp:')",
            'host.registerTurnTemporaryKey(data.sessionId, data.tmpKey)',
        ]);
        const register = extractProviderMethod('private registerTurnTemporaryKey(');
        expectOrder(register, [
            'this.pendingAssistantTmpKeyBySession.set(sessionId, temporaryAssistantKey)',
            'this.pendingLocalKeyBySession.get(sessionId)',
            'this.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, temporaryAssistantKey)',
            'this.client.setPendingAssistantTmpKey(sessionId, temporaryAssistantKey)',
        ]);

        const localBlock = extractRange('case "registerPendingUserLocal"', 'case "cancel"');
        expect(localBlock).toContain("data.localKey.startsWith('local-')");
        expect(localBlock).toContain('host.isTurnCommandInFlight(data.sessionId)');
    });

    test('captures cancel ownership once and cleans only that owner before chatDone', () => {
        const block = extractRange('case "cancel"', 'default:');
        expectOrder(block, [
            'const cancelOwner = host.captureTurnCancelOwner(data)',
            'const cancelSessionId = cancelOwner.sessionId',
            'await host.promptCancelRollbackDecision(activeWebview, cancelSessionId)',
            'await host.client.revertPendingTurnChangesToCurrentBase(cancelSessionId)',
            'await host.client.abortSession(cancelSessionId)',
            'host.clearTurnRawUserText(pendingLocalKey)',
            'host.client.cancelTurn(cancelSessionId, cancelOpId)',
            'host.clearCanceledTurnCommandState(cancelSessionId)',
            'await host.handleAbortedMessage(cancelSessionId, pendingLocalKey, activeWebview)',
            'host.clearCanceledTurnAssistantState(cancelSessionId)',
            'await host.commitPendingTurnChangesFromAuthoritativeFiles(',
            'host.client.finishTurn(cancelSessionId)',
            "type: 'chatDone'",
            "host.syncTurnInFlightAfterFinalize(cancelSessionId, activeWebview, 'user-cancel')",
        ]);
        expect(block).not.toContain('host.currentSessionId');
    });

    test('routes turn-owned registry mutation through provider domain methods', () => {
        const blocks = [
            extractRange('case "sendMessage"', 'case "appendMessage"'),
            extractRange('case "appendMessage"', 'case "appendSnapshotMeta"'),
            extractRange('case "appendSnapshotMeta"', 'case "cancel"'),
            extractRange('case "cancel"', 'default:'),
        ].join('\n');
        for (const registry of [
            'sendInFlightBySession',
            'pendingLocalKeyBySession',
            'pendingAssistantTmpKeyBySession',
            'pendingAssistantTmpKeyByLocalKey',
            'pendingAssistantMessageIdBySession',
            'assistantTextBufferBySession',
            'pendingSnapshotUserTextBySession',
            'rawUserTextByLocalKey',
            'appendSubmitInFlightBySession',
        ]) {
            expect(blocks).not.toContain(`host.${registry}`);
        }
    });

    test('keeps the family host pre-bound, typed, and free of provider internals', () => {
        const hostStart = turnControllerSource.indexOf('export interface TurnCommandHost');
        const hostEnd = turnControllerSource.indexOf('export type TurnCommandHandler', hostStart);
        expect(hostStart).toBeGreaterThanOrEqual(0);
        expect(hostEnd).toBeGreaterThan(hostStart);
        const hostInterface = turnControllerSource.slice(hostStart, hostEnd);
        expect(hostInterface).not.toContain('[key: string]');
        expect(hostInterface).not.toContain('host: any');
        for (const forbidden of [
            'currentSessionId:',
            '_context',
            '_view',
            'sendInFlightBySession',
            'pendingLocalKeyBySession',
            'pendingAssistantTmpKeyBySession',
            'pendingAssistantMessageIdBySession',
            'assistantTextBufferBySession',
            'undoSegmentsBySession',
            'postFinalWatchDiffFocusedBySession',
        ]) {
            expect(hostInterface).not.toContain(forbidden);
        }
        const compositionStart = providerSource.indexOf(
            'this.turnCommandHandler = createTurnCommandHandler({'
        );
        const compositionEnd = providerSource.indexOf(
            'this.userOwnedSessionsLoaded =',
            compositionStart
        );
        const composition = providerSource.slice(compositionStart, compositionEnd);
        expect(composition).toContain('client: {');
        expect(composition).not.toContain('client: this.client');
        expect(composition).toContain('attachments: {');
    });
});
