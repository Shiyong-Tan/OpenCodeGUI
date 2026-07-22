type ChangeListSession = {
  messagesById: Map<string, any>;
};

export function createChangeListEventController(options: {
  getSession(sessionId: string, create: boolean): ChangeListSession;
  discardAllSegments(sessionId: string, reason: string, mode: string): void;
  toStableMessageKey(session: ChangeListSession, messageId: string): string | null | undefined;
  upsertMessage(session: ChangeListSession, message: any): void;
  placeMessageAfterAnchor(session: ChangeListSession, messageId: string, anchorMessageId: string, reason: string): void;
  renderIfActive(sessionId: string, reason: string, options?: { scroll?: boolean }): void;
  postDebug(payload: string[]): void;
  now(): number;
}) {
  const handleDiffFileList = (sessionId: string, message: any, selectedMode: string): boolean => {
    options.discardAllSegments(sessionId, 'file-change-detected', selectedMode || 'unknown');
    const files = Array.isArray(message?.files)
      ? message.files.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : [];
    if (!files.length) return false;
    const commitHead = typeof message.commitHead === 'string' ? message.commitHead : '';
    const commitBase = typeof message.commitBase === 'string' ? message.commitBase : '';
    const changeListId = typeof message.changeListId === 'string' && message.changeListId.length > 0
      ? message.changeListId
      : (commitHead ? `system:changeList:${commitHead}` : `changes:${options.now()}`);
    const statsByPath = message.statsByPath && typeof message.statsByPath === 'object'
      ? message.statsByPath as Record<string, unknown>
      : {};
    const session = options.getSession(sessionId, true);
    const existing = session.messagesById.get(changeListId);
    const anchorMessageId = typeof message.anchorMessageId === 'string' && message.anchorMessageId.length > 0
      ? message.anchorMessageId
      : '';
    const stableAnchorMessageId = anchorMessageId
      ? (options.toStableMessageKey(session, anchorMessageId) || anchorMessageId)
      : '';
    const existingFiles = existing?.meta?.kind === 'changeList' && Array.isArray(existing.meta.files)
      ? existing.meta.files.filter((item: unknown): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const fileSet = new Set(files);
    const filteredStats = Object.fromEntries(
      Object.entries(statsByPath).filter(([path]) => fileSet.has(path)),
    );
    options.upsertMessage(session, {
      id: changeListId,
      role: 'system',
      text: '',
      meta: {
        kind: 'changeList',
        files,
        source: message.source || 'git',
        scope: message.scope || 'turn',
        commitHead: commitHead || undefined,
        commitBase: commitBase || undefined,
        reverted: message.reverted === true,
        statsByPath: filteredStats,
        anchorMessageId: anchorMessageId || existing?.meta?.anchorMessageId,
        stableAnchorMessageId: stableAnchorMessageId || existing?.meta?.stableAnchorMessageId,
      },
    });
    options.postDebug([
      '[WV][DIFF_FILE_LIST]',
      `sessionId=${sessionId}`,
      `changeListId=${changeListId}`,
      `incomingFileCount=${files.length}`,
      `existingFileCount=${existingFiles.length}`,
      `finalFileCount=${files.length}`,
    ]);
    if (stableAnchorMessageId) {
      options.placeMessageAfterAnchor(session, changeListId, stableAnchorMessageId, 'diffFileList');
    }
    options.renderIfActive(sessionId, 'diffFileList', { scroll: true });
    return true;
  };

  const handleChangeListUpdate = (sessionId: string, message: any): boolean => {
    const commitHead = typeof message?.commitHead === 'string' ? message.commitHead : '';
    if (!commitHead) return false;
    const session = options.getSession(sessionId, true);
    let updated = false;
    for (const candidate of session.messagesById.values()) {
      if (candidate?.meta?.kind === 'changeList' && candidate.meta.commitHead === commitHead) {
        candidate.meta.reverted = message.reverted === true;
        updated = true;
      }
    }
    if (updated) options.renderIfActive(sessionId, 'changeListUpdate');
    return updated;
  };

  return { handleDiffFileList, handleChangeListUpdate };
}
