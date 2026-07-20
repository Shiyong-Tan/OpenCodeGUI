export type SafeShellMode = 'normal-rich' | 'safe-shell';

export type SafeShellFamily =
  | 'message-user'
  | 'message-assistant'
  | 'message-tool-meta'
  | 'message-subagent'
  | 'change-list'
  | 'segment'
  | 'conflict'
  | 'message-image'
  | 'message-code'
  | 'message-diff'
  | 'message-table'
  | 'message-markdown';

type SafeShellAction =
  | 'open-full'
  | 'previous'
  | 'next'
  | 'close'
  | 'copy-full'
  | 'append'
  | 'undo'
  | 'open-file'
  | 'open-diff'
  | 'restore'
  | 'toggle'
  | 'skip'
  | 'override';

interface ShellBudget {
  readonly collapsedDescendants: number;
  readonly openDescendants: number;
  readonly rootDirectChildren: number;
}

interface FamilyDefinition {
  readonly title: string;
  readonly budgets: ShellBudget;
  readonly actions: readonly SafeShellAction[];
  readonly primary?: { readonly shapeKey: ShapeCountKey; readonly limit: number };
  readonly content: boolean;
  readonly table: boolean;
}

type ShapeCountKey = 'itemCount' | 'imageCount' | 'blockCount';

type UnknownRecord = Record<string, unknown>;

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_CODE_UNITS = 8_192;
const MAX_LOGICAL_LINES = 40;

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

const actions = (...values: SafeShellAction[]): readonly SafeShellAction[] => freeze(values);
const budget = (collapsedDescendants: number, openDescendants: number): ShellBudget => freeze({
  collapsedDescendants,
  openDescendants,
  rootDirectChildren: 5,
});

const FAMILY_DEFINITIONS: Readonly<Record<SafeShellFamily, FamilyDefinition>> = freeze({
  'message-user': freeze({
    title: 'User message', budgets: budget(40, 48),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full', 'append', 'undo'),
    content: true, table: false,
  }),
  'message-assistant': freeze({
    title: 'Assistant message', budgets: budget(40, 48),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full', 'open-file'),
    content: true, table: false,
  }),
  'message-tool-meta': freeze({
    title: 'Tool or system message', budgets: budget(44, 52),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full'),
    content: true, table: false,
  }),
  'message-subagent': freeze({
    title: 'Subagent', budgets: budget(48, 64),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full'),
    primary: freeze({ shapeKey: 'itemCount', limit: 6 }), content: true, table: false,
  }),
  'change-list': freeze({
    title: 'Change list', budgets: budget(56, 72),
    actions: actions('open-full', 'previous', 'next', 'close', 'open-file', 'open-diff'),
    primary: freeze({ shapeKey: 'itemCount', limit: 8 }), content: false, table: false,
  }),
  segment: freeze({
    title: 'Segment', budgets: budget(56, 72),
    actions: actions('open-full', 'previous', 'next', 'close', 'restore', 'toggle'),
    primary: freeze({ shapeKey: 'itemCount', limit: 6 }), content: false, table: false,
  }),
  conflict: freeze({
    title: 'Conflict', budgets: budget(64, 80),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full', 'open-diff', 'skip', 'override'),
    primary: freeze({ shapeKey: 'itemCount', limit: 6 }), content: true, table: false,
  }),
  'message-image': freeze({
    title: 'Image', budgets: budget(32, 40),
    actions: actions('open-full', 'previous', 'next', 'close'),
    primary: freeze({ shapeKey: 'imageCount', limit: 1 }), content: false, table: false,
  }),
  'message-code': freeze({
    title: 'Code', budgets: budget(40, 52),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full'),
    primary: freeze({ shapeKey: 'blockCount', limit: 1 }), content: true, table: false,
  }),
  'message-diff': freeze({
    title: 'Diff', budgets: budget(40, 52),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full'),
    content: true, table: false,
  }),
  'message-table': freeze({
    title: 'Table', budgets: budget(56, 88),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full'),
    content: false, table: true,
  }),
  'message-markdown': freeze({
    title: 'Markdown', budgets: budget(40, 52),
    actions: actions('open-full', 'previous', 'next', 'close', 'copy-full', 'open-file'),
    content: true, table: false,
  }),
});

const FAMILY_NAMES = freeze(Object.keys(FAMILY_DEFINITIONS) as SafeShellFamily[]);
const FAMILY_SET: ReadonlySet<string> = new Set(FAMILY_NAMES);
const MODE_SET: ReadonlySet<string> = new Set(['normal-rich', 'safe-shell']);

const ACTION_LABELS: Readonly<Record<SafeShellAction, string>> = freeze({
  'open-full': 'Open full',
  previous: 'Previous',
  next: 'Next',
  close: 'Close',
  'copy-full': 'Copy full',
  append: 'Append',
  undo: 'Undo',
  'open-file': 'Open file',
  'open-diff': 'Open diff',
  restore: 'Restore',
  toggle: 'Toggle',
  skip: 'Skip',
  override: 'Override',
});

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeKnownCount = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_COUNT, Math.floor(value));
};

const normalizePage = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_COUNT, Math.floor(value));
};

const pageCount = (canonicalCount: number, limit: number): number => (
  Math.max(1, Math.ceil(canonicalCount / limit))
);

const safeStart = (index: number, limit: number): number => (
  Math.min(MAX_COUNT, (index - 1) * limit)
);

const buildAxis = (requestedPage: unknown, canonicalCount: number | null, limit: number) => {
  const requested = normalizePage(requestedPage);
  const extentKnown = canonicalCount !== null;
  const total = extentKnown ? pageCount(canonicalCount, limit) : null;
  const index = total === null ? requested : Math.min(requested, total);
  const atCanonicalEnd = total === null ? false : index === total;
  return freeze({
    index,
    total,
    limit,
    start: safeStart(index, limit),
    canonicalCount,
    extentKnown,
    hasPrevious: index > 1,
    hasNext: total === null ? true : index < total,
    atCanonicalEnd,
    label: total === null ? `page ${index} of unknown extent` : `page ${index} of ${total}`,
  });
};

const buildContentPage = (requestedPage: unknown, shape: UnknownRecord) => {
  const codeUnitCount = normalizeKnownCount(shape.codeUnitCount);
  const lineCount = normalizeKnownCount(shape.lineCount);
  const extentKnown = codeUnitCount !== null && lineCount !== null;
  const total = extentKnown
    ? Math.max(1, Math.ceil(codeUnitCount / MAX_CODE_UNITS), Math.ceil(lineCount / MAX_LOGICAL_LINES))
    : null;
  const requested = normalizePage(requestedPage);
  const index = total === null ? requested : Math.min(requested, total);
  return freeze({
    index,
    total,
    maxCodeUnits: MAX_CODE_UNITS,
    maxLines: MAX_LOGICAL_LINES,
    extentKnown,
    hasPrevious: index > 1,
    hasNext: total === null ? true : index < total,
    atCanonicalEnd: total === null ? false : index === total,
    label: total === null ? `page ${index} of unknown extent` : `page ${index} of ${total}`,
  });
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as UnknownRecord)) deepFreeze(child);
  return Object.freeze(value);
};

/**
 * Returns the dormant, data-only rendering contract for one reviewed family.
 * Unknown modes or families are denied; this function never selects a mode.
 *
 * Args:
 *   input: Untrusted mode, family, page, and canonical-shape metadata.
 *
 * Returns:
 *   A deeply immutable bounded contract, or a deterministic denial descriptor.
 */
export function getSafeShellSpec(input: unknown) {
  const record = isRecord(input) ? input : {};
  if (typeof record.mode !== 'string' || !MODE_SET.has(record.mode)) {
    return freeze({ allowed: false as const, reason: 'unknown-mode' as const });
  }
  if (typeof record.family !== 'string' || !FAMILY_SET.has(record.family)) {
    return freeze({ allowed: false as const, reason: 'unknown-family' as const });
  }

  const mode = record.mode as SafeShellMode;
  const family = record.family as SafeShellFamily;
  const definition = FAMILY_DEFINITIONS[family];
  const shape = isRecord(record.shape) ? record.shape : {};
  const pages: UnknownRecord = {};

  if (definition.primary) {
    pages.primary = buildAxis(record.page, normalizeKnownCount(shape[definition.primary.shapeKey]), definition.primary.limit);
  }
  if (definition.content) pages.content = buildContentPage(record.contentPage, shape);
  if (definition.table) {
    pages.rows = buildAxis(record.page, normalizeKnownCount(shape.rowCount), 8);
    pages.columns = buildAxis(record.columnPage, normalizeKnownCount(shape.columnCount), 6);
  }

  const firstPage = (pages.primary || pages.content || pages.rows) as { label: string };
  const labels = {
    title: definition.title,
    page: firstPage.label,
    actions: definition.actions.reduce<Record<string, string>>((result, action) => {
      result[action] = ACTION_LABELS[action];
      return result;
    }, {}),
  };

  return deepFreeze({
    allowed: true as const,
    mode,
    family,
    shellSelected: mode === 'safe-shell',
    budgets: definition.budgets,
    actions: definition.actions,
    labels,
    page: pages,
  });
}
