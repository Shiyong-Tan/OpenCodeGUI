jest.mock('vscode', () => ({ window: { createOutputChannel: () => ({ appendLine() {} }) }, workspace: {} }), { virtual: true });
import { SidebarProvider } from '../SidebarProvider';
function owner() {
 const host = Object.create(SidebarProvider.prototype) as any;
 Object.assign(host, {
  sendInFlightBySession: new Set(['A', 'B']), turnCommandOwnerBySession: new Map([['A','local-A'],['B','local-B']]),
  pendingAssistantMessageIdBySession: new Map([['A','final-A']]), pendingAssistantTmpKeyBySession: new Map([['A','tmp:A']]),
  pendingLocalKeyBySession: new Map([['A','local-A']]), rawUserTextByLocalKey: new Map([['local-A','question']]),
  getWebviewLivenessActiveTurnFlags: jest.fn(() => ({ active:true })), logWebviewAutoRescueActiveTurnCleanup: jest.fn(),
  clearAssistantTextBuffers: jest.fn(), appendSnapshotTurnStateBySession: new Map(),
 });
 return host;
}
test('stall presentation preserves same-turn final binding and permits final cleanup', () => {
 const host = owner(); const webview = { postMessage: jest.fn() };
 host.syncTurnInFlightAfterFinalize('A', webview, 'autoResumeHardStop');
 expect(host.sendInFlightBySession.has('A')).toBe(false);
 expect(host.isTurnCommandOwner('A','local-A')).toBe(true);
 expect(host.pendingAssistantTmpKeyBySession.get('A')).toBe('tmp:A');
 expect(host.pendingAssistantMessageIdBySession.get('A')).toBe('final-A');
 expect(host.pendingLocalKeyBySession.get('A')).toBe('local-A');
 expect(host.turnCommandOwnerBySession.get('B')).toBe('local-B');
 expect(host.finishTurnCommandState('A','local-A')).toBe(true);
 expect(host.turnCommandOwnerBySession.has('A')).toBe(false);
});
test('a new request replaces stalled ownership and rejects the old final and cleanup', () => {
 const host = owner(); host.syncTurnInFlightAfterFinalize('A', { postMessage() {} }, 'autoResumeHardStop');
 host.turnCommandOwnerBySession.set('A','new-A');
 expect(host.isTurnCommandOwner('A','local-A')).toBe(false);
 expect(host.finishTurnCommandState('A','local-A')).toBe(false);
 expect(host.turnCommandOwnerBySession.get('A')).toBe('new-A');
});
test('explicit cancellation invalidates stalled ownership', () => {
 const host = owner(); host.syncTurnInFlightAfterFinalize('A', { postMessage() {} }, 'autoResumeHardStop');
 host.clearCanceledTurnCommandState('A');
 expect(host.isTurnCommandOwner('A','local-A')).toBe(false);
 expect(host.pendingAssistantTmpKeyBySession.has('A')).toBe(false);
});
