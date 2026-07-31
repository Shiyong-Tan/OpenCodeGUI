import {
  appendAssistantProcessingTime,
  formatProcessingDuration,
  resolveAssistantProcessingTime,
  updateAssistantProcessingTimeElements,
} from '../rendering/processing-time';

describe('assistant processing time', () => {
  test.each([
    [0, '0s'],
    [18_999, '18s'],
    [60_000, '1min 0s'],
    [138_000, '2min 18s'],
    [5_418_000, '1h 30min 18s'],
    [93_784_000, '1d 2h 3min 4s'],
  ])('formats %i milliseconds as %s', (durationMs, expected) => {
    expect(formatProcessingDuration(durationMs)).toBe(expected);
  });

  test('uses the current time while an assistant is active', () => {
    expect(resolveAssistantProcessingTime({
      role: 'assistant',
      meta: { isThinking: true, processingStartedAt: 1_000, processingCompletedAt: 2_000 },
    }, 4_500)).toEqual({ startedAt: 1_000, completedAt: null, durationMs: 3_500 });
  });

  test('freezes completed messages and supports exported history timestamps', () => {
    expect(resolveAssistantProcessingTime({
      role: 'assistant',
      meta: { isThinking: false, timeCreated: 10_000, timeCompleted: 75_000 },
    }, 999_999)).toEqual({ startedAt: 10_000, completedAt: 75_000, durationMs: 65_000 });
  });

  test('does not add timing to messages without a known start', () => {
    expect(resolveAssistantProcessingTime({ role: 'assistant', meta: {} }, 5_000)).toBeNull();
    expect(resolveAssistantProcessingTime({ role: 'user', meta: { processingStartedAt: 1_000 } }, 5_000)).toBeNull();
  });

  test('updates only active timing elements and leaves completed timing frozen', () => {
    const previousDocument = (global as any).document;
    const children: any[] = [];
    (global as any).document = {
      createElement: () => ({ dataset: {}, textContent: '', className: '', title: '' }),
    };
    const root = {
      appendChild: (element: any) => children.push(element),
      querySelectorAll: () => children.filter((element) => element.dataset.completedAt === ''),
    };
    try {
      const active = appendAssistantProcessingTime(root, {
        role: 'assistant', meta: { isThinking: true, processingStartedAt: 1_000 },
      }, 2_000);
      const completed = appendAssistantProcessingTime(root, {
        role: 'assistant', meta: { isThinking: false, processingStartedAt: 1_000, processingCompletedAt: 3_000 },
      }, 9_000);

      expect(active.textContent).toBe('1s');
      expect(completed.textContent).toBe('2s');
      expect(updateAssistantProcessingTimeElements(root, 6_000)).toBe(1);
      expect(active.textContent).toBe('5s');
      expect(completed.textContent).toBe('2s');
    } finally {
      (global as any).document = previousDocument;
    }
  });
});
