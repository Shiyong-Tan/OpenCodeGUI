import { parseOpenCodeVersion } from './opencode-version';
import { parseNotificationIdentity } from './notification-identity-protocol';
/** Only a bounded display title is allowed; prompts, commands and output stay private. */
type Parser<T> = (value: unknown) => T;
type Parsed<P> = P extends Parser<infer T> ? T : never;
const invalid = (): never => { throw new Error('Invalid supervisor snapshot'); };
const literal = <T extends string | number | boolean>(expected: T): Parser<T> => value => value === expected ? expected : invalid();
const text = (pattern: RegExp): Parser<string> => value => typeof value === 'string' && pattern.test(value) ? value : invalid();
const id = text(/^[A-Za-z0-9_-]{1,180}$/);
const session = text(/^ses_[A-Za-z0-9_-]{1,160}$/);
const counter = text(/^\d{1,40}$/);
const natural: Parser<number> = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const age: Parser<number> = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
const boolean: Parser<boolean> = value => typeof value === 'boolean' ? value : invalid();
const nullable = <T>(parser: Parser<T>): Parser<T | null> => value => value === null ? null : parser(value);
const state = <T extends string>(...values: T[]): Parser<T | 'unknown'> => value =>
  typeof value === 'string' ? (values.includes(value as T) ? value as T : 'unknown') : invalid();
const list = <T>(parser: Parser<T>, limit = 256): Parser<T[]> => value =>
  Array.isArray(value) && value.length <= limit ? value.map(parser) : invalid();
const object = <P extends Record<string, Parser<unknown>>>(fields: P): Parser<{ [K in keyof P]: Parsed<P[K]> }> => value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  // Rebuild from declared fields. Unknown fields never reach the Webview.
  return Object.fromEntries(Object.entries(fields).map(([key, parser]) => [key, parser(record[key])])) as { [K in keyof P]: Parsed<P[K]> };
};
const identity = { taskId: id, attemptId: id, parentSessionId: session, childSessionId: nullable(session) };
const task = object({ ...identity,
  title: value => value === undefined || value === null ? null : text(/^[^\x00-\x1f\x7f]{1,500}$/u)(value),
  phase: state('registered', 'dispatching', 'active', 'terminal'),
  health: state('running', 'waiting_permission', 'waiting_question', 'suspected_stall', 'unreachable', 'ended', 'cancel_unknown'),
  outcome: nullable(state('completed', 'failed')),
  lastObservationAgeMs: nullable(age), lastProgressAgeMs: age,
});
const execution = object({ ...identity, childSessionId: session, executionId: id, toolCallId: id,
  displayName: value => value == null ? null : text(/^[^\x00-\x1f\x7f]{1,180}$/u)(value),
  rootPid: value => value == null ? null : natural(value),
  activeProcesses: value => value == null ? null : natural(value),
  durationMs: value => value == null ? null : age(value),
  cpuPercent: value => value == null ? null : age(value),
  workingSetBytes: value => value == null ? null : counter(value),
  exitCode: value => value == null ? null : natural(value),
  phase: state('waiting_permission', 'starting', 'running', 'stopped', 'start_failed', 'permission_denied'),
  health: state('waiting_permission', 'running', 'suspect', 'unknown', 'stopped'),
  lastObservationAgeMs: nullable(age), lastActivityAgeMs: age,
  rootExited: nullable(boolean), ownedProcessesStopped: nullable(boolean),
  cpu100ns: nullable(counter), cpuDelta100ns: nullable(counter),
  readBytes: nullable(counter), writeBytes: nullable(counter),
  readDeltaBytes: nullable(counter), writeDeltaBytes: nullable(counter),
  cancelRequested: boolean, requestAccepted: nullable(boolean),
  cancelOutcomeUnknown: boolean, coverageUnknown: boolean, safeToRetry: literal(false),
});
const notice = object({ ...identity, childSessionId: session,
  notificationId: id, eventId: id, messageId: nullable(id),
  delivery: state('queued', 'submitting', 'submitted', 'unknown', 'received'),
  progress: state('not_observed', 'activity_observed', 'result_read'),
  escalated: boolean,
  queueAgeMs: value => value === undefined ? null : nullable(age)(value),
  activityWaitAgeMs: value => value === undefined ? null : nullable(age)(value),
});
const envelope = object({
  schemaVersion: literal(1), isolationId: id, instanceId: id, revision: natural,
  pluginVersion: text(/^\d+\.\d+\.\d+$/), openCodeVersion: parseOpenCodeVersion,
  observedAt: text(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  parentSessionId: session, scope: literal('isolated_allowlisted_commands'),
  tasks: list(task), executions: list(execution), notifications: list(notice),
  notificationIdentities: list(parseNotificationIdentity, 1024),
});
export type SupervisorView = ReturnType<typeof envelope>;

export function parseSupervisorView(value: unknown): SupervisorView {
  const view = envelope(value);
  if (!Number.isFinite(Date.parse(view.observedAt)) || new Date(view.observedAt).toISOString() !== view.observedAt) invalid();
  const tasks = new Map(view.tasks.map(t => [t.taskId, t]));
  if (tasks.size !== view.tasks.length) invalid();
  const all = [...view.tasks, ...view.executions, ...view.notifications];
  for (const entry of all) {
    if (entry.parentSessionId !== view.parentSessionId) invalid();
    const owner = tasks.get(entry.taskId);
    if (!owner || owner.attemptId !== entry.attemptId || owner.childSessionId !== entry.childSessionId) invalid();
  }
  for (const ids of [view.executions.map(e => e.executionId), view.notifications.map(n => n.notificationId),
    view.notifications.map(n => n.eventId), view.notifications.flatMap(n => n.messageId ? [n.messageId] : [])]) {
    if (new Set(ids).size !== ids.length) invalid();
  }
  for (const entry of view.executions) {
    if (entry.ownedProcessesStopped === true && (entry.rootExited !== true || entry.coverageUnknown || entry.cancelOutcomeUnknown)) invalid();
    if (entry.phase === 'stopped' && entry.ownedProcessesStopped !== true) invalid();
  }
  const identityMessages = new Set<string>();
  for (const identity of view.notificationIdentities) {
    if (identity.isolationId !== view.isolationId || identity.parentSessionId !== view.parentSessionId || identityMessages.has(identity.messageId)) invalid();
    identityMessages.add(identity.messageId);
  }
  return view;
}
