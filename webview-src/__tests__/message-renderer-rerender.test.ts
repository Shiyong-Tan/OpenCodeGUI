import fs from 'fs';
import path from 'path';

describe('message renderer rerender boundary', () => {
  test('routes segment-toggle and undo rerenders through the host exactly once', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'webview-src', 'rendering', 'message-renderer.ts'), 'utf8');
    expect(source).not.toContain('window.__oc');
    expect((source.match(/host\.requestRerender\(\)/g) || []).length).toBe(2);
    expect(source.indexOf('host.requestRerender();')).toBeGreaterThan(source.indexOf("payload: ['[WV][SEG_TOGGLE]"));
    expect(source.lastIndexOf('host.requestRerender();')).toBeGreaterThan(source.indexOf('host.handleUndoToMessage(sessionId, verdict.msgId);'));
  });
});
