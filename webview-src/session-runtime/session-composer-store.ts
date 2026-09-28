export type SessionComposerSnapshot<TAttachment, TContext, TFileRef> = Readonly<{
  draft: string;
  attachments: readonly TAttachment[];
  contextItems: readonly TContext[];
  fileRefs: readonly TFileRef[];
}>;

export function createSessionComposerStore<TAttachment, TContext, TFileRef>() {
  const bySession = new Map<string, SessionComposerSnapshot<TAttachment, TContext, TFileRef>>();
  const submissions = new Map<string, {
    clientMessageId: string; opId: string; tmpKey: string;
    snapshot: SessionComposerSnapshot<TAttachment, TContext, TFileRef>;
  }>();
  const empty = (): SessionComposerSnapshot<TAttachment, TContext, TFileRef> => ({
    draft: '',
    attachments: [],
    contextItems: [],
    fileRefs: [],
  });

  return Object.freeze({
    rememberSubmission(sessionId: string, clientMessageId: string, opId: string, tmpKey: string): void {
      if (!sessionId || !clientMessageId.startsWith('local-') || !tmpKey?.startsWith('tmp:')) return;
      submissions.set(sessionId, { clientMessageId, opId, tmpKey, snapshot: bySession.get(sessionId) || empty() });
    },
    acceptSubmission(sessionId: string, clientMessageId: string, opId: string): void {
      const pending = submissions.get(sessionId);
      if (pending?.clientMessageId === clientMessageId && pending.opId === opId) submissions.delete(sessionId);
    },
    rejectSubmission(sessionId: string, clientMessageId: string, opId: string, tmpKey: string): boolean {
      const pending = submissions.get(sessionId);
      if (!pending || pending.clientMessageId !== clientMessageId || pending.opId !== opId || pending.tmpKey !== tmpKey) return false;
      submissions.delete(sessionId);
      const current = bySession.get(sessionId) || empty();
      // Preserve text typed while the send was in transit, and all attachment/context references.
      bySession.set(sessionId, {
        draft: [pending.snapshot.draft, current.draft].filter(Boolean).join('\n\n'),
        attachments: [...pending.snapshot.attachments, ...current.attachments],
        contextItems: [...pending.snapshot.contextItems, ...current.contextItems],
        fileRefs: [...pending.snapshot.fileRefs, ...current.fileRefs],
      });
      return true;
    },
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
      submissions.delete(sessionId);
    },
  });
}
