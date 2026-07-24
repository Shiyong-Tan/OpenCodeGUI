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

function extractRange(startMarker: string, endMarker: string): string {
    const start = topControllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = topControllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return topControllerSource.slice(start, end);
}

function expectOrder(source: string, markers: string[]): void {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker);
        expect(index).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('turn command family characterization', () => {
    test('keeps every turn command in the single top-level dispatcher before extraction', () => {
        for (const command of [
            'sendMessage',
            'appendMessage',
            'appendSnapshotMeta',
            'registerTmpKey',
            'registerPendingUserLocal',
            'cancel',
        ]) {
            expect(topControllerSource).toContain(`case "${command}"`);
            expect(sessionControllerSource).not.toContain(`case '${command}'`);
            expect(utilityControllerSource).not.toContain(`case '${command}'`);
        }
        expect(topControllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
    });

    test('captures the explicit send owner before asynchronous work and never reroutes it', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const currentSessionIdAtSend = host.currentSessionId',
            'if (!payloadSessionId && !host.currentSessionId)',
            'const targetSessionId = payloadSessionId || host.currentSessionId',
            'host.sendInFlightBySession.has(targetSessionId)',
            'const targetModel = host.selectedModel',
            'let activeSendSessionId: string | undefined = targetSessionId',
            'host.sendInFlightBySession.add(targetSessionId)',
            'host.client.startTurnWithOp(targetSessionId, clientMessageId, opId)',
            'await host.client.chat(',
        ]);
        expect(block).toContain('sessionId: targetSessionId');
        expect(block).toContain('host.client.waitForSessionIdleGate(targetSessionId');
        expect(block).toContain('host.client.finishTurn(targetSessionId)');
        expect(block).not.toContain(
            'const targetSessionId = payloadSessionId || host.currentSessionId;\n' +
            '                    await'
        );
    });

    test('creates a session only when neither payload nor current selection owns the send', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        const createStart = block.indexOf('if (!payloadSessionId && !host.currentSessionId)');
        const createEnd = block.indexOf("if (data.value.toLowerCase() === 'ping')", createStart);
        expect(createStart).toBeGreaterThanOrEqual(0);
        expect(createEnd).toBeGreaterThan(createStart);
        const createBlock = block.slice(createStart, createEnd);
        expect(createBlock).toContain('await host.client.createSession()');
        expect(createBlock).toContain('host.currentSessionId = sessionInfo.id');
        expect(createBlock).toContain("type: 'sessionId'");
        expect(block.indexOf('if (payloadSessionId)')).toBeGreaterThan(createEnd);
        expect(block).toContain('host.trackUserOwnedSession(payloadSessionId)');
    });

    test('binds local, temporary, and assistant identities before publishing turn messages', () => {
        const block = extractRange('case "sendMessage"', 'case "appendMessage"');
        expectOrder(block, [
            'const clientMessageId = data.clientMessageId',
            'const tmpAssistantKey =',
            'host.pendingLocalKeyBySession.set(targetSessionId, clientMessageId)',
            'host.client.startTurnWithOp(targetSessionId, clientMessageId, opId)',
            'host.pendingAssistantTmpKeyBySession.set(targetSessionId, tmpAssistantKey)',
            'host.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, tmpAssistantKey)',
            'host.client.setPendingAssistantTmpKey(targetSessionId, tmpAssistantKey)',
            'host.client.registerMessage(clientMessageId, targetSessionId)',
            "host.client.createInternalMessageId('assistant', targetSessionId)",
            'host.pendingAssistantMessageIdBySession.set(targetSessionId, assistantMessageId)',
            "type: 'messageAppend'",
            "type: 'assistantMessageMeta'",
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
            'await host.writeFinalizeSnapshotFromCanonicalSession(finalizeIdentity)',
            'host.client.finishTurn(targetSessionId)',
            "host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'finalize_done')",
            '} finally {',
            'host.sendInFlightBySession.delete(activeSendSessionId)',
            "host.syncTurnInFlightAfterFinalize(activeSendSessionId, liveWebview, 'sendMessage.finally')",
        ]);
    });

    test('routes append by payload owner and serializes append submission', () => {
        const block = extractRange('case "appendMessage"', 'case "appendSnapshotMeta"');
        expectOrder(block, [
            "const sessionId = typeof data.sessionId === 'string'",
            'const requestedRootUserMsgId =',
            'host.sendInFlightBySession.has(sessionId)',
            'host.client.canAppendToCurrentTurn(sessionId, requestedRootUserMsgId)',
            'host.appendSubmitInFlightBySession.has(sessionId)',
            'host.client.beginAppendPrompt(sessionId, clientMessageId, value, requestedRootUserMsgId)',
            'host.appendSubmitInFlightBySession.add(sessionId)',
            'await host.client.appendPrompt(sessionId, value',
            "status: 'queued'",
            '} catch (error) {',
            'host.client.failAppendPrompt(sessionId, clientMessageId)',
            '} finally {',
            'host.appendSubmitInFlightBySession.delete(sessionId)',
        ]);
        const appendCatch = block.slice(block.indexOf('} catch (error) {'));
        expect(appendCatch).toContain("status: 'failed'");
        expect(block.match(/host\.currentSessionId/g)).toHaveLength(1);
        expect(block).toContain('currentSessionId=${host.currentSessionId || \'null\'}');
        expect(block).not.toContain('sessionId || host.currentSessionId');
    });

    test('validates temporary identity registration and delegates snapshot metadata', () => {
        const snapshotBlock = extractRange('case "appendSnapshotMeta"', 'case "registerTmpKey"');
        expect(snapshotBlock).toContain('host.cacheAppendSnapshotMeta(data)');

        const tmpBlock = extractRange('case "registerTmpKey"', 'case "registerPendingUserLocal"');
        expectOrder(tmpBlock, [
            "typeof data.sessionId !== 'string'",
            "data.tmpKey.startsWith('tmp:')",
            'host.pendingAssistantTmpKeyBySession.set(data.sessionId, data.tmpKey)',
            'host.pendingLocalKeyBySession.get(data.sessionId)',
            'host.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, data.tmpKey)',
            'host.client.setPendingAssistantTmpKey(data.sessionId, data.tmpKey)',
        ]);

        const localBlock = extractRange('case "registerPendingUserLocal"', 'case "undoSegmentUpsert"');
        expect(localBlock).toContain("data.localKey.startsWith('local-')");
        expect(localBlock).toContain('host.sendInFlightBySession.has(data.sessionId)');
    });

    test('captures cancel ownership once and cleans only that owner before chatDone', () => {
        const block = extractRange('case "cancel"', 'case "restoreAll"');
        expectOrder(block, [
            'const cancelOwner = captureCancelTurnOwner(data, host)',
            'const cancelSessionId = cancelOwner.sessionId',
            'await host.promptCancelRollbackDecision(activeWebview, cancelSessionId)',
            'await host.client.revertPendingTurnChangesToCurrentBase(cancelSessionId)',
            'await host.client.abortSession(cancelSessionId)',
            'host.client.cancelTurn(cancelSessionId, cancelOpId)',
            'host.sendInFlightBySession.delete(cancelSessionId)',
            'await host.handleAbortedMessage(cancelSessionId, pendingLocalKey, activeWebview)',
            'host.pendingAssistantMessageIdBySession.delete(cancelSessionId)',
            'host.assistantTextBufferBySession.delete(cancelSessionId)',
            'await host.commitPendingTurnChangesFromAuthoritativeFiles(',
            'host.client.finishTurn(cancelSessionId)',
            "type: 'chatDone'",
            "host.syncTurnInFlightAfterFinalize(cancelSessionId, activeWebview, 'user-cancel')",
        ]);
        expect(block).not.toContain('host.currentSessionId');
    });
});
