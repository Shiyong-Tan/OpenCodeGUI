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
    const redoBtn = document.getElementById('redo-btn');
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
        const attachmentNames = attachments.map((item) => item.name);
        const displayText = attachmentNames.length
            ? `${messageText}

[Attached: ${attachmentNames.join(', ')}]`
            : messageText;
        const clientMessageId = `local-${Date.now()}-${messageCounter++}`;
        addMessage(displayText, 'user', clientMessageId, false);
        const loadingMsg = addMessage('Thinking...', 'bot', undefined, false);
        loadingMsg.id = 'current-loading';
        setBusy(true);
        const attachmentPaths = attachments.map((item) => item.filePath);
        vscode.postMessage({ type: 'sendMessage', value: messageText, attachments: attachmentPaths, clientMessageId });
        attachments = [];
        renderAttachments();
        input.value = '';
    });

    input.addEventListener('paste', handlePaste);

    input.addEventListener('keydown', (e) => {
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

    redoBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'redoLast' });
    });

    newSessionBtn.addEventListener('click', () => {
        currentSessionId = '';
        sessionTitle.textContent = 'New Session';
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
        const now = new Date().toLocaleTimeString();
        console.log(`[${now}] Webview Received:`, message.type, message.value);

        let loading = document.getElementById('current-loading');

        switch (message.type) {
            case 'init':
                models = Array.isArray(message.models) ? message.models : [];
                sessions = Array.isArray(message.sessions) ? message.sessions : [];
                selectedModel = message.selectedModel || (models[0] ? models[0].fullId : '');
                selectedVariant = message.selectedVariant || '';
                selectedMode = message.selectedMode || 'build';
                currentSessionId = message.currentSessionId || '';
                modeSelect.value = selectedMode;
                applyModeStyles(selectedMode);
                vscode.postMessage({ type: 'setMode', value: selectedMode });
                renderModelSelect();
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
                sessionTitle.textContent = message.title || 'Session';
                attachments = [];
                renderAttachments();
                renderSessionMessages(message.messages || []);
                closeSessionPanel();
                break;
            case 'sessionId':
                currentSessionId = message.value || '';
                break;
            case 'messageIdMap':
                if (message.clientMessageId && message.messageId) {
                    const element = messageElements.get(message.clientMessageId);
                    if (element) {
                        element.dataset.messageId = message.messageId;
                        messageElements.delete(message.clientMessageId);
                        messageElements.set(message.messageId, element);
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
                if (!loading) {
                    loading = addMessage('', 'bot', undefined, false);
                    loading.id = 'current-loading';
                }
                const content = loading.querySelector('.message-content') || loading;
                if (loading.classList.contains('thinking') || content.textContent === 'Thinking...') {
                    content.textContent = '';
                    loading.classList.remove('thinking');
                }
                content.textContent += message.value;
                chatContainer.scrollTop = chatContainer.scrollHeight;
                break;
            case 'permissionPrompt':
                addSystemMessage(`Permission required. Check OpenCode output: ${message.value}`);
                break;
            case 'diffChunk':
                addDiffMessage(message.value || '');
                break;
            case 'chatDone':
                if (loading) {
                    loading.id = '';
                    loading.classList.remove('thinking');
                }
                setBusy(false);
                break;
            case 'addResponse':
                if (loading) {
                    const content = loading.querySelector('.message-content') || loading;
                    content.textContent = message.value;
                    loading.id = '';
                    loading.classList.remove('thinking');
                } else {
                    addMessage(message.value, 'bot', undefined, true);
                }
                chatContainer.scrollTop = chatContainer.scrollHeight;
                setBusy(false);
                break;
            case 'newSession':
                currentSessionId = '';
                sessionTitle.textContent = 'New Session';
                setDefaultGreeting();
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

    function addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'message system';
        div.textContent = text;
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        return div;
    }

    function addMessage(text, type, messageId, renderMarkdown) {
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

        if (isUser) {
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
        modelSelect.innerHTML = '';
        for (const model of models) {
            const option = document.createElement('option');
            option.value = model.fullId;
            option.textContent = model.name || model.fullId;
            if (model.fullId === selectedModel) {
                option.selected = true;
            }
            modelSelect.appendChild(option);
        }
        if (!selectedModel && models[0]) {
            selectedModel = models[0].fullId;
        }
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
        for (const message of messages) {
            addMessage(message.text, message.role === 'user' ? 'user' : 'bot', message.id);
        }
    }

    function setDefaultGreeting() {
        chatContainer.innerHTML = '';
        addMessage('Hello! I am OpenCode. How can I help you today?', 'bot');
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
