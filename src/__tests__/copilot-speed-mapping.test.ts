jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
    },
}), { virtual: true });

import { OpenCodeClient, ModelInfo } from '../OpenCodeClient';

describe('Copilot speed multiplier mapping', () => {
    it('keeps explicit matches and infers GPT/Opus fallback values for unmatched models', () => {
        const client = new OpenCodeClient() as any;
        const models: ModelInfo[] = [
            {
                id: 'gpt-4.1',
                providerId: 'github-copilot',
                name: 'GPT-4.1',
                fullId: 'github-copilot/gpt-4.1',
                variants: [],
            },
            {
                id: 'gpt-4.2',
                providerId: 'github-copilot',
                name: 'GPT-4.2',
                fullId: 'github-copilot/gpt-4.2',
                variants: [],
            },
            {
                id: 'claude-opus-next',
                providerId: 'github-copilot',
                name: 'Claude Opus Next',
                fullId: 'github-copilot/claude-opus-next',
                variants: [],
            },
            {
                id: 'gemini-pro',
                providerId: 'github-copilot',
                name: 'Gemini Pro',
                fullId: 'github-copilot/gemini-pro',
                variants: [],
            },
        ];

        client.applyCopilotSpeedMultipliers(models);

        expect(models[0].speedMultiplier).toBe('0x');
        expect(models[1].speedMultiplier).toBe('1x');
        expect(models[2].speedMultiplier).toBe('3x');
        expect(models[3].speedMultiplier).toBeUndefined();
    });
});
