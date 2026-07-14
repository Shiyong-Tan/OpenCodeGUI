import fs from 'fs';
import path from 'path';
import vm from 'vm';
import {
  deriveLocalOlderPresentation,
  normalizeHydrationCoverage,
  type HydrationCoverage,
} from '../rendering/local-history-window';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');

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

  test('new/reset session state starts unknown', () => {
    const context = vm.createContext({ Map, Set });
    vm.runInContext(`${extractFunction('function createSessionState(')}; globalThis.createSessionState = createSessionState;`, context);
    expect((context as any).createSessionState().hydrationCoverage).toBe('deltaContinuityUnknown');
  });

  test('sessionData and merge-only liveTurnHistory apply coverage after existing identity routing; resume does not erase it', () => {
    expect(source).toContain('applyPayloadHydrationCoverage(sessionId, message);');
    expect(extractFunction('function handleLiveTurnHistory(')).toContain('applyPayloadHydrationCoverage(sessionId, message);');
    expect(extractFunction('function handleLiveTurnResume(')).not.toContain('applyPayloadHydrationCoverage');
    expect(extractFunction('function handleLiveTurnHistory(')).toMatch(/session-mismatch[\s\S]*getSessionState\(sessionId, true\)[\s\S]*applyPayloadHydrationCoverage/);
    expect(source).toContain("hydrationCoverage: 'deltaContinuityUnknown'");
  });

  test('all inventoried pre-Wave5 payload paths publish unknown and fresh history remains metadata-only', () => {
    expect(providerSource).toContain("type HydrationCoverage = 'authoritativeHistoryComplete' | 'deltaContinuityUnknown' | 'repairInProgress' | 'repairError';");
    expect((providerSource.match(/hydrationCoverage:\s*'deltaContinuityUnknown'/g) || []).length).toBeGreaterThanOrEqual(15);
    expect(providerSource).not.toMatch(/hydrationCoverage:\s*'authoritativeHistoryComplete'/);
    const freshStart = providerSource.indexOf('private async postLiveTurnHistoryForSendInitGuardDefer(');
    const freshEnd = providerSource.indexOf('private logSendInitGuardCompensation(', freshStart);
    const fresh = providerSource.slice(freshStart, freshEnd);
    expect(fresh).toContain("type: 'liveTurnHistory'");
    expect(fresh).toContain("hydrationCoverage: 'deltaContinuityUnknown'");
    expect(fresh).not.toContain("type: 'sessionData'");
    const chainStart = providerSource.indexOf('EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer');
    const chain = providerSource.slice(chainStart, providerSource.indexOf('await this.ensureSessionUndoReady(recentSessionId', chainStart));
    expect(chain.indexOf('postLiveTurnHistoryForSendInitGuardDefer')).toBeGreaterThanOrEqual(0);
    expect(chain.indexOf('postLiveTurnResumeForSendInitGuardDefer')).toBeGreaterThan(chain.indexOf('postLiveTurnHistoryForSendInitGuardDefer'));
    expect(chain).not.toContain("type: 'sessionData'");
  });
});
