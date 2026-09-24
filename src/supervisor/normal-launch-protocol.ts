import { isAbsolute } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { canonicalWindowsWorkspace, serviceAuthenticationProof, type ServiceBinding } from './normal-connection-protocol';

/** Privileged bootstrap passed only by the existing GUI service spawn owner. */
export interface NormalLaunch {
  schemaVersion: 1;
  kind: 'normal-gui-launch';
  binding: ServiceBinding;
  launchKey: string;
  identityKey: string;
  privateDirectory: string;
  authenticationProof: string;
}

const keys = ['schemaVersion', 'kind', 'binding', 'launchKey', 'identityKey', 'privateDirectory', 'authenticationProof'];
const bindingKeys = ['integrationId', 'serviceId', 'workspace', 'serviceOrigin'];
function invalid(): never { throw new Error('Invalid supervisor launch metadata'); }
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return invalid();
  return record;
}

/** Caller supplies actual realpath, plugin server origin and ordinary service auth. */
export function parseNormalLaunch(serialized: string, realWorkspace: string, serviceOrigin: string, authorization: string): NormalLaunch {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 16_384) return invalid();
  let raw: Record<string, unknown>;
  try { raw = exact(JSON.parse(serialized), keys); } catch { return invalid(); }
  const owner = exact(raw.binding, bindingKeys);
  if (raw.schemaVersion !== 1 || raw.kind !== 'normal-gui-launch'
    || typeof raw.privateDirectory !== 'string' || raw.privateDirectory.length > 4096 || !isAbsolute(raw.privateDirectory)
    || [raw.launchKey, raw.identityKey, raw.authenticationProof, owner.integrationId, owner.serviceId]
      .some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    || owner.workspace !== canonicalWindowsWorkspace(realWorkspace) || owner.serviceOrigin !== serviceOrigin) return invalid();
  const binding = owner as unknown as ServiceBinding;
  const launchKey = raw.launchKey as string;
  let proof: string;
  try { proof = serviceAuthenticationProof(launchKey, binding, authorization); } catch { return invalid(); }
  if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(raw.authenticationProof as string, 'hex'))) return invalid();
  return { schemaVersion: 1, kind: 'normal-gui-launch', binding: { ...binding }, launchKey,
    identityKey: raw.identityKey as string, privateDirectory: raw.privateDirectory, authenticationProof: proof };
}
