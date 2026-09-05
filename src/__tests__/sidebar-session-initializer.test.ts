jest.mock('vscode', () => ({ workspace: { workspaceFolders: [] } }), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { initializeSidebarSession } from '../history/SidebarSessionInitializer';

const initializerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'history', 'SidebarSessionInitializer.ts'), 'utf8',
);

describe('SidebarSessionInitializer', () => {
  test('SidebarProvider keeps a single hydration delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    expect(source).toMatch(/private async sendInit\([\s\S]*?return initializeSidebarSession\(this, webview, options\);\s*}/);
  });

  test('rejects a stale handshake before touching host state', async () => {
    const host = new Proxy({}, { get: () => { throw new Error('host state touched'); } });
    await expect(initializeSidebarSession(host, {} as any, { isStillCurrent: () => false }))
      .rejects.toThrow('stale-handshake-before-sendInit');
  });

  test('retains snapshot-first hydration and proven-suffix merge ordering', () => {
    const snapshotRead = initializerSource.indexOf('await host.readSnapshot(recentSessionId)');
    const incrementalExport = initializerSource.indexOf('await host.client.exportSessionRecent(recentSessionId');
    const continuity = initializerSource.indexOf('host.classifyRecentAppendCandidates(');
    const immutableMerge = initializerSource.indexOf('host.buildImmutableSnapshotWithProvenSuffix(');
    const repairExport = initializerSource.indexOf('await host.client.exportSession(recentSessionId)');
    expect(snapshotRead).toBeGreaterThanOrEqual(0);
    expect(incrementalExport).toBeGreaterThan(snapshotRead);
    expect(continuity).toBeGreaterThan(incrementalExport);
    expect(immutableMerge).toBeGreaterThan(continuity);
    expect(repairExport).toBeGreaterThan(immutableMerge);
    expect(initializerSource).toContain("hydrationCoverage = fullDelta.proven ? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown'");
  });

  test('recovers a busy runtime before publishing hydrated history', () => {
    const statusRead = initializerSource.indexOf('await host.client.getSessionStatusType(runtimeRecoverySessionId)');
    const initPost = initializerSource.indexOf("type: 'init'");
    const recentFormat = initializerSource.indexOf('const formattedRaw = host.formatSession(recentExport)');
    const recoverOwner = initializerSource.indexOf('host.recoverBusySessionTurnFromMessages(');
    const sessionPost = initializerSource.indexOf('liveWebview.postMessage(sessionPayload)');
    expect(statusRead).toBeGreaterThanOrEqual(0);
    expect(initPost).toBeGreaterThan(statusRead);
    expect(recoverOwner).toBeGreaterThan(recentFormat);
    expect(sessionPost).toBeGreaterThan(recoverOwner);
    expect(initializerSource).toContain("statusType === 'busy' || statusType === 'retry'");
    expect(initializerSource).toContain("type: 'turnInFlight'");
    expect(initializerSource).toContain('ownerMsgId: recoveredTurn.assistantMessageId');
  });

  test('sends the persisted per-session settings snapshot on both init paths', () => {
    expect(initializerSource.match(/sessionSettings: host\.getSessionSettingsSnapshot\(\)/g)).toHaveLength(2);
  });
});
