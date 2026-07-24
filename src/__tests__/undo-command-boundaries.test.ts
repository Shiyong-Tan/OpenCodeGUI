import * as fs from 'fs';
import * as path from 'path';

const topControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const utilityControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'UtilityCommandController.ts'),
    'utf8',
);
const sessionControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'SessionCommandController.ts'),
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

function extractProviderRange(startMarker: string, endMarker: string): string {
    const start = providerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = providerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return providerSource.slice(start, end);
}

describe('undo command family characterization', () => {
    test('keeps every undo command on exactly one pre-extraction dispatcher path', () => {
        const commands = [
            'undoSegmentUpsert',
            'undoSegmentRemove',
            'undoSegmentDelete',
            'undoToMessage',
            'restoreAll',
            'restoreSegment',
            'conflictDecision',
            'discardSegment',
            'setRevertedSegmentCollapsed',
        ];
        for (const command of commands) {
            expect(topControllerSource.match(new RegExp(`case "${command}"`, 'g'))).toHaveLength(1);
            expect(utilityControllerSource).not.toContain(`case "${command}"`);
            expect(sessionControllerSource).not.toContain(`case "${command}"`);
            expect(turnControllerSource).not.toContain(`case "${command}"`);
        }
        expect(topControllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
    });

    test('persists segment metadata under the explicit owner and preserves the restore lock', () => {
        const block = extractRange('case "undoSegmentUpsert"', 'case "undoSegmentRemove"');
        expectOrder(block, [
            "const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''",
            'const memberMsgIds =',
            'const anchorMsgId =',
            'const previousSegment = host.getUndoSegmentState(sessionId, seg.noticeKey)',
            'const nextRestoreAllowed = previousSegment?.restoreAllowed === false',
            'const segmentState: SegmentState =',
            'await host.setUndoSegmentState(sessionId, seg.noticeKey, segmentState)',
        ]);
        expect(block).toContain("id.startsWith('msg_')");
        expect(block).toContain('previousSegment?.restoreAllowed === false');
        expect(block).not.toContain('host.currentSessionId');
    });

    test('removes segment metadata only from the explicit session and persists deletion once', () => {
        for (const [start, end] of [
            ['case "undoSegmentRemove"', 'case "undoSegmentDelete"'],
            ['case "undoSegmentDelete"', 'case "undoToMessage"'],
        ]) {
            const block = extractRange(start, end);
            expectOrder(block, [
                "const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''",
                "const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : ''",
                'await host.deleteUndoSegmentState(sessionId, noticeKey)',
            ]);
            expect(block).not.toContain('host.currentSessionId');
        }
    });

    test('undo requires an explicit operation, session, and anchor before touching files', () => {
        const block = extractRange('case "undoToMessage"', 'case "restoreAll"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const operationId =',
            'const payloadMessageId =',
            'if (!payloadSessionId || !operationId || !payloadMessageId)',
            'const ownerSessionId = payloadSessionId',
            'const resolvedMessageId = host.resolveUndoMessageId(payloadMessageId)',
            'const result = await host.client.undoFromMessage(resolvedMessageId,',
        ]);
        expect(block).toContain('sessionId: ownerSessionId');
        expect(block).toContain('host.sanitizeUndoRangeMessageIds(data?.visibleMessageIds)');
        expect(block).toContain('host.sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor)');
        expect(block).toContain('host.getInvalidSegmentMessageIds(ownerSessionId');
    });

    test('undo routes conflict or success once while preserving segment, changelist, and diff effects', () => {
        const block = extractRange('case "undoToMessage"', 'case "restoreAll"');
        expectOrder(block, [
            'const result = await host.client.undoFromMessage(',
            'if (!result.applied && result.conflicts.length)',
            'host.setPendingUndoConflict({',
            "type: 'conflictCard'",
            'if (!result.applied && !result.conflicts.length)',
            'host.resolveUndoUiVisibleRange(',
            "type: 'revertedSegment'",
            'await host.resolveChangeListCommits(',
            'await host.persistRevertedSegment(',
            "host.postAddResponse(activeWebview, 'Undo applied.'",
            'host.refreshDiffIfTouched(result.touchedFiles)',
        ]);
        expect(block.match(/await host\.client\.undoFromMessage\(/g)).toHaveLength(1);
        expect(block).toContain('sessionId: ownerSessionId, operationId');
    });

    test('restore all uses the explicit owner and retains file, segment, and changelist ordering', () => {
        const block = extractRange('case "restoreAll"', 'case "restoreSegment"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const operationId =',
            'if (!payloadSessionId || !operationId)',
            'const ownerSessionId = payloadSessionId',
            'await host.resolveChangeListCommits(ownerSessionId',
            'const result = await host.client.restoreAll({ sessionId: ownerSessionId })',
            'if (!result.applied && result.conflicts.length)',
            'host.setPendingUndoConflict({',
            "type: 'conflictCard'",
            "type: 'restoredSegment'",
            'host.client.discardRevertedSegment(ownerSessionId)',
            "type: 'revertedSegmentDiscarded'",
            'await host.clearPersistedSegment(ownerSessionId)',
            'await host.setChangeListReverted(ownerSessionId, commitHash, false',
            "host.postAddResponse(activeWebview, 'Restore applied.'",
            'host.refreshDiffIfTouched(result.touchedFiles)',
        ]);
        expect(block.match(/await host\.client\.restoreAll\(/g)).toHaveLength(1);
    });

    test('segment restore derives its canonical scope before restoring files', () => {
        const block = extractRange('case "restoreSegment"', 'case "conflictDecision"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const operationId =',
            'const anchorMsgId =',
            'const noticeKey =',
            'const ownerSessionId = payloadSessionId',
            'const persistedSegment = noticeKey',
            'host.getUndoSegmentState(ownerSessionId, noticeKey)',
            'const messageIds = Array.isArray(persistedSegment?.memberMsgIds)',
            'const restoreScope = host.buildRestoreMessageScope(',
            'await host.resolveChangeListCommits(ownerSessionId, restoreScope.activeRestoreMessageIds',
            'const result = await host.client.restoreFromMessage(anchorMsgId, endMsgId,',
            'messageIds: restoreScope.activeRestoreMessageIds',
            'excludedMessageIds: restoreScope.invalidMessageIds',
            'if (result.applied)',
            'await host.applyRestoreSegmentSuccess(',
            'if (result.conflicts.length)',
            'host.setPendingUndoConflict({',
        ]);
        expect(block.match(/await host\.client\.restoreFromMessage\(/g)).toHaveLength(1);
        expect(block).toContain('sessionId: ownerSessionId');
    });

    test('conflict decisions validate and consume stored ownership before forced retries', () => {
        const block = extractRange('case "conflictDecision"', 'case "discardSegment"');
        expectOrder(block, [
            'const payloadSessionId =',
            'const operationId =',
            'const conflictId =',
            'const kind =',
            'const pendingConflict = host.getPendingUndoConflict(payloadSessionId)',
            'pendingConflict.operationId !== operationId',
            'const conflictContext = host.takePendingUndoConflict(payloadSessionId)',
            'const ownerSessionId = conflictContext.sessionId',
            "if (decision === 'cancel' || decision === 'skip')",
        ]);
        const undoRetry = block.slice(
            block.indexOf("if (conflictContext.kind === 'undo'"),
            block.indexOf("if (conflictContext.kind === 'restore')"),
        );
        expect(undoRetry).toContain('force: true');
        expect(undoRetry).toContain('sessionId: ownerSessionId');
        expect(undoRetry).toContain('operationId: conflictContext.operationId');

        const restoreRetry = block.slice(
            block.indexOf("if (conflictContext.kind === 'restore')"),
            block.indexOf("if (conflictContext.kind === 'restoreSegment'"),
        );
        expect(restoreRetry).toContain(
            'host.client.restoreAll({ force: true, sessionId: ownerSessionId })'
        );

        const segmentRetry = block.slice(block.indexOf("if (conflictContext.kind === 'restoreSegment'"));
        expectOrder(segmentRetry, [
            'const restoreScope = host.buildRestoreMessageScope(',
            'const result = await host.client.restoreFromMessage(',
            'force: true',
            'messageIds: restoreScope.activeRestoreMessageIds',
            'excludedMessageIds: restoreScope.invalidMessageIds',
            'await host.applyRestoreSegmentSuccess(',
        ]);
        expect(block).toContain('sessionId: ownerSessionId');
        expect(block).toContain('operationId: conflictContext.operationId');
    });

    test('discard and collapse mutate only the explicitly named session', () => {
        const discard = extractRange('case "discardSegment"', 'case "setRevertedSegmentCollapsed"');
        expectOrder(discard, [
            "const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''",
            'host.client.discardRevertedSegment(sessionId)',
            "type: 'revertedSegmentDiscarded'",
            "host.postAddResponse(activeWebview, 'Reverted segment discarded.'",
            'await host.persistRevertedSegment(sessionId, segment, segment.conflicts || [], true)',
        ]);
        expect(discard).not.toContain('host.currentSessionId');

        const collapse = extractRange('case "setRevertedSegmentCollapsed"', 'case "ui-debug"');
        expectOrder(collapse, [
            "const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''",
            'host.client.setRevertedSegmentCollapsed(sessionId, data.collapsed)',
            'const segment = host.client.getRevertedSegment(sessionId)',
            "type: 'revertedSegmentState'",
        ]);
        expect(collapse).not.toContain('host.currentSessionId');
    });

    test('routes undo-owned registry access through provider domain methods', () => {
        const blocks = extractRange('case "undoSegmentUpsert"', 'case "ui-debug"');
        for (const registry of [
            'undoSegmentsBySession',
            'revertedSegmentHistoryStore',
            'pendingConflictStore',
            'clientMessageIdMap',
            'UNDO_SEGMENTS_KEY',
        ]) {
            expect(blocks).not.toContain(`host.${registry}`);
        }

        const setSegment = extractProviderRange(
            'private async setUndoSegmentState(',
            'private async deleteUndoSegmentState('
        );
        expectOrder(setSegment, [
            'let segments = this.undoSegmentsBySession.get(sessionId)',
            'this.undoSegmentsBySession.set(sessionId, segments)',
            'segments.set(noticeKey, segment)',
            'await this.saveUndoSegmentsState()',
        ]);

        const deleteSegment = extractProviderRange(
            'private async deleteUndoSegmentState(',
            'private getRevertedSegmentHistory('
        );
        expectOrder(deleteSegment, [
            'const segments = this.undoSegmentsBySession.get(sessionId)',
            'const deleted = segments?.delete(noticeKey) ?? false',
            'if (deleted)',
            'await this.saveUndoSegmentsState()',
        ]);

        const takeConflict = extractProviderMethod('private takePendingUndoConflict(');
        expect(takeConflict).toContain('return this.pendingConflictStore.take(sessionId)');
        const appendHistory = extractProviderMethod('private appendRevertedSegmentHistory(');
        expect(appendHistory).toContain(
            'this.revertedSegmentHistoryStore.update(sessionId, (entries) => [...entries, entry])'
        );
    });
});
