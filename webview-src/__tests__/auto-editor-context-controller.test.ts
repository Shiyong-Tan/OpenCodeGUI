import { createAutoEditorContextController } from '../features/composer/auto-editor-context-controller';
import { createComposerContextState } from '../features/composer/context-state';

describe('automatic editor context controller', () => {
  const timerWindow = {
    setTimeout: (callback: () => void, delay?: number) => setTimeout(callback, delay) as unknown as number,
    clearTimeout: (timer: number) => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>),
  } as Window;
  const context = {
    displayText: 'src/a.ts:2-3',
    text: 'selected',
    source: 'editor-auto' as const,
    filePath: 'C:\\workspace\\src\\a.ts',
    workspacePath: 'src/a.ts',
    range: { startLine: 2, endLine: 3 },
    contextKey: 'a:2-3:v1',
    automatic: true as const,
  };

  it('correlates refresh results and replaces the automatic token', async () => {
    jest.useFakeTimers();
    const state = createComposerContextState();
    const posts: any[] = [];
    const changed = jest.fn();
    const controller = createAutoEditorContextController({
      state, window: timerWindow, postMessage: (message) => posts.push(message),
      onContextChanged: changed, getScopeKey: () => 'session-a',
      createRequestId: () => 'request-1',
    });
    const refresh = controller.refresh();
    expect(posts).toEqual([{ type: 'getAutoEditorContext', requestId: 'request-1' }]);
    expect(controller.handleResult('request-1', context)).toBe(true);
    await refresh;
    expect(state.getContextItems()).toEqual([context]);
    expect(changed).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('honors dismissal for the current prompt and resets it after submission', async () => {
    jest.useFakeTimers();
    const state = createComposerContextState();
    let sequence = 0;
    const controller = createAutoEditorContextController({
      state, window: timerWindow, postMessage: () => undefined,
      onContextChanged: () => undefined, getScopeKey: () => 'session-a',
      createRequestId: () => `request-${++sequence}`,
    });
    const first = controller.refresh();
    controller.handleResult('request-1', context);
    await first;
    const item = state.getContextItems()[0];
    state.removeContext(item);
    controller.dismiss(item);

    const dismissed = controller.refresh();
    controller.handleResult('request-2', context);
    await dismissed;
    expect(state.getContextItems()).toEqual([]);

    state.clear();
    const restored = controller.refresh();
    controller.handleResult('request-3', context);
    await restored;
    expect(state.getContextItems()).toEqual([context]);
    jest.useRealTimers();
  });
});
