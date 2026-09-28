const commands = new Map<string, () => Promise<void>>();
const warning = jest.fn(); const information = jest.fn(); const errorMessage = jest.fn();
jest.mock('vscode', () => ({ commands: { registerCommand: (id: string, run: () => Promise<void>) => {
    commands.set(id, run); return { dispose: () => commands.delete(id) };
} }, window: { showWarningMessage: warning, showInformationMessage: information, showErrorMessage: errorMessage } }), { virtual: true });
import type * as vscode from 'vscode';
import { registerServiceCommands } from '../transport/ServiceCommands';

beforeEach(() => { commands.clear(); jest.clearAllMocks(); });

test('only command-palette operations are registered and disposed', async () => {
    const subscriptions: vscode.Disposable[] = [];
    const operateService = jest.fn(async () => 'started');
    registerServiceCommands({ subscriptions } as vscode.ExtensionContext, { operateService });
    expect([...commands.keys()]).toEqual(['opencode.service.start', 'opencode.service.stop', 'opencode.service.restart']);
    await commands.get('opencode.service.start')!();
    expect(operateService).toHaveBeenCalledWith('start', expect.any(Function));
    expect(warning).not.toHaveBeenCalled();
    subscriptions.forEach(item => item.dispose()); expect(commands.size).toBe(0);
});

test('active impact requires explicit modal selection; dismissal refuses', async () => {
    const answers: boolean[] = [];
    const operateService = async (_action: string, confirm: (action: 'stop' | 'restart') => Promise<boolean>) => {
        answers.push(await confirm('restart')); return 'already_running';
    };
    registerServiceCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, { operateService });
    warning.mockResolvedValueOnce(undefined).mockImplementationOnce(async (_message, _options, label) => label);
    await commands.get('opencode.service.restart')!(); await commands.get('opencode.service.restart')!();
    expect(answers).toEqual([false, true]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('interrupt'), { modal: true }, expect.any(String));
});

test('unexpected errors never expose raw transport or credential messages', async () => {
    registerServiceCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
        operateService: async () => { throw new Error('SECRET'); },
    });
    await commands.get('opencode.service.stop')!();
    expect(errorMessage.mock.calls[0][0]).toContain('operation_failed');
    expect(errorMessage.mock.calls[0][0]).not.toContain('SECRET');
});
