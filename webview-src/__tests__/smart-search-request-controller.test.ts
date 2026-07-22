import { createSessionSearchState } from '../features/search/search-state';
import { createSmartSearchRequestController } from '../features/search/smart-search-request-controller';

describe('Smart Search request controller', () => {
  it('posts one session-scoped request and enters in-flight state', () => {
    const state = createSessionSearchState();
    state.setTextQuery('find the reload issue');
    const posted: any[] = [];
    const controller = createSmartSearchRequestController({
      state,
      clearHighlights: () => undefined,
      updateControls: () => undefined,
      collectMessages: () => [{ id: 'm1', role: 'user', text: 'reload issue' }],
      getSessionId: () => 'session-a',
      postMessage: (message) => posted.push(message),
      createRequestId: () => 'request-a',
    });
    expect(controller.run()).toBe(true);
    expect(state.snapshot()).toMatchObject({ smartInFlight: true, smartRequestId: 'request-a', mode: 'smart' });
    expect(posted).toEqual([{
      type: 'smartSessionSearch', requestId: 'request-a', sessionId: 'session-a', query: 'find the reload issue',
      messages: [{ id: 'm1', role: 'user', text: 'reload issue' }],
    }]);
    expect(controller.run()).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it('reports an empty Smart result without sending a request', () => {
    const state = createSessionSearchState();
    state.setTextQuery('query');
    let cleared = 0;
    let updated = 0;
    const controller = createSmartSearchRequestController({
      state,
      clearHighlights: () => { cleared += 1; },
      updateControls: () => { updated += 1; },
      collectMessages: () => [],
      getSessionId: () => 'session-a',
      postMessage: () => { throw new Error('must not post'); },
      createRequestId: () => 'unused',
    });
    expect(controller.run()).toBe(false);
    expect(state.snapshot()).toMatchObject({ mode: 'smart', smartInFlight: false, smartMessageIds: [] });
    expect({ cleared, updated }).toEqual({ cleared: 1, updated: 1 });
  });
});
