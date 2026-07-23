import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const createUndoRequestController = require('../../../webview-src/undo/undo-request-controller').createUndoRequestController;
const createSessionEventRouter = require('../../../webview-src/continuation/session-event-router').createSessionEventRouter;
const createSessionRenderScheduler = require('../../../webview-src/continuation/session-render-scheduler').createSessionRenderScheduler;
const createAppendSnapshotController = require('../../../webview-src/continuation/append-snapshot-controller').createAppendSnapshotController;

function createHarnessSegmentTopology(debug: (payload: string[]) => void) {
    const resolveMessageId = (session: any, id: unknown): string | null => {
        if (typeof id !== 'string') return null;
        const mappedServer = session.clientKeyToServerId?.get(id);
        if (mappedServer && session.timeline.includes(mappedServer)) return mappedServer;
        if (session.timeline.includes(id)) return id;
        const mappedLocal = session.serverIdToClientKey?.get(id);
        return mappedLocal && session.timeline.includes(mappedLocal) ? mappedLocal : null;
    };
    const computeMembers = (session: any, anchor: string, end: string): string[] => {
        const anchorIndex = session.timeline.indexOf(anchor);
        const endIndex = session.timeline.indexOf(end);
        if (anchorIndex < 0 || endIndex < anchorIndex) return [];
        return session.timeline.slice(anchorIndex, endIndex + 1).filter((id: unknown) => typeof id === 'string' && id.startsWith('msg_'));
    };
    const normalizeMembers = (session: any, anchor: unknown, end: unknown, candidates: unknown, noticeKey: unknown) => {
        const explicit = Array.isArray(candidates)
            ? Array.from(new Set(candidates.map((id: unknown) => resolveMessageId(session, id) || id).filter((id: unknown): id is string => typeof id === 'string' && id.startsWith('msg_'))))
            : [];
        if (explicit.length) {
            debug(['[WV][SEG_MEMBERS]', 'source=explicit', `noticeKey=${noticeKey || 'null'}`, `count=${explicit.length}`]);
            return { anchorMsgId: explicit[0], endMsgId: explicit[explicit.length - 1], memberMsgIds: explicit };
        }
        const resolvedAnchor = resolveMessageId(session, anchor);
        if (!resolvedAnchor) return { anchorMsgId: null, endMsgId: null, memberMsgIds: [] };
        const resolvedEnd = resolveMessageId(session, end) || resolvedAnchor;
        if (session.timeline.indexOf(resolvedEnd) < session.timeline.indexOf(resolvedAnchor)) {
            debug(['[WV][SEG_MEMBERS]', 'source=timeline', 'inverted-range-drop']);
            return { anchorMsgId: resolvedAnchor, endMsgId: resolvedEnd, memberMsgIds: [] };
        }
        const members = computeMembers(session, resolvedAnchor, resolvedEnd);
        debug(['[WV][SEG_MEMBERS]', 'source=timeline', `count=${members.length}`]);
        return { anchorMsgId: resolvedAnchor, endMsgId: resolvedEnd, memberMsgIds: members };
    };
    return {
        resolveMessageId,
        computeMembers,
        normalizeMembers,
        sanitizeMergedSnapshot: (segment: any) => segment,
        orderMembersByTimeline: (members: string[], timeline: string[]) => [
            ...timeline.filter((id) => members.includes(id)),
            ...members.filter((id) => !timeline.includes(id)),
        ],
    };
}

function loadSegmentHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const start = source.indexOf('function computeMemberMsgIdsFromTimeline');
    const end = source.indexOf('function getAnchorOrder');
    if (start < 0 || end < 0 || end <= start) {
        throw new Error('Could not locate segment helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const context: any = {
        console,
        Date,
        Map,
        Set,
        Array,
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        window: {
            __oc: {
                renderFromState: jest.fn(),
            },
        },
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        formatList: (items: unknown[]) => JSON.stringify(items),
    };
    context.segmentTopology = createHarnessSegmentTopology(
        (payload) => posts.push({ type: 'ui-debug', payload }),
    );
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    return { context, posts, sessions };
}

function createSession(timeline: string[]): any {
    return {
        timeline: [...timeline],
        messagesById: new Map(timeline.map((id, index) => [id, { id, order: index }])),
        hiddenSet: new Set<string>(),
        segmentsByNoticeKey: new Map(),
        undoNoticeKeyByOpId: new Map(),
        pendingUndoByNoticeKey: new Map(),
        clientKeyToServerId: new Map(),
        serverIdToClientKey: new Map(),
    };
}

function loadUndoSenderHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const start = source.indexOf('function isHydrationPersistenceArtifact');
    const end = source.indexOf('function createOperationId');
    if (start < 0 || end < 0 || end <= start) {
        throw new Error('Could not locate undo sender helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const renderFromState = jest.fn();
    const context: any = {
        console,
        Date,
        Math,
        Map,
        Set,
        Array,
        activeSessionId: 'ses_A',
        sessionsById: sessions,
        sessionStore: {
            entries: () => sessions.entries(),
            getRegistryInfo: (sessionId: string) => ({ size: sessions.size, hasSession: sessions.has(sessionId) }),
        },
        hydrationStateController: {
            isPersistenceArtifact: (id: unknown, message: any) => (
                (typeof id === 'string' && (id.startsWith('system:snapshot:') || id.startsWith('system:changeList:')))
                || message?.meta?.kind === 'snapshotNotice'
                || message?.meta?.kind === 'changeList'
            ),
        },
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        upsertMessage: (session: any, message: any) => session.messagesById.set(message.id, message),
        assertInvariants: jest.fn(),
        setTimeout: jest.fn(),
        clearTimeout: jest.fn(),
        logTimelineSnapshot: jest.fn(),
        window: {
            __oc: {
                renderFromState,
            },
            __ocUndo: {
                createUndoRequestController,
            },
            __ocContinuation: {
                createSessionEventRouter,
                createSessionRenderScheduler,
                createAppendSnapshotController,
                createSessionSelectionController: () => ({
                    select: jest.fn(),
                }),
                selectAssistantUpgradeCandidate: jest.fn(),
                createTurnLifecycleController: () => ({}),
                createMessageIdentityStore: () => {
                  const ensure = (message: any) => {
                        message.meta = {
                            ...(message.meta || {}),
                            identity: message.meta?.identity || { entityId: `entity:${message.id || 'test'}` },
                        };
                        return message.meta.identity;
                  };
                  return {
                    ensure,
                    store: (messagesById: Map<string, any>, message: any) => {
                      ensure(message);
                      messagesById.set(message.id, message);
                      return message;
                    },
                  };
                },
                createMessageRekeyController: () => ({
                    rekey: jest.fn(),
                }),
            },
        },
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\nthis.suspendUndoTimeoutForConflictCard = suspendUndoTimeoutForConflictCard;`, context);
    return { context, posts, sessions, renderFromState };
}

describe('WebView revertedSegment explicit member handling', () => {
    it('uses explicit messageIds even when anchor/end timeline indices are inverted', () => {
        const { context, posts, sessions } = loadSegmentHarness();
        const session = createSession(['msg_pre', 'msg_end', 'msg_mid', 'msg_anchor', 'msg_tail']);
        sessions.set('ses_A', session);

        context.applyRevertedSegmentPayload('ses_A', {
            startMessageId: 'msg_anchor',
            endMessageId: 'msg_end',
            messageIds: ['msg_anchor', 'msg_tail'],
            applied: true,
        }, 'system:undo:msg_anchor');

        const segment = session.segmentsByNoticeKey.get('system:undo:msg_anchor');
        expect(segment.memberMsgIds).toEqual(['msg_anchor', 'msg_tail']);
        expect(segment.memberMsgIds).not.toContain('msg_pre');
        expect(session.hiddenSet.has('msg_pre')).toBe(false);
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['[WV][SEG_MEMBERS]', 'source=explicit', 'count=2']),
        }));
    });

    it('keeps legacy timeline fallback when messageIds are absent and anchor/end order is normal', () => {
        const { context, posts, sessions } = loadSegmentHarness();
        const session = createSession(['msg_pre', 'msg_anchor', 'msg_mid', 'msg_end']);
        sessions.set('ses_A', session);

        context.applyRevertedSegmentPayload('ses_A', {
            startMessageId: 'msg_anchor',
            endMessageId: 'msg_end',
            applied: true,
        }, 'system:undo:msg_anchor');

        const segment = session.segmentsByNoticeKey.get('system:undo:msg_anchor');
        expect(segment.memberMsgIds).toEqual(['msg_anchor', 'msg_mid', 'msg_end']);
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['[WV][SEG_MEMBERS]', 'source=timeline', 'count=3']),
        }));
    });

    it('drops legacy inverted anchor/end ranges when explicit messageIds are absent', () => {
        const { context, posts, sessions } = loadSegmentHarness();
        const session = createSession(['msg_pre', 'msg_end', 'msg_mid', 'msg_anchor']);
        sessions.set('ses_A', session);

        context.applyRevertedSegmentPayload('ses_A', {
            startMessageId: 'msg_anchor',
            endMessageId: 'msg_end',
            applied: true,
        }, 'system:undo:msg_anchor');

        expect(session.segmentsByNoticeKey.has('system:undo:msg_anchor')).toBe(false);
        expect(session.hiddenSet.size).toBe(0);
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['[WV][SEG_MEMBERS]', 'source=timeline', 'inverted-range-drop']),
        }));
    });
});

describe('WebView undoToMessage visible range payload', () => {
    it('sends anchor-forward visible msg ids excluding pre-anchor and system ids', () => {
        const { context, posts, sessions } = loadUndoSenderHarness();
        const session = createSession([
            'msg_pre',
            'system:changeList:1',
            'msg_anchor',
            'system:undo:msg_anchor',
            'msg_tail',
            'system:snapshot:1',
            'msg_hidden',
        ]);
        session.hiddenSet.add('msg_hidden');
        session.messagesById.set('system:changeList:1', { id: 'system:changeList:1', meta: { kind: 'changeList' } });
        session.messagesById.set('system:undo:msg_anchor', { id: 'system:undo:msg_anchor', meta: { kind: 'undoNotice' } });
        session.messagesById.set('system:snapshot:1', { id: 'system:snapshot:1', meta: { kind: 'snapshotNotice' } });
        sessions.set('ses_A', session);

        context.handleUndoToMessage('ses_A', 'msg_anchor');

        const undoMessage = posts.find((message) => message?.type === 'undoToMessage');
        expect(undoMessage).toEqual(expect.objectContaining({
            sessionId: 'ses_A',
            messageId: 'msg_anchor',
            visibleMessageIds: ['msg_pre', 'msg_anchor', 'msg_tail'],
            anchorIndex: 1,
            forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_tail'],
        }));
        expect(undoMessage.forwardMessageIdsFromAnchor).not.toContain('msg_pre');
        expect(undoMessage.forwardMessageIdsFromAnchor).not.toContain('system:undo:msg_anchor');
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['[WV][UNDO_RANGE_TX]', 'sessionId=ses_A', expect.stringContaining('anchorIndex=1')]),
        }));
    });

    it('keeps normal unanswered undo requests timing out', () => {
        const { context, posts, sessions, renderFromState } = loadUndoSenderHarness();
        const session = createSession(['msg_anchor']);
        session.pendingUndo = {
            clientOpId: 'op_undo_1',
            anchorKey: 'msg_anchor',
            noticeKey: 'system:undo:msg_anchor',
            ts: Date.now() - 10001,
            status: 'waiting-response',
        };
        session.pendingUndoByNoticeKey.set('system:undo:msg_anchor', {
            clientOpId: 'op_undo_1',
            noticeKey: 'system:undo:msg_anchor',
        });
        sessions.set('ses_A', session);

        context.handleUndoTimeout('ses_A', 'op_undo_1');

        expect(session.pendingUndo).toBeNull();
        expect(session.messagesById.get('system:undo-timeout:op_undo_1')).toEqual(expect.objectContaining({
            meta: expect.objectContaining({ kind: 'undoTimeout', opId: 'op_undo_1' }),
        }));
        expect(renderFromState).toHaveBeenCalled();
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['undo', 'timeout', 'clientOpId', 'op_undo_1']),
        }));
    });

    it('suspends undo timeout while a matching conflict card is waiting for decision', () => {
        const { context, posts, sessions } = loadUndoSenderHarness();
        const timeoutId = { id: 'timer' };
        const session = createSession(['msg_anchor']);
        session.pendingUndo = {
            clientOpId: 'op_undo_2',
            anchorKey: 'msg_anchor',
            noticeKey: 'system:undo:msg_anchor',
            ts: Date.now() - 10001,
            status: 'waiting-response',
            timeoutId,
        };
        sessions.set('ses_A', session);

        const suspended = context.suspendUndoTimeoutForConflictCard({
            type: 'conflictCard',
            sessionId: 'ses_A',
            operationId: 'op_undo_2',
            conflictId: 'conflict_1',
            kind: 'undo',
        });
        context.handleUndoTimeout('ses_A', 'op_undo_2');

        expect(suspended).toBe(true);
        expect(context.clearTimeout).toHaveBeenCalledWith(timeoutId);
        expect(session.pendingUndo).toEqual(expect.objectContaining({
            clientOpId: 'op_undo_2',
            status: 'waiting-conflict-decision',
            conflictId: 'conflict_1',
            timeoutId: null,
        }));
        expect(session.messagesById.has('system:undo-timeout:op_undo_2')).toBe(false);
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['undo', 'timeout-skip-conflict', 'clientOpId', 'op_undo_2']),
        }));
    });
});
