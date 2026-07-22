import fs from 'fs';
import path from 'path';
import vm from 'vm';
import type { MessageRendererHost } from '../rendering/message-renderer';

const capabilityNames: Array<keyof MessageRendererHost> = [
  'KEYED_CHAT_RECONCILE_ENABLED', 'activeSessionId', 'appendChatRenderRoot', 'appendHoverActiveKey',
  'appendMessageImages', 'appendMessageToChat', 'attachMessageCopyButton', 'buildAppendHoverKey',
  'busySessionId', 'canAppendToMessage', 'canUndo', 'changeListRenderer', 'chatContainer',
  'cleanSubagentTitle', 'discardAllSegments', 'enterAppendInputMode', 'formatSubagentModel',
  'getAppendItems', 'getSessionOrNull', 'getSessionState', 'gitUndoEnabled', 'handleRestoreSegment',
  'handleUndoToMessage', 'invalidateKeyedChatUnitPresentation', 'isBusy',
  'keyedFollowingTurnDividerOverride', 'logSessionState', 'pickMode', 'renderAssistantMarkdown',
  'renderMarkdownInto', 'renderNestedInvalidSegmentElement', 'renderNestedMessageElement',
  'renderUserMarkdown', 'requestRerender', 'sanitizeMergedSegmentSnapshot', 'scheduleClearAppendHover', 'selectedMode',
  'setAppendHoverActive', 'shouldShowBackgroundSubagentIndicator', 'stripAttachmentManifest',
  'stripSystemInjections', 'subagentTextExpandedByKey', 'toggleUndoSegmentPlaceholder', 'vscode',
];

function facadeSource(): string {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const start = source.indexOf('const renderMessageElementHost = Object.freeze({');
  const end = source.indexOf('\n});', start) + 4;
  return source.slice(start, end);
}

describe('message renderer host facade', () => {
  test('the real main facade supplies each typed capability as a live getter', () => {
    let activeSessionId = 'session-a';
    const callable = jest.fn();
    const context = vm.createContext({
      Object, KEYED_CHAT_RECONCILE_ENABLED: true, activeSessionId, appendChatRenderRoot: callable,
      appendHoverActiveKey: 'hover-a', appendMessageImages: callable, appendMessageToChat: callable,
      attachMessageCopyButton: callable, buildAppendHoverKey: callable, busySessionId: 'busy-a',
      canAppendToMessage: callable, canUndo: callable, changeListRenderer: { render: callable },
      chatContainer: { appendChild: callable }, cleanSubagentTitle: callable, discardAllSegments: callable,
      enterAppendInputMode: callable, formatSubagentModel: callable, getAppendItems: callable,
      getSessionOrNull: callable, getSessionState: callable, gitUndoEnabled: true, handleRestoreSegment: callable,
      handleUndoToMessage: callable, invalidateKeyedChatUnitPresentation: callable, isBusy: true,
      keyedFollowingTurnDividerOverride: null, logSessionState: callable, pickMode: callable,
      renderAssistantMarkdown: callable, renderMarkdownInto: callable, renderNestedInvalidSegmentElement: callable,
      renderNestedMessageElement: callable, renderUserMarkdown: callable, window: { __oc: { renderFromState: callable } },
      sanitizeMergedSegmentSnapshot: callable,
      scheduleClearAppendHover: callable, selectedMode: 'build', setAppendHoverActive: callable,
      shouldShowBackgroundSubagentIndicator: callable, stripAttachmentManifest: callable,
      stripSystemInjections: callable, subagentTextExpandedByKey: new Map(),
      toggleUndoSegmentPlaceholder: callable, vscode: { postMessage: callable },
    });
    vm.runInContext(`${facadeSource()}; globalThis.host = renderMessageElementHost;`, context);
    const host = (context as any).host as MessageRendererHost;

    expect(Object.keys(host).sort()).toEqual([...capabilityNames].sort());
    expect(host.appendMessageToChat).toBe(callable);
    expect(host.getSessionState).toBe(callable);
    expect(host.vscode.postMessage).toBe(callable);
    host.requestRerender('renderer-contract');
    expect(callable).toHaveBeenCalledWith('renderer-contract');
    expect(host.activeSessionId).toBe('session-a');
    (context as any).activeSessionId = activeSessionId = 'session-b';
    expect(host.activeSessionId).toBe(activeSessionId);
  });
});
