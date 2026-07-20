export type SmartSearchRetrievalMessage = {
    id: string;
    role: string;
    text: string;
};

export type SmartSearchExpansion = {
    phrases: string[];
    terms: string[];
};

export type SmartSearchCandidate = {
    index: number;
    id: string;
    score: number;
    matchedSignals: string[];
};

export type SmartSearchRecall = {
    candidates: SmartSearchCandidate[];
    positiveCount: number;
    lowConfidence: boolean;
};

const MAX_SIGNALS = 40;

function normalize(value: string): string {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueSignals(values: string[], limit = MAX_SIGNALS): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const signal = normalize(value).replace(/^[\s,.;:!?，。；：！？、]+|[\s,.;:!?，。；：！？、]+$/g, '');
        if (signal.length < 2 || signal.length > 96 || seen.has(signal)) continue;
        seen.add(signal);
        result.push(signal);
        if (result.length >= limit) break;
    }
    return result;
}

export function deriveSmartSearchSignals(query: string): SmartSearchExpansion {
    const normalized = normalize(query);
    const pieces = normalized.split(/[\s,.;:!?，。；：！？、()[\]{}<>"'“”‘’/\\|]+/).filter(Boolean);
    const latin = normalized.match(/[a-z0-9_$@#./\\:-]{2,}/g) || [];
    const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
    const chineseNgrams: string[] = [];
    for (const run of chineseRuns) {
        if (run.length <= 8) {
            chineseNgrams.push(run);
            continue;
        }
        for (let index = 0; index < run.length - 1 && chineseNgrams.length < 24; index += 1) {
            chineseNgrams.push(run.slice(index, index + 2));
        }
    }
    const phrases = uniqueSignals([
        ...(normalized.length <= 96 ? [normalized] : []),
        ...pieces.filter((piece) => piece.length >= 4)
    ], 12);
    const terms = uniqueSignals([...pieces, ...latin, ...chineseRuns, ...chineseNgrams]);
    return { phrases, terms };
}

export function parseSmartSearchExpansion(text: string, query: string): SmartSearchExpansion {
    const fallback = deriveSmartSearchSignals(query);
    const raw = String(text || '').trim();
    const candidates = [
        raw,
        raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    ];
    const objectMatch = raw.match(/\{[\s\S]*?\}/);
    if (objectMatch) candidates.push(objectMatch[0]);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const phrases = Array.isArray(parsed?.phrases)
                ? parsed.phrases.filter((item: unknown): item is string => typeof item === 'string')
                : [];
            const terms = Array.isArray(parsed?.terms)
                ? parsed.terms.filter((item: unknown): item is string => typeof item === 'string')
                : [];
            if (phrases.length || terms.length) {
                return {
                    phrases: uniqueSignals([...phrases, ...fallback.phrases], 16),
                    terms: uniqueSignals([...terms, ...fallback.terms], MAX_SIGNALS)
                };
            }
        } catch {
            // Try another JSON-shaped portion before using local query signals.
        }
    }
    return fallback;
}

export function recallSmartSearchCandidates(
    messages: SmartSearchRetrievalMessage[],
    expansion: SmartSearchExpansion,
    limit = 40
): SmartSearchRecall {
    const phrases = uniqueSignals(expansion.phrases, 16);
    const terms = uniqueSignals(expansion.terms, MAX_SIGNALS)
        .filter((term) => !phrases.includes(term));
    const signals = [...phrases, ...terms];
    const normalizedMessages = messages.map((message) => normalize(message.text));
    const documentFrequency = new Map<string, number>();
    for (const signal of signals) {
        let count = 0;
        for (const text of normalizedMessages) {
            if (text.includes(signal)) count += 1;
        }
        documentFrequency.set(signal, count);
    }

    const scored: SmartSearchCandidate[] = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message?.id || !normalizedMessages[index]) continue;
        let score = 0;
        const matchedSignals: string[] = [];
        for (const signal of signals) {
            if (!normalizedMessages[index].includes(signal)) continue;
            const frequency = documentFrequency.get(signal) || 0;
            const rarity = Math.log((messages.length + 1) / (frequency + 1)) + 1;
            const lengthWeight = 1 + Math.min(signal.length, 16) / 8;
            const phraseWeight = phrases.includes(signal) ? 2.25 : 1;
            score += rarity * lengthWeight * phraseWeight;
            matchedSignals.push(signal);
        }
        if (score > 0) scored.push({ index, id: message.id, score, matchedSignals });
    }
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    const requestedLimit = Math.max(1, limit);
    const candidates = scored.slice(0, requestedLimit);
    const positiveCount = scored.length;
    const selectedIds = new Set(candidates.map((candidate) => candidate.id));
    const fillTarget = Math.min(requestedLimit, messages.filter((message) => Boolean(message?.id)).length);
    if (candidates.length < fillTarget && messages.length) {
        for (let sample = 0; candidates.length < fillTarget && sample < fillTarget; sample += 1) {
            const index = Math.min(messages.length - 1, Math.floor(sample * messages.length / fillTarget));
            const message = messages[index];
            if (!message?.id || selectedIds.has(message.id)) continue;
            selectedIds.add(message.id);
            candidates.push({ index, id: message.id, score: 0, matchedSignals: [] });
        }
        for (let index = 0; candidates.length < fillTarget && index < messages.length; index += 1) {
            const message = messages[index];
            if (!message?.id || selectedIds.has(message.id)) continue;
            selectedIds.add(message.id);
            candidates.push({ index, id: message.id, score: 0, matchedSignals: [] });
        }
    }
    const bestScore = candidates[0]?.score || 0;
    return {
        candidates,
        positiveCount,
        lowConfidence: positiveCount < 4 || bestScore < 4
    };
}

function clipContextText(text: string, focusSignals: string[] = []): string {
    const value = String(text || '');
    if (value.length <= 800) return value;
    const normalizedValue = value.normalize('NFKC').toLocaleLowerCase();
    const focusIndex = focusSignals
        .map((signal) => normalizedValue.indexOf(normalize(signal)))
        .find((index) => index >= 0);
    if (typeof focusIndex === 'number') {
        const start = Math.max(0, focusIndex - 320);
        const end = Math.min(value.length, start + 800);
        return `${start > 0 ? '[... clipped ...]\n' : ''}${value.slice(start, end)}${end < value.length ? '\n[... clipped ...]' : ''}`;
    }
    return `${value.slice(0, 480)}\n[... clipped ...]\n${value.slice(-220)}`;
}

export function buildSmartSearchCandidateCorpus(
    messages: SmartSearchRetrievalMessage[],
    candidates: SmartSearchCandidate[],
    radius = 2
): string {
    return candidates.map((candidate, candidateRank) => {
        const start = Math.max(0, candidate.index - radius);
        const end = Math.min(messages.length, candidate.index + radius + 1);
        return JSON.stringify({
            candidateRank: candidateRank + 1,
            candidateId: candidate.id,
            lexicalScore: Number(candidate.score.toFixed(3)),
            matchedSignals: candidate.matchedSignals,
            context: messages.slice(start, end).map((message, offset) => ({
                order: start + offset,
                id: message.id,
                role: message.role || 'unknown',
                text: clipContextText(message.text, start + offset === candidate.index ? candidate.matchedSignals : [])
            }))
        });
    }).join('\n');
}
