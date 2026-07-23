import * as fs from 'fs';
import * as path from 'path';

describe('session selection production integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  test('renders cached selected state immediately and force-scrolls to bottom', () => {
    expect(source).toContain(
      'const sessionSelectionController = window.__ocContinuation.createSessionSelectionController({',
    );
    expect(source).toContain('window.__oc.scrollToBottom(force);');
    expect(source).toContain('sessionSelectionController.select(item.id);');
  });

  test('changes only the presentation owner before requesting hydration', () => {
    const select = source.indexOf('sessionSelectionController.select(item.id);');
    const request = source.indexOf("vscode.postMessage({ type: 'selectSession', sessionId: item.id });", select);
    expect(select).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(select);
    const block = source.slice(source.lastIndexOf("button.addEventListener('click'", select), request);
    expect(block).toContain('activeSessionId = item.id;');
    expect(block).toContain('transitionActiveSessionPresentationOwner(previousSessionId, item.id);');
    expect(block).not.toContain('messagesById.clear');
    expect(block).not.toContain('timeline = []');
  });
});
