import { isPluginVersion } from './plugin-version';
import { isOpenCodeVersion, type OpenCodeVersion } from './opencode-version';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Normal GUI protocol. Deliberately separate from isolated lab descriptors. */
export interface ServiceBinding {
  integrationId: string;
  serviceId: string;
  workspace: string;
  serviceOrigin: string;
}

export interface ConnectionLease extends ServiceBinding {
  schemaVersion: 1;
  kind: 'normal-gui';
  instanceId: string;
  bridgeOrigin: string;
  opencodeVersion: OpenCodeVersion;
  pluginVersion: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedConnectionLease {
  payload: ConnectionLease;
  signature: string;
}

const idPattern = /^[a-f0-9]{64}$/;
const leaseKeys = ['schemaVersion', 'kind', 'integrationId', 'serviceId', 'workspace', 'serviceOrigin',
  'instanceId', 'bridgeOrigin', 'opencodeVersion', 'pluginVersion', 'issuedAt', 'expiresAt'];
export const MAX_LEASE_MS = 60_000;

function fail(): never { throw new Error('Invalid supervisor connection binding'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail();
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) return fail();
  return value;
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return fail();
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > 65535) return fail();
  return value;
}

/** Caller must resolve realpath first. This is canonical spelling, not a filesystem proof. */
export function canonicalWindowsWorkspace(realPath: string): string {
  const normalized = realPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z]:\//.test(normalized) || /[\x00-\x1f]/.test(normalized)
    || normalized.slice(3).split('/').some(part => !part || part === '.' || part === '..')) return fail();
  return normalized;
}


/** Preserve POSIX case and literal backslashes; never collapse distinct workspaces. */
export function canonicalWorkspace(realPath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(realPath)) return canonicalWindowsWorkspace(realPath);
  if (!realPath.startsWith('/') || realPath.startsWith('//') || /[\x00-\x1f]/.test(realPath)) return fail();
  const normalized = realPath === '/' ? '/' : realPath.replace(/\/+$/, '');
  if (normalized !== '/' && normalized.slice(1).split('/').some(part => !part || part === '.' || part === '..')) return fail();
  return normalized;
}

function binding(value: ServiceBinding): ServiceBinding {
  if (canonicalWorkspace(value.workspace) !== value.workspace) return fail();
  return { integrationId: id(value.integrationId), serviceId: id(value.serviceId),
    workspace: value.workspace, serviceOrigin: origin(value.serviceOrigin) };
}

function parseLease(value: unknown): ConnectionLease {
  const raw = record(value);
  exactKeys(raw, leaseKeys);
  if (raw.schemaVersion !== 1 || raw.kind !== 'normal-gui' || !isOpenCodeVersion(raw.opencodeVersion)
    || !isPluginVersion(raw.pluginVersion) || typeof raw.workspace !== 'string'
    || !Number.isSafeInteger(raw.issuedAt) || !Number.isSafeInteger(raw.expiresAt)) return fail();
  const issuedAt = raw.issuedAt as number;
  const expiresAt = raw.expiresAt as number;
  if (issuedAt < 0 || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LEASE_MS) return fail();
  const owner = binding({ integrationId: id(raw.integrationId), serviceId: id(raw.serviceId),
    workspace: raw.workspace, serviceOrigin: origin(raw.serviceOrigin) });
  return { schemaVersion: 1, kind: 'normal-gui', ...owner, instanceId: id(raw.instanceId),
    bridgeOrigin: origin(raw.bridgeOrigin), opencodeVersion: raw.opencodeVersion, pluginVersion: raw.pluginVersion, issuedAt, expiresAt };
}

function mac(key: string, domain: string, value: unknown): string {
  id(key);
  return createHmac('sha256', Buffer.from(key, 'hex')).update(domain).update('\0').update(JSON.stringify(value)).digest('hex');
}

function equalMac(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && idPattern.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

/** The private launch key never appears in the returned discovery record. */
export function signConnectionLease(payload: ConnectionLease, launchKey: string): SignedConnectionLease {
  const parsed = parseLease(payload);
  return { payload: parsed, signature: mac(launchKey, 'supervisor/normal-lease/v1', parsed) };
}

export function verifyConnectionLease(input: unknown, expected: ServiceBinding, launchKey: string, now: number): ConnectionLease {
  const raw = record(input);
  exactKeys(raw, ['payload', 'signature']);
  const parsed = parseLease(raw.payload);
  const owner = binding(expected);
  if (!Number.isSafeInteger(now) || now < parsed.issuedAt || now >= parsed.expiresAt
    || Object.entries(owner).some(([key, value]) => parsed[key as keyof ServiceBinding] !== value)
    || !equalMac(raw.signature, mac(launchKey, 'supervisor/normal-lease/v1', parsed))) return fail();
  return parsed;
}

/** Domain separation prevents a recorded lease or proof from being used as a bearer. */
export function bridgeBearer(launchKey: string, owner: ServiceBinding, instanceId: string): string {
  return mac(launchKey, 'supervisor/normal-bearer/v1', { ...binding(owner), instanceId: id(instanceId) });
}

export function connectionProof(launchKey: string, lease: ConnectionLease, challenge: string): string {
  return mac(launchKey, 'supervisor/normal-proof/v1', { lease: parseLease(lease), challenge: id(challenge) });
}

export function verifyConnectionProof(proof: unknown, launchKey: string, lease: ConnectionLease, challenge: string): boolean {
  return equalMac(proof, connectionProof(launchKey, lease, challenge));
}

/** Binds private launch metadata to the ordinary transport authentication. */
export function serviceAuthenticationProof(launchKey: string, owner: ServiceBinding, authorization: string): string {
  if (typeof authorization !== 'string' || !/^Basic [A-Za-z0-9+/=]{8,2048}$/.test(authorization)) return fail();
  return mac(launchKey, 'supervisor/normal-service-auth/v1', { ...binding(owner), authorization });
}
