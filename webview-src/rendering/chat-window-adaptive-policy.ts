export type OverscanTier = 20 | 10 | 4;
export type InitialTailOption = 80 | 40 | 24;
export type ScrollDirection = 'stationary' | 'forward' | 'backward';
export type ScrollVelocity = 'idle' | 'slow' | 'fast';
export type AdaptiveSignal = 'none' | 'pressure' | 'headroom';
export type AdaptiveDecision = 'hold' | 'shrink' | 'grow';

export interface ChatWindowAdaptiveConfig {
  readonly enabled: boolean;
  readonly revision: number;
  readonly pressure: {
    readonly mountedAtLeast: number;
    readonly directChildrenAtLeast: number;
    readonly descendantsAtLeast: number;
    readonly renderCostAtLeast: number;
    readonly measureCostAtLeast: number;
  };
  readonly headroom: {
    readonly mountedAtMost: number;
    readonly directChildrenAtMost: number;
    readonly descendantsAtMost: number;
    readonly renderCostAtMost: number;
    readonly measureCostAtMost: number;
  };
  readonly pressureConsecutiveIntervals: number;
  readonly headroomConsecutiveIntervals: number;
  readonly cooldownIntervals: number;
  readonly minimumAheadItems: number;
  readonly minimumBehindItems: number;
  readonly fastScrollDirectionalReserve: number;
}

export interface ChatWindowAdaptiveState {
  readonly sessionGeneration: number;
  readonly lastDecisionInterval: number;
  readonly overscanTier: OverscanTier;
  readonly initialTail: InitialTailOption;
  readonly pressureCount: number;
  readonly headroomCount: number;
  readonly cooldownRemaining: number;
  readonly lastSignal: AdaptiveSignal;
  readonly decisionGeneration: number;
}

export interface ChatWindowAdaptiveMeasurements {
  readonly mountedCount: number;
  readonly directChildCount: number;
  readonly descendantCount: number;
  readonly viewportItemDemand: number;
  readonly renderCost: number;
  readonly measureCost: number;
  readonly projectedStructuralRoots: number;
  readonly currentRequestedCount: number;
  readonly currentAcceptedCount: number;
}

export interface ChatWindowAdaptiveRoleCounts {
  readonly visible: number;
  readonly core: number;
  readonly currentStreamingAssistant: number;
  readonly thinkingAlias: number;
  readonly pairedActiveUser: number;
  readonly appendRoot: number;
  readonly readingAnchor: number;
  readonly searchTarget: number;
  readonly overscan: number;
}

export interface ChatWindowAdaptiveRoleOutcomes {
  readonly accepted: ChatWindowAdaptiveRoleCounts;
  readonly capped: ChatWindowAdaptiveRoleCounts;
  readonly deferred: ChatWindowAdaptiveRoleCounts;
}

export interface ChatWindowAdaptiveInput {
  readonly config: ChatWindowAdaptiveConfig;
  readonly state: ChatWindowAdaptiveState;
  readonly decisionInterval: number;
  readonly sessionGeneration: number;
  readonly provenance:
    | Readonly<{ kind: 'external' }>
    | Readonly<{ kind: 'self'; decisionGeneration: number }>;
  readonly direction: ScrollDirection;
  readonly velocity: ScrollVelocity;
  readonly measurements: ChatWindowAdaptiveMeasurements;
  readonly roleOutcomes: ChatWindowAdaptiveRoleOutcomes;
  readonly syntheticEnvironment: boolean;
}

export type ChatWindowAdaptiveReason =
  | 'invalid-input'
  | 'disabled'
  | 'session-reset'
  | 'stale-session'
  | 'duplicate-or-stale-interval'
  | 'self-churn'
  | 'cooldown'
  | 'neutral'
  | 'pressure-pending'
  | 'headroom-pending'
  | 'pressure-transition'
  | 'headroom-transition'
  | 'minimum-tier'
  | 'maximum-tier';

export interface ChatWindowAdaptiveRange {
  readonly viewportItems: number;
  readonly aheadItems: number;
  readonly behindItems: number;
  readonly totalDemand: number;
}

export interface ChatWindowAdaptiveTelemetry {
  readonly syntheticEnvironment: boolean;
  readonly measurements: ChatWindowAdaptiveMeasurements;
  readonly pressureCount: number;
  readonly headroomCount: number;
  readonly cooldownRemaining: number;
  readonly roleOutcomes: ChatWindowAdaptiveRoleOutcomes;
}

export interface ChatWindowAdaptiveResult {
  readonly allowed: boolean;
  readonly enabled: boolean;
  readonly configRevision: number;
  readonly decisionInterval: number;
  readonly sessionGeneration: number;
  readonly priorOverscanTier: OverscanTier;
  readonly newOverscanTier: OverscanTier;
  readonly priorInitialTail: InitialTailOption;
  readonly newInitialTail: InitialTailOption;
  readonly direction: ScrollDirection;
  readonly velocity: ScrollVelocity;
  readonly decision: AdaptiveDecision;
  readonly reason: ChatWindowAdaptiveReason;
  readonly range: ChatWindowAdaptiveRange;
  readonly state: ChatWindowAdaptiveState;
  readonly telemetry: ChatWindowAdaptiveTelemetry;
}

type UnknownRecord = Record<string, unknown>;

const OVERSCAN_TIERS: readonly OverscanTier[] = Object.freeze([20, 10, 4]);
const INITIAL_TAIL_OPTIONS: readonly InitialTailOption[] = Object.freeze([80, 40, 24]);
const MAX_AGGREGATE = 1_000_000;
const MAX_INTERVAL_SETTING = 1_000;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as UnknownRecord)) deepFreeze(child);
  return Object.freeze(value);
};

export const CHAT_WINDOW_ADAPTIVE_HYPOTHESES = deepFreeze({
  overscanTiers: OVERSCAN_TIERS,
  initialTailOptions: INITIAL_TAIL_OPTIONS,
  validationCeilings: { mounted: 140, directChildren: 146 },
  initial: { enabled: false, overscanTier: 20 as OverscanTier, initialTail: 80 as InitialTailOption },
});

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const integerIn = (value: unknown, minimum: number, maximum: number): value is number => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && value >= minimum
  && value <= maximum
);

const isOverscanTier = (value: unknown): value is OverscanTier => (
  value === 20 || value === 10 || value === 4
);

const isInitialTail = (value: unknown): value is InitialTailOption => (
  value === 80 || value === 40 || value === 24
);

const isDirection = (value: unknown): value is ScrollDirection => (
  value === 'stationary' || value === 'forward' || value === 'backward'
);

const isVelocity = (value: unknown): value is ScrollVelocity => (
  value === 'idle' || value === 'slow' || value === 'fast'
);

const isSignal = (value: unknown): value is AdaptiveSignal => (
  value === 'none' || value === 'pressure' || value === 'headroom'
);

const isCounts = (value: unknown): value is ChatWindowAdaptiveRoleCounts => {
  if (!isRecord(value)) return false;
  return [
    value.visible,
    value.core,
    value.currentStreamingAssistant,
    value.thinkingAlias,
    value.pairedActiveUser,
    value.appendRoot,
    value.readingAnchor,
    value.searchTarget,
    value.overscan,
  ].every((count) => integerIn(count, 0, MAX_AGGREGATE));
};

const isRoleOutcomes = (value: unknown): value is ChatWindowAdaptiveRoleOutcomes => (
  isRecord(value)
  && isCounts(value.accepted)
  && isCounts(value.capped)
  && isCounts(value.deferred)
);

const isMeasurements = (value: unknown): value is ChatWindowAdaptiveMeasurements => {
  if (!isRecord(value)) return false;
  return [
    value.mountedCount,
    value.directChildCount,
    value.descendantCount,
    value.viewportItemDemand,
    value.renderCost,
    value.measureCost,
    value.projectedStructuralRoots,
    value.currentRequestedCount,
    value.currentAcceptedCount,
  ].every((measurement) => integerIn(measurement, 0, MAX_AGGREGATE));
};

const isConfig = (value: unknown): value is ChatWindowAdaptiveConfig => {
  if (!isRecord(value) || !isRecord(value.pressure) || !isRecord(value.headroom)) return false;
  const pressure = value.pressure;
  const headroom = value.headroom;
  const pairs: ReadonlyArray<readonly [unknown, unknown]> = [
    [headroom.mountedAtMost, pressure.mountedAtLeast],
    [headroom.directChildrenAtMost, pressure.directChildrenAtLeast],
    [headroom.descendantsAtMost, pressure.descendantsAtLeast],
    [headroom.renderCostAtMost, pressure.renderCostAtLeast],
    [headroom.measureCostAtMost, pressure.measureCostAtLeast],
  ];
  return typeof value.enabled === 'boolean'
    && integerIn(value.revision, 0, MAX_AGGREGATE)
    && pairs.every(([low, high]) => integerIn(low, 0, MAX_AGGREGATE)
      && integerIn(high, 0, MAX_AGGREGATE) && low < high)
    && integerIn(value.pressureConsecutiveIntervals, 1, MAX_INTERVAL_SETTING)
    && integerIn(value.headroomConsecutiveIntervals, 1, MAX_INTERVAL_SETTING)
    && integerIn(value.cooldownIntervals, 0, MAX_INTERVAL_SETTING)
    && integerIn(value.minimumAheadItems, 1, 140)
    && integerIn(value.minimumBehindItems, 1, 140)
    && integerIn(value.fastScrollDirectionalReserve, 0, 140)
    && value.minimumAheadItems + value.minimumBehindItems <= 4;
};

const isState = (value: unknown): value is ChatWindowAdaptiveState => (
  isRecord(value)
  && integerIn(value.sessionGeneration, 0, MAX_AGGREGATE)
  && integerIn(value.lastDecisionInterval, 0, MAX_AGGREGATE)
  && isOverscanTier(value.overscanTier)
  && isInitialTail(value.initialTail)
  && integerIn(value.pressureCount, 0, MAX_INTERVAL_SETTING)
  && integerIn(value.headroomCount, 0, MAX_INTERVAL_SETTING)
  && integerIn(value.cooldownRemaining, 0, MAX_INTERVAL_SETTING)
  && isSignal(value.lastSignal)
  && integerIn(value.decisionGeneration, 0, MAX_AGGREGATE)
);

const isProvenance = (value: unknown): value is ChatWindowAdaptiveInput['provenance'] => (
  isRecord(value)
  && (value.kind === 'external'
    || (value.kind === 'self' && integerIn(value.decisionGeneration, 0, MAX_AGGREGATE)))
);

const copyCounts = (counts: ChatWindowAdaptiveRoleCounts): ChatWindowAdaptiveRoleCounts => ({
  visible: counts.visible,
  core: counts.core,
  currentStreamingAssistant: counts.currentStreamingAssistant,
  thinkingAlias: counts.thinkingAlias,
  pairedActiveUser: counts.pairedActiveUser,
  appendRoot: counts.appendRoot,
  readingAnchor: counts.readingAnchor,
  searchTarget: counts.searchTarget,
  overscan: counts.overscan,
});

const copyMeasurements = (measurements: ChatWindowAdaptiveMeasurements): ChatWindowAdaptiveMeasurements => ({
  mountedCount: measurements.mountedCount,
  directChildCount: measurements.directChildCount,
  descendantCount: measurements.descendantCount,
  viewportItemDemand: measurements.viewportItemDemand,
  renderCost: measurements.renderCost,
  measureCost: measurements.measureCost,
  projectedStructuralRoots: measurements.projectedStructuralRoots,
  currentRequestedCount: measurements.currentRequestedCount,
  currentAcceptedCount: measurements.currentAcceptedCount,
});

const emptyCounts = (): ChatWindowAdaptiveRoleCounts => ({
  visible: 0,
  core: 0,
  currentStreamingAssistant: 0,
  thinkingAlias: 0,
  pairedActiveUser: 0,
  appendRoot: 0,
  readingAnchor: 0,
  searchTarget: 0,
  overscan: 0,
});

const emptyMeasurements = (): ChatWindowAdaptiveMeasurements => ({
  mountedCount: 0,
  directChildCount: 0,
  descendantCount: 0,
  viewportItemDemand: 0,
  renderCost: 0,
  measureCost: 0,
  projectedStructuralRoots: 0,
  currentRequestedCount: 0,
  currentAcceptedCount: 0,
});

const resetState = (sessionGeneration: number): ChatWindowAdaptiveState => ({
  sessionGeneration,
  lastDecisionInterval: 0,
  overscanTier: 20,
  initialTail: 80,
  pressureCount: 0,
  headroomCount: 0,
  cooldownRemaining: 0,
  lastSignal: 'none',
  decisionGeneration: 0,
});

const invalidResult = (input: unknown): ChatWindowAdaptiveResult => {
  const inputRecord = isRecord(input) ? input : null;
  const state = inputRecord !== null && isState(inputRecord.state)
    ? { ...inputRecord.state }
    : resetState(0);
  const counts = emptyCounts();
  const measurements = emptyMeasurements();
  return deepFreeze({
    allowed: false,
    enabled: false,
    configRevision: 0,
    decisionInterval: 0,
    sessionGeneration: 0,
    priorOverscanTier: state.overscanTier,
    newOverscanTier: state.overscanTier,
    priorInitialTail: state.initialTail,
    newInitialTail: state.initialTail,
    direction: 'stationary',
    velocity: 'idle',
    decision: 'hold',
    reason: 'invalid-input',
    range: { viewportItems: 0, aheadItems: 0, behindItems: 0, totalDemand: 0 },
    state,
    telemetry: {
      syntheticEnvironment: false,
      measurements,
      pressureCount: 0,
      headroomCount: 0,
      cooldownRemaining: 0,
      roleOutcomes: { accepted: counts, capped: emptyCounts(), deferred: emptyCounts() },
    },
  });
};

const rangeFor = (
  tier: OverscanTier,
  direction: ScrollDirection,
  velocity: ScrollVelocity,
  measurements: ChatWindowAdaptiveMeasurements,
  config: ChatWindowAdaptiveConfig,
): ChatWindowAdaptiveRange => {
  const hardDemand = Math.min(
    CHAT_WINDOW_ADAPTIVE_HYPOTHESES.validationCeilings.mounted,
    CHAT_WINDOW_ADAPTIVE_HYPOTHESES.validationCeilings.directChildren
      - measurements.projectedStructuralRoots,
    measurements.currentRequestedCount,
    measurements.currentAcceptedCount,
  );
  const optionalCapacity = Math.max(0, hardDemand - measurements.viewportItemDemand);
  const optionalDemand = Math.min(tier, optionalCapacity);
  let aheadItems = config.minimumAheadItems;
  let behindItems = config.minimumBehindItems;
  let remaining = Math.max(0, optionalDemand - aheadItems - behindItems);

  if (velocity === 'fast' && direction !== 'stationary') {
    const directional = Math.max(0, Math.min(config.fastScrollDirectionalReserve, remaining));
    if (direction === 'forward') aheadItems += directional;
    else behindItems += directional;
    remaining -= directional;
  }
  aheadItems += Math.ceil(remaining / 2);
  behindItems += Math.floor(remaining / 2);
  return {
    viewportItems: measurements.viewportItemDemand,
    aheadItems,
    behindItems,
    totalDemand: measurements.viewportItemDemand + aheadItems + behindItems,
  };
};

const tierStep = <T>(options: readonly T[], current: T, delta: -1 | 1): T => {
  const index = options.indexOf(current);
  return options[Math.max(0, Math.min(options.length - 1, index + delta))];
};

const classifySignal = (
  measurements: ChatWindowAdaptiveMeasurements,
  config: ChatWindowAdaptiveConfig,
): AdaptiveSignal => {
  const pressure = measurements.mountedCount >= config.pressure.mountedAtLeast
    || measurements.directChildCount >= config.pressure.directChildrenAtLeast
    || measurements.descendantCount >= config.pressure.descendantsAtLeast
    || measurements.renderCost >= config.pressure.renderCostAtLeast
    || measurements.measureCost >= config.pressure.measureCostAtLeast;
  if (pressure) return 'pressure';
  const headroom = measurements.mountedCount <= config.headroom.mountedAtMost
    && measurements.directChildCount <= config.headroom.directChildrenAtMost
    && measurements.descendantCount <= config.headroom.descendantsAtMost
    && measurements.renderCost <= config.headroom.renderCostAtMost
    && measurements.measureCost <= config.headroom.measureCostAtMost;
  return headroom ? 'headroom' : 'none';
};

const validInput = (value: unknown): value is ChatWindowAdaptiveInput => {
  if (!isRecord(value)
    || !isConfig(value.config)
    || !isState(value.state)
    || !integerIn(value.decisionInterval, 0, MAX_AGGREGATE)
    || !integerIn(value.sessionGeneration, 0, MAX_AGGREGATE)
    || !isProvenance(value.provenance)
    || !isDirection(value.direction)
    || !isVelocity(value.velocity)
    || !isMeasurements(value.measurements)
    || !isRoleOutcomes(value.roleOutcomes)
    || typeof value.syntheticEnvironment !== 'boolean') return false;

  const measurements = value.measurements;
  const minimumDemand = measurements.viewportItemDemand
    + value.config.minimumAheadItems
    + value.config.minimumBehindItems;
  const hardDemand = Math.min(
    140,
    146 - measurements.projectedStructuralRoots,
    measurements.currentRequestedCount,
    measurements.currentAcceptedCount,
  );
  return measurements.viewportItemDemand > 0
    && measurements.projectedStructuralRoots <= 146
    && minimumDemand <= hardDemand;
};

const makeResult = (
  input: ChatWindowAdaptiveInput,
  state: ChatWindowAdaptiveState,
  decision: AdaptiveDecision,
  reason: ChatWindowAdaptiveReason,
): ChatWindowAdaptiveResult => deepFreeze({
  allowed: true,
  enabled: input.config.enabled,
  configRevision: input.config.revision,
  decisionInterval: input.decisionInterval,
  sessionGeneration: input.sessionGeneration,
  priorOverscanTier: input.state.overscanTier,
  newOverscanTier: state.overscanTier,
  priorInitialTail: input.state.initialTail,
  newInitialTail: state.initialTail,
  direction: input.direction,
  velocity: input.velocity,
  decision,
  reason,
  range: rangeFor(state.overscanTier, input.direction, input.velocity, input.measurements, input.config),
  state,
  telemetry: {
    syntheticEnvironment: input.syntheticEnvironment,
    measurements: copyMeasurements(input.measurements),
    pressureCount: state.pressureCount,
    headroomCount: state.headroomCount,
    cooldownRemaining: state.cooldownRemaining,
    roleOutcomes: {
      accepted: copyCounts(input.roleOutcomes.accepted),
      capped: copyCounts(input.roleOutcomes.capped),
      deferred: copyCounts(input.roleOutcomes.deferred),
    },
  },
});

/**
 * Decides one bounded adaptive chat-window policy interval without side effects.
 *
 * Args:
 *   input: Explicit configuration, prior state, monotonic generations, aggregate
 *     measurements, provenance, closed scroll bands, and role counts.
 *
 * Returns:
 *   A deterministic deeply frozen transition candidate, or a frozen denied hold
 *   for malformed input.
 */
export function decideChatWindowAdaptivePolicy(input: unknown): ChatWindowAdaptiveResult {
  if (!validInput(input)) return invalidResult(input);

  if (input.sessionGeneration > input.state.sessionGeneration) {
    return makeResult(input, resetState(input.sessionGeneration), 'hold', 'session-reset');
  }
  if (input.sessionGeneration < input.state.sessionGeneration) {
    return makeResult(input, { ...input.state }, 'hold', 'stale-session');
  }
  if (input.decisionInterval <= input.state.lastDecisionInterval) {
    return makeResult(input, { ...input.state }, 'hold', 'duplicate-or-stale-interval');
  }

  const intervalState: ChatWindowAdaptiveState = {
    ...input.state,
    lastDecisionInterval: input.decisionInterval,
  };
  if (!input.config.enabled) {
    return makeResult(input, {
      ...intervalState,
      pressureCount: 0,
      headroomCount: 0,
      lastSignal: 'none',
    }, 'hold', 'disabled');
  }
  if (input.provenance.kind === 'self') {
    return makeResult(input, intervalState, 'hold', 'self-churn');
  }
  if (intervalState.cooldownRemaining > 0) {
    return makeResult(input, {
      ...intervalState,
      pressureCount: 0,
      headroomCount: 0,
      cooldownRemaining: intervalState.cooldownRemaining - 1,
      lastSignal: 'none',
    }, 'hold', 'cooldown');
  }

  const signal = classifySignal(input.measurements, input.config);
  if (signal === 'none') {
    return makeResult(input, {
      ...intervalState,
      pressureCount: 0,
      headroomCount: 0,
      lastSignal: 'none',
    }, 'hold', 'neutral');
  }
  if (signal === 'pressure') {
    const pressureCount = input.state.lastSignal === 'pressure' ? input.state.pressureCount + 1 : 1;
    if (pressureCount < input.config.pressureConsecutiveIntervals) {
      return makeResult(input, {
        ...intervalState,
        pressureCount,
        headroomCount: 0,
        lastSignal: 'pressure',
      }, 'hold', 'pressure-pending');
    }
    if (input.state.overscanTier === 4 && input.state.initialTail === 24) {
      return makeResult(input, {
        ...intervalState,
        pressureCount: 0,
        headroomCount: 0,
        lastSignal: 'pressure',
      }, 'hold', 'minimum-tier');
    }
    return makeResult(input, {
      ...intervalState,
      overscanTier: tierStep(OVERSCAN_TIERS, input.state.overscanTier, 1),
      initialTail: tierStep(INITIAL_TAIL_OPTIONS, input.state.initialTail, 1),
      pressureCount: 0,
      headroomCount: 0,
      cooldownRemaining: input.config.cooldownIntervals,
      lastSignal: 'pressure',
      decisionGeneration: Math.min(MAX_AGGREGATE, input.state.decisionGeneration + 1),
    }, 'shrink', 'pressure-transition');
  }

  const headroomCount = input.state.lastSignal === 'headroom' ? input.state.headroomCount + 1 : 1;
  if (headroomCount < input.config.headroomConsecutiveIntervals) {
    return makeResult(input, {
      ...intervalState,
      pressureCount: 0,
      headroomCount,
      lastSignal: 'headroom',
    }, 'hold', 'headroom-pending');
  }
  if (input.state.overscanTier === 20 && input.state.initialTail === 80) {
    return makeResult(input, {
      ...intervalState,
      pressureCount: 0,
      headroomCount: 0,
      lastSignal: 'headroom',
    }, 'hold', 'maximum-tier');
  }
  return makeResult(input, {
    ...intervalState,
    overscanTier: tierStep(OVERSCAN_TIERS, input.state.overscanTier, -1),
    initialTail: tierStep(INITIAL_TAIL_OPTIONS, input.state.initialTail, -1),
    pressureCount: 0,
    headroomCount: 0,
    cooldownRemaining: input.config.cooldownIntervals,
    lastSignal: 'headroom',
    decisionGeneration: Math.min(MAX_AGGREGATE, input.state.decisionGeneration + 1),
  }, 'grow', 'headroom-transition');
}
