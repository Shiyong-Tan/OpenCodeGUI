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
    it('keeps explicit matches and infers GPT/Opus fallback values for unmatched models', async () => {
        const client = new OpenCodeClient() as any;
        client.getCopilotSpeedMultiplierCache = jest.fn(async () => ({
            fetchedAt: Date.now(),
            multipliers: {
                'GPT-4.1': '0x',
                'Gemini 3.1 Pro': '1x'
            }
        }));
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
            {
                id: 'gemini-3-1-pro-preview',
                providerId: 'github-copilot',
                name: 'Gemini 3.1 Pro Preview',
                fullId: 'github-copilot/gemini-3-1-pro-preview',
                variants: [],
            },
        ];

        await client.applyCopilotSpeedMultipliers(models);

        expect(models[0].speedMultiplier).toBe('0x');
        expect(models[1].speedMultiplier).toBe('1x');
        expect(models[2].speedMultiplier).toBe('3x');
        expect(models[3].speedMultiplier).toBeUndefined();
        expect(models[4].speedMultiplier).toBe('1x');
    });

    it('parses the official model multipliers table from docs html', () => {
        const client = new OpenCodeClient() as any;
        const html = `
            <html>
                <body>
                    <h2>Model multipliers</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Multiplier for paid plans</th>
                                <th>Multiplier for Copilot Free</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Claude Haiku 4.5</td>
                                <td>0.33</td>
                                <td>1</td>
                            </tr>
                            <tr>
                                <td>GPT-5.4 nano<a href="#fn-1">1</a></td>
                                <td>0.25</td>
                                <td>1</td>
                            </tr>
                            <tr>
                                <td>Claude Opus 4.6 (fast mode) (preview)</td>
                                <td>30</td>
                                <td>Not applicable</td>
                            </tr>
                        </tbody>
                    </table>
                </body>
            </html>
        `;

        const parsed: Map<string, string> = client.parseCopilotMultiplierHtml(html);
        expect(parsed.get('claude haiku 4.5')).toBe('0.33x');
        expect(parsed.get('gpt-5.4 nano')).toBe('0.25x');
        expect(parsed.get('claude opus 4.6 (fast mode) (preview)')).toBe('30x');
        expect(parsed.has('model')).toBe(false);
    });
});
