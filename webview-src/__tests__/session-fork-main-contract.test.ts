import * as fs from 'fs';
import * as path from 'path';

describe('current session fork Webview contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');

  test('places a disabled branch control next to the new-session control', () => {
    const newSession = provider.indexOf('id="new-session-btn"');
    const forkSession = provider.indexOf('id="fork-session-btn"');
    const history = provider.indexOf('id="history-btn"');
    expect(newSession).toBeGreaterThan(0);
    expect(forkSession).toBeGreaterThan(newSession);
    expect(history).toBeGreaterThan(forkSession);
    expect(provider.slice(forkSession, history)).toContain('disabled');
  });

  test('captures the source identity and disables fork while its turn is active', () => {
    expect(source).toContain("const sourceSessionId = activeSessionId;");
    expect(source).toContain("if (!sourceSessionId || isActiveSessionBusy() || pendingForkRequest)");
    expect(source).toContain("vscode.postMessage({ type: 'forkSession', sessionId: sourceSessionId, opId });");
    expect(source).toContain("? 'Wait for the current turn to finish'");
  });

  test('switches only when the matching source remains visible', () => {
    const receipt = source.slice(
      source.indexOf("case 'sessionForked':"),
      source.indexOf("case 'sessionForkFailed':"),
    );
    expect(receipt).toContain('pendingForkRequest.sourceSessionId === sourceSessionId');
    expect(receipt).toContain('pendingForkRequest.opId === message.opId');
    expect(receipt).toContain('if (!nextSessionId || activeSessionId !== sourceSessionId) break;');
    expect(receipt).toContain('requestSessionSelection(nextSessionId);');
  });

  test('renders the branch origin as a parent-session navigation link', () => {
    expect(source).toContain("presentation.state === 'localStartReached'");
    expect(source).toContain("link.className = 'chat-fork-origin-link'");
    expect(source).toContain('requestSessionSelection(forkOrigin.parentSessionId)');
  });
});
