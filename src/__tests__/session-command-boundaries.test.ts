import * as fs from 'fs';
import * as path from 'path';

const controllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const utilityControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'UtilityCommandController.ts'),
    'utf8',
);

function extractRange(startMarker: string, endMarker: string): string {
    const start = controllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = controllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return controllerSource.slice(start, end);
}

function expectOrder(source: string, markers: string[]): void {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker);
        expect(index).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('session command family characterization', () => {
    test('keeps all session commands in the single top-level dispatcher', () => {
        for (const command of [
            'refreshSessions',
            'deleteSession',
            'selectSession',
            'newSession',
            'snapshotTimelineIds',
        ]) {
            expect(controllerSource).toContain(`case "${command}"`);
            expect(utilityControllerSource).not.toContain(`case '${command}'`);
        }
        expect(controllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
    });

    test('refreshes the session list through the resolving Webview instance', () => {
        const block = extractRange('case "refreshSessions"', 'case "registerTmpKey"');
        expect(block).toContain("await host.refreshSessions(webviewView.webview, data.requestId || '')");
        expect(block).not.toContain('host.currentSessionId');
    });

    test('captures selection identity and rejects stale hydration posts', () => {
        const block = extractRange('case "selectSession"', 'case "newSession"');
        expectOrder(block, [
            'const targetSessionId = data.sessionId',
            "host.resetWebviewLiveness('session-switch')",
            'const selectionEpoch = ++host.sessionSelectionEpoch',
            'host.resetUiState(targetSessionId)',
            'host.currentSessionId = targetSessionId',
            'host.client.setSessionId(host.currentSessionId)',
            'const isCurrentSelection = () =>',
            'const postSessionData =',
        ]);
        expect(block).toContain('host.currentSessionId === targetSessionId');
        expect(block).toContain('host.sessionSelectionEpoch === selectionEpoch');
        expect(block).toContain('[EXT][SESSION_LOAD_STALE]');
        expect(block).toContain('if (!isCurrentSelection())');
        expect(block).toContain("phase: 'snapshot' | 'recent' | 'full'");
    });

    test('preserves snapshot-first hydration and recent/full fallback order', () => {
        const block = extractRange('case "selectSession"', 'case "newSession"');
        expectOrder(block, [
            'await host.ensureSessionUndoReady(targetSessionId, activeWebview)',
            'await host.loadPersistedSegment(targetSessionId)',
            'await host.readSnapshot(targetSessionId)',
            "postSessionData(payload, 'snapshot')",
            'await host.client.exportSessionRecent(targetSessionId, host.recentSessionLoadLimit)',
            "postSessionData(sessionPayload, 'recent')",
            'if (sessionDataSent || !isCurrentSelection())',
            'await host.client.exportSession(targetSessionId)',
            "postSessionData(sessionPayload, 'full')",
        ]);
        expect(block).toContain("source: 'snapshot'");
        expect(block).toContain("hydrationCoverage: 'deltaContinuityUnknown'");
        expect(block).toContain('buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)');
        expect(block).toContain("throw new Error('snapshot-boundary-unproven')");
        expect(block).toContain('host.buildFullExportSnapshotDelta(');
        expect(block).toContain('await host.persistStructurallyRepairedSnapshot(');
        expect(block).not.toContain('mergeSessionMessagesById(');
    });

    test('reapplies cached append metadata to every hydration message set', () => {
        const block = extractRange('case "selectSession"', 'case "newSession"');
        expect(block).toContain('host.applyAppendSnapshotMeta(targetSessionId, messagesById)');
        expect(block).toContain('const snapshotMessages = restoreCachedAppendMetadata(snapshotFormatted.messages)');
        expect(block).toContain('const mergedMessages = restoreCachedAppendMetadata(mergedMessagesRaw)');
        expect(block).toContain('const fullMessages = restoreCachedAppendMetadata(formatted.messages)');
        expect(block).toContain('timelineMessageIds: snapshotTimelineIds');
        expect(block).toContain('timelineMessageIds: [...snapshotIds, ...newIds]');
        expect(block).toContain('timelineMessageIds: fullDelta.timelineMessageIds');
    });

    test('keeps delete protocol idempotent, owner-bound, and ordered', () => {
        const block = extractRange('case "deleteSession"', 'case "selectSession"');
        expect(block).not.toContain('data.sessionId || host.currentSessionId');
        expect(block).toContain("const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''");
        expect(block).toContain("liveWebview.postMessage({ type: 'sessionDeleteStarted', sessionId, opId })");
        expect(block).toMatch(/\\b404\\b[\s\S]*NotFoundError[\s\S]*deletedOnServer = true/);
        expectOrder(block, [
            'await host.client.deleteSession(sessionId)',
            'await host.cleanupDeletedSessionArtifacts(sessionId)',
            'await host.clearRecentSessionIfMatches(sessionId)',
            'if (host.currentSessionId === sessionId)',
            'host.resetUiState()',
            'host.currentSessionId = undefined',
            'host.client.setSessionId(undefined)',
            'await host.refreshSessions(liveWebview',
            "liveWebview.postMessage({ type: 'sessionDeleted', sessionId, opId })",
        ]);
        expect(block).toContain("type: 'sessionDeleteFailed'");
        expect(block).toContain('reason: String(error)');
    });

    test('new session clears the selected owner before publishing an empty session', () => {
        const block = extractRange('case "newSession"', 'case "undoToMessage"');
        expectOrder(block, [
            'await host.clearPersistedSegment(host.currentSessionId)',
            'host.resetSessionState()',
            'host.currentSessionId = undefined',
            'host.client.setSessionId(host.currentSessionId)',
            'await host._context.globalState.update(`recentSession.${workspaceKey}`, undefined)',
            "activeWebview.postMessage({ type: 'newSession', sessionId: host.currentSessionId })",
        ]);
        expect(block).toContain('if (host.gitUndoEnabled)');
        expect(block).toContain('await host.client.ensureBaselineForTurn(host.pendingBaselineTurnKey)');
        expect(block).toContain("type: 'baselineStatus'");
    });

    test('forwards snapshot timeline receipts without changing selection state', () => {
        const block = extractRange('case "snapshotTimelineIds"', 'case "ui-debug"');
        expect(block).toContain('await host.handleSnapshotTimelineIds(data.payload)');
        expect(block).not.toContain('currentSessionId');
        expect(block).not.toContain('sessionSelectionEpoch');
    });
});
