import type { SessionEnvelope } from '../../src/session-runtime/protocol';
import { createSessionSelectionController } from '../session-runtime/session-selection-controller';
import { createSessionViewStore } from '../session-runtime/session-view-store';

type ViewEvent = SessionEnvelope<'append', Readonly<{ value: string }>>;
type ViewState = Readonly<{
  sessionId: string;
  sessionEpoch: number;
  values: readonly string[];
}>;

function owned(
  sessionId: string,
  sequence: number,
  value: string,
  sessionEpoch = 1,
): ViewEvent {
  return {
    type: 'append',
    sessionId,
    sessionEpoch,
    sequence,
    payload: { value },
  };
}

function createStore() {
  return createSessionViewStore<ViewState, ViewEvent>({
    createInitialState: (sessionId, sessionEpoch) => ({
      sessionId,
      sessionEpoch,
      values: [],
    }),
    reduce: (state, event) => ({
      state: {
        ...state,
        values: [...state.values, event.payload.value],
      },
    }),
  });
}

describe('Webview isolated session runtime', () => {
  test('updates only the owned session and rejects stale traffic', () => {
    const store = createStore();

    expect(store.apply(owned('A', 1, 'a1'))).toMatchObject({ accepted: true });
    expect(store.apply(owned('B', 1, 'b1'))).toMatchObject({ accepted: true });
    expect(store.apply(owned('A', 2, 'a2'))).toMatchObject({ accepted: true });
    expect(store.apply(owned('A', 2, 'duplicate'))).toMatchObject({
      accepted: false,
      reason: 'duplicate-or-stale-sequence',
    });

    expect(store.get('A')?.values).toEqual(['a1', 'a2']);
    expect(store.get('B')?.values).toEqual(['b1']);
  });

  test('resets only the target view state on a new session epoch', () => {
    const store = createStore();
    store.apply(owned('A', 1, 'old A'));
    store.apply(owned('B', 1, 'stable B'));
    store.apply(owned('A', 1, 'new A', 2));

    expect(store.get('A')).toEqual({
      sessionId: 'A',
      sessionEpoch: 2,
      values: ['new A'],
    });
    expect(store.get('B')?.values).toEqual(['stable B']);
  });

  test('notifies ownership without knowing which session is visible', () => {
    const store = createStore();
    const updates: string[] = [];
    store.subscribe((update) => updates.push(`${update.sessionId}:${update.state.values.join(',')}`));

    store.apply(owned('A', 1, 'a'));
    store.apply(owned('B', 1, 'b'));

    expect(updates).toEqual(['A:a', 'B:b']);
  });

  test('selection renders only the selected session and always scrolls it to bottom', () => {
    const renders: string[] = [];
    const scrolls: string[] = [];
    const selection = createSessionSelectionController({
      renderSession: (sessionId, reason) => renders.push(`${sessionId}:${reason}`),
      scrollSessionToBottom: (sessionId, force) => scrolls.push(`${sessionId}:${force}`),
    });

    selection.select('A');
    expect(selection.handleSessionUpdated('B', 'background-chunk')).toBe(false);
    expect(selection.handleSessionUpdated('A', 'active-chunk')).toBe(true);
    selection.select('B');
    selection.select('A');

    expect(selection.getVisibleSessionId()).toBe('A');
    expect(renders).toEqual([
      'A:session-selected',
      'A:active-chunk',
      'B:session-selected',
      'A:session-selected',
    ]);
    expect(scrolls).toEqual(['A:true', 'B:true', 'A:true']);
  });

  test('rejects hydration belonging to an older selection or request', () => {
    const renders: string[] = [];
    const applied: string[] = [];
    const selection = createSessionSelectionController({
      renderSession: (sessionId, reason) => renders.push(`${sessionId}:${reason}`),
      scrollSessionToBottom: () => undefined,
    });

    const selectedA = selection.select('A');
    const hydrationA1 = selection.beginHydration('A');
    const hydrationA2 = selection.beginHydration('A');
    expect(selection.commitHydration(hydrationA1, () => applied.push('A1'))).toBe(false);
    expect(selection.commitHydration(hydrationA2, () => applied.push('A2'))).toBe(true);

    selection.select('B');
    expect(selection.commitHydration(selectedA, () => applied.push('selectedA'))).toBe(false);
    expect(selection.commitHydration(hydrationA2, () => applied.push('lateA2'))).toBe(false);
    expect(applied).toEqual(['A2']);
    expect(renders).toEqual([
      'A:session-selected',
      'A:session-hydrated',
      'B:session-selected',
    ]);
  });
});
