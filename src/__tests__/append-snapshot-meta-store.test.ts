import { AppendSnapshotMetaStore } from '../continuation/AppendSnapshotMetaStore';

describe('AppendSnapshotMetaStore', () => {
    test('sanitizes lengths, ids, timestamps, and duplicate append keys', () => {
        const store = new AppendSnapshotMetaStore(() => undefined);
        expect(store.sanitizeItems([
            { clientMessageId: 'client-a', text: 'x'.repeat(20_100), status: 'queued', createdAt: 1, ignored: true },
            { clientMessageId: 'client-a', text: 'duplicate' },
            { appendUserMsgId: 'msg_append', updatedAt: 2 },
        ])).toEqual([
            { clientMessageId: 'client-a', status: 'queued', text: 'x'.repeat(20_000), createdAt: 1 },
            { appendUserMsgId: 'msg_append', updatedAt: 2 },
        ]);
    });

    test('rejects temporary roots and applies canonical roots only to user messages', () => {
        const logs: string[] = [];
        const store = new AppendSnapshotMetaStore((line) => logs.push(line));
        store.cache({
            sessionId: 'session-a',
            reason: 'test',
            roots: [
                { rootMessageId: 'local-a', meta: { appendedPrompts: [{ text: 'hidden' }] } },
                { rootMessageId: 'msg_root', meta: { appendedPrompts: [{ clientMessageId: 'c1', text: 'append' }] } },
            ],
        });
        const messages = new Map<string, any>([
            ['msg_root', { id: 'msg_root', role: 'user', text: 'root', meta: { kept: true } }],
            ['msg_assistant', { id: 'msg_assistant', role: 'assistant', text: 'answer', meta: {} }],
        ]);
        expect(store.apply('session-a', messages)).toBe(1);
        expect(messages.get('msg_root').meta).toEqual({
            kept: true,
            appendedPrompts: [{ clientMessageId: 'c1', text: 'append' }],
            appendRootUserKey: 'msg_root',
        });
        expect(logs.some((line) => line.includes('rootCount=1'))).toBe(true);
    });
});
