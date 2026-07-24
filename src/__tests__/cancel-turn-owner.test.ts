import * as fs from 'fs';
import * as path from 'path';
import { captureCancelTurnOwner } from '../webview/CancelTurnOwner';

describe('cancel turn ownership', () => {
  test('captures all identities from the explicit session before asynchronous work', () => {
    const source = {
      currentSessionId: 'B',
      pendingLocalKeyBySession: new Map([['A', 'local-A'], ['B', 'local-B']]),
      pendingAssistantTmpKeyBySession: new Map([['A', 'tmp:A'], ['B', 'tmp:B']]),
      pendingAssistantMessageIdBySession: new Map([['A', 'internal-A'], ['B', 'internal-B']]),
    };

    expect(captureCancelTurnOwner({ sessionId: 'A', opId: 'op-A' }, source)).toEqual({
      sessionId: 'A',
      operationId: 'op-A',
      localKey: 'local-A',
      temporaryAssistantKey: 'tmp:A',
      assistantMessageId: 'internal-A',
    });
  });

  test('uses the visible session only once at command ingress when no owner is supplied', () => {
    const source = {
      currentSessionId: 'B',
      pendingLocalKeyBySession: new Map([['B', 'local-B']]),
      pendingAssistantTmpKeyBySession: new Map([['B', 'tmp:B']]),
      pendingAssistantMessageIdBySession: new Map([['B', 'internal-B']]),
    };
    expect(captureCancelTurnOwner({}, source)).toMatchObject({
      sessionId: 'B',
      localKey: 'local-B',
      temporaryAssistantKey: 'tmp:B',
      assistantMessageId: 'internal-B',
    });
  });

  test('controller aborts and cleans only the captured owner', () => {
    const controller = fs.readFileSync(
      path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
      'utf8',
    );
    const start = controller.indexOf('case "cancel":');
    const end = controller.indexOf('case "restoreAll":', start);
    const block = controller.slice(start, end);
    expect(block).toContain('const cancelOwner = host.captureTurnCancelOwner(data);');
    expect(block).toContain('await host.client.abortSession(cancelSessionId);');
    expect(block).toContain('const restoreLocalKey = pendingLocalKey;');
    expect(block).toContain('localKey: pendingLocalKey');
    expect(block).not.toContain('host.client.cancel();');
    expect(block).not.toContain('host.pendingClientMessageId ||');
  });
});
