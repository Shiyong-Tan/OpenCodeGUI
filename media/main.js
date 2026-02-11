const vscode = acquireVsCodeApi();

const md = window.markdownit({
    linkify: true,
    breaks: true,
    html: false
});

if (window.texmath && window.katex) {
    md.use(window.texmath, {
        engine: window.katex,
        delimiters: ['dollars', 'brackets'],
        outerSpace: true,
        katexOptions: { throwOnError: false }
    });
}

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
let hydratedSessions = new Set();
let allowedDiscardKeys = new Set();

const sessionsById = new Map();
let gitUndoEnabled = false;
let gitUndoReason = null;
let baselineReady = true;
let baselineMessage = null;
let sendButtonEl = null;
let inputEl = null;
const pendingUiPrompts = [];
const agentTimeoutBySession = new Map();
const agentTimeoutNoticeBySession = new Map();
const agentTimeoutOpBySession = new Map();

function formatList(values, max = 20) {
    if (!Array.isArray(values)) return '[]';
    if (values.length <= max) {
        return `[${values.join(', ')}]`;
    }
    const head = values.slice(0, 10);
    const tail = values.slice(-10);
    return `[${head.join(', ')}, ... , ${tail.join(', ')}]`;
}

// Removed obsolete segment state functions - new system uses segmentsByNoticeKey

function logSegmentState(sessionId, label) {
    const session = getSessionState(sessionId);
    if (!session) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEG_STATE]', label, 'session=null']
        });
        return;
    }
    const segments = Array.from(session.segmentsByNoticeKey.values());
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_STATE]', label, 
            `sessionId=${sessionId}`,
            `segments=${segments.length}`, 
            `hidden=${session.hiddenSet.size}`]
    });
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

function isThinkingActive(sessionId) {
    const session = getSessionState(sessionId);
    if (!session || !session.thinkingId) return false;
    const msg = session.messagesById.get(session.thinkingId);
    if (!msg) return false;
    if (msg.meta?.isThinking === true) return true;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    return text === 'Thinking...';
}

function clearAgentTimeout(sessionId, reason, removeNotice = false) {
    if (!sessionId) return;
    const timer = agentTimeoutBySession.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        agentTimeoutBySession.delete(sessionId);
    }
    agentTimeoutOpBySession.delete(sessionId);
    if (removeNotice) {
        agentTimeoutNoticeBySession.delete(sessionId);
        window.__oc?.renderFromState?.();
    }
    if (timer) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV: agentTimeout.cancel', `sessionId=${sessionId}`, `reason=${reason || 'unknown'}`]
        });
    }
}

function startAgentTimeout(sessionId, opId) {
    if (!sessionId) return;
    clearAgentTimeout(sessionId, 'restart', true);
    agentTimeoutOpBySession.set(sessionId, opId || null);
    const timer = setTimeout(() => {
        const currentOp = agentTimeoutOpBySession.get(sessionId);
        if ((opId || null) !== currentOp) return;
        if (!isThinkingActive(sessionId)) return;
        agentTimeoutNoticeBySession.set(sessionId, 'The agent is not responding, probably due to the usage limit.');
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV: agentTimeout.fire', `sessionId=${sessionId}`, `opId=${opId || 'null'}`]
        });
        window.__oc?.renderFromState?.();
    }, 30000);
    agentTimeoutBySession.set(sessionId, timer);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['WV: agentTimeout.start', `sessionId=${sessionId}`, `opId=${opId || 'null'}`, 'delay=30000']
    });
}

function logTimelineSnapshot(action, timeline, details) {
    const counts = timelineCounts(timeline);
    const tail = formatTail(timeline);
    const detailText = details ? ` ${details}` : '';
    // vscode.postMessage({
    //     type: 'ui-debug',
    //     payload: ['[DBG_TIMELINE]', `action=${action}${detailText} size=${timeline.length} tail=${tail}`]
    // });
    // vscode.postMessage({
    //     type: 'ui-debug',
    //     payload: ['[DBG_TIMELINE]', `counts msg=${counts.msg} tmp=${counts.tmp} local=${counts.local}`]
    // });
}

function ensureNoticeAtAnchor(timeline, noticeKey, anchorMsgId) {
    const prevIdx = timeline.indexOf(noticeKey);
    const anchorIdx = timeline.indexOf(anchorMsgId);
    if (anchorIdx < 0) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][NOTICE_ANCHOR_MISS]', `noticeKey=${noticeKey}`, `anchorMsgId=${anchorMsgId}`]
        });
        if (prevIdx >= 0) {
            timeline.splice(prevIdx, 1);
        }
        timeline.push(noticeKey);
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][NOTICE_REPOS]', `noticeKey=${noticeKey}`, `anchorIdx=${anchorIdx}`, `insertIdx=${timeline.length - 1}`, `prevIdx=${prevIdx}`, `timelineSize=${timeline.length}`]
        });
        return;
    }

    let insertIdx = anchorIdx + 1;
    if (prevIdx >= 0) {
        timeline.splice(prevIdx, 1);
        if (prevIdx < insertIdx) insertIdx -= 1;
    }
    timeline.splice(insertIdx, 0, noticeKey);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][NOTICE_REPOS]', `noticeKey=${noticeKey}`, `anchorIdx=${anchorIdx}`, `insertIdx=${insertIdx}`, `prevIdx=${prevIdx}`, `timelineSize=${timeline.length}`]
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
        messageIndexMap: new Map(),
        segmentsByNoticeKey: new Map(),
        hiddenSet: new Set(),
        thinkingId: null,
        currentTurnAssistantKey: null,
        currentTurnAssistantMsgId: null,
        lastTurnUserId: null,
        lastTurnAssistantId: null,
        cancelledTurn: false,
        canceledActiveTurn: false,
        activeTurnOpId: null,
        pendingAssistantUpgrade: null,
        nextOrder: 0,
        serverIdToKey: new Map(),
        clientKeyToServerId: new Map(),
        serverIdToClientKey: new Map(),
        undoNoticeKeyByOpId: new Map(),
        pendingUndoByNoticeKey: new Map(),
        seenUndoAckOpIds: new Set(),
        pendingUndo: null,
        lastUndoNoticeKey: null,
        undoAvailable: true
    };
}

function getSessionState(sessionId, create = false) {
    if (!sessionId) return null;
    if (!sessionsById.has(sessionId) && create) {
        sessionsById.set(sessionId, createSessionState());
    }
    return sessionsById.get(sessionId) || null;
}

function removeMessageFromSession(session, messageId) {
    if (!session || !messageId) return;
    session.messagesById.delete(messageId);
    if (Array.isArray(session.timeline) && session.timeline.length) {
        session.timeline = session.timeline.filter((id) => id !== messageId);
    }
    session.hiddenSet.delete(messageId);
    if (session.thinkingId === messageId) {
        session.thinkingId = null;
    }
    if (session.currentTurnAssistantKey === messageId) {
        session.currentTurnAssistantKey = null;
    }
    if (session.currentTurnAssistantMsgId === messageId) {
        session.currentTurnAssistantMsgId = null;
    }
}

    function cancelLocalTurn(sessionId) {
        const session = getSessionState(sessionId);
        if (!session) return;
    const userId = session.lastTurnUserId;
    const assistantId = session.lastTurnAssistantId;
    if (userId) {
        removeMessageFromSession(session, userId);
    }
    if (assistantId) {
        removeMessageFromSession(session, assistantId);
    }
    if (session.thinkingId && session.thinkingId !== assistantId) {
        removeMessageFromSession(session, session.thinkingId);
    }
    session.lastTurnUserId = null;
    session.lastTurnAssistantId = null;
    session.cancelledTurn = true;
    session.canceledActiveTurn = true;
    session.pendingAssistantUpgrade = null;
    session.currentTurnAssistantKey = null;
    session.currentTurnAssistantMsgId = null;
    session.activeTurnOpId = null;
    window.__oc?.renderFromState?.();
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

/**
 * CORE SEGMENT FUNCTIONS (V2 - Simplified)
 * Segments are pure render-layer constructs that NEVER modify timeline
 */

/**
 * Compute memberMsgIds from timeline [anchorMsgId, endMsgId] closed interval
 * Returns all msg_* messages in the range
 */
function computeMemberMsgIdsFromTimeline(session, anchorMsgId, endMsgId) {
    const inTimelineAnchor = session.timeline.includes(anchorMsgId);
    const inTimelineEnd = endMsgId ? session.timeline.includes(endMsgId) : false;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['MEMBERS_PRECHECK', `anchor=${anchorMsgId || 'null'}`, `end=${endMsgId || 'null'}`,
            `inTimelineAnchor=${inTimelineAnchor}`, `inTimelineEnd=${inTimelineEnd}`, `timelineLen=${session.timeline.length}`]
    });
    const anchorIdx = session.timeline.indexOf(anchorMsgId);
    const endIdx = session.timeline.indexOf(endMsgId);
    
    // If anchor not found, return empty (segment will be skipped)
    if (anchorIdx === -1) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][COMPUTE_MEMBERS]', 'anchor-not-found', `anchorMsgId=${anchorMsgId}`]
        });
        return [];
    }
    
    // If end not found or invalid, degrade to single-item interval [anchor, anchor]
    if (endIdx === -1 || endIdx < anchorIdx) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][COMPUTE_MEMBERS]', 'end-missing-or-invalid', 
                `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`, 
                'degrade-to-anchor-only']
        });
        return [anchorMsgId];
    }
    
    // Collect all msg_* in [anchorIdx, endIdx] closed interval
    const result = [];
    for (let i = anchorIdx; i <= endIdx; i++) {
        const id = session.timeline[i];
        if (typeof id === 'string' && id.startsWith('msg_')) {
            result.push(id);
        }
    }
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][COMPUTE_MEMBERS]', 
            `anchorMsgId=${anchorMsgId}`, 
            `endMsgId=${endMsgId}`,
            `count=${result.length}`]
    });
    
    return result;
}

function resolveSegmentMessageId(session, messageId) {
    if (!messageId || typeof messageId !== 'string') return null;
    if (session.timeline.includes(messageId)) return messageId;
    const mappedLocal = session.serverIdToClientKey?.get(messageId);
    if (mappedLocal && session.timeline.includes(mappedLocal)) return mappedLocal;
    const mappedServer = session.clientKeyToServerId?.get(messageId);
    if (mappedServer && session.timeline.includes(mappedServer)) return mappedServer;
    return null;
}

/**
 * Rebuild hiddenSet from all segments in segmentsByNoticeKey
 * This is the ONLY function that determines which messages are hidden
 * CRITICAL: ALL memberMsgIds are hidden, INCLUDING the anchor
 */
function rebuildHiddenSetFromTimeline(session) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][REBUILD_HIDDEN_ENTER]',
            `timelineSize=${session.timeline.length}`,
            `segmentsCount=${session.segmentsByNoticeKey.size}`]
    });
    session.hiddenSet.clear();
    
    let processedCount = 0;
    let skippedCount = 0;
    
    for (const [noticeKey, segment] of session.segmentsByNoticeKey) {
        // Only process collapsed segments (always true in current impl)
        if (!segment.collapsed) continue;
        
        // Use existing memberMsgIds when present (even if anchor missing from timeline)
        let memberMsgIds = Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds.slice() : [];
        if (memberMsgIds.length === 0) {
            const anchorIdx = session.timeline.indexOf(segment.anchorMsgId);
            if (anchorIdx === -1) {
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_SKIP_ANCHOR_MISSING]', 
                        `noticeKey=${noticeKey}`, 
                        `anchorMsgId=${segment.anchorMsgId}`]
                });
                skippedCount++;
                continue;  // Skip rendering this segment
            }
            memberMsgIds = computeMemberMsgIdsFromTimeline(
                session, 
                segment.anchorMsgId, 
                segment.endMsgId
            );
            segment.memberMsgIds = memberMsgIds;
        }
        
        if (memberMsgIds.length === 0) {
            skippedCount++;
            continue;
        }
        
        // Hide ALL members INCLUDING the anchor
        for (const msgId of memberMsgIds) {
            if (typeof msgId === 'string' && msgId.startsWith('system:undo-seg:')) continue;
            session.hiddenSet.add(msgId);
        }
        
        processedCount++;
    }

    for (const id of session.hiddenSet) {
        if (typeof id === 'string' && id.startsWith('system:undo-seg:')) {
            session.hiddenSet.delete(id);
        }
    }
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_REBUILD]', 
            `totalSegments=${session.segmentsByNoticeKey.size}`,
            `processed=${processedCount}`,
            `skipped=${skippedCount}`,
            `hiddenCount=${session.hiddenSet.size}`]
    });
    const placeholderIds = session.timeline.filter((id) => typeof id === 'string' && id.startsWith('system:undo-seg:'));
    const samplePlaceholder = placeholderIds[0] || null;
    const placeholderHidden = samplePlaceholder ? session.hiddenSet.has(samplePlaceholder) : false;
    let anchorHidden = null;
    if (session.segmentsByNoticeKey.size) {
        const firstSegment = session.segmentsByNoticeKey.values().next().value;
        if (firstSegment?.anchorMsgId) {
            anchorHidden = session.hiddenSet.has(firstSegment.anchorMsgId);
        }
    }
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][HIDDEN_SET]',
            `hiddenSetSize=${session.hiddenSet.size}`,
            `placeholderHidden=${placeholderHidden}`,
            `anchorHidden=${anchorHidden === null ? 'null' : anchorHidden}`]
    });
    const hiddenSample = formatList(Array.from(session.hiddenSet).slice(0, 10), 10);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][REBUILD_HIDDEN_DONE]',
            `hiddenSetSize=${session.hiddenSet.size}`,
            `sampleHiddenFirst10=${hiddenSample}`]
    });
}

function discardAllSegments(sessionId, reason, mode) {
    const session = getSessionState(sessionId);
    if (!session) return 0;
    let count = 0;
    for (const segment of session.segmentsByNoticeKey.values()) {
        if (segment.restoreAllowed !== false) {
            segment.restoreAllowed = false;
            count++;
            vscode.postMessage({
                type: 'undoSegmentUpsert',
                sessionId,
                segment: {
                    noticeKey: segment.noticeKey,
                    anchorMsgId: segment.anchorMsgId,
                    endMsgId: segment.endMsgId,
                    memberMsgIds: Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [],
                    applied: segment.applied ?? true,
                    restoreAllowed: false,
                    collapsed: true,
                    updatedAt: Date.now()
                }
            });
        }
    }
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_DISCARD]', `reason=${reason}`, `count=${count}`, `sessionId=${sessionId || 'null'}`, `mode=${mode || 'null'}`]
    });
    return count;
}

function getUndoPlaceholderId(noticeKey) {
    return `system:undo-seg:${noticeKey}`;
}

function upsertUndoPlaceholder(session, noticeKey, anchorMsgId, endMsgId, applied) {
    const placeholderId = getUndoPlaceholderId(noticeKey);
    const createdAt = Date.now();
    session.messagesById.set(placeholderId, {
        id: placeholderId,
        role: 'system',
        text: '',
        meta: {
            kind: 'undoSegmentPlaceholder',
            noticeKey,
            anchorMsgId,
            endMsgId,
            applied,
            createdAt
        }
    });

    const existingIndex = session.timeline.indexOf(placeholderId);
    if (existingIndex !== -1) {
        session.timeline.splice(existingIndex, 1);
    }

    const beforeSize = session.timeline.length;
    const anchorIndex = anchorMsgId ? session.timeline.indexOf(anchorMsgId) : -1;
    const endIndex = endMsgId ? session.timeline.indexOf(endMsgId) : -1;
    let action = 'append';

    if (anchorIndex !== -1) {
        session.timeline[anchorIndex] = placeholderId;
        action = 'replace-anchor';
    } else if (endIndex !== -1) {
        if (session.hiddenSet.has(endMsgId)) {
            session.timeline.splice(endIndex, 0, placeholderId);
            action = 'insert-before-end';
        } else {
            session.timeline[endIndex] = placeholderId;
            action = 'replace-end';
        }
    } else {
        session.timeline.push(placeholderId);
    }

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_PLACEHOLDER]',
            `placeholderId=${placeholderId}`,
            `anchorMsgId=${anchorMsgId || 'null'}`,
            `anchorIndex=${anchorIndex}`,
            `endIndex=${endIndex}`,
            `action=${action}`,
            `timelineBefore=${beforeSize}`,
            `timelineAfter=${session.timeline.length}`]
    });

    return placeholderId;
}

/**
 * Apply hydrated segments from extension
 * This is called during session load/switch
 * Clears current state and rebuilds from scratch
 */
function applyHydratedSegments(session, segments, hasSegments = true) {
    const beforeCount = session.segmentsByNoticeKey.size;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_HYDRATE]', 
            `segmentCount=${segments.length}`,
            `hasSegments=${hasSegments}`,
            `before=${beforeCount}`]
    });
    
    // Clear current segments only when segments are provided
    if (hasSegments) {
        session.segmentsByNoticeKey.clear();
    }
    
    // Insert all hydrated segments
    for (const seg of segments) {
        if (!seg.noticeKey || !seg.anchorMsgId) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_HYDRATE_SKIP]', 'missing-required-fields', 
                    `noticeKey=${seg.noticeKey || 'null'}`,
                    `anchorMsgId=${seg.anchorMsgId || 'null'}`]
            });
            continue;
        }
        
        session.segmentsByNoticeKey.set(seg.noticeKey, {
            noticeKey: seg.noticeKey,
            anchorMsgId: seg.anchorMsgId,
            endMsgId: seg.endMsgId || seg.anchorMsgId,
            memberMsgIds: seg.memberMsgIds || [],
            restoreAllowed: seg.restoreAllowed === true,
            collapsed: true,  // Always collapsed (not persisted)
            createdAt: seg.createdAt || Date.now()
        });
    }
    
    // Rebuild hidden set from timeline
    rebuildHiddenSetFromTimeline(session);
    
    // Log segment creation result
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_CREATED]',
            `segmentCount=${session.segmentsByNoticeKey.size}`,
            `hiddenCount=${session.hiddenSet.size}`,
            `before=${beforeCount}`,
            `after=${session.segmentsByNoticeKey.size}`,
            `hasSegments=${hasSegments}`]
    });
    
    // Trigger re-render
    window.__oc?.renderFromState?.();
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
        session.undoNoticeKeyByOpId.set(operationId, k);
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

    if (!existed && !session.timeline.includes(k) && source !== 'sessionData') {
        session.timeline.push(k);
    }

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['upsertUndoNotice', 'stableKey', k, 'opId', operationId, 'source', source, 'timelineHas', session.timeline.includes(k)]
    });

    return k;
}

function replaceKeyEverywhere(oldId, newId) {
    const session = getSessionState(activeSessionId);
    if (!session) return;

    if (typeof oldId === 'string' && typeof newId === 'string' && oldId.startsWith('local-') && newId === session.currentTurnAssistantMsgId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['reject.user->assistant-id', 'oldKey', oldId, 'newKey', newId, 'sessionId', activeSessionId]
        });
        return;
    }

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

    // Update segments to use new message ID
    for (const segment of session.segmentsByNoticeKey.values()) {
        if (segment.memberMsgIds.includes(oldId)) {
            segment.memberMsgIds = segment.memberMsgIds.map(id => id === oldId ? newId : id);
        }
        if (segment.anchorMsgId === oldId) {
            segment.anchorMsgId = newId;
        }
        if (segment.endMsgId === oldId) {
            segment.endMsgId = newId;
        }
    }

    if (session.thinkingId === oldId) {
        session.thinkingId = newId;
    }

    if (session.currentTurnAssistantKey === oldId) {
        session.currentTurnAssistantKey = newId;
    }
    if (typeof newId === 'string' && newId.startsWith('msg_')) {
        session.currentTurnAssistantMsgId = newId;
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

// Removed obsolete freezeSegments function - new system uses segmentsByNoticeKey

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

// Removed obsolete repairSegmentOverlap function - new system uses segmentsByNoticeKey

function assertInvariants(sessionId, source) {
    const session = getSessionState(sessionId);
    if (!session) return;
    ensureThinkingUnique(session, source);
    // Removed repairSegmentOverlap - not needed with new segment system
}

function logSessionState(sessionId, eventName) {
    const session = getSessionState(sessionId);
    if (!session) return;
    const segments = Array.from(session.segmentsByNoticeKey.values()).map((seg) => ({
        noticeKey: seg.noticeKey,
        anchorMsgId: seg.anchorMsgId,
        memberCount: seg.memberMsgIds.length
    }));
    console.log(`[session] activeSessionId=${activeSessionId} event=${eventName} sessionId=${sessionId}`);
    console.log('[session] thinkingId=', session.thinkingId);
    console.log('[session] segments=', segments);
    console.log('[session] hiddenSet.size=', session.hiddenSet.size);
}

function createTempAssistantId() {
    const suffix = Math.random().toString(36).slice(2, 10);
    return `tmp:${Date.now()}-${suffix}`;
}

/**
 * Apply reverted segment payload (from undo operation)
 * CRITICAL: This function NEVER modifies timeline
 * Segment is a pure render-layer construct
 */
function applyRevertedSegmentPayload(sessionId, payload, noticeKeyFromCaller) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][APPLY_REVERTED_ENTER]',
            `sessionId=${sessionId || 'null'}`,
            `noticeKey=${noticeKeyFromCaller || 'null'}`,
            `anchorMsgId=${payload?.startMessageId || 'null'}`,
            `endMsgId=${payload?.endMessageId || 'null'}`,
            `applied=${payload?.applied ?? 'null'}`]
    });
    const session = getSessionState(sessionId, true);
    if (!session) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_RETURN]', 'reason=missing-session', `sessionId=${sessionId || 'null'}`]
        });
        return;
    }

    if (!payload) {
        vscode.postMessage({ 
            type: 'ui-debug', 
            payload: ['[WV][APPLY_REVERTED_RETURN]', 'reason=payload-null']
        });
        return;
    }

    // Build mode should still apply segments (UI collapse is required)

    const rawAnchorMsgId = payload.startMessageId || payload.anchorMsgId || null;
    const rawEndMsgId = payload.endMessageId || payload.endMsgId || null;
    
    if (!rawAnchorMsgId || (typeof rawAnchorMsgId === 'string' && !rawAnchorMsgId.startsWith('msg_') && !rawAnchorMsgId.startsWith('local-'))) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_RETURN]', 'reason=invalid-anchorMsgId', rawAnchorMsgId || 'null']
        });
        return;
    }

    const anchorMsgId = resolveSegmentMessageId(session, rawAnchorMsgId);
    if (!anchorMsgId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_RETURN]', 'reason=anchor-not-in-timeline',
                `anchorMsgId=${rawAnchorMsgId}`,
                `timelineLength=${session.timeline.length}`]
        });
        return;
    }

    const endMsgId = resolveSegmentMessageId(session, rawEndMsgId) || anchorMsgId;
    
    // Create noticeKey (identifier only, NOT a timeline message)
    const computedNoticeKey = rawAnchorMsgId ? `system:undo:${rawAnchorMsgId}` : null;
    const payloadNoticeKey = typeof payload.noticeKey === 'string' && payload.noticeKey ? payload.noticeKey : null;
    const noticeKey = typeof noticeKeyFromCaller === 'string' && noticeKeyFromCaller
        ? noticeKeyFromCaller
        : (payloadNoticeKey || computedNoticeKey);
    if (!noticeKey) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_RETURN]', 'reason=missing-noticeKey']
        });
        return;
    }
    if (noticeKeyFromCaller && computedNoticeKey && noticeKeyFromCaller !== computedNoticeKey) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][UNDO_NOTICE_MISMATCH]', `caller=${noticeKeyFromCaller}`, `computed=${noticeKey}`]
        });
    }
    
    // Compute memberMsgIds from timeline
    let memberMsgIds = computeMemberMsgIdsFromTimeline(
        session,
        anchorMsgId,
        endMsgId
    );

    const payloadMemberMsgIds = Array.isArray(payload.messageIds)
        ? payload.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
        : [];
    if (payloadMemberMsgIds.length) {
        memberMsgIds = payloadMemberMsgIds;
    }

    if (memberMsgIds.length === 0 && anchorMsgId) {
        memberMsgIds = [anchorMsgId];
    }
    
    if (memberMsgIds.length === 0) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_WARN]', 'reason=no-members-computed',
                `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`]
        });
    }
    
    // Store segment locally
    session.segmentsByNoticeKey.set(noticeKey, {
        noticeKey,
        anchorMsgId,
        endMsgId: endMsgId || anchorMsgId,
        memberMsgIds,
        collapsed: true,
        createdAt: Date.now()
    });
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][APPLY_REVERTED_INSERT]',
            `key=${noticeKey}`,
            `segCount=${session.segmentsByNoticeKey.size}`]
    });
    
    // Rebuild hidden set
    rebuildHiddenSetFromTimeline(session);
    
    // Send to extension for persistence
    vscode.postMessage({
        type: 'undoSegmentUpsert',
        sessionId,
        segment: {
            noticeKey,
            anchorMsgId,
            endMsgId: endMsgId || anchorMsgId,
            memberMsgIds,
            collapsed: true,
            updatedAt: Date.now()
        }
    });
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_UPSERT]', 
            `noticeKey=${noticeKey}`,
            `anchorMsgId=${anchorMsgId}`,
            `endMsgId=${endMsgId || anchorMsgId}`,
            `memberCount=${memberMsgIds.length}`]
    });
    
    // Trigger re-render
    window.__oc?.renderFromState?.();
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

// Removed obsolete reconcilePendingSegments function - new system uses applyHydratedSegments

// Removed obsolete createSegmentFromUndo function - new system uses applyRevertedSegmentPayload


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
    if (!gitUndoEnabled) {
        return { allowed: false, reason: gitUndoReason || 'git-disabled', msgId };
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

function setSendEnabled(enabled) {
    if (inputEl) {
        if (!enabled && baselineMessage) {
            inputEl.placeholder = baselineMessage;
        }
    }
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
    if (typeof assistantMsgId !== 'string' || !assistantMsgId.startsWith('msg_')) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey || 'null'} msgId=${assistantMsgId || 'null'} replaced=false reason=missing-or-bad-assistantMsgId`] });
        return;
    }
    const session = getSessionState(payloadSession);
    if (!session) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey || 'null'} msgId=${assistantMsgId} replaced=false reason=no-session`] });
        return;
    }

    const resolveLastAssistantKey = () => {
        for (let i = session.timeline.length - 1; i >= 0; i--) {
            const id = session.timeline[i];
            const msg = session.messagesById.get(id);
            if (msg?.role === 'assistant') return id;
        }
        return null;
    };

    const currentKey = session.currentTurnAssistantKey || tmpKey || resolveLastAssistantKey();
    const newKey = assistantMsgId;

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['ASSIST_UPGRADE_MAP', `mapExists=${Boolean(session.messageIndexMap)}`, `hasType=${typeof session.messageIndexMap?.has}`, `hasNewKey=${session.messageIndexMap?.has?.(newKey)}`]
    });

    const getKeyIndex = (key) => {
        if (typeof key !== 'string' || !key.length) return null;
        if (session.messageIndexMap?.has(key)) return session.messageIndexMap.get(key);
        if (key.startsWith('tmp:') || key.startsWith('local-')) return -1;
        return null;
    };

    const curIndex = getKeyIndex(currentKey);
    const newIndex = getKeyIndex(newKey);
    let replaced = false;
    let reason = 'no-change';

    if (!currentKey) {
        session.currentTurnAssistantKey = newKey;
        session.currentTurnAssistantMsgId = newKey;
        reason = 'set-current-only';
    } else if (currentKey === newKey) {
        reason = 'already-current';
    } else if (typeof newIndex === 'number' && typeof curIndex !== 'number') {
        replaceKeyEverywhere(currentKey, newKey);
        replaced = true;
        reason = 'new-index-known';
    } else if (typeof newIndex === 'number' && typeof curIndex === 'number' && newIndex > curIndex) {
        replaceKeyEverywhere(currentKey, newKey);
        replaced = true;
        reason = 'higher-index';
    } else if ((currentKey.startsWith('tmp:') || currentKey.startsWith('local-')) && typeof newIndex === 'number') {
        replaceKeyEverywhere(currentKey, newKey);
        replaced = true;
        reason = 'tmp-local-upgrade';
    } else if (typeof newIndex === 'number' && curIndex === -1) {
        replaceKeyEverywhere(currentKey, newKey);
        replaced = true;
        reason = 'tmp-local-index';
    }

    const tail = formatTail(session.timeline, 2);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['ASSIST_UPGRADE', `curKey=${currentKey || 'null'}`, `newKey=${newKey}`, `curIndex=${curIndex === null ? 'null' : curIndex}`,
            `newIndex=${newIndex === null ? 'null' : newIndex}`, `replaced=${replaced}`, `reason=${reason}`, `tail=${tail}`]
    });
}

const UNDO_TIMEOUT_MS = 10000;

function handleUndoToMessage(sessionId, targetMessageId) {
    try {
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_FUNC_ENTER]', 'sessionId', sessionId || 'NULL', 'typeof', typeof sessionId, 'targetMessageId', targetMessageId || 'NULL', 'activeSessionId', activeSessionId || 'NULL'] });
        
        const session = getSessionState(sessionId);
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_AFTER_GET_SESSION]', 'hasSession', !!session, 'sessionType', typeof session] });
        
        if (!session) {
            vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_FUNC_NO_SESSION]', 'sessionId', sessionId || 'NULL', 'activeSessionId', activeSessionId || 'NULL', 'mapSize', sessionsById.size, 'hasSession', sessionsById.has(sessionId)] });
            return;
        }
        
        const target = session.messagesById.get(targetMessageId);
        if (!target) {
            vscode.postMessage({ type: 'ui-debug', payload: ['undo', 'target-not-found', targetMessageId, 'sessionId', sessionId] });
            return;
        }

        const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const serverId = targetMessageId;

        const noticeKey = `system:undo:${serverId}`;
        session.undoNoticeKeyByOpId.set(opId, noticeKey);
        session.lastUndoNoticeKey = noticeKey;

        session.pendingUndo = {
            clientOpId: opId,
            ackOpId: null,
            anchorKey: targetMessageId,
            anchorServerId: serverId,
            noticeKey,
            ts: Date.now()
        };

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
        vscode.postMessage({ type: 'ui-debug', payload: ['undo.send', 'clientOpId', opId, 'noticeKey', noticeKey, 'anchorMsgId', targetMessageId, 'sessionId', sessionId] });
        vscode.postMessage({ type: 'ui-debug', payload: ['WV', 'undo', 'pending', 'noticeKey', noticeKey, 'clientOpId', opId, 'sessionId', sessionId] });
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_PRE_SEND]', 'sessionId', sessionId || 'NULL', 'opId', opId || 'NULL', 'serverId', serverId || 'NULL', 'typeof_sessionId', typeof sessionId, 'typeof_opId', typeof opId, 'typeof_serverId', typeof serverId] });
        const undoMessage = { type: 'undoToMessage', sessionId, operationId: opId, messageId: serverId };
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_MSG_OBJ]', JSON.stringify(undoMessage)] });
        
        // Send a test ping immediately before undoToMessage to verify channel is working
        vscode.postMessage({ type: 'ping' });
        
        vscode.postMessage(undoMessage);
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_POST_SEND]', 'sent'] });

        setTimeout(() => handleUndoTimeout(sessionId, opId), UNDO_TIMEOUT_MS);
    } catch (error) {
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_ERROR]', 'error', String(error), 'message', error?.message || 'unknown', 'stack', error?.stack || 'no-stack'] });
        throw error;
    }
}

function handleUndoTimeout(sessionId, clientOpId) {
    const session = getSessionState(sessionId);
    if (!session || !session.pendingUndo) return;
    if (session.pendingUndo.clientOpId !== clientOpId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['undo', 'timeout-skip', 'clientOpId', clientOpId || 'null', 'stillPending', false]
        });
        return;
    }

    const { clientOpId: opId, anchorKey } = session.pendingUndo;
    const now = Date.now();
    const elapsed = now - session.pendingUndo.ts;

    if (elapsed < UNDO_TIMEOUT_MS) return;

    if (!session.pendingUndo || session.pendingUndo.clientOpId !== clientOpId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['undo', 'timeout-skip', 'clientOpId', clientOpId || 'null', 'stillPending', false]
        });
        return;
    }

    const timeoutKey = `system:undo-timeout:${opId}`;
    upsertMessage(session, {
        id: timeoutKey,
        role: 'system',
        text: 'Undo request timed out (code state losts.).',
        meta: { kind: 'undoTimeout', opId, anchorKey }
    });
    if (!session.timeline.includes(timeoutKey)) {
        session.timeline.push(timeoutKey);
    }

    const stillPending = Boolean(session.pendingUndo && session.pendingUndo.clientOpId === opId);
    session.pendingUndo = null;

    if (session.pendingUndoByNoticeKey?.size) {
        for (const [key, pending] of session.pendingUndoByNoticeKey.entries()) {
            if (pending?.clientOpId === opId) {
                session.pendingUndoByNoticeKey.delete(key);
            }
        }
    }

    vscode.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout', 'clientOpId', opId, 'elapsed', elapsed, 'sessionId', sessionId, 'stillPending', stillPending] });
    window.__oc?.renderFromState?.();
}

/**
 * Handle restore segment request
 * Sends restore request to extension, which will respond with restoredSegment message
 */
function handleRestoreSegment(sessionId, segmentId) {
    const session = getSessionState(sessionId);
    if (!session) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][RESTORE_DROP]', 'session-not-found', `sessionId=${sessionId || 'null'}`]
        });
        return;
    }
    
    // Extract noticeKey from segmentId (format may be seg:system:undo:msg_xxx or system:undo:msg_xxx)
    const noticeKey = segmentId.startsWith('seg:') 
        ? segmentId.slice(4) 
        : segmentId;
    
    const segment = session.segmentsByNoticeKey.get(noticeKey);
    if (!segment) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][RESTORE_DROP]', 'segment-not-found', `noticeKey=${noticeKey}`]
        });
        return;
    }
    
    // Send restore request to extension
    vscode.postMessage({
        type: 'restoreSegment',
        sessionId,
        noticeKey: segment.noticeKey,
        anchorMsgId: segment.anchorMsgId,
        endMsgId: segment.endMsgId
    });
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_RESTORE_SEND]',
            `sessionId=${sessionId || 'null'}`,
            `noticeKey=${noticeKey}`,
            'type=restoreSegment']
    });
}

function handleToggleSegment(sessionId, segmentId) {
    const session = getSessionState(sessionId);
    if (!session) return;
    // segmentId is the noticeKey
    const segment = session.segmentsByNoticeKey.get(segmentId);
    if (!segment) return;
    segment.collapsed = !segment.collapsed;
    assertInvariants(sessionId, 'toggleSegment');
}

function renderMarkdownInto(element, text) {
    const unwrapped = escapeSystemReminderTags(text || '');
    const normalized = normalizeLists(normalizeInlineMath(normalizeBlockMath(unwrapped)));
    const raw = md.render(normalized);
    element.innerHTML = purify.sanitize(raw, {
        ALLOWED_TAGS: [
            'a', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
            'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
            'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'section', 'eq', 'eqn',
            'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot',
            'mtable', 'mtr', 'mtd', 'mtext', 'mstyle', 'annotation', 'semantics'
        ],
        ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'role', 'aria-hidden', 'style', 'mathvariant', 'display', 'xmlns', 'encoding']
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
    enhanceCodeBlocksWithCopyButtons(element);
}

function enhanceCodeBlocksWithCopyButtons(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (root.closest && root.closest('.conflict-card')) return;

    const assistantRoot = root.closest ? root.closest('.message.bot') : null;
    const containers = assistantRoot
        ? [assistantRoot]
        : Array.from(root.querySelectorAll('.message.bot'));

    for (const container of containers) {
        const contentRoot = container.querySelector('.message-content') || container;
        for (const pre of contentRoot.querySelectorAll('pre')) {
            if (pre.dataset.hasCopyBtn === '1') continue;
            const code = pre.querySelector('code');
            if (!code) continue;
            pre.dataset.hasCopyBtn = '1';

            let wrapper = pre.parentElement;
            if (!wrapper || !wrapper.classList.contains('code-block-wrap')) {
                wrapper = document.createElement('div');
                wrapper.className = 'code-block-wrap';
                pre.parentElement?.insertBefore(wrapper, pre);
                wrapper.appendChild(pre);
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'code-copy-btn';
            btn.textContent = 'Copy';
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const text = code.innerText || '';
                if (!text) return;
                let copied = false;
                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    try {
                        await navigator.clipboard.writeText(text);
                        copied = true;
                    } catch {
                        copied = false;
                    }
                }
                if (!copied) {
                    try {
                        const textarea = document.createElement('textarea');
                        textarea.value = text;
                        textarea.setAttribute('readonly', '');
                        textarea.style.position = 'absolute';
                        textarea.style.left = '-9999px';
                        document.body.appendChild(textarea);
                        textarea.select();
                        copied = document.execCommand('copy');
                        document.body.removeChild(textarea);
                    } catch {
                        copied = false;
                    }
                }
                const prev = 'Copy';
                if (btn._copyResetTimer) {
                    clearTimeout(btn._copyResetTimer);
                }
                if (copied) {
                    btn.textContent = 'Copied!';
                    btn._copyResetTimer = setTimeout(() => {
                        btn.textContent = prev;
                    }, 800);
                } else {
                    btn.textContent = 'Failed';
                    btn._copyResetTimer = setTimeout(() => {
                        btn.textContent = prev;
                    }, 1200);
                }
            });
            wrapper.appendChild(btn);
        }
    }
}

function escapeSystemReminderTags(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/<system-reminder\b[^>]*>/gi, '&lt;system-reminder&gt;')
        .replace(/<\/system-reminder>/gi, '&lt;/system-reminder&gt;')
        .replace(/\r\n/g, '\n');
}

function isCopilotProvider(providerId) {
    if (!providerId || typeof providerId !== 'string') return false;
    return providerId.toLowerCase().includes('copilot');
}

function parseSpeedMultiplier(value) {
    if (!value || typeof value !== 'string') return Number.POSITIVE_INFINITY;
    const normalized = value.trim().toLowerCase().replace(/x$/, '');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function normalizeBlockMath(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\\\[(.*?)\\\]/gs, (match, inner) => {
        return `\n\n\\[${inner}\\]\n\n`;
    });
}

function normalizeInlineMath(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\$([^$\n]*?)\$/g, (match, inner) => {
        const hasLatex = /\\[a-zA-Z]+|\^|_/.test(inner);
        if (!hasLatex) return match;
        const trimmed = inner.trim();
        return `$${trimmed}$`;
    });
}

function normalizeLists(text) {
    const lines = String(text || '').split('\n');
    let inFence = false;

    const isFence = (line) => /^\s*```/.test(line) || /^\s*~~~/.test(line);
    const isOrdered = (line) => /^\s*\d+[.)]\s+/.test(line);
    const isHeading = (line) => /^\s*#{1,6}\s+/.test(line);
    const isHr = (line) => /^\s*(\*\s*){3,}$/.test(line)
        || /^\s*(-\s*){3,}$/.test(line)
        || /^\s*(_\s*){3,}$/.test(line);
    const isBlank = (line) => /^\s*$/.test(line);
    const isUnindentedBullet = (line) => /^[-+*]\s+/.test(line);

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isFence(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence || !isOrdered(line)) continue;

        let j = i + 1;
        let touched = false;
        while (j < lines.length) {
            const next = lines[j];
            if (isFence(next) || isBlank(next) || isHeading(next) || isHr(next) || isOrdered(next)) break;
            if (isUnindentedBullet(next)) {
                lines[j] = `    ${next}`;
                touched = true;
                j += 1;
                continue;
            }
            break;
        }
        if (touched) {
            i = j - 1;
        }
    }

    return lines.join('\n');
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="13 6 19 12 13 18" />
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
    const attachmentBtn = document.getElementById('attachment-btn');
    const sessionTitle = document.getElementById('session-title');
    const undoStatusEl = document.getElementById('undo-status');
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

    function updateUndoStatusDisplay(sessionId) {
        if (!undoStatusEl) return;
        const session = getSessionState(sessionId, false);
        const enabled = session?.undoAvailable !== false;
        if (enabled) {
            undoStatusEl.classList.add('hidden');
        } else {
            undoStatusEl.classList.remove('hidden');
        }
    }

    function isImageAttachment(item) {
        const mime = typeof item?.mime === 'string' ? item.mime : '';
        if (mime.startsWith('image/')) return true;
        const name = typeof item?.name === 'string' ? item.name : '';
        const lower = name.toLowerCase();
        return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic)$/.test(lower);
    }

    function renderNestedMessageElement(message) {
        const messageType = message.role === 'assistant'
            ? 'bot'
            : message.role === 'user'
                ? 'user'
                : message.role;

        const div = document.createElement('div');
        const isUser = messageType === 'user';
        const isSystem = messageType === 'system' || messageType === 'tool';
        div.className = `message ${isUser ? 'user' : isSystem ? 'system' : 'bot'} nested-message`;
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
            const rawText = message.text || '';
            const trimmedText = isUser ? rawText.replace(/^(\r?\n)+/, '') : rawText;
            content.textContent = trimmedText;
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

        return div;
    }

function renderMessageElement(message, renderedSet) {
    if (renderedSet.has(message.id)) {
        console.warn('[Render] duplicate message skipped', message.id);
        return;
    }
    renderedSet.add(message.id);

        if (message.meta?.kind === 'changeList') {
            const files = Array.isArray(message.meta?.files) ? message.meta.files : [];
            if (!files.length) return;
            const commitHead = typeof message.meta?.commitHead === 'string' ? message.meta.commitHead : undefined;
            const commitBase = typeof message.meta?.commitBase === 'string' ? message.meta.commitBase : undefined;
            const statsByPath = message.meta?.statsByPath && typeof message.meta.statsByPath === 'object'
                ? message.meta.statsByPath
                : {};

        const container = document.createElement('div');
        container.className = 'conflict-card change-list-card';
        container.style.textAlign = 'left';
        container.dataset.messageId = message.id;

        const header = document.createElement('div');
        header.className = 'conflict-card-header';
        header.textContent = `Changed files (${files.length})`;
        container.appendChild(header);

        if (message.meta?.reverted === true) {
            const revertedNotice = document.createElement('div');
            revertedNotice.className = 'change-list-reverted';
            revertedNotice.textContent = 'Changes reverted by Undo.';
            container.appendChild(revertedNotice);
        }

        const list = document.createElement('div');
        list.className = 'conflict-card-list';

        for (const rawPath of files) {
            if (typeof rawPath !== 'string' || !rawPath.length) continue;
            const normalized = rawPath.replace(/\\/g, '/');
            const parts = normalized.split('/');
            const base = parts.pop() || normalized;
            const dir = parts.length ? `${parts.join('/')}/` : '';

            const details = document.createElement('details');
            details.className = 'conflict-card-item';

            const summary = document.createElement('summary');
            summary.style.textAlign = 'left';
            summary.addEventListener('click', () => postOpenGitDiff(normalized, activeSessionId, commitHead, commitBase));

            const dirSpan = document.createElement('span');
            dirSpan.className = 'conflict-card-path';
            dirSpan.textContent = dir;

            const baseSpan = document.createElement('span');
            baseSpan.className = 'conflict-card-file';
            baseSpan.textContent = base;

            const stats = statsByPath[normalized];
            const showStats = stats && (Number.isFinite(stats.additions) || Number.isFinite(stats.deletions));
            let statsWrap = null;
            if (showStats) {
                statsWrap = document.createElement('span');
                statsWrap.className = 'change-list-stats';

                if (Number.isFinite(stats.additions)) {
                    const addSpan = document.createElement('span');
                    addSpan.className = 'change-list-add';
                    addSpan.textContent = `+${stats.additions}`;
                    statsWrap.appendChild(addSpan);
                }

                if (Number.isFinite(stats.deletions)) {
                    if (statsWrap.childNodes.length) {
                        const sep = document.createElement('span');
                        sep.className = 'change-list-sep';
                        sep.textContent = ' | ';
                        statsWrap.appendChild(sep);
                    }
                    const delSpan = document.createElement('span');
                    delSpan.className = 'change-list-del';
                    delSpan.textContent = `-${stats.deletions}`;
                    statsWrap.appendChild(delSpan);
                }
            }

            summary.appendChild(dirSpan);
            summary.appendChild(baseSpan);
            if (statsWrap) {
                summary.appendChild(statsWrap);
            }
            details.appendChild(summary);
            list.appendChild(details);
        }

        container.appendChild(list);
        chatContainer.appendChild(container);
        return;
    }

        if (message.meta?.kind === 'undoSegmentPlaceholder' || message.id.startsWith('system:undo-seg:')) {
            const session = getSessionOrNull(activeSessionId);
            const noticeKey = message.meta?.noticeKey || message.id.replace('system:undo-seg:', '');
            const segment = noticeKey ? session?.segmentsByNoticeKey?.get(noticeKey) : null;
            const memberMsgIds = segment?.memberMsgIds || [];
            const total = memberMsgIds.length;
            let available = 0;
            for (const id of memberMsgIds) {
                if (session?.messagesById?.has(id)) available++;
            }
            const restoreAllowed = segment?.restoreAllowed === true;
            const collapsed = segment?.collapsed !== false;

            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_RENDER]',
                    `noticeKey=${noticeKey || 'null'}`,
                    `total=${total}`,
                    `available=${available}`,
                    `restoreAllowed=${restoreAllowed}`,
                    `collapsed=${collapsed}`]
            });

            const div = document.createElement('div');
            div.className = 'message system undo-segment-placeholder';
            div.dataset.messageId = message.id;

            const content = document.createElement('div');
            content.className = 'message-content';

            const card = document.createElement('div');
            card.className = 'reverted-segment';

            const header = document.createElement('div');
            header.className = 'reverted-segment-header';

            const title = document.createElement('div');
            title.className = 'reverted-segment-title';
            title.textContent = `Reverted segment (${total} messages)`;

            const actions = document.createElement('div');
            actions.className = 'reverted-segment-actions';

            const restoreBtn = document.createElement('button');
            restoreBtn.type = 'button';
            restoreBtn.className = 'reverted-segment-btn primary';
            restoreBtn.textContent = 'Restore';
            restoreBtn.disabled = !restoreAllowed;
            restoreBtn.addEventListener('click', () => {
                if (!restoreAllowed) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_RESTORE_BLOCKED]', `noticeKey=${noticeKey || 'null'}`]
                    });
                    return;
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_RESTORE_CLICK]', `noticeKey=${noticeKey || 'null'}`]
                });
                handleRestoreSegment(activeSessionId, noticeKey);
            });
            actions.appendChild(restoreBtn);

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'reverted-segment-btn secondary';
            toggleBtn.textContent = collapsed ? 'Expand' : 'Collapse';
            toggleBtn.addEventListener('click', () => {
                if (!segment) return;
                segment.collapsed = !segment.collapsed;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_TOGGLE]', `noticeKey=${noticeKey || 'null'}`, `collapsed=${segment.collapsed}`]
                });
                window.__oc?.renderFromState?.();
            });
            actions.appendChild(toggleBtn);

            header.appendChild(title);
            header.appendChild(actions);
            card.appendChild(header);

            const ruleLine = document.createElement('div');
            ruleLine.className = restoreAllowed ? 'reverted-segment-hint' : 'reverted-segment-discarded';
            ruleLine.textContent = restoreAllowed
                ? 'You are allowed to restore this segment until the next build prompt.'
                : 'Segment discarded and unrestorable.';
            card.appendChild(ruleLine);

            if (available < total) {
                const warning = document.createElement('div');
                warning.className = 'reverted-segment-warning';
                warning.textContent = 'Some messages are no longer available.';
                card.appendChild(warning);
            }

            if (!collapsed && total > 0 && session) {
                const nestedWrap = document.createElement('div');
                nestedWrap.className = 'reverted-segment-body';
                for (const id of memberMsgIds) {
                    const msg = session.messagesById.get(id);
                    if (!msg) continue;
                    nestedWrap.appendChild(renderNestedMessageElement(msg));
                }
                card.appendChild(nestedWrap);
            }

            content.appendChild(card);
            div.appendChild(content);
            chatContainer.appendChild(div);
            return;
        }

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
            const raw = message.text || '';
            const sanitized = message.role === 'user' ? stripAttachmentManifest(raw) : raw;
            content.textContent = sanitized;
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
            if (!gitUndoEnabled) {
                div.appendChild(actions);
                chatContainer.appendChild(div);
                return;
            }
            const undoBtn = document.createElement('button');
            undoBtn.className = 'undo-btn';
            undoBtn.type = 'button';
            undoBtn.title = 'Undo to this message';
            undoBtn.textContent = '↺';
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
                discardAllSegments(sessionId, 'undo', selectedMode || 'unknown');
                handleUndoToMessage(sessionId, verdict.msgId);
                window.__oc?.renderFromState?.();
                logSessionState(sessionId, 'UI_UNDO_TO_MESSAGE');
            });
            actions.appendChild(undoBtn);
            div.appendChild(actions);
        }

        chatContainer.appendChild(div);
    }

    function stripAttachmentManifest(text) {
        if (!text) return text;
        const marker = '---\nAttachments (workspace files; read from disk; DO NOT use any URL):';
        const start = text.indexOf(marker);
        if (start === -1) return text;
        const end = text.indexOf('\n---', start + marker.length);
        if (end === -1) return text;
        const before = text.slice(0, start).trimEnd();
        const after = text.slice(end + '\n---'.length).trimStart();
        return [before, after].filter(Boolean).join('\n\n');
    }

    function renderSegmentElement(session, segment, renderedSet, renderKey) {
        const container = document.createElement('div');
        container.className = 'reverted-segment';
        if (renderKey) {
            container.dataset.segmentKey = renderKey;
        }
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
        const anchorMsgId = segment.anchorMsgId || segment.anchor?.msgId || '';
        const canRestore = segment.state === 'restorable' && !isBusy && Boolean(anchorMsgId);
        restoreBtn.disabled = !canRestore;
        restoreBtn.addEventListener('click', () => {
            if (!canRestore) {
                const segKey = segment.noticeKey ?? segment.id ?? '';
                const noticeKey = typeof segKey === 'string' && segKey.startsWith('seg:') ? segKey.slice(4) : segKey;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['restore.blocked', `noticeKey=${noticeKey || 'null'}`, `state=${segment.state}`]
                });
                return;
            }
            const segKey = segment.noticeKey ?? segment.id ?? '';
            const noticeKey = typeof segKey === 'string' && segKey.startsWith('seg:') ? segKey.slice(4) : segKey;
            vscode.postMessage({
                type: 'restoreSegment',
                sessionId: activeSessionId,
                noticeKey: noticeKey,
                anchorMsgId: anchorMsgId,
                endMsgId: segment.endMsgId
            });
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
        } else if (segment.state === 'discarded') {
            const discarded = document.createElement('div');
            discarded.className = 'reverted-segment-discarded';
            discarded.textContent = 'Segment discarded. Cannot restore.';
            container.appendChild(discarded);
        } else {
            const hint = document.createElement('div');
            hint.className = 'reverted-segment-hint';
            hint.textContent = anchorMsgId
                ? 'You are allowed to restore this segment until the next build prompt.'
                : 'Restore unavailable after reload (missing anchor id).';
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
                    const rawText = msg.text || '';
                    const trimmedText = isUser ? rawText.replace(/^(\r?\n)+/, '') : rawText;
                    content.textContent = trimmedText;
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
        // Removed: pendingSegments no longer used in new system
        pendingEl.classList.add('hidden');
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
        const segments = Array.from(session.segmentsByNoticeKey.values());
        const derivedHiddenSet = session.hiddenSet; // Already computed by rebuildHiddenSetFromTimeline

        vscode.postMessage({
            type: 'ui-debug',
            payload: ['renderFromState',
                'hiddenSetSize', derivedHiddenSet.size,
                'segmentsCount', segments.length,
                'timelineSize', timeline.length]
        });

        const renderedSet = new Set();
        const segmentByNoticeKey = session.segmentsByNoticeKey; // Use existing map
        const renderKeys = [];

        for (const id of timeline) {
            const msg = session.messagesById.get(id);
            if (!msg) continue;

            if (id.startsWith('system:undo:')) {
                const segment = segmentByNoticeKey.get(id);
                if (segment) {
                    renderSegmentElement(session, segment, renderedSet, id);
                    renderKeys.push(id);
                } else if (!derivedHiddenSet.has(id)) {
                    renderMessageElement(msg, renderedSet);
                    renderKeys.push(id);
                }
                continue;
            }

            if (derivedHiddenSet.has(id)) continue;
            renderMessageElement(msg, renderedSet);
            renderKeys.push(id);
        }

        if (lastConflictPayload && lastConflictPayload.sessionId === activeSessionId) {
            renderConflictCard(lastConflictPayload);
        }

        const notice = activeSessionId ? agentTimeoutNoticeBySession.get(activeSessionId) : null;
        if (notice) {
            const div = document.createElement('div');
            div.className = 'message system';
            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = notice;
            div.appendChild(content);
            chatContainer.appendChild(div);
        }

        enhanceCodeBlocksWithCopyButtons(chatContainer);

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

        const timelineKeys = timeline.slice();
        const domKeys = Array.from(chatContainer.children).map((el) => {
            const key = el?.dataset?.messageId || el?.dataset?.segmentKey || '';
            return key;
        }).filter(Boolean);
        const noticeKey = timelineKeys.find((k) => typeof k === 'string' && (k.startsWith('system:undo:') || k.startsWith('seg:system:undo:')));
        const timelineFirst10 = formatList(timelineKeys.slice(0, 10));
        const timelineLast10 = formatList(timelineKeys.slice(-10));
        const rootsFirst10 = formatList(renderKeys.slice(0, 10));
        const rootsLast10 = formatList(renderKeys.slice(-10));
        const domFirst10 = formatList(domKeys.slice(0, 10));
        const domLast10 = formatList(domKeys.slice(-10));

        // vscode.postMessage({
        //     type: 'ui-debug',
        //     payload: ['[WV][ORDER_TIMELINE]', `size=${timelineKeys.length}`, `first10=${timelineFirst10}`, `last10=${timelineLast10}`]
        // });
        // vscode.postMessage({
        //     type: 'ui-debug',
        //     payload: ['[WV][ORDER_ROOTS]', `size=${renderKeys.length}`, `first10=${rootsFirst10}`, `last10=${rootsLast10}`]
        // });
        // vscode.postMessage({
        //     type: 'ui-debug',
        //     payload: ['[WV][ORDER_DOM]', `size=${domKeys.length}`, `first10=${domFirst10}`, `last10=${domLast10}`]
        // });
        if (noticeKey) {
            const idxTimeline = timelineKeys.indexOf(noticeKey);
            const idxRoots = renderKeys.indexOf(noticeKey);
            const idxDom = domKeys.indexOf(noticeKey);
            const element = Array.from(chatContainer.children).find((el) => (el?.dataset?.messageId || el?.dataset?.segmentKey) === noticeKey);
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][ORDER_IDX]', `key=${noticeKey}`, `idxTimeline=${idxTimeline}`, `idxRoots=${idxRoots}`, `idxDom=${idxDom}`]
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][ORDER_CONTAINER]', `key=${noticeKey}`, `containerId=${element?.parentElement?.id || 'null'}`, `containerClass=${element?.parentElement?.className || 'null'}`]
            });
        }

        const containerStyle = window.getComputedStyle(chatContainer);
        if (containerStyle.display === 'flex' && containerStyle.flexDirection.includes('reverse')) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][CSS_ORDER_SUSPECT]', `selector=#chat-container`, `property=flex-direction:${containerStyle.flexDirection}`]
            });
        }
        const orderedChild = Array.from(chatContainer.children).find((el) => window.getComputedStyle(el).order && window.getComputedStyle(el).order !== '0');
        if (orderedChild) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][CSS_ORDER_SUSPECT]', `selector=${orderedChild.className || 'child'}`, `property=order:${window.getComputedStyle(orderedChild).order}`]
            });
        }
    }

    window.__oc = window.__oc || {};
    window.__oc.renderFromState = renderFromState;

    function renderModelSelect() {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][RENDER_MODELS]', `count=${models.length}`, `selected=${selectedModel || 'none'}`]
        });
        
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

        for (const provider of providerOrder) {
            if (!isCopilotProvider(provider)) continue;
            const items = grouped.get(provider) || [];
            items.sort((a, b) => {
                const aSpeed = parseSpeedMultiplier(a.speedMultiplier);
                const bSpeed = parseSpeedMultiplier(b.speedMultiplier);
                if (aSpeed !== bSpeed) return aSpeed - bSpeed;
                const aName = String(a.name || a.fullId || '').toLowerCase();
                const bName = String(b.name || b.fullId || '').toLowerCase();
                if (aName < bName) return -1;
                if (aName > bName) return 1;
                return 0;
            });
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
                const optionLabel = document.createElement('span');
                optionLabel.className = 'model-option-label';
                optionLabel.textContent = model.name || model.fullId;
                option.appendChild(optionLabel);
                const speed = model.speedMultiplier;
                if (isCopilotProvider(provider) && typeof speed === 'string' && speed.length) {
                    const speedLabel = document.createElement('span');
                    speedLabel.className = 'model-option-speed';
                    speedLabel.textContent = speed;
                    option.appendChild(speedLabel);
                }
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
        const model = models.find(m => m.fullId === selectedModel);
        const variants = model?.variants || [];
        const variantKeys = Array.isArray(variants) ? variants : Object.keys(variants);
        
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][UPDATE_VARIANTS]', 
                `model=${selectedModel}`, 
                `count=${variantKeys.length}`,
                `keys=${variantKeys.join(',') || 'none'}`]
        });
        
        variantSelect.innerHTML = '';
        const selected = models.find((item) => item.fullId === selectedModel);
        const variantsData = selected?.variants || [];
        
        // Hide variant dropdown if no variants available
        const variantWrapper = variantSelect.parentElement;
        
        if (!variantsData.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'default';
            option.selected = true;
            variantSelect.appendChild(option);
            variantSelect.disabled = true;
            selectedVariant = '';
            vscode.postMessage({ type: 'setVariant', value: selectedVariant });
            
            // Hide the entire variant wrapper
            if (variantWrapper) {
                variantWrapper.style.display = 'none';
            }
            
            renderVariantSelect();
            return;
        }

        // Show variant wrapper if variants exist
        if (variantWrapper) {
            variantWrapper.style.display = '';
        }

        variantSelect.disabled = false;
        if (!variantsData.includes(selectedVariant)) {
            selectedVariant = variantsData[0] || '';
            vscode.postMessage({ type: 'setVariant', value: selectedVariant });
        }

        for (const variant of variantsData) {
            const option = document.createElement('option');
            option.value = variant;
            option.textContent = `${variant}`;
            if (variant === selectedVariant) {
                option.selected = true;
            }
            variantSelect.appendChild(option);
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
        const imageItems = attachments.filter((item) => {
            const name = typeof item?.name === 'string' ? item.name : '';
            const mime = typeof item?.mime === 'string' ? item.mime : '';
            return mime.startsWith('image/') || name.startsWith('img-');
        });
        const totalImages = imageItems.length;
        let imageIndex = 0;

        for (const item of attachments) {
            const name = typeof item?.name === 'string' ? item.name : '';
            const mime = typeof item?.mime === 'string' ? item.mime : '';
            const isImage = mime.startsWith('image/') || name.startsWith('img-');

            if (isImage) {
                imageIndex += 1;
                const label = totalImages > 1 ? `image${imageIndex}` : 'image';
                const entry = document.createElement('div');
                entry.className = 'attachment-image-item';

                const thumb = document.createElement('img');
                thumb.className = 'attachment-image-thumb';
                thumb.alt = label;
                if (typeof item?.dataUrl === 'string' && item.dataUrl) {
                    thumb.src = item.dataUrl;
                }

                const text = document.createElement('span');
                text.className = 'attachment-image-label';
                text.textContent = label;

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'attachment-image-remove';
                removeBtn.textContent = '×';
                removeBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const idx = attachments.findIndex((entryItem) => entryItem.id === item.id);
                    if (idx >= 0) {
                        attachments.splice(idx, 1);
                        renderAttachments();
                    }
                });

                entry.appendChild(thumb);
                entry.appendChild(text);
                entry.appendChild(removeBtn);
                attachmentList.appendChild(entry);
                continue;
            }

            const entry = document.createElement('div');
            entry.className = 'attachment-image-item attachment-file-item';

            const icon = document.createElement('span');
            icon.className = 'attachment-file-icon';
            icon.textContent = '📄';

            const text = document.createElement('span');
            text.className = 'attachment-image-label';
            text.textContent = name || 'Attachment';

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'attachment-image-remove';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const idx = attachments.findIndex((entryItem) => entryItem.id === item.id);
                if (idx >= 0) {
                    attachments.splice(idx, 1);
                    renderAttachments();
                }
            });

            entry.appendChild(icon);
            entry.appendChild(text);
            entry.appendChild(removeBtn);
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
    session.cancelledTurn = false;
    session.canceledActiveTurn = false;
    session.activeTurnOpId = payload.opId || null;
    const displayText = payload.text || 'Image attached.';
        const userMessage = upsertMessage(session, {
            id: payload.clientMessageId,
            role: 'user',
            text: displayText,
            meta: { clientId: payload.clientMessageId, images: payload.images || [] }
        });
        session.lastTurnUserId = payload.clientMessageId;
        if (payload.clientMessageId && payload.clientMessageId.startsWith('local-')) {
            vscode.postMessage({ type: 'registerPendingUserLocal', sessionId, localKey: payload.clientMessageId });
        }

    if (payload.mode === 'build' && !isBusy) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][FREEZE_DROP]', 'isBusy=false', 'wouldFreeze=true']
        });
    }

    session.currentTurnAssistantMsgId = null;
    session.currentTurnAssistantKey = null;

        if (!session.thinkingId) {
            const tempId = createTempAssistantId();
            const thinkingMsg = upsertMessage(session, {
                id: tempId,
                role: 'assistant',
                text: 'Thinking...',
                meta: { isThinking: true, parentClientMessageId: payload.clientMessageId }
            });
            session.thinkingId = thinkingMsg.id;
            session.currentTurnAssistantKey = thinkingMsg.id;
            session.lastTurnAssistantId = thinkingMsg.id;
        }

        assertInvariants(sessionId, 'sendPrompt');
        startAgentTimeout(sessionId, payload.opId || null);
    }

    function handleAssistantMeta(sessionId, message) {
        const session = getSessionState(sessionId, true);
        const backendId = getEventMessageId(message);
    const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;
    if (msgId) {
        session.currentTurnAssistantMsgId = msgId;
    }
        if (!msgId && !session.thinkingId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'drop-no-backendId-no-thinking'] });
            return;
        }

        if (message?.clientMessageId && backendId) {
            registerMessageIdMapping(session, message.clientMessageId, backendId, 'assistantMessageMeta');
        }

        if ((typeof message?.tmpKey === 'string') && (message.tmpKey.startsWith('tmp:') || message.tmpKey.startsWith('local-')) && (typeof msgId === 'string') && msgId.startsWith('msg_')) {
            session.pendingAssistantUpgrade = {
                tmpKey: message.tmpKey,
                assistantMsgId: msgId,
                source: 'assistantMessageMeta',
                ts: Date.now()
            };
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_PENDING_UPGRADE_SET]', 'sessionId', sessionId, 'tmpKey', message.tmpKey, 'assistantMsgId', msgId, 'source', 'assistantMessageMeta']
            });
        }

        attemptAssistantUpgrade(sessionId, message, 'assistantMessageMeta');

        let targetId = session.currentTurnAssistantKey || session.thinkingId;

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
            const normalized = typeof nextText === 'string' ? nextText.trim() : '';
            const hasStatusChange = normalized.length > 0 && normalized !== 'Thinking...';
            if (hasStatusChange) {
                clearAgentTimeout(sessionId, 'assistantMeta-status-change');
            }
            target.text = nextText;
            target.meta = { ...target.meta, internalId: backendId, isThinking: true };
            vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'merged', targetId] });
        }

        assertInvariants(sessionId, 'assistantMeta');
    }

    function handleChatChunk(sessionId, message) {
        const session = getSessionState(sessionId, true);
        clearAgentTimeout(sessionId, 'chatChunk');
        const backendId = getEventMessageId(message);
        const chunkText = getEventChunkText(message);

    const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;
    if (msgId) {
        session.currentTurnAssistantMsgId = msgId;
    }

        if ((typeof message?.tmpKey === 'string') && (message.tmpKey.startsWith('tmp:') || message.tmpKey.startsWith('local-')) && (typeof msgId === 'string') && msgId.startsWith('msg_')) {
            session.pendingAssistantUpgrade = {
                tmpKey: message.tmpKey,
                assistantMsgId: msgId,
                source: 'chatChunk',
                ts: Date.now()
            };
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_PENDING_UPGRADE_SET]', 'sessionId', sessionId, 'tmpKey', message.tmpKey, 'assistantMsgId', msgId, 'source', 'chatChunk']
            });
        }

        if (msgId) {
            attemptAssistantUpgrade(sessionId, message, 'chatChunk');
        }

        let targetId = session.currentTurnAssistantKey || session.thinkingId;

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

    function handleChatDone(sessionId, message) {
        const session = getSessionState(sessionId);
        if (!session) return;
        clearAgentTimeout(sessionId, 'chatDone');
    if (session.thinkingId && session.messagesById.has(session.thinkingId)) {
        const msg = session.messagesById.get(session.thinkingId);
        msg.meta.isThinking = false;
            if (msg.text === 'Thinking...') {
                msg.text = '';
            }
        session.thinkingId = null;
        console.log('[Thinking] chatDone cleared pending');
    }
    const resolvedFinal =
        message?.lastAssistantMsgId ||
        message?.assistantMsgId ||
        message?.endMsgId ||
        message?.endMessageId ||
        null;

    let replaced = false;
    if (resolvedFinal && typeof resolvedFinal === 'string') {
        const beforeKey = session.currentTurnAssistantKey;
        attemptAssistantUpgrade(sessionId, { assistantMsgId: resolvedFinal }, 'chatDone');
        replaced = beforeKey !== session.currentTurnAssistantKey && session.currentTurnAssistantKey === resolvedFinal;
    }

    const match = Boolean(resolvedFinal && session.currentTurnAssistantKey === resolvedFinal);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['CHATDONE_FINAL', `curKey=${session.currentTurnAssistantKey || 'null'}`, `resolvedFinal=${resolvedFinal || 'null'}`,
            `match=${match}`, `replaced=${replaced}`]
    });

    session.currentTurnAssistantMsgId = null;
    session.currentTurnAssistantKey = null;
    assertInvariants(sessionId, 'chatDone');
}

    sendButtonEl = sendBtn;
    inputEl = input;
    setSendEnabled(!gitUndoEnabled || baselineReady);

    if (attachmentBtn) {
        attachmentBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'selectAttachments', sessionId: activeSessionId || undefined });
        });
    }

    sendBtn.addEventListener('click', () => {
        if (isBusy) {
            if (activeSessionId) {
                clearAgentTimeout(activeSessionId, 'cancel', true);
                cancelLocalTurn(activeSessionId);
            }
            const activeOpId = activeSessionId ? getSessionState(activeSessionId)?.activeTurnOpId || null : null;
            vscode.postMessage({ type: 'cancel', sessionId: activeSessionId || undefined, opId: activeOpId || undefined });
            return;
        }
        logSegmentState(activeSessionId, 'before-turn');
        const turnSession = getSessionState(activeSessionId);
        const turnSegments = turnSession ? Array.from(turnSession.segmentsByNoticeKey.values()) : [];
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEG_STATE_BEFORE_TURN]', `segmentCount=${turnSegments.length}`, `hiddenCount=${turnSession?.hiddenSet.size || 0}`]
        });
        const willFreezeSegments = selectedMode === 'build';
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][TURN_START]', `isBusy=${isBusy}`, `willFreezeSegments=${willFreezeSegments}`]
        });
        // applyTurnStartFreeze removed - segments no longer have freeze state
        const text = input.value.trim();
        if ((!text && !attachments.length) || isBusy) return;

        const hasNonImage = attachments.some((item) => !isImageAttachment(item));
        const fallbackText = hasNonImage ? 'Attachment added.' : 'Image attached.';
        const messageText = text || fallbackText;
        const clientMessageId = `local-${Date.now()}-${messageCounter++}`;
        const opId = `op-${Date.now()}-${messageCounter}`;
        const messageImages = attachments
            .map((item) => item.dataUrl)
            .filter((value) => typeof value === 'string' && value.length > 0);
        const attachmentsPayload = attachments.map((item) => {
            const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl : '';
            const commaIndex = dataUrl.indexOf(',');
            const dataBase64 = (dataUrl && dataUrl.startsWith('data:') && commaIndex !== -1)
                ? dataUrl.slice(commaIndex + 1)
                : undefined;
            return {
                filename: typeof item?.name === 'string' ? item.name : undefined,
                mime: typeof item?.mime === 'string' ? item.mime : undefined,
                dataBase64,
                tempPath: typeof item?.filePath === 'string' ? item.filePath : undefined
            };
        });

        setBusy(true);
        if (!activeSessionId) {
            isSwitchingSession = true;
            pendingUiPrompts.push({
                text: messageText,
                clientMessageId,
                opId,
                mode: selectedMode,
                images: messageImages
            });
        } else {
            applyPromptToSession(activeSessionId, {
                text: messageText,
                clientMessageId,
                opId,
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

        const tmpKey = activeSessionId ? getSessionState(activeSessionId)?.thinkingId || null : null;
        const mode = selectedMode || 'unknown';
        const isBuild = mode === 'build';
        const segCount = activeSessionId ? (getSessionState(activeSessionId)?.segmentsByNoticeKey?.size ?? 0) : 0;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEND_MODE]', `mode=${mode}`, `isBuild=${isBuild}`, `segmentsCount=${segCount}`, `sessionId=${activeSessionId || 'null'}`]
        });
        if (activeSessionId && isBuild) {
            discardAllSegments(activeSessionId, 'buildPrompt', mode);
        } else if (activeSessionId) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_DISCARD_SKIP]', `reason=not-build`, `mode=${mode}`, `sessionId=${activeSessionId || 'null'}`]
            });
        }
        vscode.postMessage({ type: 'sendMessage', value: messageText, attachments: attachmentsPayload, clientMessageId, sessionId: activeSessionId || undefined, tmpKey, opId });
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
        if (activeSessionId) {
            clearAgentTimeout(activeSessionId, 'modelChange', true);
        }
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
            payload: ['WV', 'recv', 'type', message.type || 'null', 'sessionId', message.sessionId || message.sessionID || 'null', 'hasMessages', Array.isArray(message.messages), 'messagesLen', message.messages?.length ?? 0, 'hasSegments', Array.isArray(message.segments), 'segmentsLen', message.segments?.length ?? 0]
        });

        switch (message.type) {
            case 'gitUndoAvailability': {
                gitUndoEnabled = Boolean(message.enabled);
                gitUndoReason = typeof message.reason === 'string' ? message.reason : null;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['gitUndoAvailability', 'enabled', String(gitUndoEnabled), 'reason', gitUndoReason || 'null']
                });
                window.__oc?.renderFromState?.();
                break;
            }
            case 'baselineStatus': {
                baselineReady = Boolean(message.ready);
                baselineMessage = typeof message.message === 'string' ? message.message : null;
                setSendEnabled(true);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['baselineStatus', 'ready', String(baselineReady), 'message', baselineMessage || 'null']
                });
                break;
            }
            case 'init': {
                const incomingSessionId = message.currentSessionId || '';
                const hydrated = Boolean(activeSessionId && incomingSessionId && activeSessionId === incomingSessionId && hydratedSessions.has(activeSessionId));
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][INIT_RX]', `sessionId=${incomingSessionId || 'null'}`, `currentSessionId=${activeSessionId || 'null'}`, `hydrated=${hydrated}`, `willReset=${!hydrated}`]
                });
                logSegmentState(activeSessionId, 'before-init');
                models = Array.isArray(message.models) ? message.models : [];
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                selectedModel = message.selectedModel || (models[0] ? models[0].fullId : '');
                selectedVariant = message.selectedVariant || '';
                selectedMode = message.selectedMode || 'build';
                
                // Check for empty models and show error
                if (models.length === 0) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][INIT_ERROR]', 'no-models-available']
                    });
                    sendBtn.disabled = true;
                    sendBtn.title = 'No models available';
                    
                    // Show error in chat
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'message system error';
                    errorDiv.style.color = 'red';
                    errorDiv.textContent = 'Error: No models available. Please check your OpenCode configuration.';
                    chatContainer.appendChild(errorDiv);
                } else {
                    sendBtn.disabled = false;
                    sendBtn.title = '';
                }
                
                if (!hydrated) {
                    activeSessionId = incomingSessionId || activeSessionId || '';
                }
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                renderModelSelect();
                renderModeSelect();
                updateVariantOptions();
                renderSessionList();
                if (!hydrated) {
                    window.__oc?.renderFromState?.();
                }
                logSegmentState(activeSessionId, 'after-init');
                vscode.postMessage({ type: 'ui-debug', payload: ['webview', 'ready', Date.now()] });
                break;
            }
            case 'resetUiState': {
                const incomingSessionId = message.sessionId || message.sessionID || '';
                const hydrated = Boolean(activeSessionId && incomingSessionId && activeSessionId === incomingSessionId && hydratedSessions.has(activeSessionId));
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][RESET_RX]', `sessionId=${incomingSessionId || 'null'}`, `currentSessionId=${activeSessionId || 'null'}`, `hydrated=${hydrated}`, `willReset=${!hydrated}`]
                });
                logSegmentState(activeSessionId, 'before-reset');
                if (hydrated) {
                    logSegmentState(activeSessionId, 'after-reset');
                    break;
                }
                activeSessionId = incomingSessionId || activeSessionId || '';
                window.__oc?.renderFromState?.();
                logSegmentState(activeSessionId, 'after-reset');
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
                        payload: ['[WV][SESSIONDATA_DROP]', 'missing-sessionId']
                    });
                    break;
                }

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SESSIONDATA_ENTER]', 
                        `sessionId=${sessionId}`, 
                        `messagesLen=${message.messages?.length ?? 0}`, 
                        `segmentsLen=${message.segments?.length ?? 0}`]
                });

                try {
                    activeSessionId = sessionId;
                    sessionTitle.textContent = message.title || 'OpenCode: Chat';
                    updateUndoStatusDisplay(sessionId);
                    
                    const session = getSessionState(sessionId, true);
                    
                    const hasSegments = Array.isArray(message.segments);
                    // Clear everything
                    session.messagesById.clear();
                    session.timeline = [];
                    if (hasSegments) {
                        session.segmentsByNoticeKey.clear();
                        session.hiddenSet.clear();
                    }
                    session.thinkingId = null;
                    session.nextOrder = 0;
                    
                    // Load messages into timeline
                    const sessionMessages = Array.isArray(message.messages) ? message.messages : [];
                    for (const item of sessionMessages) {
                        if (!item || !item.id) continue;
                        
                        const key = item.id;
                        if (typeof key !== 'string') continue;
                        
                        let role = item.role;
                        if (!role) {
                            if (key.startsWith('msg_')) {
                                role = 'assistant';
                            } else if (key.startsWith('system:')) {
                                role = 'system';
                            } else {
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][SESSIONDATA_WARN]', 'missing-role', `id=${key}`]
                                });
                                continue;
                            }
                        }
                        
                        const rawText = item.text || '';
                        const cleanedText = role === 'user'
                            ? rawText.replace(/^(\r?\n)+/, '')
                            : rawText;
                        upsertMessage(session, {
                            id: key,
                            role: role,
                            text: cleanedText,
                            meta: item.meta || {},
                            order: session.nextOrder++
                        });
                    }
                    
                    // Snapshot notice if needed
                    if (message.meta?.source === 'snapshot') {
                        const noticeId = `system:snapshot:${Date.now()}`;
                        upsertMessage(session, {
                            id: noticeId,
                            role: 'system',
                            text: 'Session loaded from local snapshot because opencode export failed. This view may be stale.',
                            meta: { kind: 'snapshotNotice' }
                        });
                        if (!session.timeline.includes(noticeId)) {
                            session.timeline.unshift(noticeId);
                        }
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SNAPSHOT_MODE]', `sessionId=${sessionId}`]
                        });
                    }
                    
                    // Apply hydrated segments (this calls rebuildHiddenSetFromTimeline)
                    const segments = Array.isArray(message.segments) ? message.segments : [];
                    if (hasSegments) {
                        applyHydratedSegments(session, segments, true);
                    } else {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SEG_HYDRATE_SKIP]', 'reason=no-hasSegments', `before=${session.segmentsByNoticeKey.size}`]
                        });
                        rebuildHiddenSetFromTimeline(session);
                    }

                    // Rebuild placeholders for hydrated segments
                    const msgOnlyTimeline = session.timeline.filter((id) => typeof id === 'string' && id.startsWith('msg_'));
                    let inserted = 0;
                    let skipped = 0;
                    for (const seg of session.segmentsByNoticeKey.values()) {
                        const noticeKey = seg.noticeKey;
                        if (!noticeKey) {
                            skipped++;
                            continue;
                        }
                        if (!seg.anchorMsgId || !msgOnlyTimeline.includes(seg.anchorMsgId)) {
                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['[WV][HYDRATE_SEG_SKIP]', 'reason=missing-anchor', `noticeKey=${noticeKey}`]
                            });
                            skipped++;
                            continue;
                        }
                        let anchorIdx = session.timeline.indexOf(seg.anchorMsgId);
                        if (anchorIdx === -1) {
                            for (let i = 0; i < session.timeline.length; i++) {
                                const id = session.timeline[i];
                                if (id === seg.anchorMsgId) {
                                    anchorIdx = i;
                                    break;
                                }
                            }
                        }
                        if (anchorIdx === -1) {
                            skipped++;
                            continue;
                        }
                        const placeholderId = getUndoPlaceholderId(noticeKey);
                        if (!session.messagesById.has(placeholderId)) {
                            session.messagesById.set(placeholderId, {
                                id: placeholderId,
                                role: 'system',
                                text: '',
                                meta: {
                                    kind: 'undoSegmentPlaceholder',
                                    noticeKey,
                                    anchorMsgId: seg.anchorMsgId,
                                    endMsgId: seg.endMsgId,
                                    applied: seg.applied ?? null,
                                    createdAt: seg.createdAt || Date.now()
                                }
                            });
                        }
                        session.timeline[anchorIdx] = placeholderId;
                        inserted++;
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][HYDRATE_PLACEHOLDER_INSERT]', `noticeKey=${noticeKey}`, `anchorIdx=${anchorIdx}`]
                        });
                    }

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][HYDRATE_PLACEHOLDER_REBUILD]', `total=${session.segmentsByNoticeKey.size}`, `inserted=${inserted}`, `skipped=${skipped}`]
                    });

                    rebuildHiddenSetFromTimeline(session);
                    window.__oc?.renderFromState?.();
                    
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSION_LOADED]', 
                            `sessionId=${sessionId}`,
                            `messages=${session.timeline.length}`,
                            `segments=${session.segmentsByNoticeKey.size}`,
                            `hidden=${session.hiddenSet.size}`]
                    });
                    
                    hydratedSessions.add(sessionId);
                    scrollToBottom();
                    closeSessionPanel();
                    
                } catch (err) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSIONDATA_ERROR]', `sessionId=${sessionId}`, `err=${String(err)}`]
                    });
                } finally {
                    window.__oc?.renderFromState?.();
                }
                break;
            }
            case 'sessionLoadFailed': {
                const sessionId = message?.payload?.sessionId || message?.sessionId || '';
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                const noticeId = `system:session-load-failed:${Date.now()}`;
                upsertMessage(session, {
                    id: noticeId,
                    role: 'system',
                    text: 'Failed to load session from opencode and no snapshot exists.',
                    meta: { kind: 'sessionLoadFailed' }
                });
                if (!session.timeline.includes(noticeId)) {
                    session.timeline.unshift(noticeId);
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SESSION_LOAD_FAILED]', `sessionId=${sessionId}`, `reason=${message?.payload?.reason || 'unknown'}`, `stderrLastLine=${message?.payload?.stderrLastLine || 'null'}`]
                });
                window.__oc?.renderFromState?.();
                scrollToBottom();
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
                const payloadInternalKey = message?.clientMessageId;
                const payloadServerId = message?.messageId;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'messageIdMap', 'ignored',
                        'sessionId', sessionId || 'null',
                        'payloadInternalKey', payloadInternalKey || 'null',
                        'payloadServerId', payloadServerId || 'null']
                });
                break;
            }
            case 'messageIndexMap': {
                const sessionId = getEventSessionId(message, 'messageIndexMap');
                if (!sessionId) break;
                const session = getSessionState(sessionId);
                const map = Array.isArray(message.map) ? message.map : [];
                if (session) {
                    session.messageIndexMap = new Map();
                    for (const entry of map) {
                        if (entry?.messageId && typeof entry.messageIndex === 'number') {
                            session.messageIndexMap.set(entry.messageId, entry.messageIndex);
                        }
                    }
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[DBG_RECONCILE]', `messageIndexMap type=${typeof session.messageIndexMap}`, `hasType=${typeof session.messageIndexMap?.has}`, `isMap=${session.messageIndexMap instanceof Map}`]
                    });
                }
                const pending = session?.pendingAssistantUpgrade || null;
                const willTry = Boolean(
                    session &&
                    activeSessionId === sessionId &&
                    pending &&
                    session.messageIndexMap instanceof Map &&
                    session.messageIndexMap.size > 0
                );
                const mapHasKey = Boolean(pending?.assistantMsgId && session?.messageIndexMap?.has?.(pending.assistantMsgId));
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[DBG_PENDING_UPGRADE_TRY]', 'sessionId', sessionId, 'tmpKey', pending?.tmpKey || 'null', 'assistantMsgId', pending?.assistantMsgId || 'null', 'mapHasKey', mapHasKey, 'willTry', willTry]
                });
                if (willTry && pending) {
                    attemptAssistantUpgrade(sessionId, {
                        sessionId,
                        tmpKey: pending.tmpKey,
                        assistantMsgId: pending.assistantMsgId
                    }, 'messageIndexMap');
                    const didReplace = session.currentTurnAssistantKey === pending.assistantMsgId;
                    if (didReplace) {
                        session.pendingAssistantUpgrade = null;
                        vscode.postMessage({ type: 'ui-debug', payload: ['[DBG_PENDING_UPGRADE_CLEAR]', 'sessionId', sessionId] });
                    }
                }
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
                if (session) {
                    const storedSample = Array.from(session.messageIndexMap.entries()).slice(0, 3).map(([id, idx]) => `${id}:${idx}`);
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[DBG_RECONCILE]', `storedMap size=${session.messageIndexMap.size} first=[${storedSample.join(', ')}]`]
                    });
                }
                break;
            }
            case 'retryReconcile': {
                const sessionId = getEventSessionId(message, 'retryReconcile');
                if (!sessionId) break;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'retryReconcile', 'sessionId', sessionId, 'note', 'obsolete-no-op']
                });
                // Removed: reconcilePendingSegments - new system uses applyHydratedSegments
                break;
            }
            case 'assistantMessageMeta': {
                const sessionId = getEventSessionId(message, 'assistantMessageMeta');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                if (session?.canceledActiveTurn) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['assistantMessageMeta', 'drop-canceledActiveTurn', `sessionId=${sessionId}`]
                    });
                    break;
                }
                logIdCandidates('[DBG_META]', message, sessionId, activeSessionId);
                handleAssistantMeta(sessionId, message);
                // Removed: reconcilePendingSegments - new system uses applyHydratedSegments
                window.__oc?.renderFromState?.();
                scrollToBottom();
                logSessionState(sessionId, 'assistantMessageMeta');
                break;
            }
            case 'chatChunk': {
                const sessionId = getEventSessionId(message, 'chatChunk');
                if (!sessionId) break;
                const session = getSessionState(sessionId);
                if (session?.canceledActiveTurn) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['chatChunk', 'drop-canceledActiveTurn', `sessionId=${sessionId}`]
                    });
                    break;
                }
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
                if (session?.canceledActiveTurn) {
                    setBusy(false);
                    logSessionState(sessionId, 'chatDone.canceledActiveTurn');
                    break;
                }
                handleChatDone(sessionId, message);
                if (session) {
                    session.cancelledTurn = false;
                }
                window.__oc?.renderFromState?.();
                scrollToBottom();
                setBusy(false);
                logSessionState(sessionId, 'chatDone');
                break;
            }
            case 'restoreDraft': {
                const draft = message?.payload || {};
                if (typeof draft.text === 'string' && inputEl) {
                    inputEl.value = draft.text;
                }
                if (Array.isArray(draft.attachments)) {
                    attachments = draft.attachments.map((filePath) => ({ filePath }));
                    renderAttachments();
                }
                if (typeof draft.model === 'string') {
                    selectedModel = draft.model;
                    modelSelect.value = selectedModel;
                    updateVariantOptions();
                }
                if (typeof draft.variant === 'string') {
                    selectedVariant = draft.variant;
                    variantSelect.value = selectedVariant;
                }
                if (typeof draft.mode === 'string') {
                    selectedMode = draft.mode;
                    modeSelect.value = selectedMode;
                    applyModeStyles(selectedMode);
                    renderModeSelect();
                }
                setBusy(false);
                if (inputEl) {
                    inputEl.focus();
                }
                break;
            }
            case 'userMessageUpgrade': {
                const sessionId = message?.sessionId || message?.sessionID || '';
                if (!sessionId || sessionId !== activeSessionId) {
                    vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${message?.localKey || 'null'} msgId=${message?.userMsgId || 'null'} replaced=false reason=session-mismatch`] });
                    break;
                }
                const session = getSessionState(sessionId);
                if (!session) {
                    vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${message?.localKey || 'null'} msgId=${message?.userMsgId || 'null'} replaced=false reason=session-mismatch`] });
                    break;
                }
                if (session.canceledActiveTurn) {
                    vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', 'drop-cancelled', `localKey=${message?.localKey || 'null'}`, `msgId=${message?.userMsgId || 'null'}`] });
                    break;
                }
                const localKey = message?.localKey;
                const userMsgId = message?.userMsgId;
                const assistantMsgId = message?.assistantMsgId || null;
                const assistantMsgIdsAll = Array.isArray(message?.assistantMsgIdsAll) ? message.assistantMsgIdsAll : [];
                const chosenFinish = message?.chosenFinish || null;
                const chosenTimeCompleted = message?.chosenTimeCompleted ?? null;
                const chosenTimeCreated = message?.chosenTimeCreated ?? null;
                const awaitingAssistantIdFromExport = Boolean(message?.awaitingAssistantIdFromExport);

                let targetKey = null;
                if (typeof localKey === 'string' && localKey.length) {
                    targetKey = localKey;
                } else if (typeof userMsgId === 'string' && userMsgId.length) {
                    targetKey = userMsgId;
                }

                if (assistantMsgIdsAll.length || assistantMsgId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[DBG_EXPORT_BIND]', `userMsgId=${userMsgId || 'null'}`, `assistantMsgIdsAll=[${assistantMsgIdsAll.join(', ')}]`,
                            `chosen=${assistantMsgId || 'null'}`, `finish=${chosenFinish || 'null'}`, `completed=${chosenTimeCompleted ?? 'null'}`, `created=${chosenTimeCreated ?? 'null'}`]
                    });
                }

                if (!targetKey) {
                    vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', 'drop-no-target', `localKey=${localKey || 'null'}`, `userMsgId=${userMsgId || 'null'}`] });
                    if (awaitingAssistantIdFromExport) {
                        window.__oc?.renderFromState?.();
                    }
                    break;
                }

                const targetMsg = session.messagesById.get(targetKey);
                if (targetMsg && targetMsg.role === 'user') {
                    const prevAssistantId = targetMsg.meta?.assistantId || null;
                    if (assistantMsgId && prevAssistantId && prevAssistantId !== assistantMsgId) {
                        vscode.postMessage({ type: 'ui-debug', payload: ['assistantId.updated', `from=${prevAssistantId}`, `to=${assistantMsgId}`] });
                    }
                    targetMsg.meta = {
                        ...targetMsg.meta,
                        assistantId: assistantMsgId || prevAssistantId || null,
                        awaitingAssistantIdFromExport: awaitingAssistantIdFromExport || !assistantMsgId
                    };
                }

                if (typeof localKey === 'string' && localKey.length) {
                    const localMsg = session.messagesById.get(localKey);
                    if (!localMsg || !session.timeline.includes(localKey)) {
                        vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=missing-local`] });
                    } else if (localMsg.role !== 'user') {
                        vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=local-not-user`] });
                    } else {
                        const existing = session.messagesById.get(userMsgId);
                        if (existing && existing.role !== 'user') {
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=collision-nonuser`] });
                        } else {
                            replaceKeyEverywhere(localKey, userMsgId);
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=true reason=ok`] });
                            logTimelineSnapshot('user.upgrade', session.timeline, 'expectSize=2');
                            const counts = timelineCounts(session.timeline);
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade.accept', `timelineSize=${session.timeline.length} expect=2 counts msg=${counts.msg} tmp=${counts.tmp} local=${counts.local}`] });
                        }
                    }
                }

                if (assistantMsgId && session.pendingAssistantUpgrade?.tmpKey) {
                    session.pendingAssistantUpgrade.assistantMsgId = assistantMsgId;
                }
                
                // Also upgrade the assistant message if provided
                attemptAssistantUpgrade(sessionId, message, 'userMessageUpgrade');
                
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
                handleChatDone(sessionId, message);
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
            case 'diffFileList': {
                const sessionId = getEventSessionId(message, 'diffFileList');
                if (!sessionId) break;
                const files = Array.isArray(message.files)
                    ? message.files.filter((item) => typeof item === 'string' && item.length)
                    : [];
                if (!files.length) break;
                const commitHead = typeof message.commitHead === 'string' ? message.commitHead : '';
                const commitBase = typeof message.commitBase === 'string' ? message.commitBase : '';
                const changeListId = typeof message.changeListId === 'string' && message.changeListId.length
                    ? message.changeListId
                    : (commitHead ? `system:changeList:${commitHead}` : `changes:${Date.now()}`);
                const statsByPath = message.statsByPath && typeof message.statsByPath === 'object'
                    ? message.statsByPath
                    : {};
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
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
                        statsByPath
                    }
                });
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'changeListUpdate': {
                const sessionId = getEventSessionId(message, 'changeListUpdate');
                if (!sessionId) break;
                const commitHead = typeof message.commitHead === 'string' ? message.commitHead : '';
                if (!commitHead) break;
                const session = getSessionState(sessionId, true);
                let updated = false;
                for (const msg of session.messagesById.values()) {
                    if (msg?.meta?.kind === 'changeList' && msg.meta.commitHead === commitHead) {
                        msg.meta.reverted = message.reverted === true;
                        updated = true;
                    }
                }
                if (updated) {
                    window.__oc?.renderFromState?.();
                }
                break;
            }
            case 'messageAppend': {
                const sessionId = getEventSessionId(message, 'messageAppend');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                if (session?.canceledActiveTurn && message?.message?.id === session.lastTurnUserId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['messageAppend', 'drop-cancelled', `messageId=${message?.message?.id || 'null'}`]
                    });
                    break;
                }
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
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][REVERTED_CASE_ENTER]']
                });
                try {
                    const postRevertedReturn = (reason, sessionId, noticeKey, hasSeg, membersLen) => {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_RETURN]',
                                `reason=${reason}`,
                                `sessionId=${sessionId || 'null'}`,
                                `noticeKey=${noticeKey || 'null'}`,
                                `hasSeg=${hasSeg ? 'true' : 'false'}`,
                                `membersLen=${typeof membersLen === 'number' ? membersLen : 'null'}`]
                        });
                    };
                    let sessionId = message?.sessionId || message?.sessionID || '';
                    if (!sessionId) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_DROP]', 'no-sessionId', 'activeSessionId=null']
                        });
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_CASE_RETURN]', 'reason=no-sessionId']
                        });
                        postRevertedReturn('no-sessionId', sessionId, null, false, null);
                        break;
                    }
                    const segPayload = message.segment || message;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][REVERTED_RX]', `sessionId=${sessionId}`, `hasSegment=${!!segPayload}`, `anchorMsgId=${segPayload?.startMessageId || segPayload?.anchorMsgId || 'null'}`, `endMsgId=${segPayload?.endMessageId || segPayload?.endMsgId || 'null'}`]
                    });

                    const hasAnchor = Boolean(segPayload?.startMessageId || segPayload?.anchorMsgId);
                    const hasEnd = Boolean(segPayload?.endMessageId || segPayload?.endMsgId);
                    if (!hasAnchor && !hasEnd) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_DROP]', 'reason=missing-anchor-end']
                        });
                        break;
                    }

                    const session = getSessionState(sessionId);
                    if (!session) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_CASE_RETURN]', 'reason=missing-session']
                        });
                        postRevertedReturn('missing-session', sessionId, null, Boolean(segPayload), null);
                        break;
                    }
                    session.seenUndoAckOpIds = session.seenUndoAckOpIds || new Set();
                    session.pendingUndoByNoticeKey = session.pendingUndoByNoticeKey || new Map();
                    session.undoNoticeKeyByOpId = session.undoNoticeKeyByOpId || new Map();

                const ackOpId = segPayload?.operationId;
                const anchorForUpsert = segPayload?.startMessageId || segPayload?.anchorMsgId || null;
                const derivedNoticeKey = segPayload?.noticeKey
                    || (anchorForUpsert ? `system:undo:${anchorForUpsert}` : null)
                    || session.pendingUndo?.noticeKey
                    || session.lastUndoNoticeKey
                    || (ackOpId ? `system:undo:op:${ackOpId}` : `system:undo:unknown:${Date.now()}`);

                let mappedClientOpId = ackOpId;
                let found = false;

                if (derivedNoticeKey && session.pendingUndoByNoticeKey?.has(derivedNoticeKey)) {
                    const pending = session.pendingUndoByNoticeKey.get(derivedNoticeKey);
                    mappedClientOpId = pending.clientOpId;
                    found = true;

                    if (session.pendingUndo && session.pendingUndo.clientOpId === mappedClientOpId) {
                        session.pendingUndo.ackOpId = ackOpId;
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

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.ack', 'payloadType', 'revertedSegment', 'ackOpId', ackOpId || 'null', 'clientOpId', mappedClientOpId || 'null', 'sessionId', sessionId, 'noticeKey', derivedNoticeKey || 'null']
                });

                    if (!session.pendingUndo) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][REVERTED_SKIP_ACK]', 'reason=no-pendingUndo', `noticeKey=${derivedNoticeKey || 'null'}`]
                        });
                    } else if (session.pendingUndo?.clientOpId === mappedClientOpId) {
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
                            payload: ['segment.skip', 'reason', 'emptyMembers', 'anchorMsgId', session.pendingUndo.anchorKey, 'note', 'will-try-applyRevertedSegmentPayload']
                        });
                        }
                        // New system: applyRevertedSegmentPayload handles segment creation
                        // No need to manually create segments or send undoSegmentCreated

                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['undo', 'ack', mappedClientOpId, 'sessionId', sessionId, 'membersCount', members.length]
                        });
                    }
                }

                if (mappedClientOpId && session.pendingUndo?.clientOpId === mappedClientOpId) {
                    session.pendingUndo.ackOpId = ackOpId;
                }
                session.pendingUndo = null;
                if (derivedNoticeKey) {
                    session.pendingUndoByNoticeKey?.delete(derivedNoticeKey);
                }
                if (mappedClientOpId) {
                    session.undoNoticeKeyByOpId?.delete(mappedClientOpId);
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][UNDO_PENDING_CLEAR]',
                        'stillPending=false',
                        `noticeKey=${derivedNoticeKey || 'null'}`]
                });

                if (segPayload) {
                    const upsertNoticeKey = derivedNoticeKey
                        || (anchorForUpsert ? `system:undo:${anchorForUpsert}` : `system:undo:unknown:${Date.now()}`);
                    let endForUpsert = segPayload?.endMessageId || segPayload?.endMsgId || anchorForUpsert;
                    const applied = segPayload?.applied ?? true;
                    const shouldComputeMembers = Boolean(found && applied);
                    const originalMemberMsgIds = shouldComputeMembers
                        ? computeMemberMsgIdsFromTimeline(session, anchorForUpsert, endForUpsert)
                        : [];
                    const payloadMemberMsgIds = Array.isArray(segPayload?.messageIds)
                        ? segPayload.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                        : [];
                    let memberMsgIds = payloadMemberMsgIds.length ? payloadMemberMsgIds : originalMemberMsgIds;
                    const originalEndMsgId = endForUpsert;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_MEMBERS]',
                            `anchor=${anchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`,
                            `count=${memberMsgIds.length}`]
                    });

                    // Merge with any placeholders after anchor within the final range
                    let finalEndMsgId = endForUpsert;
                    let finalMemberMsgIds = memberMsgIds;
                    let mergeApplied = false;
                    const noticeKeyNew = upsertNoticeKey;
                    const msgTimelineIndex = new Map();
                    for (let idx = 0; idx < session.timeline.length; idx++) {
                        const id = session.timeline[idx];
                        if (typeof id === 'string' && id.startsWith('msg_') && !msgTimelineIndex.has(id)) {
                            msgTimelineIndex.set(id, idx);
                        }
                    }
                    const getMsgTimelineIndex = (id) => {
                        if (!id || typeof id !== 'string') return -1;
                        return msgTimelineIndex.get(id) ?? -1;
                    };
                    const anchorIdx = anchorForUpsert ? getMsgTimelineIndex(anchorForUpsert) : -1;
                    const newEndIdx = endForUpsert ? getMsgTimelineIndex(endForUpsert) : -1;

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][MERGE_SCAN_INIT]',
                            `anchorIdx=${anchorIdx}`,
                            `newEndIdx=${newEndIdx}`]
                    });

                    if (anchorIdx >= 0 && newEndIdx >= 0) {
                        let maxEndIdx = newEndIdx;
                        const noticeKeysToDelete = [];
                        const placeholderIdxToDelete = [];
                        let i = anchorIdx + 1;

                        while (i <= maxEndIdx) {
                            const id = session.timeline[i];
                            if (typeof id === 'string' && id.startsWith('system:undo-seg:')) {
                                const oldNoticeKey = id.slice('system:undo-seg:'.length);
                                if (oldNoticeKey === noticeKeyNew) {
                                    i++;
                                    continue;
                                }
                                const oldSeg = session.segmentsByNoticeKey.get(oldNoticeKey);
                                if (!oldSeg) {
                                    i++;
                                    continue;
                                }
                                const oldEndIdx = oldSeg.endMsgId
                                    ? getMsgTimelineIndex(oldSeg.endMsgId)
                                    : -1;
                                noticeKeysToDelete.push(oldNoticeKey);
                                placeholderIdxToDelete.push(i);
                                if (oldEndIdx > maxEndIdx) {
                                    maxEndIdx = oldEndIdx;
                                }
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][MERGE_SCAN_HIT]',
                                        `i=${i}`,
                                        `oldNoticeKey=${oldNoticeKey}`,
                                        `oldEndIdx=${oldEndIdx}`,
                                        `maxEndIdx=${maxEndIdx}`]
                                });
                            }
                            i++;
                        }

                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][MERGE_SCAN_DONE]',
                                `deleteCount=${noticeKeysToDelete.length}`,
                                `maxEndIdx=${maxEndIdx}`]
                        });

                        if (noticeKeysToDelete.length) {
                            mergeApplied = true;
                        }

                        if (mergeApplied) {
                            const uniqueNoticeKeys = Array.from(new Set(noticeKeysToDelete));
                            const sortedIdx = Array.from(new Set(placeholderIdxToDelete)).sort((a, b) => b - a);
                            let unwrappedPlaceholders = 0;

                            for (const idx of sortedIdx) {
                                const placeholderId = session.timeline[idx];
                                if (typeof placeholderId !== 'string' || !placeholderId.startsWith('system:undo-seg:')) continue;
                                const oldNoticeKey = placeholderId.slice('system:undo-seg:'.length);
                                const oldSeg = session.segmentsByNoticeKey.get(oldNoticeKey);
                                if (!oldSeg?.anchorMsgId) {
                                    vscode.postMessage({
                                        type: 'ui-debug',
                                        payload: ['[WV][MERGE_UNWRAP_SKIP]',
                                            `oldNoticeKey=${oldNoticeKey}`,
                                            `placeholderIdx=${idx}`,
                                            'reason=missing-segment']
                                    });
                                    continue;
                                }
                                session.timeline[idx] = oldSeg.anchorMsgId;
                                unwrappedPlaceholders++;
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][MERGE_UNWRAP]',
                                        `oldNoticeKey=${oldNoticeKey}`,
                                        `placeholderIdx=${idx}`,
                                        `anchorMsgId=${oldSeg.anchorMsgId}`]
                                });
                            }

                            for (const oldNoticeKey of uniqueNoticeKeys) {
                                session.segmentsByNoticeKey.delete(oldNoticeKey);
                                session.pendingUndoByNoticeKey?.delete(oldNoticeKey);
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][SEG_DELETE_TX]', `noticeKey=${oldNoticeKey}`]
                                });
                                vscode.postMessage({
                                    type: 'undoSegmentDelete',
                                    sessionId,
                                    noticeKey: oldNoticeKey
                                });
                            }

                            const slice = session.timeline.slice(anchorIdx, maxEndIdx + 1);
                            finalMemberMsgIds = slice.filter((id) => typeof id === 'string' && id.startsWith('msg_'));
                            if (finalMemberMsgIds.length) {
                                finalEndMsgId = finalMemberMsgIds[finalMemberMsgIds.length - 1];
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][MERGE_MEMBERS]',
                                        `count=${finalMemberMsgIds.length}`,
                                        `first=${finalMemberMsgIds[0] || 'null'}`,
                                        `last=${finalMemberMsgIds[finalMemberMsgIds.length - 1] || 'null'}`]
                                });
                            } else {
                                mergeApplied = false;
                            }

                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['[WV][MERGE_DELETE]',
                                    `deletedSegments=${uniqueNoticeKeys.length}`,
                                    `unwrappedPlaceholders=${unwrappedPlaceholders}`]
                            });
                        }
                    }

                    if (mergeApplied) {
                        endForUpsert = finalEndMsgId;
                        memberMsgIds = finalMemberMsgIds;
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][MERGE_UPSERT]',
                                `noticeKey=${noticeKeyNew}`,
                                `anchorIdx=${anchorIdx}`,
                                `endMsgIdNew=${finalEndMsgId}`,
                                `membersCount=${finalMemberMsgIds.length}`]
                        });
                    }
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][APPLY_SEGMENT_CALL]',
                            `noticeKey=${upsertNoticeKey}`,
                            `anchor=${anchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`]
                    });
                    const existingSegment = session.segmentsByNoticeKey.get(upsertNoticeKey);
                    const restoreAllowed = existingSegment?.restoreAllowed === false ? false : true;
                    session.segmentsByNoticeKey.set(upsertNoticeKey, {
                        noticeKey: upsertNoticeKey,
                        anchorMsgId: anchorForUpsert,
                        endMsgId: endForUpsert,
                        memberMsgIds,
                        applied,
                        restoreAllowed: true,
                        ackOpId: ackOpId || null,
                        collapsed: true,
                        createdAt: Date.now()
                    });
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_PERSIST_TX]',
                            `sessionId=${sessionId || 'null'}`,
                            `noticeKey=${upsertNoticeKey}`,
                            `anchor=${anchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`,
                            `membersCount=${memberMsgIds.length}`]
                    });
                    vscode.postMessage({
                        type: 'undoSegmentUpsert',
                        sessionId,
                        segment: {
                            noticeKey: upsertNoticeKey,
                            anchorMsgId: anchorForUpsert,
                            endMsgId: endForUpsert,
                            memberMsgIds,
                            applied,
                            restoreAllowed: true,
                            collapsed: true,
                            updatedAt: Date.now()
                        }
                    });
                    rebuildHiddenSetFromTimeline(session);
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_UPSERT]',
                            `noticeKey=${upsertNoticeKey}`,
                            `segmentsCount=${session.segmentsByNoticeKey.size}`,
                            `hiddenSetSize=${session.hiddenSet.size}`]
                    });
                    const placeholderId = upsertUndoPlaceholder(session, upsertNoticeKey, anchorForUpsert, endForUpsert, applied);
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][ROOTS]',
                            `placeholderId=${placeholderId}`,
                            `timelineSize=${session.timeline.length}`]
                    });
                    window.__oc?.renderFromState?.();
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][REVERTED_HANDLER]', 'entering-apply',
                            `sessionId=${sessionId}`,
                            `activeSessionId=${activeSessionId || 'null'}`,
                            `noticeKey=${derivedNoticeKey || 'null'}`,
                            `anchor=${segPayload?.startMessageId || segPayload?.anchorMsgId || 'null'}`,
                            `end=${segPayload?.endMessageId || segPayload?.endMsgId || 'null'}`,
                            `applied=${segPayload?.applied ?? 'null'}`]
                    });
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][APPLY_SEGMENT_CALL]', `sessionId=${sessionId}`, `hasSegment=${!!segPayload}`, `anchorMsgId=${segPayload?.startMessageId || segPayload?.anchorMsgId || 'null'}`]
                    });
                    try {
                        applyRevertedSegmentPayload(sessionId, segPayload, derivedNoticeKey);
                    } catch (err) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][APPLY_SEGMENT_ERROR]',
                                `name=${err?.name || 'Error'}`,
                                `message=${err?.message || String(err)}`,
                                `stack=${err?.stack || 'null'}`]
                        });
                    }
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][REVERTED_HANDLER]', 'after-apply',
                            `segmentsCount=${session.segmentsByNoticeKey.size}`,
                            `hiddenSetSize=${session.hiddenSet.size}`]
                    });
                    window.__oc?.renderFromState?.();
                    scrollToBottom();
                    logSessionState(sessionId, 'revertedSegment');
                } else {
                    postRevertedReturn('missing-segPayload', sessionId, derivedNoticeKey, false, null);
                }
                } catch (err) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][REVERTED_CASE_ERROR]',
                            `name=${err?.name || 'Error'}`,
                            `message=${err?.message || String(err)}`,
                            `stack=${err?.stack || 'null'}`]
                    });
                }
                break;
            }
            case 'revertedSegmentDiscarded': {
                const sessionId = getEventSessionId(message, 'revertedSegmentDiscarded');
                if (!sessionId) break;

                const session = getSessionState(sessionId);
                if (!session) break;

                const opId = message.segment?.operationId;
                const noticeKey = opId ? session.undoNoticeKeyByOpId.get(opId) : null;

                const isAllowed = Boolean((opId && allowedDiscardKeys.has(opId)) || (noticeKey && allowedDiscardKeys.has(noticeKey)));
                if (!isAllowed) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][DISCARD_DROP]', 'reason=unexpected_discard', `noticeKey=${noticeKey || 'null'}`, `opId=${opId || 'null'}`]
                    });
                    break;
                }
                if (opId) allowedDiscardKeys.delete(opId);
                if (noticeKey) allowedDiscardKeys.delete(noticeKey);

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.ack', 'payloadType', 'revertedSegmentDiscarded', 'ackOpId', opId || 'null', 'clientOpId', opId || 'null', 'sessionId', sessionId, 'noticeKey', noticeKey || 'null']
                });

                if (session.pendingUndo?.clientOpId === opId || session.pendingUndo?.ackOpId === opId) {
                    session.pendingUndo = null;
                }

                if (noticeKey && session.pendingUndoByNoticeKey?.has(noticeKey)) {
                    session.pendingUndoByNoticeKey.delete(noticeKey);
                }

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

                    // Remove segment from segmentsByNoticeKey
                    const systemNoticeKey = `system:undo:${noticeKey}`;
                    if (session.segmentsByNoticeKey.has(systemNoticeKey)) {
                        session.segmentsByNoticeKey.delete(systemNoticeKey);
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['restore', 'removed-segment', 'noticeKey', systemNoticeKey, 'sessionId', sessionId]
                        });
                    } else if (session.segmentsByNoticeKey.has(noticeKey)) {
                        session.segmentsByNoticeKey.delete(noticeKey);
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['restore', 'removed-segment', 'noticeKey', noticeKey, 'sessionId', sessionId]
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
            case 'restoredSegment': {
                const sessionId = getEventSessionId(message, 'restoredSegment');
                if (!sessionId) break;
                
                const session = getSessionState(sessionId);
                if (!session) break;
                
                const noticeKey = message.noticeKey || '';
                const applied = Boolean(message.applied);
                
                if (!applied) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][RESTORE_FAILED]', `noticeKey=${noticeKey}`, 'applied=false']
                    });
                    break;
                }

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][RESTORE_RX]', `sessionId=${sessionId}`, `noticeKey=${noticeKey}`, 'applied=true']
                });
                
                const placeholderId = getUndoPlaceholderId(noticeKey);
                const seg = session.segmentsByNoticeKey.get(noticeKey) || null;
                const pIdx = session.timeline.indexOf(placeholderId);
                let didReplace = false;
                if (pIdx >= 0 && seg?.anchorMsgId) {
                    session.timeline[pIdx] = seg.anchorMsgId;
                    didReplace = true;
                }
                session.messagesById.delete(placeholderId);

                // Delete segment locally
                const deleted = session.segmentsByNoticeKey.delete(noticeKey);
                
                if (!deleted) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][RESTORE_WARN]', `noticeKey=${noticeKey}`, 'segment-not-found']
                    });
                }

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][RESTORE_PLACEHOLDER_REVERT]',
                        `noticeKey=${noticeKey}`,
                        `pIdx=${pIdx}`,
                        `segAnchor=${seg?.anchorMsgId || 'null'}`,
                        `didReplace=${didReplace}`]
                });
                
                // Rebuild hidden set (this will unhide all messages from this segment)
                rebuildHiddenSetFromTimeline(session);
                
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][RESTORE_DONE]',
                        `segmentsCount=${session.segmentsByNoticeKey.size}`,
                        `hiddenSetSize=${session.hiddenSet.size}`,
                        `timelineSize=${session.timeline.length}`,
                        `timelineFirst=${session.timeline[0] || 'null'}`]
                });

                // Notify extension to delete persisted segment
                vscode.postMessage({
                    type: 'undoSegmentRemove',
                    sessionId,
                    noticeKey
                });
                
                // Trigger re-render
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'revertedSegmentState': {
                const sessionId = getEventSessionId(message, 'revertedSegmentState');
                if (!sessionId) break;

                const session = getSessionState(sessionId);
                if (!session) break;

                const opId = message.segment?.operationId;
                const noticeKey = opId ? session.undoNoticeKeyByOpId.get(opId) : null;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.ack', 'payloadType', 'revertedSegmentState', 'ackOpId', opId || 'null', 'clientOpId', opId || 'null', 'sessionId', sessionId, 'noticeKey', noticeKey || 'null']
                });

                if (session.pendingUndo?.clientOpId === message.segment?.operationId || session.pendingUndo?.ackOpId === message.segment?.operationId) {
                    session.pendingUndo = null;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['undo', 'ack-state', message.segment?.operationId]
                    });
                }

                if (noticeKey && session.pendingUndoByNoticeKey?.has(noticeKey)) {
                    session.pendingUndoByNoticeKey.delete(noticeKey);
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
                updateUndoStatusDisplay(activeSessionId);
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'undoStatus': {
                const sessionId = getEventSessionId(message, 'undoStatus');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                session.undoAvailable = message.enabled === true;
                if (sessionId === activeSessionId) {
                    updateUndoStatusDisplay(sessionId);
                }
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
                const session = getSessionState(sessionId, true);
                if (!session) break;
                const messageId = message.messageId;
                if (typeof messageId === 'string' && messageId.length) {
                    removeMessageFromSession(session, messageId);
                }
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            default: {
                // Log unknown message types for debugging
                if (message.type && !['pong', 'webviewReadyAck'].includes(message.type)) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][UNKNOWN_MSG]', `type=${message.type}`, `sessionId=${message.sessionId || message.sessionID || 'null'}`, `keys=${Object.keys(message).join(',')}`]
                    });
                }
                break;
            }
        }
    });
});

function postOpenGitDiff(filePath, sessionId, commitHead, commitBase) {
    if (!filePath) return;
    vscode.postMessage({
        type: 'openGitDiff',
        filePath,
        sessionId: sessionId || activeSessionId || '',
        commitHead: commitHead || undefined,
        commitBase: commitBase || undefined
    });
}

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

    const hint = document.createElement('div');
    hint.className = 'conflict-card-hint';
    hint.textContent = 'Select continue to override the conflict and make a hard restore.';
    container.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'conflict-card-list';

    for (const item of payload.conflicts) {
        const details = document.createElement('details');
        details.className = 'conflict-card-item';

        const summary = document.createElement('summary');
        summary.textContent = item.path || 'unknown';
        summary.addEventListener('click', () => {
            if (item.path) {
                const sessionId = payload.sessionId || activeSessionId;
                postOpenGitDiff(item.path, sessionId);
            }
        });
        details.appendChild(summary);

        const meta = document.createElement('div');
        meta.className = 'conflict-card-meta';
        const expected = item.expectedExists ? 'exists' : 'missing';
        const current = item.currentExists ? 'exists' : 'missing';
        meta.textContent = `Expected: ${expected}, Current: ${current}`;
        details.appendChild(meta);

        const diffText = item.diffText || '';
        if (diffText) {
            const diffBlock = document.createElement('div');
            diffBlock.className = 'conflict-card-diff';
            renderMarkdownInto(diffBlock, `\n\`\`\`diff\n${diffText}\n\`\`\`\n`);
            details.appendChild(diffBlock);
        } else {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = '(no diff)';
            pre.appendChild(code);
            details.appendChild(pre);
        }

        list.appendChild(details);
    }

    container.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'conflict-card-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'conflict-card-btn secondary';
    cancelBtn.textContent = 'Skip';
    cancelBtn.addEventListener('click', () => {
        if (conflictCardEl && conflictCardEl.parentElement) {
            conflictCardEl.parentElement.removeChild(conflictCardEl);
        }
        conflictCardEl = null;
        lastConflictPayload = null;
        vscode.postMessage({ type: 'conflictDecision', decision: 'skip' });
    });

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'conflict-card-btn';
    continueBtn.textContent = 'Override';
    continueBtn.addEventListener('click', () => {
        if (conflictCardEl && conflictCardEl.parentElement) {
            conflictCardEl.parentElement.removeChild(conflictCardEl);
        }
        conflictCardEl = null;
        lastConflictPayload = null;
        vscode.postMessage({
            type: 'conflictDecision',
            decision: 'override',
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
