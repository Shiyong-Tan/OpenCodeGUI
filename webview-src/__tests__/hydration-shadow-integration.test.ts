import fs from 'fs';
import path from 'path';

const main = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const controller = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'continuation', 'hydration-state-controller.ts'),
  'utf8',
);

function sessionDataBlock(): string {
  const start = main.indexOf("case 'sessionData': {");
  const end = main.indexOf("case 'sessionLoadFailed':", start);
  if (start < 0 || end <= start) throw new Error('sessionData block unavailable');
  return main.slice(start, end);
}

describe('hydration integration shadow production wiring', () => {
  test('plans before legacy mutation and compares only after volatile and append restoration', () => {
    const block = sessionDataBlock();
    const capture = block.indexOf('const preservedHydrationState = captureVolatileHydrationState(session);');
    const plan = block.indexOf('hydrationStateController.createIntegrationShadow({', capture);
    const clear = block.indexOf('session.messagesById.clear();', plan);
    const restoreVolatile = block.indexOf('restoreVolatileHydrationState(session, preservedHydrationState);', clear);
    const restoreAppend = block.indexOf('restoreAppendHydrationMetadata(sessionId, session);', restoreVolatile);
    const compare = block.indexOf('hydrationStateController.compareIntegrationShadow(', restoreAppend);
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(capture);
    expect(clear).toBeGreaterThan(plan);
    expect(restoreVolatile).toBeGreaterThan(clear);
    expect(restoreAppend).toBeGreaterThan(restoreVolatile);
    expect(compare).toBeGreaterThan(restoreAppend);
  });

  test('keeps the legacy path as sole production writer during shadow mode', () => {
    const block = sessionDataBlock();
    expect(block).toContain('session.messagesById.clear();');
    expect(block).toContain('upsertMessage(session, {');
    expect(block).toContain("materializeInjectedChangeLists(session, rawSessionMessages, 'sessionData');");
    expect(block).toContain('applyHydratedSegments(session, segments, true);');
    expect(block).toContain('restoreVolatileHydrationState(session, preservedHydrationState);');
    expect(block).toContain('restoreAppendHydrationMetadata(sessionId, session);');
    expect(controller).not.toContain('actual.messagesById.set(');
    expect(controller).not.toContain('actual.timeline =');
    expect(controller).not.toContain('actual.segmentsByNoticeKey.set(');
  });

  test('fails shadow planning and comparison open without changing sessionData control flow', () => {
    const block = sessionDataBlock();
    expect(block).toContain("payload: ['[WV][HYDRATION_SHADOW_ERROR]', `sessionId=${sessionId}`, `phase=plan`");
    expect(block).toContain("payload: ['[WV][HYDRATION_SHADOW_ERROR]', `sessionId=${sessionId}`, `phase=compare`");
    expect(block).toContain("payload: ['[WV][HYDRATION_SHADOW]'");
    expect(block).not.toContain('throw shadowError');
    expect(block).not.toContain('return shadowComparison');
  });

  test('does not give shadow code DOM, render, virtual-window, or transport capabilities', () => {
    const shadowStart = controller.indexOf('function createIntegrationShadow(');
    const compareStart = controller.indexOf('function compareIntegrationShadow(', shadowStart);
    const returnStart = controller.indexOf('return Object.freeze({', compareStart);
    const shadowOwner = controller.slice(shadowStart, returnStart);
    expect(shadowOwner).not.toMatch(
      /document\.|window\.|postMessage|renderFromState|scrollToBottom|chatWindow|vscode|fetch\(|WebSocket/,
    );
  });
});
