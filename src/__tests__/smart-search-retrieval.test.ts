import {
    buildSmartSearchCandidateCorpus,
    deriveSmartSearchSignals,
    parseSmartSearchExpansion,
    recallSmartSearchCandidates,
    SmartSearchRetrievalMessage
} from '../smartSearchRetrieval';

function messages(texts: string[]): SmartSearchRetrievalMessage[] {
    return texts.map((text, index) => ({ id: `msg-${index}`, role: index % 2 ? 'assistant' : 'user', text }));
}

describe('Smart Search staged retrieval', () => {
    test('extracts local signals from a long Chinese description', () => {
        const result = deriveSmartSearchSignals('我记得之前讨论过重置以后本地历史还在，但是界面上看不到，需要重新同步的问题');
        expect(result.phrases.length).toBeGreaterThan(0);
        expect(result.terms).toContain('重置');
        expect(result.terms).toContain('历史');
    });

    test('combines model paraphrases with local fallback signals', () => {
        const result = parseSmartSearchExpansion(
            '{"phrases":["history missing after reset"],"terms":["snapshot","重新同步"]}',
            '重置以后历史看不到'
        );
        expect(result.phrases).toContain('history missing after reset');
        expect(result.terms).toEqual(expect.arrayContaining(['snapshot', '重新同步', '重置']));
    });

    test('ranks rare multi-word signals above generic matches', () => {
        const corpus = messages([
            '历史记录正常加载',
            '我们继续检查历史记录',
            'reset 后 snapshot continuity 导致 history missing',
            '历史记录很多，需要虚拟滚动'
        ]);
        const recall = recallSmartSearchCandidates(corpus, {
            phrases: ['history missing after reset'],
            terms: ['历史记录', 'reset', 'snapshot', 'history missing']
        }, 4);
        expect(recall.candidates[0].id).toBe('msg-2');
        expect(recall.positiveCount).toBeGreaterThan(0);
    });

    test('never returns an empty candidate set when lexical wording does not overlap', () => {
        const corpus = messages(Array.from({ length: 20 }, (_, index) => `unrelated conversation ${index}`));
        const recall = recallSmartSearchCandidates(corpus, { phrases: ['完全不同的说法'], terms: ['无命中词'] }, 8);
        expect(recall.candidates).toHaveLength(8);
        expect(recall.positiveCount).toBe(0);
        expect(recall.lowConfidence).toBe(true);
        expect(new Set(recall.candidates.map((item) => item.index)).size).toBe(8);
    });

    test('candidate corpus includes neighboring messages for semantic reranking', () => {
        const corpus = messages(['before two', 'before one', 'matching message', 'after one', 'after two']);
        const output = buildSmartSearchCandidateCorpus(corpus, [{
            index: 2,
            id: 'msg-2',
            score: 10,
            matchedSignals: ['matching']
        }], 2);
        const row = JSON.parse(output);
        expect(row.candidateId).toBe('msg-2');
        expect(row.context.map((item: any) => item.id)).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
    });
});
