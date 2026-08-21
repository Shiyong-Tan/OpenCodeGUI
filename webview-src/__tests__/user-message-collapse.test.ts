import { planUserMessageCollapse } from '../rendering/user-message-collapse';

describe('user message collapse planner', () => {
  test('keeps short user messages unchanged', () => {
    expect(planUserMessageCollapse('one\ntwo\nthree')).toEqual({
      collapsed: false,
      preview: 'one\ntwo\nthree',
      full: 'one\ntwo\nthree',
      totalLineCount: 3,
      hiddenLineCount: 0,
    });
  });

  test('shows two lines while retaining the complete pasted output', () => {
    const full = Array.from({ length: 12 }, (_, index) => `output ${index + 1}`).join('\r\n');
    expect(planUserMessageCollapse(full)).toEqual({
      collapsed: true,
      preview: 'output 1\noutput 2',
      full,
      totalLineCount: 12,
      hiddenLineCount: 10,
    });
  });

  test('collapses a long multiline payload even below the line threshold', () => {
    const full = `${'x'.repeat(600)}\n${'y'.repeat(600)}\nquestion?`;
    const plan = planUserMessageCollapse(full);
    expect(plan.collapsed).toBe(true);
    expect(plan.preview).toBe(`${'x'.repeat(600)}\n${'y'.repeat(600)}`);
    expect(plan.hiddenLineCount).toBe(1);
    expect(plan.full).toBe(full);
  });

  test('collapses only a long fenced block while keeping surrounding prose visible', () => {
    const code = Array.from({ length: 9 }, (_, index) => `print(${index})`).join('\n');
    const full = `Please inspect this output:\n\n\`\`\`python\n${code}\n\`\`\`\n\nIs the final value correct?`;
    const plan = planUserMessageCollapse(full);

    expect(plan.collapsed).toBe(true);
    expect(plan.preview).toContain('Please inspect this output:');
    expect(plan.preview).toContain('print(0)\nprint(1)');
    expect(plan.preview).not.toContain('print(2)');
    expect(plan.preview).toContain('Is the final value correct?');
    expect(plan.hiddenLineCount).toBe(7);
    expect(plan.full).toBe(full);
  });
});
