import * as fs from 'fs';
import * as path from 'path';

jest.mock('vscode', () => ({
    window: { showErrorMessage: jest.fn() },
}), { virtual: true });

import { createSessionCommandHandler } from '../webview/controllers/SessionCommandController';

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
const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
    'utf8',
);

function extractRange(startMarker: string, endMarker: string): string {
    const start = sessionControllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = sessionControllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return sessionControllerSource.slice(start, end);
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

function extractSessionMethod(marker: string): string {
    const start = sessionControllerSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyStart = sessionControllerSource.indexOf('{', start);
    expect(bodyStart).toBeGreaterThan(start);
    let depth = 0;
    for (let index = bodyStart; index < sessionControllerSource.length; index += 1) {
        if (sessionControllerSource[index] === '{') depth += 1;
        if (sessionControllerSource[index] === '}' && --depth === 0) {
            return sessionControllerSource.slice(start, index + 1);
        }
    }
    throw new Error(`Unclosed session method: ${marker}`);
}

describe('session command family characterization', () => {
    test('extracts all session commands behind the single top-level dispatcher', () => {
        for (const command of [
            'refreshSessions',
            'deleteSession',
            'selectSession',
            'forkSession',
            'newSession',
            'snapshotTimelineIds',
        ]) {
            expect(sessionControllerSource).toContain(`case '${command}'`);
            expect(topControllerSource).not.toContain(`case "${command}"`);
            expect(utilityControllerSource).not.toContain(`case '${command}'`);
        }
        expect(topControllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
        expect(topControllerSource).toContain(
            'const sessionHandling = sessionCommandHandler(data, activeWebview, webviewView.webview)'
        );
        expect(topControllerSource).toContain('sessionHandling !== false && await sessionHandling');
        expect(sessionControllerSource).toContain(
            'if (!SESSION_COMMANDS.has(data?.type)) return false'
        );
        expect(providerSource).toContain(
            'this.sessionCommandHandler = createSessionCommandHandler({'
        );
        expect(providerSource).not.toContain('createSessionCommandHandler(this)');
    });

    test('refreshes the session list through the resolving Webview instance', () => {
        const block = extractRange("case 'refreshSessions'", "case 'deleteSession'");
        expect(block).toContain(
            "await this.host.refreshSessions(resolvingWebview, data.requestId || '')"
        );
        expect(block).not.toContain('currentSessionId');
    });

    test('captures selection identity and rejects stale hydration posts', () => {
        const block = extractSessionMethod('private async selectSession(');
        expectOrder(block, [
            'const targetSessionId = data.sessionId',
            'const selectionEpoch = this.host.startSessionSelection(targetSessionId)',
            'this.host.adoptSessionSelection(targetSessionId)',
            'const isCurrentSelection = () =>',
            'this.host.isSessionSelectionCurrent(targetSessionId, selectionEpoch)',
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
        const block = extractSessionMethod('private async selectSession(');
        expectOrder(block, [
            'await this.host.persistRecentSessionSelection(targetSessionId)',
            'await this.host.hydrateSessionUndoPresentation(',
            'await this.host.readSnapshot(targetSessionId)',
            "postSessionData(payload, 'snapshot')",
            'await this.host.exportSessionRecent(',
            "postSessionData(sessionPayload, 'recent')",
            'if (sessionDataSent || !isCurrentSelection())',
            'await this.host.exportSession(targetSessionId)',
            "postSessionData(sessionPayload, 'full')",
        ]);
        expect(block).toContain("source: 'snapshot'");
        expect(block).toContain("hydrationCoverage: 'deltaContinuityUnknown'");
        expect(block).toContain('buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)');
        expect(block).toContain("throw new Error('snapshot-boundary-unproven')");
        expect(block).toContain('this.host.buildFullExportSnapshotDelta(');
        expect(block).toContain('await this.host.persistStructurallyRepairedSnapshot(');
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
        const block = extractSessionMethod('private async selectSession(');
        expect(block).toContain('this.host.applyAppendSnapshotMeta(targetSessionId, messagesById)');
        expect(block).toContain('const snapshotMessages = restoreCachedAppendMetadata(snapshotFormatted.messages)');
        expect(block).toContain('const mergedMessages = restoreCachedAppendMetadata(mergedMessagesRaw)');
        expect(block).toContain('const fullMessages = restoreCachedAppendMetadata(formatted.messages)');
        expect(block).toContain('timelineMessageIds: snapshotTimelineIds');
        expect(block).toContain('timelineMessageIds: [...snapshotIds, ...newIds]');
        expect(block).toContain('timelineMessageIds: fullDelta.timelineMessageIds');
    });

    test('keeps delete protocol idempotent, owner-bound, and ordered', () => {
        const block = extractSessionMethod('private async deleteSession(');
        expect(block).not.toContain('currentSessionId');
        expect(block).toContain("const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''");
        expect(block).toContain("liveWebview.postMessage({ type: 'sessionDeleteStarted', sessionId, opId })");
        expect(block).toMatch(/\\b404\\b[\s\S]*NotFoundError[\s\S]*deletedOnServer = true/);
        expectOrder(block, [
            'await this.host.deleteSession(sessionId)',
            'await this.host.cleanupDeletedSessionArtifacts(sessionId)',
            'await this.host.clearRecentSessionIfMatches(sessionId)',
            'this.host.clearSelectedSessionAfterDelete(sessionId)',
            'await this.host.refreshSessions(liveWebview',
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
        const block = extractSessionMethod('private async newSession(');
        expectOrder(block, [
            'const sessionId = await this.host.prepareNewSession()',
            "activeWebview.postMessage({ type: 'newSession', sessionId })",
            'await this.host.initializeNewSessionBaseline(activeWebview)',
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

    test('fork captures its source and leaves selection to the Webview response', () => {
        const block = extractSessionMethod('private async forkSession(');
        expectOrder(block, [
            "const sourceSessionId = typeof data.sessionId === 'string' ? data.sessionId : ''",
            'this.host.hasActiveTurn(sourceSessionId)',
            'await this.host.forkSession(sourceSessionId)',
            "type: 'sessionForked'",
            'await this.host.refreshSessions(liveWebview',
        ]);
        expect(block).not.toContain('adoptSessionSelection');
        expect(block).not.toContain('prepareNewSession');
        expect(block).not.toContain('readSnapshot');
    });

    test('routes session-owned mutable state only through provider domain methods', () => {
        const sessionBlocks = [
            extractSessionMethod('private async deleteSession('),
            extractSessionMethod('private async forkSession('),
            extractSessionMethod('private async selectSession('),
            extractSessionMethod('private async newSession('),
        ].join('\n');
        for (const forbidden of [
            'currentSessionId',
            'sessionSelectionEpoch',
            'revertedSegmentHistoryStore',
            'undoSegmentsBySession',
            'pendingBaselineTurnKey',
            'pendingBaselineFailed',
            'baselineReady',
            'sendInFlightBySession',
            'webviewLivenessCurrent',
            'pendingConflictStore',
        ]) expect(sessionBlocks).not.toContain(forbidden);
    });

    test('keeps the family host narrow and free of raw provider registries', () => {
        const hostStart = sessionControllerSource.indexOf('export interface SessionCommandHost');
        const hostEnd = sessionControllerSource.indexOf('export type SessionCommandHandler', hostStart);
        expect(hostStart).toBeGreaterThanOrEqual(0);
        expect(hostEnd).toBeGreaterThan(hostStart);
        const hostInterface = sessionControllerSource.slice(hostStart, hostEnd);
        expect(hostInterface).not.toContain('client:');
        for (const forbidden of [
            'currentSessionId',
            'sessionSelectionEpoch',
            'sendInFlightBySession',
            'pendingAssistantTmpKeyBySession',
            'undoSegmentsBySession',
            'revertedSegmentHistoryStore',
            'pendingConflictStore',
            'webviewLivenessCurrent',
            'smartSearch',
            'selectedModel',
        ]) expect(hostInterface).not.toContain(forbidden);
    });

    test('forwards snapshot timeline receipts without changing selection state', () => {
        const block = extractRange("case 'snapshotTimelineIds'", 'default:');
        expect(block).toContain('await this.host.handleSnapshotTimelineIds(data.payload)');
        expect(block).not.toContain('currentSessionId');
        expect(block).not.toContain('sessionSelectionEpoch');
    });
});

function createRuntimeHarness(overrides: Record<string, unknown> = {}) {
    const posts: any[] = [];
    const activeWebview: any = {
        postMessage: jest.fn(async (message: any) => {
            posts.push(message);
            return true;
        }),
    };
    const resolvingWebview: any = { postMessage: jest.fn(async () => true) };
    const host: any = {
        getLiveWebview: jest.fn((fallback: unknown) => fallback),
        log: jest.fn(),
        refreshSessions: jest.fn(async () => undefined),
        forkSession: jest.fn(async () => ({ id: 'session-fork' })),
        hasActiveTurn: jest.fn(() => false),
        getSessionChildren: jest.fn(async () => []),
        deleteSession: jest.fn(async () => true),
        cleanupDeletedSessionArtifacts: jest.fn(async () => undefined),
        clearRecentSessionIfMatches: jest.fn(async () => undefined),
        clearSelectedSessionAfterDelete: jest.fn(),
        startSessionSelection: jest.fn(() => 1),
        adoptSessionSelection: jest.fn(),
        isSessionSelectionCurrent: jest.fn(() => true),
        applyAppendSnapshotMeta: jest.fn(),
        persistRecentSessionSelection: jest.fn(async () => undefined),
        hydrateSessionUndoPresentation: jest.fn(async () => []),
        readSnapshot: jest.fn(async () => null),
        injectChangeLists: jest.fn(async (_sessionId: string, formatted: unknown) => formatted),
        getSnapshotTimelineIds: jest.fn((_sessionData: unknown, messages: any[]) =>
            messages.map((message) => message.id).filter(Boolean)),
        getSnapshotFile: jest.fn((sessionId: string) => `${sessionId}.json`),
        exportSessionRecent: jest.fn(async () => ({ title: 'Recent', messages: [] })),
        getRecentSessionLoadLimit: jest.fn(() => 200),
        formatSession: jest.fn((value: any) => ({
            title: typeof value?.title === 'string' ? value.title : 'Session',
            messages: Array.isArray(value?.messages) ? value.messages : [],
        })),
        getMaxMessageIndex: jest.fn(() => null),
        classifyRecentAppendCandidates: jest.fn(() => ({ proven: true, suffix: [] })),
        isSnapshotDeltaContinuityRepairEnabled: jest.fn(() => true),
        buildImmutableSnapshotWithProvenSuffix: jest.fn((base: any[], suffix: any[]) => [
            ...base,
            ...suffix,
        ]),
        extractLastLine: jest.fn((text: string) => text),
        exportSession: jest.fn(async () => ({ title: 'Full', messages: [] })),
        collectSnapshotRepairRequiredMessageIds: jest.fn(async () => []),
        buildFullExportSnapshotDelta: jest.fn((
            _base: any[],
            _ids: string[],
            messages: any[],
        ) => ({
            proven: true,
            messages,
            timelineMessageIds: messages.map((message) => message.id).filter(Boolean),
            repairedSnapshot: false,
        })),
        persistStructurallyRepairedSnapshot: jest.fn(async () => undefined),
        postAddResponse: jest.fn(),
        prepareNewSession: jest.fn(async () => undefined),
        initializeNewSessionBaseline: jest.fn(async () => undefined),
        handleSnapshotTimelineIds: jest.fn(async () => undefined),
        ...overrides,
    };
    const handler = createSessionCommandHandler(host);
    return { host, handler, posts, activeWebview, resolvingWebview };
}

describe('SessionCommandController runtime protocol', () => {
    test('declines non-session commands synchronously without an async boundary', () => {
        const harness = createRuntimeHarness();
        expect(harness.handler(
            { type: 'sendMessage' },
            harness.activeWebview,
            harness.resolvingWebview,
        )).toBe(false);
    });

    test('refreshes through the resolving Webview and forwards snapshot receipts', async () => {
        const harness = createRuntimeHarness();
        await harness.handler(
            { type: 'refreshSessions', requestId: 'refresh-1' },
            harness.activeWebview,
            harness.resolvingWebview,
        );
        const payload = { sessionId: 'session-a', timelineMessageIds: ['msg_1'] };
        await harness.handler(
            { type: 'snapshotTimelineIds', payload },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(harness.host.refreshSessions).toHaveBeenCalledWith(
            harness.resolvingWebview,
            'refresh-1',
        );
        expect(harness.host.handleSnapshotTimelineIds).toHaveBeenCalledWith(payload);
    });

    test('preserves delete side-effect and response order', async () => {
        const order: string[] = [];
        const harness = createRuntimeHarness({
            deleteSession: jest.fn(async () => { order.push('delete'); return true; }),
            cleanupDeletedSessionArtifacts: jest.fn(async () => { order.push('cleanup'); }),
            clearRecentSessionIfMatches: jest.fn(async () => { order.push('clear-recent'); }),
            clearSelectedSessionAfterDelete: jest.fn(() => { order.push('clear-selected'); }),
            refreshSessions: jest.fn(async () => { order.push('refresh'); }),
        });
        harness.activeWebview.postMessage.mockImplementation(async (message: any) => {
            harness.posts.push(message);
            order.push(message.type);
            return true;
        });
        await harness.handler(
            { type: 'deleteSession', sessionId: 'session-a', opId: 'op-1' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(order).toEqual([
            'sessionDeleteStarted',
            'delete',
            'cleanup',
            'clear-recent',
            'clear-selected',
            'refresh',
            'sessionDeleted',
        ]);
        expect(harness.posts).toEqual([
            { type: 'sessionDeleteStarted', sessionId: 'session-a', opId: 'op-1' },
            { type: 'sessionDeleted', sessionId: 'session-a', opId: 'op-1' },
        ]);
    });

    test('forks an idle source without mutating extension selection state', async () => {
        const order: string[] = [];
        const harness = createRuntimeHarness({
            forkSession: jest.fn(async () => { order.push('fork'); return { id: 'session-child' }; }),
            refreshSessions: jest.fn(async () => { order.push('refresh'); }),
        });
        harness.activeWebview.postMessage.mockImplementation(async (message: any) => {
            harness.posts.push(message);
            order.push(message.type);
            return true;
        });

        await harness.handler(
            { type: 'forkSession', sessionId: 'session-source', opId: 'fork-1' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(order).toEqual(['fork', 'sessionForked', 'refresh']);
        expect(harness.posts).toContainEqual({
            type: 'sessionForked',
            sourceSessionId: 'session-source',
            sessionId: 'session-child',
            opId: 'fork-1',
        });
        expect(harness.host.adoptSessionSelection).not.toHaveBeenCalled();
        expect(harness.host.prepareNewSession).not.toHaveBeenCalled();
    });

    test('rejects a fork when the captured source still has an active turn', async () => {
        const harness = createRuntimeHarness({
            hasActiveTurn: jest.fn(() => true),
        });

        await harness.handler(
            { type: 'forkSession', sessionId: 'session-source', opId: 'fork-2' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(harness.host.forkSession).not.toHaveBeenCalled();
        expect(harness.posts).toContainEqual({
            type: 'sessionForkFailed',
            sourceSessionId: 'session-source',
            opId: 'fork-2',
            reason: 'active_turn',
        });
    });

    test('hydrates snapshot first, then posts only the proven recent suffix merge', async () => {
        const snapshotMessage = {
            id: 'msg_1', role: 'user', text: 'snapshot', messageIndex: 1,
        };
        const recentMessage = {
            id: 'msg_2', role: 'assistant', text: 'recent', messageIndex: 2,
        };
        const harness = createRuntimeHarness({
            readSnapshot: jest.fn(async () => ({
                bytes: 100,
                obj: {
                    sessionData: {
                        title: 'Snapshot',
                        messages: [snapshotMessage],
                        meta: { timelineMessageIds: ['msg_1'] },
                    },
                },
            })),
            exportSessionRecent: jest.fn(async () => ({
                title: 'Recent',
                messages: [recentMessage],
            })),
            classifyRecentAppendCandidates: jest.fn(() => ({
                proven: true,
                suffix: [recentMessage],
            })),
        });
        await harness.handler(
            { type: 'selectSession', sessionId: 'session-a' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        const sessionPosts = harness.posts.filter((message) => message.type === 'sessionData');
        expect(sessionPosts.map((message) => message.phase)).toEqual(['snapshot', 'recent']);
        expect(sessionPosts[0].messages.map((message: any) => message.id)).toEqual(['msg_1']);
        expect(sessionPosts[1].messages.map((message: any) => message.id)).toEqual([
            'msg_1',
            'msg_2',
        ]);
        expect(harness.host.applyAppendSnapshotMeta).toHaveBeenCalledTimes(2);
        expect(harness.host.exportSession).not.toHaveBeenCalled();
    });

    test('retains a published snapshot when continuity repair export fails', async () => {
        const snapshotMessage = {
            id: 'msg_1', role: 'user', text: 'snapshot', messageIndex: 1,
        };
        const harness = createRuntimeHarness({
            readSnapshot: jest.fn(async () => ({
                bytes: 100,
                obj: {
                    sessionData: {
                        title: 'Snapshot',
                        messages: [snapshotMessage],
                        meta: { timelineMessageIds: ['msg_1'] },
                    },
                },
            })),
            classifyRecentAppendCandidates: jest.fn(() => ({
                proven: false,
                suffix: [],
            })),
            exportSession: jest.fn(async () => {
                throw new Error('Cannot create a string longer than 0x1fffffe8 characters');
            }),
        });

        await harness.handler(
            { type: 'selectSession', sessionId: 'session-a' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(harness.posts.filter((message) => message.type === 'sessionData')
            .map((message) => message.phase)).toEqual(['snapshot']);
        expect(harness.posts).toContainEqual(expect.objectContaining({
            type: 'hydrationCoverage',
            sessionId: 'session-a',
            hydrationCoverage: 'repairError',
            phase: 'full',
        }));
        expect(harness.posts.some((message) => message.type === 'sessionLoadFailed')).toBe(false);
        expect(harness.host.log).toHaveBeenCalledWith(
            expect.stringContaining('[EXT][SESSION_LOAD_RETAIN_SNAPSHOT]'),
        );
    });

    test('reports a load failure when no snapshot or remote export is available', async () => {
        const harness = createRuntimeHarness({
            exportSessionRecent: jest.fn(async () => {
                throw new Error('recent unavailable');
            }),
            exportSession: jest.fn(async () => {
                throw new Error('full unavailable');
            }),
        });

        await harness.handler(
            { type: 'selectSession', sessionId: 'session-a' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(harness.posts).toContainEqual({
            type: 'sessionLoadFailed',
            payload: {
                sessionId: 'session-a',
                reason: 'export_failed_no_snapshot',
                stderrLastLine: 'Error: full unavailable',
            },
        });
    });

    test('stops a stale selection after recent export without posting newer phases', async () => {
        const current = jest.fn()
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const harness = createRuntimeHarness({
            isSessionSelectionCurrent: current,
            readSnapshot: jest.fn(async () => ({
                bytes: 10,
                obj: {
                    sessionData: {
                        title: 'Snapshot',
                        messages: [{ id: 'msg_1', role: 'user', text: 'one' }],
                    },
                },
            })),
        });
        await harness.handler(
            { type: 'selectSession', sessionId: 'session-a' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(harness.posts.filter((message) => message.type === 'sessionData')
            .map((message) => message.phase)).toEqual(['snapshot']);
        expect(harness.host.exportSession).not.toHaveBeenCalled();
    });

    test('publishes an empty new session before initializing its baseline', async () => {
        const order: string[] = [];
        const harness = createRuntimeHarness({
            prepareNewSession: jest.fn(async () => { order.push('prepare'); return undefined; }),
            initializeNewSessionBaseline: jest.fn(async () => { order.push('baseline'); }),
        });
        harness.activeWebview.postMessage.mockImplementation(async (message: any) => {
            harness.posts.push(message);
            order.push(message.type);
            return true;
        });
        await harness.handler(
            { type: 'newSession' },
            harness.activeWebview,
            harness.resolvingWebview,
        );

        expect(order).toEqual(['prepare', 'newSession', 'baseline']);
        expect(harness.posts).toContainEqual({ type: 'newSession', sessionId: undefined });
    });
});
