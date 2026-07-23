import * as fs from 'fs';
import * as path from 'path';

describe('turn lifecycle production integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const hydrationSource = fs.readFileSync(
    path.join(process.cwd(), 'webview-src', 'continuation', 'hydration-state-controller.ts'),
    'utf8',
  );

  test('uses one controller for start, backend signals, main final, and effect completion', () => {
    expect(source).toContain(
      'const turnLifecycleController = window.__ocContinuation?.createTurnLifecycleController?.();',
    );
    expect(source).toContain('turnLifecycleController.start(session);');
    expect(source).toContain(
      'turnLifecycleController.setBackendInFlight(session, Boolean(message?.inFlight))',
    );
    expect(source).toContain('turnLifecycleController.acceptMainFinal(session, resolvedFinal)');
    expect(source).toContain('turnLifecycleController.completeEffects(session);');
    expect(source).toContain('turnLifecycleController.cancel(session);');
    expect(source).not.toContain('turnLifecycleController.hydrateAuthoritative(session);');
    expect(hydrationSource).toContain("phase: 'effects-finalized'");
    expect(hydrationSource).toContain("session[name] = clonePlainValue(state[name])");
    expect(source).toContain('turnLifecycleController.reconcileProjection(session);');
  });

  test('gates assistant metadata and chunks through the monotonic lifecycle', () => {
    expect(
      source.match(/!turnLifecycleController\.canAcceptAssistantActivity\(session,/g),
    ).toHaveLength(3);
    expect(source).toContain("'drop-terminal-turn'");
  });
});
