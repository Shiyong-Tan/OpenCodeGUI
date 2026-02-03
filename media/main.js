const vscode = acquireVsCodeApi();

const md = window.markdownit({
    linkify: true,
    breaks: true,
    html: false
});
const purify = window.DOMPurify;

let models = [];
let sessions = [];
let selectedModel = '';
let selectedVariant = '';
let currentSessionId = '';
let isBusy = false;
let attachments = [];
let messageElements = new Map();
let messageCounter = 0;
let collapsedProviders = new Set();
let modelDropdownOutsideHandler = null;
let simpleDropdownHandlers = new Map();
let lastUndoTargetEl = null;
let revertedSegmentState = null;
let hiddenRanges = [];
let pendingMessages = [];
let pendingUserMessage = null;
let isStreaming = false;
let currentAssistantMessage = null;
let pendingAssistantText = '';

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

    vscode.postMessage({ type: 'webviewReady' });

    sendBtn.innerHTML = sendIcon;

    sendBtn.addEventListener('click', () => {
        if (isBusy) {
            vscode.postMessage({ type: 'cancel' });
            return;
        }
        const text = input.value.trim();
        if ((!text && !attachments.length) || isBusy) return;
        const messageText = text || 'Image attached.';
        const displayText = messageText;
        const clientMessageId = `local-${Date.now()}-${messageCounter++}`;
        const messageImages = attachments
            .map((item) => item.dataUrl)
            .filter((value) => typeof value === 'string' && value.length > 0);
        pendingUserMessage = {
            id: clientMessageId,
            role: 'user',
            text: displayText,
            images: messageImages
        };
        setBusy(true);
        isStreaming = true;
        currentAssistantMessage = null;
        pendingAssistantText = '';
        if (!pendingMessages.some((item) => item.id === pendingUserMessage.id)) {
            const messageWithIndex = {
                ...pendingUserMessage,
                messageIndex: getNextMessageIndex()
            };
            pendingMessages = [...pendingMessages, messageWithIndex];
            renderSessionMessages(pendingMessages);
        }
        if (!currentAssistantMessage) {
            const thinkingMessage = {
                id: `thinking-${Date.now()}-${messageCounter++}`,
                role: 'assistant',
                text: 'Thinking...',
                messageIndex: getNextMessageIndex()
            };
            currentAssistantMessage = thinkingMessage;
            pendingMessages = [...pendingMessages, thinkingMessage];
            renderSessionMessages(pendingMessages);
        }
        const attachmentPaths = attachments.map((item) => item.filePath);
        vscode.postMessage({ type: 'sendMessage', value: messageText, attachments: attachmentPaths, clientMessageId });
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
            vscode.postMessage({ type: 'setMode', value: selectedMode });
            renderModeSelect();
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

    newSessionBtn.addEventListener('click', () => {
        currentSessionId = '';
        sessionTitle.textContent = 'OpenCode: Chat';
        attachments = [];
        renderAttachments();
        setDefaultGreeting();
        vscode.postMessage({ type: 'newSession' });
    });

    refreshSessionsBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'refreshSessions' });
    });

    closeSessionsBtn.addEventListener('click', closeSessionPanel);
    panelBackdrop.addEventListener('click', closeSessionPanel);

    window.addEventListener('message', event => {
        const message = event.data;
        const currentSessionIsEmpty = currentSessionId === '' || currentSessionId === undefined || currentSessionId === null;

        if (message.type !== 'sessionData' && message.type !== 'sessionId') {
            if (typeof message.sessionId === 'string' && !currentSessionIsEmpty && message.sessionId !== currentSessionId) {
                return;
            }
        }

        if (currentSessionIsEmpty && typeof message.sessionId === 'string' && message.sessionId) {
            currentSessionId = message.sessionId;
        }


        let loading = document.getElementById('current-loading');

        switch (message.type) {
            case 'init':
                models = Array.isArray(message.models) ? message.models : [];
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                selectedModel = message.selectedModel || (models[0] ? models[0].fullId : '');
                selectedVariant = message.selectedVariant || '';
                selectedMode = message.selectedMode || 'build';
                currentSessionId = message.currentSessionId || currentSessionId || '';
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                vscode.postMessage({ type: 'setMode', value: selectedMode });
                renderModelSelect();
                renderModeSelect();
                updateVariantOptions();
                renderSessionList();
                break;
            case 'models':
                models = Array.isArray(message.models) ? message.models : [];
                renderModelSelect();
                updateVariantOptions();
                break;
            case 'sessions':
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                renderSessionList();
                break;
            case 'sessionData':
                currentSessionId = message.sessionId || '';
                sessionTitle.textContent = message.title || 'OpenCode: Chat';
                attachments = [];
                renderAttachments();
                expandCollapsedMessages();
                pendingMessages = Array.isArray(message.messages) ? message.messages : [];
                currentAssistantMessage = null;
                isStreaming = false;
                pendingAssistantText = '';
                hiddenRanges = [];
                pendingMessages = pendingMessages.filter((item) => item.text !== 'Thinking...');
                renderSessionMessages(pendingMessages);
                closeSessionPanel();
                break;
            case 'sessionId':
                currentSessionId = message.sessionId || message.value || '';
                break;
            case 'messageIdMap':
                if (message.clientMessageId && message.messageId) {
                    const element = messageElements.get(message.clientMessageId);
                    if (element) {
                        element.dataset.messageId = message.messageId;
                        messageElements.delete(message.clientMessageId);
                        messageElements.set(message.messageId, element);
                    }
                    if (pendingUserMessage && pendingUserMessage.id === message.clientMessageId) {
                        const msgIndex = typeof message.messageIndex === 'number' ? message.messageIndex : getNextMessageIndex();
                        pendingUserMessage = { ...pendingUserMessage, id: message.messageId, messageIndex: msgIndex };
                    }
                    pendingMessages = pendingMessages.map((item) =>
                        item.id === message.clientMessageId
                            ? { ...item, id: message.messageId, messageIndex: typeof message.messageIndex === 'number' ? message.messageIndex : item.messageIndex }
                            : item
                    );
                    if (pendingUserMessage && pendingUserMessage.id === message.messageId && typeof pendingUserMessage.messageIndex === 'number') {
                        if (!pendingMessages.some((item) => item.id === pendingUserMessage.id)) {
                            pendingMessages = [...pendingMessages, pendingUserMessage];
                        }
                        pendingUserMessage = null;
                    }
                    renderSessionMessages(pendingMessages);
                }
                break;
            case 'assistantMessageMeta':
                if (message.messageId) {
                    const text = message.lastText || (document.getElementById('current-loading')
                        ?.querySelector('.message-content')?.textContent || '').trim();
                    const msgIndex = typeof message.messageIndex === 'number' ? message.messageIndex : getNextMessageIndex();
                    if (currentAssistantMessage) {
                        updatePendingMessageId(currentAssistantMessage.id, message.messageId, msgIndex);
                        currentAssistantMessage = {
                            ...currentAssistantMessage,
                            id: message.messageId,
                            messageIndex: msgIndex,
                            text: currentAssistantMessage.text === 'Thinking...'
                                ? (text || 'Thinking...')
                                : currentAssistantMessage.text || text
                        };
                        updatePendingMessage(currentAssistantMessage);
                    } else {
                        currentAssistantMessage = {
                            id: message.messageId,
                            role: 'assistant',
                            text: text || pendingAssistantText,
                            messageIndex: msgIndex
                        };
                        pendingMessages = [...pendingMessages, currentAssistantMessage];
                    }
                    if (pendingAssistantText) {
                        currentAssistantMessage.text = pendingAssistantText;
                        updatePendingMessage(currentAssistantMessage);
                        pendingAssistantText = '';
                    }
                    renderSessionMessages(pendingMessages);
                }
                break;
            case 'messageAppend':
                if (message.message && message.message.id) {
                    if (!pendingMessages.some((item) => item.id === message.message.id)) {
                        // Ensure message has messageIndex (defensive)
                        const messageWithIndex = typeof message.message.messageIndex === 'number'
                            ? message.message
                            : { ...message.message, messageIndex: getNextMessageIndex() };
                        pendingMessages = [...pendingMessages, messageWithIndex];
                        renderSessionMessages(pendingMessages);
                    }
                }
                break;
            case 'attachmentAdded':
                attachments.push({
                    id: message.id,
                    name: message.name,
                    filePath: message.filePath,
                    dataUrl: message.dataUrl,
                    mime: message.mime
                });
                renderAttachments();
                break;
            case 'attachmentError':
                addMessage(message.value || 'Failed to attach image.', 'bot', undefined, true);
                break;
            case 'chatChunk':
                if (currentAssistantMessage) {
                    if (currentAssistantMessage.text === 'Thinking...') {
                        currentAssistantMessage.text = message.value;
                    } else {
                        currentAssistantMessage.text += message.value;
                    }
                    updatePendingMessage(currentAssistantMessage);
                } else {
                    // Defensive fallback: create assistant message if none exists
                    const fallbackId = `internal-assistant-${Date.now()}-${messageCounter++}`;
                    const fallbackMessage = {
                        id: fallbackId,
                        role: 'assistant',
                        text: message.value,
                        messageIndex: Number.isFinite(message.messageIndex) ? message.messageIndex : getNextMessageIndex()
                    };
                    pendingMessages = [...pendingMessages, fallbackMessage];
                    currentAssistantMessage = fallbackMessage;
                }
                renderSessionMessages(pendingMessages);
                break;
            case 'permissionPrompt':
                addSystemMessage(`Permission required. Check OpenCode output: ${message.value}`);
                break;
            case 'diffChunk':
                addDiffMessage(message.value || '');
                break;
            case 'chatDone':
                if (currentAssistantMessage) {
                    updatePendingMessage(currentAssistantMessage);
                }
                isStreaming = false;
                currentAssistantMessage = null;
                pendingAssistantText = '';
                renderSessionMessages(pendingMessages);
                setBusy(false);
                break;
            case 'addResponse':
                if (currentAssistantMessage && message.value) {
                    currentAssistantMessage.text = message.value;
                    updatePendingMessage(currentAssistantMessage);
                } else if (message.value) {
                    const fallbackId = message.messageId || `internal-assistant-${Date.now()}-${messageCounter++}`;
                    const fallbackMessage = {
                        id: fallbackId,
                        role: 'assistant',
                        text: message.value,
                        messageIndex: Number.isFinite(message.messageIndex) ? message.messageIndex : getNextMessageIndex()
                    };
                    pendingMessages = [...pendingMessages, fallbackMessage];
                }
                isStreaming = false;
                currentAssistantMessage = null;
                pendingAssistantText = '';
                renderSessionMessages(pendingMessages);
                chatContainer.scrollTop = chatContainer.scrollHeight;
                setBusy(false);
                break;
            case 'revertedSegment':
                if (revertedSegmentState?.isActive
                    && typeof revertedSegmentState.startMessageIndex === 'number'
                    && typeof revertedSegmentState.endMessageIndex === 'number') {
                    if (!message.segment
                        || revertedSegmentState.startMessageIndex !== message.segment.startMessageIndex
                        || revertedSegmentState.endMessageIndex !== message.segment.endMessageIndex) {
                        hiddenRanges.push({
                            start: revertedSegmentState.startMessageIndex,
                            end: revertedSegmentState.endMessageIndex
                        });
                    }
                }
                revertedSegmentState = message.segment || null;
                if (revertedSegmentState) {
                    const withIndex = pendingMessages.filter((item) => typeof item.messageIndex === 'number');
                    const indices = withIndex.map((item) => item.messageIndex);
                    const minIndex = indices.length ? Math.min(...indices) : undefined;
                    const maxIndex = indices.length ? Math.max(...indices) : undefined;
                    const diag = {
                        startIndex: revertedSegmentState.startMessageIndex,
                        endIndex: revertedSegmentState.endMessageIndex,
                        collapsed: revertedSegmentState.collapsed,
                        withIndex: withIndex.length,
                        withoutIndex: pendingMessages.length - withIndex.length,
                        minIndex,
                        maxIndex,
                        sampleIndices: indices.slice(0, 10)
                    };
                    console.log('[UndoDiag] revertedSegment', diag);
                    vscode.postMessage({ type: 'undoDiag', phase: 'revertedSegment', diag });
                } else {
                    console.log('[UndoDiag] revertedSegment missing');
                    vscode.postMessage({ type: 'undoDiag', phase: 'revertedSegment', diag: null });
                }
                expandCollapsedMessages();
                renderSessionMessages(pendingMessages);
                break;
            case 'revertedSegmentCleared':
                revertedSegmentState = message.segment || null;
                console.log('[UndoDiag] revertedSegmentCleared', revertedSegmentState || null);
                vscode.postMessage({ type: 'undoDiag', phase: 'revertedSegmentCleared', diag: revertedSegmentState || null });
                hiddenRanges = [];
                expandCollapsedMessages();
                renderSessionMessages(pendingMessages);
                break;
            case 'revertedSegmentDiscarded':
                revertedSegmentState = message.segment || null;
                console.log('[UndoDiag] revertedSegmentDiscarded', revertedSegmentState || null);
                vscode.postMessage({ type: 'undoDiag', phase: 'revertedSegmentDiscarded', diag: revertedSegmentState || null });
                expandCollapsedMessages();
                renderSessionMessages(pendingMessages);
                break;
            case 'revertedSegmentState':
                revertedSegmentState = message.segment || null;
                console.log('[UndoDiag] revertedSegmentState', revertedSegmentState || null);
                vscode.postMessage({ type: 'undoDiag', phase: 'revertedSegmentState', diag: revertedSegmentState || null });
                renderSessionMessages(pendingMessages);
                break;
            case 'newSession':
                currentSessionId = message.sessionId || '';
                sessionTitle.textContent = 'OpenCode: Chat';
                resetUiState();
                hiddenRanges = [];
                setDefaultGreeting();
                break;
            case 'resetUiState':
                resetUiState();
                hiddenRanges = [];
                break;
            case 'error':
                addMessage(message.value || 'An error occurred.', 'bot', undefined, true);
                setBusy(false);
                break;
        }
    });

    function addDiffMessage(text) {
        const div = document.createElement('div');
        div.className = 'message diff';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = text;
        pre.appendChild(code);
        div.appendChild(pre);
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return div;
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
    }

    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'message system';
        div.textContent = text;
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return div;
    }

    function addMessage(text, type, messageId, renderMarkdown, disableActions, images) {
        const shouldRenderMarkdown = renderMarkdown === true || type === 'bot';

        const div = document.createElement('div');
        const isUser = type === 'user';
        div.className = `message ${isUser ? 'user' : 'bot'}`;
        if (text === 'Thinking...') {
            div.classList.add('thinking');
        }
        if (messageId) {
            div.dataset.messageId = messageId;
        }

        const content = document.createElement('div');
        content.className = 'message-content';
        if (shouldRenderMarkdown) {
            renderMarkdownInto(content, text);
        } else {
            content.textContent = text;
        }
        div.appendChild(content);

        if (Array.isArray(images) && images.length) {
            const imageWrap = document.createElement('div');
            imageWrap.className = 'message-images';
            for (const src of images) {
                if (typeof src !== 'string' || !src.length) continue;
                const img = document.createElement('img');
                img.src = src;
                img.alt = 'Attachment';
                img.loading = 'lazy';
                imageWrap.appendChild(img);
            }
            div.appendChild(imageWrap);
        }

        if (isUser && !disableActions) {
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const undoBtn = document.createElement('button');
            undoBtn.className = 'undo-btn';
            undoBtn.type = 'button';
            undoBtn.title = 'Undo to this message';
            undoBtn.textContent = '⟲';
            undoBtn.addEventListener('click', () => {
                if (isBusy) return;
                const id = div.dataset.messageId;
                if (!id) return;
                lastUndoTargetEl = div;
                vscode.postMessage({ type: 'undoToMessage', messageId: id });
            });
            actions.appendChild(undoBtn);
            div.appendChild(actions);
        }

        chatContainer.appendChild(div);
        if (messageId) {
            messageElements.set(messageId, div);
        }
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return div;
    }

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
        const model = models.find((item) => item.fullId === selectedModel);
        const variants = model && Array.isArray(model.variants) ? model.variants : [];
        variantSelect.innerHTML = '';

        if (variants.length === 0) {
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
            selectedVariant = variants[0];
            variantSelect.value = selectedVariant;
            vscode.postMessage({ type: 'setVariant', value: selectedVariant });
        }
        renderVariantSelect();
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
        for (const session of sessions) {
            const item = document.createElement('button');
            item.className = 'session-item';
            item.type = 'button';
            item.innerHTML = `
                <span class="session-item-title">${session.title}</span>
                <span class="session-item-meta">${session.updated}</span>
            `;
            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectSession', sessionId: session.id });
            });
            sessionList.appendChild(item);
        }
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

    function renderSessionMessages(messages) {
        chatContainer.innerHTML = '';
        if (!messages.length) {
            setDefaultGreeting();
            return;
        }
        clearRevertedSegment();

        const messagesToRender = messages.slice();
        const withIndex = messagesToRender.filter((item) => typeof item.messageIndex === 'number');
        const withoutIndex = messagesToRender.filter((item) => typeof item.messageIndex !== 'number');
        withIndex.sort((a, b) => (a.messageIndex || 0) - (b.messageIndex || 0));
        const ordered = [...withIndex, ...withoutIndex];
        const visibleOrdered = ordered.filter((item) => !isHiddenIndex(item.messageIndex));

        const segment = revertedSegmentState && revertedSegmentState.isActive ? revertedSegmentState : null;
        if (!segment) {
            for (const message of visibleOrdered) {
                addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
            }
            return;
        }

        const messageIdSet = Array.isArray(segment.messageIds)
            ? new Set(segment.messageIds)
            : null;
        const expectedCount = messageIdSet ? messageIdSet.size : undefined;
        const segmentMessages = messageIdSet
            ? visibleOrdered.filter((item) => item.id && messageIdSet.has(item.id))
            : visibleOrdered.filter((item) =>
                typeof item.messageIndex === 'number'
                && item.messageIndex >= segment.startMessageIndex
                && item.messageIndex <= segment.endMessageIndex
            );
        const segmentCount = segmentMessages.length;
        const missingCount = typeof expectedCount === 'number'
            ? Math.max(expectedCount - segmentCount, 0)
            : 0;
        const missingHint = missingCount > 0
            ? (segmentCount === 0 ? 'Messages are no longer available.' : 'Some messages are no longer available.')
            : '';

        if (segmentCount === 0) {
            console.warn('[RevertedSegment] No messages found in segment', {
                startIndex: segment.startMessageIndex,
                endIndex: segment.endMessageIndex,
                messageCount: messages.length,
                expectedCount,
                hasSyntheticIds: messages.some((item) => (item.id || '').startsWith('internal:'))
            });
            const displayCount = typeof expectedCount === 'number' ? expectedCount : withIndex.length;
            if (withIndex.length || expectedCount) {
                renderCollapsedSegment(displayCount, [], segment.collapsed, missingHint || 'Messages are no longer available.');
                for (const message of withoutIndex) {
                    addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
                }
            } else {
                for (const message of visibleOrdered) {
                    addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
                }
            }
            return;
        }

        if (messageIdSet) {
            let segmentInserted = false;
            for (const message of visibleOrdered) {
                const inSegment = Boolean(message.id && messageIdSet.has(message.id));
                if (inSegment) {
                    if (!segmentInserted) {
                        renderCollapsedSegment(segmentCount, segmentMessages, segment.collapsed, missingHint);
                        segmentInserted = true;
                    }
                    continue;
                }
                addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
            }
            if (!segmentInserted) {
                renderCollapsedSegment(segmentCount, segmentMessages, segment.collapsed, missingHint);
            }
            return;
        }

        let segmentInserted = false;
        for (const message of visibleOrdered) {
            if (typeof message.messageIndex !== 'number') {
                addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
                continue;
            }
            if (message.messageIndex < segment.startMessageIndex) {
                addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
                continue;
            }
            if (message.messageIndex > segment.endMessageIndex) {
                if (!segmentInserted) {
                    renderCollapsedSegment(segmentCount, segmentMessages, segment.collapsed);
                    segmentInserted = true;
                }
                addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id, undefined, undefined, message.images);
            }
        }
        if (!segmentInserted) {
            renderCollapsedSegment(segmentCount, segmentMessages, segment.collapsed);
        }
    }

    let revertedSegmentEl = null;


    function renderCollapsedSegment(count, messages = [], collapsed = true, hintText = '') {
        const container = document.createElement('div');
        container.className = 'reverted-segment';
        if (revertedSegmentState?.discarded) {
            container.classList.add('is-discarded');
        }

        const header = document.createElement('div');
        header.className = 'reverted-segment-header';

        const title = document.createElement('span');
        title.className = 'reverted-segment-title';
        title.textContent = `Reverted segment (${count} messages)`;

        const actions = document.createElement('div');
        actions.className = 'reverted-segment-actions';

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'reverted-segment-btn';
        restoreBtn.textContent = 'Restore all';
        restoreBtn.disabled = Boolean(revertedSegmentState?.discarded);
        restoreBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'restoreAll' });
        });

        actions.appendChild(restoreBtn);

        if (!revertedSegmentState?.discarded) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'reverted-segment-btn secondary';
            toggleBtn.textContent = collapsed ? 'Expand' : 'Collapse';
            toggleBtn.addEventListener('click', () => {
                const nextCollapsed = !collapsed;
                vscode.postMessage({ type: 'setRevertedSegmentCollapsed', collapsed: nextCollapsed });
            });
            actions.appendChild(toggleBtn);
        }

        header.appendChild(title);
        header.appendChild(actions);
        container.appendChild(header);

        if (!revertedSegmentState?.discarded) {
            const hint = document.createElement('div');
            hint.className = 'reverted-segment-hint';
            hint.textContent = 'You are allowed to restore this segment until the next build prompt.';
            container.appendChild(hint);
        }
        if (hintText) {
            const partial = document.createElement('div');
            partial.className = 'reverted-segment-hint';
            partial.textContent = hintText;
            container.appendChild(partial);
        }

        if (!collapsed && messages.length) {
            const body = document.createElement('div');
            body.className = 'reverted-segment-body';
            for (const message of messages) {
                const entry = document.createElement('div');
                entry.className = `message ${message.role === 'user' ? 'user' : 'bot'} in-segment`;
                if (message.text === 'Thinking...') {
                    entry.classList.add('thinking');
                }
                if (message.id) {
                    entry.dataset.messageId = message.id;
                }
                const content = document.createElement('div');
                content.className = 'message-content';
                if (message.role === 'assistant') {
                    renderMarkdownInto(content, message.text || '');
                } else {
                    content.textContent = message.text || '';
                }
                entry.appendChild(content);
                body.appendChild(entry);
            }
            container.appendChild(body);
        }

        chatContainer.appendChild(container);
        revertedSegmentEl = container;
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function clearRevertedSegment() {
        if (revertedSegmentEl && revertedSegmentEl.parentElement) {
            revertedSegmentEl.parentElement.removeChild(revertedSegmentEl);
        }
        revertedSegmentEl = null;
    }

    function isHiddenIndex(index) {
        if (typeof index !== 'number') return false;
        return hiddenRanges.some((range) => index >= range.start && index <= range.end);
    }

    function expandCollapsedMessages() {
        lastUndoTargetEl = null;
    }

    function setDefaultGreeting() {
        chatContainer.innerHTML = '';
        addMessage('Hello! I am OpenCode. How can I help you today?', 'bot');
    }

    function updatePendingMessage(message) {
        if (!message || !message.id) return;
        const index = pendingMessages.findIndex((item) => item.id === message.id);
        if (index === -1) return;
        pendingMessages[index] = { ...pendingMessages[index], text: message.text };
    }

    function updatePendingMessageId(oldId, newId, messageIndex) {
        if (!oldId || !newId || oldId === newId) return;
        const index = pendingMessages.findIndex((item) => item.id === oldId);
        if (index === -1) return;
        pendingMessages[index] = { ...pendingMessages[index], id: newId, messageIndex };
    }

    function getNextMessageIndex() {
        const indices = pendingMessages
            .map((item) => item.messageIndex)
            .filter((value) => typeof value === 'number');
        if (!indices.length) return 0;
        return Math.max(...indices) + 1;
    }

    function resetUiState() {
        messageElements.clear();
        pendingMessages = [];
        pendingUserMessage = null;
        revertedSegmentState = null;
        currentAssistantMessage = null;
        isStreaming = false;
        lastUndoTargetEl = null;
        pendingAssistantText = '';
    }

    function openSessionPanel() {
        sessionPanel.classList.remove('hidden');
        panelBackdrop.classList.remove('hidden');
    }

    function closeSessionPanel() {
        sessionPanel.classList.add('hidden');
        panelBackdrop.classList.add('hidden');
    }



    function handlePaste(event) {
        const clipboard = event.clipboardData;
        if (!clipboard || !clipboard.items) return;
        const items = Array.from(clipboard.items);
        const images = items.filter((item) => item.type && item.type.startsWith('image/'));
        if (!images.length) return;
        event.preventDefault();

        for (const item of images) {
            const file = item.getAsFile();
            if (!file) continue;
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                if (typeof dataUrl !== 'string') return;
                vscode.postMessage({ type: 'clipboardImage', dataUrl, mime: file.type });
            };
            reader.readAsDataURL(file);
        }
    }

    function renderAttachments() {
        attachmentList.innerHTML = '';
        if (!attachments.length) return;
        for (const item of attachments) {
            const container = document.createElement('div');
            container.className = 'attachment-item';

            const thumb = document.createElement('img');
            thumb.className = 'attachment-thumb';
            thumb.src = item.dataUrl;
            thumb.alt = item.name;

            const label = document.createElement('span');
            label.textContent = item.name;

            const remove = document.createElement('button');
            remove.className = 'attachment-remove';
            remove.type = 'button';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                attachments = attachments.filter((entry) => entry.id !== item.id);
                renderAttachments();
            });

            container.appendChild(thumb);
            container.appendChild(label);
            container.appendChild(remove);
            attachmentList.appendChild(container);
        }
    }
    function setBusy(state) {
        isBusy = state;
        sendBtn.disabled = false;
        input.disabled = state;
        if (state) {
            sendBtn.classList.add('is-busy');
            sendBtn.innerHTML = stopIcon;
        } else {
            sendBtn.classList.remove('is-busy');
            sendBtn.innerHTML = sendIcon;
        }
    }
});
