import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

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
        clientKeyToServerId: new Map(),
        serverIdToClientKey: new Map(),
    };
}

function loadUndoSenderHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const start = source.indexOf('function isHydrationPersistenceArtifact');
    const end = source.indexOf('function handleUndoTimeout');
    if (start < 0 || end < 0 || end <= start) {
        throw new Error('Could not locate undo sender helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const context: any = {
        console,
        Date,
        Math,
        Map,
        Set,
        Array,
        activeSessionId: 'ses_A',
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        setTimeout: jest.fn(),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    return { context, posts, sessions };
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
});
