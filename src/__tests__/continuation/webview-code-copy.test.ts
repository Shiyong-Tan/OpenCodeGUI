import * as fs from 'fs';
import * as path from 'path';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
    const start = mainSource.indexOf(startMarker);
    const end = mainSource.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end <= start) {
        throw new Error(`Could not locate webview source block: ${startMarker}`);
    }
    return mainSource.slice(start, end);
}

describe('virtualized markdown code copy controls', () => {
    it('enhances code blocks directly inside a detached markdown root', () => {
        const enhancement = sourceBetween(
            'function enhanceCodeBlocksWithCopyButtons(root)',
            'function resetCachedCodeBlockCopyEnhancements(root)',
        );

        expect(enhancement).toContain("root.querySelectorAll('pre')");
        expect(enhancement).not.toContain("root.querySelectorAll('.message.bot')");
        expect(enhancement).not.toContain("root.closest('.message.bot')");
        expect(enhancement).toContain("pre.closest('.conflict-card')");
        expect(enhancement).toContain("btn.addEventListener('click'");
    });

    it('rebinds copy controls after restoring cached markdown HTML', () => {
        const cachedRender = sourceBetween(
            'function renderAssistantMarkdown(content, message)',
            'function renderUserMarkdown(content, text)',
        );
        const resetIndex = cachedRender.indexOf('resetCachedCodeBlockCopyEnhancements(content)');
        const enhanceIndex = cachedRender.indexOf('enhanceCodeBlocksWithCopyButtons(content)');

        expect(resetIndex).toBeGreaterThanOrEqual(0);
        expect(enhanceIndex).toBeGreaterThan(resetIndex);
    });
});
