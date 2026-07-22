import { resolveUndoUiVisibleRange, sanitizeUndoRangeMessageIds } from '../undo/UndoRangeResolver';

describe('undo range resolver', () => {
    test('sanitizes message ids without changing valid order', () => {
        expect(sanitizeUndoRangeMessageIds(['msg_a', 'system:x', 'msg_a', 'msg_b', null])).toEqual(['msg_a', 'msg_b']);
    });

    test('accepts an explicit anchor-forward visible range', () => {
        expect(resolveUndoUiVisibleRange({
            data: { anchorIndex: 2, forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_tail'] },
            anchorMessageId: 'msg_anchor', canonicalMessageIds: ['msg_anchor', 'msg_canonical'], extAnchorIndex: 4,
        })).toEqual({
            messageIds: ['msg_anchor', 'msg_tail'], source: 'webview-visible', uiAnchorIndex: 2, extAnchorIndex: 4,
        });
    });

    test('derives the forward range from the validated visible anchor index', () => {
        expect(resolveUndoUiVisibleRange({
            data: { anchorIndex: 1, visibleMessageIds: ['msg_pre', 'msg_anchor', 'msg_tail'] },
            anchorMessageId: 'msg_anchor', canonicalMessageIds: [], extAnchorIndex: 7,
        }).messageIds).toEqual(['msg_anchor', 'msg_tail']);
    });

    test('falls back to the extension canonical range when Webview evidence is inconsistent', () => {
        expect(resolveUndoUiVisibleRange({
            data: { anchorIndex: 0, forwardMessageIdsFromAnchor: ['msg_wrong'], visibleMessageIds: ['msg_wrong'] },
            anchorMessageId: 'msg_anchor', canonicalMessageIds: ['msg_anchor', 'msg_canonical'], extAnchorIndex: 3,
        })).toEqual({
            messageIds: ['msg_anchor', 'msg_canonical'], source: 'fallback', uiAnchorIndex: 0, extAnchorIndex: 3,
        });
    });

    test('uses the anchor as the final canonical fallback', () => {
        expect(resolveUndoUiVisibleRange({
            data: {}, anchorMessageId: 'msg_anchor', canonicalMessageIds: [], extAnchorIndex: -1,
        })).toEqual({
            messageIds: ['msg_anchor'], source: 'extension-canonical', uiAnchorIndex: -1, extAnchorIndex: -1,
        });
    });
});
