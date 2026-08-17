export type InlineMathTitleSegment = {
  type: 'text' | 'math';
  value: string;
};

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function parseInlineMathTitle(value: string): InlineMathTitleSegment[] {
  const input = String(value || '');
  const segments: InlineMathTitleSegment[] = [];
  let text = '';
  const pushText = (): void => {
    if (!text) return;
    segments.push({ type: 'text', value: text });
    text = '';
  };

  for (let index = 0; index < input.length;) {
    if (input[index] === '$' && input[index + 1] === '$') {
      const closing = input.indexOf('$$', index + 2);
      if (closing >= 0) {
        text += input.slice(index, closing + 2);
        index = closing + 2;
      } else {
        text += '$$';
        index += 2;
      }
      continue;
    }
    if (input[index] === '\\' && input[index + 1] === '$') {
      text += '$';
      index += 2;
      continue;
    }
    if (input[index] !== '$' || input[index + 1] === '$' || isEscaped(input, index)) {
      text += input[index];
      index += 1;
      continue;
    }
    let closing = index + 1;
    while (closing < input.length) {
      if (
        input[closing] === '$'
        && input[closing + 1] !== '$'
        && !isEscaped(input, closing)
      ) break;
      if (input[closing] === '\n') break;
      closing += 1;
    }
    if (closing >= input.length || input[closing] !== '$' || closing === index + 1) {
      text += '$';
      index += 1;
      continue;
    }
    pushText();
    segments.push({ type: 'math', value: input.slice(index + 1, closing) });
    index = closing + 1;
  }
  pushText();
  return segments;
}

export function createInlineMathTitleRenderer(options: {
  document: Document;
  renderMath(source: string, element: HTMLElement): void;
}): (element: HTMLElement, title: string) => void {
  return (element, title) => {
    const segments = parseInlineMathTitle(title);
    if (!segments.some((segment) => segment.type === 'math')) {
      element.textContent = title;
      return;
    }
    const nodes: Node[] = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        nodes.push(options.document.createTextNode(segment.value));
        continue;
      }
      const math = options.document.createElement('span');
      math.className = 'session-title-math';
      try {
        options.renderMath(segment.value, math);
      } catch {
        math.textContent = `$${segment.value}$`;
      }
      nodes.push(math);
    }
    element.replaceChildren(...nodes);
  };
}
