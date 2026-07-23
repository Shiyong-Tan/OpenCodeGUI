export type SessionOverlayStoreOptions<TQuestion, TPermission> = Readonly<{
  questionIdentity(question: TQuestion): string;
  permissionIdentity(permission: TPermission): string;
}>;

type SessionOverlayEntry<TQuestion, TPermission> = {
  question: TQuestion | null;
  questionQueue: TQuestion[];
  permission: TPermission | null;
};

export type QuestionEnqueueResult = 'active' | 'queued' | 'duplicate';
export type PermissionSetResult = 'active' | 'duplicate';

export function createSessionOverlayStore<TQuestion, TPermission>(
  options: SessionOverlayStoreOptions<TQuestion, TPermission>,
) {
  const entries = new Map<string, SessionOverlayEntry<TQuestion, TPermission>>();

  function getOrCreate(sessionId: string): SessionOverlayEntry<TQuestion, TPermission> {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    const created = {
      question: null,
      questionQueue: [],
      permission: null,
    };
    entries.set(sessionId, created);
    return created;
  }

  function prune(sessionId: string, entry: SessionOverlayEntry<TQuestion, TPermission>): void {
    if (!entry.question && !entry.questionQueue.length && !entry.permission) {
      entries.delete(sessionId);
    }
  }

  return Object.freeze({
    getQuestion(sessionId: string): TQuestion | null {
      return entries.get(sessionId)?.question || null;
    },
    enqueueQuestion(sessionId: string, question: TQuestion): QuestionEnqueueResult {
      const entry = getOrCreate(sessionId);
      const identity = options.questionIdentity(question);
      if (
        (entry.question && options.questionIdentity(entry.question) === identity)
        || entry.questionQueue.some((queued) => options.questionIdentity(queued) === identity)
      ) {
        return 'duplicate';
      }
      if (!entry.question) {
        entry.question = question;
        return 'active';
      }
      entry.questionQueue.push(question);
      return 'queued';
    },
    updateQuestion(sessionId: string, update: (question: TQuestion) => TQuestion): TQuestion | null {
      const entry = entries.get(sessionId);
      if (!entry?.question) return null;
      entry.question = update(entry.question);
      return entry.question;
    },
    clearQuestion(
      sessionId: string,
      options: Readonly<{ advanceQueue?: boolean; clearQueue?: boolean }> = {},
    ): TQuestion | null {
      const entry = entries.get(sessionId);
      if (!entry) return null;
      entry.question = null;
      if (options.clearQueue) entry.questionQueue.length = 0;
      if (options.advanceQueue && entry.questionQueue.length) {
        entry.question = entry.questionQueue.shift() || null;
      }
      prune(sessionId, entry);
      return entry.question;
    },
    getQuestionQueueLength(sessionId: string): number {
      return entries.get(sessionId)?.questionQueue.length || 0;
    },
    getPermission(sessionId: string): TPermission | null {
      return entries.get(sessionId)?.permission || null;
    },
    setPermission(sessionId: string, permission: TPermission): PermissionSetResult {
      const entry = getOrCreate(sessionId);
      if (
        entry.permission
        && options.permissionIdentity(entry.permission) === options.permissionIdentity(permission)
      ) {
        return 'duplicate';
      }
      entry.permission = permission;
      return 'active';
    },
    updatePermission(
      sessionId: string,
      update: (permission: TPermission) => TPermission,
    ): TPermission | null {
      const entry = entries.get(sessionId);
      if (!entry?.permission) return null;
      entry.permission = update(entry.permission);
      return entry.permission;
    },
    clearPermission(sessionId: string): void {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entry.permission = null;
      prune(sessionId, entry);
    },
    deleteSession(sessionId: string): void {
      entries.delete(sessionId);
    },
  });
}
