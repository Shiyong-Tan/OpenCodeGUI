import * as fs from 'fs';
import * as path from 'path';

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  let depth = 0;
  let entered = false;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      entered = true;
    } else if (source[index] === '}') {
      depth -= 1;
      if (entered && depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

describe('assistant binding production integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const upgrade = extractFunction(source, 'function attemptAssistantUpgrade(');

  test('delegates source identity selection to the session-owned pure selector', () => {
    expect(source).toContain(
      'const selectAssistantUpgradeCandidate = window.__ocContinuation?.selectAssistantUpgradeCandidate;',
    );
    expect(upgrade).toContain('const candidateDecision = selectAssistantUpgradeCandidate({');
    expect(upgrade).toContain('explicitTemporaryId: typeof tmpKey');
    expect(upgrade).toContain('const currentKey = candidateDecision.sourceId;');
  });

  test('binds a background assistant only through its session-owned identity', () => {
    expect(upgrade).not.toContain('payloadSession === activeSessionId');
    expect(upgrade).not.toContain('!isActiveSession');
    expect(upgrade).not.toContain('messageIndexMap');
    expect(upgrade).not.toContain('tryMapExistsMissingNewKeyFallback');
    expect(upgrade).not.toContain('lastAssistantUpgradeFallback');
    expect(upgrade).toContain('replaceKeyEverywhere(currentKey, newKey, payloadSession);');
    expect(upgrade).toContain("reason = 'owned-identity-bind';");
  });
});
