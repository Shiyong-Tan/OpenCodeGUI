import * as fs from 'fs';
import * as path from 'path';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const controllerSource = fs.readFileSync(
    path.join(process.cwd(), 'webview-src', 'rendering', 'markdown-controller.ts'),
    'utf8',
);

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end <= start) {
        throw new Error(`Could not locate webview source block: ${startMarker}`);
    }
    return source.slice(start, end);
}

describe('virtualized markdown code copy controls', () => {
    it('enhances code blocks directly inside a detached markdown root', () => {
        const enhancement = sourceBetween(
            controllerSource,
            'function enhanceCodeBlocksWithCopyButtons(root:',
            'function resetCachedCodeBlockCopyEnhancements(',
        );

        expect(enhancement).toContain("Array.from(root.querySelectorAll<HTMLElement>('pre'))");
        expect(enhancement).not.toContain("root.querySelectorAll('.message.bot')");
        expect(enhancement).not.toContain("root.closest('.message.bot')");
        expect(enhancement).toContain("pre.closest('.conflict-card')");
        expect(enhancement).toContain("button.addEventListener('click'");
    });

    it('rebinds copy controls after restoring cached markdown HTML', () => {
        const cachedRender = sourceBetween(
            controllerSource,
            'function renderAssistantMarkdown(',
            'function renderUserMarkdown(',
        );
        const resetIndex = cachedRender.indexOf('resetCachedCodeBlockCopyEnhancements(content)');
        const enhanceIndex = cachedRender.indexOf('enhanceCodeBlocksWithCopyButtons(content)');

        expect(resetIndex).toBeGreaterThanOrEqual(0);
        expect(enhanceIndex).toBeGreaterThan(resetIndex);
    });

    it('keeps stable main.js compatibility entrypoints', () => {
        expect(mainSource).toContain('function getMarkdownController()');
        expect(mainSource).toContain('getMarkdownController().renderAssistantMarkdown(content, message, shouldLinkifyAssistantMessage(message));');
        expect(mainSource).toContain('getMarkdownController().enhanceCodeBlocksWithCopyButtons(root);');
        expect(mainSource).toContain('getMarkdownController().writeTextToClipboard(text);');
    });
});
