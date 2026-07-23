import fs from 'fs';
import path from 'path';
import vm from 'vm';
import {
  deriveLocalOlderPresentation,
  normalizeHydrationCoverage,
  type HydrationCoverage,
} from '../rendering/local-history-window';
import { createSessionState } from '../continuation/session-store';
import { buildFullExportSnapshotDelta } from '../../src/history/SnapshotDeltaPlanner';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
const initializerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'history', 'SidebarSessionInitializer.ts'), 'utf8');
const controllerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'), 'utf8');

function extractFunction(marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${marker}`);
}

function extractProviderRange(startMarker: string, endMarker: string): string {
  const start = providerSource.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = providerSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return providerSource.slice(start, end);
}

function extractInitializerRange(startMarker: string, endMarker: string): string {
  const start = initializerSource.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = initializerSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return initializerSource.slice(start, end);
}

function extractControllerRange(startMarker: string, endMarker: string): string {
  const start = controllerSource.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = controllerSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return controllerSource.slice(start, end);
}

describe('Wave 4A hydration coverage', () => {
  test('normalizes exactly four explicit states and defaults missing/invalid values to unknown', () => {
    const states: HydrationCoverage[] = [
      'authoritativeHistoryComplete', 'deltaContinuityUnknown', 'repairInProgress', 'repairError',
    ];
    expect(states.map(normalizeHydrationCoverage)).toEqual(states);
    expect(normalizeHydrationCoverage(undefined)).toBe('deltaContinuityUnknown');
    expect(normalizeHydrationCoverage('complete')).toBe('deltaContinuityUnknown');
  });

  test('snapshot presence plus local exhaustion without continuity proof stays unknown', () => {
    const payload = { meta: { source: 'snapshot', hydrationCoverage: 'deltaContinuityUnknown' } };
    const coverage = normalizeHydrationCoverage(payload.meta.hydrationCoverage);
    const presentation = deriveLocalOlderPresentation({ totalUnits: 200, revealStart: 0, hydrationCoverage: coverage });
    expect(coverage).toBe('deltaContinuityUnknown');
    expect(presentation).toMatchObject({ state: 'deltaContinuityUnknown', actionable: false });
    expect(`${presentation.label} ${presentation.hint}`).not.toContain('Start of loaded history');
  });

  test('coverage application writes only the payload-owned session and never selects it', () => {
    const sessionsById = new Map<string, any>([
      ['active', { hydrationCoverage: 'repairError' }],
      ['background', { hydrationCoverage: 'repairInProgress' }],
    ]);
    const context = vm.createContext({
      getSessionState: (sessionId: string) => sessionsById.get(sessionId),
    });
    vm.runInContext(
      `${extractFunction('function normalizePayloadHydrationCoverage(')}\n${extractFunction('function applyPayloadHydrationCoverage(')}; Object.assign(globalThis, { applyPayloadHydrationCoverage });`,
      context,
    );
    let activeSessionId = 'active';
    (context as any).applyPayloadHydrationCoverage('background', { meta: { hydrationCoverage: 'authoritativeHistoryComplete' } });
    expect(sessionsById.get('background').hydrationCoverage).toBe('authoritativeHistoryComplete');
    expect(sessionsById.get('active').hydrationCoverage).toBe('repairError');
    expect(activeSessionId).toBe('active');
    (context as any).applyPayloadHydrationCoverage('active', { meta: { hydrationCoverage: 'invalid' } });
    expect(sessionsById.get('active').hydrationCoverage).toBe('deltaContinuityUnknown');
  });

  test('standalone coverage adapter updates only existing payload-owned sessions and renders only the active target', () => {
    const activeMessages = [{ id: 'msg_active' }];
    const activeTimeline = ['msg_active'];
    const activeSegments = [{ id: 'segment_active' }];
    const sessionsById = new Map<string, any>([
      ['active', {
        hydrationCoverage: 'deltaContinuityUnknown',
        messages: activeMessages,
        timelineMessageIds: activeTimeline,
        segments: activeSegments,
      }],
      ['background', { hydrationCoverage: 'deltaContinuityUnknown', messages: [], timelineMessageIds: [], segments: [] }],
    ]);
    let activeSessionId = 'active';
    const renderAttempts: string[] = [];
    const rendered: Array<{ sessionId: string; reason: string }> = [];
    const getSessionState = jest.fn((sessionId: string, createIfMissing: boolean) => {
      expect(createIfMissing).toBe(false);
      return sessionsById.get(sessionId);
    });
    const context = vm.createContext({
      getSessionState,
      renderIfActive: (sessionId: string, reason: string) => {
        renderAttempts.push(sessionId);
        if (sessionId !== activeSessionId) return false;
        rendered.push({ sessionId, reason });
        return true;
      },
    });
    vm.runInContext(
      `${extractFunction('function normalizePayloadHydrationCoverage(')}\n${extractFunction('function applyPayloadHydrationCoverage(')}\n${extractFunction('function handleStandaloneHydrationCoverage(')}; Object.assign(globalThis, { handleStandaloneHydrationCoverage });`,
      context,
    );
    const handle = (context as any).handleStandaloneHydrationCoverage;

    expect(handle({ type: 'hydrationCoverage', sessionId: 'active', hydrationCoverage: 'repairInProgress' })).toBe(true);
    expect(sessionsById.get('active').hydrationCoverage).toBe('repairInProgress');
    expect(handle({ type: 'hydrationCoverage', sessionId: 'active', hydrationCoverage: 'repairError' })).toBe(true);
    expect(sessionsById.get('active').hydrationCoverage).toBe('repairError');
    expect(rendered).toEqual([
      { sessionId: 'active', reason: 'hydrationCoverage' },
      { sessionId: 'active', reason: 'hydrationCoverage' },
    ]);

    expect(handle({ type: 'hydrationCoverage', sessionId: 'background', hydrationCoverage: 'repairInProgress' })).toBe(true);
    expect(sessionsById.get('background').hydrationCoverage).toBe('repairInProgress');
    expect(renderAttempts).toContain('background');
    expect(rendered).toHaveLength(2);
    expect(activeSessionId).toBe('active');

    expect(handle({ type: 'hydrationCoverage', sessionId: 'active', hydrationCoverage: 'invalid' })).toBe(true);
    expect(sessionsById.get('active').hydrationCoverage).toBe('deltaContinuityUnknown');
    expect(handle({ type: 'hydrationCoverage', sessionId: 'active' })).toBe(true);
    expect(sessionsById.get('active').hydrationCoverage).toBe('deltaContinuityUnknown');

    const sizeBeforeUnknown = sessionsById.size;
    const renderAttemptsBeforeUnknown = renderAttempts.length;
    expect(handle({ type: 'hydrationCoverage', sessionId: 'unknown', hydrationCoverage: 'repairError' })).toBe(false);
    expect(sessionsById.size).toBe(sizeBeforeUnknown);
    expect(renderAttempts).toHaveLength(renderAttemptsBeforeUnknown);
    expect(activeSessionId).toBe('active');

    expect(sessionsById.get('active').messages).toBe(activeMessages);
    expect(sessionsById.get('active').timelineMessageIds).toBe(activeTimeline);
    expect(sessionsById.get('active').segments).toBe(activeSegments);
  });

  test('standalone hydrationCoverage has an explicit dispatcher path and is not treated as unknown', () => {
    expect(source).toContain("case 'hydrationCoverage':");
    expect(source).toMatch(/case 'hydrationCoverage':\s*\{\s*handleStandaloneHydrationCoverage\(message\);\s*break;/);
    expect(extractFunction('function handleStandaloneHydrationCoverage(')).toMatch(
      /message\?\.sessionId[\s\S]*applyPayloadHydrationCoverage\(sessionId[\s\S]*message\?\.hydrationCoverage[\s\S]*renderIfActive\(sessionId, 'hydrationCoverage'\)/,
    );
  });

  test('new/reset session state starts unknown', () => {
    expect(createSessionState().hydrationCoverage).toBe('deltaContinuityUnknown');
  });

  test('sessionData and merge-only liveTurnHistory apply coverage after existing identity routing; resume does not erase it', () => {
    expect(source).toContain('applyPayloadHydrationCoverage(sessionId, message);');
    expect(extractFunction('function handleLiveTurnHistory(')).toContain('applyPayloadHydrationCoverage(sessionId, message);');
    expect(extractFunction('function handleLiveTurnResume(')).not.toContain('applyPayloadHydrationCoverage');
    expect(extractFunction('function handleLiveTurnHistory(')).toMatch(/session-mismatch[\s\S]*getSessionState\(sessionId, true\)[\s\S]*applyPayloadHydrationCoverage/);
    expect(createSessionState().hydrationCoverage).toBe('deltaContinuityUnknown');
  });

  test('extension coverage is path-aware and completion requires continuity or full authority', () => {
    expect(providerSource).toContain("type HydrationCoverage = 'authoritativeHistoryComplete' | 'deltaContinuityUnknown' | 'repairInProgress' | 'repairError';");
    expect(providerSource).toContain("hydrationCoverage: 'repairInProgress' as HydrationCoverage");
    expect(providerSource).toContain("hydrationCoverage: 'repairError' as HydrationCoverage");

    const fresh = extractProviderRange(
      'private async postLiveTurnHistoryForSendInitGuardDefer(',
      'private logSendInitGuardCompensation(',
    );
    expect(fresh).toContain("let historyCoverage: HydrationCoverage = 'deltaContinuityUnknown'");
    expect(fresh).toMatch(/else if \(continuity\.proven\) \{[\s\S]*historyCoverage = 'authoritativeHistoryComplete'/);
    expect(fresh).toMatch(/historyCoverage = fullDelta\.proven \? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown'/);
    expect(fresh).not.toMatch(/baseMessages\.length[\s\S]{0,120}authoritativeHistoryComplete/);
    expect(fresh).toContain("type: 'liveTurnHistory'");
    expect(fresh).toContain('hydrationCoverage: historyCoverage');
    expect(fresh).not.toContain("type: 'sessionData'");

    const compensation = extractProviderRange(
      'private async repostSessionDataForSendInitGuardCompensation(',
      'private async runPendingSendInitGuardCompensation(',
    );
    expect(compensation).toMatch(/snapshotTimelineIds\.length > 0 && !continuity\.proven[\s\S]*reason: 'repair-disabled'[\s\S]*throw new Error\('snapshot-boundary-unproven'\)/);
    expect(compensation).toMatch(/snapshotTimelineIds\.length > 0[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);
    expect(compensation).toMatch(/fullDelta\.proven[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);

    const softRescue = extractProviderRange(
      'private async repostActiveSessionDataForWebviewSoftRescue(',
      'private async executeWebviewAutoRescueSoftRescue(',
    );
    expect(softRescue).toMatch(/snapshotTimelineIds\.length > 0 && !continuity\.proven[\s\S]*phase: 'snapshot'[\s\S]*throw new Error\('snapshot-boundary-unproven'\)/);
    expect(softRescue).toMatch(/fullDelta\.proven[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);

    const selectSession = extractControllerRange('case "selectSession"', 'case "newSession"');
    expect(selectSession).toContain('host.adoptSessionSelection(targetSessionId);');
    const adoptSelection = extractProviderRange(
      'private adoptSessionSelection(',
      'private isSessionSelectionCurrent(',
    );
    expect(adoptSelection).toContain('this.resetUiState(targetSessionId);');
    expect(selectSession).toMatch(/snapshotIds\.length > 0 && !continuity\.proven[\s\S]*repair-disabled-safe-snapshot[\s\S]*throw new Error\('snapshot-boundary-unproven'\)/);
    expect(selectSession).toMatch(/snapshotIds\.length > 0[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);
    expect(selectSession).toMatch(/fullDelta\.proven[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);

    const sendInitRecent = extractInitializerRange(
      'const recentSelectionEpoch = host.sessionSelectionEpoch',
      '[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent',
    );
    expect(sendInitRecent).toMatch(/snapshotTimelineIds\.length > 0 && continuity\.proven[\s\S]*\? 'authoritativeHistoryComplete'[\s\S]*: 'deltaContinuityUnknown'/);
    expect(sendInitRecent).toMatch(/fullDelta\.proven \? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown'/);

    const appendImmutable = (existing: any[], suffix: any[]) => [...existing, ...suffix];
    expect(buildFullExportSnapshotDelta({
      existingSnapshotRecords: [], snapshotTimelineIds: [],
      fullExportRecords: [{ id: 'msg_a', role: 'user', text: 'a' }], appendImmutable,
    })).toMatchObject({ proven: true, timelineMessageIds: ['msg_a'] });
    expect(buildFullExportSnapshotDelta({
      existingSnapshotRecords: [{ id: 'msg_a', role: 'user', text: 'a' }], snapshotTimelineIds: ['msg_a'],
      fullExportRecords: [{ id: 'msg_a', role: 'user', text: 'a' }, { id: 'msg_a', role: 'user', text: 'duplicate' }], appendImmutable,
    })).toMatchObject({ proven: false, timelineMessageIds: ['msg_a'] });
    expect(providerSource).not.toMatch(/localExhaust|revealStart[\s\S]{0,120}authoritativeHistoryComplete/);
  });

  test('fresh history remains metadata-only and resume follows without erasing coverage', () => {
    const fresh = extractProviderRange(
      'private async postLiveTurnHistoryForSendInitGuardDefer(',
      'private logSendInitGuardCompensation(',
    );
    expect(fresh).toContain("type: 'liveTurnHistory'");
    expect(fresh).not.toContain("type: 'sessionData'");
    const chainStart = initializerSource.indexOf('EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer');
    const chain = initializerSource.slice(chainStart, initializerSource.indexOf('await host.ensureSessionUndoReady(recentSessionId', chainStart));
    expect(chain.indexOf('postLiveTurnHistoryForSendInitGuardDefer')).toBeGreaterThanOrEqual(0);
    expect(chain.indexOf('postLiveTurnResumeForSendInitGuardDefer')).toBeGreaterThan(chain.indexOf('postLiveTurnHistoryForSendInitGuardDefer'));
    expect(chain).not.toContain("type: 'sessionData'");
  });
});
