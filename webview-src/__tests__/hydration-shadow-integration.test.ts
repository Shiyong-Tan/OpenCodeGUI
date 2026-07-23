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

describe('hydration integration production activation', () => {
  test('prepares once and applies through the hydration controller', () => {
    const block = sessionDataBlock();
    const capture = block.indexOf('const preservedHydrationState = captureVolatileHydrationState(session);');
    const prepare = block.indexOf('hydrationStateController.prepareIntegration({', capture);
    const apply = block.indexOf('hydrationStateController.applyIntegration(', prepare);
    const diagnostics = block.indexOf('const skippedTimelineArtifacts =', apply);
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(capture);
    expect(apply).toBeGreaterThan(prepare);
    expect(diagnostics).toBeGreaterThan(apply);
  });

  test('removes the duplicated legacy sessionData hydration writers', () => {
    const block = sessionDataBlock();
    expect(block).not.toContain('session.messagesById.clear();');
    expect(block).not.toContain('materializeInjectedChangeLists(session, rawSessionMessages');
    expect(block).not.toContain('applyHydratedSegments(session, segments, true);');
    expect(block).not.toContain('restoreVolatileHydrationState(session, preservedHydrationState);');
    expect(block).not.toContain('restoreAppendHydrationMetadata(sessionId, session);');
    expect(block).not.toContain('[WV][HYDRATION_SHADOW]');
    expect(block).not.toContain('[WV][HYDRATION_SHADOW_ERROR]');
  });

  test('keeps render, snapshot, identity, and append side effects explicit', () => {
    const block = sessionDataBlock();
    expect(block).toContain('messageIdentityStore.store(messagesById, item)');
    expect(block).toContain('createSnapshotNotice: () => ({');
    expect(block).toContain("syncAppendSnapshotMetadata(sessionId, 'sessionData-hydrate');");
    expect(block).toContain("renderIfActive(sessionId, 'sessionData'");
    expect(block).toContain("renderIfActive(sessionId, 'sessionData-finally'");
    expect(main).toMatch(
      /session\.appendFollowupIdentity = \{ \.\.\.followup \};\s*if \(session\.pendingAssistantUpgrade\?\.assistantMsgId !== followup\.assistantMsgId\) \{\s*session\.pendingAssistantUpgrade = null;\s*session\.awaitingFinalMapBind = false;/,
    );
  });

  test('does not give the hydration application owner DOM, render, or transport access', () => {
    const applyStart = controller.indexOf('function applyIntegration(');
    const compareStart = controller.indexOf('const stableValue', applyStart);
    const applicationOwner = controller.slice(applyStart, compareStart);
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(applicationOwner).not.toMatch(
      /document\.|window\.|postMessage|renderFromState|scrollToBottom|chatWindow|vscode|fetch\(|WebSocket/,
    );
  });
});
