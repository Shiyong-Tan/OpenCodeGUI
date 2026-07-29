import * as fs from 'fs';
import * as path from 'path';

const source = fs.readFileSync(
    path.join(process.cwd(), 'media', 'main.js'),
    'utf8'
);

describe('rich assistant render pressure guards', () => {
    test('keeps the structural full-render safety guard', () => {
        expect(source).toContain("bailAssistantStreamingPatch('rich-content-unsafe'");
        expect(source).toContain('Array.isArray(message.meta?.subagents)');
        expect(source).toContain('Array.isArray(message.meta?.todos)');
    });

    test('stops after duplicate or directly patched status metadata', () => {
        expect(source).toContain("return { skipRender: true, reason: 'duplicate-status' }");
        expect(source).toContain("return { skipRender: true, reason: 'status-dom-patched' }");
        expect(source).toContain("return { skipRender: true, reason: 'duplicate-meta' }");
        expect(source).toContain(
            "if (!assistantMetaResult?.skipRender && !tryPatchAssistantStreamingBubble"
        );
    });

    test('deduplicates todo and subagent rich state before scheduling renders', () => {
        expect(source).toContain('function richContentStateFingerprint(value)');
        expect(source).toContain(
            'sess?.lastSubagentStatusFingerprint === subagentStatusFingerprint'
        );
        expect(source).toContain(
            'richContentStateFingerprint(msg.meta.todos || []) === richContentStateFingerprint(todos)'
        );
    });

    test('keeps the subagent fingerprint target in the case scope', () => {
        const caseStart = source.indexOf("case 'subagentStatus':");
        const caseEnd = source.indexOf("case 'backgroundActivityPulse':", caseStart);
        const block = source.slice(caseStart, caseEnd);
        const declaration = block.indexOf('const currentThinking =');
        const sessionMerge = block.indexOf('if (sess) {');
        const fingerprint = block.indexOf('targetId: currentThinking?.id || null');

        expect(caseStart).toBeGreaterThanOrEqual(0);
        expect(caseEnd).toBeGreaterThan(caseStart);
        expect(declaration).toBeGreaterThanOrEqual(0);
        expect(declaration).toBeLessThan(sessionMerge);
        expect(fingerprint).toBeGreaterThan(sessionMerge);
    });
});
