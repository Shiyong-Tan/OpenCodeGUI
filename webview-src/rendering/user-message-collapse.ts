export type UserMessageCollapsePlan = Readonly<{
  collapsed: boolean;
  preview: string;
  full: string;
  totalLineCount: number;
  hiddenLineCount: number;
}>;

const MIN_COLLAPSE_LINES = 8;
const LONG_TEXT_CODE_UNITS = 1000;
const PREVIEW_LINES = 2;

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n');
}

function shouldCollapse(lines: readonly string[], codeUnitCount: number): boolean {
  return lines.length >= MIN_COLLAPSE_LINES
    || (lines.length > PREVIEW_LINES && codeUnitCount >= LONG_TEXT_CODE_UNITS);
}

function fencedPreview(lines: readonly string[]): { preview: string; hiddenLineCount: number } | null {
  const preview: string[] = [];
  let hiddenLineCount = 0;
  let foundLongFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (!opening) {
      preview.push(lines[index]);
      continue;
    }

    const marker = opening[1][0];
    const markerLength = opening[1].length;
    let closingIndex = index + 1;
    for (; closingIndex < lines.length; closingIndex += 1) {
      const trimmed = lines[closingIndex].trim();
      const markerRun = trimmed.match(marker === '`' ? /^`+/ : /^~+/)?.[0]?.length || 0;
      if (markerRun >= markerLength && trimmed.slice(markerRun).trim() === '') break;
    }
    if (closingIndex >= lines.length) {
      preview.push(lines[index]);
      continue;
    }

    const contentLineCount = closingIndex - index - 1;
    preview.push(lines[index]);
    if (contentLineCount >= MIN_COLLAPSE_LINES) {
      foundLongFence = true;
      preview.push(...lines.slice(index + 1, index + 1 + PREVIEW_LINES));
      hiddenLineCount += Math.max(0, contentLineCount - PREVIEW_LINES);
    } else {
      preview.push(...lines.slice(index + 1, closingIndex));
    }
    preview.push(lines[closingIndex]);
    index = closingIndex;
  }

  return foundLongFence ? { preview: preview.join('\n'), hiddenLineCount } : null;
}

/**
 * Plans a bounded preview without changing the canonical user text. The full
 * value remains the only value sent, copied, and persisted by the caller.
 */
export function planUserMessageCollapse(value: unknown): UserMessageCollapsePlan {
  const full = typeof value === 'string' ? value : '';
  const lines = normalizeLines(full);
  const fenced = fencedPreview(lines);
  if (fenced) {
    return Object.freeze({
      collapsed: true,
      preview: fenced.preview,
      full,
      totalLineCount: lines.length,
      hiddenLineCount: fenced.hiddenLineCount,
    });
  }
  if (!shouldCollapse(lines, full.length)) {
    return Object.freeze({
      collapsed: false,
      preview: full,
      full,
      totalLineCount: lines.length,
      hiddenLineCount: 0,
    });
  }

  const preview = lines.slice(0, PREVIEW_LINES).join('\n');
  return Object.freeze({
    collapsed: true,
    preview,
    full,
    totalLineCount: lines.length,
    hiddenLineCount: Math.max(0, lines.length - PREVIEW_LINES),
  });
}
