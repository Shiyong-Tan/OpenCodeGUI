import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('header production ownership', () => {
  it('does not retain parallel header title, usage, hover, or compaction state', () => {
    expect(source).not.toMatch(/^let baseSessionTitle =/m);
    expect(source).not.toMatch(/^let headerStatusText =/m);
    expect(source).not.toMatch(/^const sessionUsageById =/m);
    expect(source).not.toMatch(/^let usageCompactHoverActive =/m);
    expect(source).not.toMatch(/^const compactionRunningBySession =/m);
  });

  it('routes title, usage, and compaction events through header state', () => {
    expect(source).toContain('headerStateController = factory(\'OpenCode: Chat\');');
    expect(source).toContain('getHeaderStateController().setBaseTitle(');
    expect(source).toContain('getHeaderStateController().setUsage(sessionId, {');
    expect(source).toContain('getHeaderStateController().setCompactionState(sessionId, running, getSelectedModelContextLimit());');
    expect(source).toContain('getHeaderStateController().isCompacting(activeSessionId)');
  });

  it('delegates header DOM and compact interaction ownership to its controller', () => {
    expect(source).toContain('headerUiController = createHeaderUiController({');
    expect(source).toContain('headerUiController.install();');
    expect(source).toContain('headerUiController?.renderTitle();');
    expect(source).toContain('headerUiController?.renderUsage();');
    expect(source).not.toContain("usageEl.addEventListener('mouseenter'");
  });

  it('delegates inline session title renaming to the header controller', () => {
    expect(source).toContain('onRename: (sessionId, title, opId) => vscode.postMessage({');
    expect(source).toContain("type: 'renameSession'");
    expect(source).toContain('headerUiController?.handleSessionRenameResult({');
  });
});
