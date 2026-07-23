const vscode = acquireVsCodeApi();
const B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED = window.__ocChatWindowAdaptiveShadowTestConfig?.syntheticEnvironment === true;
const CF3_RANGE_DIAG_MARKER = 'CF3_RANGE_DIAG_V1';
const CF3_RANGE_DIAG_SOURCE_TOKEN = 'cf3-main-range-v1';
const cf3RangeDiagnosticState = {
    phase: 'async-core', sync: 'unknown', rangeCount: 0, rangeSignatures: new Set(), markerEmitted: false
};

function emitCF3RangeDiagnosticMarker() {
    if (cf3RangeDiagnosticState.markerEmitted) return;
    cf3RangeDiagnosticState.markerEmitted = true;
    vscode.postMessage({
        type: 'ui-debug', payload: [CF3_RANGE_DIAG_MARKER, { sourceToken: CF3_RANGE_DIAG_SOURCE_TOKEN }]
    });
}

function runCF3RangeDiagnosticPhase(phase, operation) {
    const priorPhase = cf3RangeDiagnosticState.phase;
    const priorSync = cf3RangeDiagnosticState.sync;
    cf3RangeDiagnosticState.phase = phase;
    cf3RangeDiagnosticState.sync = true;
    try {
        return operation();
    } finally {
        cf3RangeDiagnosticState.sync = false;
        cf3RangeDiagnosticState.phase = priorPhase;
        cf3RangeDiagnosticState.sync = priorSync;
    }
}

function getCF3RangeFirstDifference(snapshot, acknowledged) {
    try {
        if (!acknowledged) return 'missing-ack';
        const rawItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const acknowledgedItems = Array.isArray(acknowledged?.items) ? acknowledged.items : [];
        if (rawItems.length !== acknowledgedItems.length) return 'count';
        for (let index = 0; index < rawItems.length; index += 1) {
            const raw = rawItems[index];
            const prior = acknowledgedItems[index];
            if (raw?.key !== prior?.key) return 'key';
            if (raw?.index !== prior?.index) return 'index';
            if (raw?.start !== prior?.start) return 'start';
            if (raw?.end !== prior?.end) return 'end';
            if (raw?.size !== prior?.size) return 'size';
        }
        if (snapshot?.totalSize !== acknowledged?.totalSize) return 'totalSize';
        return 'none';
    } catch {
        return 'missing-ack';
    }
}

function recordCF3RangeDiagnostic(snapshot, diagnosticContext) {
    try {
        const context = diagnosticContext && typeof diagnosticContext === 'object' ? diagnosticContext : null;
        const phase = ['initial-create', 'established-update', 'transaction-finalize', 'async-core'].includes(cf3RangeDiagnosticState.phase)
            ? cf3RangeDiagnosticState.phase : 'async-core';
        const sync = cf3RangeDiagnosticState.sync === true || cf3RangeDiagnosticState.sync === false
            ? cf3RangeDiagnosticState.sync : 'unknown';
        const allowedDifferences = ['missing-ack', 'count', 'key', 'index', 'start', 'end', 'size', 'totalSize', 'none'];
        const firstDifference = allowedDifferences.includes(context?.firstDifference)
            ? context.firstDifference : 'missing-ack';
        cf3RangeDiagnosticState.rangeCount += 1;
        const signature = `${phase}|${String(sync)}|${firstDifference}`;
        const firstSignature = !cf3RangeDiagnosticState.rangeSignatures.has(signature);
        cf3RangeDiagnosticState.rangeSignatures.add(signature);
        if (cf3RangeDiagnosticState.rangeCount > 20
            && cf3RangeDiagnosticState.rangeCount % 50 !== 0
            && !firstSignature) return;
        const rawItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
        const diagnostic = Object.freeze({
            phase,
            sync,
            rendering: context?.rendering === true,
            pendingRangeRender: context?.pendingRangeRender === true,
            pendingScrollPresent: context?.pendingScrollPresent === true,
            programmaticScroll: context?.programmaticScroll === true,
            rawCount: rawItems.length,
            rawTotalSize: Number.isFinite(snapshot?.totalSize) ? Number(snapshot.totalSize) : 0,
            acknowledgedCount: Number.isSafeInteger(context?.acknowledgedCount) && context.acknowledgedCount >= 0
                ? Number(context.acknowledgedCount) : 0,
            acknowledgedTotalSize: Number.isFinite(context?.acknowledgedTotalSize)
                ? Number(context.acknowledgedTotalSize) : 0,
            firstDifference,
            scrollTop: Number.isFinite(context?.scrollTop) ? Number(context.scrollTop) : 0,
            adapterOffsetAvailable: false,
            adapterOffset: 'unavailable'
        });
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][CF3_RANGE_DIAG]', diagnostic] });
    } catch { /* diagnostic-only path must not affect range ownership */ }
}

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

let sessions = [];
let modes = ['plan', 'build'];
let selectedMode = 'plan';
let activeSessionId = '';
let isBusy = false;
let busySessionId = '';
let attachmentStateController = null;
let messageCounter = 0;
let modelStateController = null;
let simpleDropdownHandlers = new Map();
const subagentTextExpandedByKey = new Map();
let rekeyKeyedChatPresentation = null;
let conflictCardEl = null;
let conflictShellPresentationGeneration = 0;
let stallCardEl = null;
let lastConflictPayload = null;
let questionOverlayEl = null;
let questionOverlayTimer = null;
let questionOverlayState = null;
let quoteSelectionButton = null;
let quoteSelectionText = '';
const createSessionSearchState = window.__ocFeatures?.createSessionSearchState;
if (typeof createSessionSearchState !== 'function') {
    throw new Error('Session search state is unavailable');
}
let sessionSearch = createSessionSearchState();
const createSessionSearchDomController = window.__ocFeatures?.createSessionSearchDomController;
if (typeof createSessionSearchDomController !== 'function') {
    throw new Error('Session search DOM controller is unavailable');
}
const sessionSearchDomController = createSessionSearchDomController({
    document,
    state: sessionSearch,
    onManualScroll: () => { autoScrollPinnedToBottom = false; },
    collectTextMatchKeys: (query) => collectLoadedTextSearchKeys(query),
    ensureKeyMounted: (key) => ensureChatWindowKeyMounted(key, 'search')
});
const createSmartSearchRequestController = window.__ocFeatures?.createSmartSearchRequestController;
if (typeof createSmartSearchRequestController !== 'function') {
    throw new Error('Smart Search request controller is unavailable');
}
const smartSearchRequestController = createSmartSearchRequestController({
    state: sessionSearch,
    clearHighlights: () => clearSessionSearchHighlights(),
    updateControls: () => updateSessionSearchControls(),
    collectMessages: () => collectSmartSearchMessages(),
    getSessionId: () => activeSessionId || '',
    postMessage: (message) => vscode.postMessage(message),
    createRequestId: () => `smart-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
});
const createSessionSearchInteractionController = window.__ocFeatures?.createSessionSearchInteractionController;
if (typeof createSessionSearchInteractionController !== 'function') {
    throw new Error('Session search interaction controller is unavailable');
}
const sessionSearchInteractionController = createSessionSearchInteractionController({
    state: sessionSearch,
    dom: sessionSearchDomController,
    refresh: (options) => refreshSessionSearchHighlights(options),
    navigate: (delta) => goToSessionSearchMatch(delta),
    runSmart: () => smartSearchRequestController.run(),
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle)
});
const createChangeListRenderer = window.__ocFeatures?.createChangeListRenderer;
if (typeof createChangeListRenderer !== 'function') {
    throw new Error('Change list renderer is unavailable');
}
const changeListRenderer = createChangeListRenderer({
    document,
    getSessionId: () => activeSessionId,
    openFile: (path, sessionId) => vscode.postMessage({ type: 'openFileAtLocation', path, sessionId: sessionId || null }),
    openDiff: (path, sessionId, commitHead, commitBase) => postOpenGitDiff(path, sessionId, commitHead, commitBase)
});
const createChangeListEventController = window.__ocFeatures?.createChangeListEventController;
if (typeof createChangeListEventController !== 'function') {
    throw new Error('Change list event controller is unavailable');
}
const changeListEventController = createChangeListEventController({
    getSession: (sessionId, create) => getSessionState(sessionId, create),
    discardAllSegments: (sessionId, reason, mode) => discardAllSegments(sessionId, reason, mode),
    toStableMessageKey: (session, messageId) => toStableMessageKey(session, messageId),
    upsertMessage: (session, message) => upsertMessage(session, message),
    placeMessageAfterAnchor: (session, messageId, anchorMessageId, reason) => placeMessageAfterAnchor(session, messageId, anchorMessageId, reason),
    renderIfActive: (sessionId, reason, options) => renderIfActive(sessionId, reason, options),
    postDebug: (payload) => vscode.postMessage({ type: 'ui-debug', payload }),
    now: () => Date.now()
});
const planChangeListMaterialization = window.__ocFeatures?.planChangeListMaterialization;
if (typeof planChangeListMaterialization !== 'function') {
    throw new Error('Change list materialization planner is unavailable');
}
const createSegmentTopology = window.__ocUndo?.createSegmentTopology;
if (typeof createSegmentTopology !== 'function') {
    throw new Error('Segment topology is unavailable');
}
const segmentTopology = createSegmentTopology({
    debug: (payload) => vscode.postMessage({ type: 'ui-debug', payload }),
    now: () => Date.now()
});
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

const sessionStore = window.__ocContinuation.createSessionStore();
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
let inputEl = null;
let appendInputMode = null;
let appendHoverActiveKey = null;
let appendHoverHideTimer = null;
let inputDefaultPlaceholder = 'Ask anything...';
const pendingUiPrompts = [];
let composerContextStateController = null;
let sendBlockedNotice = '';
let systemNoticeText = '';
let headerStateController = null;
let headerUiController = null;
let textMeasureCanvas = null;
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
    if (getHeaderStateController().isCompacting(sessionId)) return true;
    const session = getSessionState(sessionId);
    return isSendBlockedByPendingState(session);
}

function renderHeaderTitle() {
    headerUiController?.renderTitle();
}

function getSelectedModelContextLimit() {
    return getModelStateController().getContextLimit();
}

function recomputeSessionUsageFromMessages(session) {
    if (!session?.messagesById) return null;
    return window.__ocFeatures?.recomputeSessionUsage?.(session.messagesById.values()) || null;
}

function renderHeaderUsage() {
    headerUiController?.renderUsage();
}

function setHeaderWaitingState(waiting) {
    getHeaderStateController().setWaiting(waiting);
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
        getHeaderStateController().setStatusText(BASELINE_PREPARING_NOTICE);
    } else {
        getHeaderStateController().setStatusText(sendBlockedNotice ? 'Waiting for previous response...' : '');
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
    return sessionStore.createState();
}

function normalizePayloadHydrationCoverage(value) {
    if (
        value === 'authoritativeHistoryComplete' ||
        value === 'deltaContinuityUnknown' ||
        value === 'repairInProgress' ||
        value === 'repairError'
    ) return value;
    return 'deltaContinuityUnknown';
}

function isActiveSessionHistoryLoading() {
    if (!activeSessionId || hydratedSessions.has(activeSessionId)) return false;
    const session = getSessionState(activeSessionId, false);
    return !session || !Array.isArray(session.timeline) || session.timeline.length === 0;
}

function applyPayloadHydrationCoverage(sessionId, message) {
    const session = getSessionState(sessionId, false);
    if (!session) return false;
    session.hydrationCoverage = normalizePayloadHydrationCoverage(message?.meta?.hydrationCoverage);
    return true;
}

function handleStandaloneHydrationCoverage(message) {
    const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : '';
    if (!sessionId) return false;
    const updated = applyPayloadHydrationCoverage(sessionId, {
        meta: { hydrationCoverage: message?.hydrationCoverage }
    });
    if (!updated) return false;
    renderIfActive(sessionId, 'hydrationCoverage');
    return true;
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
    return sessionStore.get(sessionId, create);
}

const hydrationStateController = window.__ocContinuation.createHydrationStateController({
    toStableMessageKey,
    now: () => Date.now()
});

function cloneSessionMap(value) {
    return hydrationStateController.cloneMap(value);
}

function cloneSessionSet(value) {
    return hydrationStateController.cloneSet(value);
}

function clonePlainSessionValue(value) {
    return hydrationStateController.clonePlainValue(value);
}

function cloneMessageForHydrationPreserve(message) {
    return hydrationStateController.cloneMessage(message);
}

function isHydrationPersistenceArtifact(id, message) {
    return hydrationStateController.isPersistenceArtifact(id, message);
}

function findMappedHydrationMsgId(map, key, matchValue = false) {
    return hydrationStateController.findMappedMessageId(map, key, matchValue);
}

function resolvePreservedHydrationCanonicalId(session, preserved, id, message) {
    return hydrationStateController.resolveCanonicalId(session, preserved, id, message);
}

function captureVolatileHydrationState(session) {
    return hydrationStateController.capture(session);
}

function restoreVolatileHydrationState(session, preserved) {
    return hydrationStateController.restore(session, preserved);
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
const STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON = 'status-post-pending-reconcile';
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_WINDOW_MS = 5000;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_LIMIT = 20;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS = 30000;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_LIMIT = 100;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_IDLE_RESET_MS = 10000;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_RENDER_RESET_COOLDOWN_MS = 1200;
const UNCLEAR_ANCHOR_CIRCUIT_BREAKER_OPEN_COOLDOWN_MS = 5000;
const SESSION_METADATA_RENDER_INTERVAL_MS = 250;
const unclearAnchorCircuitBreakers = new Map();
const pendingStatusOnlyCoalescedByKey = new Map();
const renderStormCounters = {
    fullRenderRequestsByReason: Object.create(null),
    suppressedFallbackRenderRequestsByReason: Object.create(null),
    backgroundIndicatorApplyResults: Object.create(null),
    localPatchFailedByReason: Object.create(null),
    assistantUpgradeFallbackResults: Object.create(null),
    userAppendFastPathResults: Object.create(null),
    userAppendFastPathBailReasons: Object.create(null),
    assistantStreamingPatchResults: Object.create(null),
    assistantStreamingPatchBailReasons: Object.create(null),
    statusOnlyCoalescedByKey: Object.create(null),
    backgroundPulseNoopByKey: Object.create(null),
    backgroundPulseRenderAvoidedByKey: Object.create(null)
};
const webviewAutoRescueProcessedAttemptIds = new Set();

const CHAT_RENDER_METRICS_SCHEMA_VERSION = 1;
const CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS = 30000;
const CHAT_RENDER_WARNING_INTERVAL_MS = 30000;
const CHAT_RENDER_DIRECT_CHILD_WARNING_THRESHOLD = 160;
const CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD = 4000;
let chatRenderMetricsEnabled = null;
let chatRenderMetricsDirty = false;
let chatRenderMetricsSummaryTimer = null;
let chatRenderLongTaskObserver = null;
let chatRenderDomObserver = null;
let chatRenderPendingFullRenderStartedAt = null;
let chatRenderPendingProjectionStartedAt = null;
const chatRenderWarningState = {
    directChildren: { lastAt: 0, suppressed: 0 },
    descendants: { lastAt: 0, suppressed: 0 }
};
const chatRenderMetrics = {
    schemaVersion: CHAT_RENDER_METRICS_SCHEMA_VERSION,
    phases: {
        projection: { count: 0, totalMs: 0, maxMs: 0 },
        fullRender: { count: 0, totalMs: 0, maxMs: 0 },
        richEnhancement: { count: 0, totalMs: 0, maxMs: 0 },
        appendFastPath: { count: 0, totalMs: 0, maxMs: 0 },
        streamPatch: { count: 0, totalMs: 0, maxMs: 0 }
    },
    directChildren: { samples: 0, total: 0, max: 0, last: 0 },
    descendants: { samples: 0, total: 0, max: 0, last: 0 },
    renderReasons: Object.create(null),
    pinnedState: { true: 0, false: 0 },
    timelineCount: { samples: 0, total: 0, max: 0, last: 0 },
    renderedCount: { samples: 0, total: 0, max: 0, last: 0 },
    scenarioBands: Object.fromEntries(['50', '200', '1000+'].map((key) => [key, 0])),
    longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    warnings: { directChildren: 0, descendants: 0 },
    pressureAttribution: null
};

function isChatRenderMetricsEnabled() {
    if (chatRenderMetricsEnabled !== null) return chatRenderMetricsEnabled;
    try {
        chatRenderMetricsEnabled = window.__ocChatRenderMetricsEnabled === true
            || localStorage.getItem('oc_chat_render_metrics') === '1';
    } catch {
        chatRenderMetricsEnabled = false;
    }
    return chatRenderMetricsEnabled;
}

function getChatRenderMetricTime() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function startChatRenderPhase() {
    return isChatRenderMetricsEnabled() ? getChatRenderMetricTime() : null;
}

function finishChatRenderPhase(phase, startedAt) {
    if (startedAt === null || !isChatRenderMetricsEnabled()) return;
    const bucket = chatRenderMetrics.phases[phase];
    if (!bucket) return;
    const duration = Math.max(0, getChatRenderMetricTime() - startedAt);
    bucket.count += 1;
    bucket.totalMs += duration;
    bucket.maxMs = Math.max(bucket.maxMs, duration);
    chatRenderMetricsDirty = true;
}

function recordChatRenderReason(reason) {
    if (!isChatRenderMetricsEnabled()) return;
    const key = typeof reason === 'string' && reason ? reason : 'unknown';
    chatRenderMetrics.renderReasons[key] = (chatRenderMetrics.renderReasons[key] || 0) + 1;
    chatRenderPendingFullRenderStartedAt = getChatRenderMetricTime();
    chatRenderPendingProjectionStartedAt = chatRenderPendingFullRenderStartedAt;
    chatRenderMetricsDirty = true;
}

function recordChatRenderScalar(bucket, value) {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    bucket.samples += 1;
    bucket.total += safeValue;
    bucket.max = Math.max(bucket.max, safeValue);
    bucket.last = safeValue;
}

function getChatRenderScenarioBand(timelineCount) {
    if (timelineCount <= 50) return '50';
    if (timelineCount <= 200) return '200';
    return '1000+';
}

function emitChatRenderPressureWarning(kind, value, threshold) {
    const now = Date.now();
    const state = chatRenderWarningState[kind];
    if (!state) return;
    if (now - state.lastAt < CHAT_RENDER_WARNING_INTERVAL_MS) {
        state.suppressed += 1;
        return;
    }
    const suppressed = state.suppressed;
    state.lastAt = now;
    state.suppressed = 0;
    chatRenderMetrics.warnings[kind] += 1;
    console.warn(`[OpenCode chat render pressure] ${kind}=${value} exceeds ${threshold}; suppressed=${suppressed}`);
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][CHAT_RENDER_PRESSURE]', `metric=${kind}`, `value=${value}`, `threshold=${threshold}`, `suppressed=${suppressed}`]
    });
}

function sampleChatRenderDom(chatContainer, audit = null) {
    if (!isChatRenderMetricsEnabled() || !chatContainer) return;
    const session = getSessionState(activeSessionId, false);
    const timelineCount = Array.isArray(session?.timeline) ? session.timeline.length : 0;
    const renderedCount = chatContainer.querySelectorAll('[data-message-id], [data-segment-key]').length;
    const directChildren = Number.isFinite(audit?.directChildren) ? Math.max(0, audit.directChildren) : chatContainer.childElementCount;
    const descendants = Number.isFinite(audit?.descendants) ? Math.max(0, audit.descendants) : chatContainer.querySelectorAll('*').length;
    const structuralIntegrityRoots = Array.isArray(audit?.structuralIntegrityRoots) ? audit.structuralIntegrityRoots : [];
    recordChatRenderScalar(chatRenderMetrics.timelineCount, timelineCount);
    recordChatRenderScalar(chatRenderMetrics.renderedCount, renderedCount);
    recordChatRenderScalar(chatRenderMetrics.directChildren, directChildren);
    recordChatRenderScalar(chatRenderMetrics.descendants, descendants);
    chatRenderMetrics.pinnedState[String(autoScrollPinnedToBottom === true)] += 1;
    chatRenderMetrics.scenarioBands[getChatRenderScenarioBand(timelineCount)] += 1;
    if (chatRenderPendingFullRenderStartedAt !== null) {
        finishChatRenderPhase('fullRender', chatRenderPendingFullRenderStartedAt);
        chatRenderPendingFullRenderStartedAt = null;
    }
    if (chatRenderPendingProjectionStartedAt !== null) {
        finishChatRenderPhase('projection', chatRenderPendingProjectionStartedAt);
        chatRenderPendingProjectionStartedAt = null;
    }
    if (directChildren > CHAT_RENDER_DIRECT_CHILD_WARNING_THRESHOLD) {
        emitChatRenderPressureWarning('directChildren', directChildren, CHAT_RENDER_DIRECT_CHILD_WARNING_THRESHOLD);
    }
    if (descendants > CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD) {
        emitChatRenderPressureWarning('descendants', descendants, CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD);
    }
    chatRenderMetricsDirty = true;
}

function emitChatRenderMetricsSummary() {
    if (!isChatRenderMetricsEnabled() || !chatRenderMetricsDirty) return;
    chatRenderMetricsDirty = false;
    vscode.postMessage({
        type: 'ui-debug',
        payload: ['[WV][CHAT_RENDER_METRICS]', JSON.stringify(chatRenderMetrics)]
    });
}

function installChatRenderMetrics(chatContainer) {
    if (!isChatRenderMetricsEnabled()) return;
    try {
        if (typeof MutationObserver === 'function' && chatContainer) {
            chatRenderDomObserver = new MutationObserver(() => { chatRenderMetricsDirty = true; });
            chatRenderDomObserver.observe(chatContainer, { childList: true, subtree: true });
        }
    } catch {
        chatRenderDomObserver = null;
    }
    try {
        const supportedEntryTypes = typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
            ? PerformanceObserver.supportedEntryTypes
            : [];
        if (supportedEntryTypes.includes('longtask')) {
            const observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const duration = Number.isFinite(entry.duration) ? Math.max(0, entry.duration) : 0;
                    chatRenderMetrics.longTasks.count += 1;
                    chatRenderMetrics.longTasks.totalMs += duration;
                    chatRenderMetrics.longTasks.maxMs = Math.max(chatRenderMetrics.longTasks.maxMs, duration);
                    chatRenderMetricsDirty = true;
                }
            });
            observer.observe({ type: 'longtask', buffered: true });
            chatRenderLongTaskObserver = observer;
        }
    } catch {
        chatRenderLongTaskObserver = null;
    }
    chatRenderMetricsSummaryTimer = setInterval(emitChatRenderMetricsSummary, CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS);
}

function disposeChatRenderMetrics() {
    try {
        chatRenderDomObserver?.disconnect();
        chatRenderLongTaskObserver?.disconnect();
    } catch {
        // Diagnostics disposal must never affect webview teardown.
    }
    chatRenderDomObserver = null;
    chatRenderLongTaskObserver = null;
    if (chatRenderMetricsSummaryTimer !== null) {
        clearInterval(chatRenderMetricsSummaryTimer);
        chatRenderMetricsSummaryTimer = null;
    }
}

window.__ocChatRenderMetrics = Object.freeze({
    snapshot: () => JSON.parse(JSON.stringify(chatRenderMetrics)),
    dispose: disposeChatRenderMetrics
});
if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', disposeChatRenderMetrics, { once: true });
}

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

function getUnclearAnchorCircuitBreakerKey(sessionId, source, reason) {
    return `${sessionId || 'null'}|${source || 'unknown'}|${reason || 'unknown'}`;
}

function getUnclearAnchorCircuitBreakerState(sessionId, source, reason) {
    const key = getUnclearAnchorCircuitBreakerKey(sessionId, source, reason);
    let state = unclearAnchorCircuitBreakers.get(key);
    if (!state) {
        state = {
            key,
            sessionId: sessionId || '',
            source: source || 'unknown',
            reason: reason || 'unknown',
            failures: [],
            open: false,
            openUntil: 0,
            coalescedRenderScheduled: false,
            lastCoalescedRenderAt: 0,
            resetTimer: null
        };
        unclearAnchorCircuitBreakers.set(key, state);
    }
    return state;
}

function isUnclearAnchorCircuitBreakerCurrentlyOpen(sessionId, source, reason) {
    if (reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')) {
        return false;
    }
    const key = getUnclearAnchorCircuitBreakerKey(sessionId, source, reason);
    const state = unclearAnchorCircuitBreakers.get(key);
    return Boolean(state?.open && Date.now() < state.openUntil);
}

function getPendingStatusOnlyCoalesceKey(sessionId, source, reason) {
    return `${sessionId || 'null'}|${source || 'unknown'}|${reason || 'unknown'}`;
}

function shouldLogPendingStatusOnlyCoalesce(state) {
    const count = state?.count || 0;
    return count <= 3 || count % 25 === 0;
}

function logPendingStatusOnlyCoalesce(marker, state, fields = []) {
    const key = state?.key || getPendingStatusOnlyCoalesceKey(state?.sessionId, state?.source, state?.reason);
    const total = incrementRenderStormCounter('statusOnlyCoalescedByKey', key);
    logRenderStormMetric(marker, [
        `sessionId=${state?.sessionId || 'null'}`,
        `activeSessionId=${activeSessionId || 'null'}`,
        `source=${state?.source || 'unknown'}`,
        `reason=${state?.reason || 'unknown'}`,
        `count=${state?.count || 0}`,
        `total=${total}`,
        ...fields
    ]);
}

function notePendingStatusOnlyCoalesced(sessionId, source, reason, fields = []) {
    if (reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')) {
        return false;
    }
    const key = getPendingStatusOnlyCoalesceKey(sessionId, source, reason);
    let state = pendingStatusOnlyCoalescedByKey.get(key);
    if (!state) {
        state = {
            key,
            sessionId: sessionId || '',
            source: source || 'unknown',
            reason: reason || 'unknown',
            count: 0,
            postPendingRenderScheduled: false
        };
        pendingStatusOnlyCoalescedByKey.set(key, state);
    }
    state.count += 1;
    if (shouldLogPendingStatusOnlyCoalesce(state)) {
        logPendingStatusOnlyCoalesce('status-coalesce-state-only', state, fields);
        logPendingStatusOnlyCoalesce('status-local-patch-suppressed-unclear-anchor', state, fields);
    }
    if (isUnclearAnchorCircuitBreakerCurrentlyOpen(sessionId, source, reason)) {
        return true;
    }
    if (!state.postPendingRenderScheduled) {
        state.postPendingRenderScheduled = true;
        logPendingStatusOnlyCoalesce('status-reconcile-deferred-render-pending', state, fields);
    }
    return true;
}

function flushPendingStatusOnlyCoalescedAfterRender() {
    if (!pendingStatusOnlyCoalescedByKey.size) return false;
    let scheduled = false;
    for (const state of Array.from(pendingStatusOnlyCoalescedByKey.values())) {
        if (!state.postPendingRenderScheduled) {
            pendingStatusOnlyCoalescedByKey.delete(state.key);
            continue;
        }
        if (state.sessionId && state.sessionId !== activeSessionId) {
            pendingStatusOnlyCoalescedByKey.delete(state.key);
            continue;
        }
        if (isUnclearAnchorCircuitBreakerCurrentlyOpen(state.sessionId, state.source, state.reason)) {
            pendingStatusOnlyCoalescedByKey.delete(state.key);
            continue;
        }
        if (!scheduled) {
            logPendingStatusOnlyCoalesce('status-post-pending-reconcile-scheduled', state, [
                `renderReason=${STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON}`
            ]);
            window.__oc?.renderFromState?.(STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON);
            scheduled = true;
        }
        pendingStatusOnlyCoalescedByKey.delete(state.key);
    }
    return scheduled;
}

function logUnclearAnchorCircuitBreaker(marker, state, fields = []) {
    logRenderStormMetric(marker, [
        `sessionId=${state?.sessionId || 'null'}`,
        `activeSessionId=${activeSessionId || 'null'}`,
        `source=${state?.source || 'unknown'}`,
        `reason=${state?.reason || 'unknown'}`,
        ...fields
    ]);
}

function resetUnclearAnchorCircuitBreakerState(state, resetReason) {
    if (!state) return;
    if (state.resetTimer) {
        clearTimeout(state.resetTimer);
        state.resetTimer = null;
    }
    const failureCount = Array.isArray(state.failures) ? state.failures.length : 0;
    logUnclearAnchorCircuitBreaker('unclear-anchor-circuit-breaker-reset', state, [
        `resetReason=${resetReason || 'unknown'}`,
        `failureCount=${failureCount}`,
        `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_IDLE_RESET_MS}`,
        `open=${state.open ? 'true' : 'false'}`
    ]);
    unclearAnchorCircuitBreakers.delete(state.key);
}

function armUnclearAnchorIdleReset(state) {
    if (!state) return;
    if (state.resetTimer) {
        clearTimeout(state.resetTimer);
    }
    state.resetTimer = setTimeout(() => {
        const latest = unclearAnchorCircuitBreakers.get(state.key);
        if (!latest) return;
        const now = Date.now();
        const lastFailureAt = latest.failures.length ? latest.failures[latest.failures.length - 1] : 0;
        if (!lastFailureAt || now - lastFailureAt >= UNCLEAR_ANCHOR_CIRCUIT_BREAKER_IDLE_RESET_MS) {
            resetUnclearAnchorCircuitBreakerState(latest, 'idle-no-failures');
        } else {
            armUnclearAnchorIdleReset(latest);
        }
    }, UNCLEAR_ANCHOR_CIRCUIT_BREAKER_IDLE_RESET_MS + 25);
}

function scheduleUnclearAnchorCoalescedRender(state, fields = []) {
    if (!state) return false;
    const now = Date.now();
    const activeMatches = Boolean(state.sessionId && state.sessionId === activeSessionId);
    if (!activeMatches) {
        logUnclearAnchorCircuitBreaker('unclear-anchor-coalesced-render-scheduled', state, [
            'scheduled=false',
            'skipReason=inactive-session',
            `failureCount=${state.failures.length}`,
            `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS}`,
            ...fields
        ]);
        return false;
    }
    if (state.coalescedRenderScheduled) {
        logUnclearAnchorCircuitBreaker('unclear-anchor-coalesced-render-scheduled', state, [
            'scheduled=false',
            'skipReason=already-scheduled',
            `failureCount=${state.failures.length}`,
            `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS}`,
            ...fields
        ]);
        return false;
    }
    if (state.lastCoalescedRenderAt && now - state.lastCoalescedRenderAt < UNCLEAR_ANCHOR_CIRCUIT_BREAKER_RENDER_RESET_COOLDOWN_MS) {
        logUnclearAnchorCircuitBreaker('unclear-anchor-coalesced-render-scheduled', state, [
            'scheduled=false',
            'skipReason=cooldown',
            `cooldownMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_RENDER_RESET_COOLDOWN_MS}`,
            `failureCount=${state.failures.length}`,
            `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS}`,
            ...fields
        ]);
        return false;
    }
    state.coalescedRenderScheduled = true;
    state.lastCoalescedRenderAt = now;
    logUnclearAnchorCircuitBreaker('unclear-anchor-coalesced-render-scheduled', state, [
        'scheduled=true',
        'renderReason=unclear-anchor-circuit-breaker',
        `failureCount=${state.failures.length}`,
        `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS}`,
        ...fields
    ]);
    window.__oc?.renderFromState?.('unclear-anchor-circuit-breaker');
    return true;
}

function noteUnclearAnchorCoalescedRenderComplete(sessionId) {
    if (!sessionId) return;
    for (const state of Array.from(unclearAnchorCircuitBreakers.values())) {
        if (state.sessionId !== sessionId || !state.coalescedRenderScheduled) continue;
        state.coalescedRenderScheduled = false;
        setTimeout(() => {
            const latest = unclearAnchorCircuitBreakers.get(state.key);
            if (!latest) return;
            resetUnclearAnchorCircuitBreakerState(latest, 'coalesced-render-complete');
        }, UNCLEAR_ANCHOR_CIRCUIT_BREAKER_RENDER_RESET_COOLDOWN_MS);
    }
}

function isUnclearAnchorCircuitBreakerOpen(sessionId, source, reason, fields = []) {
    if (reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')) {
        return false;
    }
    const state = getUnclearAnchorCircuitBreakerState(sessionId, source, reason);
    const now = Date.now();
    if (!state.open || now >= state.openUntil) {
        return false;
    }
    logUnclearAnchorCircuitBreaker('unclear-anchor-circuit-breaker-open', state, [
        'skipReason=open-window',
        `failureCount=${state.failures.length}`,
        `windowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_OPEN_COOLDOWN_MS}`,
        `openUntilMs=${Math.max(0, state.openUntil - now)}`,
        ...fields
    ]);
    scheduleUnclearAnchorCoalescedRender(state, fields);
    return true;
}

function recordUnclearAnchorLocalPatchFailure(sessionId, source, reason, fields = []) {
    if (reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')) {
        return false;
    }
    const state = getUnclearAnchorCircuitBreakerState(sessionId, source, reason);
    const now = Date.now();
    state.failures.push(now);
    state.failures = state.failures.filter((ts) => now - ts <= UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS);
    armUnclearAnchorIdleReset(state);
    const shortCount = state.failures.filter((ts) => now - ts <= UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_WINDOW_MS).length;
    const longCount = state.failures.length;
    const thresholdHit = shortCount >= UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_LIMIT || longCount >= UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_LIMIT;
    if (!thresholdHit) {
        return false;
    }
    if (!state.open || now >= state.openUntil) {
        state.open = true;
        state.openUntil = now + UNCLEAR_ANCHOR_CIRCUIT_BREAKER_OPEN_COOLDOWN_MS;
        logUnclearAnchorCircuitBreaker('unclear-anchor-circuit-breaker-open', state, [
            `failureCount=${longCount}`,
            `shortWindowCount=${shortCount}`,
            `shortWindowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_WINDOW_MS}`,
            `shortLimit=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_LIMIT}`,
            `longWindowCount=${longCount}`,
            `longWindowMs=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS}`,
            `longLimit=${UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_LIMIT}`,
            ...fields
        ]);
    }
    scheduleUnclearAnchorCoalescedRender(state, fields);
    return true;
}

function getWebviewAutoRescueAttemptKey(message) {
    const attemptId = typeof message?.rescueAttemptId === 'string' && message.rescueAttemptId.length > 0
        ? message.rescueAttemptId
        : '';
    if (!attemptId) return '';
    return `${message?.rescueSource || 'unknown'}:${attemptId}`;
}

function logWebviewAutoRescueMarker(marker, fields = []) {
    logRenderStormMetric(marker, ['source=webviewAutoRescue', ...fields]);
}

function postWebviewAutoRescueAck(message, phase, result, reason, extra = {}) {
    const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : '';
    const branch = message?.branch || (message?.type === 'sessionData' ? 'not-fresh-sessionData' : 'fresh-active-turn-command');
    const activeSessionMatches = Boolean(sessionId && activeSessionId === sessionId);
    const payload = {
        type: 'webviewAutoRescueAck',
        event: 'webviewAutoRescue.ack',
        phase,
        result,
        reason,
        rescueAttemptId: message?.rescueAttemptId || '',
        sessionId,
        activeSessionId: activeSessionId || '',
        branch,
        rescueRenderMode: message?.rescueRenderMode || '',
        activeSessionMatches,
        currentSessionMatches: activeSessionMatches,
        ...extra
    };
    vscode.postMessage(payload);
    logWebviewAutoRescueMarker('webviewAutoRescue.ack', [
        `phase=${phase}`,
        `result=${result}`,
        `reason=${reason || 'none'}`,
        `rescueAttemptId=${payload.rescueAttemptId || 'null'}`,
        `sessionId=${sessionId || 'null'}`,
        `activeSessionId=${activeSessionId || 'null'}`,
        `branch=${branch}`,
        `rescueRenderMode=${payload.rescueRenderMode || 'null'}`,
        `activeSessionMatches=${String(activeSessionMatches)}`,
        `currentSessionMatches=${String(activeSessionMatches)}`
    ]);
}

function markWebviewAutoRescueAttemptIfNew(message, fields = []) {
    const attemptKey = getWebviewAutoRescueAttemptKey(message);
    if (!attemptKey) {
        logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=missing-attempt-id', ...fields]);
        return { ok: false, attemptKey: '', reason: 'missing-attempt-id' };
    }
    if (webviewAutoRescueProcessedAttemptIds.has(attemptKey)) {
        logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=duplicate-attempt', `rescueAttemptId=${message.rescueAttemptId}`, ...fields]);
        return { ok: false, attemptKey, reason: 'already-rendered-current-session' };
    }
    webviewAutoRescueProcessedAttemptIds.add(attemptKey);
    return { ok: true, attemptKey, reason: 'accepted' };
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

function getBackgroundPulseNoActiveIndicatorNoopState(sessionId, session, source) {
    if (source !== 'backgroundActivityPulse' || !sessionId || sessionId !== activeSessionId || session !== getSessionState(activeSessionId)) {
        return null;
    }
    if (!sessionHasVisibleThinkingAssistant(session)) {
        return null;
    }
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        return null;
    }
    const hasIndicatorDom = Boolean(chatContainer.querySelector('.message-background-subagent-indicator, .message.bot.has-background-subagent-indicator'));
    if (hasIndicatorDom) {
        return null;
    }
    const anchoredAssistantId = typeof session.backgroundSubagentIndicatorAnchorId === 'string'
        ? session.backgroundSubagentIndicatorAnchorId
        : null;
    const fallbackAssistantId =
        (typeof session.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId)
        || (typeof session.earlyFinalAssistantId === 'string' && session.earlyFinalAssistantId)
        || null;
    const targetId = anchoredAssistantId || fallbackAssistantId;
    const targetBubble = targetId
        ? chatContainer.querySelector(`.message.bot[data-message-id="${escapeMessageIdForSelector(targetId)}"]`)
        : null;
    const visibleTargetRequiresChange = Boolean(targetBubble?.classList.contains('has-background-subagent-indicator') || targetBubble?.querySelector('.message-background-subagent-indicator'));
    if (visibleTargetRequiresChange) {
        return null;
    }
    const timelineCount = Array.isArray(session.timeline) ? session.timeline.length : 0;
    const domChildren = chatContainer.childElementCount;
    return {
        reason: 'no-active-indicator',
        timelineCount,
        domChildren,
        pressure: timelineCount >= 1200 || domChildren >= 1600
    };
}

function noteBackgroundPulseNoActiveIndicatorNoop(sessionId, state) {
    const key = `${sessionId || 'null'}|${state?.reason || 'unknown'}`;
    const count = incrementRenderStormCounter('backgroundPulseNoopByKey', key);
    const avoided = incrementRenderStormCounter('backgroundPulseRenderAvoidedByKey', key);
    if (count > 3 && count % 25 !== 0) {
        return;
    }
    const fields = [
        `reason=${state?.reason || 'unknown'}`,
        `sessionMatch=${sessionId === activeSessionId ? 'true' : 'false'}`,
        'desiredVisible=false',
        'domVisible=false',
        `pressure=${state?.pressure ? 'true' : 'false'}`,
        `timelineCount=${state?.timelineCount || 0}`,
        `domChildren=${state?.domChildren || 0}`,
        `count=${count}`,
        `renderAvoided=${avoided}`
    ];
    logRenderStormMetric('background-pulse-noop-no-active-indicator', fields);
    logRenderStormMetric('background-indicator-noop', fields);
    logRenderStormMetric('background-pulse-render-avoided', fields);
}

function noteFullRenderRequest(reason, fields = []) {
    if (typeof recordChatRenderReason === 'function') recordChatRenderReason(reason);
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

function getBackgroundSubagentIndicatorNoClearAnchorReason(session) {
    if (session && session !== getSessionState(activeSessionId)) {
        return '';
    }
    if (!sessionHasActiveBackgroundSubagents(session) || sessionHasVisibleThinkingAssistant(session)) {
        return '';
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
    const targetId = anchoredAssistantId || fallbackAssistantId;
    if (anchoredAssistantId && fallbackAssistantId && anchoredAssistantId !== fallbackAssistantId) {
        return 'unclear-anchor';
    }
    if (!targetId) {
        return 'unclear-anchor';
    }
    return '';
}

function shouldCoalescePendingStatusOnlyUnclearAnchor(sessionId, source, reason, fields = []) {
    if (reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')) {
        return false;
    }
    if (typeof window.__oc?.isRenderPending !== 'function' || !window.__oc.isRenderPending()) {
        return false;
    }
    return notePendingStatusOnlyCoalesced(sessionId, source, reason, fields);
}

function handleBackgroundIndicatorPatchResult(sessionId, result, source, fields = []) {
    countBackgroundIndicatorApplyResult(result, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
    if (result?.applied === true) return true;
    const reason = result?.reason || 'unknown';
    if (reason === 'missing-target-bubble' || reason === 'unclear-anchor') {
        countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
        recordUnclearAnchorLocalPatchFailure(sessionId, source, reason, fields);
        requestThrottledBackgroundFallbackRender(sessionId, `background-pulse-${reason}`, [`source=${source || 'unknown'}`, ...fields]);
        return false;
    }
    if (reason === 'inactive-session') {
        suppressFallbackRender(`background-pulse-${reason}`, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
        logBackgroundStateUpdate(sessionId, 'background-pulse', { extra: [`apply=${reason}`, `source=${source || 'unknown'}`, 'render=false', ...fields] });
        return false;
    }
    countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
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

function armBackgroundSubagentIndicator(sessionId, anchorAssistantId, source = 'backgroundActivityPulse') {
    const session = getSessionState(sessionId, true);
    if (!session) return;
    if (session.backgroundSubagentIndicatorVisible) {
        const existingBackgroundPulseNoopState = getBackgroundPulseNoActiveIndicatorNoopState(sessionId, session, source);
        if (existingBackgroundPulseNoopState) {
            noteBackgroundPulseNoActiveIndicatorNoop(sessionId, existingBackgroundPulseNoopState);
        }
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
        if (isUnclearAnchorCircuitBreakerOpen(sessionId, source, 'unclear-anchor', ['phase=timer-expiry-hide'])) {
            return;
        }
        handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(latest), source, ['phase=timer-expiry-hide']);
    }, 3000);
    const backgroundPulseNoopState = getBackgroundPulseNoActiveIndicatorNoopState(sessionId, session, source);
    if (backgroundPulseNoopState) {
        noteBackgroundPulseNoActiveIndicatorNoop(sessionId, backgroundPulseNoopState);
        return;
    }
    if (isUnclearAnchorCircuitBreakerOpen(sessionId, source, 'unclear-anchor', ['phase=arm-show'])) {
        return;
    }
    const noClearAnchorReason = getBackgroundSubagentIndicatorNoClearAnchorReason(session);
    if (shouldCoalescePendingStatusOnlyUnclearAnchor(sessionId, source, noClearAnchorReason, ['phase=arm-show'])) {
        return;
    }
    handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(session), source, ['phase=arm-show']);
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

const sessionEventRouter = window.__ocContinuation.createSessionEventRouter({
    entries: () => sessionStore.entries(),
    getActiveSessionId: () => activeSessionId,
    postDebug: (payload) => vscode.postMessage({ type: 'ui-debug', payload }),
    warn: (message, payload) => console.warn(message, payload),
    render: (reason) => window.__oc?.renderFromState?.(reason),
    scroll: (force, fallback) => {
        if (typeof window.__oc?.scrollToBottom === 'function') window.__oc.scrollToBottom(force);
        else if (typeof fallback === 'function') fallback(force);
    },
    singleInFlightFallbackEvents: SINGLE_IN_FLIGHT_FALLBACK_EVENTS
});

function findSingleInFlightSessionId() {
    return sessionEventRouter.findSingleInFlightSessionId();
}

function resolveEventSessionId(message, eventName, options = {}) {
    return sessionEventRouter.resolveEventRoute(message, eventName, options);
}

function getEventSessionId(message, eventName) {
    const route = resolveEventSessionId(message, eventName);
    return route?.sessionId || null;
}

function resolveParentVisibleSubagentRoute(message, eventName) {
    return sessionEventRouter.resolveParentRoute(message, eventName);
}

function resolveAgentLaneSubagentRoute(message, eventName) {
    return sessionEventRouter.resolveAgentLaneRoute(message, eventName);
}

function resolveContentEventRoute(message, eventName) {
    return sessionEventRouter.resolveContentRoute(message, eventName);
}

function retainAgentLaneParentAssociation(session, route) {
    sessionEventRouter.retainAgentLaneParentAssociation(session, route);
}

function logBackgroundStateUpdate(sessionId, reason, options = {}) {
    sessionEventRouter.logBackgroundStateUpdate(sessionId, reason, options);
}

function renderIfActive(sessionId, reason, options = {}) {
    return sessionEventRouter.renderIfActive(sessionId, reason, options);
}

const sessionRenderScheduler = window.__ocContinuation.createSessionRenderScheduler({
    getActiveSessionId: () => activeSessionId,
    render: (reason) => window.__oc?.renderFromState?.(reason),
    onInactive: (sessionId, reason) => logBackgroundStateUpdate(sessionId, reason, { extra: ['render=false', 'coalesced=inactive'] }),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    intervalMs: SESSION_METADATA_RENDER_INTERVAL_MS
});

function scheduleCoalescedSessionMetadataRender(sessionId, reason, options) {
    return sessionRenderScheduler.schedule(sessionId, reason, options || {});
}

function disposeSessionMetadataRenderStates() {
    sessionRenderScheduler.dispose();
}

if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', disposeSessionMetadataRenderStates, { once: true });
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
    return { applied: true, reason: indicator ? 'applied' : 'no-active-indicator' };
}

function isTerminalSubagentStatusUpdate(agents, doneJustNowCount) {
    if (typeof doneJustNowCount === 'number' && doneJustNowCount > 0) {
        return true;
    }
    if (!Array.isArray(agents) || !agents.length) {
        return false;
    }
    return agents.some((agent) => {
        const state = typeof agent?.state === 'string' ? agent.state : '';
        return state === 'done' || state === 'failed' || state === 'cancelled' || agent?.isDone === true;
    });
}

function handleSubagentStatusPatchResult(sessionId, result, source, fields = [], options = {}) {
    logRenderStormMetric('subagent-status-local-patch', [
        `applied=${result?.applied === true ? 'true' : 'false'}`,
        `reason=${result?.reason || 'unknown'}`,
        `sessionId=${sessionId || 'null'}`,
        `source=${source || 'unknown'}`,
        ...fields
    ]);
    if (result?.applied === true) return true;
    const reason = result?.reason || 'unknown';
    if (reason === 'unclear-anchor-circuit-breaker-open') {
        logRenderStormMetric('subagent-status-local-patch-skipped', [
            'skipReason=unclear-anchor-circuit-breaker-open',
            `sessionId=${sessionId || 'null'}`,
            `activeSessionId=${activeSessionId || 'null'}`,
            `source=${source || 'unknown'}`,
            ...fields
        ]);
        return false;
    }
    if (reason === 'missing-target-bubble' || reason === 'unclear-anchor') {
        countLocalPatchFailed(reason, [`sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, ...fields]);
        if (options.coalescedRender === true) {
            suppressFallbackRender(`subagentStatus-${reason}`, [
                `sessionId=${sessionId || 'null'}`, `source=${source || 'unknown'}`, 'reason=metadata-render-owned', ...fields
            ]);
            return false;
        }
        recordUnclearAnchorLocalPatchFailure(sessionId, source, reason, fields);
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
    if (getModelStateController().getModels().length === 0) {
        sendBtn.disabled = true;
        setSendBlockedNotice('');
        return;
    }
    const session = getSessionState(activeSessionId);
    const compactionRunning = Boolean(activeSessionId && getHeaderStateController().isCompacting(activeSessionId));
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

const appendSnapshotController = window.__ocContinuation.createAppendSnapshotController({
    resolveMessageKey: resolveSnapshotMessageKey,
    getSession: (sessionId) => getSessionState(sessionId),
    postMessage: (message) => vscode.postMessage(message)
});

function sanitizeAppendSnapshotItem(item, session) {
    return appendSnapshotController.sanitizeItem(item, session);
}

function sanitizeAppendSnapshotItems(items, session) {
    return appendSnapshotController.sanitizeItems(items, session);
}

function normalizeAppendItemsForFinalize(items) {
    return appendSnapshotController.normalizeItemsForFinalize(items);
}

function normalizeSessionAppendItemsForFinalize(session) {
    return appendSnapshotController.normalizeSessionForFinalize(session);
}

function collectAppendSnapshotMetadata(session) {
    return appendSnapshotController.collect(session);
}

function hasProtectedInflightAppendRoot(session) {
    return appendSnapshotController.hasProtectedInflightRoot(session);
}

function syncAppendSnapshotMetadata(sessionId, reason = 'unknown') {
    appendSnapshotController.sync(sessionId, reason);
}

function restoreAppendHydrationMetadata(sessionId, session) {
    return appendSnapshotController.restore(sessionId, session);
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
    const plan = planChangeListMaterialization({
        rawMessages: rawSessionMessages,
        messagesById: session.messagesById,
        timeline: session.timeline,
        nextOrder: session.nextOrder,
        toStableMessageKey: (messageId) => toStableMessageKey(session, messageId)
    });
    for (const message of plan.messages) session.messagesById.set(message.id, message);
    session.timeline = [...plan.timeline];
    session.nextOrder = plan.nextOrder;
    const stats = plan.stats;

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
    return segmentTopology.computeMembers(session, anchorMsgId, endMsgId);
}

function resolveSegmentMessageId(session, messageId) {
    return segmentTopology.resolveMessageId(session, messageId);
}

function normalizeSegmentMembersFromTimeline(session, anchorMsgId, endMsgId, candidateMsgIds, noticeKey) {
    return segmentTopology.normalizeMembers(session, anchorMsgId, endMsgId, candidateMsgIds, noticeKey);
}

function sanitizeMergedSegmentSnapshot(seg) {
    return segmentTopology.sanitizeMergedSnapshot(seg);
}

function orderSegmentMemberMsgIdsByTimeline(memberMsgIds, timeline) {
    return segmentTopology.orderMembersByTimeline(memberMsgIds, timeline);
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

    const oldMessageForRoleGuard = session.messagesById.get(oldId) || null;
    if (oldMessageForRoleGuard?.role === 'user' && typeof oldId === 'string' && oldId.startsWith('msg_') && typeof newId === 'string' && newId.startsWith('msg_')) {
        if (session.currentTurnAssistantKey === oldId) session.currentTurnAssistantKey = null;
        if (session.currentTurnAssistantMsgId === oldId) session.currentTurnAssistantMsgId = null;
        if (session.thinkingId === oldId) session.thinkingId = null;
        vscode.postMessage({ type: 'ui-debug', payload: ['reject.user->assistant-role', 'oldKey', oldId, 'newKey', newId, 'sessionId', sessionId] });
        return;
    }

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
    if (session.lastTurnAssistantId === oldId) {
        session.lastTurnAssistantId = newId;
    }
    if (session.currentTurnAssistantMsgId === oldId) {
        session.currentTurnAssistantMsgId = newId;
    }
    if (session.finalAssistantLock?.assistantMsgId === oldId) {
        session.finalAssistantLock.assistantMsgId = newId;
    }
    if (session.pendingUndo?.anchorKey === oldId) {
        session.pendingUndo.anchorKey = newId;
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
    if (typeof sessionSearch !== 'undefined') sessionSearch.rekey(oldId, newId);
    if (typeof subagentTextExpandedByKey !== 'undefined' && subagentTextExpandedByKey instanceof Map) {
        const expansionNeedle = `:${oldId}:`;
        for (const [key, expanded] of Array.from(subagentTextExpandedByKey.entries())) {
            if (!key.includes(expansionNeedle)) continue;
            subagentTextExpandedByKey.delete(key);
            subagentTextExpandedByKey.set(key.replace(expansionNeedle, `:${newId}:`), expanded);
        }
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
    if (typeof rekeyKeyedChatPresentation === 'function' && !rekeyKeyedChatPresentation(oldId, newId, sessionId)) {
        window.__oc?.renderFromState?.('alias-rekey-fail-closed');
    }
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
const createUndoRequestController = window.__ocUndo?.createUndoRequestController;
if (typeof createUndoRequestController !== 'function') {
    throw new Error('Undo request controller is unavailable');
}
const undoRequestController = createUndoRequestController({
    getSession: (sessionId) => getSessionState(sessionId),
    getActiveSessionId: () => activeSessionId,
    getSessionRegistryInfo: (sessionId) => sessionStore.getRegistryInfo(sessionId),
    isPersistenceArtifact: (id, message) => isHydrationPersistenceArtifact(id, message),
    upsertMessage: (session, message) => upsertMessage(session, message),
    assertInvariants: (sessionId, reason) => assertInvariants(sessionId, reason),
    render: () => window.__oc?.renderFromState?.(),
    postMessage: (message) => vscode.postMessage(message),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
    now: () => Date.now(),
    random: () => Math.random(),
    timeoutMs: UNDO_TIMEOUT_MS
});

function isUndoRangeVisibleMessageId(session, id) {
    return undoRequestController.isRangeVisibleMessageId(session, id);
}

function buildUndoVisibleRangeSnapshot(session, anchorMsgId) {
    return undoRequestController.buildVisibleRangeSnapshot(session, anchorMsgId);
}

function suspendUndoTimeoutForConflictCard(payload) {
    return undoRequestController.suspendTimeoutForConflictCard(payload);
}

function handleUndoToMessage(sessionId, targetMessageId) {
    return undoRequestController.handleUndoToMessage(sessionId, targetMessageId);
}

function handleUndoTimeout(sessionId, clientOpId) {
    return undoRequestController.handleTimeout(sessionId, clientOpId);
}

function createOperationId() {
    return undoRequestController.createOperationId();
}

/**
 * Handle restore segment request
 * Sends restore request to extension, which will respond with restoredSegment message
 */
function handleRestoreSegment(sessionId, segmentId) {
    return undoRequestController.handleRestoreSegment(sessionId, segmentId);
}

function handleToggleSegment(sessionId, segmentId) {
    return undoRequestController.handleToggleSegment(sessionId, segmentId);
}

function toggleUndoSegmentPlaceholder(sessionId, noticeKey) {
    return undoRequestController.togglePlaceholder(sessionId, noticeKey);
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

function scanSafeShellCodePage(text, requestedBlock, requestedPage, pageContract) {
    const source = typeof text === 'string' ? text : '';
    const wantedBlock = Number.isFinite(requestedBlock) && requestedBlock > 0 ? Math.floor(requestedBlock) : 1;
    const wantedPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    const maxCodeUnits = pageContract.maxCodeUnits;
    const maxLines = pageContract.maxLines;
    let blockCount = 0;
    let selectedStart = 0;
    let selectedEnd = 0;
    let selectedLanguage = 'plaintext';
    let cursor = 0;

    const lineEndAt = (start) => {
        const newline = source.indexOf('\n', start);
        return newline === -1 ? source.length : newline;
    };
    const inspectFence = (lineStart, lineEnd, closingMarker, closingLength) => {
        let markerStart = lineStart;
        let indentation = 0;
        while (markerStart < lineEnd && source[markerStart] === ' ' && indentation < 4) {
            markerStart += 1;
            indentation += 1;
        }
        if (indentation > 3 || markerStart >= lineEnd) return null;
        const marker = source[markerStart];
        if (marker !== '`' && marker !== '~') return null;
        let markerEnd = markerStart;
        while (markerEnd < lineEnd && source[markerEnd] === marker) markerEnd += 1;
        const markerLength = markerEnd - markerStart;
        if (markerLength < 3) return null;
        if (closingMarker) {
            if (marker !== closingMarker || markerLength < closingLength) return null;
            for (let index = markerEnd; index < lineEnd; index += 1) {
                if (source[index] !== ' ' && source[index] !== '\t' && source[index] !== '\r') return null;
            }
            return { marker, markerLength, markerEnd };
        }
        if (marker === '`') {
            for (let index = markerEnd; index < lineEnd; index += 1) {
                if (source[index] === '`') return null;
            }
        }
        return { marker, markerLength, markerEnd };
    };
    const readLanguage = (start, end) => {
        while (start < end && (source[start] === ' ' || source[start] === '\t')) start += 1;
        let tokenEnd = start;
        while (tokenEnd < end && source[tokenEnd] !== ' ' && source[tokenEnd] !== '\t' && source[tokenEnd] !== '\r') tokenEnd += 1;
        if (tokenEnd === start) return 'plaintext';
        const visibleEnd = Math.min(tokenEnd, start + 80);
        const label = source.slice(start, visibleEnd).replace(/[\u0000-\u001f\u007f]/g, '�');
        return tokenEnd > visibleEnd ? `${label}…` : label;
    };

    while (cursor < source.length) {
        const openingLineEnd = lineEndAt(cursor);
        const opening = inspectFence(cursor, openingLineEnd, '', 0);
        if (!opening) {
            if (openingLineEnd === source.length) break;
            cursor = openingLineEnd + 1;
            continue;
        }
        blockCount += 1;
        const bodyStart = openingLineEnd < source.length ? openingLineEnd + 1 : source.length;
        let bodyEnd = source.length;
        let nextCursor = source.length;
        let lineStart = bodyStart;
        while (lineStart < source.length) {
            const lineEnd = lineEndAt(lineStart);
            const closing = inspectFence(lineStart, lineEnd, opening.marker, opening.markerLength);
            if (closing) {
                bodyEnd = lineStart;
                nextCursor = lineEnd < source.length ? lineEnd + 1 : source.length;
                break;
            }
            if (lineEnd === source.length) break;
            lineStart = lineEnd + 1;
        }
        if (blockCount === wantedBlock) {
            selectedStart = bodyStart;
            selectedEnd = bodyEnd;
            selectedLanguage = readLanguage(opening.markerEnd, openingLineEnd);
        }
        cursor = nextCursor;
    }

    const selectedBlock = blockCount > 0 ? Math.min(wantedBlock, blockCount) : 1;
    if (blockCount > 0 && wantedBlock > blockCount) {
        return scanSafeShellCodePage(source, blockCount, wantedPage, pageContract);
    }
    let currentPage = 1;
    let currentCodeUnits = 0;
    let currentLines = 1;
    let newlineCount = 0;
    let pageText = '';
    for (let index = selectedStart; index < selectedEnd; index += 1) {
        const character = source[index];
        if (currentCodeUnits >= maxCodeUnits || (character === '\n' && currentLines >= maxLines)) {
            currentPage += 1;
            currentCodeUnits = 0;
            currentLines = 1;
        }
        if (currentPage === wantedPage) pageText += character;
        currentCodeUnits += 1;
        if (character === '\n') {
            currentLines += 1;
            newlineCount += 1;
        }
    }
    const totalPages = selectedEnd > selectedStart ? currentPage : 1;
    if (wantedPage > totalPages) {
        return scanSafeShellCodePage(source, selectedBlock, totalPages, pageContract);
    }
    return {
        blockCount,
        selectedBlock,
        language: selectedLanguage,
        contentStart: selectedStart,
        contentEnd: selectedEnd,
        pageText,
        totalPages,
        selectedPage: Math.min(wantedPage, totalPages),
        codeUnitCount: selectedEnd - selectedStart,
        lineCount: selectedEnd > selectedStart ? newlineCount + 1 : 0
    };
}

function renderSafeShellCodeMessage(session, unit, presentationSelection) {
    const rendering = window.__ocRendering;
    if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
    if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-code') return null;
    const message = unit.value?.message;
    if (!message || message.role !== 'assistant' || message.meta?.isThinking === true) return null;
    if (message.meta?.kind || message.meta?.isDiff
        || Array.isArray(message.meta?.images) && message.meta.images.length > 0
        || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0) return null;
    const canonicalMarkdown = typeof message.text === 'string' ? message.text : '';
    const initialSpec = rendering.getSafeShellSpec({
        mode: presentationSelection.mode,
        family: presentationSelection.family,
        blockPage: 1,
        contentPage: 1,
        shape: { blockCount: 1, codeUnitCount: 1, lineCount: 1 }
    });
    if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content || !initialSpec.page?.primary) return null;
    let requestedBlock = 1;
    let requestedPage = 1;
    let scan = scanSafeShellCodePage(canonicalMarkdown, requestedBlock, requestedPage, initialSpec.page.content);
    if (scan.blockCount === 0) return null;

    const root = document.createElement('div');
    root.className = 'safe-shell';
    root.dataset.safeShellFamily = initialSpec.family;
    root.dataset.messageId = message.id;
    const generation = ++safeShellPresentationGeneration;
    root.dataset.safeShellGeneration = String(generation);
    const ownership = {
        sessionId: activeSessionId,
        unitKey: unit.key,
        generation,
        root,
        disposed: false,
        timers: new Set(),
        frames: new Set()
    };
    safeShellMountOwnership.set(root, ownership);
    root._safeShellDispose = () => disposeSafeShellRoot(root);
    const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
    const viewerId = `safe-shell-code-viewer-${deterministicKey}-${generation}`;
    let open = false;

    const scheduleFocus = (role) => {
        let frame = null;
        frame = requestAnimationFrame(() => {
            ownership.frames.delete(frame);
            if (!isSafeShellMountCurrent(root, ownership)) return;
            root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
        });
        ownership.frames.add(frame);
    };
    const makeButton = (role, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'safe-shell-action';
        button.dataset.safeShellRole = role;
        button.textContent = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!isSafeShellMountCurrent(root, ownership)) return;
            onClick(button);
        });
        return button;
    };
    const render = () => {
        scan = scanSafeShellCodePage(canonicalMarkdown, requestedBlock, requestedPage, initialSpec.page.content);
        requestedBlock = scan.selectedBlock;
        requestedPage = scan.selectedPage;
        const spec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            blockPage: requestedBlock,
            contentPage: requestedPage,
            shape: { blockCount: scan.blockCount, codeUnitCount: scan.codeUnitCount, lineCount: scan.lineCount }
        });
        if (!spec?.allowed || spec.shellSelected !== true) return;
        const heading = document.createElement('div');
        heading.className = 'safe-shell-heading';
        heading.textContent = spec.labels.title;
        const status = document.createElement('div');
        status.className = 'safe-shell-status';
        status.dataset.safeShellRole = 'status';
        status.id = `${viewerId}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = `${scan.blockCount} code ${scan.blockCount === 1 ? 'block' : 'blocks'}; language ${scan.language}; block ${scan.selectedBlock} of ${scan.blockCount}; page ${scan.selectedPage} of ${scan.totalPages}; ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines${open ? '.' : '; content omitted from collapsed preview.'}`;
        const viewerRegion = document.createElement('div');
        viewerRegion.className = 'safe-shell-viewer-region';
        viewerRegion.dataset.safeShellRole = 'viewer-region';
        viewerRegion.id = viewerId;
        viewerRegion.setAttribute('aria-describedby', status.id);
        const viewer = document.createElement('pre');
        viewer.className = 'safe-shell-viewer';
        viewer.dataset.safeShellRole = 'viewer';
        viewer.tabIndex = -1;
        viewer.textContent = open ? scan.pageText : '';
        viewerRegion.appendChild(viewer);
        if (open) {
            const blockStatus = document.createElement('span');
            blockStatus.className = 'safe-shell-page-status';
            blockStatus.dataset.safeShellRole = 'block-status';
            blockStatus.setAttribute('role', 'status');
            blockStatus.textContent = `Block ${scan.selectedBlock} of ${scan.blockCount}; language ${scan.language}`;
            viewerRegion.appendChild(blockStatus);
            const pageStatus = document.createElement('span');
            pageStatus.className = 'safe-shell-page-status';
            pageStatus.dataset.safeShellRole = 'page-status';
            pageStatus.setAttribute('role', 'status');
            pageStatus.textContent = `Page ${scan.selectedPage} of ${scan.totalPages}`;
            viewerRegion.appendChild(pageStatus);
        }
        const actions = document.createElement('div');
        actions.className = 'safe-shell-actions';
        const labels = spec.labels.actions;
        const openButton = makeButton('open-full', labels['open-full'], () => {
            if (open) return;
            open = true;
            render();
            scheduleFocus('viewer');
        });
        openButton.setAttribute('aria-controls', viewerId);
        openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        openButton.disabled = open;
        actions.appendChild(openButton);
        if (open) {
            const previous = makeButton('previous', labels.previous, () => {
                if (requestedPage > 1) requestedPage -= 1;
                else if (requestedBlock > 1) { requestedBlock -= 1; requestedPage = 1; }
                render();
                scheduleFocus('viewer');
            });
            previous.disabled = requestedBlock <= 1 && requestedPage <= 1;
            actions.appendChild(previous);
            const next = makeButton('next', labels.next, () => {
                if (requestedPage < scan.totalPages) requestedPage += 1;
                else if (requestedBlock < scan.blockCount) { requestedBlock += 1; requestedPage = 1; }
                render();
                scheduleFocus('viewer');
            });
            next.disabled = requestedBlock >= scan.blockCount && requestedPage >= scan.totalPages;
            actions.appendChild(next);
            actions.appendChild(makeButton('close', labels.close, () => {
                open = false;
                render();
                if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
            }));
        }
        actions.appendChild(makeButton('copy-full', labels['copy-full'], (button) => {
            const canonicalBlock = canonicalMarkdown.slice(scan.contentStart, scan.contentEnd);
            Promise.resolve(writeTextToClipboard(canonicalBlock)).then((copied) => {
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                button.textContent = copied ? 'Copied' : 'Copy failed';
                const timer = setTimeout(() => {
                    ownership.timers.delete(timer);
                    if (!isSafeShellMountCurrent(root, ownership)) return;
                    delete root.dataset.safeShellCopyState;
                    render();
                }, copied ? 900 : 1200);
                ownership.timers.add(timer);
            });
        }));
        root.replaceChildren(heading, status, viewerRegion, actions);
    };
    render();
    return root;
}

function scanSafeShellDiffPage(text, requestedPage, pageContract) {
    const source = typeof text === 'string' ? text : '';
    const wantedPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    let currentPage = 1;
    let currentCodeUnits = 0;
    let currentLines = 1;
    let newlineCount = 0;
    let hunkCount = 0;
    let atLineStart = true;
    let pageText = '';
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (atLineStart && character === '@' && source[index + 1] === '@') hunkCount += 1;
        if (currentCodeUnits >= pageContract.maxCodeUnits || (character === '\n' && currentLines >= pageContract.maxLines)) {
            currentPage += 1;
            currentCodeUnits = 0;
            currentLines = 1;
        }
        if (currentPage === wantedPage) pageText += character;
        currentCodeUnits += 1;
        if (character === '\n') {
            currentLines += 1;
            newlineCount += 1;
            atLineStart = true;
        } else {
            atLineStart = false;
        }
    }
    const totalPages = source.length > 0 ? currentPage : 1;
    if (wantedPage > totalPages) return scanSafeShellDiffPage(source, totalPages, pageContract);
    return { pageText, totalPages, selectedPage: Math.min(wantedPage, totalPages), codeUnitCount: source.length,
        lineCount: source.length > 0 ? newlineCount + 1 : 0, hunkCount };
}

function renderSafeShellDiffMessage(session, unit, presentationSelection) {
    const rendering = window.__ocRendering;
    if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
    if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-diff') return null;
    const message = unit.value?.message;
    if (!message || message.meta?.isDiff !== true) return null;
    const canonicalDiff = String(message.meta?.diffText || message.text || '');
    const initialSpec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
        contentPage: 1, shape: { codeUnitCount: canonicalDiff.length, lineCount: canonicalDiff.length > 0 ? 1 : 0 } });
    if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;
    const root = document.createElement('div');
    root.className = 'safe-shell';
    root.dataset.safeShellFamily = initialSpec.family;
    root.dataset.messageId = message.id;
    const generation = ++safeShellPresentationGeneration;
    root.dataset.safeShellGeneration = String(generation);
    const ownership = { sessionId: activeSessionId, unitKey: unit.key, generation, root, disposed: false, timers: new Set(), frames: new Set() };
    safeShellMountOwnership.set(root, ownership);
    root._safeShellDispose = () => disposeSafeShellRoot(root);
    const viewerId = `safe-shell-diff-viewer-${encodeURIComponent(String(unit.key)).replace(/%/g, '-')}-${generation}`;
    let open = false;
    let requestedPage = 1;
    let scan = scanSafeShellDiffPage(canonicalDiff, requestedPage, initialSpec.page.content);
    const scheduleFocus = (role) => {
        let frame = null;
        frame = requestAnimationFrame(() => {
            ownership.frames.delete(frame);
            if (isSafeShellMountCurrent(root, ownership)) root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
        });
        ownership.frames.add(frame);
    };
    const makeButton = (role, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'safe-shell-action';
        button.dataset.safeShellRole = role;
        button.textContent = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isSafeShellMountCurrent(root, ownership)) onClick(button);
        });
        return button;
    };
    const render = () => {
        scan = scanSafeShellDiffPage(canonicalDiff, requestedPage, initialSpec.page.content);
        requestedPage = scan.selectedPage;
        const spec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
            contentPage: requestedPage, shape: { codeUnitCount: scan.codeUnitCount, lineCount: scan.lineCount } });
        if (!spec?.allowed || spec.shellSelected !== true) return;
        const heading = document.createElement('div');
        heading.className = 'safe-shell-heading';
        heading.textContent = spec.labels.title;
        const status = document.createElement('div');
        status.className = 'safe-shell-status';
        status.dataset.safeShellRole = 'status';
        status.id = `${viewerId}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = `${scan.hunkCount} ${scan.hunkCount === 1 ? 'hunk' : 'hunks'}; ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; page ${scan.selectedPage} of ${scan.totalPages}${open ? '.' : '; content omitted from collapsed preview.'}`;
        const viewerRegion = document.createElement('div');
        viewerRegion.className = 'safe-shell-viewer-region';
        viewerRegion.dataset.safeShellRole = 'viewer-region';
        viewerRegion.id = viewerId;
        viewerRegion.setAttribute('aria-describedby', status.id);
        const viewer = document.createElement('pre');
        viewer.className = 'safe-shell-viewer';
        viewer.dataset.safeShellRole = 'viewer';
        viewer.tabIndex = -1;
        viewer.textContent = open ? scan.pageText : '';
        viewerRegion.appendChild(viewer);
        if (open) {
            const pageStatus = document.createElement('span');
            pageStatus.className = 'safe-shell-page-status';
            pageStatus.dataset.safeShellRole = 'page-status';
            pageStatus.setAttribute('role', 'status');
            pageStatus.textContent = `Page ${scan.selectedPage} of ${scan.totalPages}`;
            viewerRegion.appendChild(pageStatus);
        }
        const actions = document.createElement('div');
        actions.className = 'safe-shell-actions';
        const labels = spec.labels.actions;
        const openButton = makeButton('open-full', labels['open-full'], () => { open = true; render(); scheduleFocus('viewer'); });
        openButton.setAttribute('aria-controls', viewerId);
        openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        openButton.disabled = open;
        actions.appendChild(openButton);
        if (open) {
            const previous = makeButton('previous', labels.previous, () => { requestedPage = Math.max(1, requestedPage - 1); render(); scheduleFocus('viewer'); });
            previous.disabled = requestedPage <= 1;
            actions.appendChild(previous);
            const next = makeButton('next', labels.next, () => { requestedPage += 1; render(); scheduleFocus('viewer'); });
            next.disabled = requestedPage >= scan.totalPages;
            actions.appendChild(next);
            actions.appendChild(makeButton('close', labels.close, () => {
                open = false;
                render();
                if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
            }));
        }
        actions.appendChild(makeButton('copy-full', labels['copy-full'], (button) => {
            Promise.resolve(writeTextToClipboard(canonicalDiff)).then((copied) => {
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                button.textContent = copied ? 'Copied' : 'Copy failed';
                const timer = setTimeout(() => {
                    ownership.timers.delete(timer);
                    if (!isSafeShellMountCurrent(root, ownership)) return;
                    delete root.dataset.safeShellCopyState;
                    render();
                }, copied ? 900 : 1200);
                ownership.timers.add(timer);
            });
        }));
        root.replaceChildren(heading, status, viewerRegion, actions);
    };
    render();
    return root;
}

function scanSafeShellTablePage(text, requestedRowPage, requestedColumnPage, rowContract, columnContract) {
    const source = typeof text === 'string' ? text : '';
    const rowLimit = Math.max(1, Number(rowContract?.limit) || 1);
    const columnLimit = Math.max(1, Number(columnContract?.limit) || 1);
    const wantedRowPage = Number.isFinite(requestedRowPage) && requestedRowPage > 0 ? Math.floor(requestedRowPage) : 1;
    const wantedColumnPage = Number.isFinite(requestedColumnPage) && requestedColumnPage > 0 ? Math.floor(requestedColumnPage) : 1;
    const lineEndAt = (start) => {
        const newline = source.indexOf('\n', start);
        let end = newline === -1 ? source.length : newline;
        if (end > start && source[end - 1] === '\r') end -= 1;
        return { end, next: newline === -1 ? source.length : newline + 1 };
    };
    const trimRange = (start, end) => {
        while (start < end && (source[start] === ' ' || source[start] === '\t')) start += 1;
        while (end > start && (source[end - 1] === ' ' || source[end - 1] === '\t')) end -= 1;
        return { start, end };
    };
    const visitCells = (lineStart, lineEnd, visitor) => {
        let range = trimRange(lineStart, lineEnd);
        let start = range.start;
        let end = range.end;
        if (start < end && source[start] === '|') start += 1;
        if (end > start && source[end - 1] === '|' && (end < 2 || source[end - 2] !== '\\')) end -= 1;
        let cellStart = start;
        let count = 0;
        let escaped = false;
        for (let index = start; index <= end; index += 1) {
            const character = index < end ? source[index] : '|';
            if (character === '\\' && !escaped) {
                escaped = true;
                continue;
            }
            if (character === '|' && !escaped) {
                const cell = trimRange(cellStart, index);
                visitor?.(count, cell.start, cell.end);
                count += 1;
                cellStart = index + 1;
            }
            escaped = false;
        }
        return count;
    };
    const isDelimiter = (start, end, expectedCount) => {
        let valid = true;
        const count = visitCells(start, end, (_index, cellStart, cellEnd) => {
            let cursor = cellStart;
            if (cursor < cellEnd && source[cursor] === ':') cursor += 1;
            const dashStart = cursor;
            while (cursor < cellEnd && source[cursor] === '-') cursor += 1;
            if (cursor === dashStart) valid = false;
            if (cursor < cellEnd && source[cursor] === ':') cursor += 1;
            if (cursor !== cellEnd) valid = false;
        });
        return valid && count === expectedCount && count > 0;
    };
    const hasPipe = (start, end) => {
        for (let index = start; index < end; index += 1) if (source[index] === '|') return true;
        return false;
    };
    const displayCell = (start, end) => {
        const visibleEnd = Math.min(end, start + 256);
        const value = source.slice(start, visibleEnd);
        return end > visibleEnd ? `${value}… (${end - start} code units)` : value;
    };

    let cursor = 0;
    let fencedMarker = '';
    let headerStart = -1;
    let headerEnd = -1;
    let bodyStart = -1;
    let columnCount = 0;
    while (cursor < source.length) {
        const line = lineEndAt(cursor);
        const trimmed = trimRange(cursor, line.end);
        const marker = source.slice(trimmed.start, Math.min(trimmed.end, trimmed.start + 3));
        if (marker === '```' || marker === '~~~') {
            if (!fencedMarker) fencedMarker = marker;
            else if (fencedMarker === marker) fencedMarker = '';
            cursor = line.next;
            continue;
        }
        if (!fencedMarker && hasPipe(cursor, line.end) && line.next < source.length) {
            const columns = visitCells(cursor, line.end);
            const delimiterLine = lineEndAt(line.next);
            if (isDelimiter(line.next, delimiterLine.end, columns)) {
                headerStart = cursor;
                headerEnd = line.end;
                bodyStart = delimiterLine.next;
                columnCount = columns;
                break;
            }
        }
        if (line.next === source.length) break;
        cursor = line.next;
    }
    if (headerStart < 0) return { found: false, rowCount: 0, columnCount: 0, rows: [], headers: [] };

    let rowCount = 0;
    cursor = bodyStart;
    while (cursor < source.length) {
        const line = lineEndAt(cursor);
        const trimmed = trimRange(cursor, line.end);
        if (trimmed.start === trimmed.end || !hasPipe(cursor, line.end)) break;
        rowCount += 1;
        if (line.next === source.length) break;
        cursor = line.next;
    }
    const rowPages = Math.max(1, Math.ceil(rowCount / rowLimit));
    const columnPages = Math.max(1, Math.ceil(columnCount / columnLimit));
    const selectedRowPage = Math.min(wantedRowPage, rowPages);
    const selectedColumnPage = Math.min(wantedColumnPage, columnPages);
    const rowStart = (selectedRowPage - 1) * rowLimit;
    const rowEnd = Math.min(rowCount, rowStart + rowLimit);
    const columnStart = (selectedColumnPage - 1) * columnLimit;
    const columnEnd = Math.min(columnCount, columnStart + columnLimit);
    const headers = [];
    visitCells(headerStart, headerEnd, (index, start, end) => {
        if (index >= columnStart && index < columnEnd) headers.push(displayCell(start, end));
    });
    while (headers.length < columnEnd - columnStart) headers.push('');
    const rows = [];
    cursor = bodyStart;
    let rowIndex = 0;
    while (cursor < source.length && rowIndex < rowEnd) {
        const line = lineEndAt(cursor);
        const trimmed = trimRange(cursor, line.end);
        if (trimmed.start === trimmed.end || !hasPipe(cursor, line.end)) break;
        if (rowIndex >= rowStart) {
            const cells = [];
            visitCells(cursor, line.end, (index, start, end) => {
                if (index >= columnStart && index < columnEnd) cells.push(displayCell(start, end));
            });
            while (cells.length < columnEnd - columnStart) cells.push('');
            if (cells.length > columnEnd - columnStart) cells.length = columnEnd - columnStart;
            rows.push(cells);
        }
        rowIndex += 1;
        if (line.next === source.length) break;
        cursor = line.next;
    }
    return { found: true, rowCount, columnCount, rowPages, columnPages, selectedRowPage, selectedColumnPage,
        rowStart, rowEnd, columnStart, columnEnd, headers, rows };
}

function renderSafeShellTableMessage(session, unit, presentationSelection) {
    const rendering = window.__ocRendering;
    if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
    if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-table') return null;
    const message = unit.value?.message;
    if (!message || message.role !== 'assistant' || message.meta?.isThinking === true || message.meta?.kind || message.meta?.isDiff
        || Array.isArray(message.meta?.images) && message.meta.images.length > 0
        || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0) return null;
    const canonicalMarkdown = typeof message.text === 'string' ? message.text : '';
    const initialSpec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
        page: 1, columnPage: 1, shape: { rowCount: 0, columnCount: 0 } });
    if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.rows || !initialSpec.page?.columns) return null;
    let rowPage = 1;
    let columnPage = 1;
    let scan = scanSafeShellTablePage(canonicalMarkdown, rowPage, columnPage, initialSpec.page.rows, initialSpec.page.columns);
    if (!scan.found) return null;
    const root = document.createElement('div');
    root.className = 'safe-shell';
    root.dataset.safeShellFamily = initialSpec.family;
    root.dataset.messageId = message.id;
    const generation = ++safeShellPresentationGeneration;
    root.dataset.safeShellGeneration = String(generation);
    const ownership = { sessionId: activeSessionId, unitKey: unit.key, generation, root, disposed: false, timers: new Set(), frames: new Set() };
    safeShellMountOwnership.set(root, ownership);
    root._safeShellDispose = () => disposeSafeShellRoot(root);
    const viewerId = `safe-shell-table-viewer-${encodeURIComponent(String(unit.key)).replace(/%/g, '-')}-${generation}`;
    let open = false;
    const scheduleFocus = (role) => {
        let frame = null;
        frame = requestAnimationFrame(() => {
            ownership.frames.delete(frame);
            if (isSafeShellMountCurrent(root, ownership)) root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
        });
        ownership.frames.add(frame);
    };
    const makeButton = (role, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'safe-shell-action';
        button.dataset.safeShellRole = role;
        button.textContent = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isSafeShellMountCurrent(root, ownership)) onClick(button);
        });
        return button;
    };
    const render = () => {
        scan = scanSafeShellTablePage(canonicalMarkdown, rowPage, columnPage, initialSpec.page.rows, initialSpec.page.columns);
        rowPage = scan.selectedRowPage;
        columnPage = scan.selectedColumnPage;
        const spec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
            page: rowPage, columnPage, shape: { rowCount: scan.rowCount, columnCount: scan.columnCount } });
        if (!spec?.allowed || spec.shellSelected !== true) return;
        const heading = document.createElement('div');
        heading.className = 'safe-shell-heading';
        heading.textContent = spec.labels.title;
        const omittedRows = scan.rowCount - (open ? scan.rows.length : 0);
        const omittedColumns = scan.columnCount - (open ? scan.headers.length : 0);
        const status = document.createElement('div');
        status.className = 'safe-shell-status';
        status.dataset.safeShellRole = 'status';
        status.id = `${viewerId}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = `${scan.rowCount} rows and ${scan.columnCount} columns; ${omittedRows} omitted ${omittedRows === 1 ? 'row' : 'rows'} and ${omittedColumns} omitted ${omittedColumns === 1 ? 'column' : 'columns'}${open ? '.' : '; table omitted from collapsed preview.'}`;
        const viewerRegion = document.createElement('div');
        viewerRegion.className = 'safe-shell-viewer-region';
        viewerRegion.dataset.safeShellRole = 'viewer-region';
        viewerRegion.id = viewerId;
        viewerRegion.tabIndex = -1;
        viewerRegion.setAttribute('aria-describedby', status.id);
        if (open) {
            const table = document.createElement('table');
            const caption = document.createElement('caption');
            caption.textContent = `Rows ${scan.rowCount ? scan.rowStart + 1 : 0}–${scan.rowEnd} of ${scan.rowCount}; columns ${scan.columnCount ? scan.columnStart + 1 : 0}–${scan.columnEnd} of ${scan.columnCount}`;
            table.appendChild(caption);
            const thead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            for (const value of scan.headers) {
                const cell = document.createElement('th');
                cell.setAttribute('scope', 'col');
                cell.textContent = value;
                headerRow.appendChild(cell);
            }
            thead.appendChild(headerRow);
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            for (const values of scan.rows) {
                const row = document.createElement('tr');
                for (const value of values) {
                    const cell = document.createElement('td');
                    cell.textContent = value;
                    row.appendChild(cell);
                }
                tbody.appendChild(row);
            }
            table.appendChild(tbody);
            viewerRegion.appendChild(table);
            const rowStatus = document.createElement('span');
            rowStatus.dataset.safeShellRole = 'row-page-status';
            rowStatus.setAttribute('role', 'status');
            rowStatus.textContent = `Rows ${scan.rowCount ? scan.rowStart + 1 : 0}–${scan.rowEnd} of ${scan.rowCount}`;
            viewerRegion.appendChild(rowStatus);
            const columnStatus = document.createElement('span');
            columnStatus.dataset.safeShellRole = 'column-page-status';
            columnStatus.setAttribute('role', 'status');
            columnStatus.textContent = `Columns ${scan.columnCount ? scan.columnStart + 1 : 0}–${scan.columnEnd} of ${scan.columnCount}`;
            viewerRegion.appendChild(columnStatus);
        }
        const actions = document.createElement('div');
        actions.className = 'safe-shell-actions';
        const labels = spec.labels.actions;
        const openButton = makeButton('open-full', labels['open-full'], () => { open = true; render(); scheduleFocus('viewer-region'); });
        openButton.setAttribute('aria-controls', viewerId);
        openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        openButton.disabled = open;
        actions.appendChild(openButton);
        if (open) {
            const rowPrevious = makeButton('row-previous', 'Previous rows', () => { rowPage = Math.max(1, rowPage - 1); render(); scheduleFocus('viewer-region'); });
            rowPrevious.disabled = rowPage <= 1;
            actions.appendChild(rowPrevious);
            const rowNext = makeButton('row-next', 'Next rows', () => { rowPage += 1; render(); scheduleFocus('viewer-region'); });
            rowNext.disabled = rowPage >= scan.rowPages;
            actions.appendChild(rowNext);
            const columnPrevious = makeButton('column-previous', 'Previous columns', () => { columnPage = Math.max(1, columnPage - 1); render(); scheduleFocus('viewer-region'); });
            columnPrevious.disabled = columnPage <= 1;
            actions.appendChild(columnPrevious);
            const columnNext = makeButton('column-next', 'Next columns', () => { columnPage += 1; render(); scheduleFocus('viewer-region'); });
            columnNext.disabled = columnPage >= scan.columnPages;
            actions.appendChild(columnNext);
            actions.appendChild(makeButton('close', labels.close, () => {
                open = false;
                render();
                if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
            }));
        }
        actions.appendChild(makeButton('copy-full', labels['copy-full'], (button) => {
            Promise.resolve(writeTextToClipboard(canonicalMarkdown)).then((copied) => {
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                button.textContent = copied ? 'Copied' : 'Copy failed';
                const timer = setTimeout(() => {
                    ownership.timers.delete(timer);
                    if (!isSafeShellMountCurrent(root, ownership)) return;
                    delete root.dataset.safeShellCopyState;
                    render();
                }, copied ? 900 : 1200);
                ownership.timers.add(timer);
            });
        }));
        root.replaceChildren(heading, status, viewerRegion, actions);
    };
    render();
    return root;
}

function scanSafeShellMarkdownPage(text, requestedPage, pageContract, referenceLimit) {
    const source = typeof text === 'string' ? text : '';
    const wantedPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    const maxReferences = Math.max(1, Number(referenceLimit) || 1);
    let currentPage = 1;
    let currentCodeUnits = 0;
    let currentLines = 1;
    let newlineCount = 0;
    let pageText = '';
    let blockCount = 0;
    let linkCount = 0;
    let tableCount = 0;
    let lineStart = true;
    let lineHasContent = false;
    let previousLineHadContent = false;
    let previousLineHadPipe = false;
    let lineHadPipe = false;
    let lineOnlyDelimiter = true;
    let lineHadDash = false;
    const finishLine = () => {
        if (lineHasContent && !previousLineHadContent) blockCount += 1;
        if (previousLineHadPipe && lineOnlyDelimiter && lineHadDash) tableCount += 1;
        previousLineHadContent = lineHasContent;
        previousLineHadPipe = lineHadPipe;
        lineHasContent = false;
        lineHadPipe = false;
        lineOnlyDelimiter = true;
        lineHadDash = false;
        lineStart = true;
    };
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (currentCodeUnits >= pageContract.maxCodeUnits || (character === '\n' && currentLines >= pageContract.maxLines)) {
            currentPage += 1;
            currentCodeUnits = 0;
            currentLines = 1;
        }
        if (currentPage === wantedPage) pageText += character;
        currentCodeUnits += 1;
        if (character === ']' && source[index + 1] === '(') linkCount += 1;
        if (character === '\n') {
            newlineCount += 1;
            currentLines += 1;
            finishLine();
            continue;
        }
        lineStart = false;
        if (character !== ' ' && character !== '\t' && character !== '\r') lineHasContent = true;
        if (character === '|') lineHadPipe = true;
        if (character === '-') lineHadDash = true;
        if (character !== ' ' && character !== '\t' && character !== '\r' && character !== ':' && character !== '-' && character !== '|') lineOnlyDelimiter = false;
    }
    if (source.length > 0) finishLine();
    const totalPages = source.length > 0 ? currentPage : 1;
    if (wantedPage > totalPages) return scanSafeShellMarkdownPage(source, totalPages, pageContract, maxReferences);
    const pageReferences = [];
    const references = new RegExp(`${FILE_REF_RE.source}|${FILE_ONLY_RE.source}`, 'g');
    let match = references.exec(pageText);
    while (match && pageReferences.length < maxReferences) {
        const filePath = match[1] || match[4] || '';
        if (filePath && isAllowedFileExt(filePath)) pageReferences.push({ filePath, line: match[2] || '', col: match[3] || '', label: match[0] });
        match = references.exec(pageText);
    }
    return { pageText, pageReferences, totalPages, selectedPage: Math.min(wantedPage, totalPages), codeUnitCount: source.length,
        lineCount: source.length > 0 ? newlineCount + 1 : 0, blockCount, linkCount, tableCount };
}

function renderSafeShellMarkdownMessage(session, unit, presentationSelection) {
    const rendering = window.__ocRendering;
    if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
    if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-markdown') return null;
    const message = unit.value?.message;
    if (!message || message.role !== 'assistant' || message.meta?.isThinking === true || message.meta?.kind || message.meta?.isDiff
        || Array.isArray(message.meta?.images) && message.meta.images.length > 0
        || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0) return null;
    const canonicalMarkdown = typeof message.text === 'string' ? message.text : '';
    const initialSpec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
        contentPage: 1, shape: { codeUnitCount: canonicalMarkdown.length, lineCount: canonicalMarkdown.length > 0 ? 1 : 0 } });
    if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;
    const root = document.createElement('div');
    root.className = 'safe-shell';
    root.dataset.safeShellFamily = initialSpec.family;
    root.dataset.messageId = message.id;
    const generation = ++safeShellPresentationGeneration;
    root.dataset.safeShellGeneration = String(generation);
    const ownership = { sessionId: activeSessionId, unitKey: unit.key, generation, root, disposed: false, timers: new Set(), frames: new Set() };
    safeShellMountOwnership.set(root, ownership);
    root._safeShellDispose = () => disposeSafeShellRoot(root);
    const viewerId = `safe-shell-markdown-viewer-${encodeURIComponent(String(unit.key)).replace(/%/g, '-')}-${generation}`;
    const referenceLimit = initialSpec.budgets.openDescendants - initialSpec.budgets.collapsedDescendants;
    let open = false;
    let requestedPage = 1;
    let scan = scanSafeShellMarkdownPage(canonicalMarkdown, requestedPage, initialSpec.page.content, referenceLimit);
    const scheduleFocus = (role) => {
        let frame = null;
        frame = requestAnimationFrame(() => {
            ownership.frames.delete(frame);
            if (isSafeShellMountCurrent(root, ownership)) root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
        });
        ownership.frames.add(frame);
    };
    const makeButton = (role, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'safe-shell-action';
        button.dataset.safeShellRole = role;
        button.textContent = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isSafeShellMountCurrent(root, ownership)) onClick(button);
        });
        return button;
    };
    const render = () => {
        scan = scanSafeShellMarkdownPage(canonicalMarkdown, requestedPage, initialSpec.page.content, referenceLimit);
        requestedPage = scan.selectedPage;
        const spec = rendering.getSafeShellSpec({ mode: presentationSelection.mode, family: presentationSelection.family,
            contentPage: requestedPage, shape: { codeUnitCount: scan.codeUnitCount, lineCount: scan.lineCount } });
        if (!spec?.allowed || spec.shellSelected !== true) return;
        const heading = document.createElement('div');
        heading.className = 'safe-shell-heading';
        heading.textContent = spec.labels.title;
        const status = document.createElement('div');
        status.className = 'safe-shell-status';
        status.dataset.safeShellRole = 'status';
        status.id = `${viewerId}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = `${scan.blockCount} blocks, ${scan.linkCount} links, and ${scan.tableCount} tables; ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; page ${scan.selectedPage} of ${scan.totalPages}${open ? '.' : '; raw markdown omitted from collapsed preview.'}`;
        const viewerRegion = document.createElement('div');
        viewerRegion.className = 'safe-shell-viewer-region';
        viewerRegion.dataset.safeShellRole = 'viewer-region';
        viewerRegion.id = viewerId;
        viewerRegion.setAttribute('aria-describedby', status.id);
        const viewer = document.createElement('pre');
        viewer.className = 'safe-shell-viewer';
        viewer.dataset.safeShellRole = 'viewer';
        viewer.tabIndex = -1;
        viewer.textContent = open ? scan.pageText : '';
        viewerRegion.appendChild(viewer);
        if (open) {
            const pageStatus = document.createElement('span');
            pageStatus.dataset.safeShellRole = 'page-status';
            pageStatus.setAttribute('role', 'status');
            pageStatus.textContent = `Page ${scan.selectedPage} of ${scan.totalPages}`;
            viewerRegion.appendChild(pageStatus);
            if (scan.pageReferences.length > 0) {
                const fileLinks = document.createElement('div');
                for (const reference of scan.pageReferences) {
                    const link = document.createElement('a');
                    const line = reference.line ? `&line=${reference.line}&col=${reference.col || '1'}` : '';
                    link.href = `ocfile://open?path=${encodeURIComponent(reference.filePath)}${line}`;
                    link.textContent = reference.label;
                    link.setAttribute('aria-label', `${spec.labels.actions['open-file']}: ${reference.label}`);
                    fileLinks.appendChild(link);
                }
                viewerRegion.appendChild(fileLinks);
            }
        }
        const actions = document.createElement('div');
        actions.className = 'safe-shell-actions';
        const labels = spec.labels.actions;
        const openButton = makeButton('open-full', labels['open-full'], () => { open = true; render(); scheduleFocus('viewer'); });
        openButton.setAttribute('aria-controls', viewerId);
        openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        openButton.disabled = open;
        actions.appendChild(openButton);
        if (open) {
            const previous = makeButton('previous', labels.previous, () => { requestedPage = Math.max(1, requestedPage - 1); render(); scheduleFocus('viewer'); });
            previous.disabled = requestedPage <= 1;
            actions.appendChild(previous);
            const next = makeButton('next', labels.next, () => { requestedPage += 1; render(); scheduleFocus('viewer'); });
            next.disabled = requestedPage >= scan.totalPages;
            actions.appendChild(next);
            actions.appendChild(makeButton('close', labels.close, () => {
                open = false;
                render();
                if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
            }));
        }
        actions.appendChild(makeButton('copy-full', labels['copy-full'], (button) => {
            Promise.resolve(writeTextToClipboard(canonicalMarkdown)).then((copied) => {
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                button.textContent = copied ? 'Copied' : 'Copy failed';
                const timer = setTimeout(() => {
                    ownership.timers.delete(timer);
                    if (!isSafeShellMountCurrent(root, ownership)) return;
                    delete root.dataset.safeShellCopyState;
                    render();
                }, copied ? 900 : 1200);
                ownership.timers.add(timer);
            });
        }));
        root.replaceChildren(heading, status, viewerRegion, actions);
    };
    render();
    return root;
}

let markdownController = null;

function getMarkdownController() {
    if (markdownController) return markdownController;
    const createController = window.__ocRendering?.createMarkdownController;
    if (typeof createController !== 'function') {
        throw new Error('Markdown rendering controller is unavailable');
    }
    markdownController = createController({
        document,
        renderMarkdown: (text) => md.render(text),
        sanitizeHtml: (html, config) => purify.sanitize(html, config),
        wrapTables,
        linkifyFileRefs,
        highlightElement: (element) => {
            if (window.hljs && typeof window.hljs.highlightElement === 'function') {
                window.hljs.highlightElement(element);
            }
        },
        writeClipboardText: (text) => {
            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                return Promise.reject(new Error('Clipboard API unavailable'));
            }
            return navigator.clipboard.writeText(text);
        },
        startRenderPhase: typeof startChatRenderPhase === 'function' ? startChatRenderPhase : undefined,
        finishRenderPhase: typeof finishChatRenderPhase === 'function' ? finishChatRenderPhase : undefined
    });
    return markdownController;
}

function renderAssistantMarkdown(content, message) {
    getMarkdownController().renderAssistantMarkdown(content, message, shouldLinkifyAssistantMessage(message));
}

function renderUserMarkdown(content, text) {
    getMarkdownController().renderUserMarkdown(content, text);
}

function renderMarkdownInto(element, text, options = {}) {
    getMarkdownController().renderMarkdownInto(element, text, options);
}

function writeTextToClipboard(text) {
    return getMarkdownController().writeTextToClipboard(text);
}

function enhanceCodeBlocksWithCopyButtons(root) {
    getMarkdownController().enhanceCodeBlocksWithCopyButtons(root);
}

function resetCachedCodeBlockCopyEnhancements(root) {
    getMarkdownController().resetCachedCodeBlockCopyEnhancements(root);
}

function getModelStateController() {
    if (modelStateController) return modelStateController;
    const factory = window.__ocFeatures?.createModelState;
    if (typeof factory !== 'function') {
        throw new Error('Model state controller is unavailable');
    }
    modelStateController = factory();
    return modelStateController;
}

function getAttachmentStateController() {
    if (attachmentStateController) return attachmentStateController;
    const factory = window.__ocFeatures?.createAttachmentState;
    if (typeof factory !== 'function') {
        throw new Error('Attachment state controller is unavailable');
    }
    attachmentStateController = factory();
    return attachmentStateController;
}

function getHeaderStateController() {
    if (headerStateController) return headerStateController;
    const factory = window.__ocFeatures?.createHeaderState;
    if (typeof factory !== 'function') {
        throw new Error('Header state controller is unavailable');
    }
    headerStateController = factory('OpenCode: Chat');
    return headerStateController;
}

function getComposerContextStateController() {
    if (composerContextStateController) return composerContextStateController;
    const factory = window.__ocFeatures?.createComposerContextState;
    if (typeof factory !== 'function') {
        throw new Error('Composer context state controller is unavailable');
    }
    composerContextStateController = factory();
    return composerContextStateController;
}

function isCopilotProvider(providerId) {
    return window.__ocFeatures?.isCopilotProvider?.(providerId) === true;
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
    return sessionSearchDomController.elements();
}

function clearSessionSearchHighlights() {
    sessionSearchDomController.clearHighlights();
}

function updateSessionSearchControls() {
    sessionSearchDomController.updateControls();
}

function updateActiveSessionSearchHit({ scroll = false } = {}) {
    sessionSearchDomController.updateActiveHit({ scroll });
}

function pickMode(agent) {
    return window.__ocFeatures.pickSearchAgentMode(agent);
}

function cleanSubagentTitle(title) {
    return window.__ocFeatures.cleanSearchSubagentTitle(title);
}

function formatSubagentModel(agent) {
    return window.__ocFeatures.formatSearchSubagentModel(agent);
}

function visitLoadedChatSearchChunks(session, unit, visitor) {
    return window.__ocFeatures.visitLoadedChatSearchChunks(
        session,
        unit,
        visitor,
        (message) => typeof getAppendItems === 'function' ? getAppendItems(message) : []
    );
}

function createLinearSearchMatcher(query) {
    return window.__ocFeatures.createLinearSearchMatcher(query);
}

function collectBoundedSmartSearchText(produce, cap = 2200, normalizeWhitespace = false) {
    return window.__ocFeatures.collectBoundedSmartSearchText(produce, cap, normalizeWhitespace);
}

function collectLoadedTextSearchKeys(query) {
    const session = getSessionState(activeSessionId, false);
    return window.__ocFeatures.collectLoadedTextSearchKeys({
        query,
        session,
        projectedRows: window.__oc?.getLoadedChatSearchRows?.(String(query || '').trim().toLowerCase()),
        getAppendItems: (message) => typeof getAppendItems === 'function' ? getAppendItems(message) : []
    });
}

function getLoadedSessionSearchText(message) {
    return window.__ocFeatures.getLoadedSessionSearchText(message);
}

function ensureChatWindowKeyMounted(targetKey, reason = 'search') {
    if (!targetKey) return false;
    return window.__oc?.ensureChatWindowKeyMounted?.(targetKey, reason) === true;
}

function keyedRootForSearchKey(key) {
    return sessionSearchDomController.keyedRoot(key);
}

function isSessionSearchTextNode(node, queryLower) {
    return sessionSearchDomController.isTextNode(node, queryLower);
}

function highlightSessionSearchTextNode(node, query, queryLower) {
    sessionSearchDomController.highlightTextNode(node, query, queryLower);
}

function syncActiveTextSearchDomHit(options) {
    sessionSearchDomController.syncActiveTextHit(options);
}

function refreshSessionSearchHighlights({ jumpToFirst = false } = {}) {
    sessionSearchDomController.refreshTextHighlights({ jumpToFirst });
}

function scheduleSessionSearchRefresh({ jumpToFirst = false } = {}) {
    sessionSearchInteractionController.scheduleRefresh({ jumpToFirst });
}

function goToSessionSearchMatch(delta) {
    sessionSearchDomController.navigate(delta);
}

function openSessionSearch() {
    sessionSearchInteractionController.open();
}

function closeSessionSearch() {
    sessionSearchInteractionController.close();
}

function collectSmartSearchMessages() {
    const session = getSessionState(activeSessionId, false);
    return window.__ocFeatures.collectSmartSearchMessages({
        session,
        projectedRows: window.__oc?.getLoadedChatSearchRows?.(),
        getAppendItems: (message) => typeof getAppendItems === 'function' ? getAppendItems(message) : []
    });
}

function applySmartSessionSearchResults(messageIds, { scroll = true } = {}) {
    sessionSearchDomController.applySmartResults(messageIds, { scroll });
}

document.addEventListener('DOMContentLoaded', () => {
    emitCF3RangeDiagnosticMarker();
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
    const chatJumpBottomBtn = document.getElementById('chat-jump-bottom');
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
    const createModelUiController = window.__ocFeatures?.createModelUiController;
    if (typeof createModelUiController !== 'function') {
        throw new Error('Model UI controller is unavailable');
    }
    const modelUiController = createModelUiController({
        state: getModelStateController(),
        document,
        window,
        modelSelect,
        variantSelect,
        sendButton: sendBtn,
        postMessage: (message) => vscode.postMessage(message),
        renderSimpleSelect,
        computePanelWidth: computeModelPanelWidthPx,
        getChevronSvg,
        isBusy: isActiveSessionBusy
    });
    const createAttachmentUiController = window.__ocFeatures?.createAttachmentUiController;
    if (typeof createAttachmentUiController !== 'function') {
        throw new Error('Attachment UI controller is unavailable');
    }
    const attachmentUiController = createAttachmentUiController({
        state: getAttachmentStateController(),
        document,
        listElement: attachmentList
    });
    const createContextTokenUiController = window.__ocFeatures?.createContextTokenUiController;
    if (typeof createContextTokenUiController !== 'function' || !inputTokenList) {
        throw new Error('Composer context token controller is unavailable');
    }
    const contextTokenUiController = createContextTokenUiController({
        state: getComposerContextStateController(),
        document,
        listElement: inputTokenList,
        isAppendActive: () => Boolean(appendInputMode && appendInputMode.sessionId === activeSessionId),
        exitAppend: () => exitAppendInputMode({ restoreDraft: true })
    });
    const createFileMentionController = window.__ocFeatures?.createFileMentionController;
    if (typeof createFileMentionController !== 'function' || !fileMentionList || !input) {
        throw new Error('File mention controller is unavailable');
    }
    const fileMentionController = createFileMentionController({
        contextState: getComposerContextStateController(),
        document,
        window,
        input,
        listElement: fileMentionList,
        postMessage: (message) => vscode.postMessage(message),
        onContextChanged: () => renderContextTokens()
    });
    const buildComposerSubmission = window.__ocFeatures?.buildComposerSubmission;
    if (typeof buildComposerSubmission !== 'function') {
        throw new Error('Composer submission builder is unavailable');
    }
    const createClipboardAttachmentController = window.__ocFeatures?.createClipboardAttachmentController;
    if (typeof createClipboardAttachmentController !== 'function') {
        throw new Error('Clipboard attachment controller is unavailable');
    }
    const clipboardAttachmentController = createClipboardAttachmentController({
        createFileReader: () => new FileReader(),
        postMessage: (message) => vscode.postMessage(message)
    });
    const createComposerInputController = window.__ocFeatures?.createComposerInputController;
    if (typeof createComposerInputController !== 'function') {
        throw new Error('Composer input controller is unavailable');
    }
    const composerInputController = createComposerInputController({
        document,
        input,
        fileMention: fileMentionController,
        clipboard: clipboardAttachmentController,
        isAppendActive: () => Boolean(appendInputMode),
        isAppendDraftActive: () => Boolean(appendInputMode && appendInputMode.sessionId === activeSessionId),
        onAppendDraft: (value) => {
            const session = getSessionState(activeSessionId);
            if (!session || !appendInputMode) return;
            if (!(session.appendComposerDrafts instanceof Map)) {
                session.appendComposerDrafts = new Map();
            }
            session.appendComposerDrafts.set(appendInputMode.rootUserKey, value);
        },
        onRegularDraft: (value) => {
            const session = getSessionState(activeSessionId);
            if (session) session.inputDraft = value;
        },
        onExitAppend: () => exitAppendInputMode({ restoreDraft: true }),
        onCycleMode: () => {
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
        },
        onSend: () => sendBtn.click(),
        onAppendInputChanged: updateSendGate
    });
    const usageEl = document.getElementById('header-usage');
    const usageFillEl = document.getElementById('header-usage-fill');
    const usageLabelEl = document.getElementById('header-usage-label');
    const createHeaderUiController = window.__ocFeatures?.createHeaderUiController;
    if (
        typeof createHeaderUiController !== 'function'
        || !sessionTitle
        || !usageEl
        || !usageFillEl
        || !usageLabelEl
    ) {
        throw new Error('Header UI controller is unavailable');
    }
    const headerState = getHeaderStateController();
    headerState.setBaseTitle(sessionTitle.textContent || 'OpenCode: Chat');
    headerUiController = createHeaderUiController({
        state: headerState,
        titleElement: sessionTitle,
        usageElement: usageEl,
        usageFillElement: usageFillEl,
        usageLabelElement: usageLabelEl,
        getActiveSessionId: () => activeSessionId || '',
        getContextLimit: getSelectedModelContextLimit,
        getRecomputedUsage: (sessionId) => recomputeSessionUsageFromMessages(getSessionState(sessionId)),
        isCompactDisabled: isCompactDisabledForSession,
        compactDisabledTitle: COMPACTION_ACTIVE_SESSION_NOTICE,
        onCompact: (sessionId) => vscode.postMessage({ type: 'compactSession', sessionId })
    });
    headerUiController.install();
    renderHeaderTitle();
    renderHeaderUsage();

    function updateChatJumpBottomButton() {
        if (!chatJumpBottomBtn || !chatContainer) return;
        const hasScrollableDistance = chatContainer.scrollHeight > chatContainer.clientHeight + AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
        chatJumpBottomBtn.classList.toggle('hidden', !hasScrollableDistance || isNearBottom(chatContainer));
    }

    chatJumpBottomBtn?.addEventListener('click', () => {
        chatJumpBottomBtn.classList.add('hidden');
        scrollToBottom(true);
    });

    function handleChatContainerScroll() {
        if (!chatWindowState.programmaticScroll) {
            chatWindowState.userScrollActiveUntil = Date.now() + 180;
            autoScrollPinnedToBottom = isNearBottom(chatContainer);
            if (!autoScrollPinnedToBottom) captureChatWindowAnchor();
        }
        updateChatJumpBottomButton();
        hideQuoteSelectionButton();
    }

    if (chatContainer) {
        if (typeof installChatRenderMetrics === 'function') installChatRenderMetrics(chatContainer);
        autoScrollPinnedToBottom = isNearBottom(chatContainer);
        chatContainer.addEventListener('scroll', () => {
            handleChatContainerScroll();
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
    const hardRescueGenerationToken = document.querySelector('meta[name="opencode-hard-rescue-generation"]')?.getAttribute('content') || '';
    vscode.postMessage({ type: 'ui-debug', payload: ['WV', 'webviewReady', 'id', webviewInstanceId, 'hardRescueGenerationToken', hardRescueGenerationToken || 'none'] });
    vscode.postMessage({ type: 'webviewReady', webviewInstanceId, hardRescueGenerationToken });
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
        modelUiController.ensureQuotaTooltip();
    }

    function updateSendQuotaVisual() {
        modelUiController.updateSendQuotaVisual();
    }

    function showQuotaTooltip() {
        modelUiController.showQuotaTooltip();
    }

    function hideQuotaTooltip() {
        modelUiController.hideQuotaTooltip();
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
        content.textContent = isActiveSessionHistoryLoading()
            ? 'Loading history ...'
            : 'Hello! I am OpenCode. How can I help you today?';
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
        return window.__ocFeatures?.isImageAttachment?.(item) === true;
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
        if (!messageElement) return false;
        if (message?.role !== 'assistant' && message?.role !== 'user') {
            return appendChatRenderRoot(messageElement);
        }
        const row = document.createElement('div');
        row.className = `message-row ${message.role === 'user' ? 'user' : 'bot'}`;
        if (KEYED_CHAT_RECONCILE_ENABLED) row.dataset.renderUnitKey = message.id;
        if (messageElement._hasFollowingTurnDivider === true) {
            const divider = document.createElement('div');
            divider.className = 'turn-divider';
            row.appendChild(divider);
        }
        row.appendChild(messageElement);
        return appendChatRenderRoot(row);
    }

    function renderNestedMessageElement(message) {
        const safeShellDiff = renderSafeShellDiffMessage(getSessionOrNull(activeSessionId), { key: keyedUnitKeyOverride, value: { message } }, keyedPresentationSelectionOverride);
        if (safeShellDiff) return safeShellDiff;
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

const renderMessageElementHost = Object.freeze({
    get KEYED_CHAT_RECONCILE_ENABLED() { return KEYED_CHAT_RECONCILE_ENABLED; },
    get activeSessionId() { return activeSessionId; },
    get appendChatRenderRoot() { return appendChatRenderRoot; },
    get appendHoverActiveKey() { return appendHoverActiveKey; },
    get appendMessageImages() { return appendMessageImages; },
    get appendMessageToChat() { return appendMessageToChat; },
    get attachMessageCopyButton() { return attachMessageCopyButton; },
    get buildAppendHoverKey() { return buildAppendHoverKey; },
    get busySessionId() { return busySessionId; },
    get canAppendToMessage() { return canAppendToMessage; },
    get canUndo() { return canUndo; },
    get changeListRenderer() { return changeListRenderer; },
    get chatContainer() { return chatContainer; },
    get cleanSubagentTitle() { return cleanSubagentTitle; },
    get discardAllSegments() { return discardAllSegments; },
    get enterAppendInputMode() { return enterAppendInputMode; },
    get formatSubagentModel() { return formatSubagentModel; },
    get getAppendItems() { return getAppendItems; },
    get getSessionOrNull() { return getSessionOrNull; },
    get getSessionState() { return getSessionState; },
    get gitUndoEnabled() { return gitUndoEnabled; },
    get handleRestoreSegment() { return handleRestoreSegment; },
    get handleUndoToMessage() { return handleUndoToMessage; },
    get invalidateKeyedChatUnitPresentation() { return invalidateKeyedChatUnitPresentation; },
    get isBusy() { return isBusy; },
    get keyedFollowingTurnDividerOverride() { return keyedFollowingTurnDividerOverride; },
    get logSessionState() { return logSessionState; },
    get logWarning() { return (message, payload) => console.warn(message, payload); },
    get pickMode() { return pickMode; },
    get renderAssistantMarkdown() { return renderAssistantMarkdown; },
    get renderMarkdownInto() { return renderMarkdownInto; },
    get renderNestedInvalidSegmentElement() { return renderNestedInvalidSegmentElement; },
    get renderNestedMessageElement() { return renderNestedMessageElement; },
    get renderUserMarkdown() { return renderUserMarkdown; },
    get requestRerender() { return (reason) => window.__oc?.renderFromState?.(reason); },
    get sanitizeMergedSegmentSnapshot() { return sanitizeMergedSegmentSnapshot; },
    get scheduleClearAppendHover() { return scheduleClearAppendHover; },
    get selectedMode() { return selectedMode; },
    get setAppendHoverActive() { return setAppendHoverActive; },
    get shouldShowBackgroundSubagentIndicator() { return shouldShowBackgroundSubagentIndicator; },
    get stripAttachmentManifest() { return stripAttachmentManifest; },
    get stripSystemInjections() { return stripSystemInjections; },
    get subagentTextExpandedByKey() { return subagentTextExpandedByKey; },
    get toggleUndoSegmentPlaceholder() { return toggleUndoSegmentPlaceholder; },
    get vscode() { return vscode; },
});

function renderMessageElement(message, renderedSet) {
    return window.__ocRendering.renderMessageElement(renderMessageElementHost, message, renderedSet);
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

        const rootAdmission = preflightChatRenderRootAdmission(null, messageId);
        if (!rootAdmission.allowed) {
            scheduleRenderFromState('window-append-fast-path-capacity');
            return bailUserMessageAppendFastPath('window-capacity-declined', [
                ...fields,
                `mounted=${rootAdmission.mountedCount}`,
                `directChildren=${rootAdmission.directChildCount}`,
                ...(tailSafety.fields || [])
            ]);
        }

        const renderedSet = getRenderedMessageIdSetFromDom();
        const beforeChildren = chatContainer.childElementCount;
        const appendFastPathStartedAt = typeof startChatRenderPhase === 'function' ? startChatRenderPhase() : null;
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
        if (typeof finishChatRenderPhase === 'function') finishChatRenderPhase('appendFastPath', appendFastPathStartedAt);
        countUserMessageAppendFastPathResult('success', [...fields, `reason=${tailSafety.reason || 'hidden-tail-safe'}`, `domChildren=${afterChildren}`, `domChildDelta=${domChildDelta}`, 'postAppendAuditMode=identity-tail', `postAppendAuditPassed=${postAppendAuditPassed ? 'true' : 'false'}`, ...(tailSafety.fields || [])]);
        if (isChatWindowAvailable()) scheduleRenderFromState('window-append-fast-path');
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
        const streamPatchStartedAt = typeof startChatRenderPhase === 'function' ? startChatRenderPhase() : null;
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
        const keyedFingerprintAcknowledged = acknowledgeKeyedStreamPatch(session, targetId);
        if (keyedFingerprintAcknowledged && chatWindowState.adapter) {
            const streamPresentation = getKeyedUnitPresentation(session, { key: targetId, kind: 'message', value: { message } });
            chatWindowState.adapter.setPresentationRevision(targetId, window.__ocRendering.presentationFingerprint(streamPresentation));
        }
        chatWindowState.adapter?.invalidateMeasurement?.(targetId);
        if (typeof finishChatRenderPhase === 'function') finishChatRenderPhase('streamPatch', streamPatchStartedAt);
        countAssistantStreamingPatchResult(targetResolution.resolution === 'alias' ? 'post-upgrade-alias-success' : 'success', [...fields, `targetId=${targetId}`, `textLen=${typeof message.text === 'string' ? message.text.length : 0}`, `statusTextLen=${typeof message.meta?.statusText === 'string' ? message.meta.statusText.length : 0}`, `domTail=${afterTailKey || 'null'}`, `keyedFingerprintAcknowledged=${keyedFingerprintAcknowledged}`, ...(targetResolution.fields || [])]);
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

        appendChatRenderRoot(container);
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

    const KEYED_CHAT_RECONCILE_ENABLED = window.__ocKeyedChatReconcileEnabled !== false;
    const TANSTACK_CHAT_WINDOW_ENABLED = window.__ocTanStackChatWindowEnabled !== false;
    const CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = window.__ocChatWindowContainmentPolicyEnabled !== false;
    const CHAT_WINDOW_RECOVERY_ENABLED = window.__ocChatWindowRecoveryEnabled !== false;
    const CHAT_WINDOW_EMERGENCY_ENABLED = window.__ocChatWindowEmergencyEnabled !== false;
    const CHAT_WINDOW_INITIAL_TAIL = 80;
    const CHAT_LOCAL_OLDER_BATCH = 40;
    const CHAT_PENDING_SCROLL_MAX_ATTEMPTS = 4;
    const CHAT_WINDOW_OVERSCAN = 20;
    const CHAT_WINDOW_MOUNT_LIMIT = 140;
    const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;
    const CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED = window.__ocChatWindowAdaptiveRangeEnabled !== false;
    const CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG = Object.freeze({
        enabled: CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED,
        revision: 2,
        pressure: Object.freeze({
            mountedAtLeast: 130, directChildrenAtLeast: 140, descendantsAtLeast: 900,
            renderCostAtLeast: 80, measureCostAtLeast: 70
        }),
        headroom: Object.freeze({
            mountedAtMost: 90, directChildrenAtMost: 96, descendantsAtMost: 400,
            renderCostAtMost: 30, measureCostAtMost: 25
        }),
        pressureConsecutiveIntervals: 2,
        headroomConsecutiveIntervals: 2,
        cooldownIntervals: 2,
        minimumAheadItems: 1,
        minimumBehindItems: 1,
        fastScrollDirectionalReserve: 5
    });
    const CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT = Object.freeze({
        ok: false,
        status: 'window-transaction-unavailable',
        reason: 'missing-begin-transaction'
    });
    const CHAT_WINDOW_CANDIDATE_STALE_RESULT = Object.freeze({
        ok: false,
        status: 'window-candidate-stale',
        reason: 'candidate-owner-stale'
    });
    const CHAT_WINDOW_REQUIRED_TRANSACTION_METHODS = Object.freeze([
        'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
        'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
        'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort'
    ]);
    const CHAT_STRUCTURAL_SURFACE_LIMIT = 6;
    const INIT_NO_MODELS_STRUCTURAL_KEY = 'surface:error:no-model';
    const CHAT_WINDOW_PROJECTED_TOP_SPACER = Object.freeze({ key: 'window:top-spacer' });
    const CHAT_WINDOW_PROJECTED_BOTTOM_SPACER = Object.freeze({ key: 'window:bottom-spacer' });
    const CHAT_WINDOW_PROJECTED_LOCAL_OLDER = Object.freeze({ key: 'window:local-older' });
    const chatStructuralRootReservations = new Set();
    const disposedUnpublishedChatWindowCandidates = new WeakSet();
    const consumedChatWindowStagedAttempts = new WeakSet();
    const unpublishedChatWindowCandidateAcceptedStates = new WeakMap();
    let keyedChatRenderCapture = null;
    let keyedFollowingTurnDividerOverride = null;
    let keyedPresentationSelectionOverride = null;
    let keyedUnitKeyOverride = null;
    let keyedChatReconcileFailure = null;
    let keyedChatFailedSessionId = '';
    let keyedChatReconcileState = { sessionId: '', items: [], roots: new Map() };
    function invalidateKeyedChatUnitPresentation(unitKey) {
        if (!unitKey || keyedChatReconcileState.sessionId !== (activeSessionId || '')) return false;
        let invalidated = false;
        keyedChatReconcileState.items = keyedChatReconcileState.items.map((item) => {
            if (item.key !== unitKey) return item;
            invalidated = true;
            return { ...item, fingerprint: null, streamStableFingerprint: null };
        });
        return invalidated;
    }
    let chatWindowGeneration = 0;
    const B4_SYNTHETIC_EVIDENCE_OPTIONS = Object.freeze([
        Object.freeze({ optionIndex: 0, overscanTier: 20, initialTail: 80, forwardReserve: 13, backwardReserve: 7 }),
        Object.freeze({ optionIndex: 1, overscanTier: 20, initialTail: 40, forwardReserve: 13, backwardReserve: 7 }),
        Object.freeze({ optionIndex: 2, overscanTier: 20, initialTail: 24, forwardReserve: 13, backwardReserve: 7 }),
        Object.freeze({ optionIndex: 3, overscanTier: 10, initialTail: 80, forwardReserve: 7, backwardReserve: 3 }),
        Object.freeze({ optionIndex: 4, overscanTier: 10, initialTail: 40, forwardReserve: 7, backwardReserve: 3 }),
        Object.freeze({ optionIndex: 5, overscanTier: 10, initialTail: 24, forwardReserve: 7, backwardReserve: 3 }),
        Object.freeze({ optionIndex: 6, overscanTier: 4, initialTail: 80, forwardReserve: 3, backwardReserve: 1 }),
        Object.freeze({ optionIndex: 7, overscanTier: 4, initialTail: 40, forwardReserve: 3, backwardReserve: 1 }),
        Object.freeze({ optionIndex: 8, overscanTier: 4, initialTail: 24, forwardReserve: 3, backwardReserve: 1 })
    ]);
    let chatWindowSyntheticEvidenceRequest = null;
    let chatWindowSyntheticEvidenceAttempt = 0;

    function clearChatWindowSyntheticEvidenceRequest() {
        const hadRequest = chatWindowSyntheticEvidenceRequest !== null;
        chatWindowSyntheticEvidenceRequest = null;
        return hadRequest;
    }

    function armChatWindowSyntheticEvidenceRequest(optionIndex) {
        if (!B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED) return null;
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= B4_SYNTHETIC_EVIDENCE_OPTIONS.length) return null;
        const option = B4_SYNTHETIC_EVIDENCE_OPTIONS[optionIndex];
        chatWindowSyntheticEvidenceAttempt += 1;
        const owner = Object.freeze({
            token: Object.freeze({}),
            ownerSessionId: activeSessionId || '__no_session__',
            ownerGeneration: chatWindowGeneration,
            request: Object.freeze({
                optionIndex: option.optionIndex,
                overscanTier: option.overscanTier,
                initialTail: option.initialTail,
                forwardReserve: option.forwardReserve,
                backwardReserve: option.backwardReserve,
                attempt: chatWindowSyntheticEvidenceAttempt
            })
        });
        chatWindowSyntheticEvidenceRequest = owner;
        return owner.token;
    }

    function consumeChatWindowSyntheticEvidenceRequest(token) {
        if (!B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED || !chatWindowSyntheticEvidenceRequest) return null;
        const owner = chatWindowSyntheticEvidenceRequest;
        chatWindowSyntheticEvidenceRequest = null;
        if (owner.token !== token) return null;
        if (owner.ownerSessionId !== (activeSessionId || '__no_session__') || owner.ownerGeneration !== chatWindowGeneration) return null;
        return owner.request;
    }

    if (B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED) {
        Object.defineProperty(window, '__ocChatWindowAdaptiveEvidence', {
            value: Object.freeze({
                arm: armChatWindowSyntheticEvidenceRequest,
                consume: consumeChatWindowSyntheticEvidenceRequest
            }),
            enumerable: false,
            configurable: false,
            writable: false
        });
    }
    let chatWindowAcceptedPlanRevision = 0;
    let chatWindowPlanCorrection = { sessionId: '', generation: -1, planRevision: -1 };
    const chatLocalHistoryController = window.__ocRendering?.createLocalHistoryPresentationController?.({
        initialTailCount: CHAT_WINDOW_INITIAL_TAIL, batchSize: CHAT_LOCAL_OLDER_BATCH, maxSessions: 32
    });
    const chatWindowState = {
        sessionId: '', adapter: null, snapshot: null, allUnits: [], mountedKeys: new Set(),
        topSpacer: null, bottomSpacer: null, anchorKey: '', visualOffset: 0,
        programmaticScroll: false, userScrollActiveUntil: 0, activityBelow: false, rendering: false,
        pendingRangeRender: false, failedSessionId: '', localOlderSurface: null,
        localOlderObserver: null, localOlderObserverArmed: true, pendingScrollKey: '',
        pendingScrollAttempts: 0, localHistoryPresentation: null, acknowledgedRawSnapshot: null
    };
    let chatWindowPressureLifecycle = { current: null, closures: [] };
    let chatWindowAdaptiveShadow = null;
    let chatWindowOuterRecovery = Object.freeze({
        status: 'idle', sessionId: '', generation: -1, reason: 'none', rawIntegrity: null
    });
    let chatWindowEmergencyState = Object.freeze({
        status: 'idle', sessionId: '', generation: -1, root: null, codes: []
    });
    window.__ocChatWindowEmergency = chatWindowEmergencyState;

    function boundedChatAdaptiveCount(value) {
        if (!Number.isFinite(value)) return 0;
        return Math.min(1000000, Math.max(0, Math.trunc(value)));
    }

    function createChatWindowAdaptiveShadowState(generation) {
        return Object.freeze({
            sessionGeneration: boundedChatAdaptiveCount(generation),
            lastDecisionInterval: 0,
            overscanTier: 20,
            initialTail: 80,
            pressureCount: 0,
            headroomCount: 0,
            cooldownRemaining: 0,
            lastSignal: 'none',
            decisionGeneration: 0
        });
    }

    function publishChatWindowAdaptiveShadowTelemetry(result, provenance, overrideReason = '') {
        const state = result?.state || chatWindowAdaptiveShadow?.state || createChatWindowAdaptiveShadowState(chatWindowGeneration);
        const range = result?.range || {};
        const closedReasons = new Set([
            'invalid-input', 'disabled', 'session-reset', 'stale-session', 'duplicate-or-stale-interval',
            'self-churn', 'cooldown', 'neutral', 'pressure-pending', 'headroom-pending',
            'pressure-transition', 'headroom-transition', 'minimum-tier', 'maximum-tier'
        ]);
        const telemetry = Object.freeze({
            enabled: result?.enabled === true,
            allowed: result?.allowed === true,
            configRevision: boundedChatAdaptiveCount(result?.configRevision),
            decisionInterval: boundedChatAdaptiveCount(result?.decisionInterval),
            generation: boundedChatAdaptiveCount(state.sessionGeneration),
            decisionGeneration: boundedChatAdaptiveCount(state.decisionGeneration),
            overscanTier: [20, 10, 4].includes(state.overscanTier) ? state.overscanTier : 20,
            initialTail: [80, 40, 24].includes(state.initialTail) ? state.initialTail : 80,
            pressureCount: boundedChatAdaptiveCount(state.pressureCount),
            headroomCount: boundedChatAdaptiveCount(state.headroomCount),
            cooldownRemaining: boundedChatAdaptiveCount(state.cooldownRemaining),
            decision: ['hold', 'shrink', 'grow'].includes(result?.decision) ? result.decision : 'hold',
            reason: overrideReason || (closedReasons.has(result?.reason) ? result.reason : 'invalid-input'),
            provenance: Object.freeze({
                kind: provenance?.kind === 'self' ? 'self' : 'external',
                decisionGeneration: boundedChatAdaptiveCount(provenance?.decisionGeneration)
            }),
            range: Object.freeze({
                viewportItems: boundedChatAdaptiveCount(range.viewportItems),
                aheadItems: boundedChatAdaptiveCount(range.aheadItems),
                behindItems: boundedChatAdaptiveCount(range.behindItems),
                totalDemand: boundedChatAdaptiveCount(range.totalDemand)
            })
        });
        window.__ocChatWindowAdaptiveShadow = telemetry;
        return telemetry;
    }

    function resetChatWindowAdaptiveShadow(reason = 'reset', expectedGeneration = null) {
        if (expectedGeneration !== null && chatWindowAdaptiveShadow
            && chatWindowAdaptiveShadow.ownerGeneration !== expectedGeneration) return false;
        const generation = boundedChatAdaptiveCount(chatWindowGeneration);
        const state = createChatWindowAdaptiveShadowState(generation);
        chatWindowAdaptiveShadow = Object.freeze({
            ownerSessionId: activeSessionId || '__no_session__',
            ownerGeneration: generation,
            decisionInterval: 0,
            state,
            observations: null
        });
        publishChatWindowAdaptiveShadowTelemetry({
            enabled: typeof CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED !== 'undefined' && CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED,
            allowed: true, configRevision: CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.revision,
            decisionInterval: 0, decision: 'hold', reason, state, range: null
        }, { kind: 'external', decisionGeneration: 0 }, reason);
        return true;
    }

    function resolveChatWindowAdaptiveShadowConfig() {
        const explicitTest = window.__ocChatWindowAdaptiveShadowTestConfig;
        if (!explicitTest || explicitTest.syntheticEnvironment !== true) return CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG;
        return Object.freeze({
            ...CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG,
            enabled: explicitTest.enabled === true,
            revision: boundedChatAdaptiveCount(explicitTest.revision),
            pressure: Object.freeze({ ...CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.pressure, ...(explicitTest.pressure || {}) }),
            headroom: Object.freeze({ ...CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.headroom, ...(explicitTest.headroom || {}) }),
            pressureConsecutiveIntervals: explicitTest.pressureConsecutiveIntervals ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.pressureConsecutiveIntervals,
            headroomConsecutiveIntervals: explicitTest.headroomConsecutiveIntervals ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.headroomConsecutiveIntervals,
            cooldownIntervals: explicitTest.cooldownIntervals ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.cooldownIntervals,
            minimumAheadItems: explicitTest.minimumAheadItems ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.minimumAheadItems,
            minimumBehindItems: explicitTest.minimumBehindItems ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.minimumBehindItems,
            fastScrollDirectionalReserve: explicitTest.fastScrollDirectionalReserve ?? CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG.fastScrollDirectionalReserve
        });
    }

    function observeChatWindowAdaptiveShadow(observations, provenance = null) {
        const ownerSessionId = activeSessionId || '__no_session__';
        const ownerGeneration = boundedChatAdaptiveCount(chatWindowGeneration);
        if (!chatWindowAdaptiveShadow || chatWindowAdaptiveShadow.ownerSessionId !== ownerSessionId
            || chatWindowAdaptiveShadow.ownerGeneration !== ownerGeneration) resetChatWindowAdaptiveShadow('session-reset');
        const decide = window.__ocRendering?.decideChatWindowAdaptivePolicy;
        if (typeof decide !== 'function') return null;
        const selfObservation = provenance?.kind === 'self';
        if (selfObservation && boundedChatAdaptiveCount(provenance?.decisionGeneration)
            !== boundedChatAdaptiveCount(chatWindowAdaptiveShadow.state.decisionGeneration)) return null;
        const countRoles = (roles) => Object.freeze({
            visible: boundedChatAdaptiveCount(roles?.visible),
            core: boundedChatAdaptiveCount(roles?.core),
            currentStreamingAssistant: boundedChatAdaptiveCount(roles?.currentStreamingAssistant),
            thinkingAlias: boundedChatAdaptiveCount(roles?.thinkingAlias),
            pairedActiveUser: boundedChatAdaptiveCount(roles?.pairedActiveUser),
            appendRoot: boundedChatAdaptiveCount(roles?.appendRoot),
            readingAnchor: boundedChatAdaptiveCount(roles?.readingAnchor),
            searchTarget: boundedChatAdaptiveCount(roles?.searchTarget),
            overscan: boundedChatAdaptiveCount(roles?.overscan)
        });
        const measurements = Object.freeze({
            mountedCount: boundedChatAdaptiveCount(observations?.mountedCount),
            directChildCount: boundedChatAdaptiveCount(observations?.directChildCount),
            descendantCount: boundedChatAdaptiveCount(observations?.descendantCount),
            viewportItemDemand: boundedChatAdaptiveCount(observations?.viewportItemDemand),
            renderCost: boundedChatAdaptiveCount(observations?.renderCost),
            measureCost: boundedChatAdaptiveCount(observations?.measureCost),
            projectedStructuralRoots: boundedChatAdaptiveCount(observations?.projectedStructuralRoots),
            currentRequestedCount: boundedChatAdaptiveCount(observations?.currentRequestedCount),
            currentAcceptedCount: boundedChatAdaptiveCount(observations?.currentAcceptedCount)
        });
        const roleOutcomes = Object.freeze({
            accepted: countRoles(observations?.roleOutcomes?.accepted),
            capped: countRoles(observations?.roleOutcomes?.capped),
            deferred: countRoles(observations?.roleOutcomes?.deferred)
        });
        const decisionInterval = boundedChatAdaptiveCount(chatWindowAdaptiveShadow.decisionInterval + 1);
        const taggedProvenance = Object.freeze({
            kind: provenance?.kind === 'self' ? 'self' : 'external',
            decisionGeneration: boundedChatAdaptiveCount(provenance?.decisionGeneration
                ?? chatWindowAdaptiveShadow.state.decisionGeneration)
        });
        const input = Object.freeze({
            config: resolveChatWindowAdaptiveShadowConfig(),
            state: chatWindowAdaptiveShadow.state,
            decisionInterval,
            sessionGeneration: ownerGeneration,
            provenance: taggedProvenance,
            direction: ['forward', 'backward'].includes(observations?.direction) ? observations.direction : 'stationary',
            velocity: ['slow', 'fast'].includes(observations?.velocity) ? observations.velocity : 'idle',
            measurements,
            roleOutcomes,
            syntheticEnvironment: window.__ocChatWindowAdaptiveShadowTestConfig?.syntheticEnvironment === true
        });
        let result;
        try {
            result = decide(input);
        } catch {
            resetChatWindowAdaptiveShadow('facade-exception');
            return null;
        }
        if ((activeSessionId || '__no_session__') !== ownerSessionId
            || boundedChatAdaptiveCount(chatWindowGeneration) !== ownerGeneration) {
            resetChatWindowAdaptiveShadow('stale-owner');
            return null;
        }
        if (!result || typeof result !== 'object' || !result.state || typeof result.state !== 'object') {
            resetChatWindowAdaptiveShadow('policy-result-invalid');
            return null;
        }
        if (selfObservation) {
            chatWindowAdaptiveShadow = Object.freeze({
                ownerSessionId,
                ownerGeneration,
                decisionInterval,
                state: chatWindowAdaptiveShadow.state,
                observations: chatWindowAdaptiveShadow.observations
            });
            return result;
        }
        chatWindowAdaptiveShadow = Object.freeze({
            ownerSessionId,
            ownerGeneration,
            decisionInterval,
            state: result.state,
            observations: Object.freeze({ ...measurements, roleOutcomes })
        });
        publishChatWindowAdaptiveShadowTelemetry(result, taggedProvenance);
        return result;
    }

    function createChatWindowAdaptiveObservations(snapshot, budget = null, requestedCount = 0, acceptedPlan = null, session = null, measureCost = 0) {
        const mountedCount = boundedChatAdaptiveCount(snapshot?.items?.length);
        const directChildCount = boundedChatAdaptiveCount(budget?.directChildren);
        const descendantCount = boundedChatAdaptiveCount(budget?.descendants);
        const projectedStructuralRoots = boundedChatAdaptiveCount(acceptedPlan?.projectedStructuralRoots
            ?? Math.max(0, directChildCount - mountedCount));
        const viewportItemDemand = mountedCount > 0
            ? Math.max(1, Math.min(mountedCount, Math.ceil(boundedChatAdaptiveCount(chatContainer?.clientHeight) / 48) || 1))
            : 0;
        const accepted = new Set(Array.isArray(acceptedPlan?.acceptedKeys) ? acceptedPlan.acceptedKeys : []);
        const roles = {
            visible: viewportItemDemand,
            core: 0,
            currentStreamingAssistant: accepted.has(session?.currentTurnAssistantKey) ? 1 : 0,
            thinkingAlias: accepted.has(session?.thinkingId) ? 1 : 0,
            pairedActiveUser: accepted.has(session?.lastTurnUserId) ? 1 : 0,
            appendRoot: accepted.has(session?.appendRootUserKey) ? 1 : 0,
            readingAnchor: accepted.has(chatWindowState.anchorKey) ? 1 : 0,
            searchTarget: accepted.has(sessionSearch.windowTargetKey) ? 1 : 0,
            overscan: Math.max(0, mountedCount - viewportItemDemand)
        };
        roles.core = roles.currentStreamingAssistant + roles.thinkingAlias + roles.pairedActiveUser + roles.appendRoot;
        const deferred = {
            visible: 0, core: 0, currentStreamingAssistant: 0, thinkingAlias: 0,
            pairedActiveUser: 0, appendRoot: 0, readingAnchor: 0, searchTarget: 0, overscan: 0
        };
        const roleField = {
            'current-streaming-assistant': 'currentStreamingAssistant',
            'thinking-alias': 'thinkingAlias',
            'paired-active-user': 'pairedActiveUser',
            'append-root': 'appendRoot',
            'reading-anchor': 'readingAnchor',
            'search-target': 'searchTarget'
        };
        for (const entry of Array.isArray(acceptedPlan?.deferredPins) ? acceptedPlan.deferredPins.slice(0, 6) : []) {
            const field = roleField[entry?.role];
            if (field) deferred[field] = boundedChatAdaptiveCount(deferred[field] + 1);
        }
        deferred.core = deferred.currentStreamingAssistant + deferred.thinkingAlias + deferred.pairedActiveUser + deferred.appendRoot;
        const capped = {
            visible: 0, core: 0, currentStreamingAssistant: 0, thinkingAlias: 0,
            pairedActiveUser: 0, appendRoot: 0, readingAnchor: 0, searchTarget: 0,
            overscan: Math.max(0, boundedChatAdaptiveCount(requestedCount) - mountedCount)
        };
        return Object.freeze({
            mountedCount,
            directChildCount,
            descendantCount,
            viewportItemDemand,
            renderCost: 0,
            measureCost: boundedChatAdaptiveCount(measureCost),
            projectedStructuralRoots,
            currentRequestedCount: Math.max(boundedChatAdaptiveCount(requestedCount), viewportItemDemand + 2),
            currentAcceptedCount: Math.max(mountedCount, viewportItemDemand + 2),
            roleOutcomes: Object.freeze({
                accepted: Object.freeze(roles), capped: Object.freeze(capped), deferred: Object.freeze(deferred)
            })
        });
    }

    function resolveChatWindowAdaptiveRangePolicy() {
        if (typeof CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED === 'undefined' || !CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED
            || typeof chatWindowAdaptiveShadow === 'undefined' || !chatWindowAdaptiveShadow) return undefined;
        const ownerSessionId = activeSessionId || '__no_session__';
        if (chatWindowAdaptiveShadow.ownerSessionId !== ownerSessionId
            || chatWindowAdaptiveShadow.ownerGeneration !== boundedChatAdaptiveCount(chatWindowGeneration)) return undefined;
        const state = chatWindowAdaptiveShadow.state;
        const overscanTier = [20, 10, 4].includes(state?.overscanTier) ? state.overscanTier : CHAT_WINDOW_OVERSCAN;
        const initialTail = [80, 40, 24].includes(state?.initialTail) ? state.initialTail : CHAT_WINDOW_INITIAL_TAIL;
        const beforeReserve = overscanTier === 20 ? 7 : overscanTier === 10 ? 3 : 1;
        return Object.freeze({
            overscanTier,
            beforeReserve,
            afterReserve: overscanTier - beforeReserve,
            initialTail
        });
    }

    resetChatWindowAdaptiveShadow('initial');

    function captureChatWindowAcceptedState() {
        const directChildren = Array.from(chatContainer.children);
        const acceptedNodes = new Set([
            ...directChildren,
            ...chatStructuralRootReservations,
            chatWindowState.topSpacer,
            chatWindowState.bottomSpacer,
            chatWindowState.localOlderSurface
        ].filter(Boolean));
        const nodeStates = new Map(Array.from(acceptedNodes).map((root) => [root, {
            dataset: { ...(root.dataset || {}) },
            style: root.getAttribute?.('style') ?? null,
            children: Array.from(root.childNodes || [])
        }]));
        const windowGlobals = {};
        for (const name of [
            '__ocKeyedChatLastReconcile', '__ocChatWindowLastBudget', '__ocChatWindowDomBudgetAudit',
            '__ocChatWindowRecovery'
        ]) {
            windowGlobals[name] = { owned: Object.prototype.hasOwnProperty.call(window, name), value: window[name] };
        }
        return {
            directChildren,
            nodeStates,
            chatWindowValues: Object.fromEntries(Object.keys(chatWindowState).map((key) => [key, chatWindowState[key]])),
            keyedState: {
                sessionId: keyedChatReconcileState.sessionId,
                items: keyedChatReconcileState.items,
                roots: new Map(keyedChatReconcileState.roots)
            },
            chatStructuralRootReservations: new Set(chatStructuralRootReservations),
            chatWindowAcceptedPlanRevision,
            chatWindowPlanCorrection,
            keyedChatReconcileFailure,
            conflictCardEl,
            conflictShellPresentationGeneration,
            chatWindowGeneration,
            pressureLifecycleCurrent: chatWindowPressureLifecycle.current,
            pressureLifecycleClosures: chatWindowPressureLifecycle.closures,
            metricsPressureLifecycle: typeof chatRenderMetrics !== 'undefined'
                ? { owned: Object.prototype.hasOwnProperty.call(chatRenderMetrics, 'pressureLifecycle'), value: chatRenderMetrics.pressureLifecycle }
                : null,
            chatRenderMetricsDirty,
            scrollTop: chatContainer.scrollTop,
            className: chatContainer.getAttribute?.('class') ?? null,
            windowGlobals
        };
    }

    function restoreChatContainerChildren(children) {
        chatContainer.replaceChildren(...children);
    }

    function restoreChatWindowAcceptedState(acceptedState) {
        const attemptedAdapter = chatWindowState.adapter;
        const retainedAdapter = acceptedState.chatWindowValues.adapter;
        const attemptedObserver = chatWindowState.localOlderObserver;
        const retainedObserver = acceptedState.chatWindowValues.localOlderObserver;
        if (attemptedObserver && attemptedObserver !== retainedObserver) attemptedObserver.disconnect?.();
        if (attemptedAdapter && attemptedAdapter !== retainedAdapter) attemptedAdapter.destroy?.();
        restoreChatContainerChildren(acceptedState.directChildren);
        for (const [root, state] of acceptedState.nodeStates) {
            if (root.dataset) {
                for (const key of Object.keys(root.dataset)) if (!Object.prototype.hasOwnProperty.call(state.dataset, key)) delete root.dataset[key];
                Object.assign(root.dataset, state.dataset);
            }
            if (root.setAttribute && root.removeAttribute) {
                if (state.style === null) root.removeAttribute('style');
                else root.setAttribute('style', state.style);
            }
            if (root === acceptedState.chatWindowValues.localOlderSurface) root.replaceChildren?.(...state.children);
        }
        for (const [key, value] of Object.entries(acceptedState.chatWindowValues)) chatWindowState[key] = value;
        keyedChatReconcileState = {
            sessionId: acceptedState.keyedState.sessionId,
            items: acceptedState.keyedState.items,
            roots: new Map(acceptedState.keyedState.roots)
        };
        chatStructuralRootReservations.clear();
        for (const root of acceptedState.chatStructuralRootReservations) chatStructuralRootReservations.add(root);
        chatWindowAcceptedPlanRevision = acceptedState.chatWindowAcceptedPlanRevision;
        chatWindowPlanCorrection = acceptedState.chatWindowPlanCorrection;
        keyedChatReconcileFailure = acceptedState.keyedChatReconcileFailure;
        conflictCardEl = acceptedState.conflictCardEl;
        conflictShellPresentationGeneration = acceptedState.conflictShellPresentationGeneration;
        chatWindowGeneration = acceptedState.chatWindowGeneration;
        chatWindowPressureLifecycle.current = acceptedState.pressureLifecycleCurrent;
        chatWindowPressureLifecycle.closures = acceptedState.pressureLifecycleClosures;
        if (acceptedState.metricsPressureLifecycle && typeof chatRenderMetrics !== 'undefined') {
            if (acceptedState.metricsPressureLifecycle.owned) chatRenderMetrics.pressureLifecycle = acceptedState.metricsPressureLifecycle.value;
            else delete chatRenderMetrics.pressureLifecycle;
        }
        chatRenderMetricsDirty = acceptedState.chatRenderMetricsDirty;
        chatContainer.scrollTop = acceptedState.scrollTop;
        if (chatContainer.setAttribute && chatContainer.removeAttribute) {
            if (acceptedState.className === null) chatContainer.removeAttribute('class');
            else chatContainer.setAttribute('class', acceptedState.className);
        }
        for (const [name, record] of Object.entries(acceptedState.windowGlobals)) {
            if (record.owned) window[name] = record.value;
            else delete window[name];
        }
        if (retainedObserver && acceptedState.chatWindowValues.localOlderSurface) {
            retainedObserver.observe?.(acceptedState.chatWindowValues.localOlderSurface);
        }
    }

    function beginChatPresentationJournal(acceptedState = captureChatWindowAcceptedState(), reconcileSessionId = '') {
        return {
            acceptedState,
            reconcileSessionId,
            preparedRoots: new Set(),
            supersededRoots: new Set(),
            disposedPreparedRoots: new Set(),
            disposedSupersededRoots: new Set(),
            cleanupRemovals: [],
            adapterTransaction: null,
            completion: { cleanupRecorded: new Set(), localComplete: false, degraded: false },
            aborted: false,
            finalized: false
        };
    }

    function disposePreparedChatRoot(journal, root) {
        if (!root || journal.disposedPreparedRoots.has(root)) return;
        journal.disposedPreparedRoots.add(root);
        root._safeShellDispose?.();
    }

    function disposeSupersededChatRoot(journal, root) {
        if (!root || journal.disposedSupersededRoots.has(root)) return;
        journal.disposedSupersededRoots.add(root);
        root._safeShellDispose?.();
    }

    function abortChatPresentationJournal(journal) {
        if (!journal || journal.aborted || journal.finalized) return false;
        journal.adapterTransaction?.abort?.();
        for (const root of journal.preparedRoots) disposePreparedChatRoot(journal, root);
        restoreChatContainerChildren(journal.acceptedState.directChildren);
        restoreChatWindowAcceptedState(journal.acceptedState);
        journal.aborted = true;
        return true;
    }

    function finalizeChatPresentationJournal(journal) {
        if (!journal || journal.aborted || journal.finalized) return false;
        for (const root of journal.supersededRoots) {
            try { disposeSupersededChatRoot(journal, root); } catch { journal.completion.degraded = true; }
        }
        for (let index = 0; index < journal.cleanupRemovals.length; index += 1) {
            if (journal.completion.cleanupRecorded.has(index)) continue;
            journal.completion.cleanupRecorded.add(index);
            try {
                const root = journal.cleanupRemovals[index];
                const residual = root?.parentElement === chatContainer ? 1 : 0;
                recordChatWindowCleanupCheckpoint('removal', chatWindowGeneration, 1, residual ? 0 : 1, residual);
            } catch { journal.completion.degraded = true; }
        }
        if (!journal.completion.localComplete) {
            journal.completion.localComplete = true;
            try { chatLocalHistoryController.complete(journal.reconcileSessionId); } catch { journal.completion.degraded = true; }
        }
        journal.finalized = true;
        return true;
    }

    function runChatPresentationFailureSeam(stage, detail = null) {
        window.__ocChatPresentationFailureSeam?.(stage, detail);
    }

    function appendChatRenderRoot(root) {
        if (keyedChatRenderCapture) {
            keyedChatRenderCapture.appendChild(root);
            return true;
        }
        const admission = preflightChatRenderRootAdmission(root);
        if (!admission.allowed) return false;
        if (chatWindowState.bottomSpacer?.parentElement === chatContainer) {
            chatContainer.insertBefore(root, chatWindowState.bottomSpacer);
        } else {
            chatContainer.appendChild(root);
        }
        chatStructuralRootReservations.delete(root);
        return true;
    }

    function reserveChatStructuralRoot(root) {
        if (root && root.parentElement !== chatContainer) chatStructuralRootReservations.add(root);
        return root;
    }

    function classifyChatStructuralSurface(root, key, owner) {
        root.dataset.chatStructuralKey = key;
        root.dataset.chatStructuralOwner = owner;
        const connectedIncrement = root.parentElement === chatContainer ? 0 : 1;
        const structuralCount = chatContainer.querySelectorAll(':scope > [data-chat-structural-key]').length + connectedIncrement;
        if (structuralCount > CHAT_STRUCTURAL_SURFACE_LIMIT) {
            console.warn('[Render] structural surface limit exceeded', structuralCount, CHAT_STRUCTURAL_SURFACE_LIMIT);
        }
        return root;
    }

    function showInitNoModelsError() {
        const existingError = chatContainer.querySelector(`:scope > [data-chat-structural-key="${INIT_NO_MODELS_STRUCTURAL_KEY}"]`);
        const errorDiv = existingError || document.createElement('div');
        reserveChatStructuralRoot(errorDiv);
        errorDiv.className = 'message system error';
        errorDiv.style.color = 'red';
        errorDiv.textContent = 'Error: No models available. Please check your OpenCode configuration.';
        classifyChatStructuralSurface(errorDiv, INIT_NO_MODELS_STRUCTURAL_KEY, 'init:no-models');
        if (!existingError) appendChatRenderRoot(errorDiv);
        else chatStructuralRootReservations.delete(errorDiv);
        return errorDiv;
    }

    function getSubagentExpansionPresentation(message) {
        const entries = [];
        const subagents = Array.isArray(message?.meta?.subagents) ? message.meta.subagents : [];
        for (const agent of subagents) {
            const subagentIdentity = agent?.agentSessionId || agent?.sessionId || agent?.taskId || '';
            const parentIdentity = agent?.parentSessionId || message?.sessionId || activeSessionId || '';
            const messageIdentity = message?.id || message?.messageId || '';
            const lookupKey = subagentIdentity ? `${parentIdentity}:${messageIdentity}:${subagentIdentity}` : '';
            entries.push({ lookupKey, expanded: lookupKey ? subagentTextExpandedByKey.get(lookupKey) === true : false });
        }
        return entries;
    }

    function getUndoSegmentPlaceholderPresentation(session, message) {
        const isPlaceholder = message?.meta?.kind === 'undoSegmentPlaceholder'
            || message?.id?.startsWith?.('system:undo-seg:');
        if (!isPlaceholder) return null;
        const noticeKey = message?.meta?.noticeKey || message?.id?.replace?.('system:undo-seg:', '') || '';
        const segment = noticeKey ? session?.segmentsByNoticeKey?.get?.(noticeKey) : null;
        if (!segment) return null;
        return {
            noticeKey,
            collapsed: segment.collapsed !== false,
            restoreAllowed: segment.restoreAllowed,
            anchorMsgId: segment.anchorMsgId,
            endMsgId: segment.endMsgId,
            memberMsgIds: Array.isArray(segment.memberMsgIds)
                ? segment.memberMsgIds
                : Array.from(segment.memberIds || []),
            mergedInvalidSegments: segment.mergedInvalidSegments || []
        };
    }

    function getKeyedUnitPresentation(session, unit) {
        if (unit.kind === 'greeting') {
            return {
                text: unit.value?.text || 'Hello! I am OpenCode. How can I help you today?',
                sessionId: activeSessionId || ''
            };
        }
        if (unit.kind === 'conflict') return { payload: unit.value, sessionId: activeSessionId || '' };
        if (unit.kind === 'segment') {
            const segment = unit.value?.segment;
            return {
                sessionId: activeSessionId || '', key: unit.key, state: segment?.state,
                isExpanded: segment?.isExpanded === true, collapsed: segment?.collapsed !== false,
                restoreAllowed: segment?.restoreAllowed, anchorMsgId: segment?.anchorMsgId,
                endMsgId: segment?.endMsgId,
                memberMsgIds: Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : Array.from(segment?.memberIds || []),
                mergedInvalidSegments: segment?.mergedInvalidSegments || []
            };
        }
        const message = unit.value?.message;
        return {
            sessionId: activeSessionId || '', key: unit.key, role: message?.role, text: message?.text,
            parentId: message?.parentId || message?.parentID, meta: message?.meta || {}, appendItems: getAppendItems(message),
            undoSegment: getUndoSegmentPlaceholderPresentation(session, message),
            actions: {
                canAppend: canAppendToMessage(session, message), canUndo: message?.role === 'user' && gitUndoEnabled,
                busy: isBusy, appendHoverActive: appendHoverActiveKey === buildAppendHoverKey(activeSessionId, message?.id)
            },
            backgroundSubagent: shouldShowBackgroundSubagentIndicator(session, message),
            subagentExpansion: getSubagentExpansionPresentation(message)
        };
    }

    function getKeyedStreamStablePresentation(presentation) {
        const meta = { ...(presentation?.meta || {}) };
        delete meta.statusText;
        delete meta.currentSegment;
        delete meta.textSegments;
        return { ...presentation, key: { $unitIdentityOwned: true }, text: { $streamOwned: true }, meta };
    }

    function getKeyedPresentationIdentity(presentation, presentationSelection) {
        return {
            presentation,
            mode: presentationSelection?.mode || 'normal-rich',
            family: presentationSelection?.family || ''
        };
    }

    function acknowledgeKeyedStreamPatch(session, targetId) {
        if (!KEYED_CHAT_RECONCILE_ENABLED || !window.__ocRendering) return false;
        if (!session || keyedChatReconcileState.sessionId !== activeSessionId) return false;
        const itemIndex = keyedChatReconcileState.items.findIndex((item) => item.key === targetId);
        if (itemIndex < 0 || !keyedRootForKey(targetId)) return false;
        const message = session.messagesById?.get?.(targetId);
        if (!message) return false;
        const currentPresentation = getKeyedUnitPresentation(session, {
            key: targetId,
            kind: 'message',
            value: { message }
        });
        const rendering = window.__ocRendering;
        const cachedItem = keyedChatReconcileState.items[itemIndex];
        const presentationSelection = cachedItem.presentationSelection;
        const currentStreamStableFingerprint = rendering.presentationFingerprint(getKeyedPresentationIdentity(
            getKeyedStreamStablePresentation(currentPresentation),
            presentationSelection
        ));
        if (cachedItem.streamStableFingerprint !== currentStreamStableFingerprint) return false;
        const nextItem = {
            ...cachedItem,
            fingerprint: rendering.presentationFingerprint(getKeyedPresentationIdentity(currentPresentation, presentationSelection)),
            streamStableFingerprint: currentStreamStableFingerprint
        };
        keyedChatReconcileState.items = keyedChatReconcileState.items.map((item, index) => index === itemIndex ? nextItem : item);
        return true;
    }

    function buildKeyedRenderCandidates(session) {
        const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
        if (!session || timeline.length === 0) {
            const loadingHistory = isActiveSessionHistoryLoading();
            return [{
                key: loadingHistory ? `history-loading:${activeSessionId}` : `greeting:${activeSessionId || 'none'}`,
                kind: 'greeting',
                value: loadingHistory ? { text: 'Loading history ...' } : null
            }];
        }
        const appendChildPresentationIndex = buildAppendChildPresentationIndex(session);
        const candidates = [];
        let hasVisibleUser = false;
        for (const id of timeline) {
            const message = session.messagesById.get(id);
            if (!message) continue;
            const segment = typeof id === 'string' && id.startsWith('system:undo:')
                ? session.segmentsByNoticeKey.get(id)
                : null;
            const sanitizedUserText = message.role === 'user'
                ? stripSystemInjections(stripAttachmentManifest(message.text || ''))
                : '';
            const emptyChangeList = message.meta?.kind === 'changeList'
                && (!Array.isArray(message.meta?.files) || message.meta.files.length === 0);
            const candidate = {
                key: id,
                kind: segment ? 'segment' : (message.meta?.kind === 'changeList' ? 'change-list' : 'message'),
                value: segment ? { segment } : { message, hasPriorUser: hasVisibleUser },
                hidden: !segment && (session.hiddenSet.has(id) || emptyChangeList),
                appendChildHidden: !segment && isAppendChildTopLevelUser(session, message, id, appendChildPresentationIndex),
                appendAssistantHidden: !segment && isAppendChainTopLevelAssistantHidden(session, message, id, appendChildPresentationIndex),
                dcpHidden: !segment && shouldHideDcpUiMessage(message),
                emptyUserText: message.role === 'user' && !sanitizedUserText.trim()
            };
            candidates.push(candidate);
            if (!candidate.hidden && !candidate.appendChildHidden && !candidate.appendAssistantHidden && !candidate.dcpHidden && !candidate.emptyUserText && message.role === 'user') {
                hasVisibleUser = true;
            }
        }
        if (lastConflictPayload && lastConflictPayload.sessionId === activeSessionId) {
            const identity = lastConflictPayload.conflictId || lastConflictPayload.operationId || 'active';
            candidates.push({ key: `conflict:${activeSessionId || 'none'}:${identity}`, kind: 'conflict', value: lastConflictPayload });
        }
        return candidates;
    }

    let safeShellPresentationGeneration = 0;
    const safeShellMountOwnership = new WeakMap();

    function forEachSafeShellUserCanonicalPart(message, visitor) {
        const raw = typeof message?.text === 'string' ? message.text : '';
        const mainText = stripSystemInjections(stripAttachmentManifest(raw)).trim();
        let hasPriorPart = false;
        let appendedCount = 0;
        if (mainText) {
            visitor(mainText);
            hasPriorPart = true;
        }
        for (const item of getAppendItems(message)) {
            if (!item || typeof item.text !== 'string') continue;
            const text = item.text.trim();
            if (!text) continue;
            if (hasPriorPart) visitor('\n\n');
            visitor(text);
            hasPriorPart = true;
            appendedCount += 1;
        }
        return { appendedCount, hasContent: hasPriorPart };
    }

    function scanSafeShellTextPage(message, requestedPage, pageContract) {
        const maxCodeUnits = pageContract.maxCodeUnits;
        const maxLines = pageContract.maxLines;
        let currentPage = 1;
        let currentPageCodeUnits = 0;
        let currentPageLines = 1;
        let codeUnitCount = 0;
        let newlineCount = 0;
        let pageText = '';
        const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
        const consume = (text) => {
            for (let index = 0; index < text.length; index += 1) {
                const character = text[index];
                if (currentPageCodeUnits >= maxCodeUnits || (character === '\n' && currentPageLines >= maxLines)) {
                    currentPage += 1;
                    currentPageCodeUnits = 0;
                    currentPageLines = 1;
                }
                if (currentPage === page) pageText += character;
                currentPageCodeUnits += 1;
                codeUnitCount += 1;
                if (character === '\n') {
                    currentPageLines += 1;
                    newlineCount += 1;
                }
            }
        };
        const canonical = forEachSafeShellUserCanonicalPart(message, consume);
        const totalPages = canonical.hasContent ? currentPage : 1;
        return {
            pageText,
            totalPages,
            codeUnitCount,
            lineCount: canonical.hasContent ? newlineCount + 1 : 0,
            appendedCount: canonical.appendedCount
        };
    }

    function scanSafeShellAssistantTextPage(text, requestedPage, pageContract, referenceLimit) {
        const maxCodeUnits = pageContract.maxCodeUnits;
        const maxLines = pageContract.maxLines;
        const maxReferences = Math.max(1, referenceLimit);
        const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
        let currentPage = 1;
        let currentPageCodeUnits = 0;
        let currentPageLines = 1;
        let currentPageReferences = 0;
        let newlineCount = 0;
        let pageText = '';
        let referenceCount = 0;
        const pageReferences = [];
        const nextPage = () => {
            currentPage += 1;
            currentPageCodeUnits = 0;
            currentPageLines = 1;
            currentPageReferences = 0;
        };
        const consumeRange = (start, end) => {
            for (let index = start; index < end; index += 1) {
                const character = text[index];
                if (currentPageCodeUnits >= maxCodeUnits || (character === '\n' && currentPageLines >= maxLines)) {
                    nextPage();
                }
                if (currentPage === page) pageText += character;
                currentPageCodeUnits += 1;
                if (character === '\n') {
                    currentPageLines += 1;
                    newlineCount += 1;
                }
            }
        };
        let cursor = 0;
        while (cursor < text.length) {
            const newline = text.indexOf('\n', cursor);
            const lineEnd = newline === -1 ? text.length : newline;
            const lineText = text.slice(cursor, lineEnd);
            const mayContainReference = lineText.includes('/') || lineText.includes(':');
            if (mayContainReference) {
                const references = new RegExp(`${FILE_REF_RE.source}|${FILE_ONLY_RE.source}`, 'g');
                let lineCursor = 0;
                let match = references.exec(lineText);
                while (match) {
                    consumeRange(cursor + lineCursor, cursor + match.index);
                    const filePath = match[1] || match[4] || '';
                    if (filePath && isAllowedFileExt(filePath)) {
                        if (currentPageReferences >= maxReferences) nextPage();
                        const line = match[2] || '';
                        const col = match[3] || '';
                        if (currentPage === page) pageReferences.push({ filePath, line, col, label: match[0] });
                        currentPageReferences += 1;
                        referenceCount += 1;
                    }
                    consumeRange(cursor + match.index, cursor + references.lastIndex);
                    lineCursor = references.lastIndex;
                    match = references.exec(lineText);
                }
                consumeRange(cursor + lineCursor, lineEnd);
            } else {
                consumeRange(cursor, lineEnd);
            }
            if (newline === -1) break;
            consumeRange(newline, newline + 1);
            cursor = newline + 1;
        }
        return {
            pageText,
            pageReferences,
            totalPages: text.length > 0 ? currentPage : 1,
            codeUnitCount: text.length,
            lineCount: text.length > 0 ? newlineCount + 1 : 0,
            referenceCount
        };
    }

    function isSafeShellMountCurrent(root, ownership) {
        if (!root || !ownership || ownership.disposed === true) return false;
        if (activeSessionId !== ownership.sessionId
            || root.dataset.safeShellGeneration !== String(ownership.generation)
            || safeShellMountOwnership.get(root) !== ownership
            || !root.isConnected) return false;
        const keyedRoot = keyedRootForKey(ownership.unitKey);
        let current = root;
        while (current && current !== keyedRoot) current = current.parentElement;
        return current === keyedRoot;
    }

    function disposeSafeShellRoot(root) {
        if (!root) return;
        const ownership = safeShellMountOwnership.get(root);
        if (!ownership || ownership.disposed === true) return;
        ownership.disposed = true;
        for (const timer of ownership.timers) clearTimeout(timer);
        for (const frame of ownership.frames) cancelAnimationFrame(frame);
        ownership.timers.clear();
        ownership.frames.clear();
        safeShellMountOwnership.delete(root);
    }

    function renderSafeShellImageMessage(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-image') return null;
        const message = unit.value?.message;
        const images = Array.isArray(message?.meta?.images) ? message.meta.images : [];
        if (!message || (message.role !== 'user' && message.role !== 'assistant') || images.length === 0) return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            page: 1,
            shape: { imageCount: images.length }
        });
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.primary) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        let open = false;
        let imagePage = 1;
        let pageToken = 0;

        const makeButton = (roleName, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = roleName;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!button.isConnected || !isSafeShellMountCurrent(root, ownership)) return;
                onClick();
            });
            return button;
        };

        const render = () => {
            const token = ++pageToken;
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                page: imagePage,
                shape: { imageCount: images.length }
            });
            if (!spec?.allowed || spec.shellSelected !== true || !spec.page?.primary) return;
            imagePage = spec.page.primary.index;
            const imageIndex = spec.page.primary.start;

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.textContent = open
                ? `${images.length} images; showing image ${imageIndex + 1} of ${images.length}.`
                : `${images.length} images; none loaded in the collapsed preview. Open full to view one image at a time.`;

            const viewerRegion = document.createElement('div');
            viewerRegion.className = 'safe-shell-viewer-region';
            viewerRegion.dataset.safeShellRole = 'viewer-region';
            viewerRegion.id = viewerId;
            viewerRegion.setAttribute('aria-describedby', status.id);
            if (open) {
                const imageStatus = document.createElement('span');
                imageStatus.className = 'safe-shell-page-status';
                imageStatus.dataset.safeShellRole = 'image-status';
                imageStatus.setAttribute('role', 'status');
                imageStatus.textContent = `Image ${imageIndex + 1} of ${images.length}`;
                viewerRegion.appendChild(imageStatus);

                const src = images[imageIndex];
                if (typeof src === 'string' && src.length > 0) {
                    const img = document.createElement('img');
                    img.src = src;
                    img.alt = `Attachment ${imageIndex + 1}`;
                    img.loading = 'lazy';
                    const isCurrentImageCallback = () => isSafeShellMountCurrent(root, ownership)
                        && pageToken === token
                        && imagePage === imageIndex + 1
                        && img.parentElement === viewerRegion;
                    img.addEventListener('load', () => {
                        if (!isCurrentImageCallback()) return;
                        img.dataset.safeShellImageState = 'loaded';
                    }, { once: true });
                    img.addEventListener('error', () => {
                        if (!isCurrentImageCallback()) return;
                        const fallback = document.createElement('div');
                        fallback.className = 'message-image-missing';
                        fallback.dataset.safeShellRole = 'image-fallback';
                        fallback.textContent = 'Image unavailable';
                        viewerRegion.replaceChild(fallback, img);
                    }, { once: true });
                    viewerRegion.appendChild(img);
                } else {
                    const fallback = document.createElement('div');
                    fallback.className = 'message-image-missing';
                    fallback.dataset.safeShellRole = 'image-fallback';
                    fallback.textContent = 'Image unavailable';
                    viewerRegion.appendChild(fallback);
                }
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                if (open) return;
                open = true;
                render();
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    imagePage = Math.max(1, imagePage - 1);
                    render();
                });
                previous.disabled = spec.page.primary.hasPrevious !== true;
                actions.appendChild(previous);
                const next = makeButton('next', actionLabels.next, () => {
                    imagePage += 1;
                    render();
                });
                next.disabled = spec.page.primary.hasNext !== true;
                actions.appendChild(next);
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) {
                        root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                    }
                }));
            }
            root.replaceChildren(heading, status, viewerRegion, actions);
        };

        render();
        return root;
    }

    function renderSafeShellUserMessage(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-user') return null;
        const message = unit.value?.message;
        if (!message || message.role !== 'user') return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            shape: {}
        });
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        let open = false;
        let requestedPage = 1;

        const scheduleFocus = (role) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };

        const makeButton = (role, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = role;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };

        const render = () => {
            const scan = scanSafeShellTextPage(message, requestedPage, initialSpec.page.content);
            requestedPage = Math.min(requestedPage, scan.totalPages);
            const descriptorShape = {
                codeUnitCount: ((scan.totalPages - 1) * initialSpec.page.content.maxCodeUnits) + 1,
                lineCount: 1
            };
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                contentPage: requestedPage,
                shape: descriptorShape
            });
            if (!spec?.allowed || spec.shellSelected !== true) return;

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const imageCount = Array.isArray(message?.meta?.images) ? message.meta.images.length : 0;
            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.textContent = open
                ? `${spec.labels.page}; ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; ${scan.appendedCount} appended prompts; ${imageCount} images.`
                : `Full content omitted from the collapsed preview: ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; ${scan.appendedCount} appended prompts; ${imageCount} images. Open full for bounded paging.`;

            const viewerRegion = document.createElement('div');
            viewerRegion.className = 'safe-shell-viewer-region';
            viewerRegion.dataset.safeShellRole = 'viewer-region';
            viewerRegion.id = viewerId;
            viewerRegion.setAttribute('aria-describedby', status.id);
            const viewer = document.createElement('pre');
            viewer.className = 'safe-shell-viewer';
            viewer.dataset.safeShellRole = 'viewer';
            viewer.tabIndex = -1;
            viewer.textContent = scan.pageText;
            viewerRegion.appendChild(viewer);
            if (open) {
                const pageStatus = document.createElement('span');
                pageStatus.className = 'safe-shell-page-status';
                pageStatus.dataset.safeShellRole = 'page-status';
                pageStatus.setAttribute('role', 'status');
                pageStatus.textContent = spec.labels.page;
                viewerRegion.appendChild(pageStatus);
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            if (spec.actions.includes('open-full')) {
                const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                    if (open) return;
                    open = true;
                    render();
                    scheduleFocus('viewer');
                });
                openButton.setAttribute('aria-controls', viewerId);
                openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                openButton.disabled = open;
                actions.appendChild(openButton);
            }
            if (open && spec.actions.includes('previous')) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    requestedPage = Math.max(1, requestedPage - 1);
                    render();
                    scheduleFocus('viewer');
                });
                previous.disabled = spec.page.content.hasPrevious !== true;
                actions.appendChild(previous);
            }
            if (open && spec.actions.includes('next')) {
                const next = makeButton('next', actionLabels.next, () => {
                    requestedPage += 1;
                    render();
                    scheduleFocus('viewer');
                });
                next.disabled = requestedPage >= scan.totalPages || spec.page.content.hasNext !== true;
                actions.appendChild(next);
            }
            if (open && spec.actions.includes('close')) {
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) {
                        root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                    }
                }));
            }
            if (spec.actions.includes('copy-full')) {
                actions.appendChild(makeButton('copy-full', actionLabels['copy-full'], (button) => {
                    const canonicalText = getUserMessageCopyText(message);
                    Promise.resolve(writeTextToClipboard(canonicalText)).then((copied) => {
                        if (!isSafeShellMountCurrent(root, ownership)) return;
                        root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                        button.textContent = copied ? 'Copied' : 'Copy failed';
                        const timer = setTimeout(() => {
                            ownership.timers.delete(timer);
                            if (!isSafeShellMountCurrent(root, ownership)) return;
                            delete root.dataset.safeShellCopyState;
                            render();
                        }, copied ? 900 : 1200);
                        ownership.timers.add(timer);
                    });
                }));
            }

            const appendAllowed = canAppendToMessage(session, message);
            if (appendAllowed && spec.actions.includes('append')) {
                actions.appendChild(makeButton('append', actionLabels.append, () => {
                    const currentSession = getSessionState(activeSessionId);
                    const currentMessage = currentSession?.messagesById?.get?.(message.id);
                    if (!currentMessage || !canAppendToMessage(currentSession, currentMessage)) return;
                    enterAppendInputMode(currentMessage.id);
                }));
            } else if (spec.actions.includes('undo')) {
                const undoVerdict = canUndo(session, message.id);
                const undoButton = makeButton('undo', actionLabels.undo, () => {
                    if (isBusy) return;
                    const sessionId = activeSessionId;
                    const currentSession = getSessionState(sessionId);
                    const currentMessage = currentSession?.messagesById?.get?.(message.id);
                    if (!currentMessage) return;
                    const verdict = canUndo(currentSession, message.id);
                    if (!verdict.allowed || !verdict.msgId) return;
                    discardAllSegments(sessionId, 'undo', selectedMode || 'unknown', { anchorMsgId: verdict.msgId });
                    handleUndoToMessage(sessionId, verdict.msgId);
                });
                undoButton.disabled = isBusy || undoVerdict.allowed !== true;
                undoButton.title = undoButton.disabled ? `Undo unavailable: ${isBusy ? 'busy' : undoVerdict.reason}` : actionLabels.undo;
                actions.appendChild(undoButton);
            }

            root.replaceChildren(heading, status, viewerRegion, actions);
        };

        render();
        return root;
    }

    function renderSafeShellAssistantMessage(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-assistant') return null;
        const message = unit.value?.message;
        if (!message || message.role !== 'assistant' || message.meta?.isThinking === true) return null;
        if (message.meta?.kind || message.meta?.isDiff
            || Array.isArray(message.meta?.images) && message.meta.images.length > 0
            || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0
            || Array.isArray(message.meta?.todos) && message.meta.todos.length > 0) return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            shape: {}
        });
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        const canonicalText = getDisplayedAssistantCopyText(message);
        const referenceLimit = initialSpec.budgets.openDescendants - initialSpec.budgets.collapsedDescendants;
        let open = false;
        let requestedPage = 1;

        const scheduleFocus = (role) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${role}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };
        const makeButton = (role, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = role;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };

        const render = () => {
            const scan = scanSafeShellAssistantTextPage(canonicalText, requestedPage, initialSpec.page.content, referenceLimit);
            requestedPage = Math.min(requestedPage, scan.totalPages);
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                contentPage: requestedPage,
                shape: {
                    codeUnitCount: ((scan.totalPages - 1) * initialSpec.page.content.maxCodeUnits) + 1,
                    lineCount: 1
                }
            });
            if (!spec?.allowed || spec.shellSelected !== true) return;

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.textContent = open
                ? `${spec.labels.page}; ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; ${scan.referenceCount} validated file references.`
                : `Full assistant text omitted from the collapsed preview: ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines; ${scan.referenceCount} validated file references. Open full for bounded paging.`;

            const viewerRegion = document.createElement('div');
            viewerRegion.className = 'safe-shell-viewer-region';
            viewerRegion.dataset.safeShellRole = 'viewer-region';
            viewerRegion.id = viewerId;
            viewerRegion.setAttribute('aria-describedby', status.id);
            const viewer = document.createElement('pre');
            viewer.className = 'safe-shell-viewer';
            viewer.dataset.safeShellRole = 'viewer';
            viewer.tabIndex = -1;
            viewer.textContent = scan.pageText;
            viewerRegion.appendChild(viewer);
            if (open) {
                const pageStatus = document.createElement('span');
                pageStatus.className = 'safe-shell-page-status';
                pageStatus.dataset.safeShellRole = 'page-status';
                pageStatus.setAttribute('role', 'status');
                pageStatus.textContent = spec.labels.page;
                viewerRegion.appendChild(pageStatus);
                if (scan.pageReferences.length > 0) {
                    const fileLinks = document.createElement('div');
                    fileLinks.className = 'safe-shell-file-links';
                    for (const reference of scan.pageReferences) {
                        const link = document.createElement('a');
                        const line = reference.line ? `&line=${reference.line}&col=${reference.col || '1'}` : '';
                        link.href = `ocfile://open?path=${encodeURIComponent(reference.filePath)}${line}`;
                        link.textContent = reference.label;
                        link.setAttribute('aria-label', `${spec.labels.actions['open-file']}: ${reference.label}`);
                        fileLinks.appendChild(link);
                    }
                    viewerRegion.appendChild(fileLinks);
                }
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                if (open) return;
                open = true;
                render();
                scheduleFocus('viewer');
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    requestedPage = Math.max(1, requestedPage - 1);
                    render();
                    scheduleFocus('viewer');
                });
                previous.disabled = requestedPage <= 1;
                actions.appendChild(previous);
                const next = makeButton('next', actionLabels.next, () => {
                    requestedPage += 1;
                    render();
                    scheduleFocus('viewer');
                });
                next.disabled = requestedPage >= scan.totalPages;
                actions.appendChild(next);
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) {
                        root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                    }
                }));
            }
            actions.appendChild(makeButton('copy-full', actionLabels['copy-full'], (button) => {
                const displayedText = getDisplayedAssistantCopyText(message);
                Promise.resolve(writeTextToClipboard(displayedText)).then((copied) => {
                    if (!isSafeShellMountCurrent(root, ownership)) return;
                    root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                    button.textContent = copied ? 'Copied' : 'Copy failed';
                    const timer = setTimeout(() => {
                        ownership.timers.delete(timer);
                        if (!isSafeShellMountCurrent(root, ownership)) return;
                        delete root.dataset.safeShellCopyState;
                        render();
                    }, copied ? 900 : 1200);
                    ownership.timers.add(timer);
                });
            }));
            root.replaceChildren(heading, status, viewerRegion, actions);
        };

        render();
        return root;
    }

    function renderSafeShellSubagentMessage(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-subagent') return null;
        const message = unit.value?.message;
        const agents = Array.isArray(message?.meta?.subagents) ? message.meta.subagents : [];
        if (!message || message.role !== 'assistant' || agents.length === 0) return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            shape: { itemCount: agents.length }
        });
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const agentsPerPage = 6;
        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        const stateCounts = new Map();
        const stateOf = (agent) => {
            const explicit = typeof agent?.state === 'string' ? agent.state.trim().toLowerCase() : '';
            return explicit || (agent?.isDone === true ? 'done' : 'running');
        };
        const safeIdentity = (value) => typeof value === 'string' && value.trim() ? value.trim() : '';
        const parentIdentityOf = (agent) => safeIdentity(agent?.parentSessionId)
            || safeIdentity(message.sessionId)
            || safeIdentity(activeSessionId)
            || 'unavailable';
        const fieldsOf = (agent) => {
            const latestText = typeof agent?.latestText === 'string' ? agent.latestText.trim() : '';
            const latestFullText = typeof agent?.latestFullText === 'string' ? agent.latestFullText.trim() : '';
            return {
                title: cleanSubagentTitle(agent?.title),
                mode: pickMode(agent),
                model: formatSubagentModel(agent),
                state: stateOf(agent),
                latestText,
                fullText: latestFullText || latestText,
                tool: typeof agent?.latestTool === 'string' ? agent.latestTool.trim() : '',
                input: typeof agent?.latestToolInput === 'string' ? agent.latestToolInput.trim() : '',
                parentIdentity: parentIdentityOf(agent)
            };
        };
        for (const agent of agents) {
            const state = stateOf(agent);
            stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
        }

        const stateSummary = () => {
            const ordered = ['running', 'done', 'failed', 'finalizing', 'cancelled'];
            const parts = [];
            for (const state of ordered) {
                const count = stateCounts.get(state) || 0;
                if (count) parts.push(`${count} ${state}`);
            }
            let otherCount = 0;
            for (const [state, count] of stateCounts) if (!ordered.includes(state)) otherCount += count;
            if (otherCount) parts.push(`${otherCount} other`);
            return parts.join(', ');
        };
        const detailTextOf = (agent, index) => {
            const fields = fieldsOf(agent);
            return [
                `Subagent ${index + 1}: ${fields.title}`,
                `State: ${fields.state}`,
                `Mode: ${fields.mode || 'unavailable'}`,
                `Model: ${fields.model || 'unavailable'}`,
                `Parent session: ${fields.parentIdentity}`,
                `Latest preview: ${fields.latestText || 'unavailable'}`,
                `Full text: ${fields.fullText || 'unavailable'}`,
                `Latest tool: ${fields.tool || 'unavailable'}`,
                `Tool input: ${fields.input || 'unavailable'}`
            ].join('\n');
        };
        const completeCopyText = () => {
            const parts = new Array(agents.length);
            for (let index = 0; index < agents.length; index += 1) parts[index] = detailTextOf(agents[index], index);
            return parts.join('\n\n');
        };

        let open = false;
        let agentPage = 1;
        let selectedIndex = 0;
        let detailPage = 1;

        const scheduleFocus = (roleName) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${roleName}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };
        const makeButton = (roleName, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = roleName;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };

        const render = () => {
            const totalAgentPages = Math.max(1, Math.ceil(agents.length / agentsPerPage));
            agentPage = Math.min(Math.max(1, agentPage), totalAgentPages);
            const pageStart = (agentPage - 1) * agentsPerPage;
            const pageEnd = Math.min(agents.length, pageStart + agentsPerPage);
            if (selectedIndex < pageStart || selectedIndex >= pageEnd) selectedIndex = pageStart;
            const selectedText = detailTextOf(agents[selectedIndex], selectedIndex);
            let detailScan = scanSafeShellAssistantTextPage(selectedText, detailPage, initialSpec.page.content, 1);
            detailPage = Math.min(Math.max(1, detailPage), detailScan.totalPages);
            if (detailPage !== 1) detailScan = scanSafeShellAssistantTextPage(selectedText, detailPage, initialSpec.page.content, 1);
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                contentPage: detailPage,
                itemPage: agentPage,
                shape: { itemCount: agents.length, codeUnitCount: selectedText.length }
            });
            if (!spec?.allowed || spec.shellSelected !== true) return;

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels?.title || 'Subagents';

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.textContent = `${agents.length} agents; ${stateSummary()}. ${open ? `Showing agents ${pageStart + 1}–${pageEnd}.` : 'Details omitted from the collapsed preview.'}`;

            const agentList = document.createElement('div');
            agentList.className = 'safe-shell-agent-list';
            agentList.dataset.safeShellRole = 'agent-list';
            for (let index = pageStart; index < pageEnd; index += 1) {
                const fields = fieldsOf(agents[index]);
                const summary = [
                    `${index + 1}. ${fields.title}`,
                    fields.state,
                    fields.mode,
                    fields.model,
                    `parent ${fields.parentIdentity}`
                ].filter(Boolean).join(' · ');
                const agentButton = makeButton(`agent-${index}`, summary, () => {
                    selectedIndex = index;
                    detailPage = 1;
                    render();
                    if (open) scheduleFocus('viewer');
                });
                agentButton.setAttribute('aria-pressed', selectedIndex === index ? 'true' : 'false');
                agentList.appendChild(agentButton);
            }

            const viewerRegion = document.createElement('div');
            viewerRegion.className = 'safe-shell-viewer-region';
            viewerRegion.dataset.safeShellRole = 'viewer-region';
            viewerRegion.id = viewerId;
            viewerRegion.setAttribute('aria-describedby', status.id);
            if (open) {
                const agentPageStatus = document.createElement('span');
                agentPageStatus.dataset.safeShellRole = 'agent-page-status';
                agentPageStatus.setAttribute('role', 'status');
                agentPageStatus.textContent = `Agents ${pageStart + 1}–${pageEnd} of ${agents.length}`;
                viewerRegion.appendChild(agentPageStatus);
                const viewer = document.createElement('pre');
                viewer.className = 'safe-shell-viewer';
                viewer.dataset.safeShellRole = 'viewer';
                viewer.tabIndex = -1;
                viewer.textContent = detailScan.pageText;
                viewerRegion.appendChild(viewer);
                const detailPageStatus = document.createElement('span');
                detailPageStatus.dataset.safeShellRole = 'detail-page-status';
                detailPageStatus.setAttribute('role', 'status');
                detailPageStatus.textContent = `Detail page ${detailPage} of ${detailScan.totalPages}`;
                viewerRegion.appendChild(detailPageStatus);
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels?.actions || {};
            const openButton = makeButton('open-full', actionLabels['open-full'] || 'Open full', () => {
                if (open) return;
                open = true;
                render();
                scheduleFocus('viewer');
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const agentPrevious = makeButton('agent-previous', 'Previous agents', () => {
                    agentPage = Math.max(1, agentPage - 1);
                    detailPage = 1;
                    render();
                    scheduleFocus('viewer');
                });
                agentPrevious.disabled = agentPage <= 1;
                actions.appendChild(agentPrevious);
                const agentNext = makeButton('agent-next', 'Next agents', () => {
                    agentPage = Math.min(totalAgentPages, agentPage + 1);
                    detailPage = 1;
                    render();
                    scheduleFocus('viewer');
                });
                agentNext.disabled = agentPage >= totalAgentPages;
                actions.appendChild(agentNext);
                const detailPrevious = makeButton('detail-previous', 'Previous detail page', () => {
                    detailPage = Math.max(1, detailPage - 1);
                    render();
                    scheduleFocus('viewer');
                });
                detailPrevious.disabled = detailPage <= 1;
                actions.appendChild(detailPrevious);
                const detailNext = makeButton('detail-next', 'Next detail page', () => {
                    detailPage = Math.min(detailScan.totalPages, detailPage + 1);
                    render();
                    scheduleFocus('viewer');
                });
                detailNext.disabled = detailPage >= detailScan.totalPages;
                actions.appendChild(detailNext);
                actions.appendChild(makeButton('close', actionLabels.close || 'Close', () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                }));
            }
            if (!Array.isArray(spec.actions) || spec.actions.includes('copy-full')) {
                actions.appendChild(makeButton('copy-full', actionLabels['copy-full'] || 'Copy full', (button) => {
                    Promise.resolve(writeTextToClipboard(completeCopyText())).then((copied) => {
                        if (!isSafeShellMountCurrent(root, ownership)) return;
                        root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                        button.textContent = copied ? 'Copied' : 'Copy failed';
                        const timer = setTimeout(() => {
                            ownership.timers.delete(timer);
                            if (!isSafeShellMountCurrent(root, ownership)) return;
                            delete root.dataset.safeShellCopyState;
                            render();
                        }, copied ? 900 : 1200);
                        ownership.timers.add(timer);
                    });
                }));
            }
            root.replaceChildren(heading, status, agentList, viewerRegion, actions);
        };

        render();
        return root;
    }

    function renderSafeShellChangeList(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (unit.kind !== 'change-list'
            || presentationSelection?.mode !== 'safe-shell'
            || presentationSelection?.family !== 'change-list') return null;
        const message = unit.value?.message;
        const files = Array.isArray(message?.meta?.files) ? message.meta.files : [];
        if (!message || message.meta?.kind !== 'changeList' || files.length === 0) return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            page: 1,
            shape: { itemCount: files.length }
        });
        const filesPerPage = initialSpec?.page?.primary?.limit;
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !Number.isFinite(filesPerPage)) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        const commitHead = typeof message.meta?.commitHead === 'string' ? message.meta.commitHead : undefined;
        const commitBase = typeof message.meta?.commitBase === 'string' ? message.meta.commitBase : undefined;
        const statsByPath = message.meta?.statsByPath && typeof message.meta.statsByPath === 'object'
            ? message.meta.statsByPath
            : {};
        let open = false;
        let filePage = 1;

        const scheduleFocus = (roleName) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${roleName}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };
        const makeButton = (roleName, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = roleName;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!button.isConnected || !isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };
        const statsLabel = (normalizedPath) => {
            const stats = statsByPath[normalizedPath];
            if (!stats || typeof stats !== 'object') return 'stats unavailable';
            const additions = Number.isFinite(stats.additions) ? `+${stats.additions}` : 'additions unavailable';
            const deletions = Number.isFinite(stats.deletions) ? `-${stats.deletions}` : 'deletions unavailable';
            return `${additions}, ${deletions}`;
        };

        const render = () => {
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                page: filePage,
                shape: { itemCount: files.length }
            });
            if (!spec?.allowed || spec.shellSelected !== true || !spec.page?.primary) return;
            filePage = spec.page.primary.index;
            const pageStart = spec.page.primary.start;
            const pageEnd = Math.min(files.length, pageStart + spec.page.primary.limit);

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const reverted = message.meta?.reverted === true ? 'yes' : 'no';
            const commitDisclosure = `commit head ${commitHead ? 'available' : 'unavailable'}; commit base ${commitBase ? 'available' : 'unavailable'}`;
            status.textContent = open
                ? `${files.length} changed files; reverted: ${reverted}; ${commitDisclosure}; showing files ${pageStart + 1}–${pageEnd}; ${spec.labels.page}.`
                : `${files.length} changed files; reverted: ${reverted}; ${commitDisclosure}. Only files ${pageStart + 1}–${pageEnd} are represented; open full for bounded paging.`;

            const fileList = document.createElement('div');
            fileList.className = 'safe-shell-file-links';
            fileList.dataset.safeShellRole = 'viewer-region';
            fileList.id = viewerId;
            fileList.setAttribute('aria-describedby', status.id);
            for (let index = pageStart; index < pageEnd; index += 1) {
                const rawPath = files[index];
                const normalizedPath = typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : '';
                const pathLabel = normalizedPath || `Unavailable file ${index + 1}`;
                const statistic = normalizedPath ? statsLabel(normalizedPath) : 'stats unavailable';
                const action = normalizedPath && /\.md$/i.test(normalizedPath) ? 'Open file' : 'Open diff';
                const fileButton = makeButton(`file-${index}`, `${action}: ${pathLabel}; ${statistic}`, () => {
                    if (!normalizedPath) return;
                    if (/\.md$/i.test(normalizedPath)) {
                        vscode.postMessage({
                            type: 'openFileAtLocation',
                            path: normalizedPath,
                            sessionId: activeSessionId || null
                        });
                        return;
                    }
                    postOpenGitDiff(normalizedPath, activeSessionId, commitHead, commitBase);
                });
                fileButton.disabled = !normalizedPath;
                fileList.appendChild(fileButton);
            }
            if (open) {
                const pageStatus = document.createElement('span');
                pageStatus.dataset.safeShellRole = 'file-page-status';
                pageStatus.setAttribute('role', 'status');
                pageStatus.textContent = `Files ${pageStart + 1}–${pageEnd} of ${files.length}`;
                fileList.appendChild(pageStatus);
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                if (open) return;
                open = true;
                render();
                scheduleFocus(`file-${pageStart}`);
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    filePage = Math.max(1, filePage - 1);
                    render();
                    scheduleFocus(`file-${Math.max(0, (filePage - 1) * filesPerPage)}`);
                });
                previous.disabled = spec.page.primary.hasPrevious !== true;
                actions.appendChild(previous);
                const next = makeButton('next', actionLabels.next, () => {
                    filePage += 1;
                    render();
                    scheduleFocus(`file-${(filePage - 1) * filesPerPage}`);
                });
                next.disabled = spec.page.primary.hasNext !== true;
                actions.appendChild(next);
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) {
                        root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                    }
                }));
            }
            root.replaceChildren(heading, status, fileList, actions);
        };

        render();
        return root;
    }

    function renderSafeShellSegment(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'segment') return null;

        const message = unit.kind === 'message' ? unit.value?.message : null;
        const isPlaceholder = unit.kind === 'message'
            && (message?.meta?.kind === 'undoSegmentPlaceholder' || message?.id?.startsWith?.('system:undo-seg:'));
        const noticeKey = isPlaceholder
            ? message?.meta?.noticeKey || message?.id?.replace?.('system:undo-seg:', '') || ''
            : '';
        const segment = unit.kind === 'segment'
            ? unit.value?.segment
            : isPlaceholder && noticeKey
                ? session?.segmentsByNoticeKey?.get?.(noticeKey)
                : null;
        if (!segment || (unit.kind !== 'segment' && !isPlaceholder)) return null;

        const memberIds = Array.isArray(segment.memberMsgIds)
            ? segment.memberMsgIds
            : segment.memberIds && typeof segment.memberIds[Symbol.iterator] === 'function'
                ? segment.memberIds
                : [];
        const memberCount = Number.isFinite(memberIds.length) ? memberIds.length : Number.isFinite(memberIds.size) ? memberIds.size : 0;
        const invalidSegments = Array.isArray(segment.mergedInvalidSegments) ? segment.mergedInvalidSegments : [];
        const entryCount = memberCount + invalidSegments.length;
        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            page: 1,
            shape: { itemCount: entryCount }
        });
        const entriesPerPage = initialSpec?.page?.primary?.limit;
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !Number.isFinite(entriesPerPage)) return null;

        let availableCount = 0;
        for (const id of memberIds) if (session?.messagesById?.has?.(id)) availableCount += 1;
        const isDirect = unit.kind === 'segment';
        const anchorMsgId = segment.anchorMsgId || segment.anchor?.msgId || '';
        const restoreEligible = isDirect
            ? segment.state === 'restorable' && !isBusy && Boolean(anchorMsgId)
            : segment.restoreAllowed === true;
        const stateLabel = isDirect
            ? (typeof segment.state === 'string' && segment.state ? segment.state : 'unknown')
            : segment.restoreAllowed === true ? 'restorable' : 'discarded';

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        if (isDirect) root.dataset.segmentKey = unit.sourceKey || unit.key;
        else root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        let open = false;
        let entryPage = 1;

        const memberAt = (targetIndex) => {
            if (Array.isArray(memberIds)) return memberIds[targetIndex];
            let index = 0;
            for (const id of memberIds) {
                if (index === targetIndex) return id;
                index += 1;
            }
            return undefined;
        };
        const entryAt = (index) => {
            if (index < memberCount) {
                const id = memberAt(index);
                return {
                    kind: 'member',
                    label: `${index + 1}. Member ${typeof id === 'string' && id ? id : 'unavailable identity'} — ${session?.messagesById?.has?.(id) ? 'available' : 'unavailable'}`
                };
            }
            const invalidIndex = index - memberCount;
            const child = invalidSegments[invalidIndex];
            const childKey = typeof child?.noticeKey === 'string' && child.noticeKey
                ? child.noticeKey
                : `unavailable identity ${invalidIndex + 1}`;
            const childMembers = Array.isArray(child?.memberMsgIds) ? child.memberMsgIds.length : 0;
            const childEligible = child?.restoreAllowed === false ? 'unrestorable' : 'restorable';
            return { kind: 'merged-invalid', label: `${index + 1}. Merged-invalid ${childKey} — ${childMembers} members; ${childEligible}` };
        };
        const scheduleFocus = (roleName) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${roleName}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };
        const makeButton = (roleName, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = roleName;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!button.isConnected || !isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };

        const render = () => {
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                page: entryPage,
                shape: { itemCount: entryCount }
            });
            if (!spec?.allowed || spec.shellSelected !== true || !spec.page?.primary) return;
            entryPage = spec.page.primary.index;
            const pageStart = spec.page.primary.start;
            const pageEnd = Math.min(entryCount, pageStart + spec.page.primary.limit);

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const availability = `${availableCount} available of ${memberCount} members; ${invalidSegments.length} merged-invalid entries; state ${stateLabel}; restore eligible: ${restoreEligible ? 'yes' : 'no'}`;
            status.textContent = open
                ? `${availability}; showing entries ${entryCount ? pageStart + 1 : 0}–${pageEnd} of ${entryCount}; ${spec.labels.page}.`
                : `${availability}. Only entries ${entryCount ? pageStart + 1 : 0}–${pageEnd} are represented; open full for bounded paging.`;

            const entryList = document.createElement('div');
            entryList.className = 'safe-shell-file-links';
            entryList.dataset.safeShellRole = 'viewer-region';
            entryList.id = viewerId;
            entryList.setAttribute('aria-describedby', status.id);
            for (let index = pageStart; index < pageEnd; index += 1) {
                const entry = entryAt(index);
                const entryButton = makeButton(`entry-${index}`, entry.label, () => {});
                entryButton.setAttribute('aria-label', entry.label);
                entryList.appendChild(entryButton);
            }
            if (open) {
                const pageStatus = document.createElement('span');
                pageStatus.dataset.safeShellRole = 'entry-page-status';
                pageStatus.setAttribute('role', 'status');
                pageStatus.textContent = `Entries ${entryCount ? pageStart + 1 : 0}–${pageEnd} of ${entryCount}`;
                entryList.appendChild(pageStatus);
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                if (open) return;
                open = true;
                render();
                scheduleFocus(entryCount ? `entry-${pageStart}` : 'close');
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    entryPage = Math.max(1, entryPage - 1);
                    render();
                    scheduleFocus(`entry-${Math.max(0, (entryPage - 1) * entriesPerPage)}`);
                });
                previous.disabled = spec.page.primary.hasPrevious !== true;
                actions.appendChild(previous);
                const next = makeButton('next', actionLabels.next, () => {
                    entryPage += 1;
                    render();
                    scheduleFocus(`entry-${(entryPage - 1) * entriesPerPage}`);
                });
                next.disabled = spec.page.primary.hasNext !== true;
                actions.appendChild(next);
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                }));
            }
            const restore = makeButton('restore', actionLabels.restore, () => {
                if (!restoreEligible) return;
                if (!isDirect) {
                    handleRestoreSegment(activeSessionId, noticeKey);
                    return;
                }
                const segKey = segment.noticeKey ?? segment.id ?? '';
                const canonicalNoticeKey = typeof segKey === 'string' && segKey.startsWith('seg:') ? segKey.slice(4) : segKey;
                const operationId = createOperationId();
                vscode.postMessage({
                    type: 'restoreSegment',
                    sessionId: activeSessionId,
                    operationId,
                    noticeKey: canonicalNoticeKey,
                    anchorMsgId,
                    endMsgId: segment.endMsgId
                });
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_RESTORE_SEND]', `sessionId=${activeSessionId || 'null'}`, `opId=${operationId || 'null'}`, `noticeKey=${canonicalNoticeKey || 'null'}`, `anchorMsgId=${anchorMsgId || 'null'}`, `endMsgId=${segment.endMsgId || 'null'}`, 'type=restoreSegment']
                });
                logSessionState(activeSessionId, 'UI_RESTORE_SEGMENT');
            });
            restore.disabled = !restoreEligible;
            actions.appendChild(restore);
            actions.appendChild(makeButton('toggle', actionLabels.toggle, () => {
                handleToggleSegment(activeSessionId, isDirect ? segment.id : noticeKey);
                window.__oc?.renderFromState?.();
                if (isDirect) logSessionState(activeSessionId, 'UI_TOGGLE_SEGMENT_EXPAND');
            }));
            root.replaceChildren(heading, status, entryList, actions);
        };

        render();
        return root;
    }

    function renderSafeShellToolMetaMessage(session, unit, presentationSelection) {
        const rendering = window.__ocRendering;
        if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
        if (presentationSelection?.mode !== 'safe-shell' || presentationSelection?.family !== 'message-tool-meta') return null;
        const message = unit.value?.message;
        const role = message?.role;
        const hasAssistantMetaKind = typeof message?.meta?.kind === 'string' && message.meta.kind.trim().length > 0;
        const kind = typeof message?.meta?.kind === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(message.meta.kind.trim())
            ? message.meta.kind.trim()
            : 'unknown';
        const isMultiplexedRole = role === 'tool' || role === 'system' || (role === 'assistant' && hasAssistantMetaKind);
        if (!message || !isMultiplexedRole || message.meta?.kind === 'changeList' || message.meta?.kind === 'undoSegmentPlaceholder') return null;
        if (message.meta?.isDiff
            || Array.isArray(message.meta?.images) && message.meta.images.length > 0
            || Array.isArray(message.meta?.subagents) && message.meta.subagents.length > 0
            || Array.isArray(message.meta?.todos) && message.meta.todos.length > 0) return null;

        const initialSpec = rendering.getSafeShellSpec({
            mode: presentationSelection.mode,
            family: presentationSelection.family,
            shape: {}
        });
        if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content) return null;

        const root = document.createElement('div');
        root.className = 'safe-shell';
        root.dataset.safeShellFamily = initialSpec.family;
        root.dataset.messageId = message.id;
        const generation = ++safeShellPresentationGeneration;
        root.dataset.safeShellGeneration = String(generation);
        const ownership = {
            sessionId: activeSessionId,
            unitKey: unit.key,
            generation,
            root,
            disposed: false,
            timers: new Set(),
            frames: new Set()
        };
        safeShellMountOwnership.set(root, ownership);
        root._safeShellDispose = () => disposeSafeShellRoot(root);

        const deterministicKey = encodeURIComponent(String(unit.key)).replace(/%/g, '-');
        const viewerId = `safe-shell-viewer-${deterministicKey}-${generation}`;
        const messageCopyText = getMessageCopyText(message);
        const canonicalText = role === 'assistant'
            ? messageCopyText
            : (typeof message.text === 'string' ? message.text : '');
        const statusEntryCount = Array.isArray(message.meta?.statuses) ? message.meta.statuses.length : 0;
        const statusAvailable = statusEntryCount > 0
            || typeof message.meta?.status === 'string' && message.meta.status.length > 0
            || typeof message.meta?.statusText === 'string' && message.meta.statusText.length > 0;
        let open = false;
        let requestedPage = 1;

        const scheduleFocus = (roleName) => {
            let frame = null;
            frame = requestAnimationFrame(() => {
                ownership.frames.delete(frame);
                if (!isSafeShellMountCurrent(root, ownership)) return;
                root.querySelector(`[data-safe-shell-role="${roleName}"]`)?.focus?.();
            });
            ownership.frames.add(frame);
        };
        const makeButton = (roleName, label, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'safe-shell-action';
            button.dataset.safeShellRole = roleName;
            button.textContent = label;
            button.setAttribute('aria-label', label);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isSafeShellMountCurrent(root, ownership)) return;
                onClick(button);
            });
            return button;
        };

        const render = () => {
            const scan = scanSafeShellAssistantTextPage(canonicalText, requestedPage, initialSpec.page.content, 1);
            requestedPage = Math.min(requestedPage, scan.totalPages);
            const spec = rendering.getSafeShellSpec({
                mode: presentationSelection.mode,
                family: presentationSelection.family,
                contentPage: requestedPage,
                shape: {
                    codeUnitCount: ((scan.totalPages - 1) * initialSpec.page.content.maxCodeUnits) + 1,
                    lineCount: 1
                }
            });
            if (!spec?.allowed || spec.shellSelected !== true) return;

            const heading = document.createElement('div');
            heading.className = 'safe-shell-heading';
            heading.textContent = spec.labels.title;

            const status = document.createElement('div');
            status.className = 'safe-shell-status';
            status.dataset.safeShellRole = 'status';
            status.id = `${viewerId}-status`;
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const identity = `role ${role}; kind ${kind}; status ${statusAvailable ? 'available' : 'unavailable'}; ${statusEntryCount} status entries`;
            status.textContent = open
                ? `${spec.labels.page}; ${identity}; ${scan.codeUnitCount} text code units across ${scan.lineCount} logical lines.`
                : `Full text omitted from the collapsed preview: ${identity}; ${scan.codeUnitCount} text code units across ${scan.lineCount} logical lines. Open full for bounded paging.`;

            const viewerRegion = document.createElement('div');
            viewerRegion.className = 'safe-shell-viewer-region';
            viewerRegion.dataset.safeShellRole = 'viewer-region';
            viewerRegion.id = viewerId;
            viewerRegion.setAttribute('aria-describedby', status.id);
            const viewer = document.createElement('pre');
            viewer.className = 'safe-shell-viewer';
            viewer.dataset.safeShellRole = 'viewer';
            viewer.tabIndex = -1;
            viewer.textContent = scan.pageText;
            viewerRegion.appendChild(viewer);
            if (open) {
                const pageStatus = document.createElement('span');
                pageStatus.className = 'safe-shell-page-status';
                pageStatus.dataset.safeShellRole = 'page-status';
                pageStatus.setAttribute('role', 'status');
                pageStatus.textContent = spec.labels.page;
                viewerRegion.appendChild(pageStatus);
            }

            const actions = document.createElement('div');
            actions.className = 'safe-shell-actions';
            const actionLabels = spec.labels.actions;
            const openButton = makeButton('open-full', actionLabels['open-full'], () => {
                if (open) return;
                open = true;
                render();
                scheduleFocus('viewer');
            });
            openButton.setAttribute('aria-controls', viewerId);
            openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            openButton.disabled = open;
            actions.appendChild(openButton);
            if (open) {
                const previous = makeButton('previous', actionLabels.previous, () => {
                    requestedPage = Math.max(1, requestedPage - 1);
                    render();
                    scheduleFocus('viewer');
                });
                previous.disabled = requestedPage <= 1;
                actions.appendChild(previous);
                const next = makeButton('next', actionLabels.next, () => {
                    requestedPage += 1;
                    render();
                    scheduleFocus('viewer');
                });
                next.disabled = requestedPage >= scan.totalPages;
                actions.appendChild(next);
                actions.appendChild(makeButton('close', actionLabels.close, () => {
                    open = false;
                    render();
                    if (isSafeShellMountCurrent(root, ownership)) {
                        root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
                    }
                }));
            }
            if (messageCopyText && spec.actions.includes('copy-full')) {
                actions.appendChild(makeButton('copy-full', actionLabels['copy-full'], (button) => {
                    const canonicalCopy = getMessageCopyText(message);
                    Promise.resolve(writeTextToClipboard(canonicalCopy)).then((copied) => {
                        if (!isSafeShellMountCurrent(root, ownership)) return;
                        root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                        button.textContent = copied ? 'Copied' : 'Copy failed';
                        const timer = setTimeout(() => {
                            ownership.timers.delete(timer);
                            if (!isSafeShellMountCurrent(root, ownership)) return;
                            delete root.dataset.safeShellCopyState;
                            render();
                        }, copied ? 900 : 1200);
                        ownership.timers.add(timer);
                    });
                }));
            }
            root.replaceChildren(heading, status, viewerRegion, actions);
        };

        render();
        return root;
    }

    function renderDetachedKeyedUnit(session, unit, renderedSet, presentationSelection) {
        const capture = document.createDocumentFragment();
        keyedChatRenderCapture = capture;
        keyedPresentationSelectionOverride = presentationSelection;
        keyedUnitKeyOverride = unit.key;
        keyedFollowingTurnDividerOverride = unit.kind === 'message' || unit.kind === 'change-list'
            ? unit.value?.hasPriorUser === true
            : null;
        let directRoot = null;
        try {
            const safeShellRoot = renderSafeShellSegment(session, unit, presentationSelection)
                || (unit.kind === 'change-list'
                ? renderSafeShellChangeList(session, unit, presentationSelection)
                : unit.kind === 'message'
                    ? renderSafeShellImageMessage(session, unit, presentationSelection)
                    || renderSafeShellDiffMessage(session, unit, presentationSelection)
                    || renderSafeShellCodeMessage(session, unit, presentationSelection)
                    || renderSafeShellTableMessage(session, unit, presentationSelection)
                    || renderSafeShellMarkdownMessage(session, unit, presentationSelection)
                    || renderSafeShellUserMessage(session, unit, presentationSelection)
                    || renderSafeShellAssistantMessage(session, unit, presentationSelection)
                    || renderSafeShellSubagentMessage(session, unit, presentationSelection)
                    || renderSafeShellToolMetaMessage(session, unit, presentationSelection)
                    : null);
            if (safeShellRoot) {
                directRoot = safeShellRoot;
                renderedSet?.add?.(unit.value?.message?.id);
            } else if (unit.kind === 'greeting') {
                directRoot = document.createElement('div');
                directRoot.className = 'message bot';
                const content = document.createElement('div');
                content.className = 'message-content';
                content.textContent = unit.value?.text || 'Hello! I am OpenCode. How can I help you today?';
                directRoot.appendChild(content);
            } else if (unit.kind === 'segment') {
                renderSegmentElement(session, unit.value.segment, renderedSet, unit.sourceKey);
            } else if (unit.kind === 'conflict') {
                directRoot = renderConflictCard(unit.value, { detached: true, presentationSelection, unitKey: unit.key });
            } else {
                renderMessageElement(unit.value.message, renderedSet);
            }
        } finally {
            keyedChatRenderCapture = null;
            keyedFollowingTurnDividerOverride = null;
            keyedPresentationSelectionOverride = null;
            keyedUnitKeyOverride = null;
        }
        if (directRoot) capture.appendChild(directRoot);
        const roots = Array.from(capture.children);
        if (roots.length !== 1) throw new Error(`Keyed unit ${unit.key} produced ${roots.length} roots`);
        const root = roots[0];
        root.dataset.renderUnitKey = unit.key;
        return root;
    }

    function keyedRoots() {
        return Array.from(chatContainer.children).filter((child) => child.dataset?.renderUnitKey);
    }

    function keyedRootForKey(key) {
        const matches = keyedRoots().filter((root) => root.dataset.renderUnitKey === key);
        return matches.length === 1 ? matches[0] : null;
    }

    function getChatWindowUnitKind(unit) {
        if (unit.kind === 'segment' || unit.kind === 'change-list') return unit.kind;
        if (unit.kind !== 'message') return 'system';
        const role = unit.value?.message?.role;
        return role === 'user' || role === 'assistant' ? role : 'system';
    }

    function isChatWindowAvailable() {
        return TANSTACK_CHAT_WINDOW_ENABLED
            && typeof window.__ocRendering?.createTanStackVirtualAdapter === 'function'
            && !!chatLocalHistoryController
            && chatWindowState.failedSessionId !== (activeSessionId || '__no_session__');
    }

    function destroyChatLocalOlderSurface() {
        chatWindowState.localOlderObserver?.disconnect?.();
        chatWindowState.localOlderObserver = null;
        chatWindowState.localOlderObserverArmed = true;
        chatWindowState.localOlderSurface?.remove?.();
        chatWindowState.localOlderSurface = null;
        chatWindowState.localHistoryPresentation = null;
    }

    function destroyChatWindowAdapter(reason = 'unknown') {
        clearChatWindowSyntheticEvidenceRequest();
        const ownedSessionId = chatWindowState.sessionId;
        const destroyedGeneration = chatWindowGeneration;
        const adapterWasOwned = !!chatWindowState.adapter;
        chatWindowGeneration += 1;
        if (typeof resetChatWindowAdaptiveShadow === 'function') resetChatWindowAdaptiveShadow(reason, destroyedGeneration);
        chatWindowState.adapter?.destroy?.();
        chatWindowState.adapter = null;
        chatWindowState.snapshot = null;
        chatWindowState.acknowledgedRawSnapshot = null;
        chatWindowState.mountedKeys = new Set();
        chatWindowState.sessionId = '';
        chatWindowState.pendingRangeRender = false;
        chatWindowState.pendingScrollKey = '';
        chatWindowState.pendingScrollAttempts = 0;
        chatWindowState.anchorKey = '';
        chatWindowState.visualOffset = 0;
        chatWindowState.userScrollActiveUntil = 0;
        chatWindowState.activityBelow = false;
        autoScrollPinnedToBottom = true;
        chatWindowState.programmaticScroll = true;
        if (chatContainer) chatContainer.scrollTop = 0;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { chatWindowState.programmaticScroll = false; });
        } else {
            chatWindowState.programmaticScroll = false;
        }
        chatLocalHistoryController?.complete?.(ownedSessionId);
        destroyChatLocalOlderSurface();
        chatWindowState.topSpacer?.remove?.();
        chatWindowState.bottomSpacer?.remove?.();
        chatWindowState.topSpacer = null;
        chatWindowState.bottomSpacer = null;
        chatContainer?.classList?.remove?.('chat-window-active');
        vscode.postMessage({ type: 'ui-debug', payload: ['[WV][CHAT_WINDOW_DESTROY]', `reason=${reason}`] });
        if (typeof closeChatWindowPressureGeneration === 'function') {
            closeChatWindowPressureGeneration(
                destroyedGeneration,
                reason === 'session-switch',
                adapterWasOwned,
                keyedRoots().length
            );
        }
    }

    function disableChatWindowForSession(reason, error) {
        destroyChatWindowAdapter(reason);
        chatWindowState.failedSessionId = activeSessionId || '__no_session__';
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['[WV][CHAT_WINDOW_FAIL_CLOSED_TO_WAVE2]', `reason=${reason}`, `error=${String(error)}`]
        });
    }

    function ensureChatWindowSpacers() {
        chatContainer.classList.add('chat-window-active');
        if (!chatWindowState.topSpacer) {
            const topSpacer = document.createElement('div');
            reserveChatStructuralRoot(topSpacer);
            topSpacer.className = 'chat-window-spacer chat-window-spacer-top';
            classifyChatStructuralSurface(topSpacer, 'window:top-spacer', 'tanstack-window');
            chatWindowState.topSpacer = topSpacer;
        }
        if (!chatWindowState.bottomSpacer) {
            const bottomSpacer = document.createElement('div');
            reserveChatStructuralRoot(bottomSpacer);
            bottomSpacer.className = 'chat-window-spacer chat-window-spacer-bottom';
            classifyChatStructuralSurface(bottomSpacer, 'window:bottom-spacer', 'tanstack-window');
            chatWindowState.bottomSpacer = bottomSpacer;
        }
    }

    function transitionActiveSessionPresentationOwner(previousSessionId, targetSessionId) {
        const previousOwner = previousSessionId || '__no_session__';
        const targetOwner = targetSessionId || '__no_session__';
        const presentationOwner = chatWindowState.sessionId || previousOwner;
        const hasOwnedPresentation = Boolean(chatWindowState.adapter || chatWindowState.sessionId);
        if (!hasOwnedPresentation || (previousOwner === targetOwner && presentationOwner === targetOwner)) return false;
        destroyChatWindowAdapter('session-switch');
        return true;
    }

    function ensureChatLocalOlderSurface() {
        if (chatWindowState.localOlderSurface) return chatWindowState.localOlderSurface;
        const surface = document.createElement('div');
        reserveChatStructuralRoot(surface);
        surface.className = 'chat-local-older-surface';
        classifyChatStructuralSurface(surface, 'window:local-older', 'local-history-window');
        chatWindowState.localOlderSurface = surface;
        return surface;
    }

    function reserveChatWindowStructuralRoots() {
        ensureChatWindowSpacers();
        ensureChatLocalOlderSurface();
    }

    function activateChatLocalOlder(source = 'button') {
        const sessionId = activeSessionId || '__no_session__';
        const keys = chatWindowState.allUnits.map((unit) => unit.key);
        captureChatWindowAnchor();
        const result = chatLocalHistoryController.activate(sessionId, keys, source);
        if (!result.accepted) return false;
        chatWindowState.activityBelow = !autoScrollPinnedToBottom;
        scheduleRenderFromState(`local-older-${source}`);
        return true;
    }

    function renderChatLocalOlderSurface(presentation, suppressContent) {
        const surface = ensureChatLocalOlderSurface();
        surface.replaceChildren();
        surface.dataset.localOlderState = presentation.state;
        if (suppressContent === true) {
            chatWindowState.localOlderObserver?.disconnect?.();
            chatWindowState.localOlderObserver = null;
            chatWindowState.localOlderObserverArmed = true;
        } else if (presentation.actionable) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chat-local-older-button';
            button.textContent = 'Load older';
            button.setAttribute('aria-label', 'Load older messages');
            button.addEventListener('click', () => activateChatLocalOlder('click'));
            surface.appendChild(button);
            if (!chatWindowState.localOlderObserver && typeof IntersectionObserver === 'function') {
                chatWindowState.localOlderObserver = new IntersectionObserver((entries) => {
                    const latest = entries[entries.length - 1];
                    if (!latest) return;
                    if (!latest.isIntersecting) {
                        chatWindowState.localOlderObserverArmed = true;
                        return;
                    }
                    if (!chatWindowState.localOlderObserverArmed) return;
                    chatWindowState.localOlderObserverArmed = false;
                    activateChatLocalOlder('intersection');
                }, { root: chatContainer, rootMargin: '80px 0px 0px 0px' });
                chatWindowState.localOlderObserver.observe(surface);
            }
        } else {
            chatWindowState.localOlderObserver?.disconnect?.();
            chatWindowState.localOlderObserver = null;
            chatWindowState.localOlderObserverArmed = true;
            const label = document.createElement('div');
            label.className = 'chat-local-older-label';
            label.setAttribute('role', 'status');
            label.textContent = presentation.label;
            surface.appendChild(label);
            if (presentation.hint) {
                const hint = document.createElement('div');
                hint.className = 'chat-local-older-hint';
                hint.textContent = presentation.hint;
                surface.appendChild(hint);
            }
        }
        const admission = preflightChatRenderRootAdmission(surface);
        if (!admission.allowed) return false;
        chatContainer.insertBefore(surface, chatWindowState.topSpacer || keyedRoots()[0] || null);
        chatStructuralRootReservations.delete(surface);
        return true;
    }

    function resolveChatLocalHistoryWindow(units) {
        const sessionId = activeSessionId || '__no_session__';
        const session = getSessionState(activeSessionId, false);
        const coverage = normalizePayloadHydrationCoverage(session?.hydrationCoverage);
        const resolution = chatLocalHistoryController.resolve(sessionId, units.map((unit) => unit.key), coverage);
        chatWindowState.localHistoryPresentation = resolution.presentation;
        return {
            ...resolution,
            visibleUnits: units.slice(resolution.revealStart),
            suppressSurfaceContent: isActiveSessionHistoryLoading()
                || resolution.presentation.state === 'deltaContinuityUnknown'
                || units.every((unit) => unit.kind === 'greeting')
        };
    }

    function clearPendingChatWindowScroll(reason) {
        const targetKey = chatWindowState.pendingScrollKey;
        if (targetKey) {
            vscode.postMessage({ type: 'ui-debug', payload: ['[WV][CHAT_WINDOW_SEARCH_PENDING_CLEAR]', `reason=${reason}`, `key=${targetKey}`, `attempts=${chatWindowState.pendingScrollAttempts}`] });
        }
        chatWindowState.pendingScrollKey = '';
        chatWindowState.pendingScrollAttempts = 0;
        if (targetKey && sessionSearch.windowTargetKey === targetKey) {
            sessionSearch.clearWindowTargetKey(targetKey);
        }
    }

    function tryPendingChatWindowScroll(reason) {
        const targetKey = chatWindowState.pendingScrollKey;
        if (!targetKey || !chatWindowState.adapter) return false;
        if (!chatWindowState.allUnits.some((unit) => unit.key === targetKey)) {
            clearPendingChatWindowScroll('target-disappeared');
            return false;
        }
        chatWindowState.pendingScrollAttempts += 1;
        if (chatWindowState.adapter.scrollToKey(targetKey, { align: 'center' })) {
            clearPendingChatWindowScroll(`adapter-success:${reason}`);
            return true;
        }
        const mountedRoot = keyedRootForKey(targetKey);
        if (mountedRoot) {
            mountedRoot.scrollIntoView?.({ block: 'center', behavior: 'auto' });
            clearPendingChatWindowScroll(`mounted-success:${reason}`);
            return true;
        }
        if (chatWindowState.pendingScrollAttempts >= CHAT_PENDING_SCROLL_MAX_ATTEMPTS) {
            vscode.postMessage({ type: 'ui-debug', payload: ['[WV][CHAT_WINDOW_SEARCH_PENDING_TERMINAL]', `reason=${reason}`, `key=${targetKey}`, `attempts=${chatWindowState.pendingScrollAttempts}`] });
            clearPendingChatWindowScroll('attempt-limit');
        }
        return false;
    }

    function captureChatWindowAnchor() {
        if (!chatWindowState.adapter || autoScrollPinnedToBottom || chatWindowState.programmaticScroll) return;
        const roots = keyedRoots();
        const anchor = roots.find((root) => root.offsetTop + root.offsetHeight > chatContainer.scrollTop) || roots[0];
        if (!anchor?.dataset?.renderUnitKey) return;
        chatWindowState.anchorKey = anchor.dataset.renderUnitKey;
        chatWindowState.visualOffset = anchor.offsetTop - chatContainer.scrollTop;
    }

    function restoreChatWindowAnchor() {
        if (!chatWindowState.anchorKey || autoScrollPinnedToBottom || !chatWindowState.snapshot
            || Date.now() < chatWindowState.userScrollActiveUntil) return;
        const item = chatWindowState.snapshot.items.find((entry) => entry.key === chatWindowState.anchorKey);
        if (!item) return;
        const rendering = window.__ocRendering;
        const anchorRoot = keyedRootForKey(chatWindowState.anchorKey);
        const plan = rendering.restoreKeyedScrollAnchor({
            anchorKey: chatWindowState.anchorKey,
            visualOffset: chatWindowState.visualOffset,
            anchorStartAfter: anchorRoot?.offsetTop ?? item.start,
            currentScrollTop: chatContainer.scrollTop
        });
        chatWindowState.programmaticScroll = true;
        chatContainer.scrollTop = plan.scrollTop;
        requestAnimationFrame(() => { chatWindowState.programmaticScroll = false; });
    }

    function getChatWindowKeepMountedKeys(session, units) {
        const unitKeys = new Set(units.map((unit) => unit.key));
        const keys = [session?.currentTurnAssistantKey, session?.thinkingId, chatWindowState.anchorKey, sessionSearch.windowTargetKey]
            .filter((key) => typeof key === 'string' && unitKeys.has(key));
        return [...new Set(keys)];
    }

    function projectChatWindowStructuralRoots() {
        const projectedRoots = new Set();
        for (const child of Array.from(chatContainer.children)) {
            if (!child.dataset?.renderUnitKey) projectedRoots.add(child);
        }
        for (const root of chatStructuralRootReservations) projectedRoots.add(root);
        projectedRoots.add(chatWindowState.topSpacer || CHAT_WINDOW_PROJECTED_TOP_SPACER);
        projectedRoots.add(chatWindowState.bottomSpacer || CHAT_WINDOW_PROJECTED_BOTTOM_SPACER);
        projectedRoots.add(chatWindowState.localOlderSurface || CHAT_WINDOW_PROJECTED_LOCAL_OLDER);
        return projectedRoots.size;
    }

    function getChatStructuralIntegrityRoots() {
        return Array.from(chatContainer.children)
            .filter((child) => !child.dataset?.renderUnitKey)
            .map((child) => ({ classified: Boolean(child.dataset?.chatStructuralKey) }));
    }

    function preflightChatRenderRootAdmission(root, projectedUnitKey = '') {
        if (keyedChatRenderCapture) return { allowed: true, detached: true, mountedCount: 0, directChildCount: 0 };
        const unitKey = projectedUnitKey || root?.dataset?.renderUnitKey || '';
        if (root && !unitKey) reserveChatStructuralRoot(root);
        if (!isChatWindowAvailable()) {
            return { allowed: true, mountedCount: keyedRoots().length, directChildCount: chatContainer.childElementCount };
        }
        const requestedKeys = keyedRoots().map((keyedRoot) => keyedRoot.dataset.renderUnitKey);
        if (unitKey && !requestedKeys.includes(unitKey)) requestedKeys.push(unitKey);
        const projectedStructuralRoots = projectChatWindowStructuralRoots();
        const directChildCount = requestedKeys.length + projectedStructuralRoots;
        const planContainment = globalThis.window?.__ocRendering?.planChatWindowContainment;
        const plan = typeof planContainment === 'function'
            ? planContainment({
                requestedKeys,
                visibleLoadedKeys: requestedKeys,
                viewportKeys: requestedKeys,
                coreKeys: [],
                overscanKeys: [],
                adapterSnapshotKeys: requestedKeys,
                appendRootUserKey: unitKey || undefined,
                projectedStructuralRoots,
                limits: { mounted: CHAT_WINDOW_MOUNT_LIMIT, directChildren: CHAT_WINDOW_DIRECT_CHILD_LIMIT },
                shellRequests: []
            })
            : null;
        const acceptedKeys = Array.isArray(plan?.acceptedKeys) ? new Set(plan.acceptedKeys) : new Set();
        const preservesMountedSet = requestedKeys.every((key) => acceptedKeys.has(key));
        const allowed = plan?.allowed === true
            && preservesMountedSet
            && requestedKeys.length <= CHAT_WINDOW_MOUNT_LIMIT
            && directChildCount <= CHAT_WINDOW_DIRECT_CHILD_LIMIT
            && Number(plan.directChildCount) <= CHAT_WINDOW_DIRECT_CHILD_LIMIT;
        const isWindowStructuralRoot = root === chatWindowState.topSpacer
            || root === chatWindowState.bottomSpacer
            || root === chatWindowState.localOlderSurface;
        if (!allowed && root && !isWindowStructuralRoot) chatStructuralRootReservations.delete(root);
        return { allowed, mountedCount: requestedKeys.length, directChildCount, plan };
    }

    function buildChatWindowContainmentRequest(session, visibleUnits, snapshot, explicitShellRequests = []) {
        const requestedKeys = snapshot.items.map((item) => item.key);
        const visibleLoadedKeys = visibleUnits.map((unit) => unit.key);
        const viewportStart = Math.max(0, Number(chatContainer.scrollTop) || 0);
        const viewportEnd = viewportStart + Math.max(0, Number(chatContainer.clientHeight) || 0);
        const coreKeys = snapshot.items
            .filter((item) => item.end > viewportStart && item.start < viewportEnd)
            .map((item) => item.key);
        const coreSet = new Set(coreKeys);
        const optionalKeys = requestedKeys.filter((key) => !coreSet.has(key));
        return {
            requestedKeys,
            visibleLoadedKeys,
            viewportKeys: coreKeys,
            coreKeys: [],
            overscanKeys: optionalKeys,
            adapterSnapshotKeys: requestedKeys,
            currentTurnAssistantKey: session?.currentTurnAssistantKey,
            thinkingId: session?.thinkingId,
            lastTurnUserId: session?.lastTurnUserId,
            appendRootUserKey: session?.appendRootUserKey,
            anchorKey: chatWindowState.anchorKey,
            searchTargetKey: sessionSearch.windowTargetKey,
            projectedStructuralRoots: projectChatWindowStructuralRoots(),
            limits: { mounted: CHAT_WINDOW_MOUNT_LIMIT, directChildren: CHAT_WINDOW_DIRECT_CHILD_LIMIT },
            shellRequests: explicitShellRequests
        };
    }

    function disposeUnpublishedChatWindowAdapterCandidate(candidateAdapter) {
        if (!candidateAdapter || (typeof candidateAdapter !== 'object' && typeof candidateAdapter !== 'function')
            || disposedUnpublishedChatWindowCandidates.has(candidateAdapter)) return false;
        disposedUnpublishedChatWindowCandidates.add(candidateAdapter);
        try {
            const destroy = candidateAdapter.destroy;
            if (typeof destroy === 'function') destroy.call(candidateAdapter);
        } catch { /* unpublished candidate cleanup is best-effort and never reaches live ownership */ }
        return true;
    }

    function prepareUnpublishedChatWindowTransaction(session, units, explicitShellRequests = [], transactionControl = null) {
        const cf3RunPhase = typeof runCF3RangeDiagnosticPhase === 'function'
            ? runCF3RangeDiagnosticPhase : (_phase, operation) => operation();
        const candidateAcceptedState = typeof captureChatWindowAcceptedState === 'function'
            ? captureChatWindowAcceptedState()
            : null;
        const capturedActiveSessionId = activeSessionId || '__no_session__';
        const capturedGeneration = chatWindowGeneration;
        const capturedAdapter = chatWindowState.adapter;
        const capturedOwnerSessionId = chatWindowState.sessionId;
        if (capturedAdapter) return CHAT_WINDOW_CANDIDATE_STALE_RESULT;
        const syntheticEvidenceRequest = typeof consumeChatWindowSyntheticEvidenceRequest === 'function'
            ? consumeChatWindowSyntheticEvidenceRequest(transactionControl?.syntheticEvidenceToken)
            : null;
        const syntheticEvidenceDirection = transactionControl?.syntheticEvidenceDirection === 'backward' ? 'backward' : 'forward';
        const rangePolicy = syntheticEvidenceRequest ? Object.freeze({
            overscanTier: syntheticEvidenceRequest.overscanTier,
            beforeReserve: syntheticEvidenceDirection === 'backward'
                ? syntheticEvidenceRequest.forwardReserve : syntheticEvidenceRequest.backwardReserve,
            afterReserve: syntheticEvidenceDirection === 'backward'
                ? syntheticEvidenceRequest.backwardReserve : syntheticEvidenceRequest.forwardReserve,
            initialTail: syntheticEvidenceRequest.initialTail
        }) : typeof resolveChatWindowAdaptiveRangePolicy === 'function'
            ? resolveChatWindowAdaptiveRangePolicy() : undefined;
        const rendering = window.__ocRendering;
        const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);
        const requestedKeys = boundedUnits.map((unit) => unit.key);
        const sessionState = getSessionState(activeSessionId, false);
        const hydrationCoverage = normalizePayloadHydrationCoverage(sessionState?.hydrationCoverage);
        const revealStart = Math.max(0, units.length - boundedUnits.length);
        const deriveLocalOlderPresentation = rendering?.deriveLocalOlderPresentation;
        const planContainment = rendering?.planChatWindowContainment;
        if (typeof deriveLocalOlderPresentation !== 'function' || typeof planContainment !== 'function') {
            return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;
        }
        const presentation = deriveLocalOlderPresentation({
            totalUnits: units.length,
            revealStart,
            hydrationCoverage
        });
        const acceptedPlan = transactionControl?.acceptedPlanOverride || planContainment({
            requestedKeys,
            visibleLoadedKeys: requestedKeys,
            viewportKeys: requestedKeys,
            coreKeys: [],
            overscanKeys: [],
            adapterSnapshotKeys: requestedKeys,
            currentTurnAssistantKey: session?.currentTurnAssistantKey,
            thinkingId: session?.thinkingId,
            lastTurnUserId: session?.lastTurnUserId,
            appendRootUserKey: session?.appendRootUserKey,
            anchorKey: chatWindowState.anchorKey,
            searchTargetKey: sessionSearch.windowTargetKey,
            projectedStructuralRoots: projectChatWindowStructuralRoots(),
            limits: { mounted: CHAT_WINDOW_MOUNT_LIMIT, directChildren: CHAT_WINDOW_DIRECT_CHILD_LIMIT },
            shellRequests: explicitShellRequests
        });
        if (!acceptedPlan?.allowed || !Array.isArray(acceptedPlan.acceptedKeys)
            || acceptedPlan.mountedCount > CHAT_WINDOW_MOUNT_LIMIT
            || acceptedPlan.directChildCount > CHAT_WINDOW_DIRECT_CHILD_LIMIT) {
            return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;
        }
        const unitByKey = new Map(boundedUnits.map((unit) => [unit.key, unit]));
        const acceptedUnits = acceptedPlan.acceptedKeys.map((key) => unitByKey.get(key)).filter(Boolean);
        const acceptedKeySet = new Set(acceptedUnits.map((unit) => unit.key));
        const adapterUpdate = Object.freeze({
            keys: Object.freeze(acceptedUnits.map((unit) => unit.key)),
            kinds: Object.freeze(acceptedUnits.map(getChatWindowUnitKind)),
            presentationRevisions: Object.freeze(acceptedUnits.map((unit) => rendering.presentationFingerprint(
                getKeyedPresentationIdentity(getKeyedUnitPresentation(session, unit), acceptedPlan.shellSelections?.[unit.key])
            ))),
            keepMountedKeys: Object.freeze(getChatWindowKeepMountedKeys(session, acceptedUnits)
                .filter((key) => acceptedKeySet.has(key))),
            ...(rangePolicy ? { rangePolicy } : {})
        });
        const localWindow = Object.freeze({
            revealStart,
            visibleKeys: adapterUpdate.keys,
            presentation,
            visibleUnits: Object.freeze(acceptedUnits)
        });
        const candidateGeneration = capturedGeneration + 1;
        let published = false;
        let candidateAdapter = null;
        let adapterTransaction = null;
        let candidateAbort = null;
        let abortAttempted = false;
        const abortCandidateTransaction = () => {
            if (abortAttempted || typeof candidateAbort !== 'function') return false;
            abortAttempted = true;
            try {
                candidateAbort.call(adapterTransaction);
            } catch { /* unavailable-handle abort is best-effort */ }
            return true;
        };
        const rejectCandidate = (result) => {
            abortCandidateTransaction();
            disposeUnpublishedChatWindowAdapterCandidate(candidateAdapter);
            return result;
        };
        try {
            candidateAdapter = cf3RunPhase('initial-create', () => rendering.createTanStackVirtualAdapter({
                keys: adapterUpdate.keys,
                kinds: adapterUpdate.kinds,
                presentationRevisions: adapterUpdate.presentationRevisions,
                keepMountedKeys: adapterUpdate.keepMountedKeys,
                scrollElement: chatContainer,
                overscan: CHAT_WINDOW_OVERSCAN,
                initialTailCount: CHAT_WINDOW_INITIAL_TAIL,
                maxMounted: CHAT_WINDOW_MOUNT_LIMIT,
                gap: 8,
                initialOwnerMode: 'deferred-transaction',
                onRangeChange(snapshot) {
                    if (!published) return;
                    if (candidateGeneration !== chatWindowGeneration || chatWindowState.sessionId !== capturedActiveSessionId) {
                        recordChatWindowStaleCallback(candidateGeneration, 'range');
                        if (typeof resetChatWindowAdaptiveShadow === 'function') resetChatWindowAdaptiveShadow('stale-generation', candidateGeneration);
                        return;
                    }
                    const acknowledged = chatWindowState.acknowledgedRawSnapshot;
                    if (typeof recordCF3RangeDiagnostic === 'function') recordCF3RangeDiagnostic(snapshot, Object.freeze({
                        rendering: chatWindowState.rendering === true,
                        pendingRangeRender: chatWindowState.pendingRangeRender === true,
                        pendingScrollPresent: Boolean(chatWindowState.pendingScrollKey),
                        programmaticScroll: chatWindowState.programmaticScroll === true,
                        acknowledgedCount: Array.isArray(acknowledged?.items) ? acknowledged.items.length : 0,
                        acknowledgedTotalSize: Number.isFinite(acknowledged?.totalSize) ? Number(acknowledged.totalSize) : 0,
                        firstDifference: typeof getCF3RangeFirstDifference === 'function'
                            ? getCF3RangeFirstDifference(snapshot, acknowledged) : 'missing-ack',
                        scrollTop: Number.isFinite(chatContainer?.scrollTop) ? Number(chatContainer.scrollTop) : 0
                    }));
                    chatWindowState.snapshot = snapshot;
                    const sameAcknowledgedRawSnapshot = acknowledged
                        && snapshot.totalSize === acknowledged.totalSize
                        && snapshot.items.length === acknowledged.items.length
                        && snapshot.items.every((item, index) => {
                            const prior = acknowledged.items[index];
                            return item.key === prior.key
                                && item.index === prior.index
                                && item.start === prior.start
                                && item.end === prior.end
                                && item.size === prior.size;
                        });
                    if (sameAcknowledgedRawSnapshot) {
                        if (chatWindowState.rendering && chatWindowState.pendingScrollKey) {
                            chatWindowState.pendingRangeRender = true;
                        }
                        return;
                    }
                    const pinnedContainedContraction = autoScrollPinnedToBottom
                        && acknowledged
                        && snapshot.totalSize === acknowledged.totalSize
                        && snapshot.items.length > 0
                        && snapshot.items.length < chatWindowState.mountedKeys.size
                        && snapshot.items.every((item) => chatWindowState.mountedKeys.has(item.key));
                    if (pinnedContainedContraction) {
                        // A bottom-clamped viewport can alternate by one boundary item after DOM
                        // measurement. Keep the already-mounted superset so that range callbacks
                        // converge without a render/scroll feedback loop.
                        chatWindowState.snapshot = acknowledged;
                        return;
                    }
                    const priorObservations = typeof chatWindowAdaptiveShadow !== 'undefined'
                        ? chatWindowAdaptiveShadow?.observations : null;
                    const rangeObservations = typeof createChatWindowAdaptiveObservations === 'function' ? createChatWindowAdaptiveObservations(
                        snapshot,
                        priorObservations ? {
                            directChildren: priorObservations.directChildCount,
                            descendants: priorObservations.descendantCount
                        } : null,
                        priorObservations?.currentRequestedCount || adapterUpdate.keys.length,
                        acceptedPlan,
                        session
                    ) : null;
                    if (rangeObservations && typeof observeChatWindowAdaptiveShadow === 'function') observeChatWindowAdaptiveShadow(rangeObservations, {
                        kind: 'self', decisionGeneration: typeof chatWindowAdaptiveShadow !== 'undefined'
                            ? chatWindowAdaptiveShadow?.state?.decisionGeneration : 0
                    });
                    const sameMountedRange = snapshot.items.length === chatWindowState.mountedKeys.size
                        && snapshot.items.every((item) => chatWindowState.mountedKeys.has(item.key));
                    if (sameMountedRange && chatWindowState.topSpacer && chatWindowState.bottomSpacer) {
                        updateChatWindowSpacers(snapshot);
                        if (autoScrollPinnedToBottom) scrollToBottom(true);
                        return;
                    }
                    if (chatWindowState.rendering && chatWindowState.pendingScrollKey) {
                        chatWindowState.pendingRangeRender = true;
                        return;
                    }
                    if (!chatWindowState.rendering && !chatWindowState.pendingRangeRender) {
                        chatWindowState.pendingRangeRender = true;
                        scheduleRenderFromState('window-range-change');
                    }
                },
                onMeasurements(batch) {
                    if (!published) return;
                    if (candidateGeneration !== chatWindowGeneration || chatWindowState.sessionId !== capturedActiveSessionId) {
                        recordChatWindowStaleCallback(candidateGeneration, 'measurement');
                        if (typeof resetChatWindowAdaptiveShadow === 'function') resetChatWindowAdaptiveShadow('stale-generation', candidateGeneration);
                        return;
                    }
                    const priorObservations = typeof chatWindowAdaptiveShadow !== 'undefined'
                        ? chatWindowAdaptiveShadow?.observations : null;
                    if (chatWindowState.snapshot && typeof createChatWindowAdaptiveObservations === 'function'
                        && typeof observeChatWindowAdaptiveShadow === 'function') observeChatWindowAdaptiveShadow(createChatWindowAdaptiveObservations(
                        chatWindowState.snapshot,
                        priorObservations ? {
                            directChildren: priorObservations.directChildCount,
                            descendants: priorObservations.descendantCount
                        } : null,
                        priorObservations?.currentRequestedCount || adapterUpdate.keys.length,
                        acceptedPlan,
                        session,
                        batch.changedKeys.length
                    ), { kind: 'self', decisionGeneration: typeof chatWindowAdaptiveShadow !== 'undefined'
                        ? chatWindowAdaptiveShadow?.state?.decisionGeneration : 0 });
                    vscode.postMessage({ type: 'ui-debug', payload: ['[WV][CHAT_WINDOW_MEASURE]', `changed=${batch.changedKeys.length}`, `totalSize=${batch.totalSize}`] });
                    if (autoScrollPinnedToBottom) scrollToBottom(true);
                    else {
                        chatWindowState.activityBelow = true;
                        requestAnimationFrame(updateChatJumpBottomButton);
                        restoreChatWindowAnchor();
                    }
                    if (chatWindowState.pendingScrollKey && batch.changedKeys.length && !chatWindowState.pendingRangeRender) {
                        chatWindowState.pendingRangeRender = true;
                        scheduleRenderFromState('window-search-measurement-retry');
                    }
                }
            }));
        } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        let getInitialOwnerState;
        try { getInitialOwnerState = candidateAdapter?.getInitialOwnerState; } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        if (typeof getInitialOwnerState !== 'function') return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        try {
            if (getInitialOwnerState.call(candidateAdapter) !== 'deferred') {
                return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
            }
        } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        let beginTransaction;
        try { beginTransaction = candidateAdapter?.beginTransaction; } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        if (typeof beginTransaction !== 'function') return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        try {
            adapterTransaction = beginTransaction.call(candidateAdapter, adapterUpdate);
        } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        if (!adapterTransaction) return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        try {
            candidateAbort = adapterTransaction.abort;
            for (const method of CHAT_WINDOW_REQUIRED_TRANSACTION_METHODS) {
                const member = method === 'abort' ? candidateAbort : adapterTransaction[method];
                if (typeof member !== 'function') {
                    return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
                }
            }
        } catch {
            return rejectCandidate(CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        }
        if ((activeSessionId || '__no_session__') !== capturedActiveSessionId
            || chatWindowGeneration !== capturedGeneration
            || chatWindowState.adapter !== capturedAdapter
            || chatWindowState.sessionId !== capturedOwnerSessionId) {
            return rejectCandidate(CHAT_WINDOW_CANDIDATE_STALE_RESULT);
        }
        chatWindowGeneration = candidateGeneration;
        chatWindowState.sessionId = capturedActiveSessionId;
        chatWindowState.adapter = candidateAdapter;
        if (candidateAcceptedState) unpublishedChatWindowCandidateAcceptedStates.set(candidateAdapter, candidateAcceptedState);
        beginChatWindowPressureGeneration(candidateGeneration);
        published = true;
        return Object.freeze({ candidateAdapter, adapterTransaction, adapterUpdate, localWindow, acceptedPlan });
    }

    function ensureChatWindowAdapter(session, units, explicitShellRequests = [], transactionControl = null) {
        const sessionId = activeSessionId || '__no_session__';
        const rendering = window.__ocRendering;
        if (!chatWindowState.adapter) {
            return prepareUnpublishedChatWindowTransaction(session, units, explicitShellRequests, transactionControl);
        }
        if (chatWindowState.sessionId !== sessionId) return CHAT_WINDOW_CANDIDATE_STALE_RESULT;
        const keys = units.map((unit) => unit.key);
        const kinds = units.map(getChatWindowUnitKind);
        const presentationRevisions = units.map((unit) => rendering.presentationFingerprint(getKeyedUnitPresentation(session, unit)));
        const keepMountedKeys = getChatWindowKeepMountedKeys(session, units);
        chatWindowState.adapter.update({ keys, kinds, presentationRevisions, keepMountedKeys });
        return chatWindowState.adapter;
    }

    function updateChatWindowSpacers(snapshot) {
        ensureChatWindowSpacers();
        const first = snapshot.items[0];
        const last = snapshot.items[snapshot.items.length - 1];
        chatWindowState.topSpacer.style.height = `${Math.max(0, first?.start || 0)}px`;
        chatWindowState.bottomSpacer.style.height = `${Math.max(0, snapshot.totalSize - (last?.end || 0))}px`;
        const topAdmission = preflightChatRenderRootAdmission(chatWindowState.topSpacer);
        const bottomAdmission = preflightChatRenderRootAdmission(chatWindowState.bottomSpacer);
        if (!topAdmission.allowed || !bottomAdmission.allowed) return false;
        chatContainer.insertBefore(chatWindowState.topSpacer, keyedRoots()[0] || chatWindowState.bottomSpacer || null);
        chatContainer.appendChild(chatWindowState.bottomSpacer);
        chatStructuralRootReservations.delete(chatWindowState.topSpacer);
        chatStructuralRootReservations.delete(chatWindowState.bottomSpacer);
        return true;
    }

    function assertChatWindowDomBudget(budget) {
        const bounded = (value) => Number.isFinite(value)
            ? Math.min(1000000000, Math.max(0, Math.trunc(value)))
            : 0;
        let descendantsAdvisory = false;
        if (budget.descendants > 4000) descendantsAdvisory = true;
        window.__ocChatWindowDomBudgetAudit = Object.freeze({
            mountedUnits: bounded(budget.mountedUnits),
            directChildren: bounded(budget.directChildren),
            descendants: bounded(budget.descendants),
            mountedExceeded: budget.mountedUnits > CHAT_WINDOW_MOUNT_LIMIT,
            directChildrenExceeded: budget.directChildren > CHAT_WINDOW_DIRECT_CHILD_LIMIT,
            descendantsAdvisory
        });
        return budget;
    }

    function scheduleChatWindowPlanCorrection(options) {
        const { sessionId, generation, planRevision, request, acceptedPlan, observedBudget } = options;
        const mountedMismatch = Math.max(0, observedBudget.mountedUnits - acceptedPlan.mountedCount);
        const directChildMismatch = Math.max(0, observedBudget.directChildren - acceptedPlan.directChildCount);
        if (mountedMismatch === 0 && directChildMismatch === 0) return null;
        if ((activeSessionId || '__no_session__') !== sessionId || chatWindowGeneration !== generation) return null;
        if (chatWindowPlanCorrection.sessionId === sessionId
            && chatWindowPlanCorrection.generation === generation
            && chatWindowPlanCorrection.planRevision === planRevision) return null;
        chatWindowPlanCorrection = { sessionId, generation, planRevision };
        const planContainment = window.__ocRendering?.planChatWindowContainment;
        if (typeof planContainment !== 'function') return null;
        const correctionRequest = {
            ...request,
            limits: {
                mounted: Math.max(0, request.limits.mounted - mountedMismatch),
                directChildren: Math.max(0, request.limits.directChildren - directChildMismatch)
            }
        };
        const correctedPlan = planContainment(correctionRequest);
        if ((activeSessionId || '__no_session__') !== sessionId || chatWindowGeneration !== generation) return null;
        if (!correctedPlan?.allowed || !Array.isArray(correctedPlan.acceptedKeys)) return null;
        const requestedKeySet = new Set(request.requestedKeys);
        const baselineMounted = acceptedPlan.acceptedKeys.filter((key) => requestedKeySet.has(key)).length;
        const baselineDirectChildren = Math.min(
            acceptedPlan.directChildCount,
            baselineMounted + request.projectedStructuralRoots
        );
        const reduced = correctedPlan.acceptedKeys.length < baselineMounted
            || correctedPlan.mountedCount < baselineMounted
            || correctedPlan.directChildCount < baselineDirectChildren;
        return reduced ? correctedPlan : null;
    }

    function boundedChatPressureCount(value) {
        if (!Number.isFinite(value)) return 0;
        return Math.min(1000000000, Math.max(0, Math.trunc(value)));
    }

    function publishChatWindowPressureLifecycle() {
        if (typeof isChatRenderMetricsEnabled !== 'function' || !isChatRenderMetricsEnabled()) return;
        if (typeof chatRenderMetrics === 'undefined') return;
        const current = chatWindowPressureLifecycle.current;
        chatRenderMetrics.pressureLifecycle = {
            current: current ? {
                generation: boundedChatPressureCount(current.generation),
                unobserveRequested: boundedChatPressureCount(current.unobserveRequested),
                unobserveCompleted: boundedChatPressureCount(current.unobserveCompleted),
                removalRequested: boundedChatPressureCount(current.removalRequested),
                removalCompleted: boundedChatPressureCount(current.removalCompleted),
                staleRangeRejections: boundedChatPressureCount(current.staleRangeRejections),
                staleMeasurementRejections: boundedChatPressureCount(current.staleMeasurementRejections),
                residualRootAudits: boundedChatPressureCount(current.residualRootAudits),
                residualRoots: boundedChatPressureCount(current.residualRoots),
                residualRootsPresent: current.residualRoots > 0
            } : null,
            closures: chatWindowPressureLifecycle.closures.slice(-8).map((closure) => ({
                generation: boundedChatPressureCount(closure.generation),
                unobserveRequested: boundedChatPressureCount(closure.unobserveRequested),
                unobserveCompleted: boundedChatPressureCount(closure.unobserveCompleted),
                removalRequested: boundedChatPressureCount(closure.removalRequested),
                removalCompleted: boundedChatPressureCount(closure.removalCompleted),
                staleRangeRejections: boundedChatPressureCount(closure.staleRangeRejections),
                staleMeasurementRejections: boundedChatPressureCount(closure.staleMeasurementRejections),
                adapterDestroyRequested: boundedChatPressureCount(closure.adapterDestroyRequested),
                adapterDestroyCompleted: boundedChatPressureCount(closure.adapterDestroyCompleted),
                sessionSwitch: closure.sessionSwitch === true,
                generationClosed: closure.generationClosed === true,
                residualRootAudits: boundedChatPressureCount(closure.residualRootAudits),
                residualRoots: boundedChatPressureCount(closure.residualRoots),
                residualRootsPresent: closure.residualRoots > 0
            }))
        };
        chatRenderMetricsDirty = true;
    }

    function beginChatWindowPressureGeneration(generation) {
        if (typeof isChatRenderMetricsEnabled !== 'function' || !isChatRenderMetricsEnabled()) return;
        chatWindowPressureLifecycle.current = {
            generation: boundedChatPressureCount(generation),
            unobserveRequested: 0,
            unobserveCompleted: 0,
            removalRequested: 0,
            removalCompleted: 0,
            staleRangeRejections: 0,
            staleMeasurementRejections: 0,
            residualRootAudits: 0,
            residualRoots: 0
        };
        publishChatWindowPressureLifecycle();
    }

    function recordChatWindowCleanupCheckpoint(kind, generation, requested, completed, residualRoots) {
        if (typeof isChatRenderMetricsEnabled !== 'function' || !isChatRenderMetricsEnabled()) return;
        const current = chatWindowPressureLifecycle.current;
        if (!current || current.generation !== boundedChatPressureCount(generation)) return;
        const requestedCount = boundedChatPressureCount(requested);
        const completedCount = boundedChatPressureCount(completed);
        if (kind === 'unobserve') {
            current.unobserveRequested = boundedChatPressureCount(current.unobserveRequested + requestedCount);
            current.unobserveCompleted = boundedChatPressureCount(current.unobserveCompleted + completedCount);
        } else if (kind === 'removal') {
            current.removalRequested = boundedChatPressureCount(current.removalRequested + requestedCount);
            current.removalCompleted = boundedChatPressureCount(current.removalCompleted + completedCount);
        } else {
            return;
        }
        current.residualRootAudits = boundedChatPressureCount(current.residualRootAudits + 1);
        current.residualRoots = boundedChatPressureCount(current.residualRoots + boundedChatPressureCount(residualRoots));
        publishChatWindowPressureLifecycle();
    }

    function recordChatWindowStaleCallback(generation, kind) {
        if (typeof isChatRenderMetricsEnabled !== 'function' || !isChatRenderMetricsEnabled()) return;
        const normalizedGeneration = boundedChatPressureCount(generation);
        const owner = chatWindowPressureLifecycle.current?.generation === normalizedGeneration
            ? chatWindowPressureLifecycle.current
            : chatWindowPressureLifecycle.closures.find((closure) => closure.generation === normalizedGeneration);
        if (!owner) return;
        if (kind === 'range') owner.staleRangeRejections = boundedChatPressureCount(owner.staleRangeRejections + 1);
        else if (kind === 'measurement') owner.staleMeasurementRejections = boundedChatPressureCount(owner.staleMeasurementRejections + 1);
        else return;
        publishChatWindowPressureLifecycle();
    }

    function closeChatWindowPressureGeneration(generation, sessionSwitch, adapterDestroyed, residualRoots) {
        if (typeof isChatRenderMetricsEnabled !== 'function' || !isChatRenderMetricsEnabled()) return;
        const normalizedGeneration = boundedChatPressureCount(generation);
        const current = chatWindowPressureLifecycle.current;
        if (!current || current.generation !== normalizedGeneration) return;
        if (!chatWindowPressureLifecycle.closures.some((closure) => closure.generation === normalizedGeneration)) {
            chatWindowPressureLifecycle.closures.push({
                generation: normalizedGeneration,
                unobserveRequested: current.unobserveRequested,
                unobserveCompleted: current.unobserveCompleted,
                removalRequested: current.removalRequested,
                removalCompleted: current.removalCompleted,
                staleRangeRejections: current.staleRangeRejections,
                staleMeasurementRejections: current.staleMeasurementRejections,
                adapterDestroyRequested: adapterDestroyed ? 1 : 0,
                adapterDestroyCompleted: adapterDestroyed ? 1 : 0,
                sessionSwitch: sessionSwitch === true,
                generationClosed: true,
                residualRootAudits: boundedChatPressureCount(current.residualRootAudits + 1),
                residualRoots: boundedChatPressureCount(current.residualRoots + boundedChatPressureCount(residualRoots))
            });
            chatWindowPressureLifecycle.closures = chatWindowPressureLifecycle.closures.slice(-8);
        }
        chatWindowPressureLifecycle.current = null;
        if (typeof chatRenderMetrics !== 'undefined') chatRenderMetrics.pressureAttribution = null;
        publishChatWindowPressureLifecycle();
    }

    function normalizeChatPressureKind(value) {
        return ['greeting', 'message', 'change-list', 'segment', 'conflict', 'system'].includes(value)
            ? value
            : 'unknown';
    }

    function normalizeChatPressureRole(value) {
        return ['user', 'assistant', 'system'].includes(value) ? value : 'unknown';
    }

    function recordChatWindowPressureAttribution(visibleUnits, windowUnits, snapshot, pins, directChildren, descendants) {
        if (!isChatRenderMetricsEnabled()) return;
        const buildAttribution = window.__ocRendering?.buildChatPressureAttribution;
        if (typeof buildAttribution !== 'function') return;

        const acceptedItems = Array.isArray(snapshot?.items)
            ? snapshot.items.slice(0, CHAT_WINDOW_MOUNT_LIMIT)
            : [];
        const acceptedKeys = new Set(acceptedItems.map((item) => item.key));
        const pinnedKeys = new Set(Array.isArray(pins) ? pins.slice(0, CHAT_WINDOW_MOUNT_LIMIT) : []);
        const unitByKey = new Map((Array.isArray(windowUnits) ? windowUnits : []).slice(0, CHAT_WINDOW_MOUNT_LIMIT).map((unit) => [unit.key, unit]));
        const directRoots = Array.from(chatContainer.children);
        const keyedRootList = keyedRoots();
        const rootByKey = new Map();
        let offRangeRoots = 0;
        for (const root of keyedRootList) {
            const key = root?.dataset?.renderUnitKey;
            if (!key) continue;
            if (!acceptedKeys.has(key)) offRangeRoots += 1;
            else if (!rootByKey.has(key)) rootByKey.set(key, root);
        }

        const units = [];
        let attributedDescendants = 0;
        let attributedDirectChildren = 0;
        for (const item of acceptedItems) {
            const root = rootByKey.get(item.key);
            const unit = unitByKey.get(item.key);
            if (!root || !unit || !Number.isFinite(item.index)) continue;
            const rootDescendants = boundedChatPressureCount(root.querySelectorAll('*').length);
            const rootDirectChildren = boundedChatPressureCount(root.childElementCount);
            const kind = normalizeChatPressureKind(unit.kind);
            const role = normalizeChatPressureRole(unit.value?.message?.role);
            attributedDescendants = boundedChatPressureCount(attributedDescendants + rootDescendants);
            attributedDirectChildren = boundedChatPressureCount(attributedDirectChildren + rootDirectChildren);
            units.push({
                unitIndex: boundedChatPressureCount(item.index),
                kind,
                role,
                descendants: rootDescendants,
                directChildren: rootDirectChildren,
                pinned: pinnedKeys.has(item.key)
            });
        }

        const lifecycle = typeof chatWindowPressureLifecycle !== 'undefined'
            && chatWindowPressureLifecycle.current?.generation === boundedChatPressureCount(chatWindowGeneration)
            ? chatWindowPressureLifecycle.current
            : null;
        const model = buildAttribution({
            generation: boundedChatPressureCount(chatWindowGeneration),
            auditAvailable: true,
            coverageAvailable: units.length === acceptedItems.length,
            totalDescendants: attributedDescendants,
            cleanup: lifecycle ? {
                available: true,
                generation: boundedChatPressureCount(lifecycle.generation),
                ownedUnmount: lifecycle.unobserveRequested > 0 || lifecycle.removalRequested > 0,
                residualRoots: boundedChatPressureCount(lifecycle.residualRoots),
                staleRejections: boundedChatPressureCount(lifecycle.staleRangeRejections + lifecycle.staleMeasurementRejections)
            } : undefined,
            units: units.map((unit) => ({
                unitIndex: unit.unitIndex,
                kind: unit.kind,
                role: unit.role,
                descendants: unit.descendants,
                directChildren: unit.directChildren,
                mounted: true,
                pinned: unit.pinned
            }))
        });
        const topContributors = Array.isArray(model?.topContributors)
            ? model.topContributors.slice(0, 8).map((unit) => ({
                unitIndex: boundedChatPressureCount(unit.unitIndex),
                kind: normalizeChatPressureKind(unit.kind),
                role: normalizeChatPressureRole(unit.role),
                descendants: boundedChatPressureCount(unit.descendants),
                directChildren: boundedChatPressureCount(unit.directChildren)
            }))
            : [];
        chatRenderMetrics.pressureAttribution = {
            generation: boundedChatPressureCount(model?.generation),
            units: units.map((unit) => ({
                unitIndex: unit.unitIndex,
                kind: unit.kind,
                role: unit.role,
                descendants: unit.descendants,
                directChildren: unit.directChildren
            })),
            totals: {
                descendants: boundedChatPressureCount(descendants),
                attributedDescendants,
                directChildren: boundedChatPressureCount(directChildren),
                attributedDirectChildren,
                structuralChildren: boundedChatPressureCount(directRoots.filter((root) => root?.dataset?.chatStructuralKey).length),
                mountedRoots: boundedChatPressureCount(units.length),
                offRangeRoots: boundedChatPressureCount(offRangeRoots)
            },
            range: {
                requested: { available: Array.isArray(visibleUnits), value: Array.isArray(visibleUnits) ? boundedChatPressureCount(visibleUnits.length) : null },
                accepted: { available: Array.isArray(snapshot?.items), value: Array.isArray(snapshot?.items) ? boundedChatPressureCount(snapshot.items.length) : null },
                core: { available: false, value: null },
                overscan: { available: false, value: null },
                pins: { available: Array.isArray(pins), value: Array.isArray(pins) ? boundedChatPressureCount(pins.length) : null }
            },
            topContributors
        };
        if (lifecycle) {
            chatRenderMetrics.pressureAttribution.cleanup = {
                available: model?.cleanup?.available === true,
                generationMatches: model?.cleanup?.generationMatches === true,
                ownedUnmount: model?.cleanup?.ownedUnmount === true,
                residualRoots: boundedChatPressureCount(model?.cleanup?.residualRoots),
                staleRejections: boundedChatPressureCount(model?.cleanup?.staleRejections)
            };
            chatRenderMetrics.pressureAttribution.classification = {
                value: ['cumulative-ordinary', 'exceptional-unit', 'suspected-cleanup-drift', 'mixed'].includes(model?.classification?.value)
                    ? model.classification.value
                    : 'unknown',
                residualRootsPresent: boundedChatPressureCount(model?.cleanup?.residualRoots) > 0
            };
        }
        chatRenderMetricsDirty = true;
    }

    function applyWindowedKeyedChatReconciliation(session, units, explicitShellRequests = [], transactionControl = null) {
        const cf3RunPhase = typeof runCF3RangeDiagnosticPhase === 'function'
            ? runCF3RangeDiagnosticPhase : (_phase, operation) => operation();
        const reconcileSessionId = activeSessionId || '__no_session__';
        const existingAdapter = chatWindowState.adapter;
        if (existingAdapter && chatWindowState.sessionId !== reconcileSessionId) {
            return CHAT_WINDOW_CANDIDATE_STALE_RESULT;
        }
        if (existingAdapter && typeof existingAdapter.beginTransaction !== 'function') {
            return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;
        }
        const syntheticEvidenceRequest = existingAdapter && typeof consumeChatWindowSyntheticEvidenceRequest === 'function'
            ? consumeChatWindowSyntheticEvidenceRequest(transactionControl?.syntheticEvidenceToken)
            : null;
        const syntheticEvidenceDirection = transactionControl?.syntheticEvidenceDirection === 'backward' ? 'backward' : 'forward';
        const rangePolicy = syntheticEvidenceRequest ? Object.freeze({
            overscanTier: syntheticEvidenceRequest.overscanTier,
            beforeReserve: syntheticEvidenceDirection === 'backward'
                ? syntheticEvidenceRequest.forwardReserve : syntheticEvidenceRequest.backwardReserve,
            afterReserve: syntheticEvidenceDirection === 'backward'
                ? syntheticEvidenceRequest.backwardReserve : syntheticEvidenceRequest.forwardReserve,
            initialTail: syntheticEvidenceRequest.initialTail
        }) : typeof resolveChatWindowAdaptiveRangePolicy === 'function'
            ? resolveChatWindowAdaptiveRangePolicy() : undefined;
        let stagedAttempt = transactionControl?.stagedAttempt || null;
        if (!existingAdapter && !stagedAttempt) {
            const prepared = ensureChatWindowAdapter(session, units, explicitShellRequests, transactionControl);
            if (prepared === CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT || prepared === CHAT_WINDOW_CANDIDATE_STALE_RESULT) {
                return prepared;
            }
            stagedAttempt = prepared;
            transactionControl = {
                ...(transactionControl || {}),
                stagedAttempt,
                acceptedPlanOverride: stagedAttempt.acceptedPlan,
                skipCorrection: true
            };
        }
        if (stagedAttempt) {
            if (consumedChatWindowStagedAttempts.has(stagedAttempt)
                || chatWindowState.adapter !== stagedAttempt.candidateAdapter
                || stagedAttempt.adapterTransaction == null) return CHAT_WINDOW_CANDIDATE_STALE_RESULT;
            consumedChatWindowStagedAttempts.add(stagedAttempt);
        }
        const transactionOwnerSessionId = activeSessionId || '__no_session__';
        const transactionOwnerGeneration = chatWindowGeneration;
        const transactionOwnerAdapter = chatWindowState.adapter;
        let journal = null;
        let transactionUnavailable = false;
        let reconcileSucceeded = false;
        let adapterTransaction = null;
        let applied = null;
        let rawSnapshotToAcknowledge = null;
        const acknowledgeRawSnapshot = () => {
            if (!rawSnapshotToAcknowledge) return;
            chatWindowState.acknowledgedRawSnapshot = Object.freeze({
                items: Object.freeze(rawSnapshotToAcknowledge.items.map((item) => Object.freeze({
                    key: item.key,
                    index: item.index,
                    start: item.start,
                    end: item.end,
                    size: item.size
                }))),
                totalSize: rawSnapshotToAcknowledge.totalSize
            });
        };
        try {
            const localWindow = stagedAttempt?.localWindow || (() => {
                const localWindow = resolveChatLocalHistoryWindow(units);
                return localWindow;
            })();
            // Established immediate transactions intentionally bypass
            // ensureChatWindowAdapter(session, localWindow.visibleUnits) to avoid a redundant active-owner publication.
            const adapter = stagedAttempt?.candidateAdapter || chatWindowState.adapter;
            if (adapter === CHAT_WINDOW_CANDIDATE_STALE_RESULT) return adapter;
            if (!adapter || (!stagedAttempt && typeof adapter.beginTransaction !== 'function')) {
                transactionUnavailable = true;
                return CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT;
            }
            const acceptedState = stagedAttempt
                ? unpublishedChatWindowCandidateAcceptedStates.get(adapter)
                    || (typeof captureChatWindowAcceptedState === 'function' ? captureChatWindowAcceptedState() : null)
                : typeof captureChatWindowAcceptedState === 'function' ? captureChatWindowAcceptedState() : null;
            journal = typeof beginChatPresentationJournal === 'function'
                ? beginChatPresentationJournal(acceptedState, reconcileSessionId)
                : null;
            captureChatWindowAnchor();
            chatWindowState.rendering = true;
            chatWindowState.pendingRangeRender = false;
            chatWindowState.allUnits = units;
            if (stagedAttempt) chatWindowState.localHistoryPresentation = localWindow.presentation;
            reserveChatWindowStructuralRoots(localWindow.presentation);
            const renderingFacade = globalThis.window?.__ocRendering;
            const adapterUpdate = stagedAttempt?.adapterUpdate || {
                keys: localWindow.visibleUnits.map((unit) => unit.key),
                kinds: localWindow.visibleUnits.map(getChatWindowUnitKind),
                presentationRevisions: localWindow.visibleUnits.map((unit) => renderingFacade.presentationFingerprint(getKeyedUnitPresentation(session, unit))),
                keepMountedKeys: getChatWindowKeepMountedKeys(session, localWindow.visibleUnits),
                ...(rangePolicy ? { rangePolicy } : {})
            };
            adapterTransaction = stagedAttempt?.adapterTransaction || adapter.beginTransaction(adapterUpdate);
            journal.adapterTransaction = adapterTransaction;
            if (!adapterTransaction || !adapterTransaction.prepareCommit()) throw new Error('Chat window adapter transaction prepare failed');
            runChatPresentationFailureSeam('adapter-prepared', adapterTransaction);
            const snapshot = adapterTransaction.getRange();
            rawSnapshotToAcknowledge = snapshot;
            chatWindowState.snapshot = snapshot;
            const unitByKey = new Map(localWindow.visibleUnits.map((unit) => [unit.key, unit]));
            const planContainment = stagedAttempt ? null : renderingFacade?.planChatWindowContainment;
            const containmentRequest = !stagedAttempt && typeof planContainment === 'function'
                ? buildChatWindowContainmentRequest(session, localWindow.visibleUnits, snapshot, explicitShellRequests)
                : null;
            const planned = stagedAttempt?.acceptedPlan || (typeof planContainment === 'function'
                ? planContainment(buildChatWindowContainmentRequest(
                    session, localWindow.visibleUnits, snapshot, explicitShellRequests
                ))
                : typeof window === 'undefined'
                    ? {
                        allowed: true,
                        acceptedKeys: snapshot.items.map((item) => item.key),
                        mountedCount: snapshot.items.length,
                        directChildCount: snapshot.items.length,
                        shellSelections: {},
                        syntheticNonBrowser: true
                    }
                    : null);
            const acceptedPlan = transactionControl?.acceptedPlanOverride || planned;
            if (!acceptedPlan?.allowed) {
                abortChatPresentationJournal(journal);
                return [];
            }
            if (!acceptedPlan.syntheticNonBrowser && (acceptedPlan.mountedCount > CHAT_WINDOW_MOUNT_LIMIT
                || acceptedPlan.directChildCount > CHAT_WINDOW_DIRECT_CHILD_LIMIT)) {
                abortChatPresentationJournal(journal);
                return [];
            }
            if ((activeSessionId || '__no_session__') !== transactionOwnerSessionId
                || chatWindowGeneration !== transactionOwnerGeneration
                || chatWindowState.adapter !== transactionOwnerAdapter) {
                abortChatPresentationJournal(journal);
                return CHAT_WINDOW_CANDIDATE_STALE_RESULT;
            }
            const planRevision = containmentRequest ? ++chatWindowAcceptedPlanRevision : 0;
            const applyAcceptedPlan = (acceptedPlan) => {
                const acceptedUnits = acceptedPlan.acceptedKeys.map((key) => unitByKey.get(key)).filter(Boolean);
                const acceptedKeySet = new Set(acceptedPlan.acceptedKeys);
                const acceptedSnapshot = {
                    ...snapshot,
                    items: snapshot.items.filter((item) => acceptedKeySet.has(item.key))
                };
                for (const unit of acceptedUnits) {
                    const presentationSelection = acceptedPlan.shellSelections[unit.key];
                    if (!presentationSelection) continue;
                    adapterTransaction.setPresentationRevision(unit.key, renderingFacade.presentationFingerprint(getKeyedPresentationIdentity(
                        getKeyedUnitPresentation(session, unit),
                        presentationSelection
                    )));
                }
                applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);
                updateChatWindowSpacers(acceptedSnapshot);
                runChatPresentationFailureSeam('spacer-applied', acceptedSnapshot);
                renderChatLocalOlderSurface(localWindow.presentation, localWindow.suppressSurfaceContent === true);
                runChatPresentationFailureSeam('local-surface-applied', localWindow.presentation);
                const nextMounted = new Set(acceptedUnits.map((unit) => unit.key));
                for (const key of chatWindowState.mountedKeys) if (!nextMounted.has(key)) {
                    adapterTransaction.unobserveElement(key);
                }
                for (const unit of acceptedUnits) {
                    const root = keyedRootForKey(unit.key);
                    if (root) adapterTransaction.observeElement(unit.key, root);
                }
                chatWindowState.mountedKeys = nextMounted;
                const directChildren = chatContainer.childElementCount;
                const descendants = chatContainer.querySelectorAll('*').length;
                const keepMountedKeys = getChatWindowKeepMountedKeys(session, localWindow.visibleUnits);
                const structuralIntegrityRoots = getChatStructuralIntegrityRoots();
                sampleChatRenderDom(chatContainer, { directChildren, descendants, structuralIntegrityRoots });
                recordChatWindowPressureAttribution(localWindow.visibleUnits, acceptedUnits, acceptedSnapshot, keepMountedKeys, directChildren, descendants);
                const budget = assertChatWindowDomBudget({ mountedUnits: keyedRoots().length, directChildren, descendants });
                const adaptiveObservations = typeof createChatWindowAdaptiveObservations === 'function'
                    ? createChatWindowAdaptiveObservations(
                        acceptedSnapshot, budget, localWindow.visibleUnits.length, acceptedPlan, session
                    ) : null;
                return { acceptedUnits, budget, adaptiveObservations };
            };
            applied = applyAcceptedPlan(acceptedPlan);
            const correctedPlan = containmentRequest && transactionControl?.skipCorrection !== true ? scheduleChatWindowPlanCorrection({
                sessionId: reconcileSessionId,
                generation: chatWindowGeneration,
                planRevision,
                request: containmentRequest,
                acceptedPlan,
                observedBudget: applied.budget
            }) : null;
            window.__ocChatWindowLastBudget = Object.freeze(applied.budget);
            if (!adapterTransaction.commit()) throw new Error('Chat window adapter transaction commit failed');
            runChatPresentationFailureSeam('adapter-sealed-pre-finalize', adapterTransaction);
            if (!cf3RunPhase('transaction-finalize', () => adapterTransaction.finalizeCommit())) throw new Error('Chat window adapter transaction finalize failed');
            if (adapterTransaction.hasPendingCompletion?.()) adapterTransaction.retryCompletion?.();
            journal.adapterTransaction = null;
            if (!finalizeChatPresentationJournal(journal)) throw new Error('Chat presentation journal finalize failed');
            acknowledgeRawSnapshot();
            if (applied?.adaptiveObservations && typeof observeChatWindowAdaptiveShadow === 'function') {
                observeChatWindowAdaptiveShadow(applied.adaptiveObservations, {
                    kind: 'external', decisionGeneration: typeof chatWindowAdaptiveShadow !== 'undefined'
                        ? chatWindowAdaptiveShadow?.state?.decisionGeneration : 0
                });
            }
            if (stagedAttempt) unpublishedChatWindowCandidateAcceptedStates.delete(adapter);
            chatWindowState.rendering = false;
            if (chatWindowState.pendingScrollKey) tryPendingChatWindowScroll('after-transaction-finalize');
            if (autoScrollPinnedToBottom) scrollToBottom(true);
            else restoreChatWindowAnchor();
            reconcileSucceeded = true;
            if (transactionControl && correctedPlan) transactionControl.correctedPlan = correctedPlan;
            return applied.acceptedUnits;
        } catch (error) {
            if (adapterTransaction?.isFinalized?.()) {
                journal.adapterTransaction = null;
                adapterTransaction.retryCompletion?.();
                finalizeChatPresentationJournal(journal);
                acknowledgeRawSnapshot();
                if (applied?.adaptiveObservations && typeof observeChatWindowAdaptiveShadow === 'function') {
                    observeChatWindowAdaptiveShadow(applied.adaptiveObservations, {
                        kind: 'external', decisionGeneration: typeof chatWindowAdaptiveShadow !== 'undefined'
                            ? chatWindowAdaptiveShadow?.state?.decisionGeneration : 0
                    });
                }
                chatWindowState.rendering = false;
                window.__ocChatWindowRecovery = Object.freeze({ status: 'committed-degraded', generation: chatWindowGeneration });
                reconcileSucceeded = true;
                return applied?.acceptedUnits || [];
            }
            if (journal) abortChatPresentationJournal(journal);
            throw error;
        } finally {
            if (!journal && !transactionUnavailable) {
                chatWindowState.rendering = false;
                chatLocalHistoryController.complete(reconcileSessionId); // chatLocalHistoryController.complete(reconcileSessionId);
            }
            if (reconcileSucceeded && chatWindowState.pendingRangeRender && chatWindowState.pendingScrollKey
                && chatWindowState.pendingScrollAttempts < CHAT_PENDING_SCROLL_MAX_ATTEMPTS) {
                chatWindowState.pendingRangeRender = false;
                scheduleRenderFromState('window-search-range-retry');
            }
        }
    }

    function applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, acceptedPlan) {
        return applyWindowedKeyedChatReconciliation(session, acceptedUnits, shellRequests, {
            acceptedPlanOverride: acceptedPlan,
            skipCorrection: true
        });
    }

    window.__oc = window.__oc || {};
    function getLoadedChatSearchRows(query = '') {
        const session = getSessionOrNull(activeSessionId);
        const queryText = String(query || '').trim();
        if (queryText && chatWindowState.allUnits.length === 0) return null;
        return chatWindowState.allUnits.map((unit) => {
            const message = unit.value?.message;
            const matcher = queryText ? createLinearSearchMatcher(queryText) : null;
            const text = collectBoundedSmartSearchText((visit) => {
                visitLoadedChatSearchChunks(session, unit, (chunk) => {
                    const collecting = visit(chunk) !== false;
                    matcher?.visit(chunk);
                    return matcher ? (collecting || !matcher.matched()) : collecting;
                });
            });
            return text && (!matcher || matcher.matched())
                ? { id: unit.key, role: message?.role || 'system', text }
                : null;
        }).filter(Boolean);
    }
    window.__oc.getLoadedChatSearchRows = getLoadedChatSearchRows;
    function mountChatWindowSearchKey(targetKey, reason = 'search') {
        if (!isChatWindowAvailable() || !chatWindowState.adapter) return false;
        const sessionId = activeSessionId || '__no_session__';
        const keys = chatWindowState.allUnits.map((unit) => unit.key);
        if (!chatLocalHistoryController.revealToKey(sessionId, keys, targetKey)) return false;
        sessionSearch.setWindowTargetKey(targetKey);
        autoScrollPinnedToBottom = false;
        chatWindowState.activityBelow = true;
        if (chatWindowState.pendingScrollKey !== targetKey) {
            chatWindowState.pendingScrollKey = targetKey;
            chatWindowState.pendingScrollAttempts = 0;
        }
        tryPendingChatWindowScroll('search-action');
        scheduleRenderFromState(`window-${reason}`);
        return true;
    }
    window.__oc.ensureChatWindowKeyMounted = mountChatWindowSearchKey;

    function applyKeyedChatReconciliation(session, units, presentationSelections = null, externalJournal = null) {
        const rendering = window.__ocRendering;
        const journal = externalJournal || beginChatPresentationJournal();
        const ownsJournal = !externalJournal;
        keyedChatReconcileFailure = null;
        try {
            const nextItems = units.map((unit) => {
                const presentation = getKeyedUnitPresentation(session, unit);
                const presentationSelection = presentationSelections?.[unit.key];
                return {
                    key: unit.key,
                    fingerprint: rendering.presentationFingerprint(getKeyedPresentationIdentity(presentation, presentationSelection)),
                    streamStableFingerprint: rendering.presentationFingerprint(getKeyedPresentationIdentity(
                        getKeyedStreamStablePresentation(presentation),
                        presentationSelection
                    )),
                    presentationSelection
                };
            });
            const steps = rendering.planReconciliation(keyedChatReconcileState.items, nextItems);
            const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
            const renderedSet = new Set();
            const counts = { create: 0, replace: 0, remove: 0, move: 0, reuse: 0, enhance: 0 };
            const preparedRoots = new Map();
            for (const step of steps.filter((entry) => entry.type === 'create' || entry.type === 'replace')) {
                const unit = unitByKey.get(step.key);
                if (!unit) throw new Error(`Missing render unit for ${step.key}`);
                keyedChatReconcileFailure = { key: step.key, operation: step.type };
                const root = renderDetachedKeyedUnit(session, unit, renderedSet, presentationSelections?.[unit.key]);
                preparedRoots.set(step.key, root);
                journal.preparedRoots.add(root);
                runChatPresentationFailureSeam('factory-prepared', { key: step.key, root });
            }

            for (const step of steps.filter((entry) => entry.type === 'remove')) {
                keyedChatReconcileFailure = { key: step.key, operation: 'remove' };
                const root = keyedRootForKey(step.key) || keyedChatReconcileState.roots.get(step.key);
                if (root?.parentElement === chatContainer) root.remove();
                if (root) journal.supersededRoots.add(root);
                keyedChatReconcileState.roots.delete(step.key);
                journal.cleanupRemovals.push(root);
                counts.remove += 1;
                runChatPresentationFailureSeam('remove-applied', { key: step.key, root });
            }
            for (const step of steps.filter((entry) => entry.type === 'create' || entry.type === 'replace')) {
                keyedChatReconcileFailure = { key: step.key, operation: step.type };
                const root = preparedRoots.get(step.key);
                const existing = keyedRootForKey(step.key);
                if (existing) {
                    // existing._safeShellDispose?.(); is deferred to the accepted finalization barrier.
                    journal.supersededRoots.add(existing);
                    existing.replaceWith(root);
                }
                else chatContainer.appendChild(root);
                keyedChatReconcileState.roots.set(step.key, root);
                counts[step.type] += 1;
                counts.enhance += 1;
                runChatPresentationFailureSeam('replace-applied', { key: step.key, root, existing });
            }
            for (let index = 0; index < units.length; index += 1) {
                keyedChatReconcileFailure = { key: units[index].key, operation: 'move' };
                const root = keyedRootForKey(units[index].key) || keyedChatReconcileState.roots.get(units[index].key);
                if (!root) throw new Error(`Missing keyed root after reconcile: ${units[index].key}`);
                const currentAtIndex = keyedRoots()[index] || null;
                if (currentAtIndex !== root) {
                    chatContainer.insertBefore(root, currentAtIndex);
                    counts.move += 1;
                    runChatPresentationFailureSeam('move-applied', { key: units[index].key, root, index });
                }
                keyedChatReconcileState.roots.set(units[index].key, root);
            }
            keyedChatReconcileFailure = null;
            counts.reuse = steps.filter((entry) => entry.type === 'reuse').length;
            keyedChatReconcileState = { sessionId: activeSessionId || '', items: nextItems, roots: keyedChatReconcileState.roots };
            window.__ocKeyedChatLastReconcile = Object.freeze({ ...counts, unitCount: units.length });
            if (ownsJournal) finalizeChatPresentationJournal(journal);
            return counts;
        } catch (error) {
            const attemptedFailure = keyedChatReconcileFailure;
            if (ownsJournal) abortChatPresentationJournal(journal);
            if (error && (typeof error === 'object' || typeof error === 'function')) {
                try {
                    Object.defineProperty(error, '__ocChatReconcileFailure', {
                        value: attemptedFailure, configurable: true
                    });
                } catch { /* exact attempted ownership remains best-effort on exotic throwables */ }
            }
            throw error;
        }
    }

    function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId) {
        if (!KEYED_CHAT_RECONCILE_ENABLED || keyedChatReconcileState.sessionId !== sessionId) return true;
        const oldRoot = keyedRootForKey(oldKey);
        const newRoot = keyedRootForKey(newKey);
        if (oldRoot && newRoot && oldRoot !== newRoot) {
            keyedChatReconcileState = { sessionId: '', items: [], roots: new Map() };
            keyedChatFailedSessionId = sessionId || activeSessionId || '';
            return false;
        }
        const root = oldRoot || newRoot;
        if (root) {
            root.dataset.renderUnitKey = newKey;
            const messageRoot = root.matches?.('[data-message-id]') ? root : root.querySelector?.('[data-message-id]');
            if (messageRoot?.dataset?.messageId === oldKey) messageRoot.dataset.messageId = newKey;
        }
        const cached = keyedChatReconcileState.roots.get(oldKey);
        keyedChatReconcileState.roots.delete(oldKey);
        if (cached || root) keyedChatReconcileState.roots.set(newKey, cached || root);
        keyedChatReconcileState.items = keyedChatReconcileState.items.map((item) => {
            if (item.key !== oldKey) return item;
            return { ...item, key: newKey };
        });
        chatWindowState.adapter?.migrateKey?.(oldKey, newKey);
        if (chatWindowState.anchorKey === oldKey) chatWindowState.anchorKey = newKey;
        sessionSearch.rekey(oldKey, newKey);
        return true;
    }

    rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) => {
        return applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId);
    };

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
            } else {
                flushPendingStatusOnlyCoalescedAfterRender();
            }
        });
    }

    function forceQuestionOverlayRender(reason = 'question-overlay-force') {
        requestAnimationFrame(() => {
            scheduleRenderFromState(reason);
        });
    }

    function applyChatWindowOrWave2(session, units, transactionMode = 'normal') {
        const publishRecovery = (status, reason, retryAttempted, retryPending) => {
            const recovery = Object.freeze({
                status,
                reason,
                retryAttempted,
                retryPending,
                boundedRootCount: Math.min(CHAT_WINDOW_MOUNT_LIMIT, keyedRoots().length)
            });
            window.__ocChatWindowRecovery = recovery;
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][CHAT_WINDOW_BOUNDED_RECOVERY]', `status=${status}`, `reason=${reason}`,
                    `retryAttempted=${retryAttempted}`, `retryPending=${retryPending}`,
                    `boundedRootCount=${recovery.boundedRootCount}`]
            });
        };
        const acceptedSafeShellFamilies = new Set([
            'message-user', 'message-assistant', 'message-tool-meta', 'message-subagent',
            'change-list', 'segment', 'conflict', 'message-image', 'message-code',
            'message-diff', 'message-table', 'message-markdown'
        ]);
        const truthfulSafeShellFamily = (unit) => {
            if (!unit) return '';
            const candidates = [];
            if (unit.kind === 'segment' && unit.value?.segment) candidates.push('segment');
            if (unit.kind === 'conflict' && Array.isArray(unit.value?.conflicts) && unit.value.conflicts.length) candidates.push('conflict');
            const message = unit.value?.message;
            if (!message) return candidates.length === 1 ? candidates[0] : '';
            if (unit.kind === 'change-list') {
                if (message.meta?.kind === 'changeList' && Array.isArray(message.meta?.files) && message.meta.files.length) candidates.push('change-list');
                return candidates.length === 1 ? candidates[0] : '';
            }
            if (message.meta?.kind === 'undoSegmentPlaceholder' || message.id?.startsWith?.('system:undo-seg:')) candidates.push('segment');
            if (Array.isArray(message.meta?.images) && message.meta.images.length) candidates.push('message-image');
            if (message.meta?.isDiff === true) candidates.push('message-diff');
            if (Array.isArray(message.meta?.subagents) && message.meta.subagents.length) candidates.push('message-subagent');
            if (message.role === 'user') candidates.push('message-user');
            const hasMetaKind = typeof message.meta?.kind === 'string' && message.meta.kind.trim().length > 0;
            if ((message.role === 'tool' || message.role === 'system' || message.role === 'assistant' && hasMetaKind)
                && !(Array.isArray(message.meta?.todos) && message.meta.todos.length)) candidates.push('message-tool-meta');
            if (message.role === 'assistant' && message.meta?.isThinking !== true && !hasMetaKind
                && !(Array.isArray(message.meta?.todos) && message.meta.todos.length)
                && candidates.length === 0) {
                const text = typeof message.text === 'string' ? message.text : '';
                const shaped = [];
                if (/(^|\n)\s{0,3}(```|~~~)/.test(text)) shaped.push('message-code');
                if (/\|[^\n]*\|\s*\n\s*\|?\s*:?-{3,}/.test(text)) shaped.push('message-table');
                if (/(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|>\s)|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*/.test(text)) shaped.push('message-markdown');
                if (shaped.length === 0) shaped.push('message-assistant');
                candidates.push(...shaped);
            }
            return candidates.length === 1 && acceptedSafeShellFamilies.has(candidates[0]) ? candidates[0] : '';
        };
        const consumeWindowUnavailableResult = (result) => {
            if (result !== CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT && result !== CHAT_WINDOW_CANDIDATE_STALE_RESULT) return '';
            const retained = keyedRoots().length > 0;
            const reason = result === CHAT_WINDOW_CANDIDATE_STALE_RESULT ? 'candidate-owner-stale' : 'missing-begin-transaction';
            publishRecovery(retained ? 'retained' : 'empty', reason, false, true);
            return retained ? 'window-unavailable-retained' : 'window-unavailable-bootstrap-pending';
        };
        const planAcceptedOuterTransactionalBootstrap = (safeViewer) => {
            const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);
            const requestedKeys = boundedUnits.map((unit) => unit.key);
            const shellRequests = safeViewer
                ? boundedUnits.map((unit) => {
                    const family = truthfulSafeShellFamily(unit);
                    return family ? { key: unit.key, mode: 'safe-shell', family } : null;
                }).filter(Boolean)
                : [];
            const planContainment = window.__ocRendering?.planChatWindowContainment;
            if (typeof planContainment !== 'function') return false;
            const plan = planContainment({
                requestedKeys,
                visibleLoadedKeys: requestedKeys,
                viewportKeys: requestedKeys,
                coreKeys: [],
                overscanKeys: [],
                adapterSnapshotKeys: requestedKeys,
                currentTurnAssistantKey: session?.currentTurnAssistantKey,
                thinkingId: session?.thinkingId,
                lastTurnUserId: session?.lastTurnUserId,
                appendRootUserKey: session?.appendRootUserKey,
                anchorKey: chatWindowState.anchorKey,
                searchTargetKey: sessionSearch.windowTargetKey,
                projectedStructuralRoots: projectChatWindowStructuralRoots(),
                limits: { mounted: CHAT_WINDOW_MOUNT_LIMIT, directChildren: CHAT_WINDOW_DIRECT_CHILD_LIMIT },
                shellRequests
            });
            if (!plan?.allowed || !Array.isArray(plan.acceptedKeys)) return false;
            const unitByKey = new Map(boundedUnits.map((unit) => [unit.key, unit]));
            const acceptedUnits = plan.acceptedKeys.map((key) => unitByKey.get(key)).filter(Boolean);
            if (safeViewer && acceptedUnits.some((unit) => !plan.shellSelections?.[unit.key])) return false;
            return applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, plan);
        };

        const applyTransactionalWindow = (shellRequests = [], transactionUnits = units) => {
            const control = {};
            const acceptedUnits = applyWindowedKeyedChatReconciliation(session, transactionUnits, shellRequests, control);
            if (acceptedUnits === CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT || acceptedUnits === CHAT_WINDOW_CANDIDATE_STALE_RESULT) return acceptedUnits;
            if (!control.correctedPlan) return { acceptedUnits, corrected: false, correctionFailed: false };
            try {
                const correctedUnits = applyWindowedKeyedChatReconciliation(session, transactionUnits, shellRequests, {
                    acceptedPlanOverride: control.correctedPlan,
                    skipCorrection: true
                });
                if (correctedUnits === CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT || correctedUnits === CHAT_WINDOW_CANDIDATE_STALE_RESULT) return correctedUnits;
                return { acceptedUnits: correctedUnits, corrected: true, correctionFailed: false };
            } catch {
                return { acceptedUnits, corrected: false, correctionFailed: true };
            }
        };

        const applyVirtualizedRollbackBaseline = () => {
            const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);
            if (boundedUnits.length === 0) return false;
            try {
                const result = applyTransactionalWindow([], boundedUnits);
                if (result === CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT || result === CHAT_WINDOW_CANDIDATE_STALE_RESULT) return result;
                return !result.correctionFailed;
            } catch {
                return false;
            }
        };

        const containmentPolicyEnabled = typeof CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED === 'undefined'
            || CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED !== false;
        if (!containmentPolicyEnabled) {
            const result = applyVirtualizedRollbackBaseline();
            const unavailableRoute = consumeWindowUnavailableResult(result);
            if (unavailableRoute) return unavailableRoute;
            if (result) return 'containment-policy-disabled-virtualized';
            publishRecovery('retained', 'containment-policy-disabled-pending', false, true);
            return 'containment-policy-disabled-virtualized-pending';
        }
        if (!TANSTACK_CHAT_WINDOW_ENABLED) {
            const result = applyVirtualizedRollbackBaseline();
            const unavailableRoute = consumeWindowUnavailableResult(result);
            if (unavailableRoute) return unavailableRoute;
            if (result) return 'outer-virtualized-baseline';
            publishRecovery('retained', 'baseline-unavailable', false, true);
            return 'outer-virtualized-baseline-pending';
        }
        if (!isChatWindowAvailable()) {
            if (keyedRoots().length > 0) {
                publishRecovery('retained', 'adapter-unavailable', false, true);
                return 'window-unavailable-retained';
            }
            try {
                const result = planAcceptedOuterTransactionalBootstrap(true);
                const unavailableRoute = consumeWindowUnavailableResult(result);
                if (unavailableRoute) return unavailableRoute;
                if (Array.isArray(result)) return 'window-unavailable-bootstrap';
            } catch {
                publishRecovery('empty', 'bootstrap-transaction-failed', false, true);
                return 'window-unavailable-bootstrap-pending';
            }
            publishRecovery('empty', 'bootstrap-unavailable', false, true);
            return 'window-unavailable-bootstrap-pending';
        }
        if (transactionMode === 'corruption-emergency') {
            const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);
            const shellRequests = boundedUnits.map((unit) => {
                const family = truthfulSafeShellFamily(unit);
                return family ? { key: unit.key, mode: 'safe-shell', family } : null;
            }).filter(Boolean);
            if (boundedUnits.length === 0 || shellRequests.length !== boundedUnits.length) {
                publishRecovery('retained', 'emergency-shell-denied', false, true);
                return 'window-corruption-emergency-pending';
            }
            try {
                const result = applyTransactionalWindow(shellRequests, boundedUnits);
                const unavailableRoute = consumeWindowUnavailableResult(result);
                if (unavailableRoute) return unavailableRoute;
                if (result.correctionFailed) {
                    publishRecovery('retained', 'emergency-correction-failed', false, true);
                    return 'window-corruption-emergency-pending';
                }
                publishRecovery('emergency', 'classified-corruption', false, false);
                return 'window-corruption-emergency';
            } catch {
                publishRecovery('retained', 'emergency-transaction-failed', false, true);
                return 'window-corruption-emergency-pending';
            }
        }
        try {
            const result = applyTransactionalWindow();
            const unavailableRoute = consumeWindowUnavailableResult(result);
            if (unavailableRoute) return unavailableRoute;
            if (result.correctionFailed) {
                publishRecovery('retained', 'correction-failed', false, true);
                return 'window-correction-retained';
            }
            window.__ocChatWindowRecovery = Object.freeze({
                status: 'healthy', reason: 'none', retryAttempted: false, retryPending: false,
                boundedRootCount: Math.min(CHAT_WINDOW_MOUNT_LIMIT, keyedRoots().length)
            });
            return 'window';
        } catch (windowError) {
            const recoveryEnabled = typeof CHAT_WINDOW_RECOVERY_ENABLED === 'undefined'
                || CHAT_WINDOW_RECOVERY_ENABLED !== false;
            if (!recoveryEnabled) {
                publishRecovery('retained', 'recovery-disabled', false, true);
                return 'window-recovery-disabled-retained';
            }
            const failure = windowError?.__ocChatReconcileFailure || null;
            const failedUnit = failure?.key ? units.find((unit) => unit.key === failure.key) : null;
            const family = truthfulSafeShellFamily(failedUnit);
            if (failedUnit && family && (failure.operation === 'create' || failure.operation === 'replace' || failure.operation === 'presentation')) {
                const shellRequest = { key: failedUnit.key, mode: 'safe-shell', family };
                try {
                    const retryResult = applyTransactionalWindow([shellRequest]);
                    const unavailableRoute = consumeWindowUnavailableResult(retryResult);
                    if (unavailableRoute) return unavailableRoute;
                    if (retryResult.correctionFailed) {
                        publishRecovery('recovered', 'safe-shell-correction-failed', true, true);
                        return 'window-recovered-correction-retained';
                    }
                    publishRecovery('recovered', 'safe-shell', true, false);
                    return 'window-recovered';
                } catch { /* the new retry transaction restores exact C0 */ }
            }
            publishRecovery('retained', family ? 'retry-failed' : 'no-truthful-family', Boolean(family), true);
            return 'window-recovery-pending';
        }
    }

    const CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES = Object.freeze(new Set([
        'containment-policy-disabled-virtualized',
        'outer-virtualized-baseline',
        'window-unavailable-bootstrap',
        'window',
        'window-recovered'
    ]));

    function captureChatWindowRawIntegrityAudit() {
        const roots = keyedRoots();
        const keyCounts = new Map();
        let duplicateKeyCount = 0;
        for (const root of roots) {
            const key = root?.dataset?.renderUnitKey;
            if (!key) duplicateKeyCount += 1;
            else {
                const count = (keyCounts.get(key) || 0) + 1;
                keyCounts.set(key, count);
                if (count > 1) duplicateKeyCount += 1;
            }
        }
        const structuralRoots = getChatStructuralIntegrityRoots();
        const unclassifiedStructuralRootCount = structuralRoots.filter((root) => root.classified !== true).length;
        const directChildCount = Number(chatContainer?.childElementCount || 0);
        const expectedKeys = keyedChatReconcileState.items.map((item) => item.key)
            .filter((key) => typeof key === 'string' && key.length > 0);
        const rootMapKeys = Array.from(keyedChatReconcileState.roots.keys())
            .filter((key) => typeof key === 'string' && key.length > 0);
        const actualKeys = roots.map((root) => root?.dataset?.renderUnitKey)
            .filter((key) => typeof key === 'string' && key.length > 0);
        const expectedSet = new Set(expectedKeys);
        const actualSet = new Set(actualKeys);
        const corruptionSamples = [];
        for (const count of keyCounts.values()) if (count > 1) {
            corruptionSamples.push(Object.freeze({ code: 'duplicate-keyed-root', expected: 1, actual: count }));
        }
        for (const key of expectedSet) if (!actualSet.has(key)) {
            corruptionSamples.push(Object.freeze({ code: 'missing-accepted-keyed-root', expected: true, actual: false }));
        }
        for (const key of actualSet) if (!expectedSet.has(key)) {
            corruptionSamples.push(Object.freeze({ code: 'unexpected-keyed-root', expected: false, actual: true }));
        }
        if (unclassifiedStructuralRootCount > 0) {
            corruptionSamples.push(Object.freeze({
                code: 'unclassified-direct-root', expected: 0, actual: unclassifiedStructuralRootCount
            }));
        }
        const mappedKeyByRoot = new Map();
        for (const [key, root] of keyedChatReconcileState.roots.entries()) {
            if (root && !mappedKeyByRoot.has(root)) mappedKeyByRoot.set(root, key);
        }
        const mappedKeysInDomOrder = roots.map((root, index) => mappedKeyByRoot.get(root) || `__unmapped_root_${index}`);
        for (const key of rootMapKeys) if (!mappedKeysInDomOrder.includes(key)) mappedKeysInDomOrder.push(key);
        const acceptedDomOrderMismatch = expectedKeys.length !== actualKeys.length
            || expectedKeys.some((key, index) => actualKeys[index] !== key);
        const rootBindingMismatch = actualKeys.length !== mappedKeysInDomOrder.length
            || actualKeys.some((key, index) => mappedKeysInDomOrder[index] !== key);
        if (acceptedDomOrderMismatch || rootBindingMismatch) {
            corruptionSamples.push(Object.freeze({
                code: 'root-map-dom-mismatch',
                expected: Object.freeze([...(acceptedDomOrderMismatch ? expectedKeys : actualKeys)]),
                actual: Object.freeze([...(acceptedDomOrderMismatch ? actualKeys : mappedKeysInDomOrder)])
            }));
        }
        if (chatWindowState.adapter) {
            for (const structuralKey of ['window:top-spacer', 'window:bottom-spacer']) {
                const actual = Array.from(chatContainer.children)
                    .filter((root) => root?.dataset?.chatStructuralKey === structuralKey).length;
                if (actual !== 1) corruptionSamples.push(Object.freeze({
                    code: 'active-spacer-missing-or-duplicated', expected: 1, actual
                }));
            }
            const adapterGeneration = Number(chatWindowState.adapterGeneration);
            const adapterSessionMismatch = chatWindowState.sessionId !== (activeSessionId || '__no_session__');
            if (Number.isSafeInteger(adapterGeneration) && adapterGeneration >= 0
                && (adapterSessionMismatch || adapterGeneration !== chatWindowGeneration)) {
                const actualGeneration = adapterGeneration === chatWindowGeneration
                    ? chatWindowGeneration === Number.MAX_SAFE_INTEGER ? chatWindowGeneration - 1 : chatWindowGeneration + 1
                    : adapterGeneration;
                corruptionSamples.push(Object.freeze({
                    code: 'adapter-session-generation-mismatch',
                    expected: chatWindowGeneration, actual: actualGeneration
                }));
            }
        }
        const owner = Object.freeze({ sessionId: activeSessionId || '__no_session__', generation: chatWindowGeneration });
        const audit = Object.freeze({
            sessionId: owner.sessionId,
            generation: owner.generation,
            mountedRootCount: Math.min(1000000000, roots.length),
            directChildCount: Math.min(1000000000, Math.max(0, directChildCount)),
            duplicateKeyCount: Math.min(1000000000, duplicateKeyCount),
            unclassifiedStructuralRootCount: Math.min(1000000000, unclassifiedStructuralRootCount),
            corruptionSamples: Object.freeze(corruptionSamples),
            anomaly: corruptionSamples.length > 0
        });
        if (audit.anomaly) consumeChatWindowIntegrityAudit(owner, audit);
        return audit;
    }

    function createChatWindowEmergencyDiagnostic(owner, codes) {
        const root = document.createElement('div');
        root.className = 'message system error';
        root.dataset.chatStructuralKey = 'window:corruption-emergency';
        root.dataset.chatStructuralOwner = `${owner.sessionId}:${owner.generation}`;
        root.setAttribute('role', 'alert');
        root.setAttribute('aria-live', 'assertive');
        const message = document.createElement('p');
        message.textContent = 'The bounded chat presentation failed an integrity check. A guarded recovery view is active.';
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Operator diagnostics';
        const diagnostics = document.createElement('code');
        diagnostics.textContent = codes.join(', ');
        details.appendChild(summary);
        details.appendChild(diagnostics);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'safe-shell-action';
        retry.dataset.safeShellRole = 'retry-corruption';
        retry.textContent = 'Retry bounded chat rendering';
        retry.setAttribute('aria-label', 'Retry bounded chat rendering');
        retry.addEventListener('click', () => retryChatWindowEmergency(owner, root));
        root.appendChild(message);
        root.appendChild(details);
        root.appendChild(retry);
        return root;
    }

    function retryChatWindowEmergency(owner, root) {
        if (owner.sessionId !== (activeSessionId || '__no_session__') || owner.generation !== chatWindowGeneration
            || chatWindowEmergencyState.status !== 'active'
            || chatWindowEmergencyState.sessionId !== owner.sessionId
            || chatWindowEmergencyState.generation !== owner.generation
            || chatWindowEmergencyState.root !== root
            || !root?.isConnected || root.parentElement !== chatContainer) return false;
        if (typeof resetChatWindowAdaptiveShadow === 'function') resetChatWindowAdaptiveShadow('emergency-retry');
        root.remove();
        chatStructuralRootReservations.delete(root);
        chatWindowEmergencyState = Object.freeze({ status: 'idle', sessionId: '', generation: -1, root: null, codes: [] });
        window.__ocChatWindowEmergency = chatWindowEmergencyState;
        const consumed = Object.freeze({
            status: 'consumed', sessionId: owner.sessionId, generation: owner.generation,
            reason: 'classified-corruption-retry', rawIntegrity: null
        });
        chatWindowOuterRecovery = consumed;
        window.__ocChatWindowOuterRecovery = consumed;
        scheduleRenderFromState('chat-window-corruption-retry');
        return true;
    }

    function enterChatWindowEmergency(owner, rawIntegrity, classifications) {
        if (owner.sessionId !== (activeSessionId || '__no_session__') || owner.generation !== chatWindowGeneration) return false;
        if (typeof resetChatWindowAdaptiveShadow === 'function') resetChatWindowAdaptiveShadow('emergency-entry');
        const codes = classifications.map((classification) => classification.code);
        const root = createChatWindowEmergencyDiagnostic(owner, codes);
        chatStructuralRootReservations.add(root);
        const session = getSessionOrNull(activeSessionId);
        const boundedUnits = chatWindowState.allUnits.slice(-CHAT_WINDOW_INITIAL_TAIL);
        const route = applyChatWindowOrWave2(session, boundedUnits, 'corruption-emergency');
        if (route !== 'window-corruption-emergency'
            || keyedRoots().length > CHAT_WINDOW_MOUNT_LIMIT
            || chatContainer.childElementCount + 1 > CHAT_WINDOW_DIRECT_CHILD_LIMIT) {
            chatStructuralRootReservations.delete(root);
            root.remove?.();
            return false;
        }
        if (chatWindowState.bottomSpacer?.parentElement === chatContainer) {
            chatContainer.insertBefore(root, chatWindowState.bottomSpacer);
        } else chatContainer.insertBefore(root, null);
        chatStructuralRootReservations.delete(root);
        chatWindowEmergencyState = Object.freeze({
            status: 'active', sessionId: owner.sessionId, generation: owner.generation,
            root, codes: Object.freeze([...codes])
        });
        window.__ocChatWindowEmergency = chatWindowEmergencyState;
        const evidence = Object.freeze({
            status: 'emergency', sessionId: owner.sessionId, generation: owner.generation,
            reason: 'classified-corruption', rawIntegrity
        });
        chatWindowOuterRecovery = evidence;
        window.__ocChatWindowOuterRecovery = evidence;
        return true;
    }

    function consumeChatWindowIntegrityAudit(owner, rawIntegrity) {
        if (!owner || owner.sessionId !== (activeSessionId || '__no_session__') || owner.generation !== chatWindowGeneration
            || rawIntegrity?.sessionId !== owner.sessionId || rawIntegrity?.generation !== owner.generation) return false;
        const samples = Array.isArray(rawIntegrity.corruptionSamples) ? rawIntegrity.corruptionSamples : [];
        const classify = window.__ocRendering?.classifyChatWindowIntegrity;
        if (samples.length !== 1 || typeof classify !== 'function') return false;
        let classifications;
        try {
            classifications = samples.map((sample) => classify(sample));
        } catch {
            return false;
        }
        const closedCodes = new Set([
            'duplicate-keyed-root', 'missing-accepted-keyed-root', 'unexpected-keyed-root',
            'unclassified-direct-root', 'root-map-dom-mismatch',
            'active-spacer-missing-or-duplicated', 'adapter-session-generation-mismatch'
        ]);
        if (classifications.length !== 1 || !classifications.every((classification, index) => classification?.corrupt === true
            && closedCodes.has(classification.code) && classification.code === samples[index]?.code)) return false;
        const pending = recordChatWindowOuterRecovery(owner, 'classified-corruption', rawIntegrity);
        if (pending.status !== 'pending' || pending.sessionId !== owner.sessionId || pending.generation !== owner.generation
            || pending.reason !== 'classified-corruption' || !CHAT_WINDOW_EMERGENCY_ENABLED) return false;
        return enterChatWindowEmergency(owner, rawIntegrity, classifications);
    }

    function recordChatWindowOuterRecovery(owner, reason, rawIntegrity = null, error = null) {
        if (reason === 'raw-integrity-anomaly'
            && chatWindowOuterRecovery.sessionId === owner.sessionId
            && chatWindowOuterRecovery.generation === owner.generation
            && (chatWindowOuterRecovery.reason === 'classified-corruption'
                || chatWindowOuterRecovery.status === 'emergency')) return chatWindowOuterRecovery;
        const evidence = Object.freeze({
            status: 'pending',
            sessionId: owner.sessionId,
            generation: owner.generation,
            reason,
            rawIntegrity: rawIntegrity ? Object.freeze({ ...rawIntegrity }) : null
        });
        chatWindowOuterRecovery = evidence;
        window.__ocChatWindowOuterRecovery = evidence;
        try {
            const corruptionCodes = Array.isArray(rawIntegrity?.corruptionSamples)
                ? rawIntegrity.corruptionSamples.map((sample) => sample?.code).filter(Boolean).join(',')
                : '';
            const errorText = error
                ? String(error?.stack || error?.message || error).split(/\r?\n/, 1)[0].slice(0, 500)
                : '';
            vscode.postMessage({
                type: 'ui-debug',
                payload: ['[WV][CHAT_WINDOW_OUTER_RECOVERY]', `reason=${reason}`,
                    `generation=${owner.generation}`, `rawAnomaly=${rawIntegrity?.anomaly === true}`,
                    `codes=${corruptionCodes || 'none'}`, `error=${errorText || 'none'}`]
            });
        } catch { /* pending bounded ownership must not depend on diagnostics */ }
        return evidence;
    }

    function completeChatWindowOuterRecovery(owner) {
        if (owner.sessionId !== (activeSessionId || '__no_session__') || owner.generation !== chatWindowGeneration) return false;
        if (chatWindowEmergencyState.status === 'active'
            && chatWindowEmergencyState.sessionId === owner.sessionId
            && chatWindowEmergencyState.generation === owner.generation) return true;
        if (chatWindowEmergencyState.status === 'active'
            && (chatWindowEmergencyState.sessionId !== owner.sessionId
                || chatWindowEmergencyState.generation !== owner.generation)) {
            chatWindowEmergencyState.root?.remove?.();
            chatStructuralRootReservations.delete(chatWindowEmergencyState.root);
            chatWindowEmergencyState = Object.freeze({ status: 'idle', sessionId: '', generation: -1, root: null, codes: [] });
            window.__ocChatWindowEmergency = chatWindowEmergencyState;
        }
        const evidence = Object.freeze({
            status: 'healthy', sessionId: owner.sessionId, generation: owner.generation,
            reason: 'none', rawIntegrity: null
        });
        chatWindowOuterRecovery = evidence;
        window.__ocChatWindowOuterRecovery = evidence;
        return true;
    }

    function renderFromState() {
        const owner = Object.freeze({ sessionId: activeSessionId || '__no_session__', generation: chatWindowGeneration });
        if (!KEYED_CHAT_RECONCILE_ENABLED || !window.__ocRendering) {
            recordChatWindowOuterRecovery(owner, 'keyed-capability-unavailable');
            return;
        }
        if (keyedChatFailedSessionId) keyedChatFailedSessionId = '';
        if (!chatContainer) {
            recordChatWindowOuterRecovery(owner, 'chat-container-unavailable');
            return;
        }
        let stage = 'projection';
        try {
            renderPendingCount();
            const session = getSessionOrNull(activeSessionId);
            const units = window.__ocRendering.deriveRenderUnits(buildKeyedRenderCandidates(session));
            stage = 'transaction';
            const chatWindowRoute = applyChatWindowOrWave2(session, units);
            if (!CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES.has(chatWindowRoute)) {
                recordChatWindowOuterRecovery(owner, chatWindowRoute || 'window-route-unavailable');
                return;
            }
            stage = 'raw-integrity';
            const rawIntegrity = captureChatWindowRawIntegrityAudit();
            if (rawIntegrity.anomaly) {
                recordChatWindowOuterRecovery(owner, 'raw-integrity-anomaly', rawIntegrity);
                return;
            }
            stage = 'background-indicator';
            if (session) {
                countBackgroundIndicatorApplyResult(applyBackgroundSubagentIndicator(session), [`sessionId=${activeSessionId || 'null'}`, 'source=renderFromState-keyed']);
            }
            renderQuestionCardInTimeline();
            stage = 'search-highlight';
            if (sessionSearch.mode === 'smart' && sessionSearch.smartMessageIds.length) {
                applySmartSessionSearchResults(sessionSearch.smartMessageIds, { scroll: false });
            } else if (sessionSearch.open || sessionSearch.query) {
                refreshSessionSearchHighlights({ jumpToFirst: false });
            }
            stage = 'snapshot-diagnostic';
            if (shouldEmitSnapshotOnNextRender && activeSessionId) {
                vscode.postMessage({ type: 'ui-debug', payload: ['[WV][SNAPSHOT_ROUTE]', `sessionId=${activeSessionId}`, 'reason=drop-switch-readonly', `rendered=${units.length}`] });
                shouldEmitSnapshotOnNextRender = false;
            }
            stage = 'unclear-anchor';
            noteUnclearAnchorCoalescedRenderComplete(activeSessionId);
            completeChatWindowOuterRecovery(owner);
        } catch (error) {
            const attemptedFailure = error?.__ocChatReconcileFailure;
            const reason = stage === 'transaction' && (attemptedFailure?.operation === 'create' || attemptedFailure?.operation === 'replace')
                ? 'factory-or-reconcile-exception'
                : `${stage}-exception`;
            recordChatWindowOuterRecovery(owner, reason, null, error);
        }
    }

    function renderFromStateLegacy() {
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
            noteUnclearAnchorCoalescedRenderComplete(activeSessionId);
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
        noteUnclearAnchorCoalescedRenderComplete(activeSessionId);
    }

    window.__oc = window.__oc || {};
    window.__oc.renderFromState = scheduleRenderFromState;
    window.__oc.isRenderPending = () => renderScheduled;

    function renderModelSelect() {
        modelUiController.renderModelSelect();
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

    function updateVariantOptions(notifyCurrentVariant = false) {
        modelUiController.updateVariantOptions(notifyCurrentVariant);
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
            chatWindowState.programmaticScroll = true;
            chatContainer.scrollTop = chatContainer.scrollHeight;
            autoScrollPinnedToBottom = true;
            chatWindowState.activityBelow = false;
            updateChatJumpBottomButton();
            requestAnimationFrame(() => { chatWindowState.programmaticScroll = false; });
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
        attachmentUiController.render();
    }

    function renderContextTokens() {
        contextTokenUiController.render();
    }

    function addContextItem(displayText, payload) {
        if (getComposerContextStateController().addContext(displayText, payload)) renderContextTokens();
    }

    function closeFileMentionList() {
        fileMentionController.close();
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
    return appendSnapshotController.canAppend(session, message, activeSessionId);
}

function hasBlockingAppendSubmission(message) {
    return appendSnapshotController.hasBlockingSubmission(message);
}

function getAppendItems(message) {
    return appendSnapshotController.getItems(message);
}

function resolveAppendRootMessage(session, message) {
    return appendSnapshotController.resolveRootMessage(session, message);
}

function upsertAppendItem(message, item) {
    return appendSnapshotController.upsertItem(message, item);
}

function markAppendItemSeenByAssistantParent(session, parentId) {
    return appendSnapshotController.markSeenByAssistantParent(session, parentId);
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

    function handlePrimarySendClick() {
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
        const contextState = getComposerContextStateController();
        const attachmentState = getAttachmentStateController();
        const submission = buildComposerSubmission({
            text: input.value,
            attachments: attachmentState,
            context: contextState
        });
        if (!submission || isActiveSessionBusy()) return;
        const { messageText, messageImages, attachmentsPayload, contextPayload, filesPayload } = submission;
        const clientMessageId = `local-${Date.now()}-${messageCounter++}`;
        const opId = `op-${Date.now()}-${messageCounter}`;

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
        attachmentState.clear();
        renderAttachments();
        contextState.clear();
        renderContextTokens();
        input.value = '';
        const sentSession = getSessionState(activeSessionId);
        if (sentSession) sentSession.inputDraft = '';
        closeFileMentionList();
    }

    composerInputController.install();
    sendBtn.addEventListener('click', () => {
        handlePrimarySendClick();
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

    modelSelect.addEventListener('change', (e) => {
        const selection = modelUiController.selectModel(e.target.value);
        renderHeaderUsage();
        if (activeSessionId) {
            // agent timeout notice removed
        }
        vscode.postMessage({ type: 'setModel', value: selection.selectedModel });
    });

    modeSelect.addEventListener('change', (e) => {
        selectedMode = e.target.value;
        applyModeStyles(selectedMode);
        vscode.postMessage({ type: 'ui-debug', payload: ['[MODE_SELECT_CHANGE]', `to=${selectedMode}`, `displayValue=${e.target.value}`] });
        vscode.postMessage({ type: 'setMode', value: selectedMode });
        syncModeControlWidth(modeSelect, modes, selectedMode);
    });

    variantSelect.addEventListener('change', (e) => {
        const selection = modelUiController.selectVariant(e.target.value);
        vscode.postMessage({ type: 'setVariant', value: selection.selectedVariant });
    });

    historyBtn.addEventListener('click', () => {
        openSessionPanel();
    });

    sessionSearchInteractionController.install({
        toggle: searchBtn,
        input: searchInput,
        smart: searchSmartBtn,
        prev: searchPrevBtn,
        next: searchNextBtn,
        close: searchCloseBtn
    });

    newSessionBtn.addEventListener('click', () => {
        exitAppendInputMode({ restoreDraft: false });
        transitionActiveSessionPresentationOwner(activeSessionId, '');
        activeSessionId = '';
        pendingExplicitSessionSelectionId = '';
        getHeaderStateController().setBaseTitle('OpenCode: Chat');
        renderHeaderTitle();
        renderHeaderUsage();
        refreshSendButtonState();
        getAttachmentStateController().clear();
        renderAttachments();
        getComposerContextStateController().clear();
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
        applyPayloadHydrationCoverage(sessionId, message);
        if (!activeSessionId) {
            activeSessionId = sessionId;
            clearAppendInputForSessionChange(sessionId);
            renderHeaderUsage();
            updateUndoStatusDisplay(sessionId);
        }
        if (message.title && !getHeaderStateController().getBaseTitle()) {
            getHeaderStateController().setBaseTitle(message.title);
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

    function handleSessionIdMessage(message) {
        const route = resolveEventSessionId(message, 'sessionId');
        const sessionId = route?.sessionId || null;
        if (!sessionId) return;
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
            return;
        }
        const prevSessionId = activeSessionId;
        transitionActiveSessionPresentationOwner(prevSessionId, sessionId);
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
    }

 window.addEventListener('message', (event) => {
        const message = event.data || {};
        vscode.postMessage({
            type: 'ui-debug',
            payload: ['WV', 'recv', 'type', message.type || 'null', 'sessionId', message.sessionId || message.sessionID || 'null', 'hasMessages', Array.isArray(message.messages), 'messagesLen', message.messages?.length ?? 0, 'hasSegments', Array.isArray(message.segments), 'segmentsLen', message.segments?.length ?? 0]
        });

        switch (message.type) {
            case 'smartSessionSearchResult': {
                if (!sessionSearch.acceptSmartSearchResponse(message.requestId)) break;
                applySmartSessionSearchResults(message.messageIds || []);
                updateSessionSearchControls();
                break;
            }
            case 'smartSessionSearchError': {
                if (!sessionSearch.failSmartSearch(message.requestId)) break;
                sessionSearch.clearMountedMatches();
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
                modelUiController.setQuota(message.quota || null);
                const quota = modelUiController.state.getQuota();
                vscode.postMessage({
                    type: 'ui-debug',
                    payload: [
                        'modelQuota.rx',
                        `summary=${quota?.summaryRemainingPercent ?? 'null'}`,
                        `rows=${quota?.rows?.length ?? 0}`
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
                const modelSelection = modelUiController.setCatalog(
                    message.models,
                    message.selectedModel || undefined,
                    message.selectedVariant || ''
                );
                const models = modelUiController.state.getModels();
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
                    showInitNoModelsError();
                } else {
                    sendBtn.title = '';
                    updateSendGate();
                }
                
                if (!hydrated) {
                    transitionActiveSessionPresentationOwner(activeSessionId, incomingSessionId || activeSessionId || '');
                    activeSessionId = incomingSessionId || activeSessionId || '';
                }
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                renderModelSelect();
                renderModeSelect();
                updateVariantOptions(modelSelection.variantChanged);
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

              const subagentStatusFields = [`agentSessionId=${route.agentSessionId || 'null'}`];
              const terminalStatusUpdate = isTerminalSubagentStatusUpdate(incomingAgents, doneJustNowCount);
              handleSubagentStatusPatchResult(
                sessionId,
                applySubagentStatusLocalPatch(sessionId, { runningCount, finalizingCount, doneJustNowCount }),
                'subagentStatus',
                subagentStatusFields,
                { coalescedRender: true }
              );
              scheduleCoalescedSessionMetadataRender(sessionId, 'subagentStatus-coalesced', {
                immediate: terminalStatusUpdate
              });
              break;
            }
            case 'backgroundActivityPulse': {
              const route = resolveParentVisibleSubagentRoute(message, 'backgroundActivityPulse');
              if (!route) break;
              const sessionId = route.parentSessionId;
              const anchorAssistantId = typeof message.assistantMsgId === 'string' ? message.assistantMsgId : null;
              armBackgroundSubagentIndicator(sessionId, anchorAssistantId, 'backgroundActivityPulse');
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
              scheduleCoalescedSessionMetadataRender(route.parentSessionId, 'subagentStateDelta-coalesced', {
                immediate: ['done', 'failed', 'cancelled'].includes(message.to)
              });
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
                transitionActiveSessionPresentationOwner(activeSessionId, incomingSessionId || activeSessionId || '');
                activeSessionId = incomingSessionId || activeSessionId || '';
                getComposerContextStateController().clear();
                renderContextTokens();
                closeFileMentionList();
                window.__oc?.renderFromState?.();
                logSegmentState(activeSessionId, 'after-reset');
                break;
            }
            case 'models': {
                const selection = modelUiController.setCatalog(
                    message.models,
                    modelUiController.state.getSelectedModel(),
                    modelUiController.state.getSelectedVariant()
                );
                renderModelSelect();
                updateVariantOptions(selection.variantChanged);
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
            case 'hydrationCoverage': {
                handleStandaloneHydrationCoverage(message);
                break;
            }
            case 'webviewAutoRescueRenderCurrentState': {
                const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
                const branch = message.branch || 'fresh-active-turn-command';
                const fields = [
                    `sessionId=${sessionId || 'null'}`,
                    `activeSessionId=${activeSessionId || 'null'}`,
                    `panelId=${message.panelId || 'null'}`,
                    `token=${message.token || 'null'}`,
                    `notificationToken=${message.notificationToken || 'null'}`,
                    `rescueAttemptId=${message.rescueAttemptId || 'null'}`,
                    `branch=${branch}`,
                    `rescueRenderMode=${message.rescueRenderMode || 'null'}`
                ];
                logWebviewAutoRescueMarker('rescue-command-received', fields);
                postWebviewAutoRescueAck(message, 'received', 'received', '', {
                    activeSessionMatches: Boolean(sessionId && sessionId === activeSessionId),
                    currentSessionMatches: Boolean(sessionId && sessionId === activeSessionId)
                });
                const validFreshCommand = branch === 'fresh-active-turn-command' && message.rescueRenderMode === 'render-current-state-once';
                const validNotFreshCommand = branch === 'not-fresh-sessionData' && message.rescueRenderMode === 'force-full-render-once';
                if (message.rescueSource !== 'webviewAutoRescue' || (!validFreshCommand && !validNotFreshCommand)) {
                    logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=invalid-command', ...fields]);
                    postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'invalid-command');
                    break;
                }
                if (!sessionId || sessionId !== activeSessionId) {
                    logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=session-mismatch', ...fields]);
                    postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'session-mismatch');
                    break;
                }
                const attempt = markWebviewAutoRescueAttemptIfNew(message, fields);
                if (!attempt.ok) {
                    postWebviewAutoRescueAck(message, 'render-skip', 'skipped', attempt.reason);
                    break;
                }
                const session = getSessionState(sessionId, false);
                const timelineCount = Array.isArray(session?.timeline) ? session.timeline.length : 0;
                const messageCount = session?.messagesById?.size || 0;
                logWebviewAutoRescueMarker('rescue-force-render-start', [`messages=${messageCount}`, `timeline=${timelineCount}`, ...fields]);
                const renderReason = validNotFreshCommand ? 'webviewAutoRescue-force-full-render-once-command' : 'webviewAutoRescue-render-current-state-once';
                const didRender = renderIfActive(sessionId, renderReason, { extra: [`branch=${branch}`, `rescueAttemptId=${message.rescueAttemptId || 'null'}`] });
                if (didRender) {
                    logWebviewAutoRescueMarker('rescue-force-render-done', [`messages=${messageCount}`, `timeline=${timelineCount}`, ...fields]);
                    postWebviewAutoRescueAck(message, 'render-complete', 'rendered', '', { messages: messageCount, timeline: timelineCount, rendered: timelineCount });
                } else {
                    logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=inactive-session', `messages=${messageCount}`, `timeline=${timelineCount}`, ...fields]);
                    postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'inactive-session', { messages: messageCount, timeline: timelineCount, rendered: 0 });
                }
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
                const isWebviewAutoRescueSessionData = message.rescueSource === 'webviewAutoRescue';
                const rescueBranch = message.branch || 'not-fresh-sessionData';
                const rescueFields = [
                    `sessionId=${sessionId}`,
                    `activeSessionId=${activeSessionId || 'null'}`,
                    `rescueAttemptId=${message.rescueAttemptId || 'null'}`,
                    `branch=${rescueBranch}`,
                    `rescueRenderMode=${message.rescueRenderMode || 'null'}`,
                    `phase=${message.phase || 'unknown'}`,
                    `messages=${message.messages?.length ?? 0}`
                ];
                let rescueSessionDataRenderDone = false;
                if (isWebviewAutoRescueSessionData) {
                    logWebviewAutoRescueMarker('rescue-sessionData-received', rescueFields);
                    postWebviewAutoRescueAck(message, 'received', 'received', '', {
                        messages: message.messages?.length ?? 0,
                        activeSessionMatches: Boolean(activeSessionId && activeSessionId === sessionId),
                        currentSessionMatches: Boolean(activeSessionId && activeSessionId === sessionId)
                    });
                    if (message.rescueRenderMode !== 'force-full-render-once') {
                        logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=invalid-sessionData-mode', ...rescueFields]);
                        postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'invalid-sessionData-mode', { messages: message.messages?.length ?? 0 });
                        break;
                    }
                    if (!activeSessionId || activeSessionId !== sessionId) {
                        logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=session-mismatch', ...rescueFields]);
                        postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'session-mismatch', { messages: message.messages?.length ?? 0 });
                        break;
                    }
                    const attempt = markWebviewAutoRescueAttemptIfNew(message, rescueFields);
                    if (!attempt.ok) {
                        postWebviewAutoRescueAck(message, 'render-skip', 'skipped', attempt.reason, { messages: message.messages?.length ?? 0 });
                        break;
                    }
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
                        transitionActiveSessionPresentationOwner(activeSessionId, sessionId);
                        activeSessionId = sessionId;
                        if (isExplicitSelectionTarget) {
                            pendingExplicitSessionSelectionId = '';
                        }
                        clearAppendInputForSessionChange(sessionId);
                        getHeaderStateController().setBaseTitle(message.title || 'OpenCode: Chat');
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
                    applyPayloadHydrationCoverage(sessionId, message);
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
                    if (preservedLive.missingIds.length || preservedLive.mergedIds?.length || preservedLive.fieldNames.length || skippedTimelineArtifacts || skippedBackingArtifacts || skippedCanonicalTimeline || skippedCanonicalBacking || skippedCanonicalFields) {
                        vscode.postMessage({
                            type: 'ui-debug',
                            payload: ['[WV][HYDRATE_PRESERVE_VOLATILE]',
                                `sessionId=${sessionId}`,
                                `preservedIds=${preservedLive.missingIds.length}`,
                                `mergedIds=${preservedLive.mergedIds?.length || 0}`,
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

                    if (isWebviewAutoRescueSessionData) {
                        const timelineCount = Array.isArray(session.timeline) ? session.timeline.length : 0;
                        const messageCount = session.messagesById?.size || 0;
                        logWebviewAutoRescueMarker('rescue-force-render-start', [`timeline=${timelineCount}`, `messages=${messageCount}`, ...rescueFields]);
                        rescueSessionDataRenderDone = renderIfActive(sessionId, 'webviewAutoRescue-force-full-render-once', { extra: ['phase=hydrated', `branch=${rescueBranch}`, `rescueAttemptId=${message.rescueAttemptId || 'null'}`] });
                        if (rescueSessionDataRenderDone) {
                            logWebviewAutoRescueMarker('rescue-force-render-done', [`timeline=${timelineCount}`, `messages=${messageCount}`, ...rescueFields]);
                            postWebviewAutoRescueAck(message, 'render-complete', 'rendered', '', { timeline: timelineCount, messages: messageCount, rendered: timelineCount });
                        } else {
                            logWebviewAutoRescueMarker('rescue-force-render-skip', ['reason=inactive-session', `timeline=${timelineCount}`, `messages=${messageCount}`, ...rescueFields]);
                            postWebviewAutoRescueAck(message, 'render-skip', 'skipped', 'inactive-session', { timeline: timelineCount, messages: messageCount, rendered: 0 });
                        }
                    } else {
                        renderIfActive(sessionId, 'sessionData', { extra: ['phase=hydrated'] });
                    }
                    
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
                    if (isWebviewAutoRescueSessionData) {
                        postWebviewAutoRescueAck(message, 'render-fail', 'failed', String(err));
                    }
                } finally {
                    const didRender = isWebviewAutoRescueSessionData
                        ? rescueSessionDataRenderDone
                        : renderIfActive(sessionId, 'sessionData-finally', { extra: ['phase=finally'] });
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
                handleSessionIdMessage(message);
                break;
            }
            case 'sessionUsage': {
                const sessionId = getEventSessionId(message, 'sessionUsage');
                if (!sessionId) break;
                const used = Number(message?.used);
                const size = Number(message?.size);
                const amount = Number(message?.amount);
                getHeaderStateController().setUsage(sessionId, {
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
                getHeaderStateController().setCompactionState(sessionId, running, getSelectedModelContextLimit());
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
                const files = Array.isArray(message.files) ? message.files : [];
                fileMentionController.handleResults(message.requestId, files);
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
                    getAttachmentStateController().restoreFilePaths(draft.attachments);
                    renderAttachments();
                }
                if (typeof draft.model === 'string') {
                    const selection = modelUiController.selectModel(draft.model);
                    modelSelect.value = selection.selectedModel;
                }
                if (typeof draft.variant === 'string') {
                    const selection = modelUiController.selectVariant(draft.variant);
                    variantSelect.value = selection.selectedVariant;
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
                const rendered = renderIfActive(sessionId, 'addResponse', { scroll: true, scrollFallback: scrollToBottom });
                if (rendered) setBusy(false);
                logSessionState(sessionId, 'addResponse');
                break;
            }
            case 'attachmentAdded': {
                getAttachmentStateController().add({
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
                renderIfActive(sessionId, 'attachmentError');
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
                changeListEventController.handleDiffFileList(route.sessionId, message, selectedMode || 'unknown');
                break;
            }
            case 'changeListUpdate': {
                const route = resolveEventSessionId(message, 'changeListUpdate');
                if (!route) break;
                changeListEventController.handleChangeListUpdate(route.sessionId, message);
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
                scheduleCoalescedSessionMetadataRender(sessionId, 'todoUpdate-coalesced');
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
                        renderIfActive(sessionId, 'revertedSegment:notApplied');
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

                            finalMemberMsgIds = orderSegmentMemberMsgIdsByTimeline(
                                Array.from(mergedMemberMsgIds),
                                session.timeline
                            );
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
                    renderIfActive(sessionId, 'revertedSegment:placeholder');
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
                    renderIfActive(sessionId, 'revertedSegment', { scroll: true, scrollFallback: scrollToBottom });
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
                    renderIfActive(sessionId, 'revertedSegmentDiscarded', { scroll: true, scrollFallback: scrollToBottom });
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
                renderIfActive(sessionId, 'restoredSegment', { scroll: true, scrollFallback: scrollToBottom });
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
                    renderIfActive(sessionId, 'revertedSegmentState', { scroll: true, scrollFallback: scrollToBottom });
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
                const nextSessionId = message.sessionId || '';
                transitionActiveSessionPresentationOwner(activeSessionId, nextSessionId);
                activeSessionId = nextSessionId;
                pendingExplicitSessionSelectionId = '';
                clearAppendInputForSessionChange(activeSessionId);
                clearQuestionOverlay('new-session');
                clearPermissionOverlay('new-session');
                getHeaderStateController().setBaseTitle('OpenCode: Chat');
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
                renderIfActive(sessionId, 'segmentRestoreLock');
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
                renderIfActive(sessionId, 'error', { scroll: true, scrollFallback: scrollToBottom });
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
                renderIfActive(sessionId, 'removeMessage', { scroll: true, scrollFallback: scrollToBottom });
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

function scanSafeShellConflictDiffPage(text, requestedPage, pageContract) {
    const value = typeof text === 'string' ? text : '';
    const maxCodeUnits = pageContract.maxCodeUnits;
    const maxLines = pageContract.maxLines;
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;
    let currentPage = 1;
    let currentPageCodeUnits = 0;
    let currentPageLines = 1;
    let newlineCount = 0;
    let pageText = '';
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (currentPageCodeUnits >= maxCodeUnits || (character === '\n' && currentPageLines >= maxLines)) {
            currentPage += 1;
            currentPageCodeUnits = 0;
            currentPageLines = 1;
        }
        if (currentPage === page) pageText += character;
        currentPageCodeUnits += 1;
        if (character === '\n') {
            currentPageLines += 1;
            newlineCount += 1;
        }
    }
    return {
        pageText,
        totalPages: value.length > 0 ? currentPage : 1,
        codeUnitCount: value.length,
        lineCount: value.length > 0 ? newlineCount + 1 : 0
    };
}

function renderSafeShellConflictCard(payload, options, conflictOwner) {
    const rendering = window.__ocRendering;
    const selection = options?.presentationSelection;
    if (!rendering || typeof rendering.getSafeShellSpec !== 'function') return null;
    if (selection?.mode !== 'safe-shell' || selection?.family !== 'conflict') return null;
    const conflicts = Array.isArray(payload?.conflicts) ? payload.conflicts : [];
    if (conflicts.length === 0) return null;

    const initialSpec = rendering.getSafeShellSpec({
        mode: selection.mode,
        family: selection.family,
        page: 1,
        contentPage: 1,
        shape: { itemCount: conflicts.length, codeUnitCount: 0, lineCount: 0 }
    });
    const conflictsPerPage = initialSpec?.page?.primary?.limit;
    if (!initialSpec?.allowed || initialSpec.shellSelected !== true || !initialSpec.page?.content || !Number.isFinite(conflictsPerPage)) return null;

    const root = document.createElement('div');
    root.className = 'conflict-card safe-shell';
    root.dataset.safeShellFamily = initialSpec.family;
    const generation = ++conflictShellPresentationGeneration;
    root.dataset.safeShellGeneration = String(generation);
    const ownership = {
        sessionId: activeSessionId,
        unitKey: typeof options?.unitKey === 'string' ? options.unitKey : '',
        generation,
        disposed: false,
        frames: new Set(),
        timers: new Set()
    };
    root._conflictShellOwnership = ownership;
    const isCurrent = () => ownership.disposed !== true
        && activeSessionId === ownership.sessionId
        && root.dataset.renderUnitKey === ownership.unitKey
        && root.dataset.safeShellGeneration === String(ownership.generation)
        && root._conflictShellOwnership === ownership
        && conflictCardEl === root
        && root.isConnected;
    root._safeShellDispose = () => {
        if (ownership.disposed) return;
        ownership.disposed = true;
        for (const frame of ownership.frames) cancelAnimationFrame(frame);
        for (const timer of ownership.timers) clearTimeout(timer);
        ownership.frames.clear();
        ownership.timers.clear();
        if (conflictCardEl === root) conflictCardEl = null;
    };

    const deterministicKey = encodeURIComponent(ownership.unitKey).replace(/%/g, '-');
    const viewerId = `safe-shell-conflict-viewer-${deterministicKey}-${generation}`;
    let open = false;
    let conflictPage = 1;
    let selectedIndex = 0;
    let diffPage = 1;

    const existenceLabel = (value) => value === true ? 'exists' : value === false ? 'missing' : 'unavailable';
    const pathOf = (item, index) => typeof item?.path === 'string' && item.path ? item.path : `Unavailable file ${index + 1}`;
    const diffOf = (item) => typeof item?.diffText === 'string' ? item.diffText : '';
    const scheduleFocus = (roleName) => {
        let frame = null;
        frame = requestAnimationFrame(() => {
            ownership.frames.delete(frame);
            if (!isCurrent()) return;
            root.querySelector(`[data-safe-shell-role="${roleName}"]`)?.focus?.();
        });
        ownership.frames.add(frame);
    };
    const makeButton = (roleName, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'safe-shell-action';
        button.dataset.safeShellRole = roleName;
        button.textContent = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!button.isConnected || !isCurrent()) return;
            onClick(button);
        });
        return button;
    };
    const decide = (decision) => {
        root.remove();
        if (conflictCardEl === root) conflictCardEl = null;
        lastConflictPayload = null;
        ownership.disposed = true;
        for (const frame of ownership.frames) cancelAnimationFrame(frame);
        for (const timer of ownership.timers) clearTimeout(timer);
        ownership.frames.clear();
        ownership.timers.clear();
        vscode.postMessage({
            type: 'conflictDecision',
            decision,
            sessionId: conflictOwner.sessionId,
            operationId: conflictOwner.operationId,
            conflictId: conflictOwner.conflictId,
            kind: conflictOwner.kind,
            source: conflictOwner.source,
            startMessageId: conflictOwner.startMessageId,
            endMessageId: conflictOwner.endMessageId,
            noticeKey: conflictOwner.noticeKey
        });
    };

    const render = () => {
        const descriptor = rendering.getSafeShellSpec({
            mode: selection.mode,
            family: selection.family,
            page: conflictPage,
            contentPage: diffPage,
            shape: { itemCount: conflicts.length, codeUnitCount: diffOf(conflicts[selectedIndex]).length, lineCount: 1 }
        });
        if (!descriptor?.allowed || descriptor.shellSelected !== true || !descriptor.page?.primary) return;
        conflictPage = descriptor.page.primary.index;
        const pageStart = descriptor.page.primary.start;
        const pageEnd = Math.min(conflicts.length, pageStart + descriptor.page.primary.limit);
        if (selectedIndex < pageStart || selectedIndex >= pageEnd) selectedIndex = pageStart;
        const selected = conflicts[selectedIndex];
        const selectedDiff = diffOf(selected);
        let scan = scanSafeShellConflictDiffPage(selectedDiff, diffPage, initialSpec.page.content);
        diffPage = Math.min(Math.max(1, diffPage), scan.totalPages);
        if (diffPage !== 1) scan = scanSafeShellConflictDiffPage(selectedDiff, diffPage, initialSpec.page.content);

        const heading = document.createElement('div');
        heading.className = 'safe-shell-heading';
        heading.textContent = descriptor.labels.title;

        const status = document.createElement('div');
        status.className = 'safe-shell-status';
        status.dataset.safeShellRole = 'status';
        status.id = `${viewerId}-status`;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = open
            ? `${conflicts.length} conflicts; showing conflicts ${pageStart + 1}–${pageEnd}; selected expected ${existenceLabel(selected?.expectedExists)}, current ${existenceLabel(selected?.currentExists)}; diff ${scan.codeUnitCount} code units across ${scan.lineCount} logical lines.`
            : `${conflicts.length} conflicts; only conflicts ${pageStart + 1}–${pageEnd} are represented; selected expected ${existenceLabel(selected?.expectedExists)}, current ${existenceLabel(selected?.currentExists)}. Full diff omitted; open full for bounded paging.`;

        const list = document.createElement('div');
        list.className = 'safe-shell-conflict-list';
        list.dataset.safeShellRole = 'conflict-list';
        for (let index = pageStart; index < pageEnd; index += 1) {
            const item = conflicts[index];
            const label = `${index + 1}. ${pathOf(item, index)}; expected ${existenceLabel(item?.expectedExists)}; current ${existenceLabel(item?.currentExists)}`;
            const conflictButton = makeButton(`conflict-${index}`, label, () => {
                selectedIndex = index;
                diffPage = 1;
                render();
                if (open) scheduleFocus('viewer');
            });
            conflictButton.setAttribute('aria-pressed', selectedIndex === index ? 'true' : 'false');
            list.appendChild(conflictButton);
        }

        const viewerRegion = document.createElement('div');
        viewerRegion.className = 'safe-shell-viewer-region';
        viewerRegion.dataset.safeShellRole = 'viewer-region';
        viewerRegion.id = viewerId;
        viewerRegion.setAttribute('aria-describedby', status.id);
        if (open) {
            const conflictPageStatus = document.createElement('span');
            conflictPageStatus.dataset.safeShellRole = 'conflict-page-status';
            conflictPageStatus.setAttribute('role', 'status');
            conflictPageStatus.textContent = `Conflicts ${pageStart + 1}–${pageEnd} of ${conflicts.length}`;
            viewerRegion.appendChild(conflictPageStatus);
            const viewer = document.createElement('pre');
            viewer.className = 'safe-shell-viewer';
            viewer.dataset.safeShellRole = 'viewer';
            viewer.tabIndex = -1;
            viewer.textContent = scan.pageText;
            viewerRegion.appendChild(viewer);
            const diffPageStatus = document.createElement('span');
            diffPageStatus.dataset.safeShellRole = 'diff-page-status';
            diffPageStatus.setAttribute('role', 'status');
            diffPageStatus.textContent = `Diff page ${diffPage} of ${scan.totalPages}`;
            viewerRegion.appendChild(diffPageStatus);
        }

        const actions = document.createElement('div');
        actions.className = 'safe-shell-actions';
        const labels = descriptor.labels.actions;
        const openButton = makeButton('open-full', labels['open-full'], () => {
            if (open) return;
            open = true;
            render();
            scheduleFocus('viewer');
        });
        openButton.setAttribute('aria-controls', viewerId);
        openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
        openButton.disabled = open;
        actions.appendChild(openButton);
        if (open) {
            const previous = makeButton('previous', labels.previous, () => {
                conflictPage = Math.max(1, conflictPage - 1);
                diffPage = 1;
                render();
                scheduleFocus(`conflict-${Math.max(0, (conflictPage - 1) * conflictsPerPage)}`);
            });
            previous.disabled = descriptor.page.primary.hasPrevious !== true;
            actions.appendChild(previous);
            const next = makeButton('next', labels.next, () => {
                conflictPage += 1;
                diffPage = 1;
                render();
                scheduleFocus(`conflict-${(conflictPage - 1) * conflictsPerPage}`);
            });
            next.disabled = descriptor.page.primary.hasNext !== true;
            actions.appendChild(next);
            const diffPrevious = makeButton('diff-previous', 'Previous diff page', () => {
                diffPage = Math.max(1, diffPage - 1);
                render();
                scheduleFocus('viewer');
            });
            diffPrevious.disabled = diffPage <= 1;
            actions.appendChild(diffPrevious);
            const diffNext = makeButton('diff-next', 'Next diff page', () => {
                diffPage = Math.min(scan.totalPages, diffPage + 1);
                render();
                scheduleFocus('viewer');
            });
            diffNext.disabled = diffPage >= scan.totalPages;
            actions.appendChild(diffNext);
            actions.appendChild(makeButton('close', labels.close, () => {
                open = false;
                render();
                if (isCurrent()) root.querySelector('[data-safe-shell-role="open-full"]')?.focus?.();
            }));
        }
        actions.appendChild(makeButton('copy-full', labels['copy-full'], (button) => {
            Promise.resolve(writeTextToClipboard(diffOf(conflicts[selectedIndex]))).then((copied) => {
                if (!isCurrent()) return;
                root.dataset.safeShellCopyState = copied ? 'copied' : 'failed';
                button.textContent = copied ? 'Copied' : 'Copy failed';
                const timer = setTimeout(() => {
                    ownership.timers.delete(timer);
                    if (!isCurrent()) return;
                    delete root.dataset.safeShellCopyState;
                    render();
                }, copied ? 900 : 1200);
                ownership.timers.add(timer);
            });
        }));
        const openDiff = makeButton('open-diff', labels['open-diff'], () => {
            const item = conflicts[selectedIndex];
            if (typeof item?.path === 'string' && item.path) postOpenGitDiff(item.path, conflictOwner.sessionId);
        });
        openDiff.disabled = !(typeof selected?.path === 'string' && selected.path);
        actions.appendChild(openDiff);
        actions.appendChild(makeButton('skip', labels.skip, () => decide('skip')));
        actions.appendChild(makeButton('override', labels.override, () => decide('override')));
        root.replaceChildren(heading, status, list, viewerRegion, actions);
    };

    render();
    return root;
}

function renderConflictCard(payload, options = {}) {
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
    if (!options.detached && conflictCardEl && conflictCardEl.parentElement) {
        conflictCardEl.parentElement.removeChild(conflictCardEl);
    }
    const safeShellRoot = renderSafeShellConflictCard(payload, options, conflictOwner);
    if (safeShellRoot) {
        conflictCardEl = safeShellRoot;
        if (options.detached) return safeShellRoot;
        chatContainer.appendChild(safeShellRoot);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return safeShellRoot;
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

    if (options.detached) {
        conflictCardEl = container;
        return container;
    }
    chatContainer.appendChild(container);
    conflictCardEl = container;
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return container;
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

