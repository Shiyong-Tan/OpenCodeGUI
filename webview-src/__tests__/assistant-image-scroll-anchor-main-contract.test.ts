import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(process.cwd(), 'media', 'main.css'), 'utf8');

describe('assistant image scroll anchor production contract', () => {
  it('uses a fine-grained descendant anchor while image layout is changing', () => {
    expect(source).toContain('visualAnchorElement: null');
    expect(source).toContain("element.closest('[data-render-unit-key]')");
    expect(source).toContain('const delta = currentTop - chatWindowState.visualAnchorTop;');
    expect(source).toContain('chatContainer.scrollTop += delta;');
    expect(source).toContain('function scheduleFineChatWindowAnchorRestore');
    expect(source).toContain('Math.abs(delta) < 2');
    expect(source).toContain('[WV][CHAT_WINDOW_FINE_ANCHOR_BATCH]');
    expect(styles).toMatch(/\.chat-area\s*\{[^}]*overflow-anchor:\s*none;/s);
  });

  it('tracks asynchronous image settlement without overriding direct user scroll input', () => {
    expect(source).toContain('function isAssistantImageLayoutStabilizing()');
    expect(source).toContain('function isDirectChatScrollInputActive()');
    expect(source).toContain("image.addEventListener('load'");
    expect(source).toContain("image.addEventListener('error'");
    expect(source).toContain('activeSessionId !== sessionId || chatWindowGeneration !== generation');
    expect(source).toContain('&& !isDirectChatScrollInputActive()');
    expect(source).toContain('Math.abs(currentTop - firstTop) >= 0.75');
    expect(source).toContain("retryAfterDirectInput('direct-input-settle')");
    expect(source).toContain('inputUntil - now + 16');
    expect(source).toContain('|| autoScrollPinnedToBottom) return;');
    expect(source).toContain('Re-arm from the latest');
  });

  it('invalidates stale anchors when forced bottom navigation takes ownership', () => {
    const start = source.indexOf('function scrollToBottom(force = false)');
    const end = source.indexOf('window.__oc = window.__oc || {};', start);
    const block = source.slice(start, end);
    expect(block).toContain('chatWindowState.fineAnchorRestoreToken += 1;');
    expect(block).toContain("chatWindowState.anchorKey = '';");
    expect(block).toContain('chatWindowState.visualAnchorElement = null;');
    expect(block.indexOf('chatWindowState.fineAnchorRestoreToken += 1;'))
      .toBeLessThan(block.indexOf('autoScrollPinnedToBottom = true;'));
  });

  it('captures before applying resolved image DOM and restores after it', () => {
    const start = source.indexOf("case 'assistantImageReferencesResolved': {");
    const end = source.indexOf("case 'smartSessionSearchResult': {", start);
    const handler = source.slice(start, end);
    expect(handler.indexOf('captureChatWindowAnchor();')).toBeLessThan(handler.indexOf('acceptResponse(message)'));
    expect(handler).toContain('trackAssistantImageLayoutLoads();');
    expect(handler).toContain("scheduleAssistantImageAnchorRestore('resolved');");
  });
});
