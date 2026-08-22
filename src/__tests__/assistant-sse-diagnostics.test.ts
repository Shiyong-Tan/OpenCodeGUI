import { AssistantSseDiagnostics } from '../diagnostics/AssistantSseDiagnostics';
import * as fs from 'fs';
import * as path from 'path';

describe('AssistantSseDiagnostics', () => {
    test('OpenCodeClient routes assistant SSE through bounded diagnostics', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'OpenCodeClient.ts'), 'utf8');

        expect(source).toContain('this.assistantSseDiagnostics.summarize(type, props, payload.length)');
        expect(source).not.toContain('`[SSE_ASSIST] ${payload}`');
    });

    test('summarizes text events without logging their content', () => {
        const diagnostics = new AssistantSseDiagnostics();
        const sensitiveText = 'secret assistant content';
        const line = diagnostics.summarize('message.part.updated', {
            sessionID: 'ses-a',
            part: {
                id: 'prt-a',
                messageID: 'msg-a',
                sessionID: 'ses-a',
                type: 'text',
                text: sensitiveText,
                metadata: { openai: { phase: 'commentary' } },
            },
        }, 4200);

        expect(line).toContain('[SSE_ASSIST_SUMMARY]');
        expect(line).toContain('sessionId=ses-a');
        expect(line).toContain(`textChars=${sensitiveText.length}`);
        expect(line).not.toContain(sensitiveText);
    });

    test('coalesces repeated streaming updates within the same size bucket', () => {
        const diagnostics = new AssistantSseDiagnostics();
        const event = (text: string) => diagnostics.summarize('message.part.updated', {
            part: {
                id: 'prt-a',
                messageID: 'msg-a',
                sessionID: 'ses-a',
                type: 'text',
                text,
                metadata: { openai: { phase: 'commentary' } },
            },
        }, text.length + 100);

        expect(event('a')).toBeDefined();
        expect(event('ab')).toBeUndefined();
        expect(event('x'.repeat(4096))).toContain('textChars=4096');
    });

    test('logs tool status transitions and suppresses repeated large output updates', () => {
        const diagnostics = new AssistantSseDiagnostics();
        const event = (status: string, output: string) => diagnostics.summarize(
            'message.part.updated',
            {
                part: {
                    id: 'prt-tool',
                    messageID: 'msg-a',
                    sessionID: 'ses-a',
                    type: 'tool',
                    tool: 'read',
                    state: { status, output },
                },
            },
            output.length + 200
        );

        expect(event('running', '')).toContain('status=running');
        expect(event('running', 'private output')).toBeUndefined();
        const completed = event('completed', 'private output');
        expect(completed).toContain('status=completed');
        expect(completed).toContain('suppressed=1');
        expect(completed).not.toContain('private output');
    });

    test('emits terminal assistant identity and rolls up suppressed part updates', () => {
        const diagnostics = new AssistantSseDiagnostics();
        const part = {
            part: {
                id: 'prt-a',
                messageID: 'msg-a',
                sessionID: 'ses-a',
                type: 'text',
                text: 'a',
            },
        };
        diagnostics.summarize('message.part.updated', part, 200);
        diagnostics.summarize('message.part.updated', part, 200);

        const terminal = diagnostics.summarize('message.updated', {
            sessionID: 'ses-a',
            info: {
                id: 'msg-a',
                sessionID: 'ses-a',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 1234 },
            },
        }, 500);

        expect(terminal).toContain('terminal=true');
        expect(terminal).toContain('finish=stop');
        expect(terminal).toContain('suppressed=1');
    });
});
