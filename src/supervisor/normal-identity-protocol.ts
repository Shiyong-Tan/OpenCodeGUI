import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseNotificationIdentity, type NotificationIdentity } from './notification-identity-protocol';

/** Wire v2 names the stable integration explicitly. Internal v1 projections retain
 * their legacy scope-key spelling so existing round owners need no migration. */
export interface NormalNotificationIdentity extends Omit<NotificationIdentity, 'schemaVersion' | 'isolationId'> {
  schemaVersion: 2;
  integrationId: string;
}
function invalid(): never { throw new Error('Invalid signed supervisor identity'); }
export function normalIdentityCodec(integrationId: string, identityKey: string) {
  if (![integrationId, identityKey].every(value => /^[a-f0-9]{64}$/.test(value))) return invalid();
  const normalize = (value: NotificationIdentity) => {
    const parsed = parseNotificationIdentity(value);
    if (parsed.isolationId !== integrationId) return invalid();
    return parsed;
  };
  const wire = (value: NotificationIdentity): NormalNotificationIdentity => {
    const { schemaVersion: _version, isolationId, ...fields } = normalize(value);
    return { schemaVersion: 2, integrationId: isolationId, ...fields };
  };
  const signature = (value: NormalNotificationIdentity) => createHmac('sha256', Buffer.from(identityKey, 'hex'))
    .update('supervisor/normal-notification/v2\0').update(JSON.stringify(value)).digest('hex');
  return {
    encode(value: NotificationIdentity): unknown {
      const payload = wire(value);
      return { payload, signature: signature(payload) };
    },
    decode(value: unknown): NotificationIdentity {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      const envelope = value as Record<string, unknown>;
      if (Object.keys(envelope).length !== 2 || !envelope.payload || typeof envelope.payload !== 'object'
        || Array.isArray(envelope.payload) || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) return invalid();
      const { schemaVersion, integrationId: scope, ...fields } = envelope.payload as Record<string, unknown>;
      if (schemaVersion !== 2 || scope !== integrationId || Object.prototype.hasOwnProperty.call(fields, 'isolationId')) return invalid();
      const parsed = normalize(parseNotificationIdentity({ schemaVersion: 1, isolationId: scope, ...fields }));
      const expected = signature(wire(parsed));
      if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.signature, 'hex'))) return invalid();
      return parsed;
    },
  };
}
