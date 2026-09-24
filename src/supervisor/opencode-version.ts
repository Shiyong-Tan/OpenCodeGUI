/** Explicitly audited V1 releases; never infer compatibility from a semver range. */
export const SUPPORTED_OPENCODE_VERSIONS = ['1.18.29', '1.18.31'] as const;
export type SupportedOpenCodeVersion = typeof SUPPORTED_OPENCODE_VERSIONS[number];

export function isSupportedOpenCodeVersion(value: unknown): value is SupportedOpenCodeVersion {
  return SUPPORTED_OPENCODE_VERSIONS.some(version => version === value);
}

export function parseOpenCodeVersion(value: unknown): SupportedOpenCodeVersion {
  if (!isSupportedOpenCodeVersion(value)) {
    // Do not reflect arbitrary response bodies (which may contain credentials).
    const actual = typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : 'unknown';
    throw new Error(`Unsupported OpenCode version: ${actual}; supported: ${SUPPORTED_OPENCODE_VERSIONS.join(', ')}`);
  }
  return value;
}
