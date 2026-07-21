import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end <= start) throw new Error(`Missing source block: ${startMarker}`);
    return source.slice(start, end);
}

describe('hydrated change-list anchor wiring', () => {
    it('prefers explicit stable anchors and preserves sibling insertion order', () => {
        const materialize = sourceBetween(
            'function materializeInjectedChangeLists(',
            'function computeMemberMsgIdsFromTimeline(',
        );

        expect(materialize).toContain("typeof message.meta?.stableAnchorMessageId === 'string'");
        expect(materialize).toContain('const insertionTailByAnchor = new Map();');
        expect(materialize).toContain('const insertionTailId = insertionTailByAnchor.get(anchorId) || anchorId;');
        expect(materialize).toContain('insertionTailByAnchor.set(anchorId, id);');
    });
});
