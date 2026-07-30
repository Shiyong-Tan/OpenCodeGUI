const workspaceState: any = {
    workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
    textDocuments: [],
    findFiles: jest.fn(),
};

jest.mock('vscode', () => ({
    workspace: workspaceState,
    RelativePattern: class {
        constructor(public base: unknown, public pattern: string) {}
    },
}), { virtual: true });

import {
    extractWorkspaceTerms,
    WorkspaceLexiconService,
} from '../context/WorkspaceLexiconService';

describe('workspace completion lexicon', () => {
    beforeEach(() => {
        workspaceState.findFiles.mockReset();
        workspaceState.findFiles.mockResolvedValue([
            { fsPath: 'C:\\workspace\\src\\hydrationStateController.ts' },
            { fsPath: 'C:\\workspace\\results\\relative_deltaD_energy.png' },
        ]);
        workspaceState.textDocuments = [{
            isClosed: false,
            uri: { scheme: 'file', fsPath: 'C:\\workspace\\src\\active.ts' },
            getText: () => 'function resetSessionState() { return activePresentation; }',
        }];
    });

    it('splits camelCase and snake_case identifiers', () => {
        expect(extractWorkspaceTerms('resetSessionState relative_deltaD_energy')).toEqual(
            expect.arrayContaining([
                'resetSessionState', 'reset', 'Session', 'State',
                'relative_deltaD_energy', 'relative', 'delta', 'energy',
            ]),
        );
    });

    it('collects project paths and open document identifiers with caching', async () => {
        const service = new WorkspaceLexiconService();
        const first = await service.getTerms();
        const second = await service.getTerms();

        expect(first).toEqual(expect.arrayContaining([
            'hydrationStateController',
            'relative_deltaD_energy',
            'resetSessionState',
            'activePresentation',
        ]));
        expect(second).toEqual(first);
        expect(workspaceState.findFiles).toHaveBeenCalledTimes(1);
    });
});
