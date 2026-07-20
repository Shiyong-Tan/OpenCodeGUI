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

export interface ChatWindowContainmentInput {
  readonly requestedKeys: readonly string[];
  readonly visibleLoadedKeys: readonly string[];
  readonly viewportKeys?: readonly string[];
  readonly coreKeys?: readonly string[];
  readonly overscanKeys?: readonly string[];
  readonly adapterSnapshotKeys?: readonly string[];
  readonly currentTurnAssistantKey?: string;
  readonly thinkingId?: string;
  readonly lastTurnUserId?: string;
  readonly appendRootUserKey?: string;
  readonly anchorKey?: string;
  readonly searchTargetKey?: string;
  readonly projectedStructuralRoots: number;
  readonly limits: {
    readonly mounted: number;
    readonly directChildren: number;
  };
  readonly shellRequests?: readonly {
    readonly key: string;
    readonly mode: 'safe-shell';
    readonly family: SafeShellFamily;
  }[];
}

type PinRole =
  | 'current-streaming-assistant'
  | 'thinking-alias'
  | 'paired-active-user'
  | 'append-root'
  | 'reading-anchor'
  | 'search-target';

type DeferredPinReason = 'not-requested' | 'not-visible-loaded' | 'capacity';
type ShellDenialReason = 'unknown-family' | 'invalid-mode' | 'key-not-accepted' | 'invalid-request';

export interface ChatWindowContainmentResult {
  readonly allowed: boolean;
  readonly reason: 'accepted' | 'impossible-structural-roots';
  readonly acceptedKeys: readonly string[];
  readonly mountedCount: number;
  readonly directChildCount: number;
  readonly projectedStructuralRoots: number;
  readonly deferredPins: readonly {
    readonly key: string;
    readonly role: PinRole;
    readonly reason: DeferredPinReason;
  }[];
  readonly shellSelections: Readonly<Record<string, Readonly<{
    mode: 'safe-shell';
    family: SafeShellFamily;
  }>>>;
  readonly deniedShellRequests: readonly {
    readonly key: string;
    readonly reason: ShellDenialReason;
  }[];
}

export type ChatWindowCorruptionCode =
  | 'duplicate-keyed-root'
  | 'missing-accepted-keyed-root'
  | 'unexpected-keyed-root'
  | 'unclassified-direct-root'
  | 'root-map-dom-mismatch'
  | 'active-spacer-missing-or-duplicated'
  | 'adapter-session-generation-mismatch';

export type ChatWindowIntegrityInput =
  | Readonly<{ code: 'duplicate-keyed-root'; expected: 1; actual: number }>
  | Readonly<{ code: 'missing-accepted-keyed-root'; expected: true; actual: boolean }>
  | Readonly<{ code: 'unexpected-keyed-root'; expected: false; actual: boolean }>
  | Readonly<{ code: 'unclassified-direct-root'; expected: 0; actual: number }>
  | Readonly<{
    code: 'root-map-dom-mismatch';
    expected: readonly string[];
    actual: readonly string[];
  }>
  | Readonly<{ code: 'active-spacer-missing-or-duplicated'; expected: 1; actual: number }>
  | Readonly<{
    code: 'adapter-session-generation-mismatch';
    expected: number;
    actual: number;
  }>;

export type ChatWindowIntegrityResult =
  | Readonly<{ corrupt: false }>
  | Readonly<{ corrupt: true; code: ChatWindowCorruptionCode }>;

type UnknownRecord = Record<string, unknown>;

const HARD_MOUNTED_LIMIT = 140;
const HARD_DIRECT_CHILD_LIMIT = 146;

const SAFE_SHELL_FAMILIES: ReadonlySet<string> = new Set([
  'message-user',
  'message-assistant',
  'message-tool-meta',
  'message-subagent',
  'change-list',
  'segment',
  'conflict',
  'message-image',
  'message-code',
  'message-diff',
  'message-table',
  'message-markdown',
]);

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const boundedInteger = (value: unknown, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maximum, Math.floor(value));
};

const structuralCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
};

const keyValue = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

const uniqueKeys = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const key = keyValue(candidate);
    if (key !== null && !seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as UnknownRecord)) deepFreeze(child);
  return Object.freeze(value);
};

const INTEGRITY_OK: ChatWindowIntegrityResult = Object.freeze({ corrupt: false });

const nonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= 0
);

const exactUniqueKeyList = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) return false;
    seen.add(candidate);
  }
  return true;
};

const unequalKeyLists = (expected: readonly string[], actual: readonly string[]): boolean => (
  expected.length !== actual.length
  || expected.some((key, index) => actual[index] !== key)
);

/**
 * Classifies only closed, machine-observable chat-window postcondition failures.
 * Unknown evidence, exceptions, and pressure signals have no effect.
 *
 * Args:
 *   input: An untrusted closed code with its exact expected and actual values.
 *
 * Returns:
 *   A frozen corruption classification with a code only when its predicate holds.
 */
export function classifyChatWindowIntegrity(input: unknown): ChatWindowIntegrityResult {
  if (!isRecord(input)) return INTEGRITY_OK;

  let corrupt = false;
  switch (input.code) {
    case 'duplicate-keyed-root':
      corrupt = input.expected === 1 && nonNegativeInteger(input.actual) && input.actual > 1;
      break;
    case 'missing-accepted-keyed-root':
      corrupt = input.expected === true && input.actual === false;
      break;
    case 'unexpected-keyed-root':
      corrupt = input.expected === false && input.actual === true;
      break;
    case 'unclassified-direct-root':
      corrupt = input.expected === 0 && nonNegativeInteger(input.actual) && input.actual > 0;
      break;
    case 'root-map-dom-mismatch':
      corrupt = exactUniqueKeyList(input.expected)
        && exactUniqueKeyList(input.actual)
        && unequalKeyLists(input.expected, input.actual);
      break;
    case 'active-spacer-missing-or-duplicated':
      corrupt = input.expected === 1 && nonNegativeInteger(input.actual) && input.actual !== 1;
      break;
    case 'adapter-session-generation-mismatch':
      corrupt = nonNegativeInteger(input.expected)
        && nonNegativeInteger(input.actual)
        && input.expected !== input.actual;
      break;
    default:
      return INTEGRITY_OK;
  }

  return corrupt
    ? Object.freeze({ corrupt: true, code: input.code as ChatWindowCorruptionCode })
    : INTEGRITY_OK;
}

const emptyDeniedResult = (projectedStructuralRoots: number): ChatWindowContainmentResult => deepFreeze({
  allowed: false,
  reason: 'impossible-structural-roots',
  acceptedKeys: [],
  mountedCount: 0,
  directChildCount: projectedStructuralRoots,
  projectedStructuralRoots,
  deferredPins: [],
  shellSelections: {},
  deniedShellRequests: [],
});

/**
 * Computes a deterministic, bounded chat-window selection without observing or
 * mutating DOM, canonical state, clocks, storage, or external services.
 *
 * Args:
 *   input: Untrusted requested/visible keys, semantic pins, structural count,
 *     caller limits, and explicit safe-shell requests.
 *
 * Returns:
 *   A deeply immutable accepted plan, or a safe structural-root denial.
 */
export function planChatWindowContainment(input: unknown): ChatWindowContainmentResult {
  const record = isRecord(input) ? input : {};
  const limits = isRecord(record.limits) ? record.limits : {};
  const mountedLimit = boundedInteger(limits.mounted, HARD_MOUNTED_LIMIT);
  const directChildLimit = boundedInteger(limits.directChildren, HARD_DIRECT_CHILD_LIMIT);
  const projectedStructuralRoots = structuralCount(record.projectedStructuralRoots);

  if (projectedStructuralRoots > directChildLimit) {
    return emptyDeniedResult(projectedStructuralRoots);
  }

  const capacity = Math.max(0, Math.min(mountedLimit, directChildLimit - projectedStructuralRoots));
  const visibleKeys = uniqueKeys(record.visibleLoadedKeys);
  const visibleSet = new Set(visibleKeys);
  const requestedKeys = uniqueKeys(record.requestedKeys).filter((key) => visibleSet.has(key));
  const requestedSet = new Set(requestedKeys);
  const selected = new Set<string>();

  const admit = (key: string): boolean => {
    if (!requestedSet.has(key)) return false;
    if (selected.has(key)) return true;
    if (selected.size >= capacity) return false;
    selected.add(key);
    return true;
  };

  for (const key of uniqueKeys(record.viewportKeys)) admit(key);
  for (const key of uniqueKeys(record.coreKeys)) admit(key);

  const deferredPins: Array<{ key: string; role: PinRole; reason: DeferredPinReason }> = [];
  const seenPinKeys = new Set<string>();
  const pinRequests: ReadonlyArray<readonly [unknown, PinRole]> = [
    [record.currentTurnAssistantKey, 'current-streaming-assistant'],
    [record.thinkingId, 'thinking-alias'],
    [record.lastTurnUserId, 'paired-active-user'],
    [record.appendRootUserKey, 'append-root'],
    [record.anchorKey, 'reading-anchor'],
    [record.searchTargetKey, 'search-target'],
  ];

  for (const [candidate, role] of pinRequests) {
    const key = keyValue(candidate);
    if (key === null || seenPinKeys.has(key)) continue;
    seenPinKeys.add(key);
    if (!visibleSet.has(key)) {
      deferredPins.push({ key, role, reason: 'not-visible-loaded' });
    } else if (!requestedSet.has(key)) {
      deferredPins.push({ key, role, reason: 'not-requested' });
    } else if (!admit(key)) {
      deferredPins.push({ key, role, reason: 'capacity' });
    }
  }

  for (const key of uniqueKeys(record.overscanKeys)) admit(key);
  for (const key of requestedKeys) admit(key);

  const acceptedKeys = requestedKeys.filter((key) => selected.has(key));
  const acceptedSet = new Set(acceptedKeys);
  const shellSelections: Record<string, { mode: 'safe-shell'; family: SafeShellFamily }> = {};
  const deniedShellRequests: Array<{ key: string; reason: ShellDenialReason }> = [];
  const shellRequests = Array.isArray(record.shellRequests) ? record.shellRequests : [];

  for (const candidate of shellRequests) {
    if (!isRecord(candidate)) {
      deniedShellRequests.push({ key: '', reason: 'invalid-request' });
      continue;
    }
    const key = keyValue(candidate.key) ?? '';
    if (!acceptedSet.has(key)) {
      deniedShellRequests.push({ key, reason: 'key-not-accepted' });
    } else if (candidate.mode !== 'safe-shell') {
      deniedShellRequests.push({ key, reason: 'invalid-mode' });
    } else if (typeof candidate.family !== 'string' || !SAFE_SHELL_FAMILIES.has(candidate.family)) {
      deniedShellRequests.push({ key, reason: 'unknown-family' });
    } else if (!Object.prototype.hasOwnProperty.call(shellSelections, key)) {
      shellSelections[key] = {
        mode: 'safe-shell',
        family: candidate.family as SafeShellFamily,
      };
    }
  }

  return deepFreeze({
    allowed: true,
    reason: 'accepted',
    acceptedKeys,
    mountedCount: acceptedKeys.length,
    directChildCount: acceptedKeys.length + projectedStructuralRoots,
    projectedStructuralRoots,
    deferredPins,
    shellSelections,
    deniedShellRequests,
  });
}
