import { injectChangeListRecords, type ChangeListRecord } from '../changes/ChangeListInjection';

function record(id: string, anchorMessageId: string, createdAt = 1): ChangeListRecord {
    return { id, anchorMessageId, createdAt, commitHead: `head-${id}`, commitBase: `base-${id}`, files: [`${id}.ts`] };
}

describe('change-list injection', () => {
    test('places records immediately after their resolved owner in creation order', () => {
        const result = injectChangeListRecords({
            messages: [
                { role: 'user', id: 'msg-user', text: 'request' },
                { role: 'assistant', id: 'msg-owner', text: 'done' },
                { role: 'user', id: 'msg-later', text: 'later' },
            ],
            records: [record('cl-late', 'msg-old', 2), record('cl-early', 'msg-old', 1)],
            resolveOwner: (candidate) => candidate === 'msg-old' ? 'msg-owner' : candidate,
        });
        expect(result.messages.map((message) => message.id)).toEqual([
            'msg-user', 'msg-owner', 'cl-early', 'cl-late', 'msg-later',
        ]);
        expect(result.counts.injectedByResolvedAnchor).toBe(2);
    });

    test('converts an existing placeholder with the same id without duplicating it', () => {
        const result = injectChangeListRecords({
            messages: [{ role: 'system', id: 'cl-existing', text: 'placeholder', meta: { preserved: true } }],
            records: [record('cl-existing', 'missing')],
            resolveOwner: (candidate) => candidate,
        });
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual(expect.objectContaining({
            id: 'cl-existing', role: 'system', text: '',
            meta: expect.objectContaining({ kind: 'changeList', preserved: true, files: ['cl-existing.ts'] }),
        }));
        expect(result.counts.convertedByExistingId).toBe(1);
    });

    test('does not append records whose owner cannot be resolved', () => {
        const missing: string[] = [];
        const result = injectChangeListRecords({
            messages: [{ role: 'assistant', id: 'msg-owner', text: 'done' }],
            records: [record('cl-missing', 'msg-gone')],
            resolveOwner: (candidate) => candidate,
            onMissingAnchor: (item) => missing.push(item.id),
        });
        expect(result.messages.map((message) => message.id)).toEqual(['msg-owner']);
        expect(missing).toEqual(['cl-missing']);
    });
});
