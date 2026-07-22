type Message = any;
type SessionState = any;
type RenderElement = any;

type SubagentTextExpansionState = {
    get(key: string): boolean | undefined;
    set(key: string, expanded: boolean): void;
};

export interface MessageRendererHost {
    readonly KEYED_CHAT_RECONCILE_ENABLED: boolean;
    readonly activeSessionId: string;
    readonly appendChatRenderRoot: (root: RenderElement) => boolean;
    readonly appendHoverActiveKey: string | null;
    readonly appendMessageImages: (root: RenderElement, message: Message) => void;
    readonly appendMessageToChat: (root: RenderElement, message: Message) => boolean;
    readonly attachMessageCopyButton: (root: RenderElement, message: Message) => void;
    readonly buildAppendHoverKey: (sessionId: string, messageId: string) => string;
    readonly busySessionId: string | null;
    readonly canAppendToMessage: (session: SessionState, message: Message) => boolean;
    readonly canUndo: (session: SessionState, anchorKey: string) => { allowed: boolean; msgId?: string; reason?: string };
    readonly changeListRenderer: { render(message: Message): RenderElement | null };
    readonly chatContainer: { appendChild(node: RenderElement): void };
    readonly cleanSubagentTitle: (title: string) => string;
    readonly discardAllSegments: (sessionId: string, reason: string, mode: string, options: { anchorMsgId: string }) => void;
    readonly enterAppendInputMode: (messageId: string) => void;
    readonly formatSubagentModel: (agent: Message) => string;
    readonly getAppendItems: (message: Message) => Message[];
    readonly getSessionOrNull: (sessionId: string) => SessionState | null;
    readonly getSessionState: (sessionId: string) => SessionState | null;
    readonly gitUndoEnabled: boolean;
    readonly handleRestoreSegment: (sessionId: string, noticeKey: string) => void;
    readonly handleUndoToMessage: (sessionId: string, messageId: string) => void;
    readonly invalidateKeyedChatUnitPresentation: (messageId: string) => boolean;
    readonly isBusy: boolean;
    readonly keyedFollowingTurnDividerOverride: boolean | null;
    readonly logSessionState: (sessionId: string, eventName: string) => void;
    readonly pickMode: (agent: Message) => string;
    readonly renderAssistantMarkdown: (container: RenderElement, message: Message) => void;
    readonly renderMarkdownInto: (container: RenderElement, markdown: string) => void;
    readonly renderNestedInvalidSegmentElement: (session: SessionState, segment: Message) => RenderElement;
    readonly renderNestedMessageElement: (message: Message) => RenderElement;
    readonly renderUserMarkdown: (container: RenderElement, markdown: string) => void;
    readonly sanitizeMergedSegmentSnapshot: (segment: Message) => Message | null;
    readonly scheduleClearAppendHover: (key: string) => void;
    readonly selectedMode: string | null;
    readonly setAppendHoverActive: (key: string | null) => void;
    readonly shouldShowBackgroundSubagentIndicator: (session: SessionState, message: Message) => boolean;
    readonly stripAttachmentManifest: (text: string) => string;
    readonly stripSystemInjections: (text: string) => string;
    readonly subagentTextExpandedByKey: SubagentTextExpansionState;
    readonly toggleUndoSegmentPlaceholder: (sessionId: string, noticeKey: string) => Message | null;
    readonly vscode: { postMessage(message: Message): void };
}

/** Renders one canonical chat message without owning session or virtualization state. */
export function renderMessageElement(
  host: MessageRendererHost,
  message: any,
  renderedSet: Set<string>,
): void {
    if (renderedSet.has(message.id)) {
        console.warn('[Render] duplicate message skipped', message.id);
        return;
    }
    const session = host.getSessionState(host.activeSessionId);
    const finalAssistantId = typeof session?.finalAssistantLock?.assistantMsgId === 'string'
        ? session.finalAssistantLock.assistantMsgId
        : null;
    if (message?.role === 'assistant' && finalAssistantId && message.id === finalAssistantId) {
        const currentSegmentLen = typeof message?.meta?.currentSegment === 'string' ? message.meta.currentSegment.length : 0;
        const textSegmentsLen = Array.isArray(message?.meta?.textSegments) ? message.meta.textSegments.length : 0;
        host.vscode.postMessage({
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
            const container = host.changeListRenderer.render(message);
            if (!container) return;
            if (host.appendChatRenderRoot(container) === true) renderedSet.add(message.id);
            return;
        }

        if (message.meta?.kind === 'undoSegmentPlaceholder' || message.id.startsWith('system:undo-seg:')) {
            const session = host.getSessionOrNull(host.activeSessionId);
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

            host.vscode.postMessage({
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
                    host.vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][SEG_RESTORE_BLOCKED]', `noticeKey=${noticeKey || 'null'}`]
                    });
                    return;
                }
                host.vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_RESTORE_CLICK]', `noticeKey=${noticeKey || 'null'}`]
                });
                host.handleRestoreSegment(host.activeSessionId, noticeKey);
            });
            actions.appendChild(restoreBtn);

            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'reverted-segment-btn secondary';
            toggleBtn.textContent = collapsed ? 'Expand' : 'Collapse';
            toggleBtn.addEventListener('click', () => {
                const liveSegment = host.toggleUndoSegmentPlaceholder(host.activeSessionId, noticeKey);
                if (!liveSegment) return;
                const invalidated = host.invalidateKeyedChatUnitPresentation(message.id);
                host.vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['[WV][SEG_TOGGLE]', `noticeKey=${noticeKey || 'null'}`, `collapsed=${liveSegment.collapsed}`, `invalidated=${invalidated}`]
                });
                (window as any).__oc?.renderFromState?.();
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
                    nestedWrap.appendChild(host.renderNestedMessageElement(msg));
                }
                const mergedInvalidSegments = Array.isArray(segment?.mergedInvalidSegments)
                    ? segment.mergedInvalidSegments
                        .map((child: any) => host.sanitizeMergedSegmentSnapshot(child))
                        .filter(Boolean)
                    : [];
                for (const child of mergedInvalidSegments) {
                    nestedWrap.appendChild(host.renderNestedInvalidSegmentElement(session, child));
                }
                if (nestedWrap.childNodes.length > 0) {
                    card.appendChild(nestedWrap);
                }
            }

            content.appendChild(card);
            div.appendChild(content);
            if (host.appendChatRenderRoot(div) === true) renderedSet.add(message.id);
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
                    host.renderAssistantMarkdown(content, tempMessage);
                } else {
                    // Fallback to full text if final segment is empty
                    host.renderAssistantMarkdown(content, message);
                }
            } else {
                // Streaming or no segments: render full accumulated text
                host.renderAssistantMarkdown(content, message);
            }
        } else {
            const sanitized = message.role === 'user' ? host.stripSystemInjections(host.stripAttachmentManifest(raw)) : raw;
            if (message.role === 'user' && !sanitized.trim()) {
                return;
            }
            if (message.role === 'user') {
                const mainText = document.createElement('div');
                mainText.className = 'message-user-text';
                host.renderUserMarkdown(mainText, sanitized);
                content.appendChild(mainText);
                for (const item of host.getAppendItems(message)) {
                    if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
                    const block = document.createElement('div');
                    block.className = 'append-message-block';
                    const divider = document.createElement('div');
                    divider.className = 'append-message-divider';
                    block.appendChild(divider);
                    const textEl = document.createElement('div');
                    textEl.className = 'append-message-text';
                    host.renderUserMarkdown(textEl, item.text);
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
        host.attachMessageCopyButton(div, message);

        if (host.shouldShowBackgroundSubagentIndicator(session, message)) {
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

            function addSubagentTextToggle(textRow: any, options: any = {}) {
                const collapsedLineCount = 5;
                let collapsedMaxHeight = '7.5em';
                const previewText = typeof options.previewText === 'string' ? options.previewText : '';
                const fullText = typeof options.fullText === 'string' ? options.fullText : previewText;
                const expandedKey = typeof options.expandedKey === 'string' ? options.expandedKey : '';
                const canExpandToFullText = fullText && fullText !== previewText;
                const hasToggleText = Boolean(previewText || fullText);
                let expanded = expandedKey ? host.subagentTextExpandedByKey.get(expandedKey) === true : false;

                const renderCurrentText = () => {
                    host.renderMarkdownInto(textRow, expanded && canExpandToFullText ? fullText : previewText);
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
                        host.subagentTextExpandedByKey.set(expandedKey, expanded);
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

             subagents.forEach((agent: any, index: number) => {
                 const entry = document.createElement('div');
                 entry.className = 'subagent-inline-entry';

                 // 1) Subagent N: [title],
                 const header = document.createElement('div');
                 header.className = 'subagent-inline-header';
                 const rawTitleText = (typeof agent.title === 'string' && agent.title.trim()) ? agent.title.trim() : '';
                 const titleText = host.cleanSubagentTitle(rawTitleText);
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
                 const mode = host.pickMode(agent);
                 const model = host.formatSubagentModel(agent);
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
                    const dedupeSubagentText = (value: any) => {
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
                    const parentIdentity = agent.parentSessionId || message.sessionId || host.activeSessionId || '';
                    const messageIdentity = message.id || message.messageId || '';
                    const expandedKey = subagentIdentity
                        ? `${parentIdentity}:${messageIdentity}:${subagentIdentity}`
                        : '';
                    host.renderMarkdownInto(textRow, host.subagentTextExpandedByKey.get(expandedKey) === true ? fullTextToRender : previewTextToRender);
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

        host.appendMessageImages(div, message);

        // Insert turn divider before user messages (except first)
        if (message.role === 'user' && (host.keyedFollowingTurnDividerOverride === true || (host.keyedFollowingTurnDividerOverride === null && renderedSet && renderedSet.size > 0))) {
            const hasUserMessages = Array.from(renderedSet).some(id => {
                const session = host.getSessionState(host.activeSessionId);
                if (!session) return false;
                const msg = session.messagesById.get(id);
                return msg && msg.role === 'user';
            });
            if (host.keyedFollowingTurnDividerOverride === true || hasUserMessages) {
                if (host.KEYED_CHAT_RECONCILE_ENABLED) {
                    (div as any)._hasFollowingTurnDivider = true;
                } else {
                    const divider = document.createElement('div');
                    divider.className = 'turn-divider';
                    host.chatContainer.appendChild(divider);
                }
            }
        }
        if (message.role === 'user') {
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const isAppendableActiveUserMessage = host.canAppendToMessage(session, message);
            const appendHoverKey = isAppendableActiveUserMessage
                ? host.buildAppendHoverKey(host.activeSessionId, message.id)
                : null;
            if (appendHoverKey && host.appendHoverActiveKey === appendHoverKey) {
                div.classList.add('append-hover-active');
            }
            if (appendHoverKey) {
                const keepAppendHoverActive = () => host.setAppendHoverActive(appendHoverKey);
                const releaseAppendHoverActive = () => host.scheduleClearAppendHover(appendHoverKey);
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
                    host.setAppendHoverActive(appendHoverKey);
                    host.enterAppendInputMode(message.id);
                });
                actions.appendChild(appendBtn);
            }
            if (!host.gitUndoEnabled) {
                div.appendChild(actions);
                if (host.appendMessageToChat(div, message) === true) renderedSet.add(message.id);
                return;
            }
            if (isAppendableActiveUserMessage) {
                div.appendChild(actions);
                if (host.appendMessageToChat(div, message) === true) renderedSet.add(message.id);
                return;
            }
            const undoBtn = document.createElement('button');
            undoBtn.className = 'undo-btn';
            undoBtn.type = 'button';
            undoBtn.title = 'Undo to this message';
            undoBtn.textContent = '\u21BA';
            undoBtn.addEventListener('click', () => {
                if (host.isBusy) {
                    host.vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['[WV][UNDO_BLOCKED]', 'reason=busy', `busySessionId=${host.busySessionId || 'null'}`, `activeSessionId=${host.activeSessionId || 'null'}`]
                    });
                    return;
                }
                const sessionId = host.activeSessionId;
                const session = host.getSessionState(sessionId);
                if (!session) return;
                const msg = session.messagesById.get(message.id);
                if (!msg) return;
                const anchorKey = message.id;
                const verdict = host.canUndo(session, anchorKey);
                host.vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.request', 'anchorKey', anchorKey, 'isMsgId', anchorKey.startsWith('msg_'), 'undoAllowed', verdict.allowed]
                });
                if (!verdict.allowed || !verdict.msgId) {
                    host.vscode.postMessage({
                        type: 'ui-debug',
                        payload: ['undo.blocked', 'anchorKey', anchorKey, 'reason', verdict.reason]
                    });
                    return;
                }
                host.vscode.postMessage({
                    type: 'ui-debug',
                    payload: ['undo.send', 'anchorMsgId', verdict.msgId]
                });
                host.discardAllSegments(sessionId, 'undo', host.selectedMode || 'unknown', { anchorMsgId: verdict.msgId });
                host.handleUndoToMessage(sessionId, verdict.msgId);
                (window as any).__oc?.renderFromState?.();
                host.logSessionState(sessionId, 'UI_UNDO_TO_MESSAGE');
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
        if (host.appendMessageToChat(div, message) === true) renderedSet.add(message.id);
    
}
