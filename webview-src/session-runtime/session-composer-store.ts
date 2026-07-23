export type SessionComposerSnapshot<TAttachment, TContext, TFileRef> = Readonly<{
  draft: string;
  attachments: readonly TAttachment[];
  contextItems: readonly TContext[];
  fileRefs: readonly TFileRef[];
}>;

export function createSessionComposerStore<TAttachment, TContext, TFileRef>() {
  const bySession = new Map<string, SessionComposerSnapshot<TAttachment, TContext, TFileRef>>();
  const empty = (): SessionComposerSnapshot<TAttachment, TContext, TFileRef> => ({
    draft: '',
    attachments: [],
    contextItems: [],
    fileRefs: [],
  });

  return Object.freeze({
    get(sessionId: string): SessionComposerSnapshot<TAttachment, TContext, TFileRef> {
      return bySession.get(sessionId) || empty();
    },
    setDraft(sessionId: string, draft: string): void {
      if (!sessionId) return;
      const current = bySession.get(sessionId) || empty();
      bySession.set(sessionId, {
        ...current,
        draft: typeof draft === 'string' ? draft : '',
      });
    },
    capture(
      sessionId: string,
      snapshot: SessionComposerSnapshot<TAttachment, TContext, TFileRef>,
    ): void {
      if (!sessionId) return;
      bySession.set(sessionId, {
        draft: typeof snapshot.draft === 'string' ? snapshot.draft : '',
        attachments: Array.from(snapshot.attachments || []),
        contextItems: Array.from(snapshot.contextItems || []),
        fileRefs: Array.from(snapshot.fileRefs || []),
      });
    },
    restoreDraft(sessionId: string, draft: string, attachments: readonly TAttachment[]): void {
      if (!sessionId) return;
      const current = bySession.get(sessionId) || empty();
      bySession.set(sessionId, {
        ...current,
        draft: typeof draft === 'string' ? draft : '',
        attachments: Array.from(attachments || []),
      });
    },
    addAttachment(sessionId: string, attachment: TAttachment): void {
      if (!sessionId) return;
      const current = bySession.get(sessionId) || empty();
      bySession.set(sessionId, {
        ...current,
        attachments: [...current.attachments, attachment],
      });
    },
    addContext(sessionId: string, context: TContext): void {
      if (!sessionId) return;
      const current = bySession.get(sessionId) || empty();
      bySession.set(sessionId, {
        ...current,
        contextItems: [...current.contextItems, context],
      });
    },
    deleteSession(sessionId: string): void {
      bySession.delete(sessionId);
    },
  });
}
