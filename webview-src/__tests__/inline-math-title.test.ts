import { createInlineMathTitleRenderer, parseInlineMathTitle } from '../features/header/inline-math-title';

describe('inline math session titles', () => {
  test('keeps ordinary title text unchanged', () => {
    expect(parseInlineMathTitle('Experiment results')).toEqual([
      { type: 'text', value: 'Experiment results' },
    ]);
  });

  test('extracts one or more inline formulas without enabling other Markdown', () => {
    expect(parseInlineMathTitle('Loss $L_2$ at $t=4$')).toEqual([
      { type: 'text', value: 'Loss ' },
      { type: 'math', value: 'L_2' },
      { type: 'text', value: ' at ' },
      { type: 'math', value: 't=4' },
    ]);
  });

  test('leaves block delimiters and unmatched dollars as text', () => {
    expect(parseInlineMathTitle('Result $$x^2$$ and $open')).toEqual([
      { type: 'text', value: 'Result $$x^2$$ and $open' },
    ]);
  });

  test('supports a literal escaped dollar', () => {
    expect(parseInlineMathTitle('Cost \\$5 and $x$')).toEqual([
      { type: 'text', value: 'Cost $5 and ' },
      { type: 'math', value: 'x' },
    ]);
  });

  test('renders math segments while preserving surrounding text nodes', () => {
    const created: any[] = [];
    const document = {
      createTextNode: (value: string) => ({ type: 'text', value }),
      createElement: () => {
        const element = { className: '', textContent: '' };
        created.push(element);
        return element;
      },
    } as any;
    const host = { textContent: '', replaceChildren: jest.fn() } as any;
    const renderMath = jest.fn((source: string, element: any) => { element.rendered = source; });
    const render = createInlineMathTitleRenderer({ document, renderMath });

    render(host, 'Loss $L_2$');

    expect(renderMath).toHaveBeenCalledWith('L_2', created[0]);
    expect(created[0].className).toBe('session-title-math');
    expect(host.replaceChildren).toHaveBeenCalledWith(
      { type: 'text', value: 'Loss ' },
      created[0],
    );
  });
});
