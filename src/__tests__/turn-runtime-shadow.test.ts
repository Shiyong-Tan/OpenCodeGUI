import {
    classifyTurnShadowDivergences,
    compareTurnShadowToLegacy,
    TurnRuntimeShadow,
} from '../session-runtime/turn/TurnRuntimeShadow';

describe('turn runtime shadow adapter', () => {
    test('keeps interleaved sessions independent', async () => {
        const shadow = new TurnRuntimeShadow();

        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        await shadow.observe({ type: 'text', sessionId: 'A', text: 'A1' });
        await shadow.observe({ type: 'turnInFlight', sessionId: 'B', inFlight: true });
        await shadow.observe({ type: 'text', sessionId: 'B', text: 'B1' });
        await shadow.observe({
            type: 'assistantMessageMeta',
            sessionId: 'A',
            assistantMsgId: 'msg_A',
            messageIndex: 10,
            lastText: 'A2',
        });

        expect(shadow.getSnapshot('A')).toMatchObject({
            generation: 1,
            phase: 'streaming',
            assistantText: 'A1A2',
            assistant: { canonicalId: 'msg_A', canonicalIndex: 10 },
        });
        expect(shadow.getSnapshot('B')).toMatchObject({
            generation: 1,
            phase: 'streaming',
            assistantText: 'B1',
        });
    });

    test('treats inFlight false as finalizing, not as an authoritative final', async () => {
        const shadow = new TurnRuntimeShadow();
        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        const observation = await shadow.observe({
            type: 'turnInFlight',
            sessionId: 'A',
            inFlight: false,
        });

        expect(observation).toMatchObject({
            observed: true,
            appliedTypes: ['turn-finalizing'],
            state: { phase: 'finalizing' },
        });
    });

    test('finalizes only with a canonical assistant and rejects delayed activity', async () => {
        const shadow = new TurnRuntimeShadow();
        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        await shadow.observe({
            type: 'assistantMessageMeta',
            sessionId: 'A',
            assistantMsgId: 'msg_A',
            lastText: 'answer',
        });
        const done = await shadow.observe({
            type: 'turnResolved',
            sessionId: 'A',
            assistantMsgId: 'msg_A',
        });
        await shadow.observe({ type: 'text', sessionId: 'A', text: 'late' });

        expect(done).toMatchObject({
            observed: true,
            state: { phase: 'finalized', assistantText: 'answer' },
        });
        expect(shadow.getSnapshot('A')).toMatchObject({
            phase: 'finalized',
            assistantText: 'answer',
        });
    });

    test('reports unresolved finalization instead of inventing canonical identity', async () => {
        const shadow = new TurnRuntimeShadow();
        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        const observation = await shadow.observe({ type: 'turnResolved', sessionId: 'A' });

        expect(observation).toMatchObject({
            observed: true,
            warnings: ['turn-resolved-without-canonical-assistant'],
            state: { phase: 'finalizing' },
        });
    });

    test('compares shadow facts without mutating either state', async () => {
        const shadow = new TurnRuntimeShadow();
        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        await shadow.observe({
            type: 'assistantMessageMeta',
            sessionId: 'A',
            assistantMsgId: 'msg_A',
            tmpKey: 'tmp:A',
            lastText: 'hello',
        });
        const state = shadow.getSnapshot('A')!;

        expect(compareTurnShadowToLegacy(state, {
            inFlight: true,
            assistantId: 'msg_other',
            temporaryAssistantId: 'tmp:A',
            bufferedText: 'hello',
        })).toEqual([{
            field: 'assistantId',
            shadow: 'msg_A',
            legacy: 'msg_other',
        }]);
        expect(shadow.getSnapshot('A')).toBe(state);
    });

    test('classifies the known legacy finalization gap separately', async () => {
        const shadow = new TurnRuntimeShadow();
        await shadow.observe({ type: 'turnInFlight', sessionId: 'A', inFlight: true });
        const observation = await shadow.observe({
            type: 'turnInFlight',
            sessionId: 'A',
            inFlight: false,
        });
        if (!observation.observed) throw new Error('expected observed turn event');

        expect(classifyTurnShadowDivergences(observation, {
            inFlight: false,
        })).toEqual([expect.objectContaining({
            field: 'inFlight',
            severity: 'explained',
            reason: 'legacy-clears-in-flight-before-authoritative-final',
        })]);
    });
});
