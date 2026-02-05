const vscode = acquireVsCodeApi();

const md = window.markdownit({
    linkify: true,
    breaks: true,
    html: false
});

md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    return '<div class="md-table-wrap"><table' + self.renderAttrs(tokens[idx]) + '>';
};

md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return '</table></div>';
};

const purify = window.DOMPurify;

let models = [];
let sessions = [];
let selectedModel = '';
let selectedVariant = '';
let selectedMode = 'build';
let activeSessionId = '';
let isBusy = false;
let attachments = [];
let messageCounter = 0;
let collapsedProviders = new Set();
let modelDropdownOutsideHandler = null;
let simpleDropdownHandlers = new Map();
let conflictCardEl = null;
let lastConflictPayload = null;
let isSwitchingSession = false;
let pendingRefreshRequestId = null;

const sessionsById = new Map();
const pendingUiPrompts = [];

function formatList(values, max = 20) {
    if (!Array.isArray(values)) return '[]';
    if (values.length <= max) {
        return `[${values.join(', ')}]`;
    }
    const head = values.slice(0, 10);
    const tail = values.slice(-10);
    return `[${head.join(', ')}, ... , ${tail.join(', ')}]`;
}

function formatTail(values, max = 6) {
    if (!Array.isArray(values)) return '[]';
    const tail = values.slice(-max);
    return `[${tail.join(', ')}]`;
}

function timelineCounts(timeline) {
    let msg = 0;
    let tmp = 0;
    let local = 0;
    for (const id of timeline) {
        if (typeof id !== 'string') continue;
        if (id.startsWith('msg_')) msg++;
        else if (id.startsWith('tmp:')) tmp++;
        else if (id.startsWith('local-')) local++;
    }
    return { msg, tmp, local };
}

function logTimelineSnapshot(action, timeline, details) {
    const counts = timelineCounts(timeline);
    const tail = formatTail(timeline);
    const detailText = details ? ` ${details}` : '';
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_TIMELINE]', `action=${action}${detailText} size=${timeline.length} tail=${tail}`]
    });
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_TIMELINE]', `counts msg=${counts.msg} tmp=${counts.tmp} local=${counts.local}`]
    });
}

function logIdCandidates(prefix, message, sessionId, currentSessionId) {
    const keys = message ? Object.keys(message) : [];
    vscode.postMessage({
        type: 'ui-debug',
        payload: [prefix, `sessionPayload=${sessionId || 'null'} currentSession=${currentSessionId || 'null'} keys=[${keys.join(',')}]`]
    });
    const candidates = {
        msgId: message?.msgId,
        messageId: message?.messageId,
        id: message?.id,
        serverId: message?.serverId,
        assistantMsgId: message?.assistantMsgId
    };
    const parts = [];
    for (const [k, v] of Object.entries(candidates)) {
        if (typeof v === 'string' && v.length) {
            parts.push(`${k}=${v}`);
        }
    }
    if (parts.length) {
        vscode.postMessage({ type: 'ui-debug', payload: [prefix, `idCandidates ${parts.join(' ')}`] });
    }
}

function createSessionState() {
    return {
        messagesById: new Map(),
        timeline: [],
        segments: [],
        hiddenSet: new Set(),
        thinkingId: null,
        nextOrder: 0,
        serverIdToKey: new Map(),
        clientKeyToServerId: new Map(),
        serverIdToClientKey: new Map(),
        pendingUndo: null,
        pendingUndoByNoticeKey: new Map(),
        noticeKeyByOpId: new Map(),
        undoNoticeKeyByOpId: new Map(),
        lastUndoNoticeKey: null,
        seenUndoAckOpIds: new Set(),
        seenRestoreAckOpIds: new Set(),
        persistedSegments: new Map(),
        pendingSegments: []
    };
}

function getSessionState(sessionId, create = false) {
    if (!sessionId) return null;
    if (!sessionsById.has(sessionId) && create) {
        sessionsById.set(sessionId, createSessionState());
    }
    return sessionsById.get(sessionId) || null;
}

function getEventSessionId(message, eventName) {
    const sessionId =
        message?.sessionID ||
        message?.sessionId ||
        message?.part?.sessionID ||
        message?.part?.sessionId ||
        '';
    if (!sessionId) {
        console.warn(`[SessionGate] drop event=${eventName} missing sessionID`, message);
        return null;
    }
    return sessionId;
}

function getEventMessageId(message) {
    return (
        message?.messageId ||
        message?.messageID ||
        message?.part?.messageId ||
        message?.part?.messageID ||
        message?.metadata?.openai?.itemId ||
        ''
    );
}

function getEventChunkText(message) {
    return message?.value || message?.part?.text || '';
}

function registerServerId(sessionId, serverId, messageKey) {
    const session = getSessionState(sessionId);
    if (!session) return;
    if (serverId && messageKey) {
        session.serverIdToKey.set(serverId, messageKey);
        vscode.postMessage({ type: 'ui-debug', payload: ['registerServerId', serverId, messageKey] });
    }
}

function registerMessageIdMapping(session, localKey, serverId, source) {
    if (!session || typeof localKey !== 'string' || typeof serverId !== 'string') return;
    if (!localKey.startsWith('local-')) return;
    if (!serverId.startsWith('msg_')) return;

    const existingServerForLocal = session.clientKeyToServerId.get(localKey);
    const existingLocalForServer = session.serverIdToClientKey.get(serverId);
    const conflictLocal = Boolean(existingServerForLocal && existingServerForLocal !== serverId);
    const conflictServer = Boolean(existingLocalForServer && existingLocalForServer !== localKey);

    if (conflictLocal || conflictServer) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'messageIdMap', 'mapping-conflict',
                'source', source,
                'localKey', localKey,
                'serverId', serverId,
                'canonicalStable', serverId,
                'conflictLocal', conflictLocal,
                'conflictServer', conflictServer,
                'existingServerForLocal', existingServerForLocal || 'none',
                'existingLocalForServer', existingLocalForServer || 'none']
        });
        return;
    }

    if (existingServerForLocal === serverId && existingLocalForServer === localKey) return;

    session.clientKeyToServerId.set(localKey, serverId);
    session.serverIdToClientKey.set(serverId, localKey);

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['WV', 'messageIdMap', 'mapping-registered',
            'source', source,
            'localKey', localKey,
            'serverId', serverId,
            'canonicalStable', serverId,
            'conflictLocal', conflictLocal,
            'conflictServer', conflictServer]
    });
}

function toStableMessageKey(session, key) {
    if (!key || typeof key !== 'string') return null;
    if (key.startsWith('msg_')) return key;
    if (key.startsWith('tmp:')) return null;
    if (key.startsWith('local-')) {
        const mappedServerId = session?.clientKeyToServerId?.get(key);
        if (mappedServerId && mappedServerId.startsWith('msg_')) {
            return mappedServerId;
        }
        return null;
    }
    return null;
}

function createMessage(session, payload) {
    const order = typeof payload.order === 'number' ? payload.order : session.nextOrder++;
    return {
        id: payload.id,
        role: payload.role,
        text: payload.text || '',
        meta: { ...(payload.meta || {}) },
        order
    };
}

function upsertMessage(session, payload) {
    const existing = session.messagesById.get(payload.id);
    if (existing) {
        const next = {
            ...existing,
            role: payload.role || existing.role,
            text: typeof payload.text === 'string' ? payload.text : existing.text,
            meta: { ...existing.meta, ...(payload.meta || {}) }
        };
        session.messagesById.set(payload.id, next);
        return next;
    }
    const message = createMessage(session, payload);
    session.messagesById.set(message.id, message);
    session.timeline.push(message.id);
    logTimelineSnapshot('append', session.timeline, `key=${message.id}`);
    return message;
}

function isUndoRestoreStatusText(text) {
    if (!text || typeof text !== 'string') return null;

    if (text.startsWith('Undo applied.')) {
        return { kind: 'undo', textNormalized: text };
    }
    if (text.startsWith('Restore applied.')) {
        return { kind: 'restore', textNormalized: text };
    }
    if (text.includes('No tracked file changes were available to revert')) {
        return { kind: 'undo', textNormalized: 'Undo applied. No tracked file changes were available to revert.' };
    }
    return null;
}

function updateExistingUndoNotice(session, opId, startServerId, status) {
    const stableId = startServerId;
    if (!stableId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['updateExistingUndoNotice', 'drop-missing-stableId', 'opId', opId]
        });
        return;
    }

    const noticeKey = `system:undo:${stableId}`;
    const notice = session.messagesById.get(noticeKey);

    if (notice) {
        notice.text = status.textNormalized;
        notice.meta.kind = status.kind === 'undo' ? 'undoNotice' : 'restoreNotice';
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['updateExistingUndoNotice', 'updated', 'noticeKey', noticeKey, 'kind', status.kind]
        });
    } else {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['updateExistingUndoNotice', 'notice-not-found', 'noticeKey', noticeKey, 'opId', opId]
        });
    }
}

function upsertUndoNotice(session, operationId, startServerId, text, anchorKey, source) {
    const stableId = startServerId || anchorKey;

    if (!stableId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['upsertUndoNotice', 'drop-missing-stable-id', 'opId', operationId, 'source', source]
        });
        return;
    }

    const k = `system:undo:${stableId}`;

    if (operationId) {
        session.noticeKeyByOpId.set(operationId, k);
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['upsertUndoNotice', 'mapped-opId', operationId, 'noticeKey', k]
        });
    }

    const existed = session.messagesById.has(k);

    upsertMessage(session, {
        id: k,
        role: 'system',
        text,
        meta: { kind: 'undoNotice', operationId, stableId }
    });

    if (!existed && !session.timeline.includes(k)) {
        session.timeline.push(k);
    }

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['upsertUndoNotice', 'stableKey', k, 'opId', operationId, 'source', source, 'timelineHas', session.timeline.includes(k)]
    });

    return k;
}

function replaceKeyEverywhere(sessionId, oldId, newId) {
    const session = getSessionState(sessionId);
    if (!session) return;

    const message = session.messagesById.get(oldId) || null;
    const existing = session.messagesById.get(newId) || null;

    let timelineIndex = -1;
    let timelineReplaced = false;
    let deduped = false;

    if (message) {
        session.messagesById.delete(oldId);
        if (!existing) {
            message.id = newId;
            session.messagesById.set(newId, message);
        }
    }

    session.timeline = session.timeline.map((id, idx) => {
        if (id === oldId) {
            if (timelineIndex === -1) timelineIndex = idx;
            timelineReplaced = true;
            return newId;
        }
        return id;
    });

    const seen = new Set();
    session.timeline = session.timeline.filter(id => {
        if (seen.has(id)) {
            deduped = true;
            return false;
        }
        seen.add(id);
        return true;
    });

    for (const segment of session.segments) {
        if (segment.memberIds.has(oldId)) {
            segment.memberIds.delete(oldId);
            segment.memberIds.add(newId);
        }
    }

    if (session.thinkingId === oldId) {
        session.thinkingId = newId;
    }

    if (session.clientKeyToServerId?.get(oldId) === newId) {
        session.clientKeyToServerId.delete(oldId);
    }
    if (session.serverIdToClientKey?.get(newId) === oldId) {
        session.serverIdToClientKey.set(newId, newId);
    }

    const timelineSample = session.timeline.slice(0, 5);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['replaceKeyEverywhere', 'oldKey', oldId, 'newKey', newId,
            'timelineIndex', timelineIndex,
            'timelineReplaced', timelineReplaced,
            'deduped', deduped,
            'hadOldMsg', Boolean(message),
            'hadNewMsg', Boolean(existing),
            'timelineSample', timelineSample]
    });
    logTimelineSnapshot('replace', session.timeline, `old=${oldId} new=${newId}`);
}

function freezeSegments(session) {
    for (const segment of session.segments) {
        segment.state = 'frozen';
    }
}

function ensureThinkingUnique(session, source) {
    const thinkingMessages = [];
    for (const msg of session.messagesById.values()) {
        if (msg.role === 'assistant' && msg.meta?.isThinking === true) {
            thinkingMessages.push(msg);
        }
    }

    if (!thinkingMessages.length) {
        session.thinkingId = null;
        return;
    }

    thinkingMessages.sort((a, b) => b.order - a.order);
    const winner = thinkingMessages[0];
    for (let i = 1; i < thinkingMessages.length; i++) {
        thinkingMessages[i].meta.isThinking = false;
    }
    session.thinkingId = winner.id;
    console.warn(`[Thinking] invariant fix (${source}): kept=${winner.id} cleared=${thinkingMessages.length - 1}`);
}

function repairSegmentOverlap(session, source) {
    const sorted = session.segments.slice().sort((a, b) => a.anchorOrder - b.anchorOrder);
    const used = new Set();
    const repaired = [];

    for (const segment of sorted) {
        const nextMembers = new Set();
        let overlapCount = 0;
        for (const id of segment.memberIds) {
            if (used.has(id)) {
                overlapCount++;
                continue;
            }
            nextMembers.add(id);
            used.add(id);
        }
        if (overlapCount > 0) {
            console.warn(`[Segment] overlap repaired (${source}) seg=${segment.id} removed=${overlapCount}`);
        }
        if (nextMembers.size > 0) {
            segment.memberIds = nextMembers;
            repaired.push(segment);
        } else {
            console.warn(`[Segment] removed empty segment (${source}) seg=${segment.id}`);
        }
    }

    session.segments = repaired;
}

function assertInvariants(sessionId, source) {
    const session = getSessionState(sessionId);
    if (!session) return;
    ensureThinkingUnique(session, source);
    repairSegmentOverlap(session, source);
}

function logSessionState(sessionId, eventName) {
    const session = getSessionState(sessionId);
    if (!session) return;
    const segments = session.segments.map((seg) => ({
        id: seg.id,
        anchorOrder: seg.anchorOrder,
        state: seg.state,
        size: seg.memberIds.size
    }));
    console.log(`[session] activeSessionId=${activeSessionId} event=${eventName} sessionId=${sessionId}`);
    console.log('[session] thinkingId=', session.thinkingId);
    console.log('[session] segments=', segments);
}

function createTempAssistantId() {
    const suffix = Math.random().toString(36).slice(2, 10);
    return `tmp:${Date.now()}-${suffix}`;
}

function applyRevertedSegmentPayload(sessionId, payload, noticeKeyFromCaller) {
    const session = getSessionState(sessionId, true);

    const beforeCount = session.segments.length;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['applyRevertedSegmentPayload', 'before', 'segmentsCount', beforeCount]
    });

    if (!payload) {
        vscode.postMessage({ type: 'ui-debug', payload: ['applyRevertedSegmentPayload', 'payload-null-skip'] });
        return;
    }

    const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds : [];
    const historySegments = Array.isArray(payload.historySegments) ? payload.historySegments : [];

    function mapToFrontendKey(serverId) {
        if (!serverId) return null;

        if (serverId.startsWith('system:')) {
            return serverId;
        }

        if (serverId.startsWith('msg_')) {
            if (session.messagesById.has(serverId)) {
                if (!session.timeline.includes(serverId)) {
                    session.timeline.push(serverId);
                }
                return serverId;
            }
            upsertMessage(session, {
                id: serverId,
                role: 'assistant',
                text: '',
                meta: { isGhost: true }
            });
            if (!session.timeline.includes(serverId)) {
                session.timeline.push(serverId);
            }
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['applyRevertedSegmentPayload', 'created-placeholder', serverId]
            });
            return serverId;
        }

        vscode.postMessage({
            type: 'ui-debug',
            payload: ['applyRevertedSegmentPayload', 'WARNING-unknown-format', serverId]
        });
        return null;
    }

    for (const entry of historySegments) {
        if (!Array.isArray(entry.messageIds) || !entry.messageIds.length) continue;

        const anchorOrder = getAnchorOrder(session, entry.startMessageId || entry.messageIds[0]);
        const segmentId = `seg:${entry.startMessageId || entry.messageIds[0]}`;

        const seg = session.segments.find(s => s.anchorOrder === anchorOrder);
        if (seg) {
            seg.state = 'frozen';
            seg.isExpanded = false;
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['applyRevertedSegmentPayload', 'history-update-state', 'segmentId', segmentId, 'anchorOrder', anchorOrder]
            });
        }
    }

    if (payload.operationId) {
        const segId = `seg:${payload.operationId}`;
        const noticeKeySegId = noticeKeyFromCaller ? `seg:${noticeKeyFromCaller}` : null;
        
        let seg = session.segments.find(s => s.id === segId);
        
        if (!seg && noticeKeySegId) {
            seg = session.segments.find(s => s.id === noticeKeySegId);
            if (seg) {
                vscode.postMessage({ type: 'ui-debug', payload: ['applyRevertedSegmentPayload', 'matched-by-noticeKey', 'noticeKey', noticeKeyFromCaller] });
            }
        }

        if (seg) {
            seg.state = payload.discarded ? 'frozen' : 'restorable';
            seg.isExpanded = !payload.collapsed;
            vscode.postMessage({ type: 'ui-debug', payload: ['applyRevertedSegmentPayload', 'opId', payload.operationId, 'action', 'update-state-only'] });
        } else if (session.pendingUndo?.opId !== payload.operationId && !noticeKeySegId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['applyRevertedSegmentPayload', 'opId', payload.operationId, 'action', 'drop-unknown-opId'] });
        }
    }

    const segmentMemberIds = session.segments.flatMap(s => Array.from(s.memberIds));
    const timelineSample = session.timeline.slice(0, 3);
    const firstHidden = session.segments.length > 0 && session.segments[0].memberIds.has(timelineSample[0]);

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['applyRevertedSegmentPayload', 'after',
            'segmentsCount', session.segments.length,
            'segmentMemberIds', segmentMemberIds,
            'timelineSample', timelineSample,
            'firstHidden', firstHidden]
    });

    assertInvariants(sessionId, 'applyRevertedSegmentPayload');
}

function getAnchorOrder(session, messageId) {
    if (!messageId) {
        vscode.postMessage({ 
            type: 'ui-debug', 
            payload: ['getAnchorOrder', 'WARNING-null-messageId'] 
        });
        return session.nextOrder;
    }
    
    const msg = session.messagesById.get(messageId);
    if (msg && typeof msg.order === 'number') {
        return msg.order;
    }
    
    for (const id of session.timeline) {
        const m = session.messagesById.get(id);
        if (m && typeof m.order === 'number') {
            return m.order;
        }
    }
    
    const fallbackOrder = session.nextOrder;
    vscode.postMessage({ 
        type: 'ui-debug', 
        payload: ['getAnchorOrder', 'WARNING-fallback', 'messageId', messageId, 'fallbackOrder', fallbackOrder] 
    });
    return fallbackOrder;
}

function reconcilePendingSegments(sessionId) {
    const session = getSessionState(sessionId);
    if (!session) return;

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['WV', 'reconcilePending', 'enter', 'sessionId', sessionId, 'pendingCount', session.pendingSegments.length]
    });

    const serverIdToKey = new Map();
    for (const id of session.timeline) {
        if (id.startsWith('msg_')) {
            if (!serverIdToKey.has(id)) {
                serverIdToKey.set(id, id);
            }
        }
    }
    for (const [serverId, key] of session.serverIdToKey) {
        if (!serverIdToKey.has(serverId)) {
            serverIdToKey.set(serverId, key);
        }
    }
    const timelineSet = new Set(session.timeline);

    let newlyActive = 0;
    const stillPending = [];

    for (const pending of session.pendingSegments) {
        const mappedKeys = [];
        const unmatched = [];
        const unmatchedReasons = [];

        const stableMemberKeys = Array.isArray(pending.memberKeys) ? pending.memberKeys : [];
        let stableKeysPresentInTimelineCount = 0;

        if (stableMemberKeys.length > 0) {
            for (const key of stableMemberKeys) {
                if (timelineSet.has(key)) {
                    mappedKeys.push(key);
                    stableKeysPresentInTimelineCount++;
                } else {
                    unmatched.push(key);
                    unmatchedReasons.push(`not-in-timeline:${key}`);
                }
            }
        } else {
            for (const serverId of pending.membersStable) {
                if (serverIdToKey.has(serverId)) {
                    mappedKeys.push(serverIdToKey.get(serverId));
                } else {
                    unmatched.push(serverId);
                    unmatchedReasons.push(`not-in-timeline:${serverId}`);
                }
            }
        }

        if (unmatched.length === 0 && mappedKeys.length > 0) {
            const segmentId = `seg:${pending.noticeKey}`;

            let existing = session.segments.find(s => s.id === segmentId);
            if (!existing) {
                existing = {
                    id: segmentId,
                    anchorOrder: session.nextOrder,
                    memberIds: new Set(mappedKeys),
                    state: 'restorable',
                    isExpanded: false
                };
                session.segments.push(existing);
            } else {
                existing.memberIds = new Set(mappedKeys);
            }

            for (const key of mappedKeys) {
                session.hiddenSet.add(key);
            }

            newlyActive++;

            vscode.postMessage({
                type: 'ui-debug',
                payload: ['WV', 'segment', 'activated',
                    'noticeKey', pending.noticeKey,
                    'members', mappedKeys.length,
                    'stableKeysPresentInTimelineCount', stableKeysPresentInTimelineCount,
                    'hiddenSetSize', session.hiddenSet.size,
                    'sessionId', sessionId
                ]
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_SEG_HYDRATE]', `segment notice=${pending.noticeKey} memberKeys=${formatList(mappedKeys)}`]
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_SEG_HYDRATE]', `matched=${mappedKeys.length} missing=[] method=timeline-only+pending`]
            });
        } else {
            pending.matchedKeys = mappedKeys;
            pending.unmatched = unmatched;

            if (unmatched.length > 0 && Date.now() - pending.createdAt > 10 * 60 * 1000) {
                pending.isStale = true;
            }

            stillPending.push(pending);

            vscode.postMessage({
                type: 'ui-debug',
                payload: ['WV', 'segment', 'still-pending',
                    'noticeKey', pending.noticeKey,
                    'stableMembers', pending.membersStable.length,
                    'matched', mappedKeys.length,
                    'unmatched', unmatched.length,
                    'stableKeysPresentInTimelineCount', stableKeysPresentInTimelineCount,
                    'unmatchedSample', unmatched.slice(0, 3).join(','),
                    'reasons', unmatchedReasons.slice(0, 3).join(';'),
                    'isStale', pending.isStale,
                    'sessionId', sessionId
                ]
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_SEG_HYDRATE]', `segment notice=${pending.noticeKey} memberKeys=${formatList(pending.membersStable)}`]
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_SEG_HYDRATE]', `matched=${mappedKeys.length} missing=${formatList(unmatched)} method=timeline-only+pending`]
            });
        }
    }

    session.pendingSegments = stillPending;

    session.segments = session.segments.filter(s => s.memberIds.size > 0);
    session.segments.sort((a, b) => a.anchorOrder - b.anchorOrder);

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['WV', 'reconcilePending', 'done',
            'sessionId', sessionId,
            'newlyActivated', newlyActive,
            'stillPending', stillPending.length,
            'hiddenSetSize', session.hiddenSet.size
        ]
    });

    window.__oc?.renderFromState?.();
}

function createSegmentFromUndo(sessionId, targetMessageId, opId) {
    const session = getSessionState(sessionId);
    if (!session) return null;

    const target = session.messagesById.get(targetMessageId);
    if (!target) return null;

    const anchorOrder = target.order;
    const members = [];
    for (const key of session.timeline) {
        const msg = session.messagesById.get(key);
        if (msg && msg.order >= anchorOrder && typeof key === 'string' && key.startsWith('msg_')) {
            members.push(key);
        }
    }

    if (members.length === 0) return null;

    const segment = {
        id: `seg:pending:${opId}`,
        anchorOrder,
        memberIds: new Set(members),
        state: 'restorable',
        isExpanded: false
    };

    const existingIdx = session.segments.findIndex(s => s.anchorOrder === anchorOrder);
    if (existingIdx !== -1) {
        session.segments[existingIdx] = segment;
    } else {
        session.segments.push(segment);
        session.segments.sort((a, b) => a.anchorOrder - b.anchorOrder);
    }

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['createSegmentFromUndo', 'opId', opId, 'anchor', targetMessageId, 'membersCount', members.length, 'members', members]
    });

    return segment;
}

function buildUndoMembersFromTimeline(session, anchorMsgId) {
    const anchorIndex = session.timeline.indexOf(anchorMsgId);
    if (anchorIndex === -1) {
        vscode.postMessage({ type: 'ui-debug', payload: ['buildUndoMembersFromTimeline', 'anchorNotFound', anchorMsgId, 'timelineSample', session.timeline.slice(0, 3)] });
        return [];
    }

    const members = [];
    for (let i = anchorIndex; i < session.timeline.length; i++) {
        const key = session.timeline[i];
        if (typeof key === 'string' && key.startsWith('msg_')) {
            members.push(key);
        }
    }

    const membersList = formatList(members, 20);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_UNDO_MEMBERS]', `anchor=${anchorMsgId} idx=${anchorIndex} membersCount=${members.length} members=${membersList}`]
    });
    const tailSlice = session.timeline.slice(anchorIndex, anchorIndex + 40);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_UNDO_MEMBERS]', `tailSlice=${formatList(tailSlice, 40)}`]
    });

    if (members.length === 0) {
        vscode.postMessage({ type: 'ui-debug', payload: ['segment.skip', 'reason', 'emptyMembers', 'anchorMsgId', anchorMsgId] });
    }

    return members;
}

function resolveToMsgId(session, anchorKey) {
    if (!anchorKey || typeof anchorKey !== 'string') return null;
    if (anchorKey.startsWith('msg_')) return anchorKey;
    if (anchorKey.startsWith('local-')) {
        return session?.clientKeyToServerId?.get(anchorKey) || null;
    }
    return null;
}

function canUndo(session, anchorKey) {
    const msgId = resolveToMsgId(session, anchorKey);
    if (!msgId) {
        return { allowed: false, reason: 'unresolved', msgId: null };
    }
    if (session?.thinkingId) {
        return { allowed: false, reason: 'streaming', msgId };
    }
    for (const msg of session?.messagesById?.values?.() || []) {
        if (msg?.meta?.isThinking === true) {
            return { allowed: false, reason: 'streaming', msgId };
        }
    }
    return { allowed: true, reason: 'ok', msgId };
}

function attemptAssistantUpgrade(sessionId, payload, source) {
    const currentSession = activeSessionId;
    const payloadSession = sessionId || payload?.sessionId || payload?.sessionID || null;
    const tmpKey = payload?.tmpKey;
    const assistantMsgId = payload?.assistantMsgId;

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_WV_ID]', `type=${source} sessionPayload=${payloadSession || 'null'} currentSession=${currentSession || 'null'} tmpKey=${tmpKey || 'null'} assistantMsgId=${assistantMsgId || 'null'}`]
    });

    if (!payloadSession || payloadSession !== currentSession) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey || 'null'} msgId=${assistantMsgId || 'null'} replaced=false reason=session-mismatch`] });
        return;
    }
    if (typeof tmpKey !== 'string' || typeof assistantMsgId !== 'string') {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey || 'null'} msgId=${assistantMsgId || 'null'} replaced=false reason=missing-fields`] });
        return;
    }
    if (!tmpKey.startsWith('tmp:') || !assistantMsgId.startsWith('msg_')) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey} msgId=${assistantMsgId} replaced=false reason=bad-prefix`] });
        return;
    }
    const session = getSessionState(payloadSession);
    if (!session) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey} msgId=${assistantMsgId} replaced=false reason=no-session`] });
        return;
    }
    const hasTmp = session.messagesById.has(tmpKey) || session.timeline.includes(tmpKey);
    if (!hasTmp) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey} msgId=${assistantMsgId} replaced=false reason=already-upgraded`] });
        return;
    }
    replaceKeyEverywhere(payloadSession, tmpKey, assistantMsgId);
    vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey} msgId=${assistantMsgId} replaced=true reason=ok`] });
}

function handleUndoToMessage(sessionId, targetMessageId) {
    const session = getSessionState(sessionId);
    if (!session) return;
    const target = session.messagesById.get(targetMessageId);
    if (!target) {
        vscode.postMessage({ type: 'ui-debug', payload: ['undo', 'target-not-found', targetMessageId, 'sessionId', sessionId] });
        return;
    }

    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const serverId = targetMessageId;

    session.pendingUndo = { opId, anchorKey: targetMessageId, anchorServerId: serverId, ts: Date.now() };

    const noticeKey = `system:undo:${serverId}`;
    session.undoNoticeKeyByOpId.set(opId, noticeKey);
    session.lastUndoNoticeKey = noticeKey;

    session.pendingUndoByNoticeKey = session.pendingUndoByNoticeKey || new Map();
    session.pendingUndoByNoticeKey.set(noticeKey, {
        clientOpId: opId,
        anchorKey: targetMessageId,
        anchorServerId: serverId,
        noticeKey: noticeKey,
        createdAt: Date.now()
    });

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['WV', 'undo', 'send', 'clientOpId', opId, 'anchorKey', targetMessageId, 'serverId', serverId, 'noticeKey', noticeKey, 'sessionId', sessionId]
    });
    vscode.postMessage({ type: 'ui-debug', payload: ['WV', 'undo', 'pending', 'noticeKey', noticeKey, 'clientOpId', opId, 'sessionId', sessionId] });
    vscode.postMessage({ type: 'undoToMessage', sessionId, operationId: opId, messageId: serverId });

    setTimeout(() => handleUndoTimeout(sessionId), 800);
}

function handleUndoTimeout(sessionId) {
    const session = getSessionState(sessionId);
    if (!session || !session.pendingUndo) return;

    const { opId, anchorKey } = session.pendingUndo;
    const now = Date.now();
    const elapsed = now - session.pendingUndo.ts;

    if (elapsed < 800) return;

    const timeoutKey = `system:undo-timeout:${opId}`;
    upsertMessage(session, {
        id: timeoutKey,
        role: 'system',
        text: 'Undo request timed out (no ack from extension).',
        meta: { kind: 'undoTimeout', opId, anchorKey }
    });
    if (!session.timeline.includes(timeoutKey)) {
        session.timeline.push(timeoutKey);
    }

    session.pendingUndo = null;

    vscode.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout', opId, 'elapsed', elapsed, 'sessionId', sessionId] });
    window.__oc?.renderFromState?.();
}

    function handleRestoreSegment(sessionId, segmentId) {
        const session = getSessionState(sessionId);
        if (!session) return;
        const segment = session.segments.find((seg) => seg.id === segmentId);
        if (!segment || segment.state !== 'restorable') return;
        const baseHidden = session.hiddenSet instanceof Set
            ? session.hiddenSet
            : new Set(Array.isArray(session.hiddenSet) ? session.hiddenSet : []);
        const beforeHiddenSize = baseHidden.size;
        const stableKeysRaw = segment.memberIds ? Array.from(segment.memberIds) : (Array.isArray(segment.memberKeys) ? segment.memberKeys : []);
        const stableKeys = stableKeysRaw.filter((k) => typeof k === 'string' && k.startsWith('msg_'));

        let stableRemovedCount = 0;
        for (const key of stableKeys) {
            if (baseHidden.delete(key)) {
                stableRemovedCount++;
            }
        }

        session.hiddenSet = baseHidden;

        vscode.postMessage({
            type: 'ui-debug',
            payload: ['restore.apply',
                'noticeKey', segment.noticeKey ?? segment.id ?? 'unknown',
                'unhideCount', stableRemovedCount,
                'unhideSample', stableKeys.slice(0, 3).join(','),
                'baseHiddenBefore', beforeHiddenSize,
                'baseHiddenAfter', baseHidden.size]
        });
        session.segments = session.segments.filter((seg) => seg.id !== segmentId);
        assertInvariants(sessionId, 'restore');
    }

function handleToggleSegment(sessionId, segmentId) {
    const session = getSessionState(sessionId);
    if (!session) return;
    const segment = session.segments.find((seg) => seg.id === segmentId);
    if (!segment) return;
    segment.isExpanded = !segment.isExpanded;
    assertInvariants(sessionId, 'toggleSegment');
}

function renderMarkdownInto(element, text) {
    const raw = md.render(text);
    element.innerHTML = purify.sanitize(raw, {
        ALLOWED_TAGS: [
            'a', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
            'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
            'table', 'thead', 'tbody', 'tr', 'th', 'td'
        ],
        ALLOWED_ATTR: ['href', 'title', 'target', 'rel']
    });
    for (const link of element.querySelectorAll('a')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
    }
    if (window.hljs && typeof window.hljs.highlightElement === 'function') {
        for (const block of element.querySelectorAll('pre code')) {
            window.hljs.highlightElement(block);
        }
    }
    wrapTables(element);
}

function wrapTables(root) {
    const tables = root.querySelectorAll('table');
    let wrapped = 0;
    for (const table of tables) {
        if (table.parentElement?.classList.contains('md-table-wrap')) continue;
        const wrapper = document.createElement('div');
        wrapper.className = 'md-table-wrap';
        table.parentElement.insertBefore(wrapper, table);
        wrapper.appendChild(table);
        wrapped++;
    }
    return wrapped;
}

document.addEventListener('DOMContentLoaded', () => {
    const sendBtn = document.getElementById('send-btn');
    const sendIcon = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>
        </svg>
    `;
    const stopIcon = `
        <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path d="M4 4h8v8H4z"/>
        </svg>
    `;
    const input = document.getElementById('chat-input');
    const chatContainer = document.getElementById('chat');
    const modelSelect = document.getElementById('model-select');
    const modeSelect = document.getElementById('mode-select');
    const variantSelect = document.getElementById('variant-select');
    const sessionTitle = document.getElementById('session-title');
    const historyBtn = document.getElementById('history-btn');
    const newSessionBtn = document.getElementById('new-session-btn');
    const sessionPanel = document.getElementById('session-panel');
    const sessionList = document.getElementById('session-list');
    const attachmentList = document.getElementById('attachment-list');
    const panelBackdrop = document.getElementById('panel-backdrop');
    const refreshSessionsBtn = document.getElementById('refresh-sessions');
    const closeSessionsBtn = document.getElementById('close-sessions');

    const webviewInstanceId = `wv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vscode.postMessage({ type: 'ui-debug', payload: ['WV', 'webviewReady', 'id', webviewInstanceId] });
    vscode.postMessage({ type: 'webviewReady', webviewInstanceId });
    sendBtn.innerHTML = sendIcon;

    function setBusy(nextBusy) {
        isBusy = nextBusy;
        sendBtn.innerHTML = isBusy ? stopIcon : sendIcon;
        sendBtn.classList.toggle('is-busy', isBusy);
    }

    function getSessionOrNull(sessionId) {
        return getSessionState(sessionId, false);
    }

    function setDefaultGreeting() {
        chatContainer.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'message bot';
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = 'Hello! I am OpenCode. How can I help you today?';
        div.appendChild(content);
        chatContainer.appendChild(div);
    }

    function renderMessageElement(message, renderedSet) {
        if (renderedSet.has(message.id)) {
            console.warn('[Render] duplicate message skipped', message.id);
            return;
        }
        renderedSet.add(message.id);

        const messageType = message.role === 'assistant'
            ? 'bot'
            : message.role === 'user'
                ? 'user'
                : message.role;

        const div = document.createElement('div');
        const isUser = messageType === 'user';
        const isSystem = messageType === 'system' || messageType === 'tool';
        div.className = `message ${isUser ? 'user' : isSystem ? 'system' : 'bot'}`;
        if (message.meta?.isThinking === true) {
            div.classList.add('thinking');
        }
        div.dataset.messageId = message.id;

        const content = document.createElement('div');
        content.className = 'message-content';
        if (message.meta?.isDiff) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = message.meta.diffText || message.text || '';
            pre.appendChild(code);
            content.appendChild(pre);
        } else if (message.role === 'assistant') {
            renderMarkdownInto(content, message.text || '');
        } else {
            content.textContent = message.text || '';
        }
        div.appendChild(content);

        if (Array.isArray(message.meta?.images) && message.meta.images.length) {
            const imageWrap = document.createElement('div');
            imageWrap.className = 'message-images';
            for (const src of message.meta.images) {
                if (typeof src !== 'string' || !src.length) continue;
                const img = document.createElement('img');
                img.src = src;
                img.alt = 'Attachment';
                img.loading = 'lazy';
                imageWrap.appendChild(img);
            }
            div.appendChild(imageWrap);
        }

        if (message.role === 'user') {
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const undoBtn = document.createElement('button');
            undoBtn.className = 'undo-btn';
            undoBtn.type = 'button';
            undoBtn.title = 'Undo to this message';
            undoBtn.textContent = '⟲';
            undoBtn.addEventListener('click', () => {
                if (isBusy) return;
                const sessionId = activeSessionId;
                const session = getSessionState(sessionId);
                if (!session) return;
                const msg = session.messagesById.get(message.id);
                if (!msg) return;
                const anchorKey = message.id;
                const verdict = canUndo(session, anchorKey);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.request', 'anchorKey', anchorKey, 'isMsgId', anchorKey.startsWith('msg_'), 'undoAllowed', verdict.allowed]
                });
                if (!verdict.allowed || !verdict.msgId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['undo.blocked', 'anchorKey', anchorKey, 'reason', verdict.reason]
                    });
                    return;
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.send', 'anchorMsgId', verdict.msgId]
                });
                handleUndoToMessage(sessionId, verdict.msgId);
                window.__oc?.renderFromState?.();
                logSessionState(sessionId, 'UI_UNDO_TO_MESSAGE');
            });
            actions.appendChild(undoBtn);
            div.appendChild(actions);
        }

        chatContainer.appendChild(div);
    }

    function renderSegmentElement(session, segment, renderedSet) {
        const container = document.createElement('div');
        container.className = 'reverted-segment';
        if (segment.state === 'frozen') {
            container.classList.add('is-discarded');
        }

        const header = document.createElement('div');
        header.className = 'reverted-segment-header';

        const title = document.createElement('span');
        title.className = 'reverted-segment-title';
        title.textContent = `Reverted segment (${segment.memberIds.size} messages)`;

        const actions = document.createElement('div');
        actions.className = 'reverted-segment-actions';

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'reverted-segment-btn';
        restoreBtn.textContent = 'Restore all';
        restoreBtn.disabled = segment.state !== 'restorable';
        restoreBtn.addEventListener('click', () => {
            if (segment.state !== 'restorable') return;
            handleRestoreSegment(activeSessionId, segment.id);
            vscode.postMessage({ type: 'restoreAll', sessionId: activeSessionId });
            window.__oc?.renderFromState?.();
            logSessionState(activeSessionId, 'UI_RESTORE_SEGMENT');
        });
        actions.appendChild(restoreBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'reverted-segment-btn secondary';
        toggleBtn.textContent = segment.isExpanded ? 'Collapse' : 'Expand';
        toggleBtn.addEventListener('click', () => {
            handleToggleSegment(activeSessionId, segment.id);
            window.__oc?.renderFromState?.();
            logSessionState(activeSessionId, 'UI_TOGGLE_SEGMENT_EXPAND');
        });
        actions.appendChild(toggleBtn);

        header.appendChild(title);
        header.appendChild(actions);
        container.appendChild(header);

        if (segment.state === 'frozen') {
            const discarded = document.createElement('div');
            discarded.className = 'reverted-segment-discarded';
            discarded.textContent = 'Discarded. Cannot restore.';
            container.appendChild(discarded);
        } else {
            const hint = document.createElement('div');
            hint.className = 'reverted-segment-hint';
            hint.textContent = 'You are allowed to restore this segment until the next build prompt.';
            container.appendChild(hint);
        }

        if (segment.isExpanded) {
            const body = document.createElement('div');
            body.className = 'reverted-segment-body';
            for (const id of session.timeline) {
                if (!segment.memberIds.has(id)) continue;
                const msg = session.messagesById.get(id);
                if (!msg) continue;
                const entry = document.createElement('div');
                const isUser = msg.role === 'user';
                const isSystem = msg.role === 'system' || msg.role === 'tool';
                entry.className = `message ${isUser ? 'user' : isSystem ? 'system' : 'bot'} in-segment`;
                if (msg.meta?.isThinking === true) {
                    entry.classList.add('thinking');
                }
                if (renderedSet.has(msg.id)) {
                    console.warn('[Render] duplicate message skipped', msg.id);
                    continue;
                }
                renderedSet.add(msg.id);
                const content = document.createElement('div');
                content.className = 'message-content';
                if (msg.role === 'assistant') {
                    renderMarkdownInto(content, msg.text || '');
                } else {
                    content.textContent = msg.text || '';
                }
                entry.appendChild(content);
                body.appendChild(entry);
            }
            container.appendChild(body);
        }

        chatContainer.appendChild(container);
    }

    function renderPendingCount() {
        const pendingEl = document.getElementById('pending-indicator');
        if (!pendingEl) return;
        const session = getSessionState(activeSessionId);
        const count = session?.pendingSegments?.length || 0;
        if (count > 0) {
            pendingEl.textContent = `(${count} pending)`;
            pendingEl.classList.remove('hidden');
        } else {
            pendingEl.classList.add('hidden');
        }
    }

    function renderFromState() {
        renderPendingCount();
        if (!chatContainer) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['WV', 'renderFromState', 'skip', 'reason', 'chatContainer-null']
            });
            return;
        }
        chatContainer.innerHTML = '';
        const session = getSessionOrNull(activeSessionId);
        if (!session || !session.timeline.length) {
            setDefaultGreeting();
            return;
        }

        const timeline = Array.isArray(session.timeline) ? session.timeline : [];
        const segments = Array.isArray(session.segments) ? session.segments : [];
        const pendingSegments = Array.isArray(session.pendingSegments) ? session.pendingSegments : [];
        const baseHidden = session.hiddenSet instanceof Set
            ? session.hiddenSet
            : new Set(Array.isArray(session.hiddenSet) ? session.hiddenSet : []);
        const derivedHiddenSet = new Set(baseHidden);
        const timelineSet = new Set(timeline);
        const hideableStates = new Set(['active', 'pending', 'restorable']);
        const allSegments = [];
        const seenSegmentKeys = new Set();

        function pushSegment(segment) {
            if (!segment) return;
            const key = segment.noticeKey ?? segment.id ?? '';
            if (!key) {
                allSegments.push(segment);
                return;
            }
            if (seenSegmentKeys.has(key)) return;
            seenSegmentKeys.add(key);
            allSegments.push(segment);
        }

        for (const segment of segments) {
            pushSegment(segment);
        }
        for (const segment of pendingSegments) {
            pushSegment(segment);
        }

        for (const segment of allSegments) {
            const noticeKey = segment.noticeKey ?? segment.id ?? 'unknown';
            const raw = segment.memberIds ?? segment.memberKeys ?? segment.matchedKeys ?? [];
            const memberKeys = raw instanceof Set ? Array.from(raw) : (Array.isArray(raw) ? raw : []);
            const hideable = hideableStates.has(segment.state);
            let mappedMemberCount = 0;
            let addedCount = 0;

            if (hideable && memberKeys.length > 0) {
                for (const key of memberKeys) {
                    if (typeof key !== 'string' || !key.startsWith('msg_')) continue;
                    if (!timelineSet.has(key)) continue;
                    mappedMemberCount++;
                    if (!derivedHiddenSet.has(key)) {
                        derivedHiddenSet.add(key);
                        addedCount++;
                    }
                }
            } else if (memberKeys.length > 0) {
                for (const key of memberKeys) {
                    if (typeof key === 'string' && key.startsWith('msg_') && timelineSet.has(key)) {
                        mappedMemberCount++;
                    }
                }
            }

            const payload = ['render.hidden',
                'noticeKey', noticeKey,
                'state', segment.state,
                'memberKeysLen', memberKeys.length,
                'mappedMemberCount', mappedMemberCount,
                'hideable', hideable,
                'contributed', addedCount > 0
            ];
            if (!hideable) {
                payload.push('reasonSkipped', 'state-not-hideable');
            }

            vscode.postMessage({ type: 'ui-debug', payload });
        }

        vscode.postMessage({
            type: 'ui-debug',
            payload: ['renderFromState',
                'derivedHiddenSetSize', derivedHiddenSet.size,
                'baseHiddenSize', baseHidden.size,
                'segments', segments.length,
                'pending', pendingSegments.length,
                'computedSegmentsCountUsedForHiddenSet', allSegments.length,
                'timelineSize', timeline.length,
                'segmentsCount', allSegments.length]
        });

        const segmentsSorted = segments.slice().sort((a, b) => a.anchorOrder - b.anchorOrder);
        let segmentIndex = 0;
        const renderedSet = new Set();

        for (const id of timeline) {
            const msg = session.messagesById.get(id);
            if (!msg) continue;

            if (id.startsWith('system:undo:')) {
                continue;
            }

            while (segmentIndex < segmentsSorted.length && segmentsSorted[segmentIndex].anchorOrder <= msg.order) {
                renderSegmentElement(session, segmentsSorted[segmentIndex], renderedSet);
                segmentIndex++;
            }
            if (derivedHiddenSet.has(id)) continue;
            renderMessageElement(msg, renderedSet);
        }

        while (segmentIndex < segmentsSorted.length) {
            renderSegmentElement(session, segmentsSorted[segmentIndex], renderedSet);
            segmentIndex++;
        }

        if (lastConflictPayload) {
            renderConflictCard(lastConflictPayload);
        }

        const tables = chatContainer.querySelectorAll('table');
        const wraps = chatContainer.querySelectorAll('.md-table-wrap');
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'tableWrap', 'audit', 'tables', tables.length, 'wraps', wraps.length]
        });

        const roots = chatContainer.querySelectorAll('.message-content');
        let totalWrapped = 0;
        for (const root of roots) {
            totalWrapped += wrapTables(root);
        }
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'tableWrap', 'applied', 'roots', roots.length, 'wrapped', totalWrapped]
        });
    }

    window.__oc = window.__oc || {};
    window.__oc.renderFromState = renderFromState;

    function renderModelSelect() {
        const wrapper = modelSelect.parentElement;
        if (!wrapper) return;

        modelSelect.innerHTML = '';
        for (const model of models) {
            const option = document.createElement('option');
            option.value = model.fullId;
            const baseLabel = model.name || model.fullId;
            const providerLabel = model.providerId ? ` (${model.providerId})` : '';
            option.textContent = `${baseLabel}${providerLabel}`;
            if (model.fullId === selectedModel) {
                option.selected = true;
            }
            modelSelect.appendChild(option);
        }
        if (!selectedModel && models[0]) {
            selectedModel = models[0].fullId;
        }

        modelSelect.classList.add('is-hidden');
        const existing = wrapper.querySelector('.model-dropdown');
        if (existing) {
            existing.remove();
        }
        if (modelDropdownOutsideHandler) {
            document.removeEventListener('click', modelDropdownOutsideHandler);
            modelDropdownOutsideHandler = null;
        }

        const dropdown = document.createElement('div');
        dropdown.className = 'model-dropdown';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'select-button model-toggle';
        toggle.setAttribute('aria-haspopup', 'listbox');
        toggle.setAttribute('aria-expanded', 'false');

        const icon = document.createElement('span');
        icon.className = 'select-icon';
        icon.innerHTML = getChevronSvg();

        const label = document.createElement('span');
        label.className = 'select-label';

        toggle.appendChild(icon);
        toggle.appendChild(label);

        const panel = document.createElement('div');
        panel.className = 'dropdown-panel hidden';
        panel.setAttribute('role', 'listbox');

        const grouped = new Map();
        const providerOrder = [];
        for (const model of models) {
            const provider = model.providerId || 'other';
            if (!grouped.has(provider)) {
                grouped.set(provider, []);
                providerOrder.push(provider);
            }
            grouped.get(provider).push(model);
        }

        if (collapsedProviders.size === 0) {
            for (const provider of providerOrder) {
                collapsedProviders.add(provider);
            }
        }

        for (const provider of providerOrder) {
            const group = document.createElement('div');
            group.className = 'model-group';

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'model-group-header';
            header.textContent = provider;

            const list = document.createElement('div');
            list.className = 'model-group-list';
            if (collapsedProviders.has(provider)) {
                list.classList.add('is-collapsed');
                header.classList.add('is-collapsed');
            }

            header.addEventListener('click', () => {
                if (collapsedProviders.has(provider)) {
                    collapsedProviders.delete(provider);
                } else {
                    collapsedProviders.add(provider);
                }
                list.classList.toggle('is-collapsed');
                header.classList.toggle('is-collapsed');
            });

            for (const model of grouped.get(provider)) {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'model-option';
                option.textContent = model.name || model.fullId;
                option.dataset.value = model.fullId;
                if (model.fullId === selectedModel) {
                    option.classList.add('is-selected');
                }
                option.addEventListener('click', () => {
                    selectedModel = model.fullId;
                    updateVariantOptions();
                    vscode.postMessage({ type: 'setModel', value: selectedModel });
                    updateLabel();
                    closeDropdown();
                });
                list.appendChild(option);
            }

            group.appendChild(header);
            group.appendChild(list);
            panel.appendChild(group);
        }

        dropdown.appendChild(toggle);
        dropdown.appendChild(panel);
        wrapper.appendChild(dropdown);

        function updateLabel() {
            const selected = models.find((item) => item.fullId === selectedModel);
            label.textContent = selected ? (selected.name || selected.fullId) : 'Select model';
            for (const option of panel.querySelectorAll('.model-option')) {
                option.classList.toggle('is-selected', option.dataset.value === selectedModel);
            }
        }

        function openDropdown() {
            panel.classList.remove('hidden');
            toggle.setAttribute('aria-expanded', 'true');
            dropdown.classList.add('is-open');
        }

        function closeDropdown() {
            panel.classList.add('hidden');
            toggle.setAttribute('aria-expanded', 'false');
            dropdown.classList.remove('is-open');
        }

        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (panel.classList.contains('hidden')) {
                openDropdown();
            } else {
                closeDropdown();
            }
        });

        modelDropdownOutsideHandler = (event) => {
            if (!dropdown.contains(event.target)) {
                closeDropdown();
            }
        };
        document.addEventListener('click', modelDropdownOutsideHandler);

        updateLabel();
    }

    function renderModeSelect() {
        renderSimpleSelect(modeSelect, {
            getValue: () => selectedMode,
            onSelect: (value) => {
                selectedMode = value;
                modeSelect.value = value;
                applyModeStyles(selectedMode);
                vscode.postMessage({ type: 'setMode', value: selectedMode });
            }
        });
    }

    function renderVariantSelect() {
        renderSimpleSelect(variantSelect, {
            getValue: () => selectedVariant,
            onSelect: (value) => {
                selectedVariant = value;
                variantSelect.value = value;
                vscode.postMessage({ type: 'setVariant', value: selectedVariant });
            }
        });
    }

    function renderSimpleSelect(selectEl, { getValue, onSelect }) {
        const wrapper = selectEl.parentElement;
        if (!wrapper) return;

        selectEl.classList.add('is-hidden');
        const existing = wrapper.querySelector('.simple-dropdown');
        if (existing) {
            existing.remove();
        }
        const prevHandler = simpleDropdownHandlers.get(wrapper);
        if (prevHandler) {
            document.removeEventListener('click', prevHandler);
            simpleDropdownHandlers.delete(wrapper);
        }

        const dropdown = document.createElement('div');
        dropdown.className = 'simple-dropdown';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'select-button';
        toggle.setAttribute('aria-haspopup', 'listbox');
        toggle.setAttribute('aria-expanded', 'false');

        const icon = document.createElement('span');
        icon.className = 'select-icon';
        icon.innerHTML = getChevronSvg();

        const label = document.createElement('span');
        label.className = 'select-label';

        toggle.appendChild(icon);
        toggle.appendChild(label);

        const panel = document.createElement('div');
        panel.className = 'dropdown-panel hidden';
        panel.setAttribute('role', 'listbox');

        const options = Array.from(selectEl.options || []);
        for (const optionEl of options) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'model-option';
            option.textContent = optionEl.textContent || optionEl.value;
            option.dataset.value = optionEl.value;
            if (optionEl.value === getValue()) {
                option.classList.add('is-selected');
            }
            option.addEventListener('click', () => {
                onSelect(optionEl.value);
                updateLabel();
                closeDropdown();
            });
            panel.appendChild(option);
        }

        dropdown.appendChild(toggle);
        dropdown.appendChild(panel);
        wrapper.appendChild(dropdown);

        function updateLabel() {
            const active = options.find((item) => item.value === getValue());
            label.textContent = active ? (active.textContent || active.value) : '';
            for (const option of panel.querySelectorAll('.model-option')) {
                option.classList.toggle('is-selected', option.dataset.value === getValue());
            }
        }

        function openDropdown() {
            panel.classList.remove('hidden');
            toggle.setAttribute('aria-expanded', 'true');
            dropdown.classList.add('is-open');
        }

        function closeDropdown() {
            panel.classList.add('hidden');
            toggle.setAttribute('aria-expanded', 'false');
            dropdown.classList.remove('is-open');
        }

        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (panel.classList.contains('hidden')) {
                openDropdown();
            } else {
                closeDropdown();
            }
        });

        const outsideHandler = (event) => {
            if (!dropdown.contains(event.target)) {
                closeDropdown();
            }
        };
        document.addEventListener('click', outsideHandler);
        simpleDropdownHandlers.set(wrapper, outsideHandler);

        updateLabel();
    }

    function getChevronSvg() {
        return `
            <svg width="10" height="10" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                <path d="M3.2 5.6L8 10.4l4.8-4.8.9.9-5.7 5.7-5.7-5.7.9-.9z"/>
            </svg>
        `;
    }

    function updateVariantOptions() {
        variantSelect.innerHTML = '';
        const selected = models.find((item) => item.fullId === selectedModel);
        const variants = selected?.variants || [];
        if (!variants.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'default';
            option.selected = true;
            variantSelect.appendChild(option);
            variantSelect.disabled = true;
            selectedVariant = '';
            vscode.postMessage({ type: 'setVariant', value: selectedVariant });
            renderVariantSelect();
            return;
        }

        variantSelect.disabled = false;
        const emptyOption = document.createElement('option');
        emptyOption.value = '';
        emptyOption.textContent = '';
        if (!selectedVariant) {
            emptyOption.selected = true;
        }
        variantSelect.appendChild(emptyOption);

        for (const variant of variants) {
            const option = document.createElement('option');
            option.value = variant;
            option.textContent = `${variant}`;
            if (variant === selectedVariant) {
                option.selected = true;
            }
            variantSelect.appendChild(option);
        }

        if (!variants.includes(selectedVariant)) {
            selectedVariant = '';
            variantSelect.value = selectedVariant;
            vscode.postMessage({ type: 'setVariant', value: selectedVariant });
        }
        renderVariantSelect();
    }

    function applyModeStyles(mode) {
        const container = document.querySelector('.input-container');
        if (!container) return;
        container.classList.remove('mode-plan', 'mode-build');
        if (mode === 'plan') {
            container.classList.add('mode-plan');
        } else {
            container.classList.add('mode-build');
        }
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });
    }

    function renderSessionList() {
        sessionList.innerHTML = '';
        if (!sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'session-empty';
            empty.textContent = 'No sessions found.';
            sessionList.appendChild(empty);
            return;
        }
        for (const item of sessions) {
            const button = document.createElement('button');
            button.className = 'session-item';
            button.type = 'button';

            const title = document.createElement('span');
            title.className = 'session-item-title';
            title.textContent = item.title || item.id;

            const meta = document.createElement('span');
            meta.className = 'session-item-meta';
            meta.textContent = item.updated || '';

            button.appendChild(title);
            button.appendChild(meta);
            button.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectSession', sessionId: item.id });
            });
            sessionList.appendChild(button);
        }
    }

    function renderAttachments() {
        attachmentList.innerHTML = '';
        for (const item of attachments) {
            const entry = document.createElement('div');
            entry.className = 'attachment-item';
            entry.textContent = item.name || 'Attachment';
            attachmentList.appendChild(entry);
        }
    }

    function openSessionPanel() {
        sessionPanel.classList.add('open');
        panelBackdrop.classList.add('open');
        sessionPanel.classList.remove('hidden');
        panelBackdrop.classList.remove('hidden');
        pendingRefreshRequestId = `refresh-${Date.now()}`;
        vscode.postMessage({ type: 'refreshSessions', requestId: pendingRefreshRequestId });
    }

    function closeSessionPanel() {
        sessionPanel.classList.remove('open');
        panelBackdrop.classList.remove('open');
        sessionPanel.classList.add('hidden');
        panelBackdrop.classList.add('hidden');
    }

    function handlePaste(e) {
        const items = e.clipboardData?.items || [];
        for (const item of items) {
            if (item.type && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file) continue;
                const reader = new FileReader();
                reader.onload = () => {
                    vscode.postMessage({
                        type: 'clipboardImage',
                        dataUrl: reader.result,
                        mime: file.type
                    });
                };
                reader.readAsDataURL(file);
            }
        }
    }

    function applyPromptToSession(sessionId, payload) {
        const session = getSessionState(sessionId, true);
        const displayText = payload.text || 'Image attached.';
        const userMessage = upsertMessage(session, {
            id: payload.clientMessageId,
            role: 'user',
            text: displayText,
            meta: { clientId: payload.clientMessageId, images: payload.images || [] }
        });

        if (payload.mode === 'build') {
            freezeSegments(session);
        }

        if (!session.thinkingId) {
            const tempId = createTempAssistantId();
            const thinkingMsg = upsertMessage(session, {
                id: tempId,
                role: 'assistant',
                text: 'Thinking...',
                meta: { isThinking: true, parentClientMessageId: payload.clientMessageId }
            });
            session.thinkingId = thinkingMsg.id;
        }

        assertInvariants(sessionId, 'sendPrompt');
    }

    function handleAssistantMeta(sessionId, message) {
        const session = getSessionState(sessionId, true);
        const backendId = getEventMessageId(message);
        const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;
        if (!msgId && !session.thinkingId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'drop-no-backendId-no-thinking'] });
            return;
        }

        if (message?.clientMessageId && backendId) {
            registerMessageIdMapping(session, message.clientMessageId, backendId, 'assistantMessageMeta');
        }

        let targetId = session.thinkingId;

        attemptAssistantUpgrade(sessionId, message, 'assistantMessageMeta');
        targetId = session.thinkingId || targetId;

        if (!targetId && msgId && session.messagesById.has(msgId)) {
            targetId = msgId;
        }

        if (!targetId && msgId) {
            const thinking = upsertMessage(session, {
                id: msgId,
                role: message.role || 'assistant',
                text: message.lastText || 'Thinking...',
                meta: { isThinking: true, internalId: backendId }
            });
            session.thinkingId = thinking.id;
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'new-thinking', msgId] });
            assertInvariants(sessionId, 'assistantMeta-create');
            return;
        }

        if (!targetId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'drop-no-target'] });
            return;
        }

        const target = session.messagesById.get(targetId);
        if (target) {
            const nextText = typeof message.lastText === 'string' ? message.lastText : target.text;
            target.text = nextText;
            target.meta = { ...target.meta, internalId: backendId, isThinking: true };
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'merged', targetId] });
        }

        assertInvariants(sessionId, 'assistantMeta');
    }

    function handleChatChunk(sessionId, message) {
        const session = getSessionState(sessionId, true);
        const backendId = getEventMessageId(message);
        const chunkText = getEventChunkText(message);

        const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;

        let targetId = session.thinkingId;

        attemptAssistantUpgrade(sessionId, message, 'chatChunk');
        targetId = session.thinkingId || targetId;

        if (!targetId && msgId && session.messagesById.has(msgId)) {
            targetId = msgId;
        }

        if (!targetId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'drop-no-target'] });
            return;
        }

        const target = session.messagesById.get(targetId);
        if (target) {
            if (target.meta?.isThinking === true && target.text === 'Thinking...') {
                target.text = chunkText;
            } else {
                target.text = (target.text || '') + chunkText;
            }
            target.meta = { ...target.meta, isThinking: true };
            vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'appended', targetId] });
        }

        assertInvariants(sessionId, 'chatChunk');
    }

    function handleChatDone(sessionId) {
        const session = getSessionState(sessionId);
        if (!session) return;
        if (session.thinkingId && session.messagesById.has(session.thinkingId)) {
            const msg = session.messagesById.get(session.thinkingId);
            msg.meta.isThinking = false;
            if (msg.text === 'Thinking...') {
                msg.text = '';
            }
            session.thinkingId = null;
            console.log('[Thinking] chatDone cleared pending');
        }
        assertInvariants(sessionId, 'chatDone');
    }

    sendBtn.addEventListener('click', () => {
        if (isBusy) {
            vscode.postMessage({ type: 'cancel' });
            return;
        }
        const text = input.value.trim();
        if ((!text && !attachments.length) || isBusy) return;

        const messageText = text || 'Image attached.';
        const clientMessageId = `local-${Date.now()}-${messageCounter++}`;
        const messageImages = attachments
            .map((item) => item.dataUrl)
            .filter((value) => typeof value === 'string' && value.length > 0);

        setBusy(true);
        if (!activeSessionId) {
            isSwitchingSession = true;
            pendingUiPrompts.push({
                text: messageText,
                clientMessageId,
                mode: selectedMode,
                images: messageImages
            });
        } else {
            applyPromptToSession(activeSessionId, {
                text: messageText,
                clientMessageId,
                mode: selectedMode,
                images: messageImages
            });
            const session = getSessionState(activeSessionId);
            const tmpKey = session?.thinkingId || null;
            vscode.postMessage({ type: 'registerTmpKey', sessionId: activeSessionId, tmpKey });
            window.__oc?.renderFromState?.();
            scrollToBottom();
            logSessionState(activeSessionId, 'UI_SEND_PROMPT');
        }

        const attachmentPaths = attachments.map((item) => item.filePath);
        const tmpKey = activeSessionId ? getSessionState(activeSessionId)?.thinkingId || null : null;
        vscode.postMessage({ type: 'sendMessage', value: messageText, attachments: attachmentPaths, clientMessageId, sessionId: activeSessionId || undefined, tmpKey });
        attachments = [];
        renderAttachments();
        input.value = '';
    });

    input.addEventListener('paste', handlePaste);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && document.activeElement === input) {
            e.preventDefault();
            const nextMode = modeSelect.value === 'plan' ? 'build' : 'plan';
            modeSelect.value = nextMode;
            selectedMode = nextMode;
            applyModeStyles(selectedMode);
            renderModeSelect();
            vscode.postMessage({ type: 'setMode', value: selectedMode });
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendBtn.click();
        }
    });

    modelSelect.addEventListener('change', (e) => {
        selectedModel = e.target.value;
        updateVariantOptions();
        vscode.postMessage({ type: 'setModel', value: selectedModel });
    });

    modeSelect.addEventListener('change', (e) => {
        selectedMode = e.target.value;
        applyModeStyles(selectedMode);
        vscode.postMessage({ type: 'setMode', value: selectedMode });
    });

    variantSelect.addEventListener('change', (e) => {
        selectedVariant = e.target.value;
        vscode.postMessage({ type: 'setVariant', value: selectedVariant });
    });

    historyBtn.addEventListener('click', () => {
        openSessionPanel();
    });

    const pendingIndicator = document.getElementById('pending-indicator');
    if (pendingIndicator) {
        pendingIndicator.addEventListener('click', () => {
            vscode.postMessage({ type: 'retryReconcile', sessionId: activeSessionId });
        });
    }

    newSessionBtn.addEventListener('click', () => {
        activeSessionId = '';
        sessionTitle.textContent = 'OpenCode: Chat';
        attachments = [];
        renderAttachments();
        isSwitchingSession = true;
        vscode.postMessage({ type: 'newSession' });
        window.__oc?.renderFromState?.();
        scrollToBottom();
    });

    refreshSessionsBtn.addEventListener('click', () => {
        pendingRefreshRequestId = `refresh-${Date.now()}`;
        const requestId = pendingRefreshRequestId;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'refresh', 'before-send', 'requestId', requestId]
        });
        try {
            vscode.postMessage({ type: 'refreshSessions', requestId });
        } catch (error) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['WV', 'refresh', 'send-error', error?.message || String(error)]
            });
        }
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'refresh', 'after-send', 'requestId', requestId]
        });
        const pingTs = Date.now();
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'ping-send', 'ts', pingTs]
        });
        vscode.postMessage({ type: 'ping', ts: pingTs });
    });

    closeSessionsBtn.addEventListener('click', closeSessionPanel);
    panelBackdrop.addEventListener('click', closeSessionPanel);

window.addEventListener('message', (event) => {
        const message = event.data || {};
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'recv', 'type', message.type || 'null', 'sessionId', message.sessionId || message.sessionID || 'null', 'hasMessages', Array.isArray(message.messages), 'messagesLen', message.messages?.length ?? -1, 'hasSegments', Array.isArray(message.persistedSegments), 'segmentsLen', message.persistedSegments?.length ?? -1]
        });

        switch (message.type) {
            case 'init': {
                models = Array.isArray(message.models) ? message.models : [];
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                selectedModel = message.selectedModel || (models[0] ? models[0].fullId : '');
                selectedVariant = message.selectedVariant || '';
                selectedMode = message.selectedMode || 'build';
                activeSessionId = message.currentSessionId || activeSessionId || '';
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                renderModelSelect();
                renderModeSelect();
                updateVariantOptions();
                renderSessionList();
                window.__oc?.renderFromState?.();
                vscode.postMessage({ type: 'ui-debug', payload: ['webview', 'ready', Date.now()] });
                break;
            }
            case 'models': {
                models = Array.isArray(message.models) ? message.models : [];
                renderModelSelect();
                updateVariantOptions();
                break;
            }
            case 'sessionsList': {
                const recvRequestId = message.requestId ?? null;
                const topSession = message.sessions?.[0];
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'sessionsList', 'recv', 'requestId', recvRequestId, 'expected', pendingRefreshRequestId, 'count', message.sessions?.length || 0, 'top', topSession?.id || 'none']
                });

                const effectiveRequestId = recvRequestId ?? pendingRefreshRequestId;

                if (pendingRefreshRequestId && effectiveRequestId !== pendingRefreshRequestId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionsList', 'stale-drop', 'requestId', effectiveRequestId, 'expected', pendingRefreshRequestId]
                    });
                    break;
                }

                pendingRefreshRequestId = null;
                sessions = Array.isArray(message.sessions) ? message.sessions : [];

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'sessionsList', 'applied', 'requestId', effectiveRequestId, 'count', sessions.length, 'top', topSession?.id || 'none']
                });

                renderSessionList();
                break;
            }
            case 'pong': {
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'pong', 'ts', message.ts]
                });
                break;
            }
            case 'webviewReadyAck': {
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['webview', 'recv-extension-ack', 'serverTimestamp', message.timestamp, 'localTimestamp', Date.now()]
                });
                break;
            }
            case 'sessionData': {
                const sessionId = getEventSessionId(message, 'sessionData');
                if (!sessionId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'drop', 'reason', 'missing-sessionId']
                    });
                    break;
                }

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'sessionData', 'enter', 'sessionId', sessionId, 'messagesLen', message.messages?.length ?? 0, 'segmentsLen', message.persistedSegments?.length ?? 0]
                });

                try {
                    const existingSession = getSessionState(sessionId);
                    const existingSegmentCount = existingSession?.segments?.length || 0;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['sessionData', 'existingSegmentsBeforeClear', existingSegmentCount]
                    });

                    activeSessionId = sessionId;
                    sessionTitle.textContent = message.title || 'OpenCode: Chat';
                    const session = getSessionState(sessionId, true);
                    const incomingSegmentsLen = Array.isArray(message.persistedSegments) ? message.persistedSegments.length : 0;

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'stores-before-clear',
                            'incomingSegmentsLen', incomingSegmentsLen,
                            'segments', session.segments.length,
                            'pending', session.pendingSegments.length,
                            'timeline', session.timeline.length]
                    });

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['sessionData', 'clearing', 'messages', session.timeline.length, 'segments', session.segments.length]
                    });

                    session.messagesById.clear();
                    session.timeline = [];
                    session.segments = [];
                    session.thinkingId = null;
                    session.nextOrder = 0;

                    const sessionMessages = Array.isArray(message.messages) ? message.messages : [];
                    for (const item of sessionMessages) {
                        if (!item || !item.id) continue;

                        const key = item.id;
                        if (typeof key !== 'string') continue;
                        if (!(key.startsWith('msg_') || key.startsWith('system:') || key.startsWith('diff:'))) {
                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['sessionData', 'WARNING-unknown-id', 'id', key]
                            });
                        }

                        let role = item.role;
                        if (!role) {
                            if (item.id.startsWith('msg_')) {
                                role = 'assistant';
                            } else if (item.id.startsWith('system:')) {
                                role = 'system';
                            } else {
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['sessionData', 'WARNING-missing-role', 'id', item.id]
                                });
                                continue;
                            }
                        }

                        upsertMessage(session, {
                            id: key,
                            role: role,
                            text: item.text || '',
                            meta: { clientId: key, isThinking: false },
                            order: session.nextOrder++
                        });
                    }

                    const timelineSetForHydrate = new Set(session.timeline);

                    if (message.revertedSegment) {
                        applyRevertedSegmentPayload(sessionId, message.revertedSegment);
                    }

                    // Clear old state
                    session.segments = [];
                    session.hiddenSet = new Set();
                    session.pendingSegments = [];
                    session.persistedSegments = new Map();
                    if (session.serverIdToKey?.clear) session.serverIdToKey.clear();
                    if (session.clientKeyToServerId?.clear) session.clientKeyToServerId.clear();
                    if (session.serverIdToClientKey?.clear) session.serverIdToClientKey.clear();

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'load-persisted', 'sessionId', sessionId, 'count', message.persistedSegments?.length ?? 0]
                    });

                    // Store persisted segments and init pending list
                    if (Array.isArray(message.persistedSegments) && message.persistedSegments.length > 0) {
                        for (const seg of message.persistedSegments) {
                            session.persistedSegments.set(seg.noticeKey, seg);

                            if (seg.state === 'active' && seg.resolved?.memberKeys) {
                                const resolvedKeys = seg.resolved.memberKeys.filter((k) => typeof k === 'string' && k.startsWith('msg_'));
                                if (!resolvedKeys.length) {
                                    vscode.postMessage({
                                        type: 'ui-debug',
                                        payload: ['WV', 'sessionData', 'restore-skip', 'noticeKey', seg.noticeKey, 'reason', 'empty-msg-members']
                                    });
                                    continue;
                                }
                                session.segments.push({
                                    id: `seg:${seg.noticeKey}`,
                                    anchorOrder: seg.resolved?.anchorOrder ?? session.nextOrder,
                                    memberIds: new Set(resolvedKeys),
                                    state: 'restorable',
                                    isExpanded: false
                                });
                                for (const key of resolvedKeys) {
                                    session.hiddenSet.add(key);
                                }
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['WV', 'sessionData', 'restore-active', 'noticeKey', seg.noticeKey, 'members', resolvedKeys.length]
                                });
                                const missing = resolvedKeys.filter((k) => !timelineSetForHydrate.has(k));
                                const matchedCount = resolvedKeys.length - missing.length;
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[DBG_SEG_HYDRATE]', `segment notice=${seg.noticeKey} memberKeys=${formatList(resolvedKeys)}`]
                                });
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[DBG_SEG_HYDRATE]', `matched=${matchedCount} missing=${formatList(missing)} method=timeline-only`]
                                });
                            } else {
                                const hydratedMemberKeys = (Array.isArray(seg.memberKeys)
                                    ? seg.memberKeys
                                    : (seg.members?.serverIds || [])).filter((k) => typeof k === 'string' && k.startsWith('msg_'));
                                if (!hydratedMemberKeys.length) {
                                    vscode.postMessage({
                                        type: 'ui-debug',
                                        payload: ['WV', 'sessionData', 'restore-pending-skip', 'noticeKey', seg.noticeKey, 'reason', 'empty-msg-members']
                                    });
                                    continue;
                                }
                                session.pendingSegments.push({
                                    noticeKey: seg.noticeKey,
                                    membersStable: hydratedMemberKeys,
                                    memberKeys: hydratedMemberKeys,
                                    state: seg.state || 'pending',
                                    matchedKeys: [],
                                    unmatched: hydratedMemberKeys,
                                    isStale: false,
                                    createdAt: seg.createdAt || Date.now()
                                });
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['WV', 'sessionData', 'restore-pending', 'noticeKey', seg.noticeKey, 'members', seg.members?.serverIds?.length ?? 0]
                                });
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['WV', 'sessionData', 'hydrate-memberKeys',
                                        'noticeKey', seg.noticeKey,
                                        'hydratedMemberKeysCount', hydratedMemberKeys.length,
                                        'hydratedMemberKeysSample', hydratedMemberKeys.slice(0, 3).join(',')]
                                });
                                const missing = hydratedMemberKeys.filter((k) => !timelineSetForHydrate.has(k));
                                const matchedCount = hydratedMemberKeys.length - missing.length;
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[DBG_SEG_HYDRATE]', `segment notice=${seg.noticeKey} memberKeys=${formatList(hydratedMemberKeys)}`]
                                });
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[DBG_SEG_HYDRATE]', `matched=${matchedCount} missing=${formatList(missing)} method=timeline-only`]
                                });
                            }
                        }
                    }

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'stores-after-apply',
                            'incomingSegmentsLen', incomingSegmentsLen,
                            'segments', session.segments.length,
                            'pending', session.pendingSegments.length,
                            'timeline', session.timeline.length]
                    });

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'reconcile-start', 'sessionId', sessionId, 'active', session.segments.length, 'pending', session.pendingSegments.length]
                    });

                    reconcilePendingSegments(sessionId);

                    assertInvariants(sessionId, 'sessionData');
                    scrollToBottom();
                    closeSessionPanel();

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'applied', 'sessionId', sessionId, 'timeline', session.timeline.length, 'segments', session.segments.length, 'pending', session.pendingSegments.length, 'hiddenSet', session.hiddenSet.size]
                    });

                    const timelineSet = new Set(session.timeline);
                    const hiddenSetSize = session.hiddenSet instanceof Set ? session.hiddenSet.size : 0;
                    const timelineDump = ['WV', 'sessionData', 'timeline-dump',
                        'sessionId', sessionId,
                        'timelineSize', session.timeline.length,
                        'segmentCount', session.segments.length,
                        'pendingCount', session.pendingSegments.length,
                        'hiddenSetSize', hiddenSetSize];
                    const maxTimelineDump = Math.min(5, session.timeline.length);
                    for (let i = 0; i < maxTimelineDump; i++) {
                        const id = session.timeline[i];
                        const msg = session.messagesById.get(id);
                        const role = msg?.role || msg?.kind || msg?.type || 'unknown';
                        const rawText = typeof msg?.text === 'string'
                            ? msg.text
                            : (typeof msg?.content === 'string' ? msg.content : '');
                        const snippet = rawText ? rawText.slice(0, 40) : '(no text)';
                        timelineDump.push(`id${i}`, id, `role${i}`, role, `snippet${i}`, snippet);
                    }
                    vscode.postMessage({ type: 'ui-debug', payload: timelineDump });

                    const maxSegmentsDump = Math.min(3, session.segments.length);
                    for (let i = 0; i < maxSegmentsDump; i++) {
                        const seg = session.segments[i];
                        const raw = seg.memberKeys ?? seg.memberIds ?? seg.matchedKeys ?? [];
                        const memberKeys = raw instanceof Set ? Array.from(raw) : (Array.isArray(raw) ? raw : []);
                        const matched = memberKeys.filter(k => timelineSet.has(k));
                        const isActiveForHide = (seg.state === 'active' || seg.state === 'pending' || seg.state === 'restorable')
                            && matched.length > 0;
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['WV', 'sessionData', 'segment-dump',
                                'noticeKey', seg.noticeKey ?? seg.id ?? 'unknown',
                                'state', seg.state,
                                'memberKeysCount', memberKeys.length,
                                'memberKeysSample', memberKeys.slice(0, 3).join(','),
                                'matchedInTimelineCount', matched.length,
                                'matchedSample', matched.slice(0, 3).join(','),
                                'isActiveForHide', isActiveForHide]
                        });
                    }
                    const timelineMsgCount = session.timeline.filter((id) => typeof id === 'string' && id.startsWith('msg_')).length;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['sessionData', 'loaded', 'timelineMsgCount', timelineMsgCount, 'segmentsCount', session.segments.length]
                    });
                } catch (err) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionData', 'error', 'sessionId', sessionId, 'err', String(err), 'phase', 'outer']
                    });
                } finally {
                    window.__oc?.renderFromState?.();
                }
                break;
            }
            case 'sessionId': {
                const sessionId = getEventSessionId(message, 'sessionId');
                if (!sessionId) break;
                activeSessionId = sessionId;
                if (isSwitchingSession) {
                    isSwitchingSession = false;
                    while (pendingUiPrompts.length) {
                        const prompt = pendingUiPrompts.shift();
                        applyPromptToSession(sessionId, prompt);
                        const session = getSessionState(sessionId);
                        const tmpKey = session?.thinkingId || null;
                        vscode.postMessage({ type: 'registerTmpKey', sessionId, tmpKey });
                    }
                    window.__oc?.renderFromState?.();
                    logSessionState(sessionId, 'flushPendingPrompts');
                }
                break;
            }
            case 'messageIdMap': {
                const sessionId = getEventSessionId(message, 'messageIdMap');
                if (!sessionId) break;
                const session = getSessionState(sessionId);
                if (!session) break;
                const payloadInternalKey = message.clientMessageId;
                const payloadServerId = message.messageId;
                const lastTimelineKey = session.timeline[session.timeline.length - 1] || '';

                if (payloadInternalKey && payloadServerId) {
                    const existingServerForLocal = session.clientKeyToServerId.get(payloadInternalKey);
                    const existingLocalForServer = session.serverIdToClientKey.get(payloadServerId);
                    const conflictLocal = Boolean(existingServerForLocal && existingServerForLocal !== payloadServerId);
                    const conflictServer = Boolean(existingLocalForServer && existingLocalForServer !== payloadInternalKey);
                    let didRegister = false;

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'messageIdMap', 'mapping-attempt',
                            'source', 'messageIdMap',
                            'payloadInternalKey', payloadInternalKey,
                            'payloadServerId', payloadServerId,
                            'canonicalStable', payloadServerId,
                            'lastTimelineKey', lastTimelineKey,
                            'conflictLocal', conflictLocal,
                            'conflictServer', conflictServer]
                    });

                    if (conflictLocal || conflictServer) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['WV', 'messageIdMap', 'mapping-conflict-warning',
                                'payloadInternalKey', payloadInternalKey,
                                'payloadServerId', payloadServerId,
                            'existingServerForLocal', existingServerForLocal || 'none',
                            'existingLocalForServer', existingLocalForServer || 'none']
                        });
                    } else {
                        session.serverIdToKey.set(payloadServerId, payloadServerId);
                        registerMessageIdMapping(session, payloadInternalKey, payloadServerId, 'messageIdMap');
                        didRegister = true;
                    }
                    if (didRegister) {
                        const beforeTimeline = session.timeline.slice();
                        replaceKeyEverywhere(sessionId, payloadInternalKey, payloadServerId);
                        const replaced = beforeTimeline.includes(payloadInternalKey);
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['WV', 'messageIdMap', 'registered', 'serverId', payloadServerId, 'internalKey', payloadInternalKey]
                        });
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['messageIdMap.upgrade', 'localKey', payloadInternalKey, 'msgId', payloadServerId, 'replaced', replaced]
                        });
                    }
                }
                const entries = Array.from(session.clientKeyToServerId.entries());
                const sample = entries.slice(0, 5).map(([localKey, msgId]) => `${localKey}->${msgId}`);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[DBG_RECONCILE]', `messageIdMap size=${entries.length} sample=[${sample.join(', ')}]`]
                });
                if (session.pendingSegments && session.pendingSegments.length > 0) {
                    reconcilePendingSegments(sessionId);
                }
                break;
            }
            case 'messageIndexMap': {
                const sessionId = getEventSessionId(message, 'messageIndexMap');
                if (!sessionId) break;
                const session = getSessionState(sessionId);
                const map = Array.isArray(message.map) ? message.map : [];
                const sample = map.slice(0, 5).map((entry) => `${entry.messageId}:${entry.messageIndex}`);
                let hasUser = false;
                let hasAssistant = false;
                if (session) {
                    for (const entry of map) {
                        const msg = session.messagesById.get(entry.messageId);
                        if (msg?.role === 'user') hasUser = true;
                        if (msg?.role === 'assistant') hasAssistant = true;
                    }
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[DBG_RECONCILE]', `messageIndexMap size=${map.length} first=[${sample.join(', ')}] hasUser=${hasUser} hasAssistant=${hasAssistant}`]
                });
                break;
            }
            case 'retryReconcile': {
                const sessionId = getEventSessionId(message, 'retryReconcile');
                if (!sessionId) break;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'retryReconcile', 'sessionId', sessionId]
                });
                reconcilePendingSegments(sessionId);
                break;
            }
            case 'assistantMessageMeta': {
                const sessionId = getEventSessionId(message, 'assistantMessageMeta');
                if (!sessionId) break;
                logIdCandidates('[DBG_META]', message, sessionId, activeSessionId);
                handleAssistantMeta(sessionId, message);
                if (session.pendingSegments && session.pendingSegments.length > 0) {
                    reconcilePendingSegments(sessionId);
                }
                window.__oc?.renderFromState?.();
                scrollToBottom();
                logSessionState(sessionId, 'assistantMessageMeta');
                break;
            }
            case 'chatChunk': {
                const sessionId = getEventSessionId(message, 'chatChunk');
                if (!sessionId) break;
                handleChatChunk(sessionId, message);
                window.__oc?.renderFromState?.();
                scrollToBottom();
                logSessionState(sessionId, 'chatChunk');
                break;
            }
            case 'chatDone': {
                const sessionId = getEventSessionId(message, 'chatDone');
                if (!sessionId) break;
                logIdCandidates('[DBG_CHATDONE]', message, sessionId, activeSessionId);
                const session = getSessionState(sessionId);
                if (session) {
                    const tail = formatTail(session.timeline);
                    vscode.postMessage({ type: 'ui-debug', payload: ['[DBG_CHATDONE]', `timelineTail=${tail}`] });
                }
                handleChatDone(sessionId);
                window.__oc?.renderFromState?.();
                scrollToBottom();
                setBusy(false);
                logSessionState(sessionId, 'chatDone');
                break;
            }
            case 'addResponse': {
                const sessionId = getEventSessionId(message, 'addResponse');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);

                if (message.value) {
                    const status = isUndoRestoreStatusText(message.value);
                    if (status) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['addResponse', 'drop-status-text', 'kind', status.kind, 'text', message.value.slice(0, 60)]
                        });

                        if (status.kind === 'restore') {
                            const noticeKey = session.lastUndoNoticeKey;
                            if (noticeKey) {
                                const notice = session.messagesById.get(noticeKey);
                                if (notice) {
                                    notice.text = status.textNormalized;
                                    vscode.postMessage({
                                        type: 'ui-debug',
                                        payload: ['addResponse', 'restored-notice', 'noticeKey', noticeKey]
                                    });
                                }
                            }
                        }
                    } else {
                        const meta = message.meta || {};
                        upsertMessage(session, {
                            id: `system:${Date.now()}`,
                            role: 'system',
                            text: message.value,
                            meta: meta
                        });
                    }
                }
                handleChatDone(sessionId);
                window.__oc?.renderFromState?.();
                scrollToBottom();
                setBusy(false);
                logSessionState(sessionId, 'addResponse');
                break;
            }
            case 'attachmentAdded': {
                attachments.push({
                    id: message.id,
                    name: message.name,
                    filePath: message.filePath,
                    dataUrl: message.dataUrl,
                    mime: message.mime
                });
                renderAttachments();
                break;
            }
            case 'attachmentError': {
                const sessionId = getEventSessionId(message, 'attachmentError');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: message.value || 'Failed to attach image.',
                    meta: {}
                });
                window.__oc?.renderFromState?.();
                break;
            }
            case 'permissionPrompt': {
                const sessionId = getEventSessionId(message, 'permissionPrompt');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: `Permission required. Check OpenCode output: ${message.value}`,
                    meta: {}
                });
                window.__oc?.renderFromState?.();
                break;
            }
            case 'diffChunk': {
                const sessionId = getEventSessionId(message, 'diffChunk');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `diff:${Date.now()}`,
                    role: 'system',
                    text: message.value || '',
                    meta: { isDiff: true, diffText: message.value || '' }
                });
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'messageAppend': {
                const sessionId = getEventSessionId(message, 'messageAppend');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                if (message.message && message.message.id) {
                    upsertMessage(session, {
                        id: message.message.id,
                        role: message.message.role || 'assistant',
                        text: message.message.text || '',
                        meta: {}
                    });
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                }
                break;
            }
            case 'attachmentAdded': {
                attachments.push({
                    id: message.id,
                    name: message.name,
                    filePath: message.filePath,
                    dataUrl: message.dataUrl,
                    mime: message.mime
                });
                renderAttachments();
                break;
            }
            case 'attachmentError': {
                const sessionId = getEventSessionId(message, 'attachmentError');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: message.value || 'Failed to attach image.',
                    meta: {}
                });
                window.__oc?.renderFromState?.();
                break;
            }
            case 'permissionPrompt': {
                const sessionId = getEventSessionId(message, 'permissionPrompt');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: `Permission required. Check OpenCode output: ${message.value}`,
                    meta: {}
                });
                window.__oc?.renderFromState?.();
                break;
            }
            case 'diffChunk': {
                const sessionId = getEventSessionId(message, 'diffChunk');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `diff:${Date.now()}`,
                    role: 'system',
                    text: message.value || '',
                    meta: { isDiff: true, diffText: message.value || '' }
                });
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'messageAppend': {
                const sessionId = getEventSessionId(message, 'messageAppend');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                if (message.message && message.message.id) {
                    upsertMessage(session, {
                        id: message.message.id,
                        role: message.message.role || 'assistant',
                        text: message.message.text || '',
                        meta: {}
                    });
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                }
                break;
            }
            case 'revertedSegment': {
                const sessionId = getEventSessionId(message, 'revertedSegment');
                if (!sessionId) break;

                const session = getSessionState(sessionId);
                if (!session) break;

                const ackOpId = message.segment?.operationId;
                const derivedNoticeKey = message.segment?.startMessageId
                    ? `system:undo:${message.segment.startMessageId}`
                    : null;

                let mappedClientOpId = ackOpId;
                let found = false;

                if (derivedNoticeKey && session.pendingUndoByNoticeKey?.has(derivedNoticeKey)) {
                    const pending = session.pendingUndoByNoticeKey.get(derivedNoticeKey);
                    mappedClientOpId = pending.clientOpId;
                    found = true;

                    if (session.pendingUndo) {
                        session.pendingUndo.opId = ackOpId;
                    }

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'revertedSegment', 'map', 'ackOpId', ackOpId, 'mappedClientOpId', mappedClientOpId, 'noticeKey', derivedNoticeKey, 'found', found]
                    });
                } else {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'revertedSegment', 'map', 'ackOpId', ackOpId, 'noticeKey', derivedNoticeKey || 'null', 'found', found]
                    });
                }

                if (session.pendingUndo?.opId === mappedClientOpId) {
                    if (session.seenUndoAckOpIds.has(mappedClientOpId)) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['undo', 'ack-drop-duplicate', mappedClientOpId, 'sessionId', sessionId]
                        });
                    } else {
                        session.seenUndoAckOpIds.add(mappedClientOpId);
                        const members = buildUndoMembersFromTimeline(session, session.pendingUndo.anchorKey);
                        if (!members.length) {
                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['segment.skip', 'reason', 'emptyMembers', 'anchorMsgId', session.pendingUndo.anchorKey]
                            });
                            session.pendingUndo = null;
                            return;
                        }
                        const anchorMsg = session.messagesById.get(session.pendingUndo.anchorKey);
                        const anchorOrder = anchorMsg?.order ?? session.nextOrder;
                        const segmentId = `seg:${derivedNoticeKey || mappedClientOpId}`;
                        const segment = {
                            id: segmentId,
                            anchorOrder: anchorOrder,
                            anchorKey: session.pendingUndo.anchorKey,
                            memberIds: new Set(members),
                            state: message.segment?.discarded ? 'frozen' : 'restorable',
                            isExpanded: false
                        };
                        const existingIdx = session.segments.findIndex(s => s.id === segmentId);
                        if (existingIdx !== -1) {
                            session.segments[existingIdx] = segment;
                        } else {
                            session.segments.push(segment);
                        }

                        const anchorKey = session.pendingUndo.anchorKey;
                        const startServerId = session.pendingUndo.anchorServerId;

                        if (startServerId) {
                            upsertUndoNotice(session, mappedClientOpId, startServerId, 'Undo applied.', null, 'revertedSegment');

                            const noticeKey = `system:undo:${startServerId}`;
                            const stableMembers = members.filter((key) => typeof key === 'string' && key.startsWith('msg_'));
                            if (stableMembers.length === 0) {
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['segment.skip', 'reason', 'emptyMembers', 'noticeKey', noticeKey]
                                });
                                session.pendingUndo = null;
                                return;
                            }

                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['segment.create',
                                    'noticeKey', noticeKey,
                                    'anchorMsgId', anchorKey,
                                    'memberCount', stableMembers.length,
                                    'memberSample', stableMembers.slice(0, 3).join(',')]
                            });

                            vscode.postMessage({
                                type: 'undoSegmentCreated',
                                opId: mappedClientOpId,
                                sessionId,
                                noticeKey: noticeKey,
                                anchorMsgId: anchorKey,
                                anchorOrder: anchorOrder,
                                memberKeys: stableMembers
                            });
                        } else {
                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['undo', 'ack-no-startServerId', mappedClientOpId, 'sessionId', sessionId]
                            });
                        }

                        session.pendingUndo = null;

                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['undo', 'ack', mappedClientOpId, 'sessionId', sessionId, 'membersCount', members.length]
                        });
                    }
                }

                if (message.segment) {
                    applyRevertedSegmentPayload(sessionId, message.segment, derivedNoticeKey);
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                    logSessionState(sessionId, 'revertedSegment');
                }
                break;
            }
            case 'revertedSegmentDiscarded': {
                const sessionId = getEventSessionId(message, 'revertedSegmentDiscarded');
                if (!sessionId) break;

                const session = getSessionState(sessionId);
                if (!session) break;

                const opId = message.segment?.operationId;

                if (session.pendingUndo?.opId === opId) {
                    session.pendingUndo = null;
                }

                const noticeKey = opId ? session.undoNoticeKeyByOpId.get(opId) : null;

                if (session.seenRestoreAckOpIds.has(opId)) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['restore', 'ack-drop-duplicate', opId, 'sessionId', sessionId]
                    });
                } else if (!noticeKey) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['restore', 'drop-no-noticeKey', opId, 'sessionId', sessionId]
                    });
                } else {
                    session.seenRestoreAckOpIds.add(opId);
                    const notice = session.messagesById.get(noticeKey);
                    if (notice) {
                        notice.text = 'Restore applied.';
                        notice.meta.operationId = opId;
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['restore', 'updated-notice', 'noticeKey', noticeKey, 'sessionId', sessionId]
                        });
                    } else {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['restore', 'notice-not-found', 'noticeKey', noticeKey, 'sessionId', sessionId]
                        });
                    }
                    vscode.postMessage({
                        type: 'undoSegmentRemoved',
                        opId,
                        sessionId,
                        noticeKey
                    });

                    const segId = `seg:${noticeKey}`;
                    const segIdx = session.segments.findIndex(s => s.id === segId);
                    if (segIdx >= 0) {
                        session.segments.splice(segIdx, 1);
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['restore', 'removed-segment', 'segId', segId, 'sessionId', sessionId]
                        });
                    }
                }

                if (opId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['undo', 'ack-discarded', opId, 'sessionId', sessionId]
                    });
                }

                if (message.segment) {
                    applyRevertedSegmentPayload(sessionId, message.segment, noticeKey);
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                    logSessionState(sessionId, 'revertedSegmentDiscarded');
                }
                break;
            }
            case 'revertedSegmentState': {
                const sessionId = getEventSessionId(message, 'revertedSegmentState');
                if (!sessionId) break;

                const session = getSessionState(sessionId);
                if (!session) break;

                if (session.pendingUndo?.opId === message.segment?.operationId) {
                    session.pendingUndo = null;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['undo', 'ack-state', message.segment?.operationId]
                    });
                }

                if (message.segment) {
                    applyRevertedSegmentPayload(sessionId, message.segment);
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                    logSessionState(sessionId, 'revertedSegmentState');
                }
                break;
            }
            case 'conflictCard': {
                lastConflictPayload = message;
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'newSession': {
                activeSessionId = message.sessionId || '';
                sessionTitle.textContent = 'OpenCode: Chat';
                isSwitchingSession = true;
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'error': {
                const sessionId = getEventSessionId(message, 'error');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `error:${Date.now()}`,
                    role: 'system',
                    text: message.value || 'An error occurred.',
                    meta: {}
                });
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'removeMessage': {
                const sessionId = getEventSessionId(message, 'removeMessage');
                if (!sessionId) break;
                const session = getSessionState(sessionId);
                if (!session) break;
                const msg = session.messagesById.get(message.messageId);
                if (msg) {
                    msg.meta.isRemoved = true;
                }
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            default:
                break;
        }
    });
});

function renderConflictCard(payload) {
    const chatContainer = document.getElementById('chat');
    if (!payload || !Array.isArray(payload.conflicts) || !chatContainer) return;
    if (conflictCardEl && conflictCardEl.parentElement) {
        conflictCardEl.parentElement.removeChild(conflictCardEl);
    }
    const container = document.createElement('div');
    container.className = 'conflict-card';

    const header = document.createElement('div');
    header.className = 'conflict-card-header';
    header.textContent = 'Conflicts detected. Execution paused.';
    container.appendChild(header);

    const list = document.createElement('div');
    list.className = 'conflict-card-list';

    for (const item of payload.conflicts) {
        const details = document.createElement('details');
        details.className = 'conflict-card-item';

        const summary = document.createElement('summary');
        summary.textContent = item.path || 'unknown';
        details.appendChild(summary);

        const meta = document.createElement('div');
        meta.className = 'conflict-card-meta';
        const expected = item.expectedExists ? 'exists' : 'missing';
        const current = item.currentExists ? 'exists' : 'missing';
        meta.textContent = `Expected: ${expected}, Current: ${current}`;
        details.appendChild(meta);

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = item.diffText || '(no diff)';
        pre.appendChild(code);
        details.appendChild(pre);

        list.appendChild(details);
    }

    container.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'conflict-card-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'conflict-card-btn secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
        if (conflictCardEl && conflictCardEl.parentElement) {
            conflictCardEl.parentElement.removeChild(conflictCardEl);
        }
        conflictCardEl = null;
        lastConflictPayload = null;
        vscode.postMessage({ type: 'conflictDecision', decision: 'cancel' });
    });

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'conflict-card-btn';
    continueBtn.textContent = 'Continue';
    continueBtn.addEventListener('click', () => {
        if (conflictCardEl && conflictCardEl.parentElement) {
            conflictCardEl.parentElement.removeChild(conflictCardEl);
        }
        conflictCardEl = null;
        lastConflictPayload = null;
        vscode.postMessage({
            type: 'conflictDecision',
            decision: 'continue',
            kind: payload.kind,
            startMessageId: payload.startMessageId
        });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(continueBtn);
    container.appendChild(actions);

    chatContainer.appendChild(container);
    conflictCardEl = container;
    chatContainer.scrollTop = chatContainer.scrollHeight;
}
