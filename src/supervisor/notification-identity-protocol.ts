export interface NotificationIdentity {
  schemaVersion: 1;
  isolationId: string;
  instanceId: string;
  taskId: string;
  attemptId: string;
  parentSessionId: string;
  childSessionId: string;
  notificationId: string;
  eventId: string;
  messageId: string;
}
const fields = ['isolationId', 'instanceId', 'taskId', 'attemptId', 'parentSessionId', 'childSessionId',
  'notificationId', 'eventId', 'messageId'] as const;
export function parseNotificationIdentity(value: unknown): NotificationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notification identity');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || Object.keys(input).length !== fields.length + 1) throw new Error('Invalid identity schema');
  const result = { schemaVersion: 1 } as NotificationIdentity;
  for (const key of fields) {
    const field = input[key];
    if (typeof field !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(field)) throw new Error('Invalid identity field');
    result[key] = field;
  }
  if (!result.parentSessionId.startsWith('ses_') || !result.childSessionId.startsWith('ses_') || !result.messageId.startsWith('msg_')) {
    throw new Error('Invalid session/message identity');
  }
  return result;
}
