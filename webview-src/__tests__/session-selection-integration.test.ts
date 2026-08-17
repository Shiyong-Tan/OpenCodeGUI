import * as fs from 'fs';
import * as path from 'path';

describe('session selection production integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  test('renders cached selected state immediately and force-scrolls to bottom', () => {
    expect(source).toContain(
      'const sessionSelectionController = window.__ocContinuation.createSessionSelectionController({',
    );
    expect(source).toContain('window.__oc.scrollToBottom(force);');
    expect(source).toContain('sessionSelectionController.select(sessionId);');
  });

  test('changes only the presentation owner before requesting hydration', () => {
    const helper = source.indexOf('function requestSessionSelection(sessionId) {');
    const select = source.indexOf('sessionSelectionController.select(sessionId);', helper);
    const request = source.indexOf("vscode.postMessage({ type: 'selectSession', sessionId });", select);
    expect(helper).toBeGreaterThan(0);
    expect(select).toBeGreaterThan(0);
    expect(request).toBeGreaterThan(select);
    const block = source.slice(helper, request);
    expect(block).toContain('activeSessionId = sessionId;');
    expect(block).toContain('transitionActiveSessionPresentationOwner(previousSessionId, sessionId);');
    expect(block).not.toContain('messagesById.clear');
    expect(block).not.toContain('timeline = []');
  });

  test('renders session history titles with the shared inline math renderer', () => {
    const renderSessionList = source.indexOf('function renderSessionList() {');
    const renderTitle = source.indexOf(
      'renderInlineMathTitle(title, item.title || item.id);',
      renderSessionList,
    );

    expect(renderSessionList).toBeGreaterThan(0);
    expect(renderTitle).toBeGreaterThan(renderSessionList);
  });
});
