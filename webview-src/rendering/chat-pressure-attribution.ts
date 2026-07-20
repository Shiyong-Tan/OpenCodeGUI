export const TOP_CONTRIBUTOR_LIMIT = 8;
export const MAX_ATTRIBUTION_UNITS = 140;
export const MAX_ATTRIBUTION_COUNT = 1_000_000_000;
export const MAX_ATTRIBUTION_GENERATION = 1_000_000;

export type AttributionKind =
  | 'greeting'
  | 'message'
  | 'change-list'
  | 'segment'
  | 'conflict'
  | 'system'
  | 'unknown';

export type AttributionRole = 'user' | 'assistant' | 'system' | 'unknown';

export type ChatPressureClassification =
  | 'cumulative-ordinary'
  | 'exceptional-unit'
  | 'suspected-cleanup-drift'
  | 'mixed'
  | 'unknown';

export interface ChatPressureUnitInput {
  unitIndex?: number;
  kind?: string;
  role?: string;
  descendants?: number;
  directChildren?: number;
  mounted?: boolean;
  visible?: boolean;
  pinned?: boolean;
}

export interface ChatPressureCleanupInput {
  available?: boolean;
  generation?: number;
  ownedUnmount?: boolean;
  residualRoots?: number;
  postUnmountDescendantDelta?: number;
  staleRejections?: number;
}

export interface ChatPressureAttributionInput {
  generation?: number;
  auditAvailable?: boolean;
  coverageAvailable?: boolean;
  totalDescendants?: number;
  units?: ChatPressureUnitInput[];
  cleanup?: ChatPressureCleanupInput;
}

export interface ChatPressureContributor {
  unitIndex: number;
  kind: AttributionKind;
  role: AttributionRole;
  descendants: number;
  directChildren: number;
  mounted: boolean;
  visible: boolean;
  pinned: boolean;
}

export interface ChatPressureAttribution {
  generation: number;
  audit: {
    available: boolean;
    coverageAvailable: boolean;
    totalDescendants: number | null;
    attributedDescendants: number;
    reconciled: boolean;
    observedUnitCount: number;
  };
  cleanup: {
    available: boolean;
    generationMatches: boolean | null;
    ownedUnmount: boolean | null;
    residualRoots: number | null;
    postUnmountDescendantDelta: number | null;
    staleRejections: number | null;
  };
  topContributors: ChatPressureContributor[];
  dominance: {
    available: boolean;
    topUnitBasisPoints: number | null;
    topThreeBasisPoints: number | null;
  };
  classification: {
    value: ChatPressureClassification;
    missingDiscriminators: MissingDiscriminator[];
  };
}

type MissingDiscriminator =
  | 'attributed-total-reconciliation'
  | 'audit-sample'
  | 'cleanup-evidence'
  | 'cleanup-generation-match'
  | 'coverage'
  | 'pressure-evidence';

const KINDS = new Set<AttributionKind>([
  'greeting', 'message', 'change-list', 'segment', 'conflict', 'system', 'unknown',
]);
const ROLES = new Set<AttributionRole>(['user', 'assistant', 'system', 'unknown']);

function normalizeInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function normalizeOptionalInteger(value: unknown, maximum: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return normalizeInteger(value, maximum);
}

function normalizeKind(value: unknown): AttributionKind {
  return typeof value === 'string' && KINDS.has(value as AttributionKind)
    ? value as AttributionKind
    : 'unknown';
}

function normalizeRole(value: unknown): AttributionRole {
  return typeof value === 'string' && ROLES.has(value as AttributionRole)
    ? value as AttributionRole
    : 'unknown';
}

function aggregateUnits(units: unknown): ChatPressureContributor[] {
  if (!Array.isArray(units)) return [];

  const byIndex = new Map<number, ChatPressureContributor>();
  for (const candidate of units.slice(0, MAX_ATTRIBUTION_UNITS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const unit = candidate as ChatPressureUnitInput;
    const unitIndex = normalizeInteger(unit.unitIndex, MAX_ATTRIBUTION_COUNT);
    const kind = normalizeKind(unit.kind);
    const role = normalizeRole(unit.role);
    const existing = byIndex.get(unitIndex);

    if (!existing) {
      byIndex.set(unitIndex, {
        unitIndex,
        kind,
        role,
        descendants: normalizeInteger(unit.descendants, MAX_ATTRIBUTION_COUNT),
        directChildren: normalizeInteger(unit.directChildren, MAX_ATTRIBUTION_COUNT),
        mounted: unit.mounted === true,
        visible: unit.visible === true,
        pinned: unit.pinned === true,
      });
      continue;
    }

    existing.kind = existing.kind === kind ? existing.kind : 'unknown';
    existing.role = existing.role === role ? existing.role : 'unknown';
    existing.descendants = Math.min(
      MAX_ATTRIBUTION_COUNT,
      existing.descendants + normalizeInteger(unit.descendants, MAX_ATTRIBUTION_COUNT),
    );
    existing.directChildren = Math.min(
      MAX_ATTRIBUTION_COUNT,
      existing.directChildren + normalizeInteger(unit.directChildren, MAX_ATTRIBUTION_COUNT),
    );
    existing.mounted = existing.mounted || unit.mounted === true;
    existing.visible = existing.visible || unit.visible === true;
    existing.pinned = existing.pinned || unit.pinned === true;
  }

  return Array.from(byIndex.values());
}

function basisPoints(value: number, total: number): number {
  return total > 0 ? Math.floor((value * 10_000) / total) : 0;
}

/**
 * Builds a bounded, deterministic attribution snapshot from count-only evidence.
 *
 * Args:
 *   input: Untrusted primitive attribution evidence. Unknown properties are ignored.
 *
 * Returns:
 *   A fresh privacy-safe record containing only the declared allowlisted fields.
 */
export function buildChatPressureAttribution(input: ChatPressureAttributionInput): ChatPressureAttribution {
  const source = input && typeof input === 'object' ? input : {};
  const generation = normalizeInteger(source.generation, MAX_ATTRIBUTION_GENERATION);
  const auditAvailable = source.auditAvailable === true;
  const coverageAvailable = source.coverageAvailable === true;
  const totalDescendants = normalizeOptionalInteger(source.totalDescendants, MAX_ATTRIBUTION_COUNT);
  const aggregatedUnits = aggregateUnits(source.units);
  const attributedDescendants = aggregatedUnits.reduce(
    (total, unit) => Math.min(MAX_ATTRIBUTION_COUNT, total + unit.descendants),
    0,
  );
  const reconciled = totalDescendants !== null && attributedDescendants === totalDescendants;
  const ranked = aggregatedUnits
    .slice()
    .sort((left, right) => right.descendants - left.descendants || left.unitIndex - right.unitIndex);
  const topContributors = ranked.slice(0, TOP_CONTRIBUTOR_LIMIT).map((unit) => ({
    unitIndex: unit.unitIndex,
    kind: unit.kind,
    role: unit.role,
    descendants: unit.descendants,
    directChildren: unit.directChildren,
    mounted: unit.mounted,
    visible: unit.visible,
    pinned: unit.pinned,
  }));

  const cleanupSource = source.cleanup;
  const cleanupAvailable = cleanupSource?.available === true;
  const cleanupGeneration = cleanupAvailable
    ? normalizeInteger(cleanupSource?.generation, MAX_ATTRIBUTION_GENERATION)
    : null;
  const generationMatches = cleanupAvailable ? cleanupGeneration === generation : null;
  const ownedUnmount = generationMatches ? cleanupSource?.ownedUnmount === true : null;
  const residualRoots = generationMatches
    ? normalizeInteger(cleanupSource?.residualRoots, MAX_ATTRIBUTION_COUNT)
    : null;
  const postUnmountDescendantDelta = generationMatches
    ? normalizeInteger(cleanupSource?.postUnmountDescendantDelta, MAX_ATTRIBUTION_COUNT)
    : null;
  const staleRejections = generationMatches
    ? normalizeInteger(cleanupSource?.staleRejections, MAX_ATTRIBUTION_COUNT)
    : null;

  const dominanceAvailable = auditAvailable
    && coverageAvailable
    && reconciled
    && totalDescendants !== null
    && totalDescendants > 0;
  const topUnitDescendants = ranked[0]?.descendants ?? 0;
  const topThreeDescendants = ranked
    .slice(0, 3)
    .reduce((total, unit) => total + unit.descendants, 0);
  const topUnitBasisPoints = dominanceAvailable
    ? basisPoints(topUnitDescendants, totalDescendants as number)
    : null;
  const topThreeBasisPoints = dominanceAvailable
    ? basisPoints(topThreeDescendants, totalDescendants as number)
    : null;

  const missingDiscriminators: MissingDiscriminator[] = [];
  if (totalDescendants === null || !reconciled) {
    missingDiscriminators.push('attributed-total-reconciliation');
  }
  if (!auditAvailable) missingDiscriminators.push('audit-sample');
  if (!cleanupAvailable) {
    missingDiscriminators.push('cleanup-evidence');
  } else if (!generationMatches) {
    missingDiscriminators.push('cleanup-generation-match');
  }
  if (!coverageAvailable) missingDiscriminators.push('coverage');

  let classification: ChatPressureClassification = 'unknown';
  if (missingDiscriminators.length === 0) {
    const cleanupDrift = ownedUnmount === true
      && ((residualRoots ?? 0) > 0 || (postUnmountDescendantDelta ?? 0) > 0);
    const hasPressure = (totalDescendants ?? 0) > 0;
    const exceptional = dominanceAvailable
      && (topUnitDescendants * 100 >= (totalDescendants as number) * 35
        || topThreeDescendants * 100 >= (totalDescendants as number) * 60);
    const cumulative = dominanceAvailable && !exceptional;

    if (cleanupDrift && (exceptional || cumulative)) classification = 'mixed';
    else if (cleanupDrift) classification = 'suspected-cleanup-drift';
    else if (exceptional) classification = 'exceptional-unit';
    else if (cumulative) classification = 'cumulative-ordinary';
    else if (!hasPressure) missingDiscriminators.push('pressure-evidence');
  }

  return {
    generation,
    audit: {
      available: auditAvailable,
      coverageAvailable,
      totalDescendants,
      attributedDescendants,
      reconciled,
      observedUnitCount: aggregatedUnits.length,
    },
    cleanup: {
      available: cleanupAvailable,
      generationMatches,
      ownedUnmount,
      residualRoots,
      postUnmountDescendantDelta,
      staleRejections,
    },
    topContributors,
    dominance: {
      available: dominanceAvailable,
      topUnitBasisPoints,
      topThreeBasisPoints,
    },
    classification: {
      value: classification,
      missingDiscriminators,
    },
  };
}
