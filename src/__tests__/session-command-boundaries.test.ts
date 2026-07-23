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
const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
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
            'const selectionEpoch = host.startSessionSelection(targetSessionId)',
            'host.adoptSessionSelection(targetSessionId)',
            'const isCurrentSelection = () =>',
            'host.isSessionSelectionCurrent(targetSessionId, selectionEpoch)',
            'const postSessionData =',
        ]);
        expect(block).toContain('[EXT][SESSION_LOAD_STALE]');
        expect(block).toContain('if (!isCurrentSelection())');
        expect(block).toContain("phase: 'snapshot' | 'recent' | 'full'");

        const start = extractProviderMethod('private startSessionSelection(');
        expectOrder(start, [
            "this.resetWebviewLiveness('session-switch')",
            'return ++this.sessionSelectionEpoch',
        ]);
        const adopt = extractProviderMethod('private adoptSessionSelection(');
        expectOrder(adopt, [
            'this.resetUiState(targetSessionId)',
            'this.currentSessionId = targetSessionId',
            'this.trackUserOwnedSession(targetSessionId)',
            'this.client.setSessionId(targetSessionId)',
        ]);
        const guard = extractProviderMethod('private isSessionSelectionCurrent(');
        expect(guard).toContain('this.currentSessionId === targetSessionId');
        expect(guard).toContain('this.sessionSelectionEpoch === selectionEpoch');
    });

    test('preserves snapshot-first hydration and recent/full fallback order', () => {
        const block = extractRange('case "selectSession"', 'case "newSession"');
        expectOrder(block, [
            'await host.persistRecentSessionSelection(targetSessionId)',
            'await host.hydrateSessionUndoPresentation(',
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

        const undoHydration = extractProviderMethod('private async hydrateSessionUndoPresentation(');
        expectOrder(undoHydration, [
            'await this.ensureSessionUndoReady(sessionId, webview)',
            'await this.loadPersistedSegment(sessionId)',
            'this.revertedSegmentHistoryStore.',
            'this.client.setRevertedSegment(sessionId,',
            'const segmentMap = this.undoSegmentsBySession.get(sessionId)',
            'this.syncClientRevertedSegmentFromUndoSegments(sessionId)',
        ]);
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
            'host.clearSelectedSessionAfterDelete(sessionId)',
            'await host.refreshSessions(liveWebview',
            "liveWebview.postMessage({ type: 'sessionDeleted', sessionId, opId })",
        ]);
        expect(block).toContain("type: 'sessionDeleteFailed'");
        expect(block).toContain('reason: String(error)');

        const clear = extractProviderMethod('private clearSelectedSessionAfterDelete(');
        expectOrder(clear, [
            'if (this.currentSessionId !== sessionId) return',
            'this.resetUiState()',
            'this.currentSessionId = undefined',
            'this.client.setSessionId(undefined)',
        ]);
    });

    test('new session clears the selected owner before publishing an empty session', () => {
        const block = extractRange('case "newSession"', 'case "undoToMessage"');
        expectOrder(block, [
            'const sessionId = await host.prepareNewSession()',
            "activeWebview.postMessage({ type: 'newSession', sessionId })",
            'await host.initializeNewSessionBaseline(activeWebview)',
        ]);

        const prepare = extractProviderMethod('private async prepareNewSession(');
        expectOrder(prepare, [
            'await this.clearPersistedSegment(this.currentSessionId)',
            'this.resetSessionState()',
            'this.currentSessionId = undefined',
            'this.client.setSessionId(undefined)',
            'await this.persistRecentSessionSelection(undefined)',
        ]);
        const baseline = extractProviderMethod('private async initializeNewSessionBaseline(');
        expectOrder(baseline, [
            'if (!this.gitUndoEnabled) return',
            'this.pendingBaselineTurnKey = `baseline-${Date.now()}`',
            'this.pendingBaselineFailed = false',
            "type: 'baselineStatus'",
            'await this.client.ensureBaselineForTurn(this.pendingBaselineTurnKey)',
            'this.baselineReady = baselineResult.ok',
        ]);
    });

    test('routes session-owned mutable state only through provider domain methods', () => {
        const sessionBlocks = [
            extractRange('case "deleteSession"', 'case "selectSession"'),
            extractRange('case "selectSession"', 'case "newSession"'),
            extractRange('case "newSession"', 'case "undoToMessage"'),
        ].join('\n');
        expect(sessionBlocks).not.toMatch(/host\.(currentSessionId|sessionSelectionEpoch)\s*(?:=|\+\+)/);
        expect(sessionBlocks).not.toContain('host.revertedSegmentHistoryStore.');
        expect(sessionBlocks).not.toContain('host.undoSegmentsBySession.');
        expect(sessionBlocks).not.toMatch(/host\.(pendingBaselineTurnKey|pendingBaselineFailed|baselineReady)\s*=/);
        expect(sessionBlocks).not.toContain('host._context.globalState.update(');
    });

    test('forwards snapshot timeline receipts without changing selection state', () => {
        const block = extractRange('case "snapshotTimelineIds"', 'case "ui-debug"');
        expect(block).toContain('await host.handleSnapshotTimelineIds(data.payload)');
        expect(block).not.toContain('currentSessionId');
        expect(block).not.toContain('sessionSelectionEpoch');
    });
});
