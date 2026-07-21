import type { ModelInfo, OpenCodeClient } from '../OpenCodeClient';
import {
    buildSmartSearchCandidateCorpus,
    parseSmartSearchExpansion,
    recallSmartSearchCandidates
} from '../smartSearchRetrieval';
import {
    buildSmartSearchExpansionPrompt,
    buildSmartSearchRerankPrompt,
    isEffectiveSmartSearchTool,
    isExplicitEmptySmartSearchResult,
    parseSmartSearchMessageIds,
    summarizeSmartSearchToolInput
} from './SmartSearchProtocol';
import type { SmartSearchSessionRegistry } from './SmartSearchSessionRegistry';

export type SmartSearchMessage = {
    id: string;
    role: string;
    text: string;
};

export type SmartSearchResult = {
    messageIds: string[];
    modelId: string;
};

export class SmartSearchService {
    constructor(private readonly options: {
        client: OpenCodeClient;
        sessions: SmartSearchSessionRegistry;
        getCachedModels(): ModelInfo[];
        setCachedModels(models: ModelInfo[]): void;
        getSelectedModel(): string | undefined;
        log(message: string): void;
    }) {}

    private async pickModel(): Promise<ModelInfo | undefined> {
        let models = this.options.getCachedModels();
        if (!Array.isArray(models) || !models.length) {
            try {
                models = await this.options.client.listModels();
                if (models.length) this.options.setCachedModels(models);
            } catch (error) {
                this.options.log(`EXT: smartSearch.models.fail | err=${String(error)}`);
                models = [];
            }
        }
        const selectedModel = this.options.getSelectedModel();
        const preferred = this.options.client.pickFreeModel(models, selectedModel);
        if (preferred?.fullId === selectedModel) return preferred;
        const freeModels = models.filter((candidate) =>
            this.options.client.pickFreeModel(models, candidate.fullId)?.fullId === candidate.fullId
        );
        return freeModels
            .sort((left, right) => (right.contextLimit || 0) - (left.contextLimit || 0))[0]
            || preferred
            || undefined;
    }

    private async executeAgentAttempt(
        model: ModelInfo,
        prompt: string,
        attempt: number,
        stage = 'rerank',
        timeoutMs = 90000
    ): Promise<{ assistantText: string; effectiveToolCalls: number }> {
        const tempSession = await this.options.client.createSession();
        const tempSessionId = tempSession.id;
        await this.options.sessions.track(tempSessionId);
        let assistantText = '';
        let searchError = '';
        const effectiveTools = new Set<string>();
        try {
            const tempLocalKey = `smart-search-${Date.now()}-${attempt}`;
            this.options.client.startTurnWithOp(tempSessionId, tempLocalKey, tempLocalKey);
            const task = this.options.client.chat(
                prompt,
                { model: model.fullId, sessionId: tempSessionId, mode: 'plan' },
                (event) => {
                    if (event.sessionId !== tempSessionId) return;
                    if (event.type === 'text' && typeof event.text === 'string') {
                        assistantText += event.text;
                        return;
                    }
                    if (event.type === 'error') {
                        searchError = event.text || 'Unknown Smart Search session error';
                        return;
                    }
                    if (event.type !== 'tool' || !event.tool) return;
                    const status = event.toolState?.status || 'unknown';
                    const inputSummary = summarizeSmartSearchToolInput(event.toolState?.input);
                    const outputSize = typeof event.toolState?.output === 'string' ? event.toolState.output.length : 0;
                    this.options.log(
                        `EXT: smartSearch.tool | stage=${stage} | attempt=${attempt} | sessionId=${tempSessionId} | tool=${event.tool} | status=${status} | input=${inputSummary || 'none'} | outputChars=${outputSize}`
                    );
                    if (status === 'completed' && isEffectiveSmartSearchTool(event.tool, event.toolState?.input)) {
                        effectiveTools.add(`${event.tool}|${inputSummary}`);
                    }
                }
            );
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    task,
                    new Promise((_, reject) => {
                        timeoutHandle = setTimeout(() => reject(new Error(`Smart search ${stage} timed out.`)), timeoutMs);
                    })
                ]);
            } finally {
                if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            }
            if (searchError) throw new Error(`Smart Search model session failed: ${searchError}`);
            if (!assistantText.trim()) {
                const exported = await this.options.client.listSessionMessages(tempSessionId);
                const assistant = [...exported].reverse().find((item: any) => item?.role === 'assistant');
                assistantText = typeof assistant?.text === 'string'
                    ? assistant.text
                    : Array.isArray(assistant?.parts)
                        ? assistant.parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n')
                        : '';
            }
            const rawSummary = assistantText.replace(/\s+/g, ' ').slice(-1200);
            this.options.log(
                `EXT: smartSearch.agent.output | stage=${stage} | attempt=${attempt} | sessionId=${tempSessionId} | effectiveTools=${effectiveTools.size} | chars=${assistantText.length} | raw=${rawSummary || 'empty'}`
            );
            return { assistantText, effectiveToolCalls: effectiveTools.size };
        } catch (error) {
            try {
                await this.options.client.abortSession(tempSessionId);
            } catch {
                // Best effort cleanup before deleting the temporary session.
            }
            throw error;
        } finally {
            this.options.client.finishTurn(tempSessionId);
            let deleted = false;
            try {
                await this.options.client.deleteSession(tempSessionId);
                deleted = true;
            } catch (error) {
                this.options.log(`EXT: smartSearch.cleanup.fail | sessionId=${tempSessionId} | err=${String(error)}`);
            } finally {
                if (deleted) await this.options.sessions.release(tempSessionId);
            }
        }
    }

    public async run(sessionId: string, query: string, messages: SmartSearchMessage[]): Promise<SmartSearchResult> {
        const validIds = new Set(messages.map((item) => item.id).filter((id) => typeof id === 'string' && id.length > 0));
        if (!query.trim() || !validIds.size) return { messageIds: [], modelId: '' };
        const model = await this.pickModel();
        if (!model) throw new Error('Smart search requires an available free model.');
        let expansion = parseSmartSearchExpansion('', query.trim());
        try {
            const expansionResult = await this.executeAgentAttempt(
                model,
                buildSmartSearchExpansionPrompt(query.trim()),
                1,
                'expand',
                45000
            );
            expansion = parseSmartSearchExpansion(expansionResult.assistantText, query.trim());
        } catch (error) {
            this.options.log(`EXT: smartSearch.expansion.fallback | err=${String(error)}`);
        }
        const recall = recallSmartSearchCandidates(messages, expansion, 32);
        const candidateCorpus = buildSmartSearchCandidateCorpus(messages, recall.candidates, 2);
        const candidateIds = new Set<string>();
        for (const row of recall.candidates) {
            for (let index = Math.max(0, row.index - 2); index <= Math.min(messages.length - 1, row.index + 2); index += 1) {
                if (messages[index]?.id) candidateIds.add(messages[index].id);
            }
        }
        const signalSummary = [...expansion.phrases, ...expansion.terms].slice(0, 28).join(' | ');
        const basePrompt = buildSmartSearchRerankPrompt(query.trim(), candidateCorpus, recall.lowConfidence, signalSummary);
        this.options.log(
            `EXT: smartSearch.agent.start | sessionId=${sessionId || 'null'} | model=${model.fullId} | locatorCount=${validIds.size} | candidates=${recall.candidates.length} | candidateIds=${candidateIds.size} | positive=${recall.positiveCount} | lowConfidence=${String(recall.lowConfidence)} | embeddedChars=${candidateCorpus.length}`
        );
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const prompt = attempt === 1
                ? basePrompt
                : `${basePrompt}\n\nRETRY REQUIREMENT: Your previous answer contained no valid result id. Copy ids exactly from the embedded context. Do not describe or simulate tool calls.`;
            try {
                const result = await this.executeAgentAttempt(model, prompt, attempt, 'rerank');
                const messageIds = parseSmartSearchMessageIds(result.assistantText, candidateIds);
                this.options.log(
                    `EXT: smartSearch.result | attempt=${attempt} | accepted=${messageIds.length} | ids=${messageIds.join(',') || 'none'}`
                );
                if (messageIds.length) return { messageIds, modelId: model.fullId };
                if (isExplicitEmptySmartSearchResult(result.assistantText)) {
                    this.options.log(`EXT: smartSearch.empty | attempt=${attempt} | reason=explicit-model-result`);
                    return { messageIds: [], modelId: model.fullId };
                }
                lastError = new Error('Smart Search model returned no valid embedded message id.');
                this.options.log(`EXT: smartSearch.retry | attempt=${attempt} | reason=no-valid-message-id`);
            } catch (error) {
                lastError = error;
                this.options.log(`EXT: smartSearch.retry | attempt=${attempt} | reason=agent-error | err=${String(error)}`);
            }
        }
        const fallbackIds = recall.candidates
            .filter((candidate) => candidate.score > 0)
            .slice(0, 8)
            .map((candidate) => candidate.id);
        if (fallbackIds.length) {
            this.options.log(
                `EXT: smartSearch.fallback | reason=model-invalid | results=${fallbackIds.length} | ids=${fallbackIds.join(',')}`
            );
            return { messageIds: fallbackIds, modelId: model.fullId };
        }
        throw lastError instanceof Error ? lastError : new Error('Smart Search failed after retry.');
    }
}
