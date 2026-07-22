import fs from 'fs';
import path from 'path';
import { renderMessageElement } from '../rendering/message-renderer';

describe('message renderer module', () => {
  test('main keeps a live host facade instead of duplicating renderer behavior', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    expect(source).toContain('const renderMessageElementHost = Object.freeze({');
    expect(source).toContain('get activeSessionId() { return activeSessionId; }');
    expect(source).toMatch(/function renderMessageElement\(message, renderedSet\) \{\s*return window\.__ocRendering\.renderMessageElement\(renderMessageElementHost, message, renderedSet\);\s*}/);
  });

  test('preserves duplicate suppression before any host state is read', () => {
    const rendered = new Set(['message-a']);
    const host = new Proxy({}, { get: () => { throw new Error('host accessed'); } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => renderMessageElement(host, { id: 'message-a' }, rendered)).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[Render] duplicate message skipped', 'message-a');
    warn.mockRestore();
  });

  test('delegates changelist rendering and appends exactly one root', () => {
    const root = { id: 'change-root' };
    const append = jest.fn();
    const host = {
      activeSessionId: 'session-a',
      getSessionState: () => ({}),
      changeListRenderer: { render: () => root },
      appendChatRenderRoot: append,
    };
    renderMessageElement(host, { id: 'change-a', role: 'system', meta: { kind: 'changeList' } }, new Set());
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(root);
  });
});
