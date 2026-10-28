jest.mock('vscode', () => ({ env: { clipboard: { writeText: jest.fn(async () => undefined) } } }), { virtual: true });
import * as vscode from 'vscode';
import { UtilityCommandController } from '../webview/controllers/UtilityCommandController';

test('selected chat text goes through the VS Code clipboard without browser clipboard permission', async () => {
  const c = new UtilityCommandController({} as any); const view = {} as vscode.Webview;
  await c.handle({ type: 'copySelectedText', sessionId: 'ses_A', text: 'Selected text' }, view, view);
  expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('Selected text');
});
test('missing owners, invalid text and oversized messages cannot write the clipboard', async () => {
  jest.mocked(vscode.env.clipboard.writeText).mockClear();
  const c = new UtilityCommandController({} as any); const view = {} as vscode.Webview;
  for (const data of [{ text: 'text' }, { sessionId: 'ses_A', text: 1 }, { sessionId: 'ses_A', text: 'x'.repeat(8*1024*1024+1) }])
    await c.handle({ type: 'copySelectedText', ...data }, view, view);
  expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
});
