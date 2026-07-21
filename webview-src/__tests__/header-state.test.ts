import { createHeaderState, recomputeSessionUsage } from '../features/header/header-state';

describe('header state', () => {
  it('prioritizes transient status text and owns waiting state', () => {
    const state = createHeaderState('Session title');
    expect(state.getDisplayTitle()).toBe('Session title');
    state.setStatusText('Waiting for previous response...');
    state.setWaiting(true);
    expect(state.getDisplayTitle()).toBe('Waiting for previous response...');
    expect(state.isWaiting()).toBe(true);
    state.setStatusText('');
    expect(state.getDisplayTitle()).toBe('Session title');
  });

  it('derives normal, hover, running, and hidden usage presentations', () => {
    const state = createHeaderState();
    expect(state.deriveUsage({ sessionId: 's', contextLimit: 0, compactDisabled: true, disabledTitle: 'disabled' }).visible).toBe(false);
    state.setUsage('s', { used: 50, size: 100, amount: 2 });
    expect(state.deriveUsage({ sessionId: 's', contextLimit: 100, compactDisabled: false, disabledTitle: '' })).toMatchObject({
      visible: true, percent: 50, high: true, compactMode: false, fillWidth: '50%', label: '50%',
    });
    state.setCompactHover(true);
    expect(state.deriveUsage({ sessionId: 's', contextLimit: 100, compactDisabled: false, disabledTitle: '' })).toMatchObject({
      high: false, compactMode: true, compactRunning: false, fillWidth: '100%', label: 'Compact',
    });
    state.setCompactionState('s', true, 100);
    expect(state.deriveUsage({ sessionId: 's', contextLimit: 100, compactDisabled: true, disabledTitle: 'disabled' })).toMatchObject({
      disabled: true, title: 'disabled', compactRunning: true, label: 'Running',
    });
  });

  it('resets usage when compaction completes without losing its context size or amount', () => {
    const state = createHeaderState();
    state.setUsage('s', { used: 80, size: 200, amount: 3 });
    state.setCompactionState('s', true, 200);
    state.setCompactionState('s', false, 200);
    expect(state.getUsage('s')).toEqual({ used: 0, size: 200, amount: 3 });
  });

  it('recomputes aggregate totals and latest context usage from assistant messages', () => {
    const usage = recomputeSessionUsage([
      { role: 'user', meta: { cost: 100 } },
      { role: 'assistant', meta: { timeCreated: 2, cost: 2, tokens: { input: 20, output: 4, reasoning: 1, cache: { read: 3, write: 2 } } } },
      { role: 'assistant', meta: { timeCreated: 1, cost: 1, tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 1, write: 1 } } } },
    ]);
    expect(usage).toEqual({ used: 29, size: 45, amount: 3 });
  });
});
