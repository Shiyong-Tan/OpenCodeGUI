/** Version labels identify the connected service; they are not a compatibility allowlist. */
export type OpenCodeVersion = string;
export function isOpenCodeVersion(value: unknown): value is OpenCodeVersion {
  return typeof value === 'string' && value.length <= 128 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z._+-]+)?$/.test(value);
}
export function parseOpenCodeVersion(value: unknown): OpenCodeVersion {
  if (!isOpenCodeVersion(value)) throw new Error('Invalid OpenCode health version label');
  return value;
}
