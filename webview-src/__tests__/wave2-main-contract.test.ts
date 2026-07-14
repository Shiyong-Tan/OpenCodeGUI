import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

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

describe('Wave 2 main-script contract', () => {
  test('keyed reconcile is deterministically default-on with an exact legacy fallback', () => {
    expect(source).toContain('const KEYED_CHAT_RECONCILE_ENABLED = window.__ocKeyedChatReconcileEnabled !== false;');
    expect(source).toContain('if (!KEYED_CHAT_RECONCILE_ENABLED || !window.__ocRendering || keyedChatFailedSessionId === activeSessionId)');
    expect(source).toContain('renderFromStateLegacy();');
    expect(extractFunction('function renderFromState()')).not.toContain("chatContainer.innerHTML = ''");
    expect(extractFunction('function renderFromStateLegacy()')).toContain("chatContainer.innerHTML = ''");
  });

  test('keyed reconciler alone owns unit-root structure and unchanged units skip factories', () => {
    const apply = extractFunction('function applyKeyedChatReconciliation(');
    expect(apply).toContain("entry.type === 'create' || entry.type === 'replace'");
    expect(apply).toContain('renderDetachedKeyedUnit(session, unit, renderedSet)');
    expect(apply).toContain('chatContainer.insertBefore(root, currentAtIndex)');
    expect(apply).not.toContain('enhanceCodeBlocksWithCopyButtons');
    expect(apply).not.toContain('wrapTables');
  });

  test('one stable detached root owns its following divider', () => {
    expect(source).toContain('const capture = document.createDocumentFragment();');
    expect(source).toContain('if (roots.length !== 1)');
    expect(source).toContain("divider.className = 'turn-divider';\n            row.appendChild(divider);");
    expect(extractFunction('function renderFromState()')).not.toContain('chatContainer.appendChild(divider);');
  });

  test('append/stream exactly-one audits and atomic alias rekey remain active', () => {
    expect(source).toContain('const postAppendAuditPassed = duplicateCount === 1 && tailMatchesCandidate === true && domChildDelta > 0;');
    expect(source).toContain('if (duplicateCount !== 1 || !assistantStreamingTailMatchesResolvedTarget');
    expect(source).toContain('rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) =>');
    expect(source).toContain("window.__oc?.renderFromState?.('alias-rekey-fail-closed');");
  });

  test('init no-model error is a bounded stable structural surface, not a keyed orphan', () => {
    expect(source).toContain("const INIT_NO_MODELS_STRUCTURAL_KEY = 'surface:error:no-model';");
    expect(source).toContain("const CHAT_STRUCTURAL_SURFACE_LIMIT = 6;");
    const showError = extractFunction('function showInitNoModelsError()');
    expect(showError).toContain('classifyChatStructuralSurface(errorDiv, INIT_NO_MODELS_STRUCTURAL_KEY, \'init:no-models\');');
    expect(showError).toContain('if (!existingError) chatContainer.appendChild(errorDiv);');
    expect(source).toContain('showInitNoModelsError();');
    expect(extractFunction('function keyedRoots()')).toContain('child.dataset?.renderUnitKey');
    expect(extractFunction('function getMessageKeyFromChatChild(')).not.toContain('chatStructuralKey');
  });

  test('stream acknowledgement is guarded by complete non-stream presentation identity', () => {
    const stable = extractFunction('function getKeyedStreamStablePresentation(');
    const acknowledge = extractFunction('function acknowledgeKeyedStreamPatch(');
    expect(stable).toContain('delete meta.statusText');
    expect(stable).toContain('delete meta.currentSegment');
    expect(stable).toContain('delete meta.textSegments');
    expect(stable).toContain('key: { $unitIdentityOwned: true }');
    expect(stable).not.toContain('delete meta.isThinking');
    expect(acknowledge).toContain('cachedItem.streamStableFingerprint !== currentStreamStableFingerprint');
    expect(acknowledge).toContain('fingerprint: rendering.presentationFingerprint(currentPresentation)');
    expect(source).toContain('const keyedFingerprintAcknowledged = acknowledgeKeyedStreamPatch(session, targetId);');
  });

  test('Wave 2 does not activate TanStack or range limiting', () => {
    const coordinator = extractFunction('function renderFromState()');
    expect(coordinator).not.toContain('createTanStackVirtualAdapter');
    expect(coordinator).not.toContain('rangeExtractor');
  });

  test('full loaded state, search, session ownership, and live-turn seams stay in the coordinator contract', () => {
    const projection = extractFunction('function buildKeyedRenderCandidates(');
    const coordinator = extractFunction('function renderFromState()');
    expect(projection).toContain('for (const id of timeline)');
    expect(projection).not.toContain('.slice(-');
    expect(coordinator).toContain('applySmartSessionSearchResults');
    expect(coordinator).toContain('refreshSessionSearchHighlights');
    expect(source).toContain('liveTurnHistory');
    expect(source).toContain('liveTurnResume');
    expect(source).toContain("sessionId: activeSessionId || ''");
  });
});
