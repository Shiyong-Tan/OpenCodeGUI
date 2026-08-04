import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('assistant image scroll anchor production contract', () => {
  it('uses a fine-grained descendant anchor while image layout is changing', () => {
    expect(source).toContain('visualAnchorElement: null');
    expect(source).toContain("element.closest('[data-render-unit-key]')");
    expect(source).toContain('const delta = currentTop - chatWindowState.visualAnchorTop;');
    expect(source).toContain('chatContainer.scrollTop += delta;');
    expect(source).toContain('function scheduleFineChatWindowAnchorRestore');
    expect(source).toContain('Math.abs(delta) < 2');
    expect(source).toContain('[WV][CHAT_WINDOW_FINE_ANCHOR_BATCH]');
  });

  it('tracks asynchronous image settlement without overriding direct user scroll input', () => {
    expect(source).toContain('function isAssistantImageLayoutStabilizing()');
    expect(source).toContain('function isDirectChatScrollInputActive()');
    expect(source).toContain("image.addEventListener('load'");
    expect(source).toContain("image.addEventListener('error'");
    expect(source).toContain('activeSessionId !== sessionId || chatWindowGeneration !== generation');
    expect(source).toContain('&& !isDirectChatScrollInputActive()');
    expect(source).toContain('Math.abs(currentTop - firstTop) >= 0.75');
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
