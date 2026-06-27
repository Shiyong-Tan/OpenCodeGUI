const vscode = acquireVsCodeApi();

// Global error handler for catching uncaught exceptions
window.onerror = function (message, source, lineno, colno, error) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][UNCAUGHT_ERROR]', `msg=${String(message)}`, `src=${String(source)}`, `line=${lineno}`, `col=${colno}`, `stack=${String(error?.stack)}`]
    });
    return false;
};

window.onunhandledrejection = function (event) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][UNHANDLED_REJECTION]', `reason=${String(event.reason)}`]
    });
};

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

let tempFinalTraceEnabled = null;
const TEMP_FINAL_TRACE_PREFIX = '[TMP_FINAL_TRACE]';
function isTempFinalTraceEnabled() {
    if (tempFinalTraceEnabled !== null) return tempFinalTraceEnabled;
    try {
        tempFinalTraceEnabled = window?.__oc?.debug?.tempFinal === true
            || window?.__oc?.debug?.tempFinalTrace === true
            || localStorage.getItem('oc_trace_temp_final') === '1';
    } catch (error) {
        tempFinalTraceEnabled = false;
    }
    return tempFinalTraceEnabled;
}

function emitTempFinalTrace(label, payload) {
    if (!isTempFinalTraceEnabled()) return;
    const safePayload = Array.isArray(payload) ? payload : [payload];
    vscode.postMessage({ type: 'ui-debug', payload: [TEMP_FINAL_TRACE_PREFIX, label, ...safePayload] });
}

let tempFinalAssertEnabled = null;
function isTempFinalAssertEnabled() {
    if (tempFinalAssertEnabled !== null) return tempFinalAssertEnabled;
    try {
        tempFinalAssertEnabled = window?.__oc?.debug?.tempFinalAssert === true
            || localStorage.getItem('oc_assert_temp_final') === '1';
    } catch (error) {
        tempFinalAssertEnabled = false;
    }
    return tempFinalAssertEnabled;
}

function assertTempFinalParity(sessionId, stage, finalKey) {
    if (!isTempFinalAssertEnabled()) return;
    const session = getSessionState(sessionId);
    if (!session || !finalKey || typeof finalKey !== 'string') return;
    const finalMsg = session.messagesById.get(finalKey);
    if (!finalMsg || finalMsg.role !== 'assistant') return;
    const tmpKey = session.pendingAssistantUpgrade?.tmpKey;
    if (!tmpKey || tmpKey === finalKey) return;
    const tmpMsg = session.messagesById.get(tmpKey);
    if (!tmpMsg || tmpMsg.role !== 'assistant') return;
    const finalText = typeof finalMsg.text === 'string' ? finalMsg.text : '';
    const tmpText = typeof tmpMsg.text === 'string' ? tmpMsg.text : '';
    if (finalText && tmpText && finalText !== tmpText) {
        emitTempFinalTrace('assert.parity.mismatch', [
            `stage=${stage}`,
            `sessionId=${sessionId}`,
            `finalKey=${finalKey}`,
            `tmpKey=${tmpKey}`,
            `finalLen=${finalText.length}`,
            `tmpLen=${tmpText.length}`
        ]);
    }
}

let models = [];
let sessions = [];
let modes = ['plan', 'build'];
let selectedModel = '';
let selectedVariant = '';
let selectedMode = 'plan';
let activeSessionId = '';
let isBusy = false;
let busySessionId = '';
let attachments = [];
let messageCounter = 0;
let collapsedProviders = new Set();
let modelDropdownOutsideHandler = null;
let simpleDropdownHandlers = new Map();
const subagentTextExpandedByKey = new Map();
let conflictCardEl = null;
let stallCardEl = null;
let lastConflictPayload = null;
let questionOverlayEl = null;
let questionOverlayTimer = null;
let questionOverlayState = null;
let quoteSelectionButton = null;
let quoteSelectionText = '';
let sessionSearchDebounceTimer = null;
let sessionSearch = {
    open: false,
    query: '',
    mode: 'text',
    matches: [],
    activeIndex: -1,
    smartMessageIds: [],
    smartRequestId: '',
    smartInFlight: false
};
const shownQuestionCallIds = new Set();
const sentQuestionCallIds = new Set();
const questionOverlayQueue = [];
let permissionOverlayEl = null;
let permissionOverlayState = null;
let isSwitchingSession = false;
let pendingExplicitSessionSelectionId = '';
let pendingRefreshRequestId = null;
let hydratedSessions = new Set();
let allowedDiscardKeys = new Set();
const pendingDeleteSessionOpBySession = new Map();
let armedDeleteSessionId = '';
let shouldEmitSnapshotOnNextRender = false;

const sessionsById = new Map();
let gitUndoEnabled = false;
let gitUndoReason = null;
let baselineReady = true;
let baselineMessage = null;
let baselinePreparing = false;
let baselinePreparingTimer = null;
let sendBtn = null;
let sendButtonEl = null;
let sendButtonSendIconHtml = '';
let sendButtonStopIconHtml = '';
let currentModelQuota = null;
let quotaTooltipEl = null;
let inputEl = null;
let appendInputMode = null;
let appendHoverActiveKey = null;
let appendHoverHideTimer = null;
let inputDefaultPlaceholder = 'Ask anything...';
let freeModelIds = new Set();
const pendingUiPrompts = [];
let pendingContextItems = [];
let pendingFileRefs = [];
let sendBlockedNotice = '';
let systemNoticeText = '';
let baseSessionTitle = 'OpenCode: Chat';
let headerStatusText = '';
const sessionUsageById = new Map();
let textMeasureCanvas = null;
let usageCompactHoverActive = false;
const compactionRunningBySession = new Set();
let subagentIntervals = new Map();
let subagentCardsContainer = null;
let autoScrollPinnedToBottom = true;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
let debugWebviewLivenessAckDrop = false;
let currentWebviewLivenessPanelId = '';

const SEND_BLOCK_NOTICE = 'Please wait while the previous response finishes.';
const BASELINE_PREPARING_NOTICE = 'Preparing git for this session...';
const COMPACTION_RUNNING_NOTICE = 'Compaction is running...';
const COMPACTION_ACTIVE_SESSION_NOTICE = 'Compaction is unavailable while this session is active.';
const BASELINE_PREPARING_MAX_MS = 45000;

function isCompactDisabledForSession(sessionId) {
    if (!sessionId) return true;
    if (isBusy) return true;
    if (compactionRunningBySession.has(sessionId)) return true;
    const session = getSessionState(sessionId);
    return isSendBlockedByPendingState(session);
}

function renderHeaderTitle() {
    const titleEl = document.getElementById('session-title');
    if (!titleEl) return;
    titleEl.textContent = headerStatusText || baseSessionTitle;
}

function clampPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
}

function getSelectedModelContextLimit() {
    if (!Array.isArray(models) || !selectedModel) return 0;
    const model = models.find((item) => item && item.fullId === selectedModel);
    const raw = model?.contextLimit;
    const limit = Number(raw);
    return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

function recomputeSessionUsageFromMessages(session) {
    if (!session || !session.messagesById) return null;
    const assistants = [];
    for (const message of session.messagesById.values()) {
        if (!message || message.role !== 'assistant') continue;
        const meta = message.meta || {};
        assistants.push({
            tokens: meta.tokens || null,
            cost: meta.cost,
            timeCreated: Number(meta.timeCreated || 0),
            timeCompleted: Number(meta.timeCompleted || 0)
        });
    }
    assistants.sort((a, b) => a.timeCreated - b.timeCreated);

    let cost = 0;
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let contextUsed = 0;

    for (const info of assistants) {
        const c = Number(info.cost);
        if (Number.isFinite(c)) cost += c;
        const usage = info.tokens || {};
        if (!usage) continue;

        const uInput = Number(usage.input || 0);
        const uOutput = Number(usage.output || 0);
        const uReasoning = Number(usage.reasoning || 0);
        const uCacheRead = Number((usage.cache && usage.cache.read) || 0);
        const uCacheWrite = Number((usage.cache && usage.cache.write) || 0);
        if (uInput + uOutput + uReasoning + uCacheRead + uCacheWrite <= 0) continue;

        contextUsed = uInput + uCacheRead + uCacheWrite + uOutput;
        input += uInput;
        output += uOutput;
        reasoning += uReasoning;
        cacheRead += uCacheRead;
        cacheWrite += uCacheWrite;
    }

    const tokens = input + cacheRead + cacheWrite + output + reasoning;
    return { used: contextUsed, tokens, amount: cost };
}

function renderHeaderUsage() {
    const usageEl = document.getElementById('header-usage');
    const fillEl = document.getElementById('header-usage-fill');
    const labelEl = document.getElementById('header-usage-label');
    if (!usageEl || !fillEl || !labelEl) return;
    const sid = activeSessionId || '';
    let usage = sid ? sessionUsageById.get(sid) : null;
    const contextLimit = getSelectedModelContextLimit();
    if (usage && Number(usage.size) <= 0 && contextLimit > 0) {
        usage = { ...usage, size: contextLimit };
        sessionUsageById.set(sid, usage);
    }
    if ((!usage || !Number.isFinite(Number(usage.size)) || Number(usage.size) <= 0) && sid) {
        const session = getSessionState(sid);
        const recomputed = recomputeSessionUsageFromMessages(session);
        if (recomputed && contextLimit > 0) {
            usage = { used: recomputed.used, size: contextLimit, amount: recomputed.amount };
        }
    }
    if (!usage || Number(usage.size) <= 0) {
        usageEl.classList.add('hidden');
        usageCompactHoverActive = false;
        return;
    }
    const isCompactionRunning = activeSessionId && compactionRunningBySession.has(activeSessionId);
    const isCompactDisabled = isCompactDisabledForSession(sid);
    usageEl.disabled = isCompactDisabled;
    usageEl.title = isCompactDisabled ? COMPACTION_ACTIVE_SESSION_NOTICE : '';
    const pct = clampPercent((usage.used / usage.size) * 100);
    usageEl.classList.toggle('usage-high', pct >= 50 && !isCompactionRunning && !usageCompactHoverActive);
    if (isCompactionRunning) {
        usageEl.classList.add('usage-compact-mode');
        usageEl.classList.add('usage-compact-running');
        fillEl.style.width = '100%';
        labelEl.textContent = 'Running';
    } else if (usageCompactHoverActive) {
        usageEl.classList.add('usage-compact-mode');
        usageEl.classList.remove('usage-compact-running');
        fillEl.style.width = '100%';
        labelEl.textContent = 'Compact';
    } else {
        usageEl.classList.remove('usage-compact-mode');
        usageEl.classList.remove('usage-compact-running');
        fillEl.style.width = `${pct}%`;
        labelEl.textContent = `${Math.round(pct)}%`;
    }
    usageEl.classList.remove('hidden');
}

function setHeaderWaitingState(waiting) {
    const titleEl = document.getElementById('session-title');
    if (!titleEl) return;
    titleEl.classList.toggle('is-waiting', Boolean(waiting));
}

function measureTextWidth(text, font) {
    if (!textMeasureCanvas) {
        textMeasureCanvas = document.createElement('canvas');
    }
    const ctx = textMeasureCanvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(String(text || '')).width;
}

function computeModelPanelWidthPx(wrapper, items) {
    if (!wrapper) return 0;
    const modelsList = Array.isArray(items) ? items : [];
    if (!modelsList.length) {
        return 0;
    }
    const computed = window.getComputedStyle(wrapper);
    const baseSize = Number.parseFloat(computed.fontSize || '13') || 13;
    const optionSize = Math.max(11, baseSize * 0.85);
    const fontFamily = computed.fontFamily || 'sans-serif';
    const font = `400 ${optionSize}px ${fontFamily}`;
    const twoSpacesWidth = measureTextWidth('  ', font);

    let maxTextWidth = 0;
    for (const model of modelsList) {
        const name = String(model?.name || model?.fullId || '').trim();
        const speed = typeof model?.speedMultiplier === 'string' ? model.speedMultiplier.trim() : '';
        const showSpeed = Boolean(speed && isCopilotProvider(model?.providerId || ''));
        const nameWidth = measureTextWidth(name, font);
        const speedWidth = showSpeed ? measureTextWidth(speed, font) : 0;
        const width = nameWidth + (showSpeed ? (twoSpacesWidth + speedWidth) : 0);
        if (width > maxTextWidth) {
            maxTextWidth = width;
        }
    }

    const optionPaddingLeftPx = 22;
    const optionPaddingRightPx = 8;
    const panelPaddingBorderPx = 10;
    const scrollbarReservePx = 14;
    const minWidthPx = 160;
    const maxWidthPx = 320;
    const target = Math.ceil(maxTextWidth + optionPaddingLeftPx + optionPaddingRightPx + panelPaddingBorderPx + scrollbarReservePx);
    const widthPx = Math.max(minWidthPx, Math.min(maxWidthPx, target));
    return widthPx;
}

function computeModePanelWidthPx(wrapper, modeItems) {
    if (!wrapper) return 0;
    const labels = Array.isArray(modeItems)
        ? modeItems.filter((mode) => typeof mode === 'string' && mode.length > 0)
        : [];
    if (!labels.length) return 0;

    const button = wrapper.querySelector('.select-button');
    const styleSource = button || wrapper;
    const computed = window.getComputedStyle(styleSource);
    const fontWeight = computed.fontWeight || '400';
    const fontSize = computed.fontSize || '12px';
    const fontFamily = computed.fontFamily || 'sans-serif';
    const font = `${fontWeight} ${fontSize} ${fontFamily}`;

    let maxTextWidth = 0;
    for (const label of labels) {
        const textWidth = measureTextWidth(label, font);
        if (textWidth > maxTextWidth) {
            maxTextWidth = textWidth;
        }
    }

    const padLeft = Number.parseFloat(computed.paddingLeft || '0') || 0;
    const padRight = Number.parseFloat(computed.paddingRight || '0') || 0;
    const gap = Number.parseFloat(computed.columnGap || computed.gap || '4') || 4;
    const iconWidth = 10;
    const iconBuffer = 6;
    const textSafety = 2;

    const minWidthPx = 48;
    const maxWidthPx = 210;
    const targetWidth = Math.ceil(maxTextWidth + padLeft + padRight + gap + iconWidth + iconBuffer + textSafety);
    return Math.max(minWidthPx, Math.min(maxWidthPx, targetWidth));
}

function computeModeTriggerWidthPx(wrapper, selectedMode) {
    if (!wrapper || !selectedMode) return 0;

    const button = wrapper.querySelector('.select-button');
    const styleSource = button || wrapper;
    const computed = window.getComputedStyle(styleSource);
    const fontWeight = computed.fontWeight || '400';
    const fontSize = computed.fontSize || '12px';
    const fontFamily = computed.fontFamily || 'sans-serif';
    const font = `${fontWeight} ${fontSize} ${fontFamily}`;

    const textWidth = measureTextWidth(selectedMode, font);

    const padLeft = Number.parseFloat(computed.paddingLeft || '0') || 0;
    const padRight = Number.parseFloat(computed.paddingRight || '0') || 0;
    const gap = Number.parseFloat(computed.columnGap || computed.gap || '4') || 4;
    const iconWidth = 10;
    const iconBuffer = 6;
    const textSafety = 2;

    const minWidthPx = 48;
    const maxWidthPx = 210;
    const targetWidth = Math.ceil(textWidth + padLeft + padRight + gap + iconWidth + iconBuffer + textSafety);

    const inputContainer = wrapper.closest('.input-container');
    const containerWidth = inputContainer ? inputContainer.clientWidth : 0;
    const maxOneThird = containerWidth > 0 ? Math.floor(containerWidth / 3) : maxWidthPx;
    const finalWidth = Math.max(minWidthPx, Math.min(targetWidth, Math.min(maxWidthPx, maxOneThird)));
    return finalWidth;
}

function syncModeControlWidth(selectEl, modeItems, selectedMode) {
    if (!selectEl) return;
    const wrapper = selectEl.parentElement;
    if (!wrapper) return;
    const widthPx = computeModeTriggerWidthPx(wrapper, selectedMode);
    if (widthPx > 0) {
        wrapper.style.width = `${widthPx}px`;
        wrapper.style.minWidth = `${widthPx}px`;
        wrapper.style.maxWidth = '210px';
        return;
    }
    wrapper.style.removeProperty('width');
    wrapper.style.removeProperty('min-width');
    wrapper.style.removeProperty('max-width');
}

function setSendBlockedNotice(text) {
    sendBlockedNotice = typeof text === 'string' ? text : '';
    if (baselinePreparing) {
        headerStatusText = BASELINE_PREPARING_NOTICE;
    } else {
        headerStatusText = sendBlockedNotice ? 'Waiting for previous response...' : '';
    }
    setHeaderWaitingState(Boolean(sendBlockedNotice) || baselinePreparing);
    renderHeaderTitle();
    const pendingEl = document.getElementById('pending-indicator');
    if (!pendingEl) return;
    if (systemNoticeText) {
        pendingEl.textContent = systemNoticeText;
        pendingEl.classList.remove('hidden');
    } else {
        pendingEl.textContent = '';
        pendingEl.classList.add('hidden');
    }
}

function setSystemNotice(text) {
    systemNoticeText = typeof text === 'string' ? text : '';
    const pendingEl = document.getElementById('pending-indicator');
    if (!pendingEl) return;
    if (systemNoticeText) {
        pendingEl.textContent = systemNoticeText;
        pendingEl.classList.remove('hidden');
        return;
    }
    pendingEl.textContent = '';
    pendingEl.classList.add('hidden');
}

function closeStallCard() {
    if (stallCardEl && stallCardEl.parentElement) {
        stallCardEl.parentElement.removeChild(stallCardEl);
    }
    stallCardEl = null;
}

function showStallCard(payload) {
    closeStallCard();
    const wrapper = document.createElement('div');
    wrapper.className = 'question-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'question-overlay-backdrop';

    const card = document.createElement('div');
    card.className = 'conflict-card question-card question-overlay-card';

    const title = document.createElement('h3');
    title.className = 'question-card-title';
    title.textContent = payload?.title || 'Session may be stuck';

    const prompt = document.createElement('p');
    prompt.className = 'question-card-question';
    prompt.textContent = payload?.message || 'This session appears to be unresponsive. Please reload the extension and continue.';

    const actions = document.createElement('div');
    actions.className = 'question-card-actions';

    const secondaryButton = document.createElement('button');
    secondaryButton.className = 'conflict-card-btn question-card-btn';
    secondaryButton.textContent = payload?.secondaryActionLabel || 'Keep waiting';
    secondaryButton.addEventListener('click', () => {
        closeStallCard();
    });

    const primaryButton = document.createElement('button');
    primaryButton.className = 'conflict-card-btn question-card-btn question-card-submit';
    primaryButton.textContent = payload?.actionLabel || 'Reload Window';
    primaryButton.addEventListener('click', () => {
        vscode.postMessage({ type: 'reloadWindow', sessionId: activeSessionId });
    });

    actions.appendChild(secondaryButton);
    actions.appendChild(primaryButton);
    card.appendChild(title);
    card.appendChild(prompt);
    card.appendChild(actions);
    wrapper.appendChild(backdrop);
    wrapper.appendChild(card);
    document.body.appendChild(wrapper);
    stallCardEl = wrapper;
}

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

function stabilizeTimelineAfterFinal(session, finalMessageId, source) {
    if (!session || !Array.isArray(session.timeline) || !finalMessageId) return;
    const finalPos = session.timeline.lastIndexOf(finalMessageId);
    if (finalPos < 0) return;

    const finalIndex = session.messageIndexMap?.get?.(finalMessageId);
    const trailing = session.timeline.slice(finalPos + 1);
    if (!trailing.length) return;

    const moveBeforeFinal = [];
    const keepAfterFinal = [];
    const pruned = [];

    for (const id of trailing) {
        if (typeof id !== 'string' || !id) {
            keepAfterFinal.push(id);
            continue;
        }

        if (id.startsWith('tmp:') || id.startsWith('local-')) {
            const isPinned =
                session.pendingAssistantUpgrade?.tmpKey === id ||
                session.currentTurnAssistantKey === id ||
                session.currentTurnAssistantMsgId === id ||
                session.thinkingId === id;
            if (isPinned) {
                keepAfterFinal.push(id);
            } else {
                pruned.push(id);
            }
            continue;
        }

        const idx = session.messageIndexMap?.get?.(id);
        if (typeof finalIndex === 'number' && typeof idx === 'number' && idx < finalIndex) {
            moveBeforeFinal.push(id);
            continue;
        }

        keepAfterFinal.push(id);
    }

    if (!moveBeforeFinal.length && !pruned.length) return;

    const head = session.timeline.slice(0, finalPos);
    const seen = new Set();
    session.timeline = [...head, ...moveBeforeFinal, finalMessageId, ...keepAfterFinal].filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });

    vscode.postMessage({
        type: 'ui-debug',
        payload: [
            '[WV][FINAL_TAIL_NORMALIZE]',
            `source=${source || 'unknown'}`,
            `final=${finalMessageId}`,
            `moved=[${moveBeforeFinal.join(', ')}]`,
            `pruned=[${pruned.join(', ')}]`,
            `tail=${formatTail(session.timeline, 6)}`
        ]
    });
    logTimelineSnapshot('final-tail-normalize', session.timeline, `final=${finalMessageId}`);
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
        backendTurnInFlight: false,
        pendingAssistantUpgrade: null,
        lastAssistantUpgradeFallback: null,
        awaitingFinalMapBind: false,
        streamMode: null,
        seenDiffKeys: new Set(),
        assistantUpgradeSeen: new Set(),
        nextOrder: 0,
        serverIdToKey: new Map(),
        clientKeyToServerId: new Map(),
        serverIdToClientKey: new Map(),
        undoNoticeKeyByOpId: new Map(),
        pendingUndoByNoticeKey: new Map(),
        seenUndoAckOpIds: new Set(),
        pendingUndo: null,
        lastUndoNoticeKey: null,
        undoAvailable: true,
        turnFullyFinalized: true,
        appendRootUserKey: null,
        appendComposerFor: null,
        appendComposerDrafts: new Map(),
        inputDraft: '',
        hiddenControlUserIds: new Set(),
        earlyFinalAssistantId: null,
        finalAssistantLock: null,
        backgroundSubagentIndicatorVisible: false,
        backgroundSubagentIndicatorTimer: null,
        backgroundSubagentIndicatorUntil: 0,
        backgroundSubagentIndicatorAnchorId: null,
        snapshotPendingEpoch: 0,
        snapshotEmittedEpoch: 0,
        snapshotFinalizeReady: false
    };
}

function resetBaselinePreparingTimeout() {
    if (baselinePreparingTimer) {
        clearTimeout(baselinePreparingTimer);
        baselinePreparingTimer = null;
    }
}

function armBaselinePreparingTimeout() {
    resetBaselinePreparingTimeout();
    baselinePreparingTimer = setTimeout(() => {
        if (!baselinePreparing) return;
        baselinePreparing = false;
        setSystemNotice('Git baseline is taking too long. You can continue sending; undo may be unavailable.');
        updateSendGate();
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['baselineStatus', 'fallback-unblock', `timeoutMs=${BASELINE_PREPARING_MAX_MS}`]
        });
    }, BASELINE_PREPARING_MAX_MS);
}

function getMessageParentId(message) {
    return (
        (typeof message?.parentId === 'string' && message.parentId) ||
        (typeof message?.parentID === 'string' && message.parentID) ||
        (typeof message?.parentMessageId === 'string' && message.parentMessageId) ||
        (typeof message?.meta?.parentId === 'string' && message.meta.parentId) ||
        (typeof message?.meta?.parentID === 'string' && message.meta.parentID) ||
        ''
    );
}

function shouldDropHiddenControlAssistant(session, message, source, assistantMsgId) {
    if (!session) return false;
    const parentId = getMessageParentId(message);
    if (!parentId || !session.hiddenControlUserIds?.has?.(parentId)) {
        return false;
    }
    if (isHiddenControlAssistantText(message?.text || message?.lastText || '')) {
        const lockAssistantId = typeof session.finalAssistantLock?.assistantMsgId === 'string'
            ? session.finalAssistantLock.assistantMsgId
            : null;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][HIDDEN_ASSIST_DROP]', `source=${source || 'unknown'}`, `parentId=${parentId}`, `assistantMsgId=${assistantMsgId || 'null'}`, `lockAssistantId=${lockAssistantId || 'null'}`]
        });
        return true;
    }
    return false;
}

function getSessionState(sessionId, create = false) {
    if (!sessionId) return null;
    if (!sessionsById.has(sessionId) && create) {
        sessionsById.set(sessionId, createSessionState());
    }
    return sessionsById.get(sessionId) || null;
}

function cloneSessionMap(value) {
    return value instanceof Map ? new Map(value) : new Map();
}

function cloneSessionSet(value) {
    return value instanceof Set ? new Set(value) : new Set();
}

function clonePlainSessionValue(value) {
    if (value && typeof value === 'object') {
        if (Array.isArray(value)) return value.slice();
        return { ...value };
    }
    return value;
}

function cloneMessageForHydrationPreserve(message) {
    if (!message || typeof message !== 'object') return message;
    return {
        ...message,
        meta: message.meta && typeof message.meta === 'object' ? { ...message.meta } : message.meta
    };
}

function isHydrationPersistenceArtifact(id, message) {
    if (typeof id === 'string' && (id.startsWith('system:snapshot:') || id.startsWith('system:changeList:'))) {
        return true;
    }
    const kind = message?.meta?.kind;
    return kind === 'snapshotNotice' || kind === 'changeList';
}

function findMappedHydrationMsgId(map, key, matchValue = false) {
    if (!(map instanceof Map) || typeof key !== 'string' || !key.length) return null;
    if (!matchValue) {
        const mapped = map.get(key);
        return typeof mapped === 'string' && mapped.startsWith('msg_') ? mapped : null;
    }
    for (const [mapped, value] of map.entries()) {
        if (value === key && typeof mapped === 'string' && mapped.startsWith('msg_')) {
            return mapped;
        }
    }
    return null;
}

function resolvePreservedHydrationCanonicalId(session, preserved, id, message) {
    if (typeof id !== 'string' || !id.length) return null;
    if (id.startsWith('msg_')) return id;
    if (id.startsWith('local-')) {
        return findMappedHydrationMsgId(preserved?.clientKeyToServerId, id)
            || findMappedHydrationMsgId(session?.clientKeyToServerId, id)
            || findMappedHydrationMsgId(preserved?.serverIdToClientKey, id, true)
            || findMappedHydrationMsgId(session?.serverIdToClientKey, id, true)
            || findMappedHydrationMsgId(preserved?.serverIdToKey, id, true)
            || findMappedHydrationMsgId(session?.serverIdToKey, id, true)
            || toStableMessageKey(session, id)
            || null;
    }
    if (id.startsWith('tmp:')) {
        const preservedPending = preserved?.pendingAssistantUpgrade;
        const sessionPending = session?.pendingAssistantUpgrade;
        const pendingAssistantId =
            (preservedPending?.tmpKey === id && typeof preservedPending.assistantMsgId === 'string' && preservedPending.assistantMsgId.startsWith('msg_') && preservedPending.assistantMsgId) ||
            (sessionPending?.tmpKey === id && typeof sessionPending.assistantMsgId === 'string' && sessionPending.assistantMsgId.startsWith('msg_') && sessionPending.assistantMsgId) ||
            null;
        if (pendingAssistantId) return pendingAssistantId;
        const finalAssistantId =
            (typeof preserved?.finalAssistantLock?.assistantMsgId === 'string' && preserved.finalAssistantLock.assistantMsgId.startsWith('msg_') && preserved.finalAssistantLock.assistantMsgId) ||
            (typeof session?.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId.startsWith('msg_') && session.finalAssistantLock.assistantMsgId) ||
            (typeof preserved?.earlyFinalAssistantId === 'string' && preserved.earlyFinalAssistantId.startsWith('msg_') && preserved.earlyFinalAssistantId) ||
            (typeof session?.earlyFinalAssistantId === 'string' && session.earlyFinalAssistantId.startsWith('msg_') && session.earlyFinalAssistantId) ||
            null;
        if (message?.role === 'assistant' && finalAssistantId) return finalAssistantId;
    }
    return null;
}

function captureVolatileHydrationState(session) {
    if (!session) return null;
    return {
        messagesById: cloneSessionMap(session.messagesById),
        timeline: Array.isArray(session.timeline) ? session.timeline.slice() : [],
        messageIndexMap: cloneSessionMap(session.messageIndexMap),
        serverIdToKey: cloneSessionMap(session.serverIdToKey),
        clientKeyToServerId: cloneSessionMap(session.clientKeyToServerId),
        serverIdToClientKey: cloneSessionMap(session.serverIdToClientKey),
        hiddenControlUserIds: cloneSessionSet(session.hiddenControlUserIds),
        assistantUpgradeSeen: cloneSessionSet(session.assistantUpgradeSeen),
        pendingAssistantUpgrade: clonePlainSessionValue(session.pendingAssistantUpgrade),
        finalAssistantLock: clonePlainSessionValue(session.finalAssistantLock),
        thinkingId: session.thinkingId,
        currentTurnAssistantKey: session.currentTurnAssistantKey,
        currentTurnAssistantMsgId: session.currentTurnAssistantMsgId,
        lastTurnUserId: session.lastTurnUserId,
        lastTurnAssistantId: session.lastTurnAssistantId,
        cancelledTurn: session.cancelledTurn,
        canceledActiveTurn: session.canceledActiveTurn,
        activeTurnOpId: session.activeTurnOpId,
        backendTurnInFlight: session.backendTurnInFlight,
        awaitingFinalMapBind: session.awaitingFinalMapBind,
        streamMode: session.streamMode,
        earlyFinalAssistantId: session.earlyFinalAssistantId,
        turnFullyFinalized: session.turnFullyFinalized,
        appendRootUserKey: session.appendRootUserKey,
        appendComposerFor: session.appendComposerFor,
        appendComposerDrafts: cloneSessionMap(session.appendComposerDrafts),
        inputDraft: session.inputDraft,
        backgroundSubagentIndicatorVisible: session.backgroundSubagentIndicatorVisible,
        backgroundSubagentIndicatorUntil: session.backgroundSubagentIndicatorUntil,
        backgroundSubagentIndicatorAnchorId: session.backgroundSubagentIndicatorAnchorId
    };
}

function restoreVolatileHydrationState(session, preserved) {
    if (!session || !preserved) return { missingIds: [], fieldNames: [], skippedArtifacts: { timeline: 0, backing: 0 }, skippedCanonicalizedVolatile: { timeline: 0, backing: 0, fields: 0 } };

    const hydratedIds = new Set(Array.isArray(session.timeline) ? session.timeline : []);
    const hydratedBackingIds = new Set(session.messagesById instanceof Map ? session.messagesById.keys() : []);
    const missingIds = [];
    const skippedArtifacts = { timeline: 0, backing: 0 };
    const skippedCanonicalizedVolatile = { timeline: 0, backing: 0, fields: 0 };
    let hasCanonicalizedVolatileDuplicate = false;
    const isHydrated = (id) => typeof id === 'string' && (hydratedIds.has(id) || hydratedBackingIds.has(id));
    const canonicalizedHydratedId = (id, message) => {
        if (typeof id !== 'string' || (!id.startsWith('local-') && !id.startsWith('tmp:'))) return null;
        const canonicalId = resolvePreservedHydrationCanonicalId(session, preserved, id, message);
        return canonicalId && canonicalId.startsWith('msg_') && isHydrated(canonicalId) ? canonicalId : null;
    };
    for (const id of preserved.timeline) {
        if (typeof id !== 'string' || !id.length || hydratedIds.has(id)) continue;
        const preservedMessage = preserved.messagesById.get(id);
        if (!preservedMessage) continue;
        if (isHydrationPersistenceArtifact(id, preservedMessage)) {
            skippedArtifacts.timeline++;
            continue;
        }
        if (canonicalizedHydratedId(id, preservedMessage)) {
            skippedCanonicalizedVolatile.timeline++;
            hasCanonicalizedVolatileDuplicate = true;
            continue;
        }
        session.messagesById.set(id, cloneMessageForHydrationPreserve(preservedMessage));
        session.timeline.push(id);
        hydratedIds.add(id);
        hydratedBackingIds.add(id);
        missingIds.push(id);
    }

    for (const [id, preservedMessage] of preserved.messagesById.entries()) {
        if (!id || session.messagesById.has(id)) continue;
        if (isHydrationPersistenceArtifact(id, preservedMessage)) {
            skippedArtifacts.backing++;
            continue;
        }
        if (canonicalizedHydratedId(id, preservedMessage)) {
            skippedCanonicalizedVolatile.backing++;
            hasCanonicalizedVolatileDuplicate = true;
            continue;
        }
        session.messagesById.set(id, cloneMessageForHydrationPreserve(preservedMessage));
        hydratedBackingIds.add(id);
    }

    const fieldNames = [];
    const fieldReferencesCanonicalHydratedVolatile = (value) => {
        if (typeof value === 'string') {
            return Boolean(canonicalizedHydratedId(value, preserved.messagesById.get(value)));
        }
        if (value && typeof value === 'object') {
            for (const candidate of [value.tmpKey, value.localKey, value.messageId, value.msgId, value.assistantMsgId, value.userMsgId, value.rootUserMessageId]) {
                if (typeof candidate === 'string' && canonicalizedHydratedId(candidate, preserved.messagesById.get(candidate))) {
                    return true;
                }
            }
        }
        return false;
    };
    const shouldSkipStaleInFlightField = (name) => {
        if (!hasCanonicalizedVolatileDuplicate) return false;
        const staleInFlightFields = new Set([
            'pendingAssistantUpgrade',
            'thinkingId',
            'currentTurnAssistantKey',
            'currentTurnAssistantMsgId',
            'lastTurnUserId',
            'lastTurnAssistantId',
            'activeTurnOpId',
            'backendTurnInFlight',
            'awaitingFinalMapBind',
            'streamMode',
            'appendRootUserKey'
        ]);
        if (!staleInFlightFields.has(name)) return false;
        if (fieldReferencesCanonicalHydratedVolatile(preserved[name])) return true;
        return ['activeTurnOpId', 'backendTurnInFlight', 'awaitingFinalMapBind', 'streamMode'].includes(name)
            && session.turnFullyFinalized !== false
            && session.backendTurnInFlight !== true;
    };
    const preserveField = (name, shouldPreserve) => {
        if (!shouldPreserve) return;
        if (shouldSkipStaleInFlightField(name)) {
            skippedCanonicalizedVolatile.fields++;
            return;
        }
        session[name] = clonePlainSessionValue(preserved[name]);
        fieldNames.push(name);
    };

    preserveField('pendingAssistantUpgrade', Boolean(preserved.pendingAssistantUpgrade));
    preserveField('finalAssistantLock', Boolean(preserved.finalAssistantLock));
    preserveField('thinkingId', Boolean(preserved.thinkingId));
    preserveField('currentTurnAssistantKey', Boolean(preserved.currentTurnAssistantKey));
    preserveField('currentTurnAssistantMsgId', Boolean(preserved.currentTurnAssistantMsgId));
    preserveField('lastTurnUserId', Boolean(preserved.lastTurnUserId));
    preserveField('lastTurnAssistantId', Boolean(preserved.lastTurnAssistantId));
    preserveField('cancelledTurn', preserved.cancelledTurn === true);
    preserveField('canceledActiveTurn', preserved.canceledActiveTurn === true);
    preserveField('activeTurnOpId', Boolean(preserved.activeTurnOpId));
    preserveField('backendTurnInFlight', preserved.backendTurnInFlight === true);
    preserveField('awaitingFinalMapBind', preserved.awaitingFinalMapBind === true);
    preserveField('streamMode', Boolean(preserved.streamMode));
    preserveField('earlyFinalAssistantId', Boolean(preserved.earlyFinalAssistantId));
    preserveField('turnFullyFinalized', preserved.turnFullyFinalized === false);
    preserveField('appendRootUserKey', Boolean(preserved.appendRootUserKey));
    preserveField('appendComposerFor', Boolean(preserved.appendComposerFor));
    preserveField('inputDraft', typeof preserved.inputDraft === 'string' && preserved.inputDraft.length > 0);
    preserveField('backgroundSubagentIndicatorVisible', preserved.backgroundSubagentIndicatorVisible === true);
    preserveField('backgroundSubagentIndicatorUntil', typeof preserved.backgroundSubagentIndicatorUntil === 'number' && preserved.backgroundSubagentIndicatorUntil > Date.now());
    preserveField('backgroundSubagentIndicatorAnchorId', Boolean(preserved.backgroundSubagentIndicatorAnchorId));

    if (preserved.messageIndexMap.size) {
        if (!(session.messageIndexMap instanceof Map)) session.messageIndexMap = new Map();
        for (const [key, value] of preserved.messageIndexMap.entries()) {
            if (!session.messageIndexMap.has(key)) session.messageIndexMap.set(key, value);
        }
        fieldNames.push('messageIndexMap');
    }
    for (const [name, preservedMap] of [
        ['serverIdToKey', preserved.serverIdToKey],
        ['clientKeyToServerId', preserved.clientKeyToServerId],
        ['serverIdToClientKey', preserved.serverIdToClientKey],
        ['appendComposerDrafts', preserved.appendComposerDrafts]
    ]) {
        if (!preservedMap.size) continue;
        if (!(session[name] instanceof Map)) session[name] = new Map();
        for (const [key, value] of preservedMap.entries()) {
            if (!session[name].has(key)) session[name].set(key, value);
        }
        fieldNames.push(name);
    }
    for (const [name, preservedSet] of [
        ['hiddenControlUserIds', preserved.hiddenControlUserIds],
        ['assistantUpgradeSeen', preserved.assistantUpgradeSeen]
    ]) {
        if (!preservedSet.size) continue;
        if (!(session[name] instanceof Set)) session[name] = new Set();
        for (const value of preservedSet.values()) {
            session[name].add(value);
        }
        fieldNames.push(name);
    }

    return { missingIds, fieldNames: Array.from(new Set(fieldNames)), skippedArtifacts, skippedCanonicalizedVolatile };
}

function postLiveTurnResumeReconcileDiagnostic(marker, sessionId, reason, extra = []) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: [
            marker,
            `reason=${reason || 'unknown'}`,
            `sessionId=${sessionId || 'null'}`,
            `activeSessionId=${activeSessionId || 'null'}`,
            'postedSessionData=false',
            'reload=false',
            'recreate=false',
            'sessionMutation=false',
            ...extra
        ]
    });
}

function sessionHasActiveBackgroundSubagents(session) {
    if (!session) {
        return false;
    }
    return typeof session.backgroundSubagentIndicatorUntil === 'number'
        && session.backgroundSubagentIndicatorUntil > Date.now();
}

function sessionHasVisibleThinkingAssistant(session) {
    if (!session?.messagesById) {
        return false;
    }
    for (const message of session.messagesById.values()) {
        if (message?.role === 'assistant' && message?.meta?.isThinking === true) {
            return true;
        }
    }
    return false;
}

const BACKGROUND_RENDER_FALLBACK_THROTTLE_LIMIT = 2;
const BACKGROUND_RENDER_FALLBACK_THROTTLE_WINDOW_MS = 1000;
const backgroundRenderFallbackWindows = new Map();
const renderStormCounters = {
    fullRenderRequestsByReason: Object.create(null),
    suppressedFallbackRenderRequestsByReason: Object.create(null),
    backgroundIndicatorApplyResults: Object.create(null),
    localPatchFailedByReason: Object.create(null),
    assistantUpgradeFallbackResults: Object.create(null),
    userAppendFastPathResults: Object.create(null),
    userAppendFastPathBailReasons: Object.create(null),
    assistantStreamingPatchResults: Object.create(null),
    assistantStreamingPatchBailReasons: Object.create(null)
};

function incrementRenderStormCounter(bucketName, key) {
    const bucket = renderStormCounters[bucketName];
    if (!bucket) return 0;
    const safeKey = key || 'unknown';
    bucket[safeKey] = (bucket[safeKey] || 0) + 1;
    return bucket[safeKey];
}

function logRenderStormMetric(eventName, fields = []) {
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][RENDER_STORM]', eventName || 'metric', ...fields]
    });
}

function countBackgroundIndicatorApplyResult(result, fields = []) {
    const reason = result?.reason || 'unknown';
    const total = incrementRenderStormCounter('backgroundIndicatorApplyResults', reason);
    logRenderStormMetric('background-indicator-apply', [
        `applied=${result?.applied === true ? 'true' : 'false'}`,
        `reason=${reason}`,
        `count=${total}`,
        ...fields
    ]);
}

function countLocalPatchFailed(reason, fields = []) {
    const total = incrementRenderStormCounter('localPatchFailedByReason', reason);
    logRenderStormMetric('local-patch-failed', [`reason=${reason || 'unknown'}`, `count=${total}`, ...fields]);
}

function countAssistantUpgradeFallbackResult(reason, fields = []) {
    const total = incrementRenderStormCounter('assistantUpgradeFallbackResults', reason);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][ASSIST_UPGRADE_FALLBACK]', `reason=${reason || 'unknown'}`, `count=${total}`, ...fields]
    });
}

function countUserMessageAppendFastPathResult(result, fields = []) {
    const key = result || 'unknown';
    const total = incrementRenderStormCounter('userAppendFastPathResults', key);
    logRenderStormMetric('user-message-append-fast-path', [`result=${key}`, `count=${total}`, ...fields]);
}

function countUserMessageAppendFastPathBail(reason, fields = []) {
    const key = reason || 'unknown';
    const total = incrementRenderStormCounter('userAppendFastPathBailReasons', key);
    logRenderStormMetric('user-message-append-bail', [`reason=${key}`, `count=${total}`, ...fields]);
}

function countAssistantStreamingPatchResult(result, fields = []) {
    const key = result || 'unknown';
    const total = incrementRenderStormCounter('assistantStreamingPatchResults', key);
    logRenderStormMetric('assistant-streaming-patch', [`result=${key}`, `count=${total}`, ...fields]);
}

function countAssistantStreamingPatchBail(reason, fields = []) {
    const key = reason || 'unknown';
    const total = incrementRenderStormCounter('assistantStreamingPatchBailReasons', key);
    logRenderStormMetric('assistant-streaming-patch-bail', [`reason=${key}`, `count=${total}`, ...fields]);
}

function noteFullRenderRequest(reason, fields = []) {
    const total = incrementRenderStormCounter('fullRenderRequestsByReason', reason);
    logRenderStormMetric('full-render-request', [`reason=${reason || 'unknown'}`, `count=${total}`, ...fields]);
}

function suppressFallbackRender(reason, fields = []) {
    const total = incrementRenderStormCounter('suppressedFallbackRenderRequestsByReason', reason);
    logRenderStormMetric('fallback-render-suppressed', [`reason=${reason || 'unknown'}`, `count=${total}`, ...fields]);
}

function requestThrottledBackgroundFallbackRender(sessionId, reason, fields = []) {
    const renderReason = reason || 'background-fallback';
    if (sessionId && sessionId !== activeSessionId) {
        suppressFallbackRender(renderReason, [`sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, 'reason=inactive-session', ...fields]);
        logBackgroundStateUpdate(sessionId, renderReason, { extra: ['render=false', 'fallback=suppressed-inactive', ...fields] });
        return false;
    }
    const now = Date.now();
    let windowState = backgroundRenderFallbackWindows.get(renderReason);
    if (!windowState || now - windowState.startedAt >= BACKGROUND_RENDER_FALLBACK_THROTTLE_WINDOW_MS) {
        windowState = { startedAt: now, count: 0 };
        backgroundRenderFallbackWindows.set(renderReason, windowState);
    }
    if (windowState.count >= BACKGROUND_RENDER_FALLBACK_THROTTLE_LIMIT) {
        suppressFallbackRender(renderReason, [
            `sessionId=${sessionId || 'null'}`,
            `activeSessionId=${activeSessionId || 'null'}`,
            `windowMs=${BACKGROUND_RENDER_FALLBACK_THROTTLE_WINDOW_MS}`,
            `limit=${BACKGROUND_RENDER_FALLBACK_THROTTLE_LIMIT}`,
            ...fields
        ]);
        return false;
    }
    windowState.count += 1;
    logRenderStormMetric('fallback-render-allowed', [`reason=${renderReason}`, `sessionId=${sessionId || 'null'}`, `windowCount=${windowState.count}`, ...fields]);
    if (window.__oc && typeof window.__oc.renderFromState === 'function') {
        window.__oc.renderFromState(renderReason);
        return true;
    }
    requestAnimationFrame(() => {
        if (window.__oc && typeof window.__oc.renderFromState === 'function') {
            window.__oc.renderFromState(`${renderReason}-raf`);
        }
    });
    return true;
}

function escapeMessageIdForSelector(messageId) {
    const value = String(messageId || '');
    if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
    }
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function requestBackgroundPulseRender(sessionId) {
    if (sessionId && sessionId !== activeSessionId) {
        suppressFallbackRender('background-pulse', [`sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, 'reason=inactive-session']);
        logBackgroundStateUpdate(sessionId, 'background-pulse', { extra: ['render=false', 'fallback=suppressed-inactive'] });
        return;
    }
    requestThrottledBackgroundFallbackRender(sessionId || activeSessionId, 'background-pulse', ['source=requestBackgroundPulseRender']);
}

function shouldShowBackgroundSubagentIndicator(session, message) {
    if (!session || !message || message.role !== 'assistant') {
        return false;
    }
    if (message.meta?.isThinking === true) {
        return false;
    }
    if (!sessionHasActiveBackgroundSubagents(session)) {
        return false;
    }
    if (sessionHasVisibleThinkingAssistant(session)) {
        return false;
    }
    const anchoredAssistantId = typeof session.backgroundSubagentIndicatorAnchorId === 'string'
        ? session.backgroundSubagentIndicatorAnchorId
        : null;
    const finalAssistantId = typeof session.finalAssistantLock?.assistantMsgId === 'string'
        ? session.finalAssistantLock.assistantMsgId
        : null;
    const earlyFinalAssistantId = typeof session.earlyFinalAssistantId === 'string'
        ? session.earlyFinalAssistantId
        : null;
    const fallbackAssistantId = finalAssistantId || earlyFinalAssistantId || null;
    const targetAssistantId = anchoredAssistantId || fallbackAssistantId;
    const anchorMatches = targetAssistantId ? targetAssistantId === message.id : false;
    return anchorMatches;
}

function applyBackgroundSubagentIndicator(session) {
    if (session && session !== getSessionState(activeSessionId)) {
        return { applied: false, reason: 'inactive-session' };
    }
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return { applied: false, reason: 'missing-chat-container' };
    for (const existing of chatContainer.querySelectorAll('.message-background-subagent-indicator')) {
        existing.remove();
    }
    for (const bubble of chatContainer.querySelectorAll('.message.bot.has-background-subagent-indicator')) {
        bubble.classList.remove('has-background-subagent-indicator');
    }
    if (!sessionHasActiveBackgroundSubagents(session)) {
        return { applied: true, reason: 'no-active-indicator' };
    }
    if (sessionHasVisibleThinkingAssistant(session)) {
        return { applied: true, reason: 'no-active-indicator' };
    }
    const anchoredAssistantId = typeof session?.backgroundSubagentIndicatorAnchorId === 'string'
        ? session.backgroundSubagentIndicatorAnchorId
        : null;
    const finalAssistantId = typeof session?.finalAssistantLock?.assistantMsgId === 'string'
        ? session.finalAssistantLock.assistantMsgId
        : null;
    const earlyFinalAssistantId = typeof session?.earlyFinalAssistantId === 'string'
        ? session.earlyFinalAssistantId
        : null;
    const fallbackAssistantId = finalAssistantId || earlyFinalAssistantId || null;
    let targetBubble = null;
    const targetId = anchoredAssistantId || fallbackAssistantId;
    if (anchoredAssistantId && fallbackAssistantId && anchoredAssistantId !== fallbackAssistantId) {
        return { applied: false, reason: 'unclear-anchor' };
    }
    if (!targetId) {
        return { applied: false, reason: 'unclear-anchor' };
    }
    if (targetId) {
        targetBubble = chatContainer.querySelector(`.message.bot[data-message-id="${escapeMessageIdForSelector(targetId)}"]`);
    }
    if (!targetBubble) {
        return { applied: false, reason: 'missing-target-bubble' };
    }
    if (!targetBubble.querySelector('.message-background-subagent-indicator')) {
        targetBubble.classList.add('has-background-subagent-indicator');
        const bgIndicator = document.createElement('span');
        bgIndicator.className = 'message-background-subagent-indicator';
        bgIndicator.title = 'Background subagent is still running';
        bgIndicator.setAttribute('aria-label', 'Background subagent is still running');
        targetBubble.appendChild(bgIndicator);
    }
    return { applied: true, reason: 'applied' };
}

function handleBackgroundIndicatorPatchResult(sessionId, result, source) {
    countBackgroundIndicatorApplyResult(result, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`]);
    if (result?.applied === true) return true;
    const reason = result?.reason || 'unknown';
    if (reason === 'missing-target-bubble' || reason === 'unclear-anchor') {
        countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`]);
        requestThrottledBackgroundFallbackRender(sessionId, `background-pulse-${reason}`, [`source=${source || 'unknown'}`]);
        return false;
    }
    if (reason === 'inactive-session') {
        suppressFallbackRender(`background-pulse-${reason}`, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`]);
        logBackgroundStateUpdate(sessionId, 'background-pulse', { extra: [`apply=${reason}`, `source=${source || 'unknown'}`, 'render=false'] });
        return false;
    }
    countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`]);
    return false;
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

function armBackgroundSubagentIndicator(sessionId, anchorAssistantId) {
    const session = getSessionState(sessionId, true);
    if (!session) return;
    if (session.backgroundSubagentIndicatorVisible) {
        return;
    }
    const now = Date.now();
    session.backgroundSubagentIndicatorVisible = true;
    session.backgroundSubagentIndicatorUntil = now + 3000;
    session.backgroundSubagentIndicatorAnchorId =
        (typeof anchorAssistantId === 'string' && anchorAssistantId)
        ||
        (typeof session.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId)
        ||
        (typeof session.earlyFinalAssistantId === 'string' && session.earlyFinalAssistantId)
        || null;
    session.backgroundSubagentIndicatorTimer = setTimeout(() => {
        const latest = getSessionState(sessionId);
        if (!latest) return;
        latest.backgroundSubagentIndicatorVisible = false;
        latest.backgroundSubagentIndicatorUntil = 0;
        latest.backgroundSubagentIndicatorTimer = null;
        latest.backgroundSubagentIndicatorAnchorId = null;
        handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(latest), 'timer-expiry-hide');
    }, 3000);
    handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(session), 'arm-show');
}

function clearBackgroundSubagentIndicator(session) {
    if (!session) return;
    session.backgroundSubagentIndicatorVisible = false;
    session.backgroundSubagentIndicatorUntil = 0;
    session.backgroundSubagentIndicatorAnchorId = null;
    if (session.backgroundSubagentIndicatorTimer) {
        clearTimeout(session.backgroundSubagentIndicatorTimer);
        session.backgroundSubagentIndicatorTimer = null;
    }
}

    function cancelLocalTurn(sessionId) {
        const session = getSessionState(sessionId);
        if (!session) return;
    clearBackgroundSubagentIndicator(session);
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
    session.lastAssistantUpgradeFallback = null;
    session.awaitingFinalMapBind = false;
    session.backendTurnInFlight = false;
    session.currentTurnAssistantKey = null;
    session.currentTurnAssistantMsgId = null;
    session.streamMode = null;
    if (session.assistantUpgradeSeen instanceof Set) {
        session.assistantUpgradeSeen.clear();
    }
    session.activeTurnOpId = null;
    session.turnFullyFinalized = true;
    window.__oc?.renderFromState?.();
    updateSendGate();
}

const SINGLE_IN_FLIGHT_FALLBACK_EVENTS = new Set([
    // Intentionally empty for Slice 3: no legacy streaming event was proven to need fallback.
]);

function findSingleInFlightSessionId() {
    let found = '';
    for (const [sessionId, session] of sessionsById.entries()) {
        if (!session) continue;
        if (session.backendTurnInFlight === true || session.turnFullyFinalized === false) {
            if (found) return '';
            found = sessionId;
        }
    }
    return found;
}

function resolveEventSessionId(message, eventName, options = {}) {
    const sessionId =
        message?.sessionID ||
        message?.sessionId ||
        message?.part?.sessionID ||
        message?.part?.sessionId ||
        '';
    let resolvedSessionId = sessionId;
    let source = sessionId ? 'payload' : '';
    if (!resolvedSessionId && options?.allowSingleInFlightFallback === true && SINGLE_IN_FLIGHT_FALLBACK_EVENTS.has(eventName)) {
        resolvedSessionId = findSingleInFlightSessionId();
        source = resolvedSessionId ? 'single-in-flight' : '';
    }
    if (!resolvedSessionId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SESSION_ROUTE_DROP]', `event=${eventName || 'unknown'}`, 'reason=missing-session', `activeSessionId=${activeSessionId || 'null'}`]
        });
        console.warn(`[SessionGate] drop event=${eventName} missing sessionID`, message);
        return null;
    }
    const isActive = resolvedSessionId === activeSessionId;
    const shouldRender = options?.render === false ? false : isActive;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SESSION_ROUTE]', `event=${eventName || 'unknown'}`, `sessionId=${resolvedSessionId}`, `source=${source || 'unknown'}`, `active=${isActive ? 'true' : 'false'}`, `shouldRender=${shouldRender ? 'true' : 'false'}`]
    });
    return { sessionId: resolvedSessionId, source: source || 'unknown', isActive, shouldRender };
}

function getEventSessionId(message, eventName) {
    const route = resolveEventSessionId(message, eventName);
    return route?.sessionId || null;
}

function resolveParentVisibleSubagentRoute(message, eventName) {
    const parentSessionId = typeof message?.parentSessionId === 'string' ? message.parentSessionId : '';
    const agentSessionId = typeof message?.agentSessionId === 'string' ? message.agentSessionId : '';
    const displayTarget = typeof message?.displayTarget === 'string' ? message.displayTarget : '';
    const isActiveParent = parentSessionId === activeSessionId;
    const baseLog = [
        '[WV][SUBAGENT_ROUTE]',
        `event=${eventName || 'unknown'}`,
        `parentSessionId=${parentSessionId || 'null'}`,
        `agentSessionId=${agentSessionId || 'null'}`,
        `displayTarget=${displayTarget || 'null'}`,
        `activeSessionId=${activeSessionId || 'null'}`,
        `isActiveParent=${isActiveParent ? 'true' : 'false'}`
    ];
    if (!parentSessionId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [...baseLog, 'shouldRender=false', 'decision=drop', 'reason=missing-parentSessionId']
        });
        console.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=missing-parentSessionId`, message);
        return null;
    }
    if (displayTarget !== 'parent') {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [...baseLog, 'shouldRender=false', 'decision=drop', 'reason=displayTarget-not-parent']
        });
        console.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=displayTarget-not-parent parentSessionId=${parentSessionId}`, message);
        return null;
    }
    const shouldRender = isActiveParent;
    vscode.postMessage({
        type: 'ui-debug',
        payload: [
            ...baseLog,
            `shouldRender=${shouldRender ? 'true' : 'false'}`,
            `decision=${shouldRender ? 'render' : 'state-only'}`
        ]
    });
    return { parentSessionId, agentSessionId, displayTarget, isActiveParent, shouldRender };
}

function resolveAgentLaneSubagentRoute(message, eventName) {
    const parentSessionId = typeof message?.parentSessionId === 'string' ? message.parentSessionId : '';
    const agentSessionId = typeof message?.agentSessionId === 'string' ? message.agentSessionId : '';
    const payloadSessionId =
        (typeof message?.sessionID === 'string' && message.sessionID) ||
        (typeof message?.sessionId === 'string' && message.sessionId) ||
        (typeof message?.part?.sessionID === 'string' && message.part.sessionID) ||
        (typeof message?.part?.sessionId === 'string' && message.part.sessionId) ||
        '';
    const displayTarget = typeof message?.displayTarget === 'string' ? message.displayTarget : '';
    const isActiveAgent = agentSessionId === activeSessionId;
    const baseLog = [
        '[WV][SUBAGENT_ROUTE]',
        `event=${eventName || 'unknown'}`,
        `parentSessionId=${parentSessionId || 'null'}`,
        `agentSessionId=${agentSessionId || 'null'}`,
        `sessionId=${payloadSessionId || 'null'}`,
        `displayTarget=${displayTarget || 'null'}`,
        `activeSessionId=${activeSessionId || 'null'}`,
        `isActiveParent=${parentSessionId && parentSessionId === activeSessionId ? 'true' : 'false'}`,
        `isActiveAgent=${isActiveAgent ? 'true' : 'false'}`
    ];
    if (displayTarget !== 'agent-lane') {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [...baseLog, 'shouldRender=false', 'decision=drop', 'reason=displayTarget-not-agent-lane']
        });
        console.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=displayTarget-not-agent-lane displayTarget=${displayTarget || 'null'}`, message);
        return null;
    }
    if (!agentSessionId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [...baseLog, 'shouldRender=false', 'decision=drop', 'reason=missing-agentSessionId']
        });
        console.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=missing-agentSessionId`, message);
        return null;
    }
    const shouldRender = isActiveAgent;
    vscode.postMessage({
        type: 'ui-debug',
        payload: [
            ...baseLog,
            `targetSessionId=${agentSessionId}`,
            `shouldRender=${shouldRender ? 'true' : 'false'}`,
            `decision=${shouldRender ? 'render-agent-lane' : 'state-only-agent-lane'}`,
            payloadSessionId && payloadSessionId !== agentSessionId ? 'note=sessionId-ignored-agentSessionId-authoritative' : 'note=agentSessionId-authoritative'
        ]
    });
    return {
        sessionId: agentSessionId,
        parentSessionId,
        agentSessionId,
        displayTarget,
        source: 'agent-lane',
        isActive: isActiveAgent,
        isActiveAgent,
        shouldRender
    };
}

function resolveContentEventRoute(message, eventName) {
    if (message?.displayTarget === 'agent-lane') {
        return resolveAgentLaneSubagentRoute(message, eventName);
    }
    return resolveEventSessionId(message, eventName);
}

function retainAgentLaneParentAssociation(session, route) {
    if (!session || !route || route.displayTarget !== 'agent-lane') return;
    if (!session.meta) session.meta = {};
    session.meta.agentSessionId = route.agentSessionId;
    if (route.parentSessionId) {
        session.meta.parentSessionId = route.parentSessionId;
    }
}

function logBackgroundStateUpdate(sessionId, reason, options = {}) {
    if (!sessionId || sessionId === activeSessionId) return;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][BACKGROUND_STATE_UPDATE]', `event=${reason || 'unknown'}`, `sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, ...(Array.isArray(options.extra) ? options.extra : [])]
    });
}

function renderIfActive(sessionId, reason, options = {}) {
    const isActive = Boolean(sessionId && sessionId === activeSessionId);
    if (!isActive) {
        logBackgroundStateUpdate(sessionId, reason, options);
        return false;
    }
    window.__oc?.renderFromState?.(reason);
    if (options.scroll === true) {
        if (typeof window.__oc?.scrollToBottom === 'function') {
            window.__oc.scrollToBottom(options.forceScroll === true);
        } else if (typeof options.scrollFallback === 'function') {
            options.scrollFallback(options.forceScroll === true);
        }
    }
    return true;
}

function applySubagentStatusLocalPatch(sessionId, counts = {}) {
    if (!sessionId || sessionId !== activeSessionId) {
        return { applied: false, reason: 'inactive-session' };
    }
    const indicator = document.getElementById('subagent-indicator');
    if (indicator) {
        const runningCount = typeof counts.runningCount === 'number' ? counts.runningCount : 0;
        const finalizingCount = typeof counts.finalizingCount === 'number' ? counts.finalizingCount : 0;
        const doneJustNowCount = typeof counts.doneJustNowCount === 'number' ? counts.doneJustNowCount : 0;
        const hasIndicator = runningCount > 0 || finalizingCount > 0 || doneJustNowCount > 0;
        indicator.style.display = hasIndicator ? '' : 'none';
        if (runningCount > 0 || finalizingCount > 0) {
            indicator.textContent = `${runningCount} running / ${finalizingCount} finalizing`;
        } else {
            indicator.textContent = `Done just now (${doneJustNowCount})`;
        }
    }

    const session = getSessionState(sessionId);
    const currentThinking = session?.thinkingId ? session.messagesById.get(session.thinkingId) : null;
    if (!currentThinking || !currentThinking.meta?.isThinking) {
        return { applied: true, reason: indicator ? 'applied' : 'no-active-indicator' };
    }
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        return { applied: false, reason: 'missing-chat-container' };
    }
    const targetId = currentThinking.id || session.thinkingId || '';
    if (!targetId) {
        return { applied: false, reason: 'unclear-anchor' };
    }
    const targetBubble = chatContainer.querySelector(`.message.bot[data-message-id="${escapeMessageIdForSelector(targetId)}"]`);
    if (!targetBubble) {
        return { applied: false, reason: 'missing-target-bubble' };
    }
    if (Array.isArray(currentThinking.meta?.subagents) && currentThinking.meta.subagents.length) {
        return { applied: false, reason: 'unclear-anchor' };
    }
    return { applied: true, reason: indicator ? 'applied' : 'no-active-indicator' };
}

function handleSubagentStatusPatchResult(sessionId, result, source, fields = []) {
    logRenderStormMetric('subagent-status-local-patch', [
        `applied=${result?.applied === true ? 'true' : 'false'}`,
        `reason=${result?.reason || 'unknown'}`,
        `sessionId=${sessionId || 'null'}`,
        `source=${source || 'unknown'}`,
        ...fields
    ]);
    if (result?.applied === true) return true;
    const reason = result?.reason || 'unknown';
    if (reason === 'missing-target-bubble' || reason === 'unclear-anchor') {
        countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
        requestThrottledBackgroundFallbackRender(sessionId, `subagentStatus-${reason}`, [`source=${source || 'unknown'}`, ...fields]);
        return false;
    }
    if (reason === 'inactive-session') {
        suppressFallbackRender(`subagentStatus-${reason}`, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
        logBackgroundStateUpdate(sessionId, 'subagentStatus', { extra: [`apply=${reason}`, 'render=false', ...fields] });
        return false;
    }
    countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
    return false;
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

function isSendBlockedByPendingState(session) {
    if (!session) return false;
    return !session.turnFullyFinalized || session.backendTurnInFlight;
}

function isSessionBusy(sessionId) {
    if (!sessionId) return false;
    return isSendBlockedByPendingState(getSessionState(sessionId));
}

function isActiveSessionBusy() {
    return isSessionBusy(activeSessionId);
}

function syncSendButtonBusyVisual() {
    if (!sendBtn || !sendButtonSendIconHtml || !sendButtonStopIconHtml) return;
    const activeBusy = isActiveSessionBusy();
    const showsStopIcon = activeBusy && !appendInputMode;
    sendBtn.innerHTML = showsStopIcon ? sendButtonStopIconHtml : sendButtonSendIconHtml;
    sendBtn.classList.toggle('is-busy', showsStopIcon);
    if (showsStopIcon) {
        sendBtn.classList.remove('has-quota');
    }
}

function canSendAppendFromInput() {
    if (!appendInputMode || !activeSessionId) return false;
    if (appendInputMode.sessionId !== activeSessionId) return false;
    const session = getSessionState(activeSessionId);
    if (!session) return false;
    const root = session.messagesById?.get?.(appendInputMode.rootUserKey);
    if (!root || root.role !== 'user') return false;
    if (session.backendTurnInFlight !== true) return false;
    if (session.turnFullyFinalized === true) return false;
    if (session.canceledActiveTurn === true) return false;
    if (session.finalAssistantLock?.assistantMsgId) return false;
    if (!session.appendRootUserKey || root.id !== session.appendRootUserKey) return false;
    const appendItems = Array.isArray(root.meta?.appendedPrompts) ? root.meta.appendedPrompts : [];
    if (appendItems.some((item) => item && item.status === 'sending')) return false;
    return true;
}

function updateSendGate() {
    if (!sendBtn) return;
    syncSendButtonBusyVisual();
    if (appendInputMode) {
        const allowed = canSendAppendFromInput();
        sendBtn.disabled = !allowed;
        sendBtn.title = allowed ? '' : SEND_BLOCK_NOTICE;
        setSendBlockedNotice(allowed ? '' : SEND_BLOCK_NOTICE);
        return;
    }
    if (isActiveSessionBusy()) {
        sendBtn.disabled = false;
        setSendBlockedNotice('');
        return;
    }
    if (baselinePreparing) {
        sendBtn.disabled = true;
        sendBtn.title = BASELINE_PREPARING_NOTICE;
        setSendBlockedNotice('');
        return;
    }
    if (models.length === 0) {
        sendBtn.disabled = true;
        setSendBlockedNotice('');
        return;
    }
    const session = getSessionState(activeSessionId);
    const compactionRunning = Boolean(activeSessionId && compactionRunningBySession.has(activeSessionId));
    if (compactionRunning) {
        sendBtn.disabled = true;
        sendBtn.title = COMPACTION_RUNNING_NOTICE;
        setSendBlockedNotice(COMPACTION_RUNNING_NOTICE);
        return;
    }
    const blocked = isSendBlockedByPendingState(session);
    sendBtn.disabled = blocked;
    if (blocked) {
        sendBtn.title = SEND_BLOCK_NOTICE;
        setSendBlockedNotice(SEND_BLOCK_NOTICE);
    } else if (
        sendBtn.title === SEND_BLOCK_NOTICE
        || sendBtn.title === BASELINE_PREPARING_NOTICE
        || sendBtn.title === COMPACTION_RUNNING_NOTICE
    ) {
        sendBtn.title = '';
        setSendBlockedNotice('');
    }
}

function getEventChunkText(message) {
    function extractText(value, depth = 0) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
        if (!value || typeof value !== 'object' || depth > 2) {
            return '';
        }
        const nestedCandidates = [
            value.text,
            value.value,
            value.chunk,
            value.delta,
            value.content,
            value.part,
            value.message,
        ];
        for (const nested of nestedCandidates) {
            const found = extractText(nested, depth + 1);
            if (found.length > 0) {
                return found;
            }
        }
        return '';
    }

    const candidates = [
        message?.value,
        message?.text,
        message?.chunk,
        message?.delta,
        message?.part?.text,
        message?.part?.value,
        message?.part?.chunk,
        message?.part?.delta,
        message?.part?.content,
        message?.content,
    ];
    for (const value of candidates) {
        const text = extractText(value);
        if (text.length > 0) {
            return text;
        }
    }
    return '';
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

function handleUserAckBindMessage(message) {
    const sessionId = getEventSessionId(message, 'userAckBind');
    if (!sessionId) return false;

    const session = getSessionState(sessionId, true);
    const localKey = message?.localKey;
    const serverId = message?.msgId;

    registerMessageIdMapping(session, localKey, serverId, 'userAckBind');

    if (typeof localKey !== 'string' || typeof serverId !== 'string') return false;
    if (!localKey.startsWith('local-') || !serverId.startsWith('msg_')) return false;
    if (localKey === serverId) return false;

    const localMsg = session.messagesById?.get?.(localKey) || null;
    const existingServerMsg = session.messagesById?.get?.(serverId) || null;
    if (localMsg && localMsg.role !== 'user') {
        vscode.postMessage({ type: 'ui-debug', payload: ['userAckBind.upgrade', 'skipped', 'reason', 'local-not-user', 'localKey', localKey, 'serverId', serverId, 'sessionId', sessionId] });
        return false;
    }
    if (existingServerMsg && existingServerMsg.role !== 'user') {
        vscode.postMessage({ type: 'ui-debug', payload: ['userAckBind.upgrade', 'skipped', 'reason', 'collision-nonuser', 'localKey', localKey, 'serverId', serverId, 'sessionId', sessionId] });
        return false;
    }

    const hasLocalReferences = Boolean(
        localMsg
        || session.timeline?.includes?.(localKey)
        || session.appendRootUserKey === localKey
        || session.appendComposerFor === localKey
        || session.appendComposerDrafts?.has?.(localKey)
        || session.lastTurnUserId === localKey
    );
    if (!hasLocalReferences) return false;

    const previousAssistantKey = session.currentTurnAssistantKey;
    const previousAssistantMsgId = session.currentTurnAssistantMsgId;
    replaceKeyEverywhere(localKey, serverId, sessionId);
    if (previousAssistantKey && previousAssistantKey !== localKey) {
        session.currentTurnAssistantKey = previousAssistantKey;
    }
    if (previousAssistantMsgId && previousAssistantMsgId !== localKey) {
        session.currentTurnAssistantMsgId = previousAssistantMsgId;
    }
    syncAppendSnapshotMetadata(sessionId, 'userAckBind');
    return true;
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

function resolveSnapshotMessageKey(session, key) {
    if (!session || typeof key !== 'string' || !key.length) return null;
    if (key.startsWith('local-')) {
        return toStableMessageKey(session, key);
    }
    if (key.startsWith('tmp:')) {
        const pending = session.pendingAssistantUpgrade;
        if (pending?.tmpKey === key && typeof pending.assistantMsgId === 'string' && pending.assistantMsgId.startsWith('msg_')) {
            return pending.assistantMsgId;
        }
        const finalAssistantId =
            (typeof session.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId) ||
            (typeof session.earlyFinalAssistantId === 'string' && session.earlyFinalAssistantId) ||
            null;
        const message = session.messagesById?.get?.(key);
        if (message?.role === 'assistant' && finalAssistantId && session.messagesById?.has?.(finalAssistantId)) {
            return finalAssistantId;
        }
    }
    return key;
}

function sanitizeAppendSnapshotItem(item, session) {
    if (!item || typeof item !== 'object') return null;
    const out = {};
    const copyString = (name, maxLen = 20000) => {
        const value = item[name];
        if (typeof value === 'string' && value.length > 0) out[name] = value.slice(0, maxLen);
    };
    copyString('clientMessageId', 512);
    copyString('status', 64);
    copyString('reason', 1000);
    copyString('text', 20000);
    const appendUserMsgId = resolveSnapshotMessageKey(session, item.appendUserMsgId) || item.appendUserMsgId;
    if (typeof appendUserMsgId === 'string' && appendUserMsgId.length && !appendUserMsgId.startsWith('local-') && !appendUserMsgId.startsWith('tmp:')) {
        out.appendUserMsgId = appendUserMsgId;
    }
    const rootUserMsgId = resolveSnapshotMessageKey(session, item.rootUserMsgId) || item.rootUserMsgId;
    if (typeof rootUserMsgId === 'string' && rootUserMsgId.length && !rootUserMsgId.startsWith('local-') && !rootUserMsgId.startsWith('tmp:')) {
        out.rootUserMsgId = rootUserMsgId;
    }
    if (typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)) out.createdAt = item.createdAt;
    if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) out.updatedAt = item.updatedAt;
    return Object.keys(out).length ? out : null;
}

function sanitizeAppendSnapshotItems(items, session) {
    if (!Array.isArray(items)) return [];
    const out = [];
    const seen = new Set();
    for (const item of items) {
        const sanitized = sanitizeAppendSnapshotItem(item, session);
        if (!sanitized) continue;
        const dedupeKey = sanitized.clientMessageId || sanitized.appendUserMsgId || `${out.length}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(sanitized);
    }
    return out;
}

function normalizeAppendItemsForFinalize(items) {
    if (!Array.isArray(items)) return { items: [], changed: false };
    let changed = false;
    const normalized = items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        if (item.status === 'applied' || item.status === 'failed' || item.status === 'rejected') {
            return item;
        }
        if (item.status === 'seen' || ((item.status === 'queued' || item.status === 'sending') && item.appendUserMsgId)) {
            changed = true;
            return { ...item, status: 'applied' };
        }
        if (item.status === 'sending' || item.status === 'queued') {
            changed = true;
            return { ...item, status: 'failed', reason: item.reason || 'append-not-acknowledged' };
        }
        return item;
    });
    return { items: normalized, changed };
}

function normalizeSessionAppendItemsForFinalize(session) {
    if (!session || !(session.messagesById instanceof Map)) return false;
    let changed = false;
    for (const message of session.messagesById.values()) {
        if (!message || message.role !== 'user') continue;
        if (!Array.isArray(message.meta?.appendedPrompts)) continue;
        const result = normalizeAppendItemsForFinalize(message.meta.appendedPrompts);
        if (!result.changed) continue;
        message.meta = { ...(message.meta || {}), appendedPrompts: result.items };
        changed = true;
    }
    return changed;
}

function collectAppendSnapshotMetadata(session) {
    if (!session || !(session.messagesById instanceof Map)) return [];
    const entries = [];
    const seenRoots = new Set();
    for (const message of session.messagesById.values()) {
        if (!message || message.role !== 'user') continue;
        const items = sanitizeAppendSnapshotItems(message.meta?.appendedPrompts, session);
        if (!items.length) continue;
        const rootMessageId = resolveSnapshotMessageKey(session, message.id) || message.id;
        if (typeof rootMessageId !== 'string' || !rootMessageId.length || rootMessageId.startsWith('local-') || rootMessageId.startsWith('tmp:')) continue;
        if (seenRoots.has(rootMessageId)) continue;
        seenRoots.add(rootMessageId);
        entries.push({ rootMessageId, appendRootUserKey: rootMessageId, meta: { appendedPrompts: items } });
    }
    return entries;
}

function hasProtectedInflightAppendRoot(session) {
    if (!session || !(session.messagesById instanceof Map)) return false;
    if (session.backendTurnInFlight !== true) return false;
    if (session.turnFullyFinalized === true) return false;
    if (session.canceledActiveTurn === true) return false;
    if (typeof session.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId.length) return false;

    const key = session.appendRootUserKey;
    if (typeof key !== 'string' || !key.length) return false;

    const candidates = new Set([key]);
    const resolved = resolveSnapshotMessageKey(session, key);
    if (typeof resolved === 'string' && resolved.length) candidates.add(resolved);
    const mappedServer = session.clientKeyToServerId?.get?.(key);
    if (typeof mappedServer === 'string' && mappedServer.length) candidates.add(mappedServer);
    const mappedClient = session.serverIdToClientKey?.get?.(key);
    if (typeof mappedClient === 'string' && mappedClient.length) candidates.add(mappedClient);

    for (const candidate of candidates) {
        const message = session.messagesById.get(candidate);
        if (message?.role === 'user') return true;
    }
    return false;
}

function syncAppendSnapshotMetadata(sessionId, reason = 'unknown') {
    if (typeof sessionId !== 'string' || !sessionId.length) return;
    const session = getSessionState(sessionId);
    if (!session) return;
    const roots = collectAppendSnapshotMetadata(session);
    if (!roots.length) return;
    vscode.postMessage({ type: 'appendSnapshotMeta', sessionId, roots, reason });
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][APPEND_SNAPSHOT_META]', `sessionId=${sessionId}`, `reason=${reason}`, `rootCount=${roots.length}`, `appendCount=${roots.reduce((sum, root) => sum + (Array.isArray(root.meta?.appendedPrompts) ? root.meta.appendedPrompts.length : 0), 0)}`]
    });
}

function restoreAppendHydrationMetadata(sessionId, session) {
    if (!session || !(session.messagesById instanceof Map)) return { rootCount: 0, appendCount: 0, restoredRootUserKey: '' };
    let rootCount = 0;
    let appendCount = 0;
    let restoredRootUserKey = '';
    const protectInflightAppendRoot = hasProtectedInflightAppendRoot(session);
    const shouldNormalizeFinalizedAppendItems = session.turnFullyFinalized === true;
    for (const message of session.messagesById.values()) {
        if (!message || message.role !== 'user') continue;
        let items = sanitizeAppendSnapshotItems(message.meta?.appendedPrompts, session);
        if (!items.length) continue;
        if (shouldNormalizeFinalizedAppendItems) {
            items = normalizeAppendItemsForFinalize(items).items;
        }
        message.meta = { ...(message.meta || {}), appendedPrompts: items };
        rootCount++;
        appendCount += items.length;
        if (!restoredRootUserKey && typeof message.id === 'string' && message.id.length && !message.id.startsWith('local-') && !message.id.startsWith('tmp:')) {
            restoredRootUserKey = message.id;
        }
    }
    if (restoredRootUserKey && !protectInflightAppendRoot) session.appendRootUserKey = restoredRootUserKey;
    if (rootCount > 0) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPEND_HYDRATE_META]', `sessionId=${sessionId || 'null'}`, `rootCount=${rootCount}`, `appendCount=${appendCount}`, `appendRootUserKey=${restoredRootUserKey || 'null'}`]
        });
    }
    return { rootCount, appendCount, restoredRootUserKey };
}

function getPresentationMessageKeyVariants(session, key) {
    const variants = new Set();
    if (!session || typeof key !== 'string' || !key.length) return variants;

    variants.add(key);
    const resolved = resolveSnapshotMessageKey(session, key);
    if (typeof resolved === 'string' && resolved.length) variants.add(resolved);
    const stable = toStableMessageKey(session, key);
    if (typeof stable === 'string' && stable.length) variants.add(stable);

    const mappedServer = session.clientKeyToServerId?.get?.(key);
    if (typeof mappedServer === 'string' && mappedServer.length) variants.add(mappedServer);
    const mappedClient = session.serverIdToClientKey?.get?.(key);
    if (typeof mappedClient === 'string' && mappedClient.length) variants.add(mappedClient);

    for (const candidate of Array.from(variants)) {
        const serverAlias = session.clientKeyToServerId?.get?.(candidate);
        if (typeof serverAlias === 'string' && serverAlias.length) variants.add(serverAlias);
        const clientAlias = session.serverIdToClientKey?.get?.(candidate);
        if (typeof clientAlias === 'string' && clientAlias.length) variants.add(clientAlias);
    }

    return variants;
}

function addAppendChildPresentationEntry(index, childId, rootId) {
    if (typeof childId !== 'string' || !childId.length) return;
    if (!index.has(childId)) index.set(childId, new Set());
    if (typeof rootId === 'string' && rootId.length) {
        index.get(childId).add(rootId);
    }
}

function getAppendPresentationParentId(message) {
    return (
        (typeof message?.parentId === 'string' && message.parentId) ||
        (typeof message?.parentID === 'string' && message.parentID) ||
        (typeof message?.parentMessageId === 'string' && message.parentMessageId) ||
        (typeof message?.meta?.parentId === 'string' && message.meta.parentId) ||
        (typeof message?.meta?.parentID === 'string' && message.meta.parentID) ||
        ''
    );
}

function addPresentationKeyVariants(session, targetSet, key) {
    if (!(targetSet instanceof Set) || typeof key !== 'string' || !key.length) return;
    targetSet.add(key);
    for (const candidate of getPresentationMessageKeyVariants(session, key)) {
        targetSet.add(candidate);
    }
}

function buildAppendChainAssistantHiddenKeys(session, hiddenParentKeys) {
    const hiddenAssistantKeys = new Set();
    if (!session || !(session.messagesById instanceof Map) || !(hiddenParentKeys instanceof Set) || hiddenParentKeys.size === 0) {
        return hiddenAssistantKeys;
    }

    for (const [messageKey, message] of session.messagesById.entries()) {
        if (!message || message.role !== 'assistant') continue;
        const parentId = getAppendPresentationParentId(message);
        if (typeof parentId !== 'string' || !parentId.length) continue;

        let parentMatchesAppendChain = false;
        for (const candidate of getPresentationMessageKeyVariants(session, parentId)) {
            if (hiddenParentKeys.has(candidate)) {
                parentMatchesAppendChain = true;
                break;
            }
        }
        if (!parentMatchesAppendChain && hiddenParentKeys.has(parentId)) {
            parentMatchesAppendChain = true;
        }
        if (!parentMatchesAppendChain) continue;

        if (typeof messageKey === 'string' && messageKey.length) {
            addPresentationKeyVariants(session, hiddenAssistantKeys, messageKey);
        }
        if (typeof message.id === 'string' && message.id.length) {
            addPresentationKeyVariants(session, hiddenAssistantKeys, message.id);
        }
    }

    return hiddenAssistantKeys;
}

function buildAppendChildPresentationIndex(session) {
    const index = new Map();
    if (!session || !(session.messagesById instanceof Map)) return index;

    const hiddenAssistantParentKeys = new Set();

    for (const root of session.messagesById.values()) {
        if (!root || root.role !== 'user') continue;
        const items = Array.isArray(root.meta?.appendedPrompts) ? root.meta.appendedPrompts : [];
        const appendUserIds = items
            .map((item) => item?.appendUserMsgId)
            .filter((appendUserMsgId) => typeof appendUserMsgId === 'string' && appendUserMsgId.length);
        if (!appendUserIds.length) continue;

        const rootId = typeof root.id === 'string' ? root.id : '';
        addPresentationKeyVariants(session, hiddenAssistantParentKeys, rootId);
        for (let i = 0; i < appendUserIds.length - 1; i++) {
            addPresentationKeyVariants(session, hiddenAssistantParentKeys, appendUserIds[i]);
        }
        for (const appendUserMsgId of appendUserIds) {
            const childVariants = getPresentationMessageKeyVariants(session, appendUserMsgId);
            if (!childVariants.size) childVariants.add(appendUserMsgId);
            for (const childId of childVariants) {
                addAppendChildPresentationEntry(index, childId, rootId);
            }
        }
    }

    index.appendChainAssistantHiddenKeys = buildAppendChainAssistantHiddenKeys(session, hiddenAssistantParentKeys);

    return index;
}

function isAppendChildTopLevelUser(session, msg, id, appendChildPresentationIndex) {
    if (!session || !msg || msg.role !== 'user') return false;
    const index = appendChildPresentationIndex instanceof Map
        ? appendChildPresentationIndex
        : buildAppendChildPresentationIndex(session);
    const candidates = new Set();
    if (typeof id === 'string' && id.length) {
        for (const candidate of getPresentationMessageKeyVariants(session, id)) candidates.add(candidate);
        candidates.add(id);
    }
    if (typeof msg.id === 'string' && msg.id.length) {
        for (const candidate of getPresentationMessageKeyVariants(session, msg.id)) candidates.add(candidate);
        candidates.add(msg.id);
    }

    for (const candidate of candidates) {
        const roots = index.get(candidate);
        if (!roots || roots.size === 0) continue;
        if (!roots.has(candidate)) return true;
        if (typeof id === 'string' && !roots.has(id)) return true;
        if (typeof msg.id === 'string' && !roots.has(msg.id)) return true;
    }
    return false;
}

function isAppendChainTopLevelAssistantHidden(session, msg, id, appendChildPresentationIndex) {
    if (!session || !msg || msg.role !== 'assistant') return false;
    const index = appendChildPresentationIndex instanceof Map
        ? appendChildPresentationIndex
        : buildAppendChildPresentationIndex(session);
    const hiddenAssistantKeys = index?.appendChainAssistantHiddenKeys;
    if (!(hiddenAssistantKeys instanceof Set) || hiddenAssistantKeys.size === 0) return false;

    const candidates = new Set();
    if (typeof id === 'string' && id.length) {
        addPresentationKeyVariants(session, candidates, id);
    }
    if (typeof msg.id === 'string' && msg.id.length) {
        addPresentationKeyVariants(session, candidates, msg.id);
    }

    for (const candidate of candidates) {
        if (hiddenAssistantKeys.has(candidate)) return true;
    }
    return false;
}

function buildCanonicalSnapshotEntries(session, keys) {
    const entries = [];
    const unresolved = [];
    const seen = new Set();
    const sourceByCanonicalId = new Map();
    for (const key of Array.isArray(keys) ? keys : []) {
        if (typeof key !== 'string' || !key.length) continue;
        const canonicalId = resolveSnapshotMessageKey(session, key);
        if (!canonicalId || canonicalId.startsWith('local-') || canonicalId.startsWith('tmp:')) {
            unresolved.push(key);
            continue;
        }
        if (seen.has(canonicalId)) continue;
        seen.add(canonicalId);
        sourceByCanonicalId.set(canonicalId, key);
        entries.push(canonicalId);
    }
    return { entries, unresolved, sourceByCanonicalId };
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
    const text = typeof payload.text === 'string' ? payload.text : '';
    const normalizedText = text.trimStart();
    const isSystemDcpMessage = payload.role === 'system'
        && normalizedText.startsWith('\u25A3')
        && normalizedText.includes('DCP');
    if (isSystemDcpMessage) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][FILTER]', 'DCP-system-message-filtered', `id=${payload.id}`]
        });
        return;
    }
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

function placeMessageAfterAnchor(session, messageId, anchorMessageId, source) {
    if (!session || typeof messageId !== 'string' || typeof anchorMessageId !== 'string') return false;
    if (!session.messagesById?.has?.(messageId)) return false;
    const stableAnchorId = toStableMessageKey(session, anchorMessageId) || anchorMessageId;
    if (stableAnchorId === messageId || !session.messagesById.has(stableAnchorId)) return false;
    const anchorIndex = session.timeline.indexOf(stableAnchorId);
    if (anchorIndex < 0) return false;

    session.timeline = session.timeline.filter((id) => id !== messageId);
    const nextAnchorIndex = session.timeline.indexOf(stableAnchorId);
    if (nextAnchorIndex < 0) return false;
    session.timeline.splice(nextAnchorIndex + 1, 0, messageId);
    logTimelineSnapshot('anchor-place', session.timeline, `key=${messageId} anchor=${stableAnchorId} source=${source || 'unknown'}`);
    return true;
}

function isChangeListSessionMessage(item) {
    if (!item || typeof item.id !== 'string' || !item.id.length) return false;
    return item.meta?.kind === 'changeList' || item.id.startsWith('system:changeList:');
}

function materializeInjectedChangeLists(session, rawSessionMessages, source = 'sessionData') {
    if (!session || !Array.isArray(rawSessionMessages) || !rawSessionMessages.length) {
        return { seen: 0, alreadyTimeline: 0, materialized: 0, insertedAfter: 0, appended: 0, skippedNoFiles: 0 };
    }

    const stats = { seen: 0, alreadyTimeline: 0, materialized: 0, insertedAfter: 0, appended: 0, skippedNoFiles: 0 };
    const findNearestPriorTimelineId = (index) => {
        for (let i = index - 1; i >= 0; i--) {
            const priorId = rawSessionMessages[i]?.id;
            if (typeof priorId !== 'string' || !priorId.length) continue;
            const stablePriorId = toStableMessageKey(session, priorId) || priorId;
            if (session.timeline.includes(stablePriorId)) return stablePriorId;
        }
        return '';
    };

    rawSessionMessages.forEach((item, index) => {
        if (!isChangeListSessionMessage(item)) return;
        stats.seen++;
        const id = item.id;
        const files = Array.isArray(item.meta?.files)
            ? item.meta.files.filter((file) => typeof file === 'string' && file.length)
            : [];
        if (!files.length) {
            stats.skippedNoFiles++;
            return;
        }

        const existing = session.messagesById.get(id);
        const message = {
            ...(existing || {}),
            id,
            role: item.role || existing?.role || 'system',
            text: typeof item.text === 'string' ? item.text : (existing?.text || ''),
            meta: {
                ...(existing?.meta || {}),
                ...(item.meta || {}),
                kind: 'changeList',
                files
            },
            order: existing?.order ?? session.nextOrder++
        };
        session.messagesById.set(id, message);

        if (session.timeline.includes(id)) {
            stats.alreadyTimeline++;
            return;
        }

        const anchorId = typeof message.meta?.stableAnchorMessageId === 'string' && session.timeline.includes(message.meta.stableAnchorMessageId)
            ? message.meta.stableAnchorMessageId
            : (typeof message.meta?.anchorMessageId === 'string'
                ? (toStableMessageKey(session, message.meta.anchorMessageId) || message.meta.anchorMessageId)
                : findNearestPriorTimelineId(index));
        if (anchorId && session.timeline.includes(anchorId)) {
            const anchorIndex = session.timeline.indexOf(anchorId);
            session.timeline.splice(anchorIndex + 1, 0, id);
            stats.insertedAfter++;
        } else {
            session.timeline.push(id);
            stats.appended++;
        }
        stats.materialized++;
    });

    if (stats.seen || stats.materialized) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][CHANGELIST_MATERIALIZE]',
                `source=${source}`,
                `seen=${stats.seen}`,
                `alreadyTimeline=${stats.alreadyTimeline}`,
                `materialized=${stats.materialized}`,
                `insertedAfter=${stats.insertedAfter}`,
                `appended=${stats.appended}`,
                `skippedNoFiles=${stats.skippedNoFiles}`,
                `timelineSize=${session.timeline.length}`]
        });
    }

    return stats;
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
    
    if (endIdx < anchorIdx) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][COMPUTE_MEMBERS]', 'inverted-range-drop',
                `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`, 
                `anchorIdx=${anchorIdx}`, `endIdx=${endIdx}`]
        });
        return [];
    }

    // If end not found or invalid, degrade to single-item interval [anchor, anchor]
    if (endIdx === -1) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][COMPUTE_MEMBERS]', 'end-missing', 
                `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`, 
                'degrade-to-anchor-only']
        });
        return typeof anchorMsgId === 'string' && anchorMsgId.startsWith('msg_') ? [anchorMsgId] : [];
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
    const mappedServer = session.clientKeyToServerId?.get(messageId);
    if (mappedServer && session.timeline.includes(mappedServer)) return mappedServer;
    if (session.timeline.includes(messageId)) return messageId;
    const mappedLocal = session.serverIdToClientKey?.get(messageId);
    if (mappedLocal && session.timeline.includes(mappedLocal)) return mappedLocal;
    return null;
}

function normalizeSegmentMembersFromTimeline(session, anchorMsgId, endMsgId, candidateMsgIds, noticeKey) {
    const explicitMemberMsgIds = Array.isArray(candidateMsgIds)
        ? candidateMsgIds
            .map((id) => resolveSegmentMessageId(session, id) || id)
            .filter((id) => typeof id === 'string' && id.startsWith('msg_'))
        : [];
    if (explicitMemberMsgIds.length) {
        const deduped = [];
        const seen = new Set();
        for (const id of explicitMemberMsgIds) {
            if (seen.has(id)) continue;
            seen.add(id);
            deduped.push(id);
        }
        const resolvedAnchor = resolveSegmentMessageId(session, anchorMsgId) || deduped[0];
        const resolvedEnd = resolveSegmentMessageId(session, endMsgId) || deduped[deduped.length - 1] || resolvedAnchor;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEG_MEMBERS]', 'source=explicit',
                `noticeKey=${noticeKey || 'null'}`,
                `anchor=${resolvedAnchor || 'null'}`,
                `end=${resolvedEnd || 'null'}`,
                `count=${deduped.length}`]
        });
        return {
            anchorMsgId: deduped[0] || resolvedAnchor,
            endMsgId: deduped[deduped.length - 1] || resolvedEnd,
            memberMsgIds: deduped
        };
    }

    const resolvedAnchor = resolveSegmentMessageId(session, anchorMsgId);
    if (!resolvedAnchor) {
        return { anchorMsgId: null, endMsgId: null, memberMsgIds: [] };
    }

    const resolvedEnd = resolveSegmentMessageId(session, endMsgId) || resolvedAnchor;
    const resolvedAnchorIdx = session.timeline.indexOf(resolvedAnchor);
    const resolvedEndIdx = session.timeline.indexOf(resolvedEnd);
    if (resolvedEndIdx >= 0 && resolvedEndIdx < resolvedAnchorIdx) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEG_MEMBERS]', 'source=timeline', 'inverted-range-drop',
                `noticeKey=${noticeKey || 'null'}`,
                `anchor=${resolvedAnchor}`,
                `end=${resolvedEnd}`,
                `anchorIdx=${resolvedAnchorIdx}`,
                `endIdx=${resolvedEndIdx}`]
        });
        return { anchorMsgId: resolvedAnchor, endMsgId: resolvedEnd, memberMsgIds: [] };
    }
    let memberMsgIds = computeMemberMsgIdsFromTimeline(session, resolvedAnchor, resolvedEnd);
    if (memberMsgIds.length === 0 && typeof resolvedAnchor === 'string' && resolvedAnchor.startsWith('msg_')) {
        memberMsgIds = [resolvedAnchor];
    }

    if (Array.isArray(candidateMsgIds) && candidateMsgIds.length) {
        const candidateSet = new Set(candidateMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_')));
        const normalizedSet = new Set(memberMsgIds);
        let dropped = 0;
        for (const id of candidateSet) {
            if (!normalizedSet.has(id)) dropped++;
        }
        if (dropped > 0) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_NORMALIZE_DROP]',
                    `noticeKey=${noticeKey || 'null'}`,
                    `dropped=${dropped}`,
                    `anchor=${resolvedAnchor}`,
                    `end=${resolvedEnd}`]
            });
        }
    }

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_MEMBERS]', 'source=timeline',
            `noticeKey=${noticeKey || 'null'}`,
            `anchor=${resolvedAnchor || 'null'}`,
            `end=${resolvedEnd || 'null'}`,
            `count=${memberMsgIds.length}`]
    });

    return {
        anchorMsgId: resolvedAnchor,
        endMsgId: resolvedEnd,
        memberMsgIds
    };
}

function sanitizeMergedSegmentSnapshot(seg) {
    if (!seg || typeof seg.noticeKey !== 'string') return null;
    const memberMsgIds = Array.isArray(seg.memberMsgIds)
        ? seg.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
        : [];
    const anchorMsgId = typeof seg.anchorMsgId === 'string' && seg.anchorMsgId.startsWith('msg_')
        ? seg.anchorMsgId
        : (memberMsgIds[0] || '');
    const endMsgId = typeof seg.endMsgId === 'string' && seg.endMsgId.startsWith('msg_')
        ? seg.endMsgId
        : (memberMsgIds[memberMsgIds.length - 1] || anchorMsgId);
    if (!anchorMsgId || memberMsgIds.length === 0) return null;
    return {
        noticeKey: seg.noticeKey,
        anchorMsgId,
        endMsgId,
        memberMsgIds,
        applied: seg.applied ?? true,
        restoreAllowed: seg.restoreAllowed === false ? false : true,
        collapsed: seg.collapsed !== false,
        mergedInvalidSegments: [],
        createdAt: typeof seg.createdAt === 'number' ? seg.createdAt : Date.now(),
        updatedAt: typeof seg.updatedAt === 'number' ? seg.updatedAt : Date.now()
    };
}

function isHiddenControlUserText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (trimmed.startsWith('[OC_UI_AUTORESUME')) return true;
    if (trimmed === '/stop-continuation') return true;
    if (trimmed.includes('<auto-slash-command>') && trimmed.includes('/stop-continuation Command')) return true;
    if (trimmed.includes('<command-instruction>') && trimmed.toLowerCase().includes('stop all continuation mechanisms')) return true;
    return text.includes('<!-- OMO_INTERNAL_INITIATOR -->')
        && (
            text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
            || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
        );
}

function isHiddenControlAssistantText(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    return trimmed.includes('All continuation mechanisms have been stopped for this session')
        || trimmed.includes('All continuation mechanisms stopped for this session:')
        || (lower.includes('continuation') && lower.includes('stopped'));
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
        if (!segment.collapsed) continue;

        const memberMsgIds = Array.isArray(segment.memberMsgIds)
            ? segment.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        if (memberMsgIds.length === 0) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_SKIP_EMPTY_MEMBERS]', `noticeKey=${noticeKey}`]
            });
            skippedCount++;
            continue;
        }

        // Derive anchor/end from authoritative members. Do not depend on timeline presence.
        segment.anchorMsgId = memberMsgIds[0];
        segment.endMsgId = memberMsgIds[memberMsgIds.length - 1];
        segment.memberMsgIds = memberMsgIds;

        for (const msgId of memberMsgIds) {
            if (typeof msgId === 'string' && msgId.startsWith('system:undo-seg:')) continue;
            if (!session.messagesById.has(msgId)) continue;
            session.hiddenSet.add(msgId);
        }
        processedCount++;
    }

    for (const msgId of session.timeline) {
        if (typeof msgId !== 'string') continue;
        const message = session.messagesById.get(msgId);
        if (!message || message.role !== 'user') continue;
        if (message.meta?.syntheticUser === true) {
            session.hiddenSet.add(msgId);
            continue;
        }
        if (isHiddenControlUserText(message.text)) {
            session.hiddenSet.add(msgId);
        }
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

function discardAllSegments(sessionId, reason, mode, options = {}) {
    const session = getSessionState(sessionId);
    if (!session) return 0;
    const anchorMsgId = typeof options.anchorMsgId === 'string' ? options.anchorMsgId : '';
    const anchorIndex = anchorMsgId ? session.timeline.indexOf(anchorMsgId) : -1;
    let count = 0;
    for (const segment of session.segmentsByNoticeKey.values()) {
        if (anchorIndex >= 0) {
            const segAnchorIndex = segment.anchorMsgId ? session.timeline.indexOf(segment.anchorMsgId) : -1;
            if (segAnchorIndex < 0 || segAnchorIndex >= anchorIndex) {
                continue;
            }
        }
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
        payload: ['[WV][SEG_DISCARD]', `reason=${reason}`, `count=${count}`, `sessionId=${sessionId || 'null'}`, `mode=${mode || 'null'}`, `anchorMsgId=${anchorMsgId || 'null'}`, `anchorIndex=${anchorIndex}`]
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
    const beforeSize = session.timeline.length;
    const anchorIndex = anchorMsgId ? session.timeline.indexOf(anchorMsgId) : -1;
    const endIndex = endMsgId ? session.timeline.indexOf(endMsgId) : -1;
    let action = 'append';

    // Keep stable ordering: if a placeholder slot already exists in timeline
    // (typically from snapshot meta.timelineMessageIds), do not relocate it.
    if (existingIndex !== -1) {
        session.timeline[existingIndex] = placeholderId;
        action = 'keep-existing-slot';
    } else if (anchorIndex !== -1) {
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
        const memberMsgIds = Array.isArray(seg.memberMsgIds)
            ? seg.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        if (!seg.noticeKey || memberMsgIds.length === 0) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_HYDRATE_SKIP]', 'missing-required-fields', 
                    `noticeKey=${seg.noticeKey || 'null'}`,
                    `members=${memberMsgIds.length}`]
            });
            continue;
        }
        const mergedInvalidSegments = Array.isArray(seg.mergedInvalidSegments)
            ? seg.mergedInvalidSegments
                .filter((child) => child && typeof child.noticeKey === 'string')
                .map((child) => sanitizeMergedSegmentSnapshot(child))
                .filter(Boolean)
            : [];
        session.segmentsByNoticeKey.set(seg.noticeKey, {
            noticeKey: seg.noticeKey,
            anchorMsgId: memberMsgIds[0],
            endMsgId: memberMsgIds[memberMsgIds.length - 1],
            memberMsgIds,
            mergedInvalidSegments,
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

function replaceKeyEverywhere(oldId, newId, sessionId = activeSessionId) {
    const session = getSessionState(sessionId);
    if (!session) return;

    const preReplaceCurrentTurnAssistantKey = session.currentTurnAssistantKey;
    const preReplaceThinkingId = session.thinkingId;
    const preReplaceCurrentTurnAssistantMsgId = session.currentTurnAssistantMsgId;

    if (typeof oldId === 'string' && typeof newId === 'string' && oldId.startsWith('local-') && newId === session.currentTurnAssistantMsgId) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['reject.user->assistant-id', 'oldKey', oldId, 'newKey', newId, 'sessionId', sessionId]
        });
        return;
    }

    const message = session.messagesById.get(oldId) || null;
    const existing = session.messagesById.get(newId) || null;

    let timelineIndex = -1;
    let timelineReplaced = false;
    let deduped = false;

    const pickCompleteMessage = (primary, secondary) => {
        if (!primary) return secondary || null;
        if (!secondary) return primary || null;
        const primaryText = typeof primary.text === 'string' ? primary.text : '';
        const secondaryText = typeof secondary.text === 'string' ? secondary.text : '';
        if (primaryText.length !== secondaryText.length) {
            return primaryText.length > secondaryText.length ? primary : secondary;
        }
        const primarySegments = Array.isArray(primary.meta?.textSegments) ? primary.meta.textSegments.length : 0;
        const secondarySegments = Array.isArray(secondary.meta?.textSegments) ? secondary.meta.textSegments.length : 0;
        if (primarySegments !== secondarySegments) {
            return primarySegments > secondarySegments ? primary : secondary;
        }
        const primaryThinking = primary.meta?.isThinking === true;
        const secondaryThinking = secondary.meta?.isThinking === true;
        if (primaryThinking !== secondaryThinking) {
            return primaryThinking ? secondary : primary;
        }
        const primaryOrder = typeof primary.order === 'number' ? primary.order : -1;
        const secondaryOrder = typeof secondary.order === 'number' ? secondary.order : -1;
        return primaryOrder >= secondaryOrder ? primary : secondary;
    };

    if (message) {
        session.messagesById.delete(oldId);
        if (!existing) {
            message.id = newId;
            session.messagesById.set(newId, message);
        } else {
            const selected = pickCompleteMessage(message, existing);
            if (selected) {
                selected.id = newId;
                session.messagesById.set(newId, selected);
            }
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

    if (session.lastTurnUserId === oldId) {
        session.lastTurnUserId = newId;
    }
    if (session.appendRootUserKey === oldId) {
        session.appendRootUserKey = newId;
    }
    if (session.appendComposerFor === oldId) {
        session.appendComposerFor = newId;
    }
    if (session.appendComposerDrafts?.has?.(oldId)) {
        const draft = session.appendComposerDrafts.get(oldId);
        session.appendComposerDrafts.delete(oldId);
        session.appendComposerDrafts.set(newId, draft);
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

    const replacedTmpLocalAssistant = typeof oldId === 'string'
        && typeof newId === 'string'
        && (oldId.startsWith('tmp:') || oldId.startsWith('local-'))
        && newId.startsWith('msg_')
        && (
            message?.role === 'assistant'
            || existing?.role === 'assistant'
            || preReplaceCurrentTurnAssistantKey === oldId
            || preReplaceThinkingId === oldId
        );
    if (replacedTmpLocalAssistant) {
        const recentAliases = Array.isArray(session.recentAssistantDomTargetAliases)
            ? session.recentAssistantDomTargetAliases
            : [];
        recentAliases.push({
            oldKey: oldId,
            newKey: newId,
            sessionId,
            source: 'replaceKeyEverywhere',
            ts: Date.now(),
            turnAnchor: preReplaceCurrentTurnAssistantKey || preReplaceThinkingId || oldId,
            assistantMsgId: preReplaceCurrentTurnAssistantMsgId || newId
        });
        session.recentAssistantDomTargetAliases = recentAliases.slice(-6);
    }

    const timelineSample = session.timeline.slice(0, 5);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['replaceKeyEverywhere', 'oldKey', oldId, 'newKey', newId,
            'timelineIndex', timelineIndex,
            'timelineReplaced', timelineReplaced,
            'deduped', deduped,
            'sessionId', sessionId,
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
    
    const payloadMemberMsgIds = Array.isArray(payload.messageIds)
        ? payload.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
        : [];

    // Compute memberMsgIds strictly from timeline range
    const normalizedSegment = normalizeSegmentMembersFromTimeline(
        session,
        anchorMsgId,
        endMsgId,
        payloadMemberMsgIds,
        noticeKey
    );
    const normalizedAnchorMsgId = normalizedSegment.anchorMsgId || anchorMsgId;
    const normalizedEndMsgId = normalizedSegment.endMsgId || normalizedAnchorMsgId;
    const memberMsgIds = normalizedSegment.memberMsgIds;
    const mergedInvalidSegments = Array.isArray(payload.mergedInvalidSegments)
        ? payload.mergedInvalidSegments
            .map((child) => sanitizeMergedSegmentSnapshot(child))
            .filter(Boolean)
        : [];
    
    if (memberMsgIds.length === 0) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][APPLY_REVERTED_WARN]', 'reason=no-members-computed',
                `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`]
        });
        return;
    }
    
    // Store segment locally
    session.segmentsByNoticeKey.set(noticeKey, {
        noticeKey,
        anchorMsgId: normalizedAnchorMsgId,
        endMsgId: normalizedEndMsgId,
        memberMsgIds,
        mergedInvalidSegments,
        applied: payload?.applied ?? true,
        restoreAllowed: payload?.restoreAllowed === false ? false : true,
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
            anchorMsgId: normalizedAnchorMsgId,
            endMsgId: normalizedEndMsgId,
            memberMsgIds,
            mergedInvalidSegments,
            applied: payload?.applied ?? true,
            restoreAllowed: payload?.restoreAllowed === false ? false : true,
            collapsed: true,
            updatedAt: Date.now()
        }
    });
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_UPSERT]', 
            `noticeKey=${noticeKey}`,
            `anchorMsgId=${normalizedAnchorMsgId}`,
            `endMsgId=${normalizedEndMsgId}`,
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
    updateSendGate();
}

function attemptAssistantUpgrade(sessionId, payload, source) {
    const currentSession = activeSessionId;
    const payloadSession = sessionId || payload?.sessionId || payload?.sessionID || null;
    const tmpKey = payload?.tmpKey;
    const assistantMsgId = payload?.assistantMsgId;

    emitTempFinalTrace('upgrade.attempt', [
        `source=${source || 'unknown'}`,
        `payloadSession=${payloadSession || 'null'}`,
        `currentSession=${currentSession || 'null'}`,
        `tmpKey=${tmpKey || 'null'}`,
        `assistantMsgId=${assistantMsgId || 'null'}`
    ]);

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[DBG_WV_ID]', `type=${source} sessionPayload=${payloadSession || 'null'} currentSession=${currentSession || 'null'} tmpKey=${tmpKey || 'null'} assistantMsgId=${assistantMsgId || 'null'}`]
    });

    if (!payloadSession) {
        vscode.postMessage({ type: 'ui-debug', payload: ['assistant.upgrade', `tmpKey=${tmpKey || 'null'} msgId=${assistantMsgId || 'null'} replaced=false reason=missing-session`] });
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

    if (session.canceledActiveTurn) {
        emitTempFinalTrace('upgrade.drop', ['reason=canceledActiveTurn']);
        return;
    }

    if (!tmpKey && !session.currentTurnAssistantKey && !session.pendingAssistantUpgrade && !session.awaitingFinalMapBind) {
        emitTempFinalTrace('upgrade.drop', ['reason=no-turn-binding']);
        return;
    }

    if (session.assistantUpgradeSeen instanceof Set && session.assistantUpgradeSeen.has(assistantMsgId)) {
        if (session.currentTurnAssistantKey === assistantMsgId) {
            emitTempFinalTrace('upgrade.idempotent', [`assistantMsgId=${assistantMsgId}`]);
            return;
        }
    }

    const resolveLastAssistantKey = () => {
        for (let i = session.timeline.length - 1; i >= 0; i--) {
            const id = session.timeline[i];
            const msg = session.messagesById.get(id);
            if (msg?.role === 'assistant') return id;
        }
        return null;
    };

    const candidateTmpKey = typeof tmpKey === 'string'
        ? tmpKey
        : (session.pendingAssistantUpgrade?.assistantMsgId === assistantMsgId ? session.pendingAssistantUpgrade?.tmpKey : null);
    const pickCandidateKey = (key) => {
        if (typeof key !== 'string' || !key.length) return null;
        if (key.startsWith('tmp:') || key.startsWith('local-')) return key;
        if (session.messagesById.has(key)) return key;
        return null;
    };
    const currentKey = pickCandidateKey(session.currentTurnAssistantKey)
        || pickCandidateKey(candidateTmpKey)
        || (session.awaitingFinalMapBind ? resolveLastAssistantKey() : null);
    const newKey = assistantMsgId;

    emitTempFinalTrace('upgrade.keySelect', [
        `currentTurnKey=${session.currentTurnAssistantKey || 'null'}`,
        `candidateTmpKey=${candidateTmpKey || 'null'}`,
        `resolvedCurrentKey=${currentKey || 'null'}`,
        `newKey=${newKey}`
    ]);

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

    const logMapExistsFallbackSkip = (skipReason, extra = []) => {
        countAssistantUpgradeFallbackResult(`skipped-${skipReason}`, [
            `sessionId=${payloadSession || 'null'}`,
            `activeSessionId=${currentSession || 'null'}`,
            `curKey=${currentKey || 'null'}`,
            `newKey=${newKey || 'null'}`,
            `source=${source || 'unknown'}`,
            ...extra
        ]);
    };

    const tryMapExistsMissingNewKeyFallback = () => {
        const pending = session.pendingAssistantUpgrade || null;
        const mapExists = session.messageIndexMap instanceof Map;
        if (!mapExists) return false;
        if (typeof newKey !== 'string' || !newKey.startsWith('msg_')) {
            logMapExistsFallbackSkip('bad-new-key');
            return false;
        }
        if (session.messageIndexMap.has(newKey)) return false;
        if (typeof currentKey !== 'string' || !(currentKey.startsWith('tmp:') || currentKey.startsWith('local-'))) {
            logMapExistsFallbackSkip('current-not-tmp-local');
            return false;
        }
        if (!pending) {
            logMapExistsFallbackSkip('missing-pending-metadata');
            return false;
        }
        if (pending.tmpKey !== currentKey || pending.assistantMsgId !== newKey) {
            logMapExistsFallbackSkip('pending-mismatch', [
                `pendingTmpKey=${pending.tmpKey || 'null'}`,
                `pendingAssistantMsgId=${pending.assistantMsgId || 'null'}`
            ]);
            return false;
        }

        const currentMsg = session.messagesById?.get?.(currentKey) || null;
        const currentInTimeline = Array.isArray(session.timeline) && session.timeline.includes(currentKey);
        const currentInTurnState = session.currentTurnAssistantKey === currentKey || session.thinkingId === currentKey;
        if (!currentMsg && !currentInTimeline && !currentInTurnState) {
            logMapExistsFallbackSkip('current-key-not-present', [
                `hasMessage=${Boolean(currentMsg)}`,
                `inTimeline=${currentInTimeline}`,
                `inTurnState=${currentInTurnState}`
            ]);
            return false;
        }
        if (currentMsg && currentMsg.role !== 'assistant') {
            logMapExistsFallbackSkip('current-not-assistant', [`role=${currentMsg.role || 'null'}`]);
            return false;
        }
        if (currentKey.startsWith('local-') && session.currentTurnAssistantMsgId === newKey) {
            logMapExistsFallbackSkip('replace-rejected-local-current-assistant', [
                `currentTurnAssistantMsgId=${session.currentTurnAssistantMsgId || 'null'}`
            ]);
            return false;
        }

        const isActiveSession = Boolean(payloadSession && payloadSession === activeSessionId);
        const currentTurnAnchored = Boolean(
            session.currentTurnAssistantKey === currentKey ||
            session.thinkingId === currentKey ||
            (session.awaitingFinalMapBind && pending.tmpKey === currentKey)
        );
        const candidateAnchored = Boolean(
            session.currentTurnAssistantMsgId === newKey ||
            pending.assistantMsgId === newKey ||
            session.earlyFinalAssistantId === newKey ||
            session.finalAssistantLock?.assistantMsgId === newKey
        );
        if (!isActiveSession || !currentTurnAnchored || !candidateAnchored || session.canceledActiveTurn) {
            logMapExistsFallbackSkip('stale-or-cross-turn', [
                `isActiveSession=${isActiveSession}`,
                `currentTurnAnchored=${currentTurnAnchored}`,
                `candidateAnchored=${candidateAnchored}`,
                `canceled=${Boolean(session.canceledActiveTurn)}`
            ]);
            return false;
        }

        const fallbackMetadata = {
            fallbackAssistantKey: newKey,
            fallbackSourceTmpKey: currentKey,
            fallbackSessionId: payloadSession,
            fallbackSource: source || 'unknown',
            fallbackTurnAnchor: session.currentTurnAssistantKey || session.thinkingId || currentKey,
            fallbackPendingSource: pending.source || 'unknown',
            fallbackAppliedAt: Date.now(),
            fallbackMapSize: session.messageIndexMap.size,
            fallbackMapHadNewKey: false,
            fallbackReason: 'map-exists-new-key-missing'
        };
        session.pendingAssistantUpgrade = {
            ...pending,
            ...fallbackMetadata
        };
        session.lastAssistantUpgradeFallback = fallbackMetadata;
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        countAssistantUpgradeFallbackResult('applied-map-exists-new-key-missing', [
            `sessionId=${payloadSession}`,
            `curKey=${currentKey}`,
            `newKey=${newKey}`,
            `source=${source || 'unknown'}`,
            `mapSize=${session.messageIndexMap.size}`,
            `turnAnchor=${fallbackMetadata.fallbackTurnAnchor || 'null'}`
        ]);
        return true;
    };

    if (!currentKey) {
        session.currentTurnAssistantKey = newKey;
        session.currentTurnAssistantMsgId = newKey;
        reason = 'set-current-only';
    } else if (currentKey === newKey) {
        reason = 'already-current';
    } else if (source === 'chatDone'
        && newKey.startsWith('msg_')
        && session.messagesById.get(currentKey)?.meta?.liveTurnResume === true
        && (
            session.backendTurnInFlight === true
            || session.turnFullyFinalized === false
            || session.thinkingId === currentKey
            || session.currentTurnAssistantKey === currentKey
            || session.pendingAssistantUpgrade?.tmpKey === currentKey
            || session.pendingAssistantUpgrade?.fallbackSourceTmpKey === currentKey
        )) {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'live-resume-final-id-bridge';
    } else if (typeof newIndex === 'number' && typeof curIndex !== 'number') {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'new-index-known';
    } else if (typeof newIndex === 'number' && typeof curIndex === 'number' && newIndex > curIndex) {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'higher-index';
    } else if ((currentKey.startsWith('tmp:') || currentKey.startsWith('local-')) && typeof newIndex === 'number') {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'tmp-local-upgrade';
    } else if (typeof newIndex === 'number' && curIndex === -1) {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'tmp-local-index';
    } else if ((currentKey.startsWith('tmp:') || currentKey.startsWith('local-')) && newIndex === null && session.messageIndexMap instanceof Map && newKey.startsWith('msg_')) {
        if (tryMapExistsMissingNewKeyFallback()) {
            replaced = true;
            reason = 'map-exists-new-key-missing-fallback';
        } else {
            reason = 'map-exists-new-key-missing-fallback-skipped';
        }
    } else if ((currentKey.startsWith('tmp:') || currentKey.startsWith('local-')) && !session.messageIndexMap && newKey.startsWith('msg_')) {
        replaceKeyEverywhere(currentKey, newKey, payloadSession);
        replaced = true;
        reason = 'index-map-missing-fallback';
        console.log('[ASSIST_UPGRADE] fallback path triggered, reason=index-map-missing');
    }

    const tail = formatTail(session.timeline, 2);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['ASSIST_UPGRADE', `curKey=${currentKey || 'null'}`, `newKey=${newKey}`, `curIndex=${curIndex === null ? 'null' : curIndex}`,
            `newIndex=${newIndex === null ? 'null' : newIndex}`, `replaced=${replaced}`, `reason=${reason}`, `tail=${tail}`]
    });

    if (session.assistantUpgradeSeen instanceof Set) {
        session.assistantUpgradeSeen.add(newKey);
    }

    const bound = session.currentTurnAssistantKey === newKey;
    if (bound) {
        if (session.pendingAssistantUpgrade && session.pendingAssistantUpgrade.assistantMsgId === newKey) {
            session.pendingAssistantUpgrade = null;
            session.lastAssistantUpgradeFallback = null;
        }
        session.awaitingFinalMapBind = false;
        updateSendGate();
    }
}

function reconcileAssistantUpgradeFallbackWithAuthoritativeMap(sessionId, session, source, observedMessageId = null, fallbackSnapshot = null) {
    if (!session || !(session.messageIndexMap instanceof Map)) return;
    const fallback = fallbackSnapshot || session.lastAssistantUpgradeFallback || null;
    if (!fallback) return;

    const fallbackAssistantKey = fallback.fallbackAssistantKey;
    const fallbackSourceTmpKey = fallback.fallbackSourceTmpKey;
    if (typeof fallbackAssistantKey !== 'string' || !fallbackAssistantKey.startsWith('msg_') || typeof fallbackSourceTmpKey !== 'string') {
        countAssistantUpgradeFallbackResult('missing-fallback-metadata', [
            `sessionId=${sessionId || 'null'}`,
            `source=${source || 'unknown'}`,
            `fallbackAssistantKey=${fallbackAssistantKey || 'null'}`,
            `fallbackSourceTmpKey=${fallbackSourceTmpKey || 'null'}`
        ]);
        session.lastAssistantUpgradeFallback = null;
        return;
    }

    if (observedMessageId && observedMessageId !== fallbackAssistantKey) return;

    const mapHasFallbackAssistant = session.messageIndexMap.has(fallbackAssistantKey);
    const tmpStillPresent = Boolean(
        session.messagesById?.has?.(fallbackSourceTmpKey) ||
        session.timeline?.includes?.(fallbackSourceTmpKey) ||
        session.currentTurnAssistantKey === fallbackSourceTmpKey ||
        session.thinkingId === fallbackSourceTmpKey
    );
    const preAttemptCurrentTurnAssistantKey = fallback.authoritativePreAttemptCurrentTurnAssistantKey || null;
    const preAttemptTmpStillPresent = typeof fallback.authoritativePreAttemptTmpStillPresent === 'boolean'
        ? fallback.authoritativePreAttemptTmpStillPresent
        : null;
    const authoritativeFields = [
        `sessionId=${sessionId || 'null'}`,
        `source=${source || 'unknown'}`,
        `authoritativeMessageId=${observedMessageId || fallbackAssistantKey}`,
        `fallbackAssistantKey=${fallbackAssistantKey}`,
        `fallbackSourceTmpKey=${fallbackSourceTmpKey}`,
        `mapHasFallbackAssistant=${mapHasFallbackAssistant}`,
        `currentTurnAssistantKey=${session.currentTurnAssistantKey || 'null'}`,
        `tmpStillPresent=${tmpStillPresent}`,
        `preAttemptCurrentTurnAssistantKey=${preAttemptCurrentTurnAssistantKey || 'null'}`,
        `preAttemptTmpStillPresent=${preAttemptTmpStillPresent === null ? 'null' : preAttemptTmpStillPresent}`
    ];

    if (!mapHasFallbackAssistant) {
        countAssistantUpgradeFallbackResult('contradiction-detected-authoritative-missing', authoritativeFields);
        session.awaitingFinalMapBind = true;
        if (!session.pendingAssistantUpgrade || session.pendingAssistantUpgrade.assistantMsgId !== fallbackAssistantKey) {
            session.pendingAssistantUpgrade = {
                tmpKey: fallbackSourceTmpKey,
                assistantMsgId: fallbackAssistantKey,
                source: 'authoritative-map-missing-fallback-retry',
                ts: Date.now(),
                fallbackAssistantKey,
                fallbackSourceTmpKey,
                fallbackSessionId: sessionId,
                fallbackSource: fallback.fallbackSource || 'unknown',
                fallbackTurnAnchor: fallback.fallbackTurnAnchor || fallbackSourceTmpKey,
                fallbackReason: fallback.fallbackReason || 'map-exists-new-key-missing'
            };
        }
        return;
    }

    const conflictingCurrentKey = Boolean(session.currentTurnAssistantKey && session.currentTurnAssistantKey !== fallbackAssistantKey);
    const preAttemptConflictingCurrentKey = Boolean(preAttemptCurrentTurnAssistantKey && preAttemptCurrentTurnAssistantKey !== fallbackAssistantKey);
    if (conflictingCurrentKey || tmpStillPresent || preAttemptConflictingCurrentKey || preAttemptTmpStillPresent === true) {
        countAssistantUpgradeFallbackResult('contradiction-detected-authoritative-present', authoritativeFields);
        attemptAssistantUpgrade(sessionId, {
            sessionId,
            tmpKey: fallbackSourceTmpKey,
            assistantMsgId: fallbackAssistantKey
        }, `${source || 'authoritative'}:fallback-correction`);
    }

    if (session.currentTurnAssistantKey === fallbackAssistantKey || (!tmpStillPresent && !conflictingCurrentKey)) {
        session.awaitingFinalMapBind = false;
        session.lastAssistantUpgradeFallback = null;
        countAssistantUpgradeFallbackResult('authoritative-correction-applied', authoritativeFields);
    }
}

const UNDO_TIMEOUT_MS = 10000;

function isUndoRangeVisibleMessageId(session, id) {
    if (typeof id !== 'string' || !id.startsWith('msg_')) return false;
    if (session?.hiddenSet instanceof Set && session.hiddenSet.has(id)) return false;
    const message = session?.messagesById instanceof Map ? session.messagesById.get(id) : null;
    if (isHydrationPersistenceArtifact(id, message)) return false;
    const kind = message?.meta?.kind;
    if (kind === 'undoNotice' || kind === 'snapshotNotice' || kind === 'changeList') return false;
    return true;
}

function buildUndoVisibleRangeSnapshot(session, anchorMsgId) {
    const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
    const visibleMessageIds = [];
    for (const id of timeline) {
        if (isUndoRangeVisibleMessageId(session, id)) {
            visibleMessageIds.push(id);
        }
    }
    const anchorIndex = visibleMessageIds.indexOf(anchorMsgId);
    const forwardMessageIdsFromAnchor = anchorIndex >= 0
        ? visibleMessageIds.slice(anchorIndex)
        : [];
    return { visibleMessageIds, anchorIndex, forwardMessageIdsFromAnchor };
}

function suspendUndoTimeoutForConflictCard(payload) {
    if (!payload || typeof payload.operationId !== 'string' || !payload.operationId) return false;
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    if (kind && kind !== 'undo') return false;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : activeSessionId;
    const session = getSessionState(sessionId);
    const pending = session?.pendingUndo;
    if (!pending || pending.clientOpId !== payload.operationId) return false;

    if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
        pending.timeoutId = null;
    }
    pending.status = 'waiting-conflict-decision';
    pending.conflictId = typeof payload.conflictId === 'string' ? payload.conflictId : '';
    pending.conflictKind = kind || 'undo';

    vscode.postMessage({
        type: 'ui-debug',
        payload: ['undo', 'timeout-suspended-conflict', 'clientOpId', pending.clientOpId, 'sessionId', sessionId || 'null', 'conflictId', pending.conflictId || 'null']
    });
    return true;
}

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
            ts: Date.now(),
            status: 'waiting-response',
            timeoutId: null
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
        const undoRangeSnapshot = buildUndoVisibleRangeSnapshot(session, serverId);
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][UNDO_RANGE_TX]', `sessionId=${sessionId || 'null'}`, `opId=${opId || 'null'}`, `anchorIndex=${undoRangeSnapshot.anchorIndex}`, `visibleCount=${undoRangeSnapshot.visibleMessageIds.length}`, `forwardCount=${undoRangeSnapshot.forwardMessageIdsFromAnchor.length}`]
        });
        const undoMessage = {
            type: 'undoToMessage',
            sessionId,
            operationId: opId,
            messageId: serverId,
            visibleMessageIds: undoRangeSnapshot.visibleMessageIds,
            anchorIndex: undoRangeSnapshot.anchorIndex,
            forwardMessageIdsFromAnchor: undoRangeSnapshot.forwardMessageIdsFromAnchor
        };
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_MSG_OBJ]', JSON.stringify(undoMessage)] });
        
        // Send a test ping immediately before undoToMessage to verify channel is working
        vscode.postMessage({ type: 'ping' });
        
        vscode.postMessage(undoMessage);
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_POST_SEND]', 'sent'] });

        session.pendingUndo.timeoutId = setTimeout(() => handleUndoTimeout(sessionId, opId), UNDO_TIMEOUT_MS);
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

    if (session.pendingUndo.status === 'waiting-conflict-decision') {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['undo', 'timeout-skip-conflict', 'clientOpId', clientOpId || 'null', 'sessionId', sessionId || 'null']
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

function createOperationId() {
    return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    
    const operationId = createOperationId();

    // Send restore request to extension
    vscode.postMessage({
        type: 'restoreSegment',
        sessionId,
        operationId,
        noticeKey: segment.noticeKey,
        anchorMsgId: segment.anchorMsgId,
        endMsgId: segment.endMsgId
    });
    
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][SEG_RESTORE_SEND]',
            `sessionId=${sessionId || 'null'}`,
            `opId=${operationId || 'null'}`,
            `noticeKey=${noticeKey}`,
            `anchorMsgId=${segment.anchorMsgId || 'null'}`,
            `endMsgId=${segment.endMsgId || 'null'}`,
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

const FILE_REF_RE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d{1,6})(?::(\d{1,6}))?/g;
const FILE_REF_CODE_RE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d{1,6})(?::(\d{1,6}))?/g;
const FILE_REF_QUICK_RE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d{1,6})(?::(\d{1,6}))?/;
const FILE_ONLY_RE = /(?<![A-Za-z0-9_./-])((?:\.{1,2}\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9_./-])/g;
const FILE_ONLY_QUICK_RE = /(?<![A-Za-z0-9_./-])((?:\.{1,2}\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9_./-])/;
const ALLOWED_EXTS = null;

function isAllowedFileExt(filePath) {
    if (!Array.isArray(ALLOWED_EXTS) || !ALLOWED_EXTS.length) return true;
    const dot = filePath.lastIndexOf('.');
    if (dot === -1 || dot >= filePath.length - 1) return false;
    const ext = filePath.slice(dot + 1).toLowerCase();
    return ALLOWED_EXTS.includes(ext);
}

function isInsideNoLinkifyTags(node, rootEl) {
    let current = node?.parentElement || null;
    while (current && current !== rootEl) {
        const tag = current.tagName;
        if (tag === 'A' || tag === 'PRE') return true;
        current = current.parentElement;
    }
    return false;
}

function isInsideCodeTag(node, rootEl) {
    let current = node?.parentElement || null;
    while (current && current !== rootEl) {
        const tag = current.tagName;
        if (tag === 'CODE') return true;
        current = current.parentElement;
    }
    return false;
}

function appendLinkifiedText(target, text, regex, buildLink) {
    if (!text) return 0;
    regex.lastIndex = 0;
    let last = 0;
    let count = 0;
    let match = regex.exec(text);
    while (match) {
        const full = match[0];
        const start = match.index;
        if (start > last) {
            target.appendChild(document.createTextNode(text.slice(last, start)));
        }
        const built = buildLink(match, full);
        if (built) {
            target.appendChild(built);
            count += 1;
        } else {
            target.appendChild(document.createTextNode(full));
        }
        last = start + full.length;
        match = regex.exec(text);
    }
    if (last < text.length) {
        target.appendChild(document.createTextNode(text.slice(last)));
    }
    return count;
}

function linkifyFileRefs(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node = walker.nextNode();
    while (node) {
        if (typeof node.nodeValue === 'string' && node.nodeValue.length > 0) {
            textNodes.push(node);
        }
        node = walker.nextNode();
    }

    let matches = 0;
    for (const textNode of textNodes) {
        const parent = textNode.parentNode;
        const source = textNode.nodeValue || '';
        if (!parent || !source) continue;
        if (isInsideNoLinkifyTags(textNode, rootEl)) continue;
        const inCode = isInsideCodeTag(textNode, rootEl);
        const shouldMatchLineRefs = FILE_REF_QUICK_RE.test(source);
        const shouldMatchFileOnly = FILE_ONLY_QUICK_RE.test(source);
        if (!shouldMatchLineRefs && !shouldMatchFileOnly) continue;

        const frag = document.createDocumentFragment();
        let changed = false;
        const linkLineRef = (match, full) => {
            const filePath = match[1];
            if (!isAllowedFileExt(filePath)) return null;
            const line = match[2];
            const col = match[3] || '1';
            const link = document.createElement('a');
            link.href = `ocfile://open?path=${encodeURIComponent(filePath)}&line=${line}&col=${col}`;
            link.textContent = full;
            return link;
        };
        const linkFileOnly = (match, full) => {
            const filePath = match[1];
            if (!isAllowedFileExt(filePath)) return null;
            const link = document.createElement('a');
            link.href = `ocfile://open?path=${encodeURIComponent(filePath)}`;
            link.textContent = full;
            return link;
        };

        if (shouldMatchLineRefs) {
            const lineRefRe = inCode ? FILE_REF_CODE_RE : FILE_REF_RE;
            const intermediate = document.createDocumentFragment();
            const lineCount = appendLinkifiedText(intermediate, source, lineRefRe, linkLineRef);
            matches += lineCount;
            changed = changed || lineCount > 0;

            if (shouldMatchFileOnly) {
                const nodes = Array.from(intermediate.childNodes);
                for (const child of nodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const text = child.nodeValue || '';
                        if (!text || !FILE_ONLY_QUICK_RE.test(text)) {
                            frag.appendChild(child);
                            continue;
                        }
                        const nested = document.createDocumentFragment();
                        const fileCount = appendLinkifiedText(nested, text, FILE_ONLY_RE, linkFileOnly);
                        matches += fileCount;
                        changed = changed || fileCount > 0;
                        frag.appendChild(nested);
                    } else {
                        frag.appendChild(child);
                    }
                }
            } else {
                frag.appendChild(intermediate);
            }
        } else if (shouldMatchFileOnly) {
            const fileCount = appendLinkifiedText(frag, source, FILE_ONLY_RE, linkFileOnly);
            matches += fileCount;
            changed = changed || fileCount > 0;
        }

        if (!changed) continue;
        parent.replaceChild(frag, textNode);
    }

    vscode.postMessage({ type: 'ui-debug', payload: ['WV: linkify.refs', `matches=${matches}`] });
}

function shouldLinkifyAssistantMessage(message) {
    return Boolean(message?.role === 'assistant' && message?.meta?.isThinking !== true);
}

function renderAssistantMarkdown(content, message) {
    const text = typeof message?.text === 'string' ? message.text : '';
    const linkifyRefs = shouldLinkifyAssistantMessage(message);
    const signature = `${linkifyRefs ? '1' : '0'}:${text}`;
    if (message && message._renderSignature === signature && typeof message._renderHtml === 'string') {
        content.innerHTML = message._renderHtml;
        return;
    }
    renderMarkdownInto(content, text, { linkifyRefs });
    if (message && typeof message === 'object') {
        message._renderSignature = signature;
        message._renderHtml = content.innerHTML;
    }
}

function renderUserMarkdown(content, text) {
    renderMarkdownInto(content, text || '', { linkifyRefs: false });
}

function renderMarkdownInto(element, text, options = {}) {
    delete element.dataset.linkified;
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
    if (options.linkifyRefs === true && element.dataset.linkified !== '1') {
        linkifyFileRefs(element);
        element.dataset.linkified = '1';
    }
}

async function writeTextToClipboard(text) {
    if (!text) return false;
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
        let textarea = null;
        try {
            textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        } finally {
            if (textarea && textarea.parentNode) {
                textarea.parentNode.removeChild(textarea);
            }
        }
    }
    return copied;
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
                const copied = await writeTextToClipboard(text);
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

function isFreeModel(model) {
    if (!model) return false;
    const provider = String(model.providerId || '').toLowerCase();
    const fullId = String(model.fullId || '').toLowerCase();
    const name = String(model.name || '').toLowerCase();
    const id = String(model.id || '').toLowerCase();
    const speed = typeof model.speedMultiplier === 'string' ? model.speedMultiplier.trim().toLowerCase() : '';
    const isCopilot = isCopilotProvider(provider) || fullId.includes('copilot');
    if (isCopilot && speed === '0x') return true;
    const isOpenCode = provider === 'opencode' || fullId.startsWith('opencode/');
    const hasFree = name.includes('free') || fullId.includes('free') || id.includes('free');
    return isOpenCode && hasFree;
}

function refreshFreeModelIds() {
    const next = new Set();
    for (const model of models) {
        if (isFreeModel(model) && model.fullId) {
            next.add(model.fullId);
        }
    }
    freeModelIds = next;
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

function hashText(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
    }
    return `${text.length}:${hash.toString(16)}`;
}

function shouldRenderDiffChunk(session, message) {
    if (!session) return false;
    if (!(session.seenDiffKeys instanceof Set)) {
        session.seenDiffKeys = new Set();
    }
    const value = typeof message?.value === 'string' ? message.value : '';
    if (!value) return false;
    const key = `diff:${hashText(value)}`;
    if (session.seenDiffKeys.has(key)) {
        return false;
    }
    session.seenDiffKeys.add(key);
    if (session.seenDiffKeys.size > 200) {
        const compact = new Set(Array.from(session.seenDiffKeys).slice(-120));
        session.seenDiffKeys = compact;
    }
    return true;
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

function getSessionSearchElements() {
    return {
        bar: document.getElementById('session-search-bar'),
        input: document.getElementById('session-search-input'),
        count: document.getElementById('session-search-count'),
        smart: document.getElementById('session-search-smart'),
        prev: document.getElementById('session-search-prev'),
        next: document.getElementById('session-search-next')
    };
}

function clearSessionSearchHighlights() {
    const marks = Array.from(document.querySelectorAll('mark.session-search-hit'));
    const parents = new Set();
    for (const mark of marks) {
        const parent = mark.parentNode;
        if (!parent) continue;
        parents.add(parent);
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    }
    for (const parent of parents) {
        if (typeof parent.normalize === 'function') parent.normalize();
    }
    const semanticHits = Array.from(document.querySelectorAll('.session-search-semantic-hit'));
    for (const hit of semanticHits) {
        hit.classList.remove('session-search-semantic-hit', 'active');
    }
    sessionSearch.matches = [];
}

function updateSessionSearchControls() {
    const { count, prev, next, smart } = getSessionSearchElements();
    const total = sessionSearch.matches.length;
    const current = total > 0 && sessionSearch.activeIndex >= 0 ? sessionSearch.activeIndex + 1 : 0;
    const hasQuery = Boolean(String(sessionSearch.query || '').trim());
    if (count) {
        count.textContent = sessionSearch.smartInFlight ? '' : (hasQuery ? `${current}/${total}` : '0/0');
        count.classList.toggle('is-loading', sessionSearch.smartInFlight);
        count.classList.toggle('no-results', !sessionSearch.smartInFlight && hasQuery && total === 0);
    }
    if (smart) {
        smart.disabled = sessionSearch.smartInFlight || !hasQuery;
        smart.classList.toggle('is-active', sessionSearch.mode === 'smart');
        smart.textContent = sessionSearch.smartInFlight ? 'Smart...' : 'Smart';
    }
    if (prev) prev.disabled = total <= 1;
    if (next) next.disabled = total <= 1;
}

function updateActiveSessionSearchHit({ scroll = false } = {}) {
    const total = sessionSearch.matches.length;
    for (let i = 0; i < total; i++) {
        sessionSearch.matches[i].classList.toggle('active', i === sessionSearch.activeIndex);
    }
    updateSessionSearchControls();
    if (!scroll || total === 0 || sessionSearch.activeIndex < 0) return;
    const active = sessionSearch.matches[sessionSearch.activeIndex];
    active?.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}

function isSessionSearchTextNode(node, queryLower) {
    const text = node?.nodeValue || '';
    if (!text || !text.toLowerCase().includes(queryLower)) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    if (parent.closest('button, input, textarea, select, mark.session-search-hit')) return false;
    if (parent.closest('.message-actions, .copy-btn, .message-copy-btn, .session-search-bar')) return false;
    return true;
}

function highlightSessionSearchTextNode(node, query, queryLower) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let index = lower.indexOf(queryLower, cursor);
    while (index !== -1) {
        if (index > cursor) {
            fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        }
        const mark = document.createElement('mark');
        mark.className = 'session-search-hit';
        mark.textContent = text.slice(index, index + query.length);
        mark.dataset.searchIndex = String(sessionSearch.matches.length);
        sessionSearch.matches.push(mark);
        fragment.appendChild(mark);
        cursor = index + query.length;
        index = lower.indexOf(queryLower, cursor);
    }
    if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode?.replaceChild(fragment, node);
}

function refreshSessionSearchHighlights({ jumpToFirst = false } = {}) {
    if (sessionSearch.mode === 'smart') {
        updateSessionSearchControls();
        return;
    }
    const previousIndex = sessionSearch.activeIndex;
    clearSessionSearchHighlights();

    const query = String(sessionSearch.query || '').trim();
    if (!query) {
        sessionSearch.activeIndex = -1;
        updateSessionSearchControls();
        return;
    }

    const chat = document.getElementById('chat');
    if (!chat) {
        sessionSearch.activeIndex = -1;
        updateSessionSearchControls();
        return;
    }

    const queryLower = query.toLowerCase();
    const roots = Array.from(chat.querySelectorAll('.message-content, .change-list-card'));
    for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isSessionSearchTextNode(node, queryLower)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });
        const nodes = [];
        let node = walker.nextNode();
        while (node) {
            nodes.push(node);
            node = walker.nextNode();
        }
        for (const textNode of nodes) {
            highlightSessionSearchTextNode(textNode, query, queryLower);
        }
    }

    if (sessionSearch.matches.length === 0) {
        sessionSearch.activeIndex = -1;
        updateSessionSearchControls();
        return;
    }

    if (jumpToFirst || previousIndex < 0) {
        sessionSearch.activeIndex = 0;
    } else {
        sessionSearch.activeIndex = Math.min(previousIndex, sessionSearch.matches.length - 1);
    }
    updateActiveSessionSearchHit({ scroll: jumpToFirst });
}

function scheduleSessionSearchRefresh({ jumpToFirst = false } = {}) {
    sessionSearch.mode = 'text';
    if (sessionSearchDebounceTimer) {
        clearTimeout(sessionSearchDebounceTimer);
    }
    sessionSearchDebounceTimer = setTimeout(() => {
        sessionSearchDebounceTimer = null;
        refreshSessionSearchHighlights({ jumpToFirst });
    }, 120);
}

function goToSessionSearchMatch(delta) {
    const total = sessionSearch.matches.length;
    if (!total) return;
    sessionSearch.activeIndex = (sessionSearch.activeIndex + delta + total) % total;
    updateActiveSessionSearchHit({ scroll: true });
}

function openSessionSearch() {
    const { bar, input } = getSessionSearchElements();
    if (!bar || !input) return;
    sessionSearch.open = true;
    bar.classList.remove('hidden');
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
    refreshSessionSearchHighlights({ jumpToFirst: false });
}

function closeSessionSearch() {
    const { bar, input } = getSessionSearchElements();
    sessionSearch.open = false;
    sessionSearch.query = '';
    sessionSearch.mode = 'text';
    sessionSearch.activeIndex = -1;
    sessionSearch.smartMessageIds = [];
    sessionSearch.smartRequestId = '';
    sessionSearch.smartInFlight = false;
    if (sessionSearchDebounceTimer) {
        clearTimeout(sessionSearchDebounceTimer);
        sessionSearchDebounceTimer = null;
    }
    if (input) input.value = '';
    clearSessionSearchHighlights();
    updateSessionSearchControls();
    bar?.classList.add('hidden');
}

function collectSmartSearchMessages() {
    const chat = document.getElementById('chat');
    if (!chat) return [];
    const seen = new Set();
    const rows = [];
    const nodes = Array.from(chat.querySelectorAll('[data-message-id], [data-segment-key]'));
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const id = node.dataset.messageId || node.dataset.segmentKey || '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const content = node.querySelector('.message-content, .conflict-card-list') || node;
        const text = String(content.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        rows.push({
            id,
            role: node.classList.contains('user') ? 'user' : node.classList.contains('bot') ? 'assistant' : 'system',
            text: text.slice(0, 2200)
        });
    }
    return rows;
}

function applySmartSessionSearchResults(messageIds, { scroll = true } = {}) {
    const previousIndex = sessionSearch.activeIndex;
    clearSessionSearchHighlights();
    sessionSearch.mode = 'smart';
    sessionSearch.smartMessageIds = Array.isArray(messageIds) ? messageIds.filter((id) => typeof id === 'string' && id) : [];
    sessionSearch.matches = [];
    const seen = new Set();
    for (const id of sessionSearch.smartMessageIds) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(id)
            : id.replace(/["\\]/g, '\\$&');
        const el = document.querySelector(`[data-message-id="${escaped}"], [data-segment-key="${escaped}"]`);
        if (!(el instanceof HTMLElement)) continue;
        el.classList.add('session-search-semantic-hit');
        sessionSearch.matches.push(el);
    }
    sessionSearch.activeIndex = sessionSearch.matches.length
        ? Math.min(Math.max(previousIndex, 0), sessionSearch.matches.length - 1)
        : -1;
    updateActiveSessionSearchHit({ scroll });
}

function runSmartSessionSearch() {
    const query = String(sessionSearch.query || '').trim();
    if (!query || sessionSearch.smartInFlight) return;
    const messages = collectSmartSearchMessages();
    if (!messages.length) {
        clearSessionSearchHighlights();
        sessionSearch.mode = 'smart';
        sessionSearch.activeIndex = -1;
        updateSessionSearchControls();
        return;
    }
    const requestId = `smart-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionSearch.mode = 'smart';
    sessionSearch.smartRequestId = requestId;
    sessionSearch.smartMessageIds = [];
    sessionSearch.smartInFlight = true;
    clearSessionSearchHighlights();
    updateSessionSearchControls();
    vscode.postMessage({
        type: 'smartSessionSearch',
        requestId,
        sessionId: activeSessionId || '',
        query,
        messages
    });
}

document.addEventListener('DOMContentLoaded', () => {
    sendBtn = document.getElementById('send-btn');
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
    sendButtonSendIconHtml = sendIcon;
    sendButtonStopIconHtml = stopIcon;
    const input = document.getElementById('chat-input');
    const chatContainer = document.getElementById('chat');
    const modelSelect = document.getElementById('model-select');
    const modeSelect = document.getElementById('mode-select');
    const variantSelect = document.getElementById('variant-select');
    const attachmentBtn = document.getElementById('attachment-btn');
    const sessionTitle = document.getElementById('session-title');
    const undoStatusEl = document.getElementById('undo-status');
    const historyBtn = document.getElementById('history-btn');
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('session-search-input');
    const searchSmartBtn = document.getElementById('session-search-smart');
    const searchPrevBtn = document.getElementById('session-search-prev');
    const searchNextBtn = document.getElementById('session-search-next');
    const searchCloseBtn = document.getElementById('session-search-close');
    const newSessionBtn = document.getElementById('new-session-btn');
    const sessionPanel = document.getElementById('session-panel');
    const sessionList = document.getElementById('session-list');
    const attachmentList = document.getElementById('attachment-list');
    const inputTokenList = document.getElementById('input-token-list');
    const fileMentionList = document.getElementById('file-mention-list');
    const serverStatusDot = document.getElementById('server-status-dot');
    const panelBackdrop = document.getElementById('panel-backdrop');
    const refreshSessionsBtn = document.getElementById('refresh-sessions');
    const closeSessionsBtn = document.getElementById('close-sessions');
    baseSessionTitle = sessionTitle?.textContent || 'OpenCode: Chat';
    renderHeaderTitle();
    renderHeaderUsage();

    const usageEl = document.getElementById('header-usage');
    if (usageEl) {
        usageEl.addEventListener('mouseenter', () => {
            usageCompactHoverActive = true;
            renderHeaderUsage();
        });
        usageEl.addEventListener('mouseleave', () => {
            usageCompactHoverActive = false;
            renderHeaderUsage();
        });
        usageEl.addEventListener('click', () => {
            if (!usageCompactHoverActive) return;
            if (isCompactDisabledForSession(activeSessionId || '')) return;
            if (!activeSessionId) return;
            vscode.postMessage({ type: 'compactSession', sessionId: activeSessionId });
        });
    }

    if (chatContainer) {
        autoScrollPinnedToBottom = isNearBottom(chatContainer);
        chatContainer.addEventListener('scroll', () => {
            autoScrollPinnedToBottom = isNearBottom(chatContainer);
            hideQuoteSelectionButton();
        }, { passive: true });
        chatContainer.addEventListener('mouseup', () => {
            setTimeout(showQuoteSelectionButton, 0);
        });
        chatContainer.addEventListener('keyup', () => {
            setTimeout(showQuoteSelectionButton, 0);
        });
        chatContainer.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const anchor = target.closest('a[href^="ocfile://open"]');
            if (!(anchor instanceof HTMLAnchorElement)) return;
            event.preventDefault();
            try {
                const url = new URL(anchor.href);
                const filePath = url.searchParams.get('path') || '';
                const line = Number(url.searchParams.get('line') || '1');
                const col = Number(url.searchParams.get('col') || '1');
                if (!filePath) return;
                vscode.postMessage({
                    type: 'openFileAtLocation',
                    path: filePath,
                    line,
                    col,
                    sessionId: activeSessionId || null
                });
            } catch {
                // ignore malformed link
            }
        });
    }

    const webviewInstanceId = `wv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vscode.postMessage({ type: 'ui-debug', payload: ['WV', 'webviewReady', 'id', webviewInstanceId] });
    vscode.postMessage({ type: 'webviewReady', webviewInstanceId });
    sendBtn.innerHTML = sendIcon;
    inputDefaultPlaceholder = input?.placeholder || inputDefaultPlaceholder;

    function getInputContainer() {
        return input?.closest?.('.input-container') || null;
    }

    function pulseAppendInput() {
        const container = getInputContainer();
        if (!container) return;
        container.classList.remove('append-pulse');
        void container.offsetWidth;
        container.classList.add('append-pulse');
        setTimeout(() => container.classList.remove('append-pulse'), 1400);
    }

    function refreshSendButtonState() {
        syncSendButtonBusyVisual();
        updateSendQuotaVisual();
        updateSendGate();
    }

    function refreshSendButtonStateAfterSessionSwitch() {
        refreshSendButtonState();
        requestAnimationFrame(() => {
            refreshSendButtonState();
        });
    }

    function updateAppendInputUi() {
        const container = getInputContainer();
        if (container) {
            container.classList.toggle('append-mode', Boolean(appendInputMode));
        }
        if (input) {
            input.placeholder = appendInputMode ? 'Append...' : inputDefaultPlaceholder;
        }
        renderContextTokens();
        refreshSendButtonState();
    }

    function buildAppendHoverKey(sessionId, rootUserKey) {
        if (!sessionId || !rootUserKey) return null;
        return `${sessionId}::${rootUserKey}`;
    }

    function setAppendHoverActive(key) {
        if (!key) return;
        if (appendHoverHideTimer) {
            clearTimeout(appendHoverHideTimer);
            appendHoverHideTimer = null;
        }
        appendHoverActiveKey = key;
    }

    function scheduleClearAppendHover(key) {
        if (!key || appendHoverActiveKey !== key) return;
        if (appendHoverHideTimer) clearTimeout(appendHoverHideTimer);
        appendHoverHideTimer = setTimeout(() => {
            appendHoverHideTimer = null;
            if (appendHoverActiveKey === key) {
                appendHoverActiveKey = null;
                window.__oc?.renderFromState?.();
            }
        }, 180);
    }

    function clearAppendHover(reason = 'unknown') {
        if (appendHoverHideTimer) {
            clearTimeout(appendHoverHideTimer);
            appendHoverHideTimer = null;
        }
        appendHoverActiveKey = null;
    }

    function enterAppendInputMode(rootUserKey, initialText) {
        const session = getSessionState(activeSessionId);
        if (!session || !rootUserKey || !input) return;
        setAppendHoverActive(buildAppendHoverKey(activeSessionId, rootUserKey));
        if (!(session.appendComposerDrafts instanceof Map)) {
            session.appendComposerDrafts = new Map();
        }
        if (!appendInputMode || appendInputMode.sessionId !== activeSessionId) {
            session.inputDraft = input.value;
        } else if (appendInputMode.rootUserKey !== rootUserKey) {
            session.appendComposerDrafts.set(appendInputMode.rootUserKey, input.value);
        }
        session.appendComposerFor = null;
        appendInputMode = { sessionId: activeSessionId, rootUserKey };
        input.value = typeof initialText === 'string'
            ? initialText
            : (session.appendComposerDrafts.get(rootUserKey) || '');
        updateAppendInputUi();
        pulseAppendInput();
        setTimeout(() => {
            input.focus();
            const end = input.value.length;
            input.selectionStart = end;
            input.selectionEnd = end;
        }, 0);
    }

    function exitAppendInputMode(options = {}) {
        if (!appendInputMode || !input) return;
        const { restoreDraft = true, discardAppendDraft = false, keepCurrentInput = false } = options;
        const { sessionId, rootUserKey } = appendInputMode;
        const session = getSessionState(sessionId);
        const currentValue = input.value;
        if (session) {
            if (discardAppendDraft) {
                session.appendComposerDrafts?.delete?.(rootUserKey);
            } else {
                if (!(session.appendComposerDrafts instanceof Map)) {
                    session.appendComposerDrafts = new Map();
                }
                session.appendComposerDrafts.set(rootUserKey, currentValue);
            }
        }
        appendInputMode = null;
        if (keepCurrentInput && sessionId === activeSessionId) {
            if (session) session.inputDraft = currentValue;
            input.value = currentValue;
        } else if (restoreDraft && sessionId === activeSessionId) {
            input.value = session?.inputDraft || '';
        }
        updateAppendInputUi();
    }

    function maybeExitAppendInputModeAfterTurnEnd(sessionId, reason = 'unknown') {
        if (!appendInputMode || appendInputMode.sessionId !== sessionId || sessionId !== activeSessionId) return;
        const session = getSessionState(sessionId);
        if (!session) return;
        const turnEnded =
            session.backendTurnInFlight !== true ||
            session.turnFullyFinalized === true ||
            session.canceledActiveTurn === true ||
            Boolean(session.finalAssistantLock?.assistantMsgId);
        if (!turnEnded) return;
        const rootUserKey = appendInputMode.rootUserKey;
        exitAppendInputMode({ restoreDraft: false, discardAppendDraft: false, keepCurrentInput: true });
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['append.input.auto-exit', 'reason', reason, 'sessionId', sessionId, 'rootUserKey', rootUserKey || 'null']
        });
    }

    function clearAppendInputForSessionChange(nextSessionId) {
        if (appendHoverActiveKey && !appendHoverActiveKey.startsWith(`${nextSessionId || ''}::`)) {
            clearAppendHover('session-change');
        }
        if (!appendInputMode || appendInputMode.sessionId === nextSessionId) return;
        appendInputMode = null;
        if (input) {
            const nextSession = getSessionState(nextSessionId);
            input.value = nextSession?.inputDraft || '';
        }
        updateAppendInputUi();
    }

    function ensureQuoteSelectionButton() {
        if (quoteSelectionButton) return quoteSelectionButton;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quote-selection-btn hidden';
        button.textContent = 'Quote';
        button.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            insertQuoteIntoInput(quoteSelectionText);
            hideQuoteSelectionButton();
            window.getSelection()?.removeAllRanges?.();
        });
        document.body.appendChild(button);
        quoteSelectionButton = button;
        return button;
    }

    function hideQuoteSelectionButton() {
        quoteSelectionText = '';
        if (quoteSelectionButton) {
            quoteSelectionButton.classList.add('hidden');
        }
    }

    function getSelectionElement(node) {
        if (!node) return null;
        return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    }

    function getSelectedFormulaMarkdown(selection) {
        if (!selection || selection.rangeCount !== 1) return '';
        const range = selection.getRangeAt(0);
        const startFormula = getSelectionElement(range.startContainer)?.closest?.('.katex');
        const endFormula = getSelectionElement(range.endContainer)?.closest?.('.katex');
        if (!startFormula || startFormula !== endFormula) return '';
        const annotation = startFormula.querySelector('annotation[encoding="application/x-tex"]');
        const tex = annotation?.textContent?.trim?.() || '';
        if (!tex) return '';
        const isDisplay = Boolean(startFormula.closest('.katex-display'));
        return isDisplay ? `$$${tex}$$` : `$${tex}$`;
    }

    function getKatexMarkdown(formulaEl) {
        if (!formulaEl || typeof formulaEl.querySelector !== 'function') return '';
        const annotation = formulaEl.querySelector('annotation[encoding="application/x-tex"]');
        const tex = annotation?.textContent?.trim?.() || '';
        if (!tex) return '';
        const isDisplay = Boolean(formulaEl.closest?.('.katex-display') || formulaEl.parentElement?.classList?.contains('katex-display'));
        return isDisplay ? `$$${tex}$$` : `$${tex}$`;
    }

    function isBlockElement(element) {
        if (!element || !element.tagName) return false;
        return /^(P|DIV|SECTION|ARTICLE|LI|UL|OL|BLOCKQUOTE|PRE|TABLE|TR|H[1-6])$/.test(element.tagName);
    }

    function serializeSelectionNode(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) {
            return (node.nodeValue || '').replace(/\u00a0/g, ' ');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const element = node;
        if (element.classList?.contains('katex')) {
            return getKatexMarkdown(element);
        }
        if (element.classList?.contains('katex-html') || element.getAttribute?.('aria-hidden') === 'true') {
            return '';
        }
        if (element.tagName === 'ANNOTATION' || element.tagName === 'SEMANTICS') {
            return '';
        }
        if (element.tagName === 'BR') {
            return '\n';
        }

        let text = '';
        for (const child of Array.from(element.childNodes || [])) {
            text += serializeSelectionNode(child);
        }
        if (isBlockElement(element)) {
            text = text.replace(/[ \t]+\n/g, '\n').trim();
            return text ? `${text}\n` : '';
        }
        return text;
    }

    function getSelectionMarkdownText(selection) {
        if (!selection || selection.rangeCount !== 1) return '';
        const formulaOnly = getSelectedFormulaMarkdown(selection);
        if (formulaOnly) return formulaOnly;
        const range = selection.getRangeAt(0);
        const fragment = range.cloneContents();
        let text = '';
        for (const child of Array.from(fragment.childNodes || [])) {
            text += serializeSelectionNode(child);
        }
        return text
            .replace(/\u200b/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getQuoteMarkdownFromSelection(selection) {
        const text = getSelectionMarkdownText(selection);
        if (!text) return '';
        const looksLikeMarkdownMath = /\$[^$]+\$|\\\(|\\\[/.test(text);
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => looksLikeMarkdownMath ? `> ${line}` : `> *${line.replace(/\*/g, '\\*')}*`)
            .join('\n');
    }

    function showQuoteSelectionButton() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            hideQuoteSelectionButton();
            return;
        }
        const range = selection.getRangeAt(0);
        const startEl = getSelectionElement(range.startContainer);
        const endEl = getSelectionElement(range.endContainer);
        if (!chatContainer?.contains(startEl) || !chatContainer.contains(endEl)) {
            hideQuoteSelectionButton();
            return;
        }
        if (startEl?.closest?.('textarea, input, button, select') || endEl?.closest?.('textarea, input, button, select')) {
            hideQuoteSelectionButton();
            return;
        }
        const quoteText = getQuoteMarkdownFromSelection(selection);
        if (!quoteText) {
            hideQuoteSelectionButton();
            return;
        }
        quoteSelectionText = quoteText;
        const rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
            hideQuoteSelectionButton();
            return;
        }
        const button = ensureQuoteSelectionButton();
        button.classList.remove('hidden');
        const buttonWidth = button.offsetWidth || 62;
        const buttonHeight = button.offsetHeight || 28;
        const left = Math.max(8, Math.min(window.innerWidth - buttonWidth - 8, rect.right + 8));
        const top = Math.max(8, Math.min(window.innerHeight - buttonHeight - 8, rect.top + (rect.height / 2) - (buttonHeight / 2)));
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
    }

    function insertQuoteIntoInput(quoteText) {
        if (!quoteText || !input) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        const prefix = before && !before.endsWith('\n\n')
            ? (before.endsWith('\n') ? '\n' : '\n\n')
            : '';
        const suffix = after
            ? (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n')
            : '\n\n';
        const inserted = `${prefix}${quoteText}${suffix}`;
        input.value = `${before}${inserted}${after}`;
        const cursor = before.length + inserted.length;
        input.focus();
        input.setSelectionRange(cursor, cursor);
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(cursor, cursor);
        });
        const session = getSessionState(activeSessionId);
        if (appendInputMode && appendInputMode.sessionId === activeSessionId) {
            if (session) {
                if (!(session.appendComposerDrafts instanceof Map)) {
                    session.appendComposerDrafts = new Map();
                }
                session.appendComposerDrafts.set(appendInputMode.rootUserKey, input.value);
            }
        } else if (session) {
            session.inputDraft = input.value;
        }
        updateSendGate();
    }

    function setBusy(nextBusy, ownerSessionId = '') {
        isBusy = nextBusy;
        busySessionId = nextBusy ? (ownerSessionId || activeSessionId || '') : '';
        refreshSendButtonState();
    }

    function clearBusyForSession(sessionId, reason = 'unknown') {
        if (!isBusy) return false;
        const eventSessionId = typeof sessionId === 'string' ? sessionId : '';
        if (busySessionId && eventSessionId && busySessionId !== eventSessionId) return false;
        if (busySessionId && !eventSessionId) return false;
        setBusy(false);
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][BUSY_CLEAR]', `reason=${reason}`, `sessionId=${eventSessionId || 'null'}`, `activeSessionId=${activeSessionId || 'null'}`]
        });
        return true;
    }

    function ensureQuotaTooltip() {
        if (quotaTooltipEl) return;

        const div = document.createElement('div');
        div.className = 'quota-tooltip hidden';
        document.body.appendChild(div);
        quotaTooltipEl = div;
    }

    function normalizeResetText(resetText) {
        if (!resetText || typeof resetText !== 'string') return '';
        return resetText
            .replace(/^resets\s+(at|on|in)\s+/i, '')
            .trim();
    }

    function updateSendQuotaVisual() {
        if (!sendBtn) return;
        const isFree = freeModelIds.has(selectedModel);
        const activeBusy = isActiveSessionBusy();
        if (activeBusy || (!isFree && (!currentModelQuota || typeof currentModelQuota.summaryRemainingPercent !== 'number'))) {
            sendBtn.classList.remove('has-quota');
            sendBtn.style.removeProperty('--quota-remaining-deg');
            sendBtn.style.removeProperty('--quota-remaining-color');
            sendBtn.style.removeProperty('--quota-used-color');
            vscode.postMessage({
                type: 'ui-debug',
                payload: [
                    'quota.render.skip',
                    `busy=${String(activeBusy)}`,
                    `summary=${currentModelQuota?.summaryRemainingPercent ?? 'null'}`
                ]
            });
            return;
        }
        const remaining = isFree
            ? 100
            : Math.max(0, Math.min(100, Number(currentModelQuota.summaryRemainingPercent || 0)));
        const used = Math.max(0, 100 - remaining);
        const remainingDeg = Math.round(remaining * 3.6);
        const usedDeg = 360 - remainingDeg;
        let centerColor = 'var(--vscode-button-background)';
        if (!isFree && remaining <= 0) {
            sendBtn.style.setProperty('--quota-remaining-color', 'var(--quota-danger)');
            sendBtn.style.setProperty('--quota-used-color', 'var(--quota-danger)');
            centerColor = 'var(--quota-danger)';
        } else if (!isFree && remaining < 10) {
            sendBtn.style.setProperty('--quota-remaining-color', 'var(--quota-warning)');
            sendBtn.style.setProperty('--quota-used-color', 'var(--quota-warning-light)');
            centerColor = 'var(--quota-warning)';
        } else {
            sendBtn.style.removeProperty('--quota-remaining-color');
            sendBtn.style.removeProperty('--quota-used-color');
        }
        sendBtn.style.setProperty('--quota-used-deg', `${usedDeg}deg`);
        sendBtn.style.setProperty('--quota-remaining-deg', `${remainingDeg}deg`);
        sendBtn.style.setProperty('--quota-center-color', centerColor);
        sendBtn.classList.add('has-quota');
        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                'quota.render.ok',
                `remaining=${remaining}`,
                `used=${used}`,
                `hasQuota=${sendBtn.classList.contains('has-quota')}`
            ]
        });
    }

    function showQuotaTooltip() {
        if (!sendBtn || !quotaTooltipEl || isActiveSessionBusy()) return;
        const rows = currentModelQuota && Array.isArray(currentModelQuota.rows) ? currentModelQuota.rows : [];
        const body = rows.length
            ? rows.map((row) => {
                const reset = normalizeResetText(row.resetText);
                return `<div class="quota-tooltip-row"><span class="quota-col-label">${row.label}</span><span class="quota-col-pct">${row.remainingPercent}%</span><span class="quota-col-reset">${reset}</span></div>`;
            }).join('')
            : '<div class="quota-tooltip-row">Quota unavailable</div>';
        quotaTooltipEl.innerHTML = `
            <div class="quota-tooltip-header">
                <span class="quota-tooltip-title"><span class="quota-title-icon">\u25D4</span>Rate limits remaining</span>
            </div>
            ${body}
        `;
        const rect = sendBtn.getBoundingClientRect();
        quotaTooltipEl.classList.remove('hidden');
        quotaTooltipEl.style.visibility = 'hidden';
        const width = quotaTooltipEl.offsetWidth || 196;
        const height = quotaTooltipEl.offsetHeight || 80;
        const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width));
        quotaTooltipEl.style.left = `${left}px`;
        quotaTooltipEl.style.top = `${Math.max(8, rect.top - height - 8)}px`;
        quotaTooltipEl.style.visibility = 'visible';
        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                'quota.tooltip.show',
                `rows=${rows.length}`,
                `busy=${String(isActiveSessionBusy())}`
            ]
        });
    }

    function hideQuotaTooltip() {
        if (!quotaTooltipEl) return;
        quotaTooltipEl.classList.add('hidden');
    }

    function setServerStatus(status, reason) {
        if (!serverStatusDot) return;
        serverStatusDot.classList.remove('status-connected', 'status-reconnecting', 'status-error');
        if (status === 'reconnecting') {
            serverStatusDot.classList.add('status-reconnecting');
            serverStatusDot.title = 'Reconnecting to OpenCode server...';
        } else if (status === 'error') {
            serverStatusDot.classList.add('status-error');
            serverStatusDot.title = 'Server unreachable.';
        } else {
            serverStatusDot.classList.add('status-connected');
            serverStatusDot.title = 'Connected';
        }
        if (reason) {
            vscode.postMessage({ type: 'ui-debug', payload: ['serverStatus', status, reason] });
        }
    }

    setServerStatus('connected', 'default');

    function getSessionOrNull(sessionId) {
        return getSessionState(sessionId, false);
    }

    function setDefaultGreeting() {
        chatContainer.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'message bot';
        const session = getSessionState(activeSessionId);
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

    function getDisplayedAssistantCopyText(message) {
        if (!message || message.role !== 'assistant') return '';
        if (message.meta?.isDiff) {
            return String(message.meta.diffText || message.text || '').trim();
        }
        const isCompleted = message.meta?.isThinking !== true;
        if (isCompleted && Array.isArray(message.meta?.textSegments) && message.meta.textSegments.length > 0) {
            const finalSegment = message.meta.textSegments[message.meta.textSegments.length - 1];
            const finalText = typeof finalSegment === 'string' ? finalSegment.trim() : '';
            if (finalText) return finalText;
        }
        return String(message.text || '').trim();
    }

    function getUserMessageCopyText(message) {
        if (!message || message.role !== 'user') return '';
        const raw = String(message.text || '');
        const sanitized = stripSystemInjections(stripAttachmentManifest(raw));
        const parts = [];
        if (sanitized.trim()) parts.push(sanitized.trim());
        for (const item of getAppendItems(message)) {
            if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
            parts.push(item.text.trim());
        }
        return parts.join('\n\n').trim();
    }

    function getMessageCopyText(message) {
        if (message?.role === 'assistant') return getDisplayedAssistantCopyText(message);
        if (message?.role === 'user') return getUserMessageCopyText(message);
        return '';
    }

    function createMessageCopyCodicon(iconName) {
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${iconName}`;
        icon.setAttribute('aria-hidden', 'true');
        return icon;
    }

    function setMessageCopyButtonState(btn, state) {
        if (!btn) return;
        const isCopied = state === 'copied';
        const isFailed = state === 'failed';
        const label = isCopied ? 'Copied' : isFailed ? 'Copy failed' : 'Copy message';
        btn.replaceChildren(createMessageCopyCodicon(isCopied ? 'check' : 'copy'));
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }

    function attachMessageCopyButton(container, message) {
        if (!container || !message || (message.role !== 'assistant' && message.role !== 'user')) return;
        const text = getMessageCopyText(message);
        if (!text) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `message-copy-btn ${message.role === 'user' ? 'user-copy' : 'assistant-copy'}`;
        setMessageCopyButtonState(btn, 'copy');
        btn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const copied = await writeTextToClipboard(text);
            if (btn._copyResetTimer) clearTimeout(btn._copyResetTimer);
            setMessageCopyButtonState(btn, copied ? 'copied' : 'failed');
            btn._copyResetTimer = setTimeout(() => {
                setMessageCopyButtonState(btn, 'copy');
            }, copied ? 900 : 1200);
        });
        container.appendChild(btn);
    }

    function appendMessageToChat(messageElement, message) {
        if (!messageElement) return;
        if (message?.role !== 'assistant' && message?.role !== 'user') {
            chatContainer.appendChild(messageElement);
            return;
        }
        const row = document.createElement('div');
        row.className = `message-row ${message.role === 'user' ? 'user' : 'bot'}`;
        row.appendChild(messageElement);
        chatContainer.appendChild(row);
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
            renderAssistantMarkdown(content, message);
        } else {
            const rawText = message.text || '';
            const trimmedText = isUser ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, '')) : rawText;
            if (isUser) {
                renderUserMarkdown(content, trimmedText);
            } else {
                content.textContent = trimmedText;
            }
        }
        div.appendChild(content);
        attachMessageCopyButton(div, message);

        appendMessageImages(div, message);

        return div;
    }

    function renderNestedInvalidSegmentElement(session, segment) {
        const card = document.createElement('div');
        card.className = 'reverted-segment nested-invalid-segment';

        const header = document.createElement('div');
        header.className = 'reverted-segment-header';

        const title = document.createElement('div');
        title.className = 'reverted-segment-title';
        const memberMsgIds = Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : [];
        const available = memberMsgIds.filter((id) => session?.messagesById?.has(id)).length;
        title.textContent = `Reverted segment (${available} messages)`;
        header.appendChild(title);
        card.appendChild(header);

        const ruleLine = document.createElement('div');
        ruleLine.className = segment?.restoreAllowed === false ? 'reverted-segment-discarded' : 'reverted-segment-hint';
        ruleLine.textContent = segment?.restoreAllowed === false
            ? 'Segment discarded and unrestorable.'
            : 'You are allowed to restore this segment until the next build prompt.';
        card.appendChild(ruleLine);

        if (available < memberMsgIds.length) {
            const warning = document.createElement('div');
            warning.className = 'reverted-segment-warning';
            warning.textContent = 'Some messages are no longer available.';
            card.appendChild(warning);
        }

        return card;
    }

function renderMessageElement(message, renderedSet) {
    if (renderedSet.has(message.id)) {
        console.warn('[Render] duplicate message skipped', message.id);
        return;
    }
    renderedSet.add(message.id);
    const session = getSessionState(activeSessionId);
    const finalAssistantId = typeof session?.finalAssistantLock?.assistantMsgId === 'string'
        ? session.finalAssistantLock.assistantMsgId
        : null;
    if (message?.role === 'assistant' && finalAssistantId && message.id === finalAssistantId) {
        const currentSegmentLen = typeof message?.meta?.currentSegment === 'string' ? message.meta.currentSegment.length : 0;
        const textSegmentsLen = Array.isArray(message?.meta?.textSegments) ? message.meta.textSegments.length : 0;
        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                '[WV][FINAL_RENDER]',
                `messageId=${message.id}`,
                `textLen=${typeof message.text === 'string' ? message.text.length : 0}`,
                `isThinking=${message?.meta?.isThinking === true}`,
                `statusTextLen=${typeof message?.meta?.statusText === 'string' ? message.meta.statusText.length : 0}`,
                `currentSegmentLen=${currentSegmentLen}`,
                `textSegmentsLen=${textSegmentsLen}`,
                `timelineHas=${Array.isArray(session?.timeline) ? session.timeline.includes(message.id) : false}`
            ]
        });
    }

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

        let maxStatDigits = 1;
        for (const rawPath of files) {
            if (typeof rawPath !== 'string' || !rawPath.length) continue;
            const normalized = rawPath.replace(/\\/g, '/');
            const stats = statsByPath[normalized];
            if (!stats) continue;
            const candidates = [stats.additions, stats.deletions];
            for (const value of candidates) {
                if (!Number.isFinite(value)) continue;
                const digits = Math.max(1, String(Math.abs(value)).length);
                if (digits > maxStatDigits) maxStatDigits = digits;
            }
        }
        list.style.setProperty('--delta-col-width', `${maxStatDigits + 1}ch`);

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
            summary.addEventListener('click', () => {
                if (/\.md$/i.test(normalized)) {
                    vscode.postMessage({
                        type: 'openFileAtLocation',
                        path: normalized,
                        sessionId: activeSessionId || null
                    });
                    return;
                }
                postOpenGitDiff(normalized, activeSessionId, commitHead, commitBase);
            });

            const baseSpan = document.createElement('span');
            baseSpan.className = 'conflict-card-file';
            baseSpan.textContent = base;

            const dirSpan = document.createElement('span');
            dirSpan.className = 'conflict-card-path';
            dirSpan.textContent = dir;

            const nameWrap = document.createElement('span');
            nameWrap.className = 'conflict-card-name';
            nameWrap.appendChild(baseSpan);
            if (dir) {
                const pathSep = document.createElement('span');
                pathSep.className = 'conflict-card-path-sep';
                pathSep.textContent = '|';
                nameWrap.appendChild(pathSep);
                nameWrap.appendChild(dirSpan);
            }

            const stats = statsByPath[normalized];
            const showStats = stats && (Number.isFinite(stats.additions) || Number.isFinite(stats.deletions));
            let statsWrap = null;
            if (showStats) {
                statsWrap = document.createElement('span');
                statsWrap.className = 'change-list-stats';

                const deltaWrap = document.createElement('span');
                deltaWrap.className = 'change-delta';

                const addSpan = document.createElement('span');
                addSpan.className = 'delta plus';
                addSpan.textContent = Number.isFinite(stats.additions) ? `+${stats.additions}` : '';
                deltaWrap.appendChild(addSpan);

                const sep = document.createElement('span');
                sep.className = 'sep';
                sep.textContent = '|';
                deltaWrap.appendChild(sep);

                const delSpan = document.createElement('span');
                delSpan.className = 'delta minus';
                delSpan.textContent = Number.isFinite(stats.deletions) ? `-${stats.deletions}` : '';
                deltaWrap.appendChild(delSpan);

                statsWrap.appendChild(deltaWrap);
            }

            summary.appendChild(nameWrap);
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
            title.textContent = `Reverted segment (${available} messages)`;

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

            if (!collapsed && session) {
                const nestedWrap = document.createElement('div');
                nestedWrap.className = 'reverted-segment-body';
                for (const id of memberMsgIds) {
                    const msg = session.messagesById.get(id);
                    if (!msg) continue;
                    nestedWrap.appendChild(renderNestedMessageElement(msg));
                }
                const mergedInvalidSegments = Array.isArray(segment?.mergedInvalidSegments)
                    ? segment.mergedInvalidSegments
                        .map((child) => sanitizeMergedSegmentSnapshot(child))
                        .filter(Boolean)
                    : [];
                for (const child of mergedInvalidSegments) {
                    nestedWrap.appendChild(renderNestedInvalidSegmentElement(session, child));
                }
                if (nestedWrap.childNodes.length > 0) {
                    card.appendChild(nestedWrap);
                }
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
            // Streaming animation lives on outer bubble (.streaming).
            // Keep .streaming off inner content.
            div.classList.add('streaming');
        }
        div.dataset.messageId = message.id;

        const content = document.createElement('div');
        content.className = 'message-content';
        const raw = message.text || '';
        if (message.meta?.isDiff) {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = message.meta.diffText || raw;
            pre.appendChild(code);
            content.appendChild(pre);
        } else if (message.role === 'assistant') {
            // For completed main-agent messages, render only final text (last segment)
            const isCompleted = message.meta?.isThinking !== true;
            if (isCompleted && Array.isArray(message.meta?.textSegments) && message.meta.textSegments.length > 0) {
                // Render only the last segment (final text)
                const finalSegment = message.meta.textSegments[message.meta.textSegments.length - 1];
                const finalText = typeof finalSegment === 'string' ? finalSegment.trim() : '';
                if (finalText) {
                    const tempMessage = { ...message, text: finalText };
                    renderAssistantMarkdown(content, tempMessage);
                } else {
                    // Fallback to full text if final segment is empty
                    renderAssistantMarkdown(content, message);
                }
            } else {
                // Streaming or no segments: render full accumulated text
                renderAssistantMarkdown(content, message);
            }
        } else {
            const sanitized = message.role === 'user' ? stripSystemInjections(stripAttachmentManifest(raw)) : raw;
            if (message.role === 'user' && !sanitized.trim()) {
                return;
            }
            if (message.role === 'user') {
                const mainText = document.createElement('div');
                mainText.className = 'message-user-text';
                renderUserMarkdown(mainText, sanitized);
                content.appendChild(mainText);
                for (const item of getAppendItems(message)) {
                    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
                    const block = document.createElement('div');
                    block.className = 'append-message-block';
                    const divider = document.createElement('div');
                    divider.className = 'append-message-divider';
                    block.appendChild(divider);
                    const textEl = document.createElement('div');
                    textEl.className = 'append-message-text';
                    renderUserMarkdown(textEl, item.text);
                    block.appendChild(textEl);
                    if (item.status && item.status !== 'applied') {
                        const status = document.createElement('div');
                        status.className = `append-message-status append-${item.status}`;
                        status.textContent = item.status === 'failed'
                            ? 'Append failed'
                            : item.status === 'rejected'
                                ? 'Append unavailable'
                                : item.status === 'seen'
                                    ? 'Received'
                                    : item.status === 'queued'
                                        ? 'Queued'
                                        : 'Sending...';
                        block.appendChild(status);
                    }
                    content.appendChild(block);
                }
            } else {
                content.textContent = sanitized;
            }
        }
        div.appendChild(content);
        attachMessageCopyButton(div, message);

        if (shouldShowBackgroundSubagentIndicator(session, message)) {
            div.classList.add('has-background-subagent-indicator');
            const bgIndicator = document.createElement('span');
            bgIndicator.className = 'message-background-subagent-indicator';
            bgIndicator.title = 'Background subagent is still running';
            bgIndicator.setAttribute('aria-label', 'Background subagent is still running');
            div.appendChild(bgIndicator);
        }

        if (message.meta?.isThinking && message.meta?.statusText) {
            // statusText rendered only during streaming.
            const statusDiv = document.createElement('div');
            statusDiv.className = 'message-status';
            statusDiv.textContent = message.meta.statusText;
            div.appendChild(statusDiv);
        }
        
        // Subagents display inline with assistant text flow.
        const subagents = message.meta?.subagents || [];
        if (subagents.length > 0 && message.meta?.isThinking) {
             const inlineContainer = document.createElement('div');
             inlineContainer.className = 'subagent-inline';
             const messageIsThinking = Boolean(message.meta?.isThinking);

            function pickMode(agent) {
                if (typeof agent.mode === 'string' && agent.mode.trim()) return agent.mode.trim();
                if (typeof agent.description === 'string' && agent.description.trim()) return agent.description.trim();
                return '';
            }

            function cleanSubagentTitle(title) {
                const raw = typeof title === 'string' ? title.trim() : '';
                if (!raw) return 'Subagent';
                return raw
                    .replace(/\s*[（(]\s*@[^()]*[)）]\s*$/i, '')
                    .trim() || 'Subagent';
            }

            function formatSubagentModel(agent) {
                const modelId = (typeof agent.model === 'string' && agent.model.trim()) ? agent.model.trim() : '';
                const providerId = (typeof agent.providerId === 'string' && agent.providerId.trim()) ? agent.providerId.trim() : '';
                if (modelId && providerId) return `${modelId}/${providerId}`;
                return modelId || providerId || '';
            }

            function addSubagentTextToggle(textRow, options = {}) {
                const collapsedLineCount = 5;
                let collapsedMaxHeight = '7.5em';
                const previewText = typeof options.previewText === 'string' ? options.previewText : '';
                const fullText = typeof options.fullText === 'string' ? options.fullText : previewText;
                const expandedKey = typeof options.expandedKey === 'string' ? options.expandedKey : '';
                const canExpandToFullText = fullText && fullText !== previewText;
                const hasToggleText = Boolean(previewText || fullText);
                let expanded = expandedKey ? subagentTextExpandedByKey.get(expandedKey) === true : false;

                const renderCurrentText = () => {
                    renderMarkdownInto(textRow, expanded && canExpandToFullText ? fullText : previewText);
                };

                const setTextRowClamp = () => {
                    textRow.style.setProperty('display', 'block', 'important');
                    textRow.style.setProperty('white-space', 'normal', 'important');
                    textRow.style.setProperty('text-overflow', 'clip', 'important');
                    textRow.style.setProperty('-webkit-line-clamp', 'unset', 'important');
                    textRow.style.setProperty('-webkit-box-orient', 'initial', 'important');
                    textRow.style.setProperty('max-height', expanded ? 'none' : collapsedMaxHeight, 'important');
                    textRow.style.setProperty('height', expanded ? 'auto' : 'auto', 'important');
                    textRow.style.setProperty('overflow', expanded ? 'visible' : 'hidden', 'important');
                    textRow.style.setProperty('overflow-x', expanded ? 'visible' : 'hidden', 'important');
                    textRow.style.setProperty('overflow-y', expanded ? 'visible' : 'hidden', 'important');
                };
                renderCurrentText();
                setTextRowClamp();

                const toggleButton = document.createElement('button');
                toggleButton.type = 'button';
                toggleButton.className = 'subagent-inline-text-toggle';
                toggleButton.textContent = expanded ? 'Show less' : 'Show more';
                toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                toggleButton.style.display = hasToggleText ? 'block' : 'none';

                const computeCollapsedMaxHeight = () => {
                    const computed = window.getComputedStyle(textRow);
                    const fontSize = Number.parseFloat(computed.fontSize || '0') || 12;
                    const lineHeight = Number.parseFloat(computed.lineHeight || '0') || (fontSize * 1.4);
                    collapsedMaxHeight = `${Math.ceil(lineHeight * collapsedLineCount) + 2}px`;
                };

                const updateExpandedState = () => {
                    renderCurrentText();
                    setTextRowClamp();
                    toggleButton.textContent = expanded ? 'Show less' : 'Show more';
                    toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                };

                toggleButton.addEventListener('click', () => {
                    expanded = !expanded;
                    if (expandedKey) {
                        subagentTextExpandedByKey.set(expandedKey, expanded);
                    }
                    updateExpandedState();
                    requestAnimationFrame(() => {
                        if (!textRow.isConnected) return;
                        computeCollapsedMaxHeight();
                        setTextRowClamp();
                    });
                });

                requestAnimationFrame(() => {
                    if (!textRow.isConnected) return;
                    computeCollapsedMaxHeight();
                    setTextRowClamp();
                });

                return toggleButton;
            }

             subagents.forEach((agent, index) => {
                 const entry = document.createElement('div');
                 entry.className = 'subagent-inline-entry';

                 // 1) Subagent N: [title],
                 const header = document.createElement('div');
                 header.className = 'subagent-inline-header';
                 const rawTitleText = (typeof agent.title === 'string' && agent.title.trim()) ? agent.title.trim() : '';
                 const titleText = cleanSubagentTitle(rawTitleText);
                 const headerIcon = document.createElement('span');
                 headerIcon.className = 'subagent-inline-icon';
                 const stateForIcon = typeof agent.state === 'string' ? agent.state : (agent.isDone === true ? 'done' : 'running');
                 const doneForIcon = stateForIcon === 'done';
                 headerIcon.textContent = doneForIcon ? '\u25CF' : '\u25CB';
                 headerIcon.style.color = doneForIcon ? '#22c55e' : '#f59e0b';
                 header.appendChild(headerIcon);
                 header.appendChild(document.createTextNode(`Subagent ${index + 1}: ${titleText}`));
                 entry.appendChild(header);

                 // 2) indented [description], [model]
                 const mode = pickMode(agent);
                 const model = formatSubagentModel(agent);
                 if (mode || model) {
                     const metaRow = document.createElement('div');
                     metaRow.className = 'subagent-inline-meta';
                     metaRow.textContent = mode && model ? `${mode}, ${model}` : (mode || model);
                     entry.appendChild(metaRow);
                 }

                const latestText = typeof agent.latestText === 'string' ? agent.latestText.trim() : '';
                const latestFullText = typeof agent.latestFullText === 'string' ? agent.latestFullText.trim() : latestText;
                const latestTool = typeof agent.latestTool === 'string' ? agent.latestTool.trim() : '';
                const latestToolInput = typeof agent.latestToolInput === 'string' ? agent.latestToolInput.trim() : '';
                const state = typeof agent.state === 'string' ? agent.state : (agent.isDone === true ? 'done' : 'running');
                const isTerminal = state === 'done' || state === 'failed' || state === 'cancelled';
                const isDone = isTerminal || (!messageIsThinking && !latestText && !latestTool);

                if (isDone) {
                    const doneRow = document.createElement('div');
                    doneRow.className = 'subagent-inline-done';
                    doneRow.textContent = state === 'failed' ? 'Task failed.' : state === 'cancelled' ? 'Task cancelled.' : 'Task done.';
                    entry.appendChild(doneRow);
                    inlineContainer.appendChild(entry);
                    return;
                }

                // 3) indented latest text (streaming only)
                if (state === 'finalizing') {
                    const textRow = document.createElement('div');
                    textRow.className = 'subagent-inline-text';
                    textRow.textContent = 'Finalizing...';
                    entry.appendChild(textRow);
                } else if (latestText) {
                    const textRow = document.createElement('div');
                    textRow.className = 'subagent-inline-text';
                    const dedupeSubagentText = (value) => {
                        let textToRender = typeof value === 'string' ? value : '';
                        if (rawTitleText && textToRender.startsWith(rawTitleText)) {
                            textToRender = textToRender.slice(rawTitleText.length).trim();
                        } else if (titleText && textToRender.startsWith(titleText)) {
                            textToRender = textToRender.slice(titleText.length).trim();
                        }
                        return textToRender;
                    };
                    const previewTextToRender = dedupeSubagentText(latestText);
                    const fullTextToRender = dedupeSubagentText(latestFullText || latestText);
                    const subagentIdentity = agent.agentSessionId || agent.sessionId || agent.taskId || '';
                    const parentIdentity = agent.parentSessionId || message.sessionId || activeSessionId || '';
                    const messageIdentity = message.id || message.messageId || '';
                    const expandedKey = subagentIdentity
                        ? `${parentIdentity}:${messageIdentity}:${subagentIdentity}`
                        : '';
                    renderMarkdownInto(textRow, subagentTextExpandedByKey.get(expandedKey) === true ? fullTextToRender : previewTextToRender);
                    entry.appendChild(textRow);
                    entry.appendChild(addSubagentTextToggle(textRow, {
                        previewText: previewTextToRender,
                        fullText: fullTextToRender,
                        expandedKey
                    }));
                }

                 // 4) indented latest tool (streaming only)
                 if (latestTool) {
                     const toolRow = document.createElement('div');
                     toolRow.className = 'subagent-inline-tool';
                     toolRow.textContent = `\u25B8 ${latestTool}`;
                     entry.appendChild(toolRow);
                 }

                 if (latestToolInput) {
                     const inputRow = document.createElement('div');
                     inputRow.className = 'subagent-inline-input';
                     inputRow.textContent = latestToolInput;
                     entry.appendChild(inputRow);
                 }
                 inlineContainer.appendChild(entry);
             });
             content.appendChild(inlineContainer);
        }

        appendMessageImages(div, message);

        // Insert turn divider before user messages (except first)
        if (message.role === 'user' && renderedSet && renderedSet.size > 0) {
            const hasUserMessages = Array.from(renderedSet).some(id => {
                const session = getSessionState(activeSessionId);
                if (!session) return false;
                const msg = session.messagesById.get(id);
                return msg && msg.role === 'user';
            });
            if (hasUserMessages) {
                const divider = document.createElement('div');
                divider.className = 'turn-divider';
                chatContainer.appendChild(divider);
            }
        }
        if (message.role === 'user') {
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const isAppendableActiveUserMessage = canAppendToMessage(session, message);
            const appendHoverKey = isAppendableActiveUserMessage
                ? buildAppendHoverKey(activeSessionId, message.id)
                : null;
            if (appendHoverKey && appendHoverActiveKey === appendHoverKey) {
                div.classList.add('append-hover-active');
            }
            if (appendHoverKey) {
                const keepAppendHoverActive = () => setAppendHoverActive(appendHoverKey);
                const releaseAppendHoverActive = () => scheduleClearAppendHover(appendHoverKey);
                div.addEventListener('mouseenter', keepAppendHoverActive);
                div.addEventListener('mouseleave', releaseAppendHoverActive);
                div.addEventListener('focusin', keepAppendHoverActive);
                div.addEventListener('focusout', releaseAppendHoverActive);
                actions.addEventListener('mouseenter', keepAppendHoverActive);
                actions.addEventListener('mouseleave', releaseAppendHoverActive);
                actions.addEventListener('focusin', keepAppendHoverActive);
                actions.addEventListener('focusout', releaseAppendHoverActive);
            }
            if (isAppendableActiveUserMessage) {
                const appendBtn = document.createElement('button');
                appendBtn.className = 'append-btn';
                appendBtn.type = 'button';
                appendBtn.title = 'Append to this message';
                appendBtn.textContent = '+';
                appendBtn.addEventListener('click', () => {
                    setAppendHoverActive(appendHoverKey);
                    enterAppendInputMode(message.id);
                });
                actions.appendChild(appendBtn);
            }
            if (!gitUndoEnabled) {
                div.appendChild(actions);
                appendMessageToChat(div, message);
                return;
            }
            if (isAppendableActiveUserMessage) {
                div.appendChild(actions);
                appendMessageToChat(div, message);
                return;
            }
            const undoBtn = document.createElement('button');
            undoBtn.className = 'undo-btn';
            undoBtn.type = 'button';
            undoBtn.title = 'Undo to this message';
            undoBtn.textContent = '\u21BA';
            undoBtn.addEventListener('click', () => {
                if (isBusy) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][UNDO_BLOCKED]', 'reason=busy', `busySessionId=${busySessionId || 'null'}`, `activeSessionId=${activeSessionId || 'null'}`]
                    });
                    return;
                }
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
                discardAllSegments(sessionId, 'undo', selectedMode || 'unknown', { anchorMsgId: verdict.msgId });
                handleUndoToMessage(sessionId, verdict.msgId);
                window.__oc?.renderFromState?.();
                logSessionState(sessionId, 'UI_UNDO_TO_MESSAGE');
            });
            actions.appendChild(undoBtn);
            div.appendChild(actions);
        }


        // Todo list (below temporary assistant bubble only)
        if (message.role === 'assistant' && message.meta?.isThinking === true &&
            Array.isArray(message.meta?.todos) && message.meta.todos.length > 0) {
            const todoCard = document.createElement('div');
            todoCard.className = 'todo-list';
            const todoTitle = document.createElement('div');
            todoTitle.className = 'todo-title';
            todoTitle.textContent = 'Todo list';
            todoCard.appendChild(todoTitle);
            for (const todo of message.meta.todos) {
                if (!todo || typeof todo.content !== 'string') continue;
                const item = document.createElement('div');
                const status = todo.status || 'pending';
                item.className = `todo-item todo-${status}`;
                const check = document.createElement('span');
                check.className = 'todo-check';
                check.textContent = status === 'completed' ? '\u2713' : status === 'in_progress' ? '\u25CF' : '\u25CB';
                const label = document.createElement('span');
                label.className = 'todo-content';
                label.textContent = todo.content;
                item.appendChild(check);
                item.appendChild(label);
                todoCard.appendChild(item);
            }
            div.appendChild(todoCard);
        }
        appendMessageToChat(div, message);
    }

    function getMessageKeyFromChatChild(child) {
        if (!child) return '';
        const direct = child.dataset?.messageId || child.dataset?.segmentKey || '';
        if (direct) return direct;
        const nested = child.querySelector?.('[data-message-id], [data-segment-key]');
        return nested?.dataset?.messageId || nested?.dataset?.segmentKey || '';
    }

    function getLastRenderedChatKey() {
        if (!chatContainer) return '';
        for (let i = chatContainer.children.length - 1; i >= 0; i -= 1) {
            const key = getMessageKeyFromChatChild(chatContainer.children[i]);
            if (key) return key;
        }
        return '';
    }

    function normalizeRenderedTailKey(session, key) {
        const raw = typeof key === 'string' ? key : '';
        const aliases = new Set();
        if (!raw) return { kind: 'empty', primary: '', aliases };

        aliases.add(raw);
        if (raw.startsWith('seg:')) aliases.add(raw.slice(4));

        const unsegmented = raw.startsWith('seg:') ? raw.slice(4) : raw;
        if (unsegmented.startsWith('system:undo-seg:')) {
            const noticeKey = unsegmented.slice('system:undo-seg:'.length);
            if (noticeKey) {
                aliases.add(noticeKey);
                aliases.add(`seg:${noticeKey}`);
            }
            return { kind: 'undo-placeholder', primary: noticeKey || unsegmented, aliases };
        }

        if (session?.segmentsByNoticeKey instanceof Map) {
            if (session.segmentsByNoticeKey.has(unsegmented)) {
                aliases.add(`seg:${unsegmented}`);
                aliases.add(getUndoPlaceholderId(unsegmented));
                return { kind: 'segment-notice', primary: unsegmented, aliases };
            }
            for (const [noticeKey, segment] of session.segmentsByNoticeKey.entries()) {
                if (!segment) continue;
                const memberMsgIds = Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [];
                if (segment.noticeKey === unsegmented || segment.anchorMsgId === unsegmented || segment.endMsgId === unsegmented || memberMsgIds.includes(unsegmented)) {
                    aliases.add(noticeKey);
                    aliases.add(`seg:${noticeKey}`);
                    aliases.add(getUndoPlaceholderId(noticeKey));
                    return { kind: 'segment-member', primary: noticeKey, aliases };
                }
            }
        }

        if (session?.messagesById instanceof Map && session.messagesById.has(unsegmented)) {
            aliases.add(unsegmented);
            return { kind: 'message', primary: unsegmented, aliases };
        }
        return { kind: 'unknown', primary: unsegmented, aliases };
    }

    function renderedTailKeysMatch(session, leftKey, rightKey) {
        const left = normalizeRenderedTailKey(session, leftKey);
        const right = normalizeRenderedTailKey(session, rightKey);
        if (!left.primary || !right.primary) return false;
        if (left.primary === right.primary) return true;
        for (const alias of left.aliases) {
            if (right.aliases.has(alias)) return true;
        }
        return false;
    }

    function getComputedPreviousRenderedTailKeyExcludingCandidate(session, candidateMessageId) {
        const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
        const appendChildPresentationIndex = buildAppendChildPresentationIndex(session);
        let previousKey = '';
        for (const id of timeline) {
            if (id === candidateMessageId) continue;
            if (typeof id !== 'string' || !id) continue;
            const msg = session.messagesById?.get?.(id);
            if (!msg) continue;
            if (id.startsWith('system:undo:')) {
                const segment = session.segmentsByNoticeKey?.get?.(id);
                if (segment) {
                    previousKey = id;
                } else if (!(session.hiddenSet instanceof Set && session.hiddenSet.has(id)) && !shouldHideDcpUiMessage(msg)) {
                    previousKey = id;
                }
                continue;
            }
            if (session.hiddenSet instanceof Set && session.hiddenSet.has(id)) continue;
            if (isAppendChildTopLevelUser(session, msg, id, appendChildPresentationIndex)) continue;
            if (isAppendChainTopLevelAssistantHidden(session, msg, id, appendChildPresentationIndex)) continue;
            if (shouldHideDcpUiMessage(msg)) continue;
            if (msg.role === 'user' && !stripSystemInjections(stripAttachmentManifest(msg.text || '')).trim()) continue;
            previousKey = id;
        }
        return previousKey;
    }

    function getTailSafetyContext(session, candidateMessageId, domLastRenderedKey, computedPreviousRenderedTailKey) {
        const hiddenCount = session?.hiddenSet instanceof Set ? session.hiddenSet.size : 0;
        const segmentCount = session?.segmentsByNoticeKey instanceof Map ? session.segmentsByNoticeKey.size : 0;
        const domKeyInfo = normalizeRenderedTailKey(session, domLastRenderedKey);
        const computedKeyInfo = normalizeRenderedTailKey(session, computedPreviousRenderedTailKey);
        return [
            `hidden=${hiddenCount}`,
            `segments=${segmentCount}`,
            `domLastRendered=${domLastRenderedKey || 'null'}`,
            `computedPreviousRenderedTail=${computedPreviousRenderedTailKey || 'null'}`,
            `domLastRenderedNormalized=${domKeyInfo.primary || 'null'}`,
            `computedPreviousRenderedTailNormalized=${computedKeyInfo.primary || 'null'}`,
            `domKeyKind=${domKeyInfo.kind || 'unknown'}`,
            `computedKeyKind=${computedKeyInfo.kind || 'unknown'}`,
            `candidateKeyKind=${normalizeRenderedTailKey(session, candidateMessageId).kind || 'unknown'}`
        ];
    }

    function getTimelineIndexForRenderedTailKey(session, key) {
        const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
        const info = normalizeRenderedTailKey(session, key);
        if (!info.primary) return -1;
        for (let i = 0; i < timeline.length; i += 1) {
            if (renderedTailKeysMatch(session, timeline[i], key)) return i;
        }
        return -1;
    }

    function getRenderedDomKeyMatches(session, key) {
        const matches = [];
        if (!chatContainer || !key) return matches;
        for (const child of chatContainer.children) {
            const domKey = getMessageKeyFromChatChild(child);
            if (domKey && renderedTailKeysMatch(session, domKey, key)) {
                matches.push(domKey);
            }
        }
        return matches;
    }

    function resolveHiddenTailSegmentBoundary(session, hiddenId, targetIndex, computedPreviousRenderedTailKey) {
        const segmentsByNoticeKey = session?.segmentsByNoticeKey instanceof Map ? session.segmentsByNoticeKey : new Map();
        const hiddenVariants = getPresentationMessageKeyVariants(session, hiddenId);
        hiddenVariants.add(hiddenId);
        const owners = [];
        for (const [noticeKey, segment] of segmentsByNoticeKey.entries()) {
            if (!noticeKey || !segment || segment.collapsed === false) continue;
            const memberMsgIds = Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [];
            let matchedMember = '';
            for (const memberId of memberMsgIds) {
                if (typeof memberId !== 'string' || !memberId) continue;
                const memberVariants = getPresentationMessageKeyVariants(session, memberId);
                memberVariants.add(memberId);
                for (const variant of memberVariants) {
                    if (hiddenVariants.has(variant)) {
                        matchedMember = memberId;
                        break;
                    }
                }
                if (matchedMember) break;
            }
            if (matchedMember) owners.push({ noticeKey, segment, matchedMember });
        }
        if (owners.length !== 1) {
            return { resolved: false, reason: owners.length === 0 ? 'unresolved-hidden-segment' : 'multiple-hidden-segment-owners', ownerCount: owners.length };
        }

        const owner = owners[0];
        const placeholderKey = getUndoPlaceholderId(owner.noticeKey);
        const noticeIndex = session.timeline.indexOf(owner.noticeKey);
        const placeholderIndex = session.timeline.indexOf(placeholderKey);
        const visibleKey = noticeIndex >= 0 ? owner.noticeKey : (placeholderIndex >= 0 ? placeholderKey : '');
        const visibleIndex = noticeIndex >= 0 ? noticeIndex : placeholderIndex;
        if (!visibleKey || visibleIndex < 0) {
            return { resolved: false, reason: 'missing-visible-segment-boundary', noticeKey: owner.noticeKey, placeholderKey };
        }
        if (visibleIndex >= targetIndex) {
            return { resolved: false, reason: 'segment-after-append-target', noticeKey: owner.noticeKey, placeholderKey, visibleKey, visibleIndex };
        }

        const computedTailIndex = getTimelineIndexForRenderedTailKey(session, computedPreviousRenderedTailKey);
        if (computedTailIndex < 0 || visibleIndex >= computedTailIndex) {
            return { resolved: false, reason: 'segment-boundary-unproven', noticeKey: owner.noticeKey, placeholderKey, visibleKey, visibleIndex, computedTailIndex };
        }

        const domMatches = getRenderedDomKeyMatches(session, visibleKey);
        if (domMatches.length !== 1) {
            return { resolved: false, reason: domMatches.length === 0 ? 'missing-segment-boundary-dom' : 'multiple-segment-boundary-dom', noticeKey: owner.noticeKey, placeholderKey, visibleKey, visibleIndex, computedTailIndex, domMatches };
        }

        return {
            resolved: true,
            kind: 'collapsed-segment',
            relation: 'hidden-member-before-rendered-tail',
            hiddenId,
            matchedMember: owner.matchedMember,
            noticeKey: owner.noticeKey,
            placeholderKey,
            visibleKey,
            visibleBoundaryKey: domMatches[0],
            visibleIndex,
            computedTailIndex
        };
    }

    function proveHiddenTailSafeForUserAppend(session, candidateMessageId, targetIndex, domLastRenderedKey, computedPreviousRenderedTailKey) {
        const baseFields = getTailSafetyContext(session, candidateMessageId, domLastRenderedKey, computedPreviousRenderedTailKey);
        const hiddenSet = session?.hiddenSet instanceof Set ? session.hiddenSet : new Set();
        const segmentsByNoticeKey = session?.segmentsByNoticeKey instanceof Map ? session.segmentsByNoticeKey : new Map();
        const segmentAwareResolutions = [];

        if (hiddenSet.has(candidateMessageId)) {
            return { safe: false, reason: 'hidden-includes-new-message', fields: baseFields };
        }

        for (const hiddenId of hiddenSet) {
            const hiddenIndex = session.timeline.indexOf(hiddenId);
            if (hiddenIndex < 0) {
                const resolved = resolveHiddenTailSegmentBoundary(session, hiddenId, targetIndex, computedPreviousRenderedTailKey);
                if (!resolved.resolved) {
                    return { safe: false, reason: 'hidden-tail-ambiguous', fields: [...baseFields, 'hiddenIndexResolution=segment-aware', `hiddenTailSubreason=${resolved.reason || 'unresolved-hidden-segment'}`, `hiddenId=${hiddenId || 'null'}`, `hiddenIndex=${hiddenIndex}`, `ownerCount=${resolved.ownerCount ?? 'null'}`, `noticeKey=${resolved.noticeKey || 'null'}`, `placeholderKey=${resolved.placeholderKey || 'null'}`, `visibleKey=${resolved.visibleKey || 'null'}`, `visibleIndex=${resolved.visibleIndex ?? 'null'}`, `computedTailIndex=${resolved.computedTailIndex ?? 'null'}`] };
                }
                segmentAwareResolutions.push(resolved);
                continue;
            }
            if (hiddenIndex >= targetIndex) {
                return { safe: false, reason: 'hidden-tail-ambiguous', fields: [...baseFields, `hiddenId=${hiddenId || 'null'}`, `hiddenIndex=${hiddenIndex}`] };
            }
        }

        for (const [noticeKey, segment] of segmentsByNoticeKey.entries()) {
            const memberMsgIds = Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : [];
            if (memberMsgIds.includes(candidateMessageId) || segment?.anchorMsgId === candidateMessageId || segment?.endMsgId === candidateMessageId) {
                return { safe: false, reason: 'hidden-includes-new-message', fields: [...baseFields, `noticeKey=${noticeKey || 'null'}`] };
            }
            const noticeIndex = session.timeline.indexOf(noticeKey);
            const placeholderIndex = session.timeline.indexOf(getUndoPlaceholderId(noticeKey));
            const indexes = memberMsgIds.map((id) => session.timeline.indexOf(id)).filter((idx) => idx >= 0);
            if (noticeIndex >= targetIndex || placeholderIndex >= targetIndex || indexes.some((idx) => idx >= targetIndex)) {
                return { safe: false, reason: 'hidden-tail-ambiguous', fields: [...baseFields, `noticeKey=${noticeKey || 'null'}`, `noticeIndex=${noticeIndex}`, `placeholderIndex=${placeholderIndex}`] };
            }
        }

        if (!domLastRenderedKey || !computedPreviousRenderedTailKey || !renderedTailKeysMatch(session, domLastRenderedKey, computedPreviousRenderedTailKey)) {
            return { safe: false, reason: 'hidden-last-rendered-key-mismatch', fields: baseFields };
        }

        const previousTimelineId = session.timeline[targetIndex - 1] || '';
        if (!previousTimelineId || hiddenSet.has(previousTimelineId) || previousTimelineId.startsWith('system:undo-seg:')) {
            return { safe: false, reason: 'hidden-segment-boundary-adjacent', fields: [...baseFields, `previousTimelineId=${previousTimelineId || 'null'}`] };
        }
        for (const [noticeKey, segment] of segmentsByNoticeKey.entries()) {
            const memberMsgIds = Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : [];
            if (noticeKey === previousTimelineId || segment?.anchorMsgId === previousTimelineId || segment?.endMsgId === previousTimelineId || memberMsgIds.includes(previousTimelineId)) {
                return { safe: false, reason: 'hidden-segment-boundary-adjacent', fields: [...baseFields, `noticeKey=${noticeKey || 'null'}`, `previousTimelineId=${previousTimelineId}`] };
            }
        }

        const segmentAwareFields = segmentAwareResolutions.length
            ? [
                'hiddenIndexResolution=segment-aware',
                `resolvedHiddenIds=${formatList(segmentAwareResolutions.map((item) => item.hiddenId), 8)}`,
                `resolvedSegmentKeys=${formatList(segmentAwareResolutions.map((item) => item.noticeKey), 8)}`,
                `resolvedPlaceholderKeys=${formatList(segmentAwareResolutions.map((item) => item.placeholderKey), 8)}`,
                `visibleBoundaryKeys=${formatList(segmentAwareResolutions.map((item) => item.visibleBoundaryKey), 8)}`,
                `orderProof=${formatList(segmentAwareResolutions.map((item) => `${item.visibleIndex}<${item.computedTailIndex}`), 8)}`
            ]
            : [];
        return { safe: true, reason: hiddenSet.size > 0 || segmentsByNoticeKey.size > 0 ? 'hidden-tail-safe' : 'clean-tail-safe', fields: [...baseFields, ...segmentAwareFields] };
    }

    function getRenderedMessageIdSetFromDom() {
        const ids = new Set();
        if (!chatContainer) return ids;
        for (const el of chatContainer.querySelectorAll('[data-message-id]')) {
            const id = el?.dataset?.messageId || '';
            if (id) ids.add(id);
        }
        return ids;
    }

    function findPreviousVisibleTimelineMessageId(session, messageId) {
        const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
        const targetIndex = timeline.lastIndexOf(messageId);
        if (targetIndex <= 0) return '';
        const appendChildPresentationIndex = buildAppendChildPresentationIndex(session);
        for (let i = targetIndex - 1; i >= 0; i -= 1) {
            const id = timeline[i];
            if (typeof id !== 'string' || !id) continue;
            const msg = session.messagesById?.get?.(id);
            if (!msg) continue;
            if (session.hiddenSet instanceof Set && session.hiddenSet.has(id)) continue;
            if (isAppendChildTopLevelUser(session, msg, id, appendChildPresentationIndex)) continue;
            if (isAppendChainTopLevelAssistantHidden(session, msg, id, appendChildPresentationIndex)) continue;
            if (shouldHideDcpUiMessage(msg)) continue;
            if (msg.role === 'user' && !stripSystemInjections(stripAttachmentManifest(msg.text || '')).trim()) continue;
            return id;
        }
        return '';
    }

    function bailUserMessageAppendFastPath(reason, fields = []) {
        countUserMessageAppendFastPathResult('fallback-full-render', [`reason=${reason || 'unknown'}`, ...fields]);
        countUserMessageAppendFastPathBail(reason, fields);
        return { applied: false, reason: reason || 'unknown' };
    }

    function tryAppendUserMessageFastPath(sessionId, messageId, source = 'unknown') {
        const fields = [`sessionId=${sessionId || 'null'}`, `messageId=${messageId || 'null'}`, `source=${source || 'unknown'}`];
        if (!chatContainer) return bailUserMessageAppendFastPath('missing-chat-container', fields);
        if (!sessionId || sessionId !== activeSessionId) {
            return bailUserMessageAppendFastPath('inactive-session', [...fields, `activeSessionId=${activeSessionId || 'null'}`]);
        }
        const session = getSessionState(sessionId);
        if (!session || !(session.messagesById instanceof Map) || !Array.isArray(session.timeline)) {
            return bailUserMessageAppendFastPath('session-mismatch', fields);
        }
        if (typeof messageId !== 'string' || !messageId.length) {
            return bailUserMessageAppendFastPath('missing-message-id', fields);
        }
        const message = session.messagesById.get(messageId);
        if (!message || message.role !== 'user') {
            return bailUserMessageAppendFastPath('message-not-user', [...fields, `role=${message?.role || 'null'}`]);
        }
        if (message.meta?.syntheticUser === true || isHiddenControlUserText(message.text || '')) {
            return bailUserMessageAppendFastPath('hidden-control-user', fields);
        }
        if (sessionSearch.open || String(sessionSearch.query || '').trim() || sessionSearch.smartInFlight || sessionSearch.mode === 'smart' || sessionSearch.matches.length > 0) {
            return bailUserMessageAppendFastPath('search-state-active', [...fields, `searchMode=${sessionSearch.mode || 'text'}`, `matches=${sessionSearch.matches.length}`]);
        }
        if (chatContainer.querySelector(`[data-message-id="${escapeMessageIdForSelector(messageId)}"]`)) {
            return bailUserMessageAppendFastPath('duplicate-dom-message', fields);
        }
        const targetIndex = session.timeline.lastIndexOf(messageId);
        if (targetIndex < 0) {
            return bailUserMessageAppendFastPath('message-not-in-timeline', fields);
        }
        if (targetIndex !== session.timeline.length - 1) {
            return bailUserMessageAppendFastPath('message-not-tail', [...fields, `targetIndex=${targetIndex}`, `timelineSize=${session.timeline.length}`]);
        }
        if (session.timeline.length <= 1) {
            return bailUserMessageAppendFastPath('first-message-needs-greeting-clear', fields);
        }
        const previousVisibleId = findPreviousVisibleTimelineMessageId(session, messageId);
        const lastRenderedKey = getLastRenderedChatKey();
        const computedPreviousRenderedTailKey = getComputedPreviousRenderedTailKeyExcludingCandidate(session, messageId);
        const tailSafety = proveHiddenTailSafeForUserAppend(session, messageId, targetIndex, lastRenderedKey, computedPreviousRenderedTailKey);
        if (!tailSafety.safe) {
            return bailUserMessageAppendFastPath(tailSafety.reason || 'tail-safe-unproven', [...fields, ...(tailSafety.fields || []), `previousVisible=${previousVisibleId || 'null'}`]);
        }
        if (!previousVisibleId || !lastRenderedKey || !renderedTailKeysMatch(session, previousVisibleId, lastRenderedKey)) {
            return bailUserMessageAppendFastPath('insertion-point-ambiguous', [...fields, ...(tailSafety.fields || []), `previousVisible=${previousVisibleId || 'null'}`]);
        }
        const wasPinned = autoScrollPinnedToBottom === true && isNearBottom(chatContainer);
        if (!wasPinned) {
            return bailUserMessageAppendFastPath('scroll-unpinned', [...fields, ...(tailSafety.fields || [])]);
        }

        const renderedSet = getRenderedMessageIdSetFromDom();
        const beforeChildren = chatContainer.childElementCount;
        try {
            renderMessageElement(message, renderedSet);
        } catch (error) {
            return bailUserMessageAppendFastPath('render-throw', [...fields, `error=${String(error)}`]);
        }
        const afterChildren = chatContainer.childElementCount;
        if (afterChildren <= beforeChildren) {
            return bailUserMessageAppendFastPath('no-dom-output', fields);
        }
        const afterTailKey = getLastRenderedChatKey();
        const duplicateCount = chatContainer.querySelectorAll(`[data-message-id="${escapeMessageIdForSelector(messageId)}"]`).length;
        const tailMatchesCandidate = renderedTailKeysMatch(session, afterTailKey, messageId);
        const domChildDelta = afterChildren - beforeChildren;
        const postAppendAuditPassed = duplicateCount === 1 && tailMatchesCandidate === true && domChildDelta > 0;
        logRenderStormMetric('user-message-append-post-audit', [
            `messageId=${messageId}`,
            `domChildrenBefore=${beforeChildren}`,
            `domChildrenAfter=${afterChildren}`,
            `domChildDelta=${domChildDelta}`,
            `duplicateCount=${duplicateCount}`,
            `expectedTail=${messageId}`,
            `actualTail=${afterTailKey || 'null'}`,
            `tailMatches=${tailMatchesCandidate ? 'true' : 'false'}`,
            'postAppendAuditMode=identity-tail',
            `postAppendAuditPassed=${postAppendAuditPassed ? 'true' : 'false'}`,
            ...(tailSafety.fields || [])
        ]);
        if (!postAppendAuditPassed) {
            return bailUserMessageAppendFastPath('post-append-audit-failed', [...fields, `duplicateCount=${duplicateCount}`, `afterTailKey=${afterTailKey || 'null'}`, `domChildrenBefore=${beforeChildren}`, `domChildrenAfter=${afterChildren}`, `domChildDelta=${domChildDelta}`, 'postAppendAuditMode=identity-tail', ...(tailSafety.fields || [])]);
        }
        session.lastAssistantUpgradeFallback = null;
        countUserMessageAppendFastPathResult('success', [...fields, `reason=${tailSafety.reason || 'hidden-tail-safe'}`, `domChildren=${afterChildren}`, `domChildDelta=${domChildDelta}`, 'postAppendAuditMode=identity-tail', `postAppendAuditPassed=${postAppendAuditPassed ? 'true' : 'false'}`, ...(tailSafety.fields || [])]);
        scrollToBottom(true);
        return { applied: true, reason: tailSafety.reason || 'success' };
    }

    function bailAssistantStreamingPatch(reason, fields = []) {
        const key = reason || 'unknown';
        countAssistantStreamingPatchResult('fallback-full-render', [`reason=${key}`, ...fields]);
        countAssistantStreamingPatchBail(key, fields);
        return { applied: false, reason: key };
    }

    function isAssistantStreamingSearchUnsafe() {
        return Boolean(
            sessionSearch.open
            || String(sessionSearch.query || '').trim()
            || sessionSearch.smartInFlight
            || sessionSearch.mode === 'smart'
            || sessionSearch.matches.length > 0
            || sessionSearch.smartMessageIds.length > 0
        );
    }

    function resolveAssistantStreamingDomTarget(session, targetId, exactMatches, fields = []) {
        const exactSelector = `[data-message-id="${escapeMessageIdForSelector(targetId)}"]`;
        if (exactMatches.length === 1) {
            return {
                resolved: true,
                resolution: 'exact',
                bubble: exactMatches[0],
                selector: exactSelector,
                domKey: targetId,
                fields: ['domTargetResolution=exact']
            };
        }
        if (exactMatches.length > 1) {
            return {
                resolved: false,
                reason: 'identity-order-duplicate-dom-target',
                fields: [...fields, `targetId=${targetId}`, `domMatches=${exactMatches.length}`, 'domTargetResolution=duplicate-exact']
            };
        }
        if (typeof targetId !== 'string' || !targetId.startsWith('msg_')) {
            return {
                resolved: false,
                reason: 'dom-target-missing',
                fields: [...fields, `targetId=${targetId || 'null'}`, 'domMatches=0', 'domTargetResolution=missing-no-server-target']
            };
        }

        const now = Date.now();
        const candidates = [];
        const addCandidate = (aliasKey, source, meta = {}) => {
            if (typeof aliasKey !== 'string' || !(aliasKey.startsWith('tmp:') || aliasKey.startsWith('local-'))) return;
            if (meta.sessionId && meta.sessionId !== activeSessionId) return;
            if (meta.newKey && meta.newKey !== targetId) return;
            if (meta.assistantMsgId && meta.assistantMsgId !== targetId) return;
            const ts = typeof meta.ts === 'number' ? meta.ts : null;
            const ageMs = ts ? now - ts : null;
            candidates.push({ aliasKey, source: source || 'unknown', ts, ageMs, turnAnchor: meta.turnAnchor || aliasKey });
        };

        const pending = session.pendingAssistantUpgrade || null;
        addCandidate(pending?.tmpKey, pending?.source || 'pendingAssistantUpgrade', {
            sessionId: pending?.fallbackSessionId,
            newKey: pending?.assistantMsgId || pending?.fallbackAssistantKey,
            assistantMsgId: pending?.assistantMsgId || pending?.fallbackAssistantKey,
            ts: pending?.ts || pending?.fallbackAppliedAt,
            turnAnchor: pending?.fallbackTurnAnchor || pending?.tmpKey
        });
        addCandidate(pending?.fallbackSourceTmpKey, pending?.fallbackSource || pending?.source || 'pendingAssistantUpgrade', {
            sessionId: pending?.fallbackSessionId,
            newKey: pending?.fallbackAssistantKey || pending?.assistantMsgId,
            assistantMsgId: pending?.assistantMsgId || pending?.fallbackAssistantKey,
            ts: pending?.ts || pending?.fallbackAppliedAt,
            turnAnchor: pending?.fallbackTurnAnchor || pending?.fallbackSourceTmpKey
        });

        const fallback = session.lastAssistantUpgradeFallback || null;
        addCandidate(fallback?.fallbackSourceTmpKey, fallback?.fallbackSource || 'lastAssistantUpgradeFallback', {
            sessionId: fallback?.fallbackSessionId,
            newKey: fallback?.fallbackAssistantKey,
            assistantMsgId: fallback?.fallbackAssistantKey,
            ts: fallback?.fallbackAppliedAt,
            turnAnchor: fallback?.fallbackTurnAnchor || fallback?.fallbackSourceTmpKey
        });

        const recentAliases = Array.isArray(session.recentAssistantDomTargetAliases) ? session.recentAssistantDomTargetAliases : [];
        for (const alias of recentAliases) {
            addCandidate(alias?.oldKey, alias?.source || 'recentAssistantDomTargetAliases', {
                sessionId: alias?.sessionId,
                newKey: alias?.newKey,
                assistantMsgId: alias?.assistantMsgId || alias?.newKey,
                ts: alias?.ts,
                turnAnchor: alias?.turnAnchor || alias?.oldKey
            });
        }

        const uniqueCandidates = [];
        const seenAliases = new Set();
        for (const candidate of candidates) {
            if (seenAliases.has(candidate.aliasKey)) continue;
            seenAliases.add(candidate.aliasKey);
            uniqueCandidates.push(candidate);
        }
        if (uniqueCandidates.length === 0) {
            return {
                resolved: false,
                reason: 'dom-target-missing',
                fields: [...fields, `targetId=${targetId}`, 'domMatches=0', 'domTargetResolution=missing-no-alias']
            };
        }

        const currentTurnAnchored = session.currentTurnAssistantKey === targetId || session.thinkingId === targetId || session.currentTurnAssistantMsgId === targetId;
        if (!currentTurnAnchored || session.canceledActiveTurn) {
            return {
                resolved: false,
                reason: 'identity-order-alias-stale',
                fields: [...fields, `targetId=${targetId}`, `currentTurnAnchored=${currentTurnAnchored}`, `canceled=${Boolean(session.canceledActiveTurn)}`, 'domTargetResolution=alias-stale']
            };
        }

        const matchedAliases = [];
        let staleCandidateCount = 0;
        for (const candidate of uniqueCandidates) {
            if (candidate.ageMs !== null && candidate.ageMs > 60000) {
                staleCandidateCount += 1;
                continue;
            }
            const aliasSelector = `[data-message-id="${escapeMessageIdForSelector(candidate.aliasKey)}"]`;
            const aliasMatches = Array.from(chatContainer.querySelectorAll(aliasSelector))
                .filter((node) => node?.classList?.contains('message') && node.classList.contains('bot'));
            if (aliasMatches.length > 0) {
                matchedAliases.push({ ...candidate, selector: aliasSelector, matches: aliasMatches });
            }
        }
        const nonStaleMatches = matchedAliases.filter((candidate) => candidate.matches.length > 0);
        if (staleCandidateCount > 0 && staleCandidateCount === uniqueCandidates.length) {
            return {
                resolved: false,
                reason: 'identity-order-alias-stale',
                fields: [...fields, `targetId=${targetId}`, `aliasCandidates=${uniqueCandidates.length}`, `staleAliasCandidates=${staleCandidateCount}`, 'domMatches=0', 'domTargetResolution=alias-stale']
            };
        }
        if (nonStaleMatches.length === 0) {
            return {
                resolved: false,
                reason: 'dom-target-missing',
                fields: [...fields, `targetId=${targetId}`, `aliasCandidates=${uniqueCandidates.length}`, 'domMatches=0', 'domTargetResolution=alias-miss']
            };
        }
        if (nonStaleMatches.length !== 1 || nonStaleMatches[0].matches.length !== 1) {
            const aliasMatchCount = nonStaleMatches.reduce((total, candidate) => total + candidate.matches.length, 0);
            return {
                resolved: false,
                reason: 'identity-order-alias-ambiguous',
                fields: [...fields, `targetId=${targetId}`, `aliasCandidates=${uniqueCandidates.length}`, `aliasDomMatches=${aliasMatchCount}`, 'domTargetResolution=alias-ambiguous']
            };
        }

        const alias = nonStaleMatches[0];
        return {
            resolved: true,
            resolution: 'alias',
            bubble: alias.matches[0],
            selector: alias.selector,
            domKey: alias.aliasKey,
            aliasKey: alias.aliasKey,
            aliasSource: alias.source,
            fields: [
                'domTargetResolution=alias',
                'domAliasApplied=true',
                `domAliasKey=${alias.aliasKey}`,
                `domAliasSource=${alias.source}`,
                `domAliasAgeMs=${alias.ageMs ?? 'null'}`
            ]
        };
    }

    function assistantStreamingTailMatchesResolvedTarget(session, tailKey, targetId, targetResolution) {
        if (!tailKey) return false;
        if (renderedTailKeysMatch(session, tailKey, targetId)) return true;
        if (targetResolution?.resolution !== 'alias') return false;
        const aliasKey = targetResolution.aliasKey || '';
        if (!aliasKey) return false;
        return tailKey === aliasKey || renderedTailKeysMatch(session, tailKey, aliasKey);
    }

    function tryPatchAssistantStreamingBubble(sessionId, source = 'unknown') {
        const fields = [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`];
        if (!chatContainer) return bailAssistantStreamingPatch('dom-target-missing', fields);
        if (!sessionId || sessionId !== activeSessionId) {
            return bailAssistantStreamingPatch('identity-order-inactive-session', [...fields, `activeSessionId=${activeSessionId || 'null'}`]);
        }
        const session = getSessionState(sessionId);
        if (!session || !(session.messagesById instanceof Map) || !Array.isArray(session.timeline)) {
            return bailAssistantStreamingPatch('identity-order-session-mismatch', fields);
        }
        if (isAssistantStreamingSearchUnsafe()) {
            return bailAssistantStreamingPatch('search-highlight-active', [...fields, `searchMode=${sessionSearch.mode || 'text'}`, `matches=${sessionSearch.matches.length}`]);
        }

        const targetId = session.currentTurnAssistantKey || session.thinkingId || '';
        if (typeof targetId !== 'string' || !targetId) {
            return bailAssistantStreamingPatch('identity-order-missing-target', fields);
        }
        const message = session.messagesById.get(targetId);
        if (!message || message.role !== 'assistant') {
            return bailAssistantStreamingPatch('identity-order-target-not-assistant', [...fields, `targetId=${targetId || 'null'}`, `role=${message?.role || 'null'}`]);
        }
        if (message.meta?.isThinking !== true) {
            return bailAssistantStreamingPatch('identity-order-target-not-streaming', [...fields, `targetId=${targetId}`]);
        }
        if (session.hiddenSet instanceof Set && session.hiddenSet.has(targetId)) {
            return bailAssistantStreamingPatch('identity-order-hidden-target', [...fields, `targetId=${targetId}`]);
        }
        if (shouldHideDcpUiMessage(message) || isHiddenControlAssistantText(message.text || '')) {
            return bailAssistantStreamingPatch('identity-order-hidden-control-assistant', [...fields, `targetId=${targetId}`]);
        }
        if (message.meta?.kind || message.meta?.isDiff || Array.isArray(message.meta?.images) || Array.isArray(message.meta?.todos) && message.meta.todos.length > 0 || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0) {
            return bailAssistantStreamingPatch('rich-content-unsafe', [...fields, `targetId=${targetId}`]);
        }

        const targetIndex = session.timeline.lastIndexOf(targetId);
        if (targetIndex < 0) {
            return bailAssistantStreamingPatch('identity-order-not-in-timeline', [...fields, `targetId=${targetId}`]);
        }
        if (targetIndex !== session.timeline.length - 1) {
            return bailAssistantStreamingPatch('identity-order-not-tail', [...fields, `targetId=${targetId}`, `targetIndex=${targetIndex}`, `timelineSize=${session.timeline.length}`]);
        }

        const selector = `[data-message-id="${escapeMessageIdForSelector(targetId)}"]`;
        const matches = Array.from(chatContainer.querySelectorAll(selector))
            .filter((node) => node?.classList?.contains('message') && node.classList.contains('bot'));
        const targetResolution = resolveAssistantStreamingDomTarget(session, targetId, matches, fields);
        if (!targetResolution.resolved) {
            return bailAssistantStreamingPatch(targetResolution.reason, targetResolution.fields);
        }
        const bubble = targetResolution.bubble;
        const content = bubble.querySelector(':scope > .message-content');
        if (!content) {
            return bailAssistantStreamingPatch('dom-target-missing-content', [...fields, `targetId=${targetId}`, ...(targetResolution.fields || [])]);
        }
        const lastRenderedKey = getLastRenderedChatKey();
        if (!assistantStreamingTailMatchesResolvedTarget(session, lastRenderedKey, targetId, targetResolution)) {
            return bailAssistantStreamingPatch('identity-order-dom-tail-mismatch', [...fields, `targetId=${targetId}`, `domLastRendered=${lastRenderedKey || 'null'}`, ...(targetResolution.fields || [])]);
        }

        const wasPinned = autoScrollPinnedToBottom === true && isNearBottom(chatContainer);
        if (!wasPinned) {
            return bailAssistantStreamingPatch('scroll-unpinned', [...fields, `targetId=${targetId}`, ...(targetResolution.fields || [])]);
        }

        const beforeHtml = content.innerHTML;
        try {
            renderAssistantMarkdown(content, message);
            bubble.classList.toggle('thinking', message.meta?.isThinking === true);
            bubble.classList.toggle('streaming', message.meta?.isThinking === true);
            const statusText = typeof message.meta?.statusText === 'string' ? message.meta.statusText : '';
            let statusEl = bubble.querySelector(':scope > .message-status');
            if (statusText) {
                if (!statusEl) {
                    statusEl = document.createElement('div');
                    statusEl.className = 'message-status';
                    bubble.appendChild(statusEl);
                }
                statusEl.textContent = statusText;
            } else if (statusEl) {
                statusEl.remove();
            }
            bubble.querySelectorAll(':scope > .message-copy-btn.assistant-copy').forEach((btn) => btn.remove());
            attachMessageCopyButton(bubble, message);
            enhanceCodeBlocksWithCopyButtons(bubble);
            wrapTables(content);
        } catch (error) {
            content.innerHTML = beforeHtml;
            return bailAssistantStreamingPatch('rich-content-render-throw', [...fields, `targetId=${targetId}`, `error=${String(error)}`, ...(targetResolution.fields || [])]);
        }

        const duplicateCount = chatContainer.querySelectorAll(targetResolution.selector).length;
        const afterTailKey = getLastRenderedChatKey();
        if (duplicateCount !== 1 || !assistantStreamingTailMatchesResolvedTarget(session, afterTailKey, targetId, targetResolution)) {
            return bailAssistantStreamingPatch('identity-order-post-audit-failed', [...fields, `targetId=${targetId}`, `duplicateCount=${duplicateCount}`, `afterTailKey=${afterTailKey || 'null'}`, ...(targetResolution.fields || [])]);
        }
        countAssistantStreamingPatchResult(targetResolution.resolution === 'alias' ? 'post-upgrade-alias-success' : 'success', [...fields, `targetId=${targetId}`, `textLen=${typeof message.text === 'string' ? message.text.length : 0}`, `statusTextLen=${typeof message.meta?.statusText === 'string' ? message.meta.statusText.length : 0}`, `domTail=${afterTailKey || 'null'}`, ...(targetResolution.fields || [])]);
        scrollToBottom(true);
        return { applied: true, reason: targetResolution.resolution === 'alias' ? 'post-upgrade-alias-success' : 'success' };
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

    /**
     * Hides marker-delimited blocks from user messages.
     * Removes opener + content + terminator (inclusive).
     * Handles multiple openers and unclosed blocks gracefully.
     */
    function hideMarkerRanges(s) {
        const openers = [
            '[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]',
            '<system-reminder>'
        ];
        const terminator = '<!-- OMO_INTERNAL_INITIATOR -->';

        for (const opener of openers) {
            let idx = s.indexOf(opener);
            while (idx !== -1) {
                const endIdx = s.indexOf(terminator, idx);
                if (endIdx !== -1) {
                    // Remove inclusive: opener + content + terminator
                    s = s.slice(0, idx) + s.slice(endIdx + terminator.length);
                    // Search again from same position (content shifted left)
                    idx = s.indexOf(opener, idx);
                } else {
                    // Unclosed opener - leave unchanged, stop searching this opener
                    break;
                }
            }
        }

        return s;
    }

function stripSystemInjections(text) {
        if (!text) return text;
        let s = text;

        // Remove injected mode blocks (including trailing blank lines).
        const modeBlockRe = /^\[(analyze-mode|search-mode)\][\s\S]*?^\s*---\s*(?:\r?\n(?:\s*\r?\n)*)?/im;
        while (modeBlockRe.test(s)) {
            s = s.replace(modeBlockRe, '');
        }

        // Marker-range hiding (inclusive removal)
        s = hideMarkerRanges(s);

        // Minimal cleanup: normalize excess newlines and trim
        s = s.replace(/\n{3,}/g, '\n\n').trim();

    return s;
}

function collapseSessionDataMessagesForDisplay(messages, anchorMsgIds = new Set()) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const collapsed = [];
    let pendingAssistant = null;
    const hiddenControlUserIds = new Set();

    const flushAssistant = () => {
        if (pendingAssistant) {
            collapsed.push(pendingAssistant);
            pendingAssistant = null;
        }
    };

    for (const item of messages) {
        if (!item || !item.id) continue;
        const role = item.role;
        const meta = item.meta || {};
        if (role === 'system') {
            if (meta.kind === 'changeList') {
                flushAssistant();
                collapsed.push(item);
            }
            continue;
        }
        if (role === 'user') {
            if (meta.syntheticUser === true || isHiddenControlUserText(item.text || '')) {
                hiddenControlUserIds.add(item.id);
                continue;
            }
            const text = stripSystemInjections((item.text || '').replace(/^(\r?\n)+/, ''));
            if (!text.trim()) continue;
            flushAssistant();
            collapsed.push({ ...item, text });
            continue;
        }
        if (role === 'assistant') {
            const text = item.text || '';
            if (isHiddenControlAssistantText(text)) continue;
            const parentId =
                (typeof item.parentId === 'string' && item.parentId)
                || (typeof item.parentID === 'string' && item.parentID)
                || (typeof meta.parentId === 'string' && meta.parentId)
                || (typeof meta.parentID === 'string' && meta.parentID)
                || '';
            if (!text.trim()) continue;
            if (anchorMsgIds.has(item.id)) {
                flushAssistant();
                collapsed.push({ ...item, text });
                continue;
            }
            pendingAssistant = { ...item, text };
        }
    }

    flushAssistant();
    return collapsed;
}

function shouldHideDcpUiMessage(message) {
    if (message?.role !== 'system') {
        return false;
    }
    const raw = typeof message?.text === 'string' ? message.text : '';
    if (!raw) return false;
    return raw.trimStart().includes('\u25A3 DCP');
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
            const operationId = createOperationId();
            vscode.postMessage({
                type: 'restoreSegment',
                sessionId: activeSessionId,
                operationId,
                noticeKey: noticeKey,
                anchorMsgId: anchorMsgId,
                endMsgId: segment.endMsgId
            });
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_RESTORE_SEND]', `sessionId=${activeSessionId || 'null'}`, `opId=${operationId || 'null'}`, `noticeKey=${noticeKey || 'null'}`, `anchorMsgId=${anchorMsgId || 'null'}`, `endMsgId=${segment.endMsgId || 'null'}`, 'type=restoreSegment']
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
            const memberIdSet = segment.memberIds instanceof Set
                ? segment.memberIds
                : new Set(
                    Array.isArray(segment.memberMsgIds)
                        ? segment.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                        : []
                );
            const orderedMemberIds = [];
            const seenMemberIds = new Set();
            for (const id of session.timeline) {
                if (!memberIdSet.has(id) || seenMemberIds.has(id)) continue;
                orderedMemberIds.push(id);
                seenMemberIds.add(id);
            }
            for (const id of memberIdSet) {
                if (seenMemberIds.has(id)) continue;
                orderedMemberIds.push(id);
                seenMemberIds.add(id);
            }
            for (const id of orderedMemberIds) {
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
                    renderAssistantMarkdown(content, msg);
                } else {
                    const rawText = msg.text || '';
                    const trimmedText = isUser ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, '')) : rawText;
                    if (isUser) {
                        renderUserMarkdown(content, trimmedText);
                    } else {
                        content.textContent = trimmedText;
                    }
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
        if (systemNoticeText) {
            pendingEl.textContent = systemNoticeText;
            pendingEl.classList.remove('hidden');
            return;
        }
        // Removed: pendingSegments no longer used in new system
        pendingEl.classList.add('hidden');
    }

    let renderScheduled = false;
    let renderNeedsAnother = false;
    let queuedRenderReason = '';
    function scheduleRenderFromState(reason = 'unknown') {
        if (renderScheduled) {
            renderNeedsAnother = true;
            queuedRenderReason = reason || queuedRenderReason || 'queued';
            vscode.postMessage({ type: 'ui-debug', payload: ['WV: render.skip', `reason=${reason}`, 'pending=1'] });
            return;
        }
        renderScheduled = true;
        noteFullRenderRequest(reason, ['source=scheduleRenderFromState']);
        vscode.postMessage({ type: 'ui-debug', payload: ['WV: render.scheduled', `reason=${reason}`] });
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderFromState();
            if (renderNeedsAnother) {
                const nextReason = queuedRenderReason || 'queued-flush';
                renderNeedsAnother = false;
                queuedRenderReason = '';
                scheduleRenderFromState(nextReason);
            }
        });
    }

    function forceQuestionOverlayRender(reason = 'question-overlay-force') {
        requestAnimationFrame(() => {
            scheduleRenderFromState(reason);
        });
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
            renderQuestionCardInTimeline();
            if (sessionSearch.mode === 'smart' && sessionSearch.smartMessageIds.length) {
                applySmartSessionSearchResults(sessionSearch.smartMessageIds, { scroll: false });
            } else if (sessionSearch.open || sessionSearch.query) {
                refreshSessionSearchHighlights({ jumpToFirst: false });
            }
            return;
        }

        if (session.snapshotFinalizeReady === true) {
            const pendingEpoch = typeof session.snapshotPendingEpoch === 'number' ? session.snapshotPendingEpoch : 0;
            const emittedEpoch = typeof session.snapshotEmittedEpoch === 'number' ? session.snapshotEmittedEpoch : 0;
            if (pendingEpoch > emittedEpoch) {
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SNAPSHOT_ROUTE]', `sessionId=${activeSessionId}`, `reason=skip-switch-readonly`, `epochPending=${pendingEpoch}`, `epochEmitted=${emittedEpoch}`]
                });
            }
        }

        const timeline = Array.isArray(session.timeline) ? session.timeline : [];
        const segments = Array.from(session.segmentsByNoticeKey.values());
        const derivedHiddenSet = session.hiddenSet; // Already computed by rebuildHiddenSetFromTimeline
        const appendChildPresentationIndex = buildAppendChildPresentationIndex(session);

        vscode.postMessage({
            type: 'ui-debug',
            payload: ['renderFromState',
                'hiddenSetSize', derivedHiddenSet.size,
                'appendChildPresentationHidden', appendChildPresentationIndex.size,
                'segmentsCount', segments.length,
                'timelineSize', timeline.length]
        });

        const renderedSet = new Set();
        const segmentByNoticeKey = session.segmentsByNoticeKey; // Use existing map
        const renderKeys = [];
        const renderStats = {
            missingMessage: 0,
            hidden: 0,
            appendChildHidden: 0,
            appendAssistantHidden: 0,
            dcpHidden: 0,
            rendered: 0,
            changeListSeen: 0,
            changeListRendered: 0,
            skippedNoDom: 0,
            errors: 0,
            skippedSample: []
        };

        function trackSkipped(id, role, reason) {
            if (renderStats.skippedSample.length < 12) {
                renderStats.skippedSample.push(`${id}:${role || 'unknown'}:${reason}`);
            }
        }

        function renderMessageSafely(msg, id) {
            const beforeChildren = chatContainer.childElementCount;
            try {
                renderMessageElement(msg, renderedSet);
            } catch (error) {
                renderStats.errors += 1;
                trackSkipped(id, msg?.role, 'render-throw');
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][RENDER_ERR]', `id=${id}`, `role=${msg?.role || 'unknown'}`, `error=${String(error)}`]
                });
                return false;
            }

            const afterChildren = chatContainer.childElementCount;
            if (afterChildren > beforeChildren) {
                renderStats.rendered += 1;
                if (msg?.meta?.kind === 'changeList' || (typeof id === 'string' && id.startsWith('system:changeList:'))) {
                    renderStats.changeListRendered += 1;
                }
                return true;
            }

            renderStats.skippedNoDom += 1;
            trackSkipped(id, msg?.role, 'no-dom-output');
            return false;
        }

        for (const id of timeline) {
            const msg = session.messagesById.get(id);
            if (!msg) {
                renderStats.missingMessage += 1;
                continue;
            }

            if (msg?.meta?.kind === 'changeList' || (typeof id === 'string' && id.startsWith('system:changeList:'))) {
                renderStats.changeListSeen += 1;
            }

            if (id.startsWith('system:undo:')) {
                const segment = segmentByNoticeKey.get(id);
                if (segment) {
                    renderSegmentElement(session, segment, renderedSet, id);
                    renderKeys.push(id);
                } else if (!derivedHiddenSet.has(id)) {
                    if (shouldHideDcpUiMessage(msg)) {
                        renderStats.dcpHidden += 1;
                        continue;
                    }
                    if (renderMessageSafely(msg, id)) {
                        renderKeys.push(id);
                    }
                } else {
                    renderStats.hidden += 1;
                }
                continue;
            }

            if (derivedHiddenSet.has(id)) {
                renderStats.hidden += 1;
                continue;
            }
            if (isAppendChildTopLevelUser(session, msg, id, appendChildPresentationIndex)) {
                renderStats.appendChildHidden += 1;
                trackSkipped(id, msg?.role, 'append-child-top-level');
                continue;
            }
            if (isAppendChainTopLevelAssistantHidden(session, msg, id, appendChildPresentationIndex)) {
                renderStats.appendAssistantHidden += 1;
                trackSkipped(id, msg?.role, 'append-chain-assistant-top-level');
                continue;
            }
            if (shouldHideDcpUiMessage(msg)) {
                renderStats.dcpHidden += 1;
                continue;
            }
            if (renderMessageSafely(msg, id)) {
                renderKeys.push(id);
            }
        }

        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                '[WV][RENDER_AUDIT]',
                `timeline=${timeline.length}`,
                `rendered=${renderStats.rendered}`,
                `changeListSeen=${renderStats.changeListSeen}`,
                `changeListRendered=${renderStats.changeListRendered}`,
                `hidden=${renderStats.hidden}`,
                `appendChildHidden=${renderStats.appendChildHidden}`,
                `appendAssistantHidden=${renderStats.appendAssistantHidden}`,
                `dcpHidden=${renderStats.dcpHidden}`,
                `missingMessage=${renderStats.missingMessage}`,
                `skippedNoDom=${renderStats.skippedNoDom}`,
                `errors=${renderStats.errors}`,
                `domChildren=${chatContainer.childElementCount}`,
                `sample=${renderStats.skippedSample.join('|') || 'none'}`
            ]
        });

        if (lastConflictPayload && lastConflictPayload.sessionId === activeSessionId) {
            renderConflictCard(lastConflictPayload);
        }


        renderQuestionCardInTimeline();

        countBackgroundIndicatorApplyResult(applyBackgroundSubagentIndicator(session), [`sessionId=${activeSessionId || 'null'}`, 'source=renderFromState-pre-enhance']);

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

        if (sessionSearch.mode === 'smart' && sessionSearch.smartMessageIds.length) {
            applySmartSessionSearchResults(sessionSearch.smartMessageIds, { scroll: false });
        } else if (sessionSearch.open || sessionSearch.query) {
            refreshSessionSearchHighlights({ jumpToFirst: false });
        }

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

        countBackgroundIndicatorApplyResult(applyBackgroundSubagentIndicator(session), [`sessionId=${activeSessionId || 'null'}`, 'source=renderFromState-post-audit']);

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
        // Legacy WebView snapshot catch-up is intentionally disabled: normal finalize
        // snapshot persistence is owned by the extension-side finalize route.
        if (shouldEmitSnapshotOnNextRender && activeSessionId) {
            shouldEmitSnapshotOnNextRender = false;
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SNAPSHOT_ROUTE]', `sessionId=${activeSessionId}`, `reason=drop-switch-readonly`, `rendered=${renderKeys.length}`]
            });
        }
    }

    window.__oc = window.__oc || {};
    window.__oc.renderFromState = scheduleRenderFromState;

    function renderModelSelect() {
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][RENDER_MODELS]', `count=${models.length}`, `selected=${selectedModel || 'none'}`]
        });
        
        const wrapper = modelSelect.parentElement;
        if (!wrapper) return;
        wrapper.style.width = '';
        wrapper.style.minWidth = '';

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
                    updateSendQuotaVisual();
                    closeDropdown();
                });
                list.appendChild(option);
            }

            group.appendChild(header);
            group.appendChild(list);
            panel.appendChild(group);
        }

        const panelWidthPx = computeModelPanelWidthPx(wrapper, models);
        panel.style.width = panelWidthPx > 0 ? `${panelWidthPx}px` : '';
        panel.style.minWidth = panel.style.width;

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
        modeSelect.innerHTML = '';
        const modeItems = Array.isArray(modes) && modes.length ? modes : ['plan', 'build'];
        for (const mode of modeItems) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode;
            if (mode === selectedMode) {
                option.selected = true;
            }
            modeSelect.appendChild(option);
        }
        renderSimpleSelect(modeSelect, {
            getValue: () => selectedMode,
            onSelect: (value) => {
                selectedMode = value;
                modeSelect.value = value;
                applyModeStyles(selectedMode);
                vscode.postMessage({ type: 'setMode', value: selectedMode });
                syncModeControlWidth(modeSelect, modeItems, selectedMode);
                if (modePanel) {
                    modePanel.style.width = `${computeModePanelWidthPx(modeWrapper, modeItems)}px`;
                }
            }
        });
        syncModeControlWidth(modeSelect, modeItems, selectedMode);
        const modeWrapper = modeSelect.parentElement;
        const modeDropdown = modeWrapper ? modeWrapper.querySelector('.simple-dropdown') : null;
        const modePanel = modeDropdown ? modeDropdown.querySelector('.dropdown-panel') : null;
        if (modePanel) {
            const panelWidth = computeModePanelWidthPx(modeWrapper, modeItems);
            modePanel.style.width = `${panelWidth}px`;
        }
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
            option.className = 'simple-option';
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
            for (const option of panel.querySelectorAll('.simple-option')) {
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
        } else if (mode === 'build') {
            container.classList.add('mode-build');
        }
    }

    function isNearBottom(container) {
        if (!container) return true;
        const remaining = container.scrollHeight - (container.scrollTop + container.clientHeight);
        return remaining <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    }

    function scrollToBottom(force = false) {
        if (!chatContainer) return;
        if (!force && !autoScrollPinnedToBottom) return;
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight;
            autoScrollPinnedToBottom = true;
        });
    }
    window.__oc = window.__oc || {};
    window.__oc.scrollToBottom = scrollToBottom;

    function renderSessionList() {
        sessionList.innerHTML = '';
        if (!sessions.length) {
            armedDeleteSessionId = '';
            const empty = document.createElement('div');
            empty.className = 'session-empty';
            empty.textContent = 'No sessions found.';
            sessionList.appendChild(empty);
            return;
        }
        if (armedDeleteSessionId && !sessions.some((item) => item?.id === armedDeleteSessionId)) {
            armedDeleteSessionId = '';
        }
        for (const item of sessions) {
            const row = document.createElement('div');
            row.className = 'session-item session-item-row';
            if (armedDeleteSessionId === item.id) {
                row.classList.add('is-delete-armed');
            }

            const button = document.createElement('button');
            button.className = 'session-item-main';
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
                armedDeleteSessionId = '';
                pendingExplicitSessionSelectionId = item.id;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SESSION_SELECTION_TARGET]', `sessionId=${item.id || 'null'}`]
                });
                vscode.postMessage({ type: 'selectSession', sessionId: item.id });
            });

            const actions = document.createElement('div');
            actions.className = 'session-item-actions';
            const pendingDeleteOpId = pendingDeleteSessionOpBySession.get(item.id);
            if (pendingDeleteOpId) {
                const waitBtn = document.createElement('button');
                waitBtn.type = 'button';
                waitBtn.className = 'session-item-delete';
                waitBtn.textContent = '...';
                waitBtn.disabled = true;
                actions.appendChild(waitBtn);
            } else if (armedDeleteSessionId === item.id) {
                const confirmBtn = document.createElement('button');
                confirmBtn.type = 'button';
                confirmBtn.className = 'session-item-delete session-item-delete-confirm';
                confirmBtn.textContent = 'delete';
                confirmBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const opId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    pendingDeleteSessionOpBySession.set(item.id, opId);
                    armedDeleteSessionId = '';
                    renderSessionList();
                    vscode.postMessage({ type: 'deleteSession', sessionId: item.id, opId });
                });

                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'session-item-delete session-item-delete-cancel';
                cancelBtn.textContent = 'cancel';
                cancelBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    armedDeleteSessionId = '';
                    renderSessionList();
                });

                actions.appendChild(confirmBtn);
                actions.appendChild(cancelBtn);
            } else {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'session-item-delete session-item-delete-icon';
                removeBtn.setAttribute('aria-label', 'Delete session');
                removeBtn.setAttribute('title', 'Delete session');
                removeBtn.textContent = '\u00D7';
                removeBtn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    armedDeleteSessionId = item.id;
                    renderSessionList();
                });
                actions.appendChild(removeBtn);
            }

            row.appendChild(button);
            row.appendChild(actions);
            sessionList.appendChild(row);
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
                removeBtn.textContent = '\u00D7';
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
            icon.textContent = '\u{1F4C4}';

            const text = document.createElement('span');
            text.className = 'attachment-image-label';
            text.textContent = name || 'Attachment';

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'attachment-image-remove';
            removeBtn.textContent = '\u00D7';
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

    function renderContextTokens() {
        if (!inputTokenList) return;
        inputTokenList.innerHTML = '';
        if (appendInputMode && appendInputMode.sessionId === activeSessionId) {
            const chip = document.createElement('span');
            chip.className = 'input-token append-token';

            const label = document.createElement('span');
            label.className = 'input-token-label';
            label.textContent = 'Append';
            chip.appendChild(label);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'input-token-remove';
            removeBtn.title = 'Exit append mode';
            removeBtn.setAttribute('aria-label', 'Exit append mode');
            removeBtn.textContent = '\u00D7';
            removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                exitAppendInputMode({ restoreDraft: true });
            });
            chip.appendChild(removeBtn);
            inputTokenList.appendChild(chip);
            return;
        }
        for (const item of pendingContextItems) {
            if (!item || !item.displayText) continue;
            const chip = document.createElement('span');
            chip.className = 'input-token context-token';

            const label = document.createElement('span');
            label.className = 'input-token-label';
            label.textContent = item.displayText;
            chip.appendChild(label);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'input-token-remove';
            removeBtn.title = 'Remove context';
            removeBtn.setAttribute('aria-label', `Remove ${item.displayText}`);
            removeBtn.textContent = '\u00D7';
            removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                pendingContextItems = pendingContextItems.filter((entry) => entry !== item);
                renderContextTokens();
            });
            chip.appendChild(removeBtn);

            inputTokenList.appendChild(chip);
        }
        for (const item of pendingFileRefs) {
            if (!item || !item.path) continue;
            const chip = document.createElement('span');
            chip.className = 'input-token file-token';

            const label = document.createElement('span');
            label.className = 'input-token-label';
            label.textContent = `@${item.path}`;
            chip.appendChild(label);

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'input-token-remove';
            removeBtn.title = 'Remove file reference';
            removeBtn.setAttribute('aria-label', `Remove ${item.path}`);
            removeBtn.textContent = '\u00D7';
            removeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                pendingFileRefs = pendingFileRefs.filter((entry) => entry.path !== item.path);
                renderContextTokens();
            });
            chip.appendChild(removeBtn);

            inputTokenList.appendChild(chip);
        }
    }

    function addContextItem(displayText, payload) {
        if (!displayText || !payload || typeof payload.text !== 'string') return;
        pendingContextItems.push({ displayText, ...payload });
        renderContextTokens();
    }

    const fileMentionState = {
        open: false,
        requestId: '',
        query: '',
        range: null,
        items: [],
        selectedIndex: 0,
        timer: null
    };

    function normalizeFileRef(file) {
        if (!file || typeof file.path !== 'string' || !file.path) return null;
        return {
            path: file.path,
            name: typeof file.name === 'string' ? file.name : file.path.split('/').pop(),
            directory: typeof file.directory === 'string' ? file.directory : ''
        };
    }

    function addFileRef(file) {
        const normalized = normalizeFileRef(file);
        if (!normalized) return;
        if (pendingFileRefs.some((item) => item.path === normalized.path)) {
            renderContextTokens();
            return;
        }
        pendingFileRefs.push(normalized);
        renderContextTokens();
    }

    function closeFileMentionList() {
        fileMentionState.open = false;
        fileMentionState.items = [];
        fileMentionState.selectedIndex = 0;
        fileMentionState.range = null;
        if (fileMentionList) {
            fileMentionList.classList.add('hidden');
            fileMentionList.innerHTML = '';
        }
    }

    function renderFileMentionList() {
        if (!fileMentionList) return;
        fileMentionList.innerHTML = '';
        if (!fileMentionState.open) {
            fileMentionList.classList.add('hidden');
            return;
        }
        const items = fileMentionState.items || [];
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'file-mention-empty';
            empty.textContent = 'No files found';
            fileMentionList.appendChild(empty);
            fileMentionList.classList.remove('hidden');
            return;
        }
        items.forEach((item, index) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `file-mention-item${index === fileMentionState.selectedIndex ? ' selected' : ''}`;
            option.dataset.index = String(index);

            const name = document.createElement('span');
            name.className = 'file-mention-name';
            name.textContent = item.name || item.path;
            option.appendChild(name);

            const dir = document.createElement('span');
            dir.className = 'file-mention-dir';
            dir.textContent = item.directory || '.';
            option.appendChild(dir);

            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                selectFileMention(index);
            });
            fileMentionList.appendChild(option);
        });
        fileMentionList.classList.remove('hidden');
    }

    function findActiveFileMention() {
        if (!input) return null;
        const cursor = input.selectionStart;
        if (cursor !== input.selectionEnd) return null;
        const beforeCursor = input.value.slice(0, cursor);
        const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
        if (!match) return null;
        const query = match[2] || '';
        return {
            query,
            start: cursor - query.length - 1,
            end: cursor
        };
    }

    function requestFileMentionResults() {
        const activeMention = findActiveFileMention();
        if (!activeMention) {
            closeFileMentionList();
            return;
        }
        fileMentionState.open = true;
        fileMentionState.query = activeMention.query;
        fileMentionState.range = { start: activeMention.start, end: activeMention.end };
        fileMentionState.selectedIndex = 0;
        const requestId = `files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        fileMentionState.requestId = requestId;
        vscode.postMessage({
            type: 'listWorkspaceFiles',
            requestId,
            query: activeMention.query
        });
    }

    function scheduleFileMentionUpdate() {
        if (fileMentionState.timer) {
            clearTimeout(fileMentionState.timer);
        }
        const activeMention = findActiveFileMention();
        if (!activeMention) {
            closeFileMentionList();
            return;
        }
        fileMentionState.open = true;
        fileMentionState.query = activeMention.query;
        fileMentionState.range = { start: activeMention.start, end: activeMention.end };
        renderFileMentionList();
        fileMentionState.timer = setTimeout(requestFileMentionResults, 120);
    }

    function selectFileMention(index) {
        const item = fileMentionState.items[index];
        if (!item || !fileMentionState.range || !input) return;
        const { start, end } = fileMentionState.range;
        input.value = `${input.value.slice(0, start)}${input.value.slice(end)}`;
        input.selectionStart = start;
        input.selectionEnd = start;
        addFileRef(item);
        closeFileMentionList();
        input.focus();
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
        armedDeleteSessionId = '';
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
    const displayText = stripSystemInjections(payload.text || 'Image attached.');
        const userMessage = upsertMessage(session, {
            id: payload.clientMessageId,
            role: 'user',
            text: displayText,
            meta: { clientId: payload.clientMessageId, images: payload.images || [] }
        });
        const userAppendFastPathResult = tryAppendUserMessageFastPath(sessionId, userMessage?.id || payload.clientMessageId, 'applyPromptToSession');
        session.lastTurnUserId = payload.clientMessageId;
        session.appendRootUserKey = payload.clientMessageId;
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
    session.earlyFinalAssistantId = null;
    session.finalAssistantLock = null;
    session.pendingAssistantUpgrade = null;
    session.lastAssistantUpgradeFallback = null;
    session.awaitingFinalMapBind = false;
    session.streamMode = null;
    session.backendTurnInFlight = false;
    session.turnFullyFinalized = false;
    if (session.seenDiffKeys instanceof Set) {
        session.seenDiffKeys.clear();
    }
    if (session.assistantUpgradeSeen instanceof Set) {
        session.assistantUpgradeSeen.clear();
    }

        if (!session.thinkingId) {
            const tempId = createTempAssistantId();
            const thinkingMsg = upsertMessage(session, {
                id: tempId,
                role: 'assistant',
                text: 'Thinking...',
                meta: { isThinking: true, parentClientMessageId: payload.clientMessageId, textSegments: [], currentSegment: '', subagents: [], todos: [] }
            });
            session.thinkingId = thinkingMsg.id;
            session.currentTurnAssistantKey = thinkingMsg.id;
            session.lastTurnAssistantId = thinkingMsg.id;
        }

        assertInvariants(sessionId, 'sendPrompt');
        updateSendGate();
        // agent timeout notice removed
        return { userAppendFastPathApplied: userAppendFastPathResult?.applied === true, userAppendFastPathReason: userAppendFastPathResult?.reason || 'unknown' };
    }

function canAppendToMessage(session, message) {
    if (!session || !message || message.role !== 'user') return false;
    if (!activeSessionId) return false;
    if (session.backendTurnInFlight !== true) return false;
    if (session.turnFullyFinalized === true) return false;
    if (session.canceledActiveTurn === true) return false;
    if (session.finalAssistantLock?.assistantMsgId) return false;
    return Boolean(session.appendRootUserKey && message.id === session.appendRootUserKey);
}

function hasBlockingAppendSubmission(message) {
    const items = getAppendItems(message);
    return items.some((item) => item && item.status === 'sending');
}

function getAppendItems(message) {
    if (!message.meta || !Array.isArray(message.meta.appendedPrompts)) return [];
    return message.meta.appendedPrompts;
}

function resolveAppendRootMessage(session, message) {
    if (!session?.messagesById) return null;
    const clientMessageId = typeof message?.clientMessageId === 'string' ? message.clientMessageId : '';

    if (clientMessageId) {
        for (const candidate of session.messagesById.values()) {
            if (!candidate || candidate.role !== 'user') continue;
            const items = getAppendItems(candidate);
            if (items.some((item) => item?.clientMessageId === clientMessageId)) {
                return candidate;
            }
        }
    }

    const keys = [];
    const addKey = (key) => {
        if (typeof key !== 'string' || !key || keys.includes(key)) return;
        keys.push(key);
        const localKey = session.serverIdToClientKey?.get?.(key);
        if (typeof localKey === 'string' && localKey && !keys.includes(localKey)) keys.push(localKey);
        const stableKey = session.clientKeyToServerId?.get?.(key);
        if (typeof stableKey === 'string' && stableKey && !keys.includes(stableKey)) keys.push(stableKey);
        const mappedKey = session.serverIdToKey?.get?.(key);
        if (typeof mappedKey === 'string' && mappedKey && !keys.includes(mappedKey)) keys.push(mappedKey);
    };

    addKey(message?.rootUserMsgId);
    addKey(session.appendRootUserKey);
    addKey(session.lastTurnUserId);

    for (const key of keys) {
        const candidate = session.messagesById.get(key);
        if (candidate?.role === 'user') return candidate;
    }
    return null;
}

function upsertAppendItem(message, item) {
    if (!message) return null;
    if (!message.meta) message.meta = {};
    const items = Array.isArray(message.meta.appendedPrompts)
        ? [...message.meta.appendedPrompts]
        : [];
    const index = items.findIndex((entry) =>
        (item.clientMessageId && entry.clientMessageId === item.clientMessageId)
        || (item.appendUserMsgId && entry.appendUserMsgId === item.appendUserMsgId)
    );
    const existing = index >= 0 ? items[index] : {};
    const statusRank = { sending: 1, queued: 2, seen: 3, applied: 4, failed: 10, rejected: 10 };
    let status = item.status || existing.status;
    if (existing.status && item.status) {
        const oldRank = statusRank[existing.status] || 0;
        const newRank = statusRank[item.status] || 0;
        status = newRank >= oldRank ? item.status : existing.status;
    }
    const next = {
        ...existing,
        ...item,
        status
    };
    if (index >= 0) {
        items[index] = next;
    } else {
        items.push(next);
    }
    const seenClientMessageIds = new Set();
    message.meta.appendedPrompts = items.filter((entry, entryIndex) => {
        if (!entry?.clientMessageId) return true;
        if (entryIndex === index) {
            seenClientMessageIds.add(entry.clientMessageId);
            return true;
        }
        if (seenClientMessageIds.has(entry.clientMessageId)) return false;
        seenClientMessageIds.add(entry.clientMessageId);
        return true;
    });
    return next;
}

function markAppendItemSeenByAssistantParent(session, parentId) {
    if (!session || !parentId || !(session.messagesById instanceof Map)) return false;
    for (const message of session.messagesById.values()) {
        const items = Array.isArray(message?.meta?.appendedPrompts)
            ? message.meta.appendedPrompts
            : [];
        const parentIndex = items.findIndex((entry) => entry?.appendUserMsgId === parentId);
        if (parentIndex < 0) continue;
        let changed = false;
        for (let i = 0; i <= parentIndex; i += 1) {
            const item = items[i];
            if (
                !item?.appendUserMsgId ||
                item.status === 'seen' ||
                item.status === 'applied' ||
                item.status === 'failed' ||
                item.status === 'rejected'
            ) {
                continue;
            }
            upsertAppendItem(message, {
                clientMessageId: item.clientMessageId,
                appendUserMsgId: item.appendUserMsgId,
                status: 'seen'
            });
            changed = true;
        }
        return changed;
    }
    return false;
}

function submitAppendMessage(sessionId, rootUserKey, text) {
    const session = getSessionState(sessionId);
    const root = session?.messagesById?.get(rootUserKey);
    const value = typeof text === 'string' ? text.trim() : '';
    if (!session || !root || !value || !canAppendToMessage(session, root)) return false;
    if (hasBlockingAppendSubmission(root)) return false;
    const clientMessageId = `append-${Date.now()}-${messageCounter++}`;
    upsertAppendItem(root, {
        clientMessageId,
        text: value,
        status: 'sending',
        createdAt: Date.now()
    });
    syncAppendSnapshotMetadata(sessionId, 'submitAppendMessage');
    session.appendComposerFor = null;
    session.appendComposerDrafts?.delete?.(rootUserKey);
    vscode.postMessage({
        type: 'appendMessage',
        sessionId,
        rootUserKey,
        clientMessageId,
        value
    });
    window.__oc?.renderFromState?.();
    scrollToBottom();
    return true;
}

function handleAssistantMeta(sessionId, message, options = {}) {
        const session = getSessionState(sessionId, true);
        const backendId = getEventMessageId(message);
        const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;
        if (shouldDropHiddenControlAssistant(session, message, 'assistantMessageMeta', msgId)) {
            return;
        }
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

        if (!session.streamMode) {
            session.streamMode = 'meta';
        }

        if ((typeof message?.tmpKey === 'string') && (message.tmpKey.startsWith('tmp:') || message.tmpKey.startsWith('local-')) && (typeof msgId === 'string') && msgId.startsWith('msg_')) {
            session.pendingAssistantUpgrade = {
                tmpKey: message.tmpKey,
                assistantMsgId: msgId,
                source: 'assistantMessageMeta',
                ts: Date.now(),
                fallbackAssistantKey: msgId,
                fallbackSourceTmpKey: message.tmpKey,
                fallbackSessionId: sessionId,
                fallbackSource: 'assistantMessageMeta',
                fallbackTurnAnchor: session.currentTurnAssistantKey || session.thinkingId || message.tmpKey
            };
            updateSendGate();
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[DBG_PENDING_UPGRADE_SET]', 'sessionId', sessionId, 'tmpKey', message.tmpKey, 'assistantMsgId', msgId, 'source', 'assistantMessageMeta']
            });
        }

        attemptAssistantUpgrade(sessionId, message, 'assistantMessageMeta');

        let targetId = session.currentTurnAssistantKey || session.thinkingId;

        if (!targetId && msgId && session.messagesById.has(msgId)) {
            if (isBusy && (!session.currentTurnAssistantKey || session.currentTurnAssistantKey === msgId)) {
                targetId = msgId;
                session.currentTurnAssistantKey = msgId;
            } else {
                vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'drop-historical-msg', msgId] });
                return;
            }
        }

        if (!targetId && msgId) {
            const thinking = upsertMessage(session, {
                id: msgId,
                role: message.role || 'assistant',
                text: message.lastText || 'Thinking...',
                meta: { isThinking: true, internalId: backendId, statusText: '' }
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
            const activeTargetId = session.currentTurnAssistantKey || session.thinkingId || null;
            const isActiveTarget = Boolean(activeTargetId && targetId === activeTargetId);
            if (!isActiveTarget && target.meta?.isThinking !== true) {
                vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'drop-finalized-target', targetId] });
                return;
            }
            if (message?.isStatusUpdate) {
                // When a tool call arrives, finalize current speech segment
                if (target.meta && target.meta.currentSegment && target.meta.currentSegment.trim()) {
                    target.meta.textSegments = [...(target.meta.textSegments || []), target.meta.currentSegment];
                    target.meta.currentSegment = '';
                    // Re-synthesize text
                    target.text = target.meta.textSegments.join('\n\n');
                }
                const statusText = typeof message.lastText === 'string' ? message.lastText : '';
                // isStatusUpdate: statusText only to avoid flicker. (isStatusUpdate statusText)
                target.meta = { ...target.meta, internalId: backendId, isThinking: true, statusText };
                const statusEl = options.render === false ? null : document.querySelector(`[data-message-id="${targetId}"] .message-status`);
                if (statusEl) {
                    statusEl.textContent = statusText;
                } else {
                    renderIfActive(sessionId, 'assistantMessageMeta:status');
                }
                vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'status-update', targetId] });
            } else {
                if (!session.streamMode) {
                    session.streamMode = 'meta';
                } else if (session.streamMode !== 'meta') {
                    emitTempFinalTrace('meta.replace.drop', [`reason=streamMode=${session.streamMode}`, `targetId=${targetId}`]);
                    return;
                }
                console.log(`[ASSIST_META] replace mode | key=${targetId} | textLen=${typeof message.lastText === 'string' ? message.lastText.length : 0} | streaming=true`);
                const hasNonEmptyLastText = typeof message.lastText === 'string' && message.lastText.trim().length > 0;
                const nextText = hasNonEmptyLastText ? message.lastText : target.text;
                const normalized = typeof nextText === 'string' ? nextText.trim() : '';
                const hasStatusChange = normalized.length > 0 && normalized !== 'Thinking...';
                if (hasStatusChange) {
                    // agent timeout notice removed
                }
                target.text = nextText;
                target.meta = {
                    ...target.meta,
                    internalId: backendId,
                    isThinking: true,
                    statusText: '',
                    currentSegment: '',
                    textSegments: []
                };
                console.log('[ASSIST_META] currentSegment reset on full text replace | no cumulative append logic active');
                if (isTempFinalTraceEnabled()) {
                    const segmentsLen = Array.isArray(target.meta?.textSegments) ? target.meta.textSegments.length : 0;
                    emitTempFinalTrace('meta.replace.reset', [`targetId=${targetId}`, `textLen=${typeof nextText === 'string' ? nextText.length : 0}`, `segments=${segmentsLen}`]);
                }
                vscode.postMessage({ type: 'ui-debug', payload: ['handleAssistantMeta', 'merged', targetId] });
                renderIfActive(sessionId, 'assistantMessageMeta:merge');
            }
        }

        assertInvariants(sessionId, 'assistantMeta');
    }

function handleChatChunk(sessionId, message) {
        const session = getSessionState(sessionId, true);
        // agent timeout notice removed
        const backendId = getEventMessageId(message);
        const chunkText = getEventChunkText(message);

        if (!session?.thinkingId && !session?.currentTurnAssistantKey && !session?.backendTurnInFlight) {
            emitTempFinalTrace('chatChunk.drop', [`sessionId=${sessionId}`, 'reason=no-active-turn']);
            return;
        }

        if (!session.streamMode) {
            session.streamMode = 'chunk';
        } else if (session.streamMode !== 'chunk') {
            emitTempFinalTrace('chatChunk.drop', [`reason=streamMode=${session.streamMode}`, `sessionId=${sessionId}`]);
            return;
        }

        const msgId = typeof message?.assistantMsgId === 'string' ? message.assistantMsgId : null;
        if (shouldDropHiddenControlAssistant(session, message, 'chatChunk', msgId)) {
            return;
        }
        if (msgId) {
            session.currentTurnAssistantMsgId = msgId;
        }

        if ((typeof message?.tmpKey === 'string') && (message.tmpKey.startsWith('tmp:') || message.tmpKey.startsWith('local-')) && (typeof msgId === 'string') && msgId.startsWith('msg_')) {
            session.pendingAssistantUpgrade = {
                tmpKey: message.tmpKey,
                assistantMsgId: msgId,
                source: 'chatChunk',
                ts: Date.now(),
                fallbackAssistantKey: msgId,
                fallbackSourceTmpKey: message.tmpKey,
                fallbackSessionId: sessionId,
                fallbackSource: 'chatChunk',
                fallbackTurnAnchor: session.currentTurnAssistantKey || session.thinkingId || message.tmpKey
            };
            updateSendGate();
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
            if (isBusy && (!session.currentTurnAssistantKey || session.currentTurnAssistantKey === msgId)) {
                targetId = msgId;
                session.currentTurnAssistantKey = msgId;
            } else {
                vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'drop-historical-msg', msgId] });
                return;
            }
        }

        if (!targetId) {
            vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'drop-no-target'] });
            emitTempFinalTrace('chatChunk.drop', [`sessionId=${sessionId}`, 'reason=no-target']);
            return;
        }

        const target = session.messagesById.get(targetId);
        if (target) {
            const activeTargetId = session.currentTurnAssistantKey || session.thinkingId || null;
            const isActiveTarget = Boolean(activeTargetId && targetId === activeTargetId);
            if (!isActiveTarget && target.meta?.isThinking !== true) {
                vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'drop-finalized-target', targetId] });
                return;
            }
            if (!target.meta) target.meta = {};
            if (!target.meta.textSegments) { target.meta.textSegments = []; target.meta.currentSegment = ''; }
            // Keep only latest chunk (no accumulation)
            target.meta.currentSegment = chunkText;
            target.text = target.meta.currentSegment || '';
            if (!target.text) target.text = 'Thinking...';
            target.meta = { ...target.meta, isThinking: true };
            if (target.meta.liveTurnResume === true && session.liveTurnResumeStreamAppendLogged !== targetId) {
                session.liveTurnResumeStreamAppendLogged = targetId;
                postLiveTurnResumeReconcileDiagnostic(
                    'EXT: webviewAutoRescue.liveTurnResume.streamAppend',
                    sessionId,
                    'bound-resumed-assistant',
                    [
                        `targetId=${targetId}`,
                        `assistantMsgId=${msgId || 'null'}`,
                        `thinkingId=${session.thinkingId || 'null'}`,
                        `currentTurnAssistantKey=${session.currentTurnAssistantKey || 'null'}`
                    ]
                );
            }
            vscode.postMessage({ type: 'ui-debug', payload: ['handleChatChunk', 'appended', targetId] });
        }

        assertInvariants(sessionId, 'chatChunk');
    }

function handleChatDone(sessionId, message) {
        const session = getSessionState(sessionId);
        if (!session) return;
        const skipSnapshot = message?.skipSnapshot === true;
        const preDoneAssistantKey = session.currentTurnAssistantKey || session.thinkingId || null;
        const preDoneAssistant = preDoneAssistantKey ? session.messagesById.get(preDoneAssistantKey) : null;
        const wasLiveTurnResumeAssistant = preDoneAssistant?.meta?.liveTurnResume === true;
        // agent timeout notice removed
    if (session.thinkingId && session.messagesById.has(session.thinkingId)) {
        const msg = session.messagesById.get(session.thinkingId);
        msg.meta.isThinking = false;
        // Clear statusText when streaming finishes.
        msg.meta.statusText = null;
        if (msg.text === 'Thinking...') {
            msg.text = '';
        }
        // Keep final text as the latest segment only (no cumulative merge)
        if (msg.meta) {
            const latest = typeof msg.meta.currentSegment === 'string' ? msg.meta.currentSegment : '';
            msg.meta.textSegments = latest ? [latest] : [];
            msg.meta.currentSegment = latest;
            msg.meta.todos = [];
            msg.text = latest || msg.text || '';
        }
        // For subagents: snapshot into meta before clearing
        if (session.activeSubagents && session.activeSubagents.length > 0) {
            if (msg.meta) {
                // Snapshot final state, clearing streaming artifacts
                msg.meta.subagents = session.activeSubagents.map(a => ({
                    ...a,
                    latestText: null,
                    latestTool: null
                }));
            }
            session.activeSubagents = [];
        }
        session.thinkingId = null;

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
        attemptAssistantUpgrade(sessionId, { assistantMsgId: resolvedFinal, tmpKey: preDoneAssistantKey }, 'chatDone');
        replaced = beforeKey !== session.currentTurnAssistantKey && session.currentTurnAssistantKey === resolvedFinal;
        if (session.currentTurnAssistantKey === resolvedFinal) {
            session.assistantUpgradeSeen?.add?.(resolvedFinal);
        }
    }

    const match = Boolean(resolvedFinal && session.currentTurnAssistantKey === resolvedFinal);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['CHATDONE_FINAL', `curKey=${session.currentTurnAssistantKey || 'null'}`, `resolvedFinal=${resolvedFinal || 'null'}`,
            `match=${match}`, `replaced=${replaced}`]
    });

    assertTempFinalParity(sessionId, 'chatDone', resolvedFinal);

    if (resolvedFinal && typeof resolvedFinal === 'string') {
        if (!match) {
            session.awaitingFinalMapBind = true;
            if (!session.pendingAssistantUpgrade || session.pendingAssistantUpgrade.assistantMsgId !== resolvedFinal) {
                session.pendingAssistantUpgrade = {
                    tmpKey: preDoneAssistantKey || session.currentTurnAssistantKey || session.thinkingId || null,
                    assistantMsgId: resolvedFinal,
                    source: 'chatDone',
                    ts: Date.now(),
                    fallbackAssistantKey: resolvedFinal,
                    fallbackSourceTmpKey: preDoneAssistantKey || session.currentTurnAssistantKey || session.thinkingId || null,
                    fallbackSessionId: sessionId,
                    fallbackSource: 'chatDone',
                    fallbackTurnAnchor: preDoneAssistantKey || session.currentTurnAssistantKey || session.thinkingId || null
                };
            }
        } else {
            session.awaitingFinalMapBind = false;
            session.pendingAssistantUpgrade = null;
            session.lastAssistantUpgradeFallback = null;
            session.currentTurnAssistantMsgId = null;
            session.currentTurnAssistantKey = null;
        }
    }
    if (resolvedFinal && typeof resolvedFinal === 'string') {
        session.streamMode = null;
        session.earlyFinalAssistantId = resolvedFinal;
        session.finalAssistantLock = {
            assistantMsgId: resolvedFinal,
            ts: Date.now()
        };
        stabilizeTimelineAfterFinal(session, resolvedFinal, 'chatDone');
        const finalizedAssistant = session.messagesById.get(resolvedFinal) || null;
        if (finalizedAssistant?.meta?.liveTurnResume === true) {
            finalizedAssistant.meta = { ...finalizedAssistant.meta };
            delete finalizedAssistant.meta.liveTurnResume;
        }
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][FINAL_LOCK_SET]', `sessionId=${sessionId}`, `assistantMsgId=${resolvedFinal}`]
        });
        if (wasLiveTurnResumeAssistant) {
            postLiveTurnResumeReconcileDiagnostic(
                'EXT: webviewAutoRescue.liveTurnResume.finalizeReconcile',
                sessionId,
                match ? 'final-bound' : 'awaiting-final-map-bind',
                [
                    `preDoneAssistantKey=${preDoneAssistantKey || 'null'}`,
                    `resolvedFinal=${resolvedFinal}`,
                    `match=${match}`,
                    `replaced=${replaced}`,
                    `awaitingFinalMapBind=${session.awaitingFinalMapBind === true ? 'true' : 'false'}`
                ]
            );
        }
    }
    const appendItemsChanged = normalizeSessionAppendItemsForFinalize(session);
    if (appendItemsChanged) {
        syncAppendSnapshotMetadata(sessionId, 'chatDone-finalize');
    }
    updateSendGate();
    // Mark snapshot pending for this turn; actual emit is single-point gated at finalize_done.
    if (!skipSnapshot) {
        session.snapshotPendingEpoch = (typeof session.snapshotPendingEpoch === 'number' ? session.snapshotPendingEpoch : 0) + 1;
        session.snapshotFinalizeReady = false;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][CHATDONE]', `snapshotPendingEpoch=${session.snapshotPendingEpoch}`]
        });
    } else {
        session.snapshotFinalizeReady = false;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][CHATDONE]', `snapshotSkipped=true`, `reason=error-finalize`]
        });
    }
    assertInvariants(sessionId, 'chatDone');
}

function sanitizeMetaForSnapshot(meta) {
    if (!meta || typeof meta !== 'object') return undefined;
    const out = { ...meta };
    if (Array.isArray(meta.images)) {
        const kept = [];
        let redactedCount = 0;
        for (const item of meta.images) {
            if (typeof item !== 'string' || !item) continue;
            if (item.startsWith('data:image/')) {
                redactedCount++;
                continue;
            }
            kept.push(item);
        }
        if (kept.length > 0) out.images = kept;
        else delete out.images;
        if (redactedCount > 0) {
            out.imageCount = Math.max(Number(out.imageCount) || 0, kept.length + redactedCount);
            out.imagesRedactedInSnapshot = true;
        }
    }
    return out;
}

function appendMessageImages(parentEl, message) {
    const images = Array.isArray(message?.meta?.images) ? message.meta.images : [];
    if (!images.length) return;
    const imageWrap = document.createElement('div');
    imageWrap.className = 'message-images';
    for (const src of images) {
        if (typeof src !== 'string' || !src.length) continue;
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Attachment';
        img.loading = 'lazy';
        img.addEventListener('error', () => {
            const fallback = document.createElement('div');
            fallback.className = 'message-image-missing';
            fallback.textContent = 'Image unavailable';
            if (img.parentElement) img.parentElement.replaceChild(fallback, img);
        }, { once: true });
        imageWrap.appendChild(img);
    }
    if (imageWrap.children.length > 0) {
        parentEl.appendChild(imageWrap);
    }
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
        if (appendInputMode) {
            if (!canSendAppendFromInput()) {
                updateSendGate();
                return;
            }
            const { sessionId, rootUserKey } = appendInputMode;
            const accepted = submitAppendMessage(sessionId, rootUserKey, input.value);
            if (accepted) {
                exitAppendInputMode({ restoreDraft: true, discardAppendDraft: true });
            }
            return;
        }
        if (isActiveSessionBusy()) {
            if (activeSessionId) {
                // agent timeout notice removed
                cancelLocalTurn(activeSessionId);
            }
            const activeOpId = activeSessionId ? getSessionState(activeSessionId)?.activeTurnOpId || null : null;
            vscode.postMessage({ type: 'cancel', sessionId: activeSessionId || undefined, opId: activeOpId || undefined });
            return;
        }
        if (baselinePreparing) {
            updateSendGate();
            return;
        }
        const gateSession = getSessionState(activeSessionId);
        if (isSendBlockedByPendingState(gateSession)) {
            updateSendGate();
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
            payload: ['[WV][TURN_START]', `isBusy=${isActiveSessionBusy()}`, `willFreezeSegments=${willFreezeSegments}`]
        });
        // applyTurnStartFreeze removed - segments no longer have freeze state
        const text = input.value.trim();
        const hasContext = pendingContextItems.length > 0;
        const hasFileRefs = pendingFileRefs.length > 0;
        if ((!text && !attachments.length && !hasContext && !hasFileRefs) || isActiveSessionBusy()) return;

        const hasNonImage = attachments.some((item) => !isImageAttachment(item));
        const fallbackText = hasNonImage ? 'Attachment added.' : 'Image attached.';
        const contextDisplay = [
            ...pendingContextItems.map((item) => item.displayText).filter(Boolean),
            ...pendingFileRefs.map((item) => item?.path ? `@${item.path}` : '').filter(Boolean)
        ].join(' ');
        const baseText = contextDisplay
            ? (text ? `${contextDisplay}\n${text}` : contextDisplay)
            : text;
        const messageText = baseText || fallbackText;
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
        const contextPayload = pendingContextItems.map((item) => ({
            displayText: item.displayText,
            text: item.text,
            source: item.source,
            filePath: item.filePath,
            range: item.range
        }));
        const filesPayload = pendingFileRefs
            .map((item) => item?.path)
            .filter((value) => typeof value === 'string' && value.length > 0);

        const sendingSessionId = activeSessionId || '';
        setBusy(true, sendingSessionId);
        if (!activeSessionId) {
            isSwitchingSession = true;
            pendingUiPrompts.push({
                text: messageText,
                clientMessageId,
                opId,
                mode: selectedMode,
                images: messageImages,
                contextItems: contextPayload
            });
        } else {
            const promptRenderResult = applyPromptToSession(activeSessionId, {
                text: messageText,
                clientMessageId,
                opId,
                mode: selectedMode,
                images: messageImages,
                contextItems: contextPayload
            });
            const session = getSessionState(activeSessionId);
            const tmpKey = session?.thinkingId || null;
            vscode.postMessage({ type: 'registerTmpKey', sessionId: activeSessionId, tmpKey });
            if (promptRenderResult?.userAppendFastPathApplied === true) {
                countUserMessageAppendFastPathResult('skip-immediate-full-render', [
                    `sessionId=${activeSessionId || 'null'}`,
                    `messageId=${clientMessageId}`,
                    `reason=${promptRenderResult.userAppendFastPathReason || 'success'}`
                ]);
            } else {
                window.__oc?.renderFromState?.('sendPrompt:user-append-fallback');
            }
            scrollToBottom();
            logSessionState(activeSessionId, 'UI_SEND_PROMPT');
        }

        const tmpKey = activeSessionId ? getSessionState(activeSessionId)?.thinkingId || null : null;
        const mode = selectedMode || 'unknown';
        const segCount = activeSessionId ? (getSessionState(activeSessionId)?.segmentsByNoticeKey?.size ?? 0) : 0;
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][SEND_MODE]', `mode=${mode}`, 'discard=disabled', `segmentsCount=${segCount}`, `sessionId=${activeSessionId || 'null'}`]
        });
        if (activeSessionId) {
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][SEG_DISCARD_SKIP]', 'reason=sendMessage-does-not-lock', `mode=${mode}`, `sessionId=${activeSessionId || 'null'}`]
            });
        }
        vscode.postMessage({
            type: 'sendMessage',
            value: messageText,
            attachments: attachmentsPayload,
            contextItems: contextPayload,
            files: filesPayload,
            clientMessageId,
            sessionId: activeSessionId || undefined,
            tmpKey,
            opId
        });
        attachments = [];
        renderAttachments();
        pendingContextItems = [];
        pendingFileRefs = [];
        renderContextTokens();
        input.value = '';
        const sentSession = getSessionState(activeSessionId);
        if (sentSession) sentSession.inputDraft = '';
        closeFileMentionList();
    });

    input.addEventListener('paste', handlePaste);
    input.addEventListener('input', () => {
        const session = getSessionState(activeSessionId);
        if (appendInputMode && appendInputMode.sessionId === activeSessionId) {
            if (session) {
                if (!(session.appendComposerDrafts instanceof Map)) {
                    session.appendComposerDrafts = new Map();
                }
                session.appendComposerDrafts.set(appendInputMode.rootUserKey, input.value);
            }
            closeFileMentionList();
            updateSendGate();
            return;
        }
        if (session) {
            session.inputDraft = input.value;
        }
        scheduleFileMentionUpdate();
    });
    input.addEventListener('click', () => {
        if (appendInputMode) {
            closeFileMentionList();
            return;
        }
        scheduleFileMentionUpdate();
    });
    document.addEventListener('mousedown', (event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (quoteSelectionButton?.contains?.(target)) return;
        if (target instanceof Element && !target.closest('#chat')) {
            hideQuoteSelectionButton();
        }
        if (target === input || fileMentionList?.contains(target)) return;
        closeFileMentionList();
    });

    input.addEventListener('keydown', (e) => {
        if (fileMentionState.open && !fileMentionList?.classList.contains('hidden')) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const count = fileMentionState.items.length;
                if (count > 0) {
                    const delta = e.key === 'ArrowDown' ? 1 : -1;
                    fileMentionState.selectedIndex = (fileMentionState.selectedIndex + delta + count) % count;
                    renderFileMentionList();
                }
                return;
            }
            if (e.key === 'Enter' && fileMentionState.items.length > 0) {
                e.preventDefault();
                selectFileMention(fileMentionState.selectedIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeFileMentionList();
                return;
            }
        }
        if (appendInputMode && e.key === 'Escape') {
            e.preventDefault();
            exitAppendInputMode({ restoreDraft: true });
            return;
        }
        if (appendInputMode && e.key === 'Tab') {
            return;
        }
        if (e.key === 'Tab' && document.activeElement === input) {
            e.preventDefault();
            const modeItems = ['plan', 'build'].filter((mode) => Array.isArray(modes) ? modes.includes(mode) : true);
            const currentIndex = modeItems.indexOf(modeSelect.value);
            const nextIndex = currentIndex >= 0 ? ((currentIndex + 1) % modeItems.length) : 0;
            const nextMode = modeItems[nextIndex] || 'plan';
            modeSelect.value = nextMode;
            selectedMode = nextMode;
            applyModeStyles(selectedMode);
            renderModeSelect();
            vscode.postMessage({ type: 'ui-debug', payload: ['[TAB_SWITCH_MODE]', `to=${selectedMode}`, `displayValue=${modeSelect.value}`] });
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
        renderHeaderUsage();
        if (activeSessionId) {
            // agent timeout notice removed
        }
        vscode.postMessage({ type: 'setModel', value: selectedModel });
    });

    modeSelect.addEventListener('change', (e) => {
        selectedMode = e.target.value;
        applyModeStyles(selectedMode);
        vscode.postMessage({ type: 'ui-debug', payload: ['[MODE_SELECT_CHANGE]', `to=${selectedMode}`, `displayValue=${e.target.value}`] });
        vscode.postMessage({ type: 'setMode', value: selectedMode });
        syncModeControlWidth(modeSelect, modes, selectedMode);
    });

    variantSelect.addEventListener('change', (e) => {
        selectedVariant = e.target.value;
        vscode.postMessage({ type: 'setVariant', value: selectedVariant });
    });

    historyBtn.addEventListener('click', () => {
        openSessionPanel();
    });

    searchBtn?.addEventListener('click', () => {
        if (sessionSearch.open) {
            closeSessionSearch();
        } else {
            openSessionSearch();
        }
    });

    searchInput?.addEventListener('input', () => {
        sessionSearch.query = searchInput.value || '';
        sessionSearch.mode = 'text';
        sessionSearch.smartRequestId = '';
        sessionSearch.smartInFlight = false;
        sessionSearch.activeIndex = -1;
        scheduleSessionSearchRefresh({ jumpToFirst: true });
    });

    searchInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSessionSearch();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            runSmartSessionSearch();
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            goToSessionSearchMatch(event.shiftKey ? -1 : 1);
        }
    });

    searchSmartBtn?.addEventListener('click', () => {
        runSmartSessionSearch();
        searchInput?.focus();
    });

    searchPrevBtn?.addEventListener('click', () => {
        goToSessionSearchMatch(-1);
        searchInput?.focus();
    });

    searchNextBtn?.addEventListener('click', () => {
        goToSessionSearchMatch(1);
        searchInput?.focus();
    });

    searchCloseBtn?.addEventListener('click', () => {
        closeSessionSearch();
    });

    newSessionBtn.addEventListener('click', () => {
        exitAppendInputMode({ restoreDraft: false });
        activeSessionId = '';
        baseSessionTitle = 'OpenCode: Chat';
        renderHeaderTitle();
        renderHeaderUsage();
        refreshSendButtonState();
        attachments = [];
        renderAttachments();
        pendingContextItems = [];
        pendingFileRefs = [];
        renderContextTokens();
        closeFileMentionList();
        isSwitchingSession = true;
        vscode.postMessage({ type: 'newSession' });
        window.__oc?.renderFromState?.();
        scrollToBottom();
    });

    document.addEventListener('mouseover', (event) => {
        const target = event.target instanceof Element ? event.target.closest('#send-btn') : null;
        if (!target) return;
        ensureQuotaTooltip();
        showQuotaTooltip();
    });
    document.addEventListener('mouseout', (event) => {
        const target = event.target instanceof Element ? event.target.closest('#send-btn') : null;
        if (!target) return;
        hideQuotaTooltip();
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

    function getLiveTurnResumeField(message, name) {
        const value = message?.[name];
        return typeof value === 'string' && value.length > 0 ? value : '';
    }

    function isLiveTurnResumeMessageId(value, prefixes) {
        if (typeof value !== 'string' || !value.length) return false;
        return prefixes.some((prefix) => value.startsWith(prefix));
    }

    function postLiveTurnResumeDiagnostic(marker, message, reason, extra = []) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                marker,
                `reason=${reason || 'unknown'}`,
                `sessionId=${message?.sessionId || 'null'}`,
                `panelId=${message?.panelId || 'null'}`,
                `expectedPanelId=${currentWebviewLivenessPanelId || 'null'}`,
                `webviewInstanceId=${message?.webviewInstanceId || 'null'}`,
                `expectedWebviewInstanceId=${webviewInstanceId || 'null'}`,
                `activeTurnId=${message?.activeTurnId || 'null'}`,
                `activeSessionId=${activeSessionId || 'null'}`,
                ...extra
            ]
        });
    }

    function getLiveTurnResumeUserKey(message) {
        const mappedUserId = getLiveTurnResumeField(message, 'userMessageId');
        const localUserId = getLiveTurnResumeField(message, 'userLocalId');
        if (isLiveTurnResumeMessageId(mappedUserId, ['msg_'])) return mappedUserId;
        if (isLiveTurnResumeMessageId(localUserId, ['local-'])) return localUserId;
        return '';
    }

    function getLiveTurnResumeAssistantKey(message) {
        const assistantMessageId = getLiveTurnResumeField(message, 'assistantMessageId');
        const tmpAssistantKey = getLiveTurnResumeField(message, 'tmpAssistantKey');
        if (isLiveTurnResumeMessageId(assistantMessageId, ['msg_'])) return assistantMessageId;
        if (isLiveTurnResumeMessageId(tmpAssistantKey, ['tmp:', 'local-'])) return tmpAssistantKey;
        return '';
    }

    function liveTurnResumeTurnIdentityMatchesSession(session, message, userKey, assistantKey) {
        const activeTurnId = getLiveTurnResumeField(message, 'activeTurnId');
        if (!activeTurnId) return { ok: false, reason: 'missing-activeTurnId' };
        const payloadTurnIds = [
            getLiveTurnResumeField(message, 'userLocalId'),
            getLiveTurnResumeField(message, 'userMessageId'),
            getLiveTurnResumeField(message, 'tmpAssistantKey'),
            getLiveTurnResumeField(message, 'assistantMessageId')
        ].filter(Boolean);
        if (!payloadTurnIds.includes(activeTurnId)) {
            return { ok: false, reason: 'activeTurnId-not-in-payload' };
        }
        if (!session) return { ok: true, reason: 'bootstrap-self-consistent' };

        const knownTurnIds = [
            session.lastTurnUserId,
            session.currentTurnAssistantKey,
            session.currentTurnAssistantMsgId,
            session.thinkingId,
            session.pendingAssistantUpgrade?.tmpKey,
            session.pendingAssistantUpgrade?.assistantMsgId,
            userKey,
            assistantKey,
            ...payloadTurnIds
        ].filter(Boolean);
        const hasLocalTurnState = Boolean(
            session.lastTurnUserId ||
            session.currentTurnAssistantKey ||
            session.currentTurnAssistantMsgId ||
            session.thinkingId ||
            session.pendingAssistantUpgrade
        );
        if (hasLocalTurnState && !knownTurnIds.includes(activeTurnId)) {
            return { ok: false, reason: 'activeTurnId-session-mismatch' };
        }
        return { ok: true, reason: hasLocalTurnState ? 'session-match' : 'session-self-consistent' };
    }

    function ensureTimelineContainsOnce(session, messageId) {
        if (!session || typeof messageId !== 'string' || !messageId.length) return;
        const next = [];
        let seen = false;
        for (const id of Array.isArray(session.timeline) ? session.timeline : []) {
            if (id === messageId) {
                if (seen) continue;
                seen = true;
            }
            next.push(id);
        }
        if (!seen) next.push(messageId);
        session.timeline = next;
    }

    function removeLiveTurnResumeAlias(session, aliasKey, canonicalKey, expectedRole) {
        if (!session || typeof aliasKey !== 'string' || typeof canonicalKey !== 'string') return false;
        if (!aliasKey || !canonicalKey || aliasKey === canonicalKey) return false;
        const canonicalMessage = session.messagesById?.get?.(canonicalKey) || null;
        const aliasMessage = session.messagesById?.get?.(aliasKey) || null;
        if (!canonicalMessage || canonicalMessage.role !== expectedRole) return false;
        if (aliasMessage && aliasMessage.role !== expectedRole) return false;

        const pending = session.pendingAssistantUpgrade || null;
        const aliasReferencedByActiveTurn = Boolean(
            session.thinkingId === aliasKey ||
            session.currentTurnAssistantKey === aliasKey ||
            session.currentTurnAssistantMsgId === aliasKey ||
            session.lastTurnAssistantId === aliasKey ||
            session.lastTurnUserId === aliasKey ||
            session.appendRootUserKey === aliasKey ||
            session.appendComposerFor === aliasKey ||
            pending?.tmpKey === aliasKey ||
            pending?.assistantMsgId === aliasKey ||
            pending?.fallbackAssistantKey === aliasKey ||
            pending?.fallbackSourceTmpKey === aliasKey ||
            pending?.fallbackTurnAnchor === aliasKey
        );
        const aliasIsLivePlaceholder = Boolean(
            aliasMessage?.meta?.liveTurnResume === true ||
            aliasMessage?.meta?.isThinking === true
        );
        if (!aliasReferencedByActiveTurn && !aliasIsLivePlaceholder) return false;

        if (aliasMessage) {
            const aliasText = typeof aliasMessage.text === 'string' ? aliasMessage.text : '';
            const canonicalText = typeof canonicalMessage.text === 'string' ? canonicalMessage.text : '';
            const canonicalIsLivePlaceholder = Boolean(
                canonicalMessage.meta?.liveTurnResume === true ||
                canonicalMessage.meta?.isThinking === true
            );
            if (aliasText && (!canonicalText || canonicalIsLivePlaceholder)) {
                canonicalMessage.text = aliasText;
            }
            canonicalMessage.meta = { ...(aliasMessage.meta || {}), ...(canonicalMessage.meta || {}) };
            session.messagesById.delete(aliasKey);
        }

        session.timeline = (Array.isArray(session.timeline) ? session.timeline : []).filter((id) => id !== aliasKey);
        if (session.thinkingId === aliasKey) session.thinkingId = canonicalKey;
        if (session.currentTurnAssistantKey === aliasKey) session.currentTurnAssistantKey = canonicalKey;
        if (session.currentTurnAssistantMsgId === aliasKey) session.currentTurnAssistantMsgId = canonicalKey;
        if (session.lastTurnAssistantId === aliasKey) session.lastTurnAssistantId = canonicalKey;
        if (session.lastTurnUserId === aliasKey) session.lastTurnUserId = canonicalKey;
        if (session.appendRootUserKey === aliasKey) session.appendRootUserKey = canonicalKey;
        if (session.appendComposerFor === aliasKey) session.appendComposerFor = canonicalKey;
        if (pending?.tmpKey === aliasKey) pending.tmpKey = canonicalKey;
        if (pending?.assistantMsgId === aliasKey) pending.assistantMsgId = canonicalKey;
        if (pending?.fallbackAssistantKey === aliasKey) pending.fallbackAssistantKey = canonicalKey;
        if (pending?.fallbackSourceTmpKey === aliasKey) pending.fallbackSourceTmpKey = canonicalKey;
        if (pending?.fallbackTurnAnchor === aliasKey) pending.fallbackTurnAnchor = canonicalKey;
        if (session.appendComposerDrafts?.has?.(aliasKey)) {
            const draft = session.appendComposerDrafts.get(aliasKey);
            session.appendComposerDrafts.delete(aliasKey);
            if (!session.appendComposerDrafts.has(canonicalKey)) session.appendComposerDrafts.set(canonicalKey, draft);
        }
        ensureTimelineContainsOnce(session, canonicalKey);
        return true;
    }

    function resolveLiveTurnResumeUserKey(session, message, fallbackUserKey) {
        const userMessageId = getLiveTurnResumeField(message, 'userMessageId');
        const userLocalId = getLiveTurnResumeField(message, 'userLocalId');
        if (userLocalId && userMessageId) {
            registerMessageIdMapping(session, userLocalId, userMessageId, 'liveTurnResume');
        }
        if (userMessageId && session.messagesById?.get?.(userMessageId)?.role === 'user') {
            return { key: userMessageId, reason: 'canonical-user-reuse' };
        }
        const mappedUserId = userLocalId ? session.clientKeyToServerId?.get?.(userLocalId) : '';
        if (mappedUserId && session.messagesById?.get?.(mappedUserId)?.role === 'user') {
            return { key: mappedUserId, reason: 'mapped-canonical-user-reuse' };
        }
        if (fallbackUserKey && session.messagesById?.get?.(fallbackUserKey)?.role === 'user') {
            return { key: fallbackUserKey, reason: fallbackUserKey.startsWith('msg_') ? 'canonical-user-existing' : 'local-user-existing' };
        }
        return { key: fallbackUserKey || userMessageId || userLocalId, reason: 'user-fallback' };
    }

    function resolveLiveTurnResumeAssistantKey(session, message, fallbackAssistantKey) {
        const assistantMessageId = getLiveTurnResumeField(message, 'assistantMessageId');
        const tmpAssistantKey = getLiveTurnResumeField(message, 'tmpAssistantKey');
        if (assistantMessageId && session.messagesById?.get?.(assistantMessageId)?.role === 'assistant') {
            return { key: assistantMessageId, reason: 'canonical-assistant-reuse' };
        }
        const pending = session.pendingAssistantUpgrade || null;
        if (tmpAssistantKey && pending?.tmpKey === tmpAssistantKey) {
            const pendingAssistantId = pending.assistantMsgId || pending.fallbackAssistantKey || '';
            if (pendingAssistantId && session.messagesById?.get?.(pendingAssistantId)?.role === 'assistant') {
                return { key: pendingAssistantId, reason: 'mapped-canonical-assistant-reuse' };
            }
        }
        if (assistantMessageId && session.currentTurnAssistantMsgId === assistantMessageId && session.messagesById?.get?.(assistantMessageId)?.role === 'assistant') {
            return { key: assistantMessageId, reason: 'current-canonical-assistant-reuse' };
        }
        if (fallbackAssistantKey && session.messagesById?.get?.(fallbackAssistantKey)?.role === 'assistant') {
            return { key: fallbackAssistantKey, reason: fallbackAssistantKey.startsWith('msg_') ? 'canonical-assistant-existing' : 'tmp-assistant-existing' };
        }
        if (tmpAssistantKey) return { key: tmpAssistantKey, reason: 'tmp-assistant-fallback' };
        return { key: fallbackAssistantKey || assistantMessageId, reason: 'assistant-fallback' };
    }

    function postLiveTurnHistoryDiagnostic(marker, message, reason, extra = []) {
        vscode.postMessage({
            type: 'ui-debug',
            payload: [
                marker,
                `reason=${reason || 'unknown'}`,
                `sessionId=${message?.sessionId || 'null'}`,
                `panelId=${message?.panelId || 'null'}`,
                `expectedPanelId=${currentWebviewLivenessPanelId || 'null'}`,
                `webviewInstanceId=${message?.webviewInstanceId || 'null'}`,
                `expectedWebviewInstanceId=${webviewInstanceId || 'null'}`,
                `selectionEpoch=${message?.selectionEpoch ?? 'null'}`,
                `messageCount=${message?.messageCount ?? (Array.isArray(message?.messages) ? message.messages.length : 0)}`,
                'postedSessionData=false',
                'reload=false',
                'recreate=false',
                'sessionMutation=false',
                ...extra
            ]
        });
    }

    function getLiveTurnHistoryExistingKey(session, item) {
        const id = typeof item?.id === 'string' ? item.id : '';
        if (!session || !id) return '';
        if (session.messagesById?.has?.(id)) return id;
        if (id.startsWith('msg_')) {
            const mappedClientKey = session.serverIdToClientKey?.get?.(id) || session.serverIdToKey?.get?.(id) || '';
            if (mappedClientKey && session.messagesById?.has?.(mappedClientKey)) return mappedClientKey;
        }
        if (id.startsWith('local-') || id.startsWith('tmp:')) {
            const canonicalId = resolvePreservedHydrationCanonicalId(session, session, id, item);
            if (canonicalId && session.messagesById?.has?.(canonicalId)) return canonicalId;
        }
        return '';
    }

    function normalizeLiveTurnHistoryMessage(item, order) {
        if (!item || typeof item.id !== 'string' || !item.id.length) return null;
        let role = item.role;
        if (!role) {
            if (item.id.startsWith('msg_')) role = 'assistant';
            else if (item.id.startsWith('system:')) role = 'system';
            else role = 'user';
        }
        const rawText = typeof item.text === 'string' ? item.text : '';
        const cleanedText = role === 'user'
            ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, ''))
            : rawText;
        return {
            id: item.id,
            role,
            text: cleanedText,
            meta: { ...(item.meta || {}) },
            order
        };
    }

    function handleLiveTurnHistory(message) {
        const sessionId = getLiveTurnResumeField(message, 'sessionId');
        const panelId = getLiveTurnResumeField(message, 'panelId');
        const incomingWebviewInstanceId = getLiveTurnResumeField(message, 'webviewInstanceId');
        const skip = (reason, extra = []) => postLiveTurnHistoryDiagnostic('EXT: webviewAutoRescue.liveTurnResume.historySkipped', message, reason, extra);

        if (!panelId) return skip('missing-panelId');
        if (!incomingWebviewInstanceId) return skip('missing-webviewInstanceId');
        if (!webviewInstanceId || incomingWebviewInstanceId !== webviewInstanceId) return skip('webview-instance-mismatch');
        if (!currentWebviewLivenessPanelId) {
            if (!activeSessionId) {
                currentWebviewLivenessPanelId = panelId;
                postLiveTurnHistoryDiagnostic('EXT: webviewAutoRescue.liveTurnResume.historyPanelExpectationBootstrap', message, 'panel-expectation-bootstrap');
            } else {
                return skip('missing-panel-expectation');
            }
        }
        if (panelId !== currentWebviewLivenessPanelId) return skip('panel-mismatch');
        if (!sessionId) return skip('missing-sessionId');
        if (activeSessionId && activeSessionId !== sessionId) return skip('session-mismatch', [`activeSessionId=${activeSessionId || 'null'}`]);

        const session = getSessionState(sessionId, true);
        if (!activeSessionId) {
            activeSessionId = sessionId;
            clearAppendInputForSessionChange(sessionId);
            renderHeaderUsage();
            updateUndoStatusDisplay(sessionId);
        }
        if (message.title && !baseSessionTitle) {
            baseSessionTitle = message.title;
            renderHeaderTitle();
        }

        const rawMessages = Array.isArray(message.messages) ? message.messages : [];
        const explicitTimelineIds = Array.isArray(message?.meta?.timelineMessageIds)
            ? message.meta.timelineMessageIds.filter((id) => typeof id === 'string' && id.length > 0)
            : rawMessages.map((item) => (typeof item?.id === 'string' ? item.id : '')).filter(Boolean);
        const mergedIds = new Set();
        let skippedExisting = 0;
        let skippedCanonical = 0;
        let skippedInvalid = 0;

        for (const item of rawMessages) {
            const id = typeof item?.id === 'string' ? item.id : '';
            if (!id) {
                skippedInvalid++;
                continue;
            }
            const existingKey = getLiveTurnHistoryExistingKey(session, item);
            if (existingKey) {
                if (existingKey === id) skippedExisting++;
                else skippedCanonical++;
                continue;
            }
            const normalized = normalizeLiveTurnHistoryMessage(item, session.nextOrder++);
            if (!normalized) {
                skippedInvalid++;
                continue;
            }
            session.messagesById.set(id, normalized);
            mergedIds.add(id);
        }

        const currentTimeline = Array.isArray(session.timeline) ? session.timeline.slice() : [];
        const nextTimeline = [];
        const seen = new Set();
        const appendTimelineId = (id) => {
            if (typeof id !== 'string' || !id.length || seen.has(id)) return;
            if (!session.messagesById.has(id)) return;
            seen.add(id);
            nextTimeline.push(id);
        };
        for (const id of explicitTimelineIds) appendTimelineId(id);
        for (const id of currentTimeline) appendTimelineId(id);
        session.timeline = nextTimeline;

        materializeInjectedChangeLists(session, rawMessages, 'liveTurnHistory');
        rebuildHiddenSetFromTimeline(session);
        hydratedSessions.add(sessionId);
        postLiveTurnHistoryDiagnostic(
            'EXT: webviewAutoRescue.liveTurnResume.historyMerged',
            message,
            'merge-only',
            [
                `historyCount=${rawMessages.length}`,
                `merged=${mergedIds.size}`,
                `skippedExisting=${skippedExisting}`,
                `skippedCanonical=${skippedCanonical}`,
                `skippedInvalid=${skippedInvalid}`,
                `timelineSize=${session.timeline.length}`,
                `thinkingId=${session.thinkingId || 'null'}`,
                `currentTurnAssistantKey=${session.currentTurnAssistantKey || 'null'}`,
                `backendTurnInFlight=${session.backendTurnInFlight === true ? 'true' : 'false'}`
            ]
        );
        renderIfActive(sessionId, 'liveTurnHistory', { extra: ['phase=merge-only'] });
        updateSendGate();
    }

    function handleLiveTurnResume(message) {
        const sessionId = getLiveTurnResumeField(message, 'sessionId');
        const panelId = getLiveTurnResumeField(message, 'panelId');
        const incomingWebviewInstanceId = getLiveTurnResumeField(message, 'webviewInstanceId');
        const activeTurnId = getLiveTurnResumeField(message, 'activeTurnId');
        const rawUserKey = getLiveTurnResumeUserKey(message);
        const rawAssistantKey = getLiveTurnResumeAssistantKey(message);
        const tmpAssistantKey = getLiveTurnResumeField(message, 'tmpAssistantKey');
        const assistantMessageId = getLiveTurnResumeField(message, 'assistantMessageId');

        const skip = (reason, extra = []) => {
            postLiveTurnResumeDiagnostic('EXT: webviewAutoRescue.liveTurnResume.skipped', message, reason, extra);
        };
        const deduped = (reason, extra = []) => {
            postLiveTurnResumeDiagnostic('EXT: webviewAutoRescue.liveTurnResume.deduped', message, reason, extra);
        };

        if (!panelId) return skip('missing-panelId');
        if (!incomingWebviewInstanceId) return skip('missing-webviewInstanceId');
        if (!webviewInstanceId || incomingWebviewInstanceId !== webviewInstanceId) return skip('webview-instance-mismatch');
        if (!currentWebviewLivenessPanelId) {
            if (!activeSessionId) {
                currentWebviewLivenessPanelId = panelId;
                postLiveTurnResumeDiagnostic('EXT: webviewAutoRescue.liveTurnResume.panelExpectationBootstrap', message, 'panel-expectation-bootstrap');
            } else {
                return skip('missing-panel-expectation');
            }
        }
        if (panelId !== currentWebviewLivenessPanelId) return skip('panel-mismatch');
        if (!sessionId) return skip('missing-sessionId');
        if (!activeTurnId) return skip('missing-activeTurnId');
        if (!rawUserKey) return skip('missing-user-message-id');
        if (!rawAssistantKey) return skip('missing-assistant-message-id');

        const existingSession = getSessionState(sessionId, false);
        const wasActiveSession = Boolean(activeSessionId && activeSessionId === sessionId);
        const isFirstBootstrap = !activeSessionId;
        const shouldActivateSession = wasActiveSession || isFirstBootstrap;
        const identity = liveTurnResumeTurnIdentityMatchesSession(existingSession, message, rawUserKey, rawAssistantKey);
        if (!identity.ok) return skip(identity.reason);

        const session = getSessionState(sessionId, true);
        const resolvedUser = resolveLiveTurnResumeUserKey(session, message, rawUserKey);
        const resolvedAssistant = resolveLiveTurnResumeAssistantKey(session, message, rawAssistantKey);
        const userKey = resolvedUser.key;
        const assistantKey = resolvedAssistant.key;
        if (!userKey) return skip('missing-resolved-user-message-id');
        if (!assistantKey) return skip('missing-resolved-assistant-message-id');

        const userAliasRemoved = removeLiveTurnResumeAlias(session, getLiveTurnResumeField(message, 'userLocalId'), userKey, 'user');
        const assistantAliasRemoved = removeLiveTurnResumeAlias(session, tmpAssistantKey, assistantKey, 'assistant');
        const existingUser = session.messagesById.get(userKey) || null;
        const existingAssistant = session.messagesById.get(assistantKey) || null;
        const alreadyFinalized = Boolean(
            existingAssistant &&
            existingAssistant.role === 'assistant' &&
            existingAssistant.meta?.isThinking !== true &&
            session.backendTurnInFlight !== true &&
            session.turnFullyFinalized !== false
        );
        if (alreadyFinalized) {
            ensureTimelineContainsOnce(session, userKey);
            ensureTimelineContainsOnce(session, assistantKey);
            deduped('already-finalized', [`userKey=${userKey}`, `assistantKey=${assistantKey}`]);
            renderIfActive(sessionId, 'liveTurnResume:finalized-dedupe', { scroll: true, forceScroll: true });
            return;
        }

        if (shouldActivateSession) {
            activeSessionId = sessionId;
            clearAppendInputForSessionChange(sessionId);
            renderHeaderUsage();
            updateUndoStatusDisplay(sessionId);
        }

        const displayUserText = typeof message.displayUserText === 'string'
            ? message.displayUserText
            : (typeof message.rawUserText === 'string' ? stripSystemInjections(message.rawUserText) : '');
        upsertMessage(session, {
            id: userKey,
            role: 'user',
            text: displayUserText,
            meta: { clientId: message.userLocalId || userKey }
        });

        const assistantText = typeof message.assistantText === 'string' && message.assistantText.length > 0
            ? message.assistantText
            : 'Thinking...';
        upsertMessage(session, {
            id: assistantKey,
            role: 'assistant',
            text: assistantText,
            meta: { isThinking: true, statusText: '', liveTurnResume: true, liveTurnResumeAssistantKey: assistantKey }
        });
        placeMessageAfterAnchor(session, assistantKey, userKey, 'liveTurnResume');
        ensureTimelineContainsOnce(session, userKey);
        ensureTimelineContainsOnce(session, assistantKey);

        session.lastTurnUserId = userKey;
        session.appendRootUserKey = userKey;
        session.thinkingId = assistantKey;
        session.currentTurnAssistantKey = assistantKey;
        session.currentTurnAssistantMsgId = assistantMessageId || assistantKey;
        session.canceledActiveTurn = false;
        session.backendTurnInFlight = true;
        session.turnFullyFinalized = false;
        if (tmpAssistantKey && assistantMessageId && tmpAssistantKey !== assistantMessageId) {
            session.pendingAssistantUpgrade = {
                tmpKey: tmpAssistantKey,
                assistantMsgId: assistantMessageId,
                source: 'liveTurnResume',
                ts: Date.now(),
                fallbackAssistantKey: assistantKey,
                fallbackSourceTmpKey: tmpAssistantKey,
                fallbackSessionId: sessionId,
                fallbackSource: 'liveTurnResume',
                fallbackTurnAnchor: userKey
            };
        } else {
            session.pendingAssistantUpgrade = null;
        }

        const duplicate = Boolean(existingUser && existingAssistant);
        postLiveTurnResumeDiagnostic(
            duplicate ? 'EXT: webviewAutoRescue.liveTurnResume.deduped' : 'EXT: webviewAutoRescue.liveTurnResume.accepted',
            message,
            duplicate ? `duplicate-payload:${resolvedUser.reason}:${resolvedAssistant.reason}` : `${identity.reason}:${resolvedUser.reason}:${resolvedAssistant.reason}`,
            [
                `userKey=${userKey}`,
                `assistantKey=${assistantKey}`,
                `rawUserKey=${rawUserKey}`,
                `rawAssistantKey=${rawAssistantKey}`,
                `userAliasRemoved=${userAliasRemoved ? 'true' : 'false'}`,
                `assistantAliasRemoved=${assistantAliasRemoved ? 'true' : 'false'}`,
                `appendRootUserKey=${session.appendRootUserKey || 'null'}`,
                `activate=${shouldActivateSession ? 'true' : 'false'}`,
                `bootstrap=${isFirstBootstrap ? 'true' : 'false'}`
            ]
        );
        renderIfActive(sessionId, 'liveTurnResume', { scroll: true, forceScroll: true });
        updateSendGate();
    }

window.addEventListener('message', (event) => {
        const message = event.data || {};
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'recv', 'type', message.type || 'null', 'sessionId', message.sessionId || message.sessionID || 'null', 'hasMessages', Array.isArray(message.messages), 'messagesLen', message.messages?.length ?? 0, 'hasSegments', Array.isArray(message.segments), 'segmentsLen', message.segments?.length ?? 0]
        });

        switch (message.type) {
            case 'smartSessionSearchResult': {
                if (message.requestId !== sessionSearch.smartRequestId) break;
                sessionSearch.smartInFlight = false;
                applySmartSessionSearchResults(message.messageIds || []);
                updateSessionSearchControls();
                break;
            }
            case 'smartSessionSearchError': {
                if (message.requestId !== sessionSearch.smartRequestId) break;
                sessionSearch.smartInFlight = false;
                sessionSearch.mode = 'smart';
                sessionSearch.matches = [];
                sessionSearch.activeIndex = -1;
                updateSessionSearchControls();
                break;
            }
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
                baselinePreparing = !baselineReady && /initializing git baseline/i.test(baselineMessage || '');
                if (baselinePreparing) {
                    armBaselinePreparingTimeout();
                } else {
                    resetBaselinePreparingTimeout();
                }
                setSendEnabled(true);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['baselineStatus', 'ready', String(baselineReady), 'message', baselineMessage || 'null', 'preparing', String(baselinePreparing)]
                });
                break;
            }
            case 'modelQuota': {
                currentModelQuota = message.quota || null;
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: [
                        'modelQuota.rx',
                        `summary=${currentModelQuota?.summaryRemainingPercent ?? 'null'}`,
                        `rows=${currentModelQuota?.rows?.length ?? 0}`
                    ]
                });
                updateSendQuotaVisual();
                break;
            }
            case 'init': {
                const incomingSessionId = message.currentSessionId || '';
                const hydrated = Boolean(activeSessionId && incomingSessionId && activeSessionId === incomingSessionId && hydratedSessions.has(activeSessionId));
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][INIT_RX]', `sessionId=${incomingSessionId || 'null'}`, `currentSessionId=${activeSessionId || 'null'}`, `hydrated=${hydrated}`, `willReset=${!hydrated}`, `metadataOnly=${String(Boolean(message.metadataOnly))}`, `postedSessionData=${String(Boolean(message.postedSessionData))}`]
                });
                if (
                    typeof message.panelId === 'string' && message.panelId.length > 0 &&
                    typeof message.webviewInstanceId === 'string' && message.webviewInstanceId.length > 0 &&
                    webviewInstanceId && message.webviewInstanceId === webviewInstanceId
                ) {
                    currentWebviewLivenessPanelId = message.panelId;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][INIT_PANEL_EXPECTATION]', 'reason=init-authenticated-panel-seed', `panelId=${message.panelId}`, `webviewInstanceId=${message.webviewInstanceId}`]
                    });
                }
                logSegmentState(activeSessionId, 'before-init');
                models = Array.isArray(message.models) ? message.models : [];
                refreshFreeModelIds();
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                // Deduplicate modes and keep OMO-family agents in one contiguous block.
                const rawModes = Array.isArray(message.modes)
                    ? message.modes.filter((item, index, arr) => typeof item === 'string' && item.length > 0 && arr.indexOf(item) === index)
                    : [];
                const isOmoFamilyMode = (mode) => {
                    const normalized = mode.toLowerCase();
                    return normalized.includes('hephaestus')
                        || normalized.includes('prometheus')
                        || normalized.includes('sisyphus')
                        || normalized.includes('atlas');
                };
                const receivedModes = [];
                const omoModes = [];
                for (const mode of rawModes) {
                    if (isOmoFamilyMode(mode)) {
                        omoModes.push(mode);
                    } else {
                        receivedModes.push(mode);
                    }
                }
                receivedModes.push(...omoModes);
                modes = receivedModes.length ? receivedModes : ['plan', 'build'];

                selectedModel = message.selectedModel || (models[0] ? models[0].fullId : '');
                selectedVariant = message.selectedVariant || '';
                const incomingMode = typeof message.selectedMode === 'string' ? message.selectedMode : '';
                selectedMode = modes.includes(incomingMode)
                    ? incomingMode
                    : (modes.includes('plan') ? 'plan' : (modes[0] || 'plan'));
                
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
                    sendBtn.title = '';
                    updateSendGate();
                }
                
                if (!hydrated) {
                    activeSessionId = incomingSessionId || activeSessionId || '';
                }
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                renderModelSelect();
                renderModeSelect();
                updateVariantOptions();
                updateSendQuotaVisual();
                renderSessionList();
                if (!hydrated) {
                    window.__oc?.renderFromState?.();
                }
                updateSendGate();
                logSegmentState(activeSessionId, 'after-init');
                vscode.postMessage({ type: 'ui-debug', payload: ['webview', 'ready', Date.now()] });
                break;
            }
            case 'serverStatus': {
                const status = typeof message.status === 'string' ? message.status : 'connected';
                setServerStatus(status, message.reason || null);
                break;
            }
            case 'subagentStatus': {
              const route = resolveParentVisibleSubagentRoute(message, 'subagentStatus');
              if (!route) break;
              const { agents } = message;
              const sessionId = route.parentSessionId;
              const sess = getSessionState(sessionId, true);
              const incomingAgents = Array.isArray(agents) ? agents : [];
              const runningCount = typeof message.runningCount === 'number' ? message.runningCount : incomingAgents.filter((a) => a?.state === 'running').length;
              const finalizingCount = typeof message.finalizingCount === 'number' ? message.finalizingCount : incomingAgents.filter((a) => a?.state === 'finalizing').length;
              const doneJustNowCount = typeof message.doneJustNowCount === 'number' ? message.doneJustNowCount : incomingAgents.filter((a) => a?.state === 'done').length;
              if (sess) {
                const currentThinking = sess.thinkingId ? sess.messagesById.get(sess.thinkingId) : null;
                const previousAgents = Array.isArray(currentThinking?.meta?.subagents)
                  ? currentThinking.meta.subagents
                  : (Array.isArray(sess.activeSubagents) ? sess.activeSubagents : []);
                const previousBySession = new Map(previousAgents.map((a) => [a.sessionId, a]));
                const mergedAgents = incomingAgents.map((agent) => {
                  const prev = previousBySession.get(agent.sessionId) || {};
                  const prevState = typeof prev.state === 'string' ? prev.state : (prev.isDone ? 'done' : '');
                  const state = typeof agent.state === 'string'
                    ? agent.state
                    : (agent.isDone ? 'done' : (prevState || 'running'));
                  return {
                    ...prev,
                    ...agent,
                    state,
                    isDone: state === 'done' || state === 'failed' || state === 'cancelled',
                    latestText: typeof agent.latestText === 'string' ? agent.latestText : (prev.latestText || ''),
                    latestFullText: typeof agent.latestFullText === 'string' ? agent.latestFullText : (prev.latestFullText || prev.latestText || ''),
                    latestTool: typeof agent.latestTool === 'string' ? agent.latestTool : (prev.latestTool || ''),
                    latestToolInput: typeof agent.latestToolInput === 'string' ? agent.latestToolInput : (prev.latestToolInput || '')
                  };
                });
                sess.activeSubagents = mergedAgents;
                if (currentThinking && currentThinking.meta) {
                  currentThinking.meta.subagents = mergedAgents;
                }
              }

              handleSubagentStatusPatchResult(
                sessionId,
                applySubagentStatusLocalPatch(sessionId, { runningCount, finalizingCount, doneJustNowCount }),
                'subagentStatus',
                [`agentSessionId=${route.agentSessionId || 'null'}`]
              );
              break;
            }
            case 'backgroundActivityPulse': {
              const route = resolveParentVisibleSubagentRoute(message, 'backgroundActivityPulse');
              if (!route) break;
              const sessionId = route.parentSessionId;
              const anchorAssistantId = typeof message.assistantMsgId === 'string' ? message.assistantMsgId : null;
              armBackgroundSubagentIndicator(sessionId, anchorAssistantId);
              break;
            }
            case 'subagentStateDelta': {
              const route = resolveParentVisibleSubagentRoute(message, 'subagentStateDelta');
              if (!route) break;
              const sess = getSessionState(route.parentSessionId, true);
              if (sess && Array.isArray(sess.activeSubagents)) {
                const idx = sess.activeSubagents.findIndex((a) => a?.sessionId === route.agentSessionId);
                if (idx >= 0) {
                  const cur = sess.activeSubagents[idx] || {};
                  sess.activeSubagents[idx] = {
                    ...cur,
                    state: typeof message.to === 'string' ? message.to : cur.state,
                    isDone: message.to === 'done'
                  };
                }
              }
              renderIfActive(route.parentSessionId, 'subagentStateDelta', { extra: [`agentSessionId=${route.agentSessionId || 'null'}`] });
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
                pendingContextItems = [];
                pendingFileRefs = [];
                renderContextTokens();
                closeFileMentionList();
                window.__oc?.renderFromState?.();
                logSegmentState(activeSessionId, 'after-reset');
                break;
            }
            case 'models': {
                models = Array.isArray(message.models) ? message.models : [];
                refreshFreeModelIds();
                renderModelSelect();
                updateVariantOptions();
                updateSendQuotaVisual();
                renderHeaderUsage();
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
                const sessionIds = new Set(sessions.map((item) => item?.id).filter((id) => typeof id === 'string'));
                for (const pendingId of Array.from(pendingDeleteSessionOpBySession.keys())) {
                    if (!sessionIds.has(pendingId)) {
                        pendingDeleteSessionOpBySession.delete(pendingId);
                    }
                }
                if (armedDeleteSessionId && !sessionIds.has(armedDeleteSessionId)) {
                    armedDeleteSessionId = '';
                }

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'sessionsList', 'applied', 'requestId', effectiveRequestId, 'count', sessions.length, 'top', topSession?.id || 'none']
                });

                renderSessionList();
                break;
            }
            case 'sessionDeleteStarted': {
                const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
                const opId = typeof message.opId === 'string' ? message.opId : '';
                if (!sessionId || !opId) {
                    break;
                }
                pendingDeleteSessionOpBySession.set(sessionId, opId);
                renderSessionList();
                break;
            }
            case 'sessionDeleted': {
                const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
                const opId = typeof message.opId === 'string' ? message.opId : '';
                if (!sessionId) {
                    break;
                }
                const pendingOp = pendingDeleteSessionOpBySession.get(sessionId);
                if (pendingOp && opId && pendingOp !== opId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionDelete', 'stale-drop', 'sessionId', sessionId, 'opId', opId, 'expected', pendingOp]
                    });
                    break;
                }
                pendingDeleteSessionOpBySession.delete(sessionId);
                if (armedDeleteSessionId === sessionId) {
                    armedDeleteSessionId = '';
                }
                sessions = sessions.filter((item) => item?.id !== sessionId);
                renderSessionList();
                break;
            }
            case 'sessionDeleteFailed': {
                const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
                const opId = typeof message.opId === 'string' ? message.opId : '';
                if (!sessionId) {
                    break;
                }
                const pendingOp = pendingDeleteSessionOpBySession.get(sessionId);
                if (pendingOp && opId && pendingOp !== opId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'sessionDelete', 'fail-stale-drop', 'sessionId', sessionId, 'opId', opId, 'expected', pendingOp]
                    });
                    break;
                }
                pendingDeleteSessionOpBySession.delete(sessionId);
                if (armedDeleteSessionId === sessionId) {
                    armedDeleteSessionId = '';
                }
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
            case 'debugWebviewLivenessAckDrop': {
                debugWebviewLivenessAckDrop = Boolean(message.enabled);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'webviewLiveness.ackDrop', 'enabled', String(debugWebviewLivenessAckDrop)]
                });
                break;
            }
            case 'webviewLivenessPing': {
                if (typeof message.panelId === 'string' && message.panelId.length > 0) {
                    currentWebviewLivenessPanelId = message.panelId;
                }
                if (debugWebviewLivenessAckDrop) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['WV', 'webviewLiveness.ackDrop.drop', 'pingId', message.pingId || 'null', 'sessionId', message.sessionId || activeSessionId || 'null', 'token', message.token || 'null']
                    });
                    break;
                }
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['WV', 'webviewLiveness.ack', 'pingId', message.pingId || 'null', 'sessionId', message.sessionId || activeSessionId || 'null', 'token', message.token || 'null']
                });
                vscode.postMessage({
                    type: 'webviewLivenessAck',
                    pingId: message.pingId,
                    token: message.token,
                    sessionId: message.sessionId || activeSessionId || '',
                    panelId: message.panelId,
                    webviewInstanceId: message.webviewInstanceId,
                    ts: Date.now()
                });
                break;
            }
            case 'liveTurnResume': {
                handleLiveTurnResume(message);
                break;
            }
            case 'liveTurnHistory': {
                handleLiveTurnHistory(message);
                break;
            }
            case 'sessionData': {
                const route = resolveEventSessionId(message, 'sessionData');
                const sessionId = route?.sessionId || null;
                if (!sessionId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSIONDATA_DROP]', 'missing-sessionId']
                    });
                    break;
                }
                const wasActiveSession = Boolean(activeSessionId && activeSessionId === sessionId);
                const isExplicitSelectionTarget = Boolean(pendingExplicitSessionSelectionId && pendingExplicitSessionSelectionId === sessionId);
                const isFirstBootstrap = !activeSessionId;
                const shouldActivateSession = wasActiveSession || isExplicitSelectionTarget || isFirstBootstrap;

                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SESSIONDATA_ENTER]', 
                        `sessionId=${sessionId}`, 
                        `messagesLen=${message.messages?.length ?? 0}`, 
                        `segmentsLen=${message.segments?.length ?? 0}`,
                        `activate=${shouldActivateSession ? 'true' : 'false'}`,
                        `explicit=${isExplicitSelectionTarget ? 'true' : 'false'}`,
                        `bootstrap=${isFirstBootstrap ? 'true' : 'false'}`]
                });

                try {
                    if (shouldActivateSession) {
                        activeSessionId = sessionId;
                        if (isExplicitSelectionTarget) {
                            pendingExplicitSessionSelectionId = '';
                        }
                        clearAppendInputForSessionChange(sessionId);
                        baseSessionTitle = message.title || 'OpenCode: Chat';
                        renderHeaderTitle();
                        renderHeaderUsage();
                        updateUndoStatusDisplay(sessionId);
                    } else {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SESSION_SELECTION_PRESERVE]', 'event=sessionData', `sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, `pendingExplicit=${pendingExplicitSessionSelectionId || 'null'}`]
                        });
                    }
                    
                    const session = getSessionState(sessionId, true);
                    const preservedHydrationState = captureVolatileHydrationState(session);
                    
                    const hasSegments = Array.isArray(message.segments);
                    // Clear everything
                    session.messagesById.clear();
                    session.timeline = [];
                    if (hasSegments) {
                        session.segmentsByNoticeKey.clear();
                        session.hiddenSet.clear();
                    }
                    session.thinkingId = null;
                    session.pendingAssistantUpgrade = null;
                    session.lastAssistantUpgradeFallback = null;
                    session.awaitingFinalMapBind = false;
                    session.backendTurnInFlight = false;
                    session.turnFullyFinalized = true;
                    session.earlyFinalAssistantId = null;
                    session.finalAssistantLock = null;
                    if (session.hiddenControlUserIds instanceof Set) {
                        session.hiddenControlUserIds.clear();
                    }
                    session.nextOrder = 0;
                    
                    // Load messages into timeline
                    const rawSessionMessages = Array.isArray(message.messages) ? message.messages : [];
                    for (const item of rawSessionMessages) {
                        if (!item || item.role !== 'user' || typeof item.id !== 'string') continue;
                        if (isHiddenControlUserText(item.text || '')) {
                            session.hiddenControlUserIds.add(item.id);
                        }
                    }
                    const explicitTimelineIds = Array.isArray(message?.meta?.timelineMessageIds)
                        ? message.meta.timelineMessageIds.filter((id) => typeof id === 'string' && id.length > 0)
                        : [];
                    if (explicitTimelineIds.length) {
                        // DUAL-LOAD STRATEGY:
                        // Load 1: Timeline messages only (via upsertMessage which pushes to timeline)
                        const timelineIdSet = new Set(explicitTimelineIds);
                        const timelineMessages = rawSessionMessages.filter((item) => {
                            if (!item || !item.id) return false;
                            if (!timelineIdSet.has(item.id)) return false;
                            if (item.role === 'user' && isHiddenControlUserText(item.text || '')) return false;
                            if (item.role === 'assistant' && isHiddenControlAssistantText(item.text || '')) return false;
                            return true;
                        });
                        for (const item of timelineMessages) {
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
                                ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, ''))
                                : rawText;
                            upsertMessage(session, {
                                id: key,
                                role: role,
                                text: cleanedText,
                                meta: item.meta || {},
                                order: session.nextOrder++
                            });
                        }
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][DUAL_LOAD_TIMELINE]', `loaded=${timelineMessages.length}`, `timelineNow=${session.timeline.length}`]
                        });

                        // Load 2: Backing messages directly to messagesById ONLY (NOT timeline)
                        const backingIds = new Set(
                            Array.isArray(message?.meta?.segmentBackingMessageIds)
                                ? message.meta.segmentBackingMessageIds.filter((id) => typeof id === 'string' && id.length > 0)
                                : []
                        );
                        let backingLoaded = 0;
                        if (backingIds.size > 0) {
                            for (const item of rawSessionMessages) {
                                if (!item?.id || !backingIds.has(item.id) || timelineIdSet.has(item.id)) continue;
                                if (!session.messagesById.has(item.id)) {
                                    let role = item.role;
                                    if (!role) {
                                        role = item.id.startsWith('msg_') ? 'assistant' : 'system';
                                    }
                                    const rawText = item.text || '';
                                    const cleanedText = role === 'user'
                                        ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, ''))
                                        : rawText;
                                    session.messagesById.set(item.id, {
                                        id: item.id,
                                        role: role,
                                        text: cleanedText,
                                        meta: item.meta || {}
                                    });
                                    backingLoaded++;
                                }
                            }
                        }
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][DUAL_LOAD_BACKING]', `backingIdsExpected=${backingIds.size}`, `backingLoaded=${backingLoaded}`, `messagesById=${session.messagesById.size}`]
                        });

                        // Reset timeline to explicit IDs. Keep undo segment slots even before placeholder hydration.
                        session.timeline = explicitTimelineIds.filter((id) =>
                            session.messagesById.has(id) || (typeof id === 'string' && id.startsWith('system:undo-seg:'))
                        );
                        const undoSlotCount = session.timeline.filter((id) => typeof id === 'string' && id.startsWith('system:undo-seg:')).length;
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][DUAL_LOAD_TIMELINE_RESET]', `explicit=${explicitTimelineIds.length}`, `kept=${session.timeline.length}`, `undoSlots=${undoSlotCount}`]
                        });
                        logTimelineSnapshot('snapshot-restore', session.timeline, `count=${session.timeline.length}`);
                    } else {
                        // Fallback: no explicit timeline IDs — use old logic
                        const sessionMessages = message?.meta?.source === 'snapshot'
                            ? rawSessionMessages.filter((item) => {
                                if (!item || !item.id) return false;
                                if (item.role === 'user' && isHiddenControlUserText(item.text || '')) return false;
                                if (item.role === 'assistant' && isHiddenControlAssistantText(item.text || '')) return false;
                                return true;
                            })
                            : collapseSessionDataMessagesForDisplay(
                                rawSessionMessages,
                                new Set(
                                    (Array.isArray(message.segments) ? message.segments : [])
                                        .map((seg) => seg?.anchorMsgId)
                                        .filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                                )
                            );
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
                                ? stripSystemInjections(rawText.replace(/^(\r?\n)+/, ''))
                                : rawText;
                            upsertMessage(session, {
                                id: key,
                                role: role,
                                text: cleanedText,
                                meta: item.meta || {},
                                order: session.nextOrder++
                            });
                        }
                    }

                    materializeInjectedChangeLists(session, rawSessionMessages, 'sessionData');
                     
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
                        const timelineSlotId = `system:undo-seg:${noticeKey}`;
                        let anchorIdx = session.timeline.indexOf(timelineSlotId);
                        if (anchorIdx === -1) {
                            if (!seg.anchorMsgId || !msgOnlyTimeline.includes(seg.anchorMsgId)) {
                                vscode.postMessage({
                                    type: 'ui-debug',
                                    payload: ['[WV][HYDRATE_SEG_SKIP]', 'reason=missing-slot-and-anchor', `noticeKey=${noticeKey}`]
                                });
                                skipped++;
                                continue;
                            }
                            anchorIdx = session.timeline.indexOf(seg.anchorMsgId);
                            if (anchorIdx === -1) {
                                for (let i = 0; i < session.timeline.length; i++) {
                                    const id = session.timeline[i];
                                    if (id === seg.anchorMsgId) {
                                        anchorIdx = i;
                                        break;
                                    }
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

                    const preservedLive = restoreVolatileHydrationState(session, preservedHydrationState);
                    const restoredAppendMeta = restoreAppendHydrationMetadata(sessionId, session);
                    if (restoredAppendMeta.rootCount > 0) {
                        syncAppendSnapshotMetadata(sessionId, 'sessionData-hydrate');
                    }
                    const skippedTimelineArtifacts = preservedLive.skippedArtifacts?.timeline || 0;
                    const skippedBackingArtifacts = preservedLive.skippedArtifacts?.backing || 0;
                    const skippedCanonicalTimeline = preservedLive.skippedCanonicalizedVolatile?.timeline || 0;
                    const skippedCanonicalBacking = preservedLive.skippedCanonicalizedVolatile?.backing || 0;
                    const skippedCanonicalFields = preservedLive.skippedCanonicalizedVolatile?.fields || 0;
                    const preservedLiveTurnResumeState = Boolean(
                        preservedHydrationState?.pendingAssistantUpgrade?.source === 'liveTurnResume' ||
                        Array.from(preservedHydrationState?.messagesById?.values?.() || []).some((item) => item?.meta?.liveTurnResume === true)
                    );
                    if (preservedLiveTurnResumeState && (skippedCanonicalTimeline || skippedCanonicalBacking || skippedCanonicalFields)) {
                        postLiveTurnResumeReconcileDiagnostic(
                            'EXT: webviewAutoRescue.liveTurnResume.finalizeReconcile',
                            sessionId,
                            'sessionData-canonicalized-live-pair',
                            [
                                `skippedCanonicalizedTimeline=${skippedCanonicalTimeline}`,
                                `skippedCanonicalizedBacking=${skippedCanonicalBacking}`,
                                `skippedCanonicalizedFields=${skippedCanonicalFields}`,
                                `thinkingId=${session.thinkingId || 'null'}`,
                                `currentTurnAssistantKey=${session.currentTurnAssistantKey || 'null'}`,
                                `backendTurnInFlight=${session.backendTurnInFlight === true ? 'true' : 'false'}`
                            ]
                        );
                    }
                    if (preservedLive.missingIds.length || preservedLive.fieldNames.length || skippedTimelineArtifacts || skippedBackingArtifacts || skippedCanonicalTimeline || skippedCanonicalBacking || skippedCanonicalFields) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][HYDRATE_PRESERVE_VOLATILE]',
                                `sessionId=${sessionId}`,
                                `preservedIds=${preservedLive.missingIds.length}`,
                                `skippedArtifacts=${skippedTimelineArtifacts + skippedBackingArtifacts}`,
                                `skippedSnapshotChangeListTimeline=${skippedTimelineArtifacts}`,
                                `skippedSnapshotChangeListBacking=${skippedBackingArtifacts}`,
                                `skippedCanonicalizedVolatile=${skippedCanonicalTimeline + skippedCanonicalBacking + skippedCanonicalFields}`,
                                `skippedCanonicalizedTimeline=${skippedCanonicalTimeline}`,
                                `skippedCanonicalizedBacking=${skippedCanonicalBacking}`,
                                `skippedCanonicalizedFields=${skippedCanonicalFields}`,
                                `tail=[${formatTail(preservedLive.missingIds, 6)}]`,
                                `fields=[${preservedLive.fieldNames.slice(0, 12).join(',')}]`,
                                `timelineSize=${session.timeline.length}`]
                        });
                    }

                    renderIfActive(sessionId, 'sessionData', { extra: ['phase=hydrated'] });
                    
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSION_LOADED]', 
                            `sessionId=${sessionId}`,
                            `messages=${session.timeline.length}`,
                            `segments=${session.segmentsByNoticeKey.size}`,
                            `hidden=${session.hiddenSet.size}`]
                    });
                    
                    hydratedSessions.add(sessionId);
                    if (shouldActivateSession) {
                        closeSessionPanel();
                        refreshSendButtonStateAfterSessionSwitch();
                    } else {
                        updateSendGate();
                    }
                    
                } catch (err) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSIONDATA_ERROR]', `sessionId=${sessionId}`, `err=${String(err)}`]
                    });
                } finally {
                    const didRender = renderIfActive(sessionId, 'sessionData-finally', { extra: ['phase=finally'] });
                    if (didRender) {
                        requestAnimationFrame(() => {
                            refreshSendButtonState();
                            scrollToBottom();
                        });
                    }
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
                const route = resolveEventSessionId(message, 'sessionId');
                const sessionId = route?.sessionId || null;
                if (!sessionId) break;
                const wasActiveSession = Boolean(activeSessionId && activeSessionId === sessionId);
                const isExplicitSelectionTarget = Boolean(pendingExplicitSessionSelectionId && pendingExplicitSessionSelectionId === sessionId);
                const isFirstBootstrap = !activeSessionId;
                const shouldActivateSession = wasActiveSession || isExplicitSelectionTarget || isFirstBootstrap;
                if (!shouldActivateSession) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SESSION_SELECTION_PRESERVE]', 'event=sessionId', `sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, `pendingExplicit=${pendingExplicitSessionSelectionId || 'null'}`]
                    });
                    logBackgroundStateUpdate(sessionId, 'sessionId', { extra: ['phase=selection-preserve'] });
                    refreshSendButtonState();
                    break;
                }
                const prevSessionId = activeSessionId;
                activeSessionId = sessionId;
                if (isExplicitSelectionTarget) {
                    pendingExplicitSessionSelectionId = '';
                }
                clearAppendInputForSessionChange(sessionId);
                renderHeaderUsage();
                if (prevSessionId && prevSessionId !== sessionId) {
                    clearQuestionOverlay('session-change');
                    clearPermissionOverlay('session-change');
                    closeStallCard();
                    setSystemNotice('');
                }
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
                refreshSendButtonStateAfterSessionSwitch();
                break;
            }
            case 'sessionUsage': {
                const sessionId = getEventSessionId(message, 'sessionUsage');
                if (!sessionId) break;
                const used = Number(message?.used);
                const size = Number(message?.size);
                const amount = Number(message?.amount);
                sessionUsageById.set(sessionId, {
                    used: Number.isFinite(used) ? used : 0,
                    size: Number.isFinite(size) ? size : 0,
                    amount: Number.isFinite(amount) ? amount : 0
                });
                if (sessionId === activeSessionId) {
                    renderHeaderUsage();
                }
                break;
            }
            case 'compactionState': {
                const sessionId = getEventSessionId(message, 'compactionState');
                if (!sessionId) break;
                const running = Boolean(message?.running);
                if (running) {
                    compactionRunningBySession.add(sessionId);
                } else {
                    compactionRunningBySession.delete(sessionId);
                    const prev = sessionUsageById.get(sessionId);
                    if (prev) {
                        sessionUsageById.set(sessionId, {
                            used: 0,
                            size: Number(prev.size) > 0 ? Number(prev.size) : getSelectedModelContextLimit(),
                            amount: Number(prev.amount) || 0
                        });
                    } else {
                        const fallbackSize = getSelectedModelContextLimit();
                        if (fallbackSize > 0) {
                            sessionUsageById.set(sessionId, { used: 0, size: fallbackSize, amount: 0 });
                        }
                    }
                }
                if (sessionId === activeSessionId) {
                    renderHeaderUsage();
                    updateSendGate();
                }
                break;
            }
            case 'prefillInput': {
                const displayText = typeof message.displayText === 'string' ? message.displayText : '';
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : null;
                addContextItem(displayText, payload);
                break;
            }
            case 'workspaceFileResults': {
                if (message.requestId !== fileMentionState.requestId) break;
                const files = Array.isArray(message.files) ? message.files : [];
                fileMentionState.items = files.map(normalizeFileRef).filter(Boolean);
                fileMentionState.selectedIndex = 0;
                fileMentionState.open = Boolean(fileMentionState.range);
                renderFileMentionList();
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
            case 'userAckBind': {
                handleUserAckBindMessage(message);
                break;
            }
            case 'appendStatus': {
                const sessionId = getEventSessionId(message, 'appendStatus');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                const root = resolveAppendRootMessage(session, message);
                if (!root) break;
                const item = upsertAppendItem(root, {
                    clientMessageId: message.clientMessageId,
                    status: message.status || 'queued',
                    reason: message.reason || ''
                });
                syncAppendSnapshotMetadata(sessionId, 'appendStatus');
                if (
                    sessionId === activeSessionId
                    && (message.status === 'failed' || message.status === 'rejected')
                    && root?.id
                    && item?.text
                ) {
                    enterAppendInputMode(root.id, item.text);
                }
                vscode.postMessage({ type: 'ui-debug', payload: ['[WV][APPEND_ROUTE]', 'appendStatus', 'sessionId', sessionId, 'activeSessionId', activeSessionId || 'null', 'status', message.status || 'queued'] });
                renderIfActive(sessionId, 'appendStatus');
                break;
            }
            case 'appendUserMessage': {
                const sessionId = getEventSessionId(message, 'appendUserMessage');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                const root = resolveAppendRootMessage(session, message);
                if (!root) break;
                upsertAppendItem(root, {
                    clientMessageId: message.clientMessageId,
                    appendUserMsgId: message.appendUserMsgId,
                    text: typeof message.text === 'string' ? message.text : '',
                    // The user-message SSE only means opencode persisted the append.
                    // It can still be queued behind the active turn's current work.
                    status: 'queued'
                });
                syncAppendSnapshotMetadata(sessionId, 'appendUserMessage');
                vscode.postMessage({ type: 'ui-debug', payload: ['[WV][APPEND_ROUTE]', 'appendUserMessage', 'sessionId', sessionId, 'activeSessionId', activeSessionId || 'null', 'rootUserMsgId', message.rootUserMsgId || 'null', 'appendUserMsgId', message.appendUserMsgId || 'null'] });
                renderIfActive(sessionId, 'appendUserMessage', { scroll: true, scrollFallback: scrollToBottom });
                break;
            }
            case 'turnInFlight': {
                const sessionId = getEventSessionId(message, 'turnInFlight');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                session.backendTurnInFlight = Boolean(message?.inFlight);
                if (message?.inFlight) {
                    session.turnFullyFinalized = false;
                    session.snapshotFinalizeReady = false;
                    const ownerMsgId = typeof message?.ownerMsgId === 'string' ? message.ownerMsgId : null;
                    if (ownerMsgId && session.messagesById.has(ownerMsgId)) {
                        const activeAssistantKey = session.currentTurnAssistantKey || session.thinkingId;
                        const hasActiveTempAssistant = typeof activeAssistantKey === 'string' && (activeAssistantKey.startsWith('tmp:') || activeAssistantKey.startsWith('local-'));
                        if (hasActiveTempAssistant && activeAssistantKey !== ownerMsgId) {
                            vscode.postMessage({ type: 'ui-debug', payload: ['turnInFlight', 'skip-owner-over-temp', 'ownerMsgId', ownerMsgId, 'activeAssistantKey', activeAssistantKey] });
                            updateSendGate();
                            break;
                        }
                        session.currentTurnAssistantKey = ownerMsgId;
                        session.currentTurnAssistantMsgId = ownerMsgId;
                        session.thinkingId = ownerMsgId;
                        const ownerMsg = session.messagesById.get(ownerMsgId);
                        if (ownerMsg) {
                            ownerMsg.meta = {
                                ...(ownerMsg.meta || {}),
                                isThinking: true,
                                statusText: ''
                            };
                        }
                    }
                } else {
                    maybeExitAppendInputModeAfterTurnEnd(sessionId, 'turnInFlight:false');
                }
                updateSendGate();
                break;
            }
            case 'systemNotice': {
                const sessionId = getEventSessionId(message, 'systemNotice');
                if (sessionId && sessionId !== activeSessionId) break;
                const text = typeof message?.message === 'string' ? message.message : '';
                setSystemNotice(text);
                break;
            }
            case 'systemNoticeClear': {
                const sessionId = getEventSessionId(message, 'systemNoticeClear');
                if (sessionId && sessionId !== activeSessionId) break;
                setSystemNotice('');
                break;
            }
            case 'stallCard': {
                const sessionId = getEventSessionId(message, 'stallCard');
                if (sessionId && sessionId !== activeSessionId) break;
                showStallCard(message);
                break;
            }
            case 'messageIndexMapDelta': {
                const sessionId = getEventSessionId(message, 'messageIndexMapDelta');
                if (!sessionId) break;
                const session = getSessionState(sessionId, true);
                const messageId = typeof message?.messageId === 'string' ? message.messageId : '';
                const messageIndex = typeof message?.messageIndex === 'number' ? message.messageIndex : null;
                if (messageId && Number.isFinite(messageIndex)) {
                    session.messageIndexMap.set(messageId, messageIndex);
                    const tmpKey = session.pendingAssistantUpgrade?.tmpKey || session.thinkingId || null;
                    const assistantUpgradeFallbackSnapshot = session.lastAssistantUpgradeFallback ? {
                        ...session.lastAssistantUpgradeFallback,
                        authoritativePreAttemptCurrentTurnAssistantKey: session.currentTurnAssistantKey || null,
                        authoritativePreAttemptTmpStillPresent: Boolean(
                            tmpKey && (
                                session.messagesById?.has?.(tmpKey) ||
                                session.timeline?.includes?.(tmpKey) ||
                                session.currentTurnAssistantKey === tmpKey ||
                                session.thinkingId === tmpKey
                            )
                        )
                    } : null;
                    attemptAssistantUpgrade(sessionId, { sessionId, tmpKey, assistantMsgId: messageId }, 'messageIndexMapDelta');
                    reconcileAssistantUpgradeFallbackWithAuthoritativeMap(sessionId, session, 'messageIndexMapDelta', messageId, assistantUpgradeFallbackSnapshot);
                    if (session.currentTurnAssistantKey === messageId) {
                        session.awaitingFinalMapBind = false;
                        if (session.pendingAssistantUpgrade?.assistantMsgId === messageId) {
                            session.pendingAssistantUpgrade = null;
                            session.lastAssistantUpgradeFallback = null;
                        }
                    }
                }
                updateSendGate();
                break;
            }
            case 'messageIndexMap': {
                const route = resolveEventSessionId(message, 'messageIndexMap');
                if (!route) break;
                const sessionId = route.sessionId;
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
                        session.lastAssistantUpgradeFallback = null;
                        session.awaitingFinalMapBind = false;
                        vscode.postMessage({ type: 'ui-debug', payload: ['[DBG_PENDING_UPGRADE_CLEAR]', 'sessionId', sessionId] });
                    }
                }
                if (session) {
                    reconcileAssistantUpgradeFallbackWithAuthoritativeMap(sessionId, session, 'messageIndexMap');
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
                if (session && !route.shouldRender) {
                    logBackgroundStateUpdate(sessionId, 'messageIndexMap');
                }
                updateSendGate();
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
                const route = resolveContentEventRoute(message, 'assistantMessageMeta');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, false);
                retainAgentLaneParentAssociation(session, route);
                if (session?.canceledActiveTurn) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['assistantMessageMeta', 'drop-canceledActiveTurn', `sessionId=${sessionId}`]
                    });
                    break;
                }
                if (session?.turnFullyFinalized === true && session?.backendTurnInFlight !== true) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['assistantMessageMeta', 'drop-turnSealed', `sessionId=${sessionId}`]
                    });
                    break;
                }
                const allowedSessionIds = Array.isArray(message?.allowedSessionIds)
                    ? message.allowedSessionIds.filter(id => typeof id === 'string' && id.length)
                    : [];
                const isAllowedSession = !allowedSessionIds.length || allowedSessionIds.includes(sessionId);
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: [
                        '[WV][ASSIST_META_GATE]',
                        `current=${activeSessionId || 'null'}`,
                        `meta=${sessionId}`,
                        `allowedCount=${allowedSessionIds.length}`,
                        `isAllowed=${isAllowedSession}`,
                        `assistantMsgId=${message?.assistantMsgId || message?.messageId || 'null'}`
                    ]
                });
                if (!isAllowedSession) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: [
                            '[WV][ASSIST_META_BLOCKED]',
                            `current=${activeSessionId || 'null'}`,
                            `meta=${sessionId}`,
                            `allowed=${allowedSessionIds.join(',') || 'none'}`
                        ]
                    });
                    break;
                }
                const sessionStateForAllowed = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(sessionStateForAllowed, route);

                // P2: Suppress synthetic auto-continuation turns
                if (message.isSyntheticTurn === true) {
                    // State tracking still happens (getSessionState above),
                    // but skip all display side-effects.
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: [
                            '[WV][ASSIST_META_SYNTHETIC_SUPPRESSED]',
                            `sessionId=${sessionId}`,
                            `turnId=${message.turnId || 'null'}`,
                            `msgId=${message.assistantMsgId || message.messageId || 'null'}`
                        ]
                    });
                    break;
                }
                handleAssistantMeta(sessionId, message, { render: route.shouldRender });
                // Removed: reconcilePendingSegments - new system uses applyHydratedSegments
                if (!tryPatchAssistantStreamingBubble(sessionId, 'assistantMessageMeta').applied) {
                    renderIfActive(sessionId, 'assistantMessageMeta', { scroll: true });
                }
                logSessionState(sessionId, 'assistantMessageMeta');
                break;
            }
            case 'assistantPhase': {
                const route = resolveContentEventRoute(message, 'assistantPhase');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(session, route);
                if (!session.meta) session.meta = {};
                if (!session.meta.assistantPhases) session.meta.assistantPhases = {};
                const msgId = typeof message.messageId === 'string' ? message.messageId : '';
                if (msgId) {
                    session.meta.assistantPhases[msgId] = {
                        phase: message.phase || '',
                        lane: message.lane || 'unknown',
                        ts: typeof message.ts === 'number' ? message.ts : Date.now()
                    };
                    const parentId =
                        (typeof message.parentId === 'string' && message.parentId)
                        || (typeof message.parentID === 'string' && message.parentID)
                        || '';
                    if (markAppendItemSeenByAssistantParent(session, parentId)) {
                        window.__oc?.renderFromState?.();
                    }
                    if (message.phase === 'assistant_final_accepted') {
                        session.earlyFinalAssistantId = msgId;
                        if (sessionHasActiveBackgroundSubagents(session)) {
                            requestBackgroundPulseRender(sessionId);
                        }
                    }
                }
                break;
            }
            case 'chatChunk': {
                const route = resolveContentEventRoute(message, 'chatChunk');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId);
                retainAgentLaneParentAssociation(session, route);
                if (session?.canceledActiveTurn) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['chatChunk', 'drop-canceledActiveTurn', `sessionId=${sessionId}`]
                    });
                    break;
                }
                if (session?.turnFullyFinalized === true && session?.backendTurnInFlight !== true) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['chatChunk', 'drop-turnSealed', `sessionId=${sessionId}`]
                    });
                    break;
                }
                handleChatChunk(sessionId, message);
                if (!tryPatchAssistantStreamingBubble(sessionId, 'chatChunk').applied) {
                    renderIfActive(sessionId, 'chatChunk', { scroll: true });
                }
                logSessionState(sessionId, 'chatChunk');
                break;
            }
            case 'turnFinalizePhase': {
                const route = resolveEventSessionId(message, 'turnFinalizePhase');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                if (!session.meta) session.meta = {};
                session.meta.turnFinalizePhase = message.phase || '';
                if (message.phase === 'finalize_done') {
                    session.turnFullyFinalized = true;
                    session.backendTurnInFlight = false;
                    session.snapshotFinalizeReady = true;
                    const pendingEpoch = typeof session.snapshotPendingEpoch === 'number' ? session.snapshotPendingEpoch : 0;
                    const emittedEpoch = typeof session.snapshotEmittedEpoch === 'number' ? session.snapshotEmittedEpoch : 0;
                    if (route.isActive && pendingEpoch > emittedEpoch) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SNAPSHOT_ROUTE]', `sessionId=${sessionId}`, `reason=skip-finalize-owned-extension`, `epochPending=${pendingEpoch}`, `epochEmitted=${emittedEpoch}`]
                        });
                    }
                    maybeExitAppendInputModeAfterTurnEnd(sessionId, 'finalize_done');
                    clearBusyForSession(sessionId, 'turnFinalizePhase:finalize_done');
                    updateSendGate();
                    renderIfActive(sessionId, 'turnFinalizePhase:finalize_done');
                }
                break;
            }
            case 'chatDone': {
                const route = resolveContentEventRoute(message, 'chatDone');
                if (!route) break;
                const sessionId = route.sessionId;
                logIdCandidates('[DBG_CHATDONE]', message, sessionId, activeSessionId);
                const session = getSessionState(sessionId);
                retainAgentLaneParentAssociation(session, route);
                if (session) {
                    const tail = formatTail(session.timeline);
                    vscode.postMessage({ type: 'ui-debug', payload: ['[DBG_CHATDONE]', `timelineTail=${tail}`] });
                }
                if (session?.canceledActiveTurn) {
                    clearBusyForSession(sessionId, 'chatDone:canceledActiveTurn');
                    maybeExitAppendInputModeAfterTurnEnd(sessionId, 'chatDone:canceledActiveTurn');
                    logSessionState(sessionId, 'chatDone.canceledActiveTurn');
                    break;
                }
                handleChatDone(sessionId, message);
                maybeExitAppendInputModeAfterTurnEnd(sessionId, 'chatDone');
                if (session) {
                    session.cancelledTurn = false;
                }
                renderIfActive(sessionId, 'chatDone', { scroll: true });
                clearBusyForSession(sessionId, 'chatDone');
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
                    selectedMode = modes.includes(draft.mode)
                        ? draft.mode
                        : (modes.includes('plan') ? 'plan' : (modes[0] || 'plan'));
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
                const route = resolveEventSessionId(message, 'userMessageUpgrade');
                if (!route) {
                    vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${message?.localKey || 'null'} msgId=${message?.userMsgId || 'null'} replaced=false reason=session-mismatch`] });
                    break;
                }
                const sessionId = route.sessionId;
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
                let userKeyReplaced = false;

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
                        renderIfActive(sessionId, 'userMessageUpgrade:awaitingAssistantIdFromExport');
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
                        const serverUserMsg = userMsgId ? session.messagesById.get(userMsgId) : null;
                        if (
                            localKey.startsWith('cont:')
                            && serverUserMsg?.role === 'user'
                            && session.timeline.includes(userMsgId)
                        ) {
                            vscode.postMessage({
                                type: 'ui-debug',
                                payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=true reason=continuation-already-bound`]
                            });
                        } else {
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=missing-local`] });
                        }
                    } else if (localMsg.role !== 'user') {
                        vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=local-not-user`] });
                    } else {
                        const existing = session.messagesById.get(userMsgId);
                        if (existing && existing.role !== 'user') {
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=false reason=collision-nonuser`] });
                        } else {
                            replaceKeyEverywhere(localKey, userMsgId, sessionId);
                            userKeyReplaced = true;
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade', `user.upgrade: localKey=${localKey || 'null'} msgId=${userMsgId || 'null'} replaced=true reason=ok`] });
                            logTimelineSnapshot('user.upgrade', session.timeline, 'expectSize=2');
                            const counts = timelineCounts(session.timeline);
                            vscode.postMessage({ type: 'ui-debug', payload: ['user.upgrade.accept', `timelineSize=${session.timeline.length} expect=2 counts msg=${counts.msg} tmp=${counts.tmp} local=${counts.local}`] });
                        }
                    }
                }

                if (assistantMsgId && session.pendingAssistantUpgrade?.tmpKey) {
                    session.pendingAssistantUpgrade.assistantMsgId = assistantMsgId;
                    session.pendingAssistantUpgrade.fallbackAssistantKey = assistantMsgId;
                    session.pendingAssistantUpgrade.fallbackSourceTmpKey = session.pendingAssistantUpgrade.tmpKey;
                    session.pendingAssistantUpgrade.fallbackSessionId = sessionId;
                    session.pendingAssistantUpgrade.fallbackSource = 'userMessageUpgrade';
                    session.pendingAssistantUpgrade.fallbackTurnAnchor = session.currentTurnAssistantKey || session.thinkingId || session.pendingAssistantUpgrade.tmpKey;
                }
                
                // Also upgrade the assistant message if provided
                attemptAssistantUpgrade(sessionId, message, 'userMessageUpgrade');
                if (userKeyReplaced) {
                    countUserMessageAppendFastPathResult('fallback-full-render', [
                        `reason=user-identity-resync`,
                        `sessionId=${sessionId || 'null'}`,
                        `localKey=${localKey || 'null'}`,
                        `userMsgId=${userMsgId || 'null'}`
                    ]);
                    renderIfActive(sessionId, 'userMessageUpgrade:user-identity-resync');
                }
                if (!route.shouldRender) {
                    logBackgroundStateUpdate(sessionId, 'userMessageUpgrade');
                }
                
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
                const route = resolveEventSessionId(message, 'permissionPrompt');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: `Permission required. Check OpenCode output: ${message.value}`,
                    meta: {}
                });
                renderIfActive(sessionId, 'permissionPrompt');
                break;
            }
            case 'diffChunk': {
                const route = resolveContentEventRoute(message, 'diffChunk');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(session, route);
                if (!shouldRenderDiffChunk(session, message)) {
                    break;
                }
                upsertMessage(session, {
                    id: `diff:${Date.now()}`,
                    role: 'system',
                    text: message.value || '',
                    meta: { isDiff: true, diffText: message.value || '' }
                });
                renderIfActive(sessionId, 'diffChunk', { scroll: true });
                break;
            }
            case 'diffFileList': {
                const route = resolveEventSessionId(message, 'diffFileList');
                if (!route) break;
                const sessionId = route.sessionId;
                discardAllSegments(sessionId, 'file-change-detected', selectedMode || 'unknown');
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
                const existing = session.messagesById.get(changeListId);
                const anchorMessageId = typeof message.anchorMessageId === 'string' && message.anchorMessageId.length
                    ? message.anchorMessageId
                    : '';
                const stableAnchorMessageId = anchorMessageId
                    ? (toStableMessageKey(session, anchorMessageId) || anchorMessageId)
                    : '';
                const existingFiles = existing?.meta?.kind === 'changeList' && Array.isArray(existing.meta.files)
                    ? existing.meta.files.filter((item) => typeof item === 'string' && item.length)
                    : [];
                const mergedFiles = files;
                const mergedFileSet = new Set(mergedFiles);
                const mergedStats = Object.fromEntries(
                    Object.entries(statsByPath).filter(([path]) => mergedFileSet.has(path))
                );
                upsertMessage(session, {
                    id: changeListId,
                    role: 'system',
                    text: '',
                    meta: {
                        kind: 'changeList',
                        files: mergedFiles,
                        source: message.source || 'git',
                        scope: message.scope || 'turn',
                        commitHead: commitHead || undefined,
                        commitBase: commitBase || undefined,
                        reverted: message.reverted === true,
                        statsByPath: mergedStats,
                        anchorMessageId: anchorMessageId || existing?.meta?.anchorMessageId,
                        stableAnchorMessageId: stableAnchorMessageId || existing?.meta?.stableAnchorMessageId
                    }
                });
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][DIFF_FILE_LIST]', `sessionId=${sessionId}`, `changeListId=${changeListId}`, `incomingFileCount=${files.length}`, `existingFileCount=${existingFiles.length}`, `finalFileCount=${mergedFiles.length}`]
                });
                if (stableAnchorMessageId) {
                    placeMessageAfterAnchor(session, changeListId, stableAnchorMessageId, 'diffFileList');
                }
                renderIfActive(sessionId, 'diffFileList', { scroll: true });
                break;
            }
            case 'changeListUpdate': {
                const route = resolveEventSessionId(message, 'changeListUpdate');
                if (!route) break;
                const sessionId = route.sessionId;
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
                    renderIfActive(sessionId, 'changeListUpdate');
                }
                break;
            }
            case 'todoUpdate': {
                const parentVisible = message?.displayTarget === 'parent' || typeof message?.parentSessionId === 'string';
                const route = parentVisible
                    ? resolveParentVisibleSubagentRoute(message, 'todoUpdate')
                    : resolveEventSessionId(message, 'todoUpdate');
                if (!route) break;
                const sessionId = parentVisible ? route.parentSessionId : route.sessionId;
                const { todos, anchorMessageId } = message;
                if (!Array.isArray(todos)) break;
                const session = getSessionState(sessionId, parentVisible);
                if (!session) break;
                const activeTargetId = session.currentTurnAssistantKey || session.thinkingId || null;
                let msg = activeTargetId ? session.messagesById.get(activeTargetId) : null;
                if ((!msg || msg.meta?.isThinking !== true) && anchorMessageId) {
                    const anchored = session.messagesById.get(anchorMessageId);
                    if (anchored?.meta?.isThinking === true) {
                        msg = anchored;
                    }
                }
                if (!msg) break;
                if (!msg.meta) msg.meta = {};
                msg.meta.todos = todos;
                renderIfActive(sessionId, 'todoUpdate', parentVisible ? { extra: [`agentSessionId=${route.agentSessionId || 'null'}`] } : undefined);
                break;
            }
            case 'messageAppend': {
                const route = resolveContentEventRoute(message, 'messageAppend');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(session, route);
                if (session?.canceledActiveTurn && message?.message?.id === session.lastTurnUserId) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['messageAppend', 'drop-cancelled', `messageId=${message?.message?.id || 'null'}`]
                    });
                    break;
                }
                if (session?.turnFullyFinalized === true && session?.backendTurnInFlight !== true) {
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['messageAppend', 'drop-turnSealed', `sessionId=${sessionId}`]
                    });
                    break;
                }
                if (message.message && message.message.role === 'user' && isHiddenControlUserText(message.message.text || '')) {
                    if (typeof message.message.id === 'string' && message.message.id.length) {
                        session.hiddenControlUserIds.add(message.message.id);
                    }
                    break;
                }
                if (message.message && message.message.role === 'assistant' && isHiddenControlAssistantText(message.message.text || '')) {
                    break;
                }
                if (message.message && message.message.role === 'assistant'
                    && shouldDropHiddenControlAssistant(session, message.message, 'messageAppend', message.message.id)) {
                    break;
                }
                if (message.message && message.message.id) {
                    upsertMessage(session, {
                        id: message.message.id,
                        role: message.message.role || 'assistant',
                        text: message.message.text || '',
                        meta: {}
                    });
                    renderIfActive(sessionId, 'messageAppend', { scroll: true });
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
                const route = resolveEventSessionId(message, 'permissionPrompt');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                upsertMessage(session, {
                    id: `system:${Date.now()}`,
                    role: 'system',
                    text: `Permission required. Check OpenCode output: ${message.value}`,
                    meta: {}
                });
                renderIfActive(sessionId, 'permissionPrompt');
                break;
            }
            case 'diffChunk': {
                const route = resolveContentEventRoute(message, 'diffChunk');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(session, route);
                if (!shouldRenderDiffChunk(session, message)) {
                    break;
                }
                upsertMessage(session, {
                    id: `diff:${Date.now()}`,
                    role: 'system',
                    text: message.value || '',
                    meta: { isDiff: true, diffText: message.value || '' }
                });
                renderIfActive(sessionId, 'diffChunk', { scroll: true });
                break;
            }
            case 'messageAppend': {
                const route = resolveContentEventRoute(message, 'messageAppend');
                if (!route) break;
                const sessionId = route.sessionId;
                const session = getSessionState(sessionId, true);
                retainAgentLaneParentAssociation(session, route);
                if (message.message && message.message.role === 'user' && isHiddenControlUserText(message.message.text || '')) {
                    if (typeof message.message.id === 'string' && message.message.id.length) {
                        session.hiddenControlUserIds.add(message.message.id);
                    }
                    break;
                }
                if (message.message && message.message.role === 'assistant' && isHiddenControlAssistantText(message.message.text || '')) {
                    break;
                }
                if (message.message && message.message.role === 'assistant'
                    && shouldDropHiddenControlAssistant(session, message.message, 'messageAppend', message.message.id)) {
                    break;
                }
                if (message.message && message.message.id) {
                    upsertMessage(session, {
                        id: message.message.id,
                        role: message.message.role || 'assistant',
                        text: message.message.text || '',
                        meta: {}
                    });
                    renderIfActive(sessionId, 'messageAppend', { scroll: true });
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
                    if (applied === false) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SEG_UPSERT_SKIP]', `noticeKey=${upsertNoticeKey}`, 'reason=undo-not-applied']
                        });
                        window.__oc?.renderFromState?.();
                        logSessionState(sessionId, 'revertedSegment.notApplied');
                        break;
                    }
                    const explicitPayloadMessageIds = Array.isArray(segPayload?.messageIds)
                        ? segPayload.messageIds
                        : (Array.isArray(message?.messageIds) ? message.messageIds : []);
                    const fallbackAnchor = resolveSegmentMessageId(session, anchorForUpsert) || anchorForUpsert;
                    const fallbackEnd = resolveSegmentMessageId(session, endForUpsert) || fallbackAnchor;
                    const payloadMemberMsgIds = explicitPayloadMessageIds
                        .map((id) => resolveSegmentMessageId(session, id) || id)
                        .filter((id) => typeof id === 'string' && id.startsWith('msg_'));
                    const hasExplicitMemberIds = payloadMemberMsgIds.length > 0;
                    let memberMsgIds = hasExplicitMemberIds
                        ? payloadMemberMsgIds
                        : computeMemberMsgIdsFromTimeline(session, fallbackAnchor, fallbackEnd);
                    if (!memberMsgIds.length) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][SEG_UPSERT_SKIP]', `noticeKey=${upsertNoticeKey}`, 'reason=empty-messageIds']
                        });
                        break;
                    }
                    const normalizedAnchorForUpsert = memberMsgIds[0] || fallbackAnchor;
                    const normalizedEndForUpsert = memberMsgIds.length
                        ? memberMsgIds[memberMsgIds.length - 1]
                        : fallbackEnd;
                    endForUpsert = normalizedEndForUpsert;
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_MEMBERS]', `source=${hasExplicitMemberIds ? 'explicit' : 'timeline'}`,
                            `anchor=${normalizedAnchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`,
                            `count=${memberMsgIds.length}`]
                    });

                    // Merge with any placeholders after anchor within the final range
                    let finalEndMsgId = endForUpsert;
                    let finalMemberMsgIds = memberMsgIds;
                    let mergedInvalidSegments = Array.isArray(segPayload?.mergedInvalidSegments)
                        ? segPayload.mergedInvalidSegments
                            .map((child) => sanitizeMergedSegmentSnapshot(child))
                            .filter(Boolean)
                        : [];
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
                    const anchorIdx = normalizedAnchorForUpsert ? getMsgTimelineIndex(normalizedAnchorForUpsert) : -1;
                    const newEndIdx = endForUpsert ? getMsgTimelineIndex(endForUpsert) : -1;
                    const payloadVisibleIndices = memberMsgIds
                        .map((id) => getMsgTimelineIndex(id))
                        .filter((idx) => idx >= 0);
                    const payloadEndIdx = payloadVisibleIndices.length
                        ? Math.max(...payloadVisibleIndices)
                        : -1;

                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][MERGE_SCAN_INIT]',
                            `anchorIdx=${anchorIdx}`,
                            `newEndIdx=${newEndIdx}`]
                    });

                    if (anchorIdx >= 0) {
                        let maxEndIdx = payloadEndIdx >= 0 ? payloadEndIdx : newEndIdx;
                        if (maxEndIdx < anchorIdx) {
                            maxEndIdx = anchorIdx;
                        }
                        const noticeKeysToDelete = [];
                        const placeholderIdxToDelete = [];
                        const mergedMemberMsgIds = new Set(memberMsgIds);
                        const mergedChildSegments = [];
                        let i = anchorIdx + 1;

                        while (i <= maxEndIdx && i < session.timeline.length) {
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
                                mergedChildSegments.push(oldSeg);
                                const oldMemberMsgIds = Array.isArray(oldSeg.memberMsgIds)
                                    ? oldSeg.memberMsgIds.filter((msgId) => typeof msgId === 'string' && msgId.startsWith('msg_'))
                                    : [];
                                if (oldSeg.restoreAllowed === false) {
                                    const snapshot = sanitizeMergedSegmentSnapshot(oldSeg);
                                    if (snapshot) {
                                        mergedInvalidSegments.push(snapshot);
                                    }
                                }
                                for (const oldMsgId of oldMemberMsgIds) {
                                    mergedMemberMsgIds.add(oldMsgId);
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

                            finalMemberMsgIds = Array.from(mergedMemberMsgIds);
                            const candidateEndIds = [endForUpsert];
                            for (const oldSeg of mergedChildSegments) {
                                if (oldSeg?.endMsgId) {
                                    candidateEndIds.push(oldSeg.endMsgId);
                                }
                            }
                            let farthestEndId = endForUpsert;
                            let farthestEndIdx = endForUpsert ? getMsgTimelineIndex(endForUpsert) : -1;
                            for (const candidateId of candidateEndIds) {
                                const candidateIdx = candidateId ? getMsgTimelineIndex(candidateId) : -1;
                                if (candidateIdx > farthestEndIdx) {
                                    farthestEndIdx = candidateIdx;
                                    farthestEndId = candidateId;
                                }
                            }

                            const mergedInvalidMsgIds = new Set(
                                mergedInvalidSegments.flatMap((child) => Array.isArray(child?.memberMsgIds) ? child.memberMsgIds : [])
                                    .filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                            );
                            const activeMergedMsgIds = finalMemberMsgIds.filter((id) => !mergedInvalidMsgIds.has(id));
                            const activeMergedVisibleIndices = activeMergedMsgIds
                                .map((id) => getMsgTimelineIndex(id))
                                .filter((idx) => idx >= 0);
                            const farthestActiveVisibleIdx = activeMergedVisibleIndices.length
                                ? Math.max(...activeMergedVisibleIndices)
                                : -1;
                            const farthestActiveVisibleId = farthestActiveVisibleIdx >= 0
                                ? session.timeline[farthestActiveVisibleIdx]
                                : null;

                            if (maxEndIdx >= anchorIdx) {
                                const slice = session.timeline.slice(anchorIdx, maxEndIdx + 1);
                                const visibleMergedMsgIds = slice.filter((id) => typeof id === 'string' && id.startsWith('msg_'));
                                if (visibleMergedMsgIds.length) {
                                    finalEndMsgId = farthestActiveVisibleId || farthestEndId || activeMergedMsgIds[activeMergedMsgIds.length - 1] || finalMemberMsgIds[finalMemberMsgIds.length - 1] || finalEndMsgId;
                                    vscode.postMessage({
                                        type: 'ui-debug',
                                        payload: ['[WV][MERGE_MEMBERS]',
                                            `count=${finalMemberMsgIds.length}`,
                                            `first=${finalMemberMsgIds[0] || 'null'}`,
                                            `last=${finalMemberMsgIds[finalMemberMsgIds.length - 1] || 'null'}`,
                                            `activeLast=${activeMergedMsgIds[activeMergedMsgIds.length - 1] || 'null'}`,
                                            `end=${finalEndMsgId || 'null'}`]
                                    });
                                } else {
                                    mergeApplied = false;
                                }
                            } else {
                                finalEndMsgId = farthestActiveVisibleId || farthestEndId || activeMergedMsgIds[activeMergedMsgIds.length - 1] || finalMemberMsgIds[finalMemberMsgIds.length - 1] || finalEndMsgId;
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
                            `anchor=${normalizedAnchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`]
                    });
                    const existingSegment = session.segmentsByNoticeKey.get(upsertNoticeKey);
                    const incomingRestoreAllowed = segPayload?.restoreAllowed === false ? false : true;
                    const restoreAllowed = existingSegment?.restoreAllowed === false ? false : incomingRestoreAllowed;
                    if (existingSegment?.restoreAllowed === false && incomingRestoreAllowed === true) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['RESTORE_LOCK_MONOTONIC_FAIL', `noticeKey=${upsertNoticeKey}`, 'from=false', 'to=true', 'action=blocked']
                        });
                    }
                    session.segmentsByNoticeKey.set(upsertNoticeKey, {
                        noticeKey: upsertNoticeKey,
                        anchorMsgId: normalizedAnchorForUpsert,
                        endMsgId: endForUpsert,
                        memberMsgIds,
                        mergedInvalidSegments,
                        applied,
                        restoreAllowed,
                        ackOpId: ackOpId || null,
                        collapsed: true,
                        createdAt: Date.now()
                    });
                    vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_PERSIST_TX]',
                            `sessionId=${sessionId || 'null'}`,
                            `noticeKey=${upsertNoticeKey}`,
                            `anchor=${normalizedAnchorForUpsert || 'null'}`,
                            `end=${endForUpsert || 'null'}`,
                            `membersCount=${memberMsgIds.length}`]
                    });
                    vscode.postMessage({
                        type: 'undoSegmentUpsert',
                        sessionId,
                        segment: {
                            noticeKey: upsertNoticeKey,
                            anchorMsgId: normalizedAnchorForUpsert,
                            endMsgId: endForUpsert,
                            memberMsgIds,
                            mergedInvalidSegments,
                            applied,
                            restoreAllowed,
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
                    const placeholderId = upsertUndoPlaceholder(session, upsertNoticeKey, normalizedAnchorForUpsert, endForUpsert, applied);
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
                const mergedInvalidSegments = Array.isArray(seg?.mergedInvalidSegments)
                    ? seg.mergedInvalidSegments
                        .map((child) => sanitizeMergedSegmentSnapshot(child))
                        .filter(Boolean)
                    : [];
                const pIdx = session.timeline.indexOf(placeholderId);
                let didReplace = false;
                if (pIdx >= 0 && seg?.anchorMsgId) {
                    session.timeline[pIdx] = seg.anchorMsgId;
                    didReplace = true;
                }
                session.messagesById.delete(placeholderId);

                for (const child of mergedInvalidSegments) {
                    session.segmentsByNoticeKey.set(child.noticeKey, {
                        noticeKey: child.noticeKey,
                        anchorMsgId: child.anchorMsgId,
                        endMsgId: child.endMsgId,
                        memberMsgIds: Array.isArray(child.memberMsgIds) ? child.memberMsgIds : [],
                        mergedInvalidSegments: [],
                        applied: child.applied ?? true,
                        restoreAllowed: child.restoreAllowed === false ? false : true,
                        collapsed: child.collapsed !== false,
                        createdAt: typeof child.createdAt === 'number' ? child.createdAt : Date.now()
                    });
                    upsertUndoPlaceholder(session, child.noticeKey, child.anchorMsgId, child.endMsgId, child.applied ?? true);
                    vscode.postMessage({
                        type: 'undoSegmentUpsert',
                        sessionId,
                        segment: {
                            noticeKey: child.noticeKey,
                            anchorMsgId: child.anchorMsgId,
                            endMsgId: child.endMsgId,
                            memberMsgIds: Array.isArray(child.memberMsgIds) ? child.memberMsgIds : [],
                            mergedInvalidSegments: [],
                            applied: child.applied ?? true,
                            restoreAllowed: child.restoreAllowed === false ? false : true,
                            collapsed: child.collapsed !== false,
                            updatedAt: Date.now()
                        }
                    });
                }

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
                        `didReplace=${didReplace}`,
                        `restoredInvalidCount=${mergedInvalidSegments.length}`]
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
            case 'questionOverlay': {
                showQuestionOverlay(message);
                break;
            }
            case 'questionOverlayClose': {
                clearQuestionOverlay('external-close');
                scheduleRenderFromState('question-overlay-close');
                break;
            }
            case 'permissionOverlay': {
                showPermissionOverlay(message);
                break;
            }
            case 'permissionOverlayClose': {
                clearPermissionOverlay('external-close');
                break;
            }
            case 'permissionResultAck': {
                clearPermissionOverlay('result-ack');
                break;
            }
            case 'permissionResultFailed': {
                if (permissionOverlayState) {
                    permissionOverlayState.pending = false;
                    permissionOverlayState.error = typeof message.reason === 'string' ? message.reason : 'Permission response failed.';
                    renderPermissionOverlayModal();
                }
                break;
            }
            case 'conflictCard': {
                lastConflictPayload = message;
                suspendUndoTimeoutForConflictCard(message);
                window.__oc?.renderFromState?.();
                scrollToBottom();
                break;
            }
            case 'newSession': {
                activeSessionId = message.sessionId || '';
                clearAppendInputForSessionChange(activeSessionId);
                clearQuestionOverlay('new-session');
                clearPermissionOverlay('new-session');
                baseSessionTitle = 'OpenCode: Chat';
                renderHeaderTitle();
                renderHeaderUsage();
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
            case 'segmentRestoreLock': {
                const sessionId = getEventSessionId(message, 'segmentRestoreLock');
                if (!sessionId) break;
                const reason = typeof message.reason === 'string' && message.reason ? message.reason : 'file-change-detected';
                discardAllSegments(sessionId, reason, selectedMode || 'unknown');
                window.__oc?.renderFromState?.();
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
                if (message.type && !['pong', 'webviewReadyAck', 'webviewLivenessPing'].includes(message.type)) {
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
    const conflictOwner = {
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
        operationId: typeof payload.operationId === 'string' ? payload.operationId : '',
        conflictId: typeof payload.conflictId === 'string' ? payload.conflictId : '',
        kind: typeof payload.kind === 'string' ? payload.kind : '',
        source: typeof payload.source === 'string' ? payload.source : '',
        startMessageId: typeof payload.startMessageId === 'string' ? payload.startMessageId : undefined,
        endMessageId: typeof payload.endMessageId === 'string' ? payload.endMessageId : undefined,
        noticeKey: typeof payload.noticeKey === 'string' ? payload.noticeKey : undefined
    };
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][CONFLICT_RENDER]', `sessionId=${conflictOwner.sessionId || 'null'}`, `opId=${conflictOwner.operationId || 'null'}`, `conflictId=${conflictOwner.conflictId || 'null'}`, `kind=${conflictOwner.kind || 'null'}`, `source=${conflictOwner.source || 'null'}`]
    });
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
        vscode.postMessage({
            type: 'conflictDecision',
            decision: 'skip',
            sessionId: conflictOwner.sessionId,
            operationId: conflictOwner.operationId,
            conflictId: conflictOwner.conflictId,
            kind: conflictOwner.kind,
            source: conflictOwner.source,
            startMessageId: conflictOwner.startMessageId,
            endMessageId: conflictOwner.endMessageId,
            noticeKey: conflictOwner.noticeKey
        });
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
            sessionId: conflictOwner.sessionId,
            operationId: conflictOwner.operationId,
            conflictId: conflictOwner.conflictId,
            kind: conflictOwner.kind,
            source: conflictOwner.source,
            startMessageId: conflictOwner.startMessageId,
            endMessageId: conflictOwner.endMessageId,
            noticeKey: conflictOwner.noticeKey
        });
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(continueBtn);
    container.appendChild(actions);

    chatContainer.appendChild(container);
    conflictCardEl = container;
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function commitCurrentQuestionAnswers(answersForCurrent) {
    if (!questionOverlayState) return;
    const stepIndex = questionOverlayState.stepIndex || 0;
    const questions = Array.isArray(questionOverlayState.questions) ? questionOverlayState.questions : [];
    const nextAnswers = Array.isArray(questionOverlayState.answers) ? questionOverlayState.answers.slice() : [];
    nextAnswers[stepIndex] = Array.isArray(answersForCurrent) ? answersForCurrent.slice() : [];
    if (stepIndex + 1 < questions.length) {
        questionOverlayState.stepIndex = stepIndex + 1;
        questionOverlayState.answers = nextAnswers;
        questionOverlayState.selected = [];
        renderQuestionOverlayModal();
        return;
    }
    const callId = questionOverlayState.callId;
    const requestId = questionOverlayState.requestId;
    const sessionId = questionOverlayState.sessionId;
    if (!callId || sentQuestionCallIds.has(callId)) return;
    sentQuestionCallIds.add(callId);
    const allAnswers = nextAnswers.map((entry) => Array.isArray(entry) ? entry : []);
    const result = {
        selectedId: allAnswers[0]?.[0] || undefined,
        selectedLabel: allAnswers[0]?.[0] || undefined,
        answers: allAnswers
    };
    if (questionOverlayState.localOnly) {
        vscode.postMessage({
            type: 'localQuestionResult',
            sessionId,
            callId,
            result
        });
    } else {
        vscode.postMessage({
            type: 'toolResult',
            sessionId,
            callId,
            requestId: requestId || undefined,
            toolName: 'question',
            result
        });
    }
    clearQuestionOverlay('selected', true);
}

function renderQuestionCardInTimeline() {
    // Intentionally empty: question card now uses an inline pinned panel near the composer.
}

function applyQuestionOptionWidth(actionsEl, options) {
    if (!actionsEl) return;
    const layoutClasses = [
        'question-card-actions-measuring',
        'question-card-actions-row',
        'question-card-actions-column-compact',
        'question-card-actions-column-full'
    ];
    if (actionsEl.classList.contains('permission-card-actions')) {
        actionsEl.classList.remove(...layoutClasses);
        actionsEl.style.removeProperty('--question-option-width');
        return;
    }
    actionsEl.classList.remove(...layoutClasses);
    actionsEl.classList.add('question-card-actions-measuring');
    actionsEl.style.removeProperty('--question-option-width');

    const measure = () => {
        if (!actionsEl.isConnected) return;
        const optionButtons = Array.from(actionsEl.querySelectorAll('.question-card-btn:not(.question-card-submit)'));
        if (!optionButtons.length) {
            actionsEl.classList.remove('question-card-actions-measuring');
            actionsEl.classList.add('question-card-actions-column-full');
            actionsEl.style.setProperty('--question-option-width', '100%');
            return;
        }

        const availableWidth = Math.floor(actionsEl.clientWidth || actionsEl.getBoundingClientRect().width || 0);
        const styles = window.getComputedStyle(actionsEl);
        const parsedGap = Number.parseFloat(styles.columnGap || styles.gap || '0');
        const gap = Number.isFinite(parsedGap) ? parsedGap : 0;
        const naturalWidths = optionButtons.map((button) => {
            const previous = {
                width: button.style.width,
                minWidth: button.style.minWidth,
                maxWidth: button.style.maxWidth,
                flex: button.style.flex,
                whiteSpace: button.style.whiteSpace
            };
            button.style.width = 'auto';
            button.style.minWidth = '0';
            button.style.maxWidth = 'none';
            button.style.flex = '0 0 auto';
            button.style.whiteSpace = 'nowrap';
            const width = Math.ceil(button.getBoundingClientRect().width || button.scrollWidth || 0);
            button.style.width = previous.width;
            button.style.minWidth = previous.minWidth;
            button.style.maxWidth = previous.maxWidth;
            button.style.flex = previous.flex;
            button.style.whiteSpace = previous.whiteSpace;
            return width;
        });
        const optionWidth = Math.max(...naturalWidths, 0);
        const totalRowWidth = (optionWidth * optionButtons.length) + (gap * Math.max(0, optionButtons.length - 1));
        const compactColumnMaxWidth = Math.min(360, availableWidth * 0.72);
        const canUseRow = availableWidth > 0 && totalRowWidth <= availableWidth;
        const canUseCompactColumn = availableWidth > 0 && optionWidth <= compactColumnMaxWidth;
        const layoutClass = canUseRow
            ? 'question-card-actions-row'
            : (canUseCompactColumn ? 'question-card-actions-column-compact' : 'question-card-actions-column-full');

        actionsEl.classList.remove('question-card-actions-measuring');
        actionsEl.classList.add(layoutClass);
        actionsEl.style.setProperty('--question-option-width', layoutClass === 'question-card-actions-column-full' ? '100%' : `${optionWidth}px`);
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(measure);
    } else {
        setTimeout(measure, 0);
    }
}

function renderQuestionOverlayModal() {
    if (!questionOverlayState) return;
    const state = questionOverlayState;
    if (state.sessionId && activeSessionId && state.sessionId !== activeSessionId) return;
    const questions = Array.isArray(state.questions) ? state.questions : [];
    const stepIndex = Number.isFinite(state.stepIndex) ? state.stepIndex : 0;
    const current = questions[stepIndex];
    if (!current) {
        clearQuestionOverlay('invalid-state', true);
        return;
    }

    if (questionOverlayEl && questionOverlayEl.parentElement) {
        questionOverlayEl.parentElement.removeChild(questionOverlayEl);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'question-panel';

    const card = document.createElement('div');
    card.className = 'conflict-card question-card question-panel-card';

    const header = document.createElement('div');
    header.className = 'conflict-card-header';
    header.textContent = current.title;
    card.appendChild(header);

    const prompt = document.createElement('div');
    prompt.className = 'question-card-question';
    renderAssistantMarkdown(prompt, {
        role: 'assistant',
        text: current.prompt || '',
        meta: { isThinking: false }
    });
    prompt.classList.add('markdown-body');
    card.appendChild(prompt);

    const actions = document.createElement('div');
    actions.className = 'question-card-actions';
    applyQuestionOptionWidth(actions, current.options || []);

    const selected = new Set(Array.isArray(state.selected) ? state.selected : []);
    for (const option of current.options || []) {
        const optionLabel = typeof option?.label === 'string' ? option.label : '';
        if (!optionLabel) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conflict-card-btn question-card-btn';
        if (selected.has(optionLabel)) {
            button.classList.add('active');
        }
        button.textContent = optionLabel;
        button.addEventListener('click', () => {
            if (current.multiple) {
                const currentSelected = new Set(Array.isArray(questionOverlayState?.selected) ? questionOverlayState.selected : []);
                if (currentSelected.has(optionLabel)) {
                    currentSelected.delete(optionLabel);
                } else {
                    currentSelected.add(optionLabel);
                }
                if (questionOverlayState) {
                    questionOverlayState.selected = Array.from(currentSelected);
                }
                renderQuestionOverlayModal();
                return;
            }
            const buttons = card.querySelectorAll('button.question-card-btn,button.question-card-submit');
            for (const btn of buttons) btn.disabled = true;
            commitCurrentQuestionAnswers([optionLabel]);
        });
        actions.appendChild(button);
    }

    if (current.multiple) {
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'conflict-card-btn question-card-btn question-card-submit';
        submit.textContent = 'Submit';
        if (!selected.size) {
            submit.disabled = true;
        }
        submit.addEventListener('click', () => {
            const currentSelected = Array.isArray(questionOverlayState?.selected) ? questionOverlayState.selected : [];
            if (!currentSelected.length) return;
            const buttons = card.querySelectorAll('button.question-card-btn,button.question-card-submit');
            for (const btn of buttons) btn.disabled = true;
            commitCurrentQuestionAnswers(currentSelected);
        });
        actions.appendChild(submit);
    }

    // Add free-text textarea input
    const freeTextRow = document.createElement('div');
    freeTextRow.className = 'question-free-text-row';
    const textarea = document.createElement('textarea');
    textarea.className = 'question-free-text-input';
    textarea.placeholder = 'Or type your answer...';
    textarea.rows = 1;
    
    // Auto-expand textarea up to 3 rows
    textarea.addEventListener('input', () => {
        const lines = (textarea.value.match(/\n/g) || []).length + 1;
        textarea.rows = Math.min(lines, 3);
    });
    
    // Handle Enter key to submit, Shift+Enter for newline
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = textarea.value.trim();
            if (text) {
                const buttons = card.querySelectorAll('button.question-card-btn,button.question-card-submit');
                for (const btn of buttons) btn.disabled = true;
                commitCurrentQuestionAnswers([text]);
            }
            return;
        }
    });
    
    freeTextRow.appendChild(textarea);
    actions.appendChild(freeTextRow);


    card.appendChild(actions);
    wrapper.appendChild(card);

    const inputContainer = document.querySelector('.input-container');
    if (inputContainer && inputContainer.parentElement) {
        inputContainer.parentElement.insertBefore(wrapper, inputContainer);
    } else {
        document.body.appendChild(wrapper);
    }
    questionOverlayEl = wrapper;
}

function renderPermissionOverlayModal() {
    if (!permissionOverlayState) return;
    const state = permissionOverlayState;
    if (state.sessionId && activeSessionId && state.sessionId !== activeSessionId) return;

    if (permissionOverlayEl && permissionOverlayEl.parentElement) {
        permissionOverlayEl.parentElement.removeChild(permissionOverlayEl);
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'question-overlay';

    const backdrop = document.createElement('div');
    backdrop.className = 'question-overlay-backdrop';
    wrapper.appendChild(backdrop);

    const card = document.createElement('div');
    card.className = 'conflict-card question-card question-overlay-card';

    const header = document.createElement('div');
    header.className = 'conflict-card-header';
    header.textContent = 'Permission required';
    card.appendChild(header);

    const prompt = document.createElement('div');
    prompt.className = 'question-card-question';
    const permissionText = typeof state.permission === 'string' && state.permission.length
        ? state.permission
        : 'The agent requests permission to continue.';
    prompt.textContent = permissionText;
    card.appendChild(prompt);

    if (Array.isArray(state.patterns) && state.patterns.length) {
        const detail = document.createElement('div');
        detail.className = 'question-card-question';
        detail.textContent = `Patterns: ${state.patterns.join(', ')}`;
        card.appendChild(detail);
    }

    if (typeof state.error === 'string' && state.error.length) {
        const errorText = document.createElement('div');
        errorText.className = 'question-card-question';
        errorText.style.color = '#ff6b6b';
        errorText.textContent = state.error;
        card.appendChild(errorText);
    }

    const actions = document.createElement('div');
    actions.className = 'question-card-actions permission-card-actions';
    const options = [
        { label: 'once', value: 'once' },
        { label: 'always', value: 'always' },
        { label: 'reject', value: 'reject' }
    ];
    applyQuestionOptionWidth(actions, options);

    for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conflict-card-btn question-card-btn';
        button.textContent = option.label;
        if (state.pending) {
            button.disabled = true;
        }
        button.addEventListener('click', () => {
            if (!permissionOverlayState || permissionOverlayState.pending) return;
            permissionOverlayState.pending = true;
            permissionOverlayState.error = '';
            renderPermissionOverlayModal();
            vscode.postMessage({
                type: 'permissionResult',
                sessionId: state.sessionId,
                permissionId: state.permissionId,
                requestId: state.requestId,
                response: option.value
            });
        });
        actions.appendChild(button);
    }

    card.appendChild(actions);
    wrapper.appendChild(card);
    document.body.appendChild(wrapper);
    permissionOverlayEl = wrapper;
}

function clearQuestionOverlay(reason, advanceQueue = false) {
    if (questionOverlayTimer) {
        clearTimeout(questionOverlayTimer);
        questionOverlayTimer = null;
    }
    if (questionOverlayEl && questionOverlayEl.parentElement) {
        questionOverlayEl.parentElement.removeChild(questionOverlayEl);
    }
    questionOverlayEl = null;
    questionOverlayState = null;
    if (reason === 'session-change' || reason === 'new-session' || reason === 'external-close') {
        questionOverlayQueue.length = 0;
    }
    if (advanceQueue && questionOverlayQueue.length) {
        const nextPayload = questionOverlayQueue.shift();
        if (nextPayload) {
            questionOverlayState = {
                sessionId: nextPayload.sessionId,
                callId: nextPayload.callId,
                requestId: nextPayload.requestId || undefined,
                localOnly: nextPayload.localOnly === true,
                questions: nextPayload.questions,
                stepIndex: 0,
                answers: [],
                selected: []
            };
            renderQuestionOverlayModal();
        }
    }
}

function clearPermissionOverlay(reason) {
    if (permissionOverlayEl && permissionOverlayEl.parentElement) {
        permissionOverlayEl.parentElement.removeChild(permissionOverlayEl);
    }
    permissionOverlayEl = null;
    permissionOverlayState = null;
}

function logQuestionDebug(...parts) {
    vscode.postMessage({ type: 'ui-debug', payload: ['question', ...parts] });
}

function normalizeQuestionItems(payload) {
    const raw = Array.isArray(payload?.questions) && payload.questions.length
        ? payload.questions
        : [{ title: payload?.title, prompt: payload?.prompt, options: payload?.options, multiple: false }];
    const normalized = [];
    for (const item of raw) {
        const title = typeof item?.title === 'string' ? item.title : '';
        const prompt = typeof item?.prompt === 'string' ? item.prompt : '';
        const options = Array.isArray(item?.options) ? item.options : [];
        const multiple = item?.multiple === true;
        if (!title || !prompt || !options.length) continue;
        const normalizedOptions = [];
        for (const option of options) {
            const id = typeof option?.id === 'string' ? option.id : '';
            const label = typeof option?.label === 'string' ? option.label : '';
            if (!id || !label) continue;
            normalizedOptions.push({ id, label });
        }
        if (!normalizedOptions.length) continue;
        normalized.push({ title, prompt, options: normalizedOptions, multiple });
    }
    return normalized;
}

function showQuestionOverlay(payload) {
    if (!payload || typeof payload !== 'object') {
        logQuestionDebug('show.skip', 'reason=bad-payload');
        return;
    }
    const sessionId = payload.sessionId || activeSessionId || '';
    if (payload.sessionId && activeSessionId && payload.sessionId !== activeSessionId) {
        logQuestionDebug('show.skip', `reason=session-mismatch payload=${payload.sessionId} active=${activeSessionId}`);
        return;
    }
    const callId = typeof payload.callId === 'string' ? payload.callId : '';
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const questionItems = normalizeQuestionItems(payload);
    if (!sessionId || !callId || !questionItems.length) {
        logQuestionDebug('show.skip', `reason=missing-fields session=${sessionId || 'none'} callId=${callId || 'none'} questions=${questionItems.length}`);
        return;
    }
    const dedupeKey = `${sessionId}|${callId}`;
    if (shownQuestionCallIds.has(dedupeKey)) {
        logQuestionDebug('show.skip', `reason=dedupe key=${dedupeKey}`);
        return;
    }
    if (shownQuestionCallIds.size > 2000) {
        shownQuestionCallIds.clear();
    }
    if (sentQuestionCallIds.size > 2000) {
        sentQuestionCallIds.clear();
    }

    const normalizedPayload = {
        ...payload,
        sessionId,
        callId,
        requestId: requestId || undefined,
        questions: questionItems
    };

    if (questionOverlayState) {
        if (questionOverlayQueue.some((item) => item && item.callId === callId && item.sessionId === sessionId) || (questionOverlayState.callId === callId && questionOverlayState.sessionId === sessionId)) {
            logQuestionDebug('show.skip', `reason=already-present callId=${callId}`);
            return;
        }
        questionOverlayQueue.push(normalizedPayload);
        logQuestionDebug('show.queued', `callId=${callId}`, `queueSize=${questionOverlayQueue.length}`);
        return;
    }

    clearQuestionOverlay('replace');
    shownQuestionCallIds.add(dedupeKey);
    questionOverlayState = {
        sessionId,
        callId,
        requestId: requestId || undefined,
        localOnly: payload.localOnly === true,
        questions: questionItems,
        stepIndex: 0,
        answers: [],
        selected: []
    };
    logQuestionDebug('show.active', `callId=${callId}`, `questions=${questionItems.length}`);
    renderQuestionOverlayModal();
}

function showPermissionOverlay(payload) {
    if (!payload || typeof payload !== 'object') {
        return;
    }
    const sessionId = payload.sessionId || activeSessionId || '';
    if (payload.sessionId && activeSessionId && payload.sessionId !== activeSessionId) {
        return;
    }
    const permissionId = typeof payload.permissionId === 'string' ? payload.permissionId : '';
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const permission = typeof payload.permission === 'string' ? payload.permission : '';
    const patterns = Array.isArray(payload.patterns)
        ? payload.patterns.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
    if (!sessionId || !(permissionId || requestId)) {
        return;
    }

    if (
        permissionOverlayState
        && permissionOverlayState.sessionId === sessionId
        && permissionOverlayState.permissionId === (permissionId || requestId)
    ) {
        return;
    }

    clearPermissionOverlay('replace');
    permissionOverlayState = {
        sessionId,
        permissionId: permissionId || requestId,
        requestId: requestId || permissionId || '',
        permission,
        patterns,
        pending: false,
        error: ''
    };
    renderPermissionOverlayModal();
}

