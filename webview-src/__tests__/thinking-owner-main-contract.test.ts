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

type Message = { id: string; role: string; text: string; order: number; meta: Record<string, unknown> };

describe('active thinking owner integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const resolveOwner = extractFunction(source, 'function resolveActiveThinkingOwner(');
  const ensureUnique = extractFunction(source, 'function ensureThinkingUnique(');
  const run = new Function('session', 'source', 'console', `
    ${resolveOwner}
    ${ensureUnique}
    ensureThinkingUnique(session, source);
    return session;
  `) as (session: any, sourceName: string, consoleObject: Console) => any;

  function message(id: string, order: number, isThinking: boolean, text = ''): Message {
    return { id, role: 'assistant', text, order, meta: { isThinking } };
  }

  test('keeps the explicit current-turn owner instead of a newer stale message', () => {
    const owner = message('owner', 10, true, 'working');
    const stale = message('stale', 99, true, 'old');
    const session: any = {
      messagesById: new Map([[owner.id, owner], [stale.id, stale]]),
      turnLifecycle: { phase: 'active' },
      currentTurnAssistantKey: owner.id,
    };

    run(session, 'test', console);

    expect(owner.meta.isThinking).toBe(true);
    expect(stale.meta.isThinking).toBe(false);
    expect(session.thinkingId).toBe(owner.id);
  });

  test('re-arms an active append successor restored as finalized', () => {
    const predecessor = message('predecessor', 30, true, 'old answer');
    const successor = message('successor', 20, false, 'current answer');
    const session: any = {
      messagesById: new Map([[predecessor.id, predecessor], [successor.id, successor]]),
      turnLifecycle: { phase: 'active' },
      currentTurnAssistantKey: successor.id,
      appendFollowupIdentity: {
        kind: 'append-followup',
        mode: 'same-turn-handoff',
        assistantMsgId: successor.id,
        predecessorPresentationAssistantId: predecessor.id,
      },
    };

    run(session, 'sessionData-hydrate', console);

    expect(successor.meta.isThinking).toBe(true);
    expect(predecessor.meta.isThinking).toBe(false);
    expect(session.thinkingId).toBe(successor.id);
  });

  test('keeps the visible predecessor active while an append successor is blank', () => {
    const predecessor = message('predecessor', 10, true, 'visible answer');
    const successor = message('successor', 20, true, '');
    const session: any = {
      messagesById: new Map([[predecessor.id, predecessor], [successor.id, successor]]),
      turnLifecycle: { phase: 'active' },
      currentTurnAssistantKey: successor.id,
      appendFollowupIdentity: {
        kind: 'append-followup',
        mode: 'same-turn-handoff',
        assistantMsgId: successor.id,
        predecessorPresentationAssistantId: predecessor.id,
      },
    };

    run(session, 'sessionData-hydrate', console);

    expect(predecessor.meta.isThinking).toBe(true);
    expect(successor.meta.isThinking).toBe(false);
    expect(session.thinkingId).toBe(predecessor.id);
  });

  test('does not re-arm an assistant after the turn finalized', () => {
    const finalMessage = message('final', 10, false, 'done');
    const session: any = {
      messagesById: new Map([[finalMessage.id, finalMessage]]),
      turnLifecycle: { phase: 'finalized' },
      currentTurnAssistantKey: finalMessage.id,
    };

    run(session, 'sessionData-hydrate', console);

    expect(finalMessage.meta.isThinking).toBe(false);
    expect(session.thinkingId).toBeNull();
  });

  test('runs the invariant after hydration is applied', () => {
    const apply = source.indexOf('const hydrationApplication = hydrationStateController.applyIntegration(');
    const invariant = source.indexOf("assertInvariants(sessionId, 'sessionData-hydrate');", apply);
    const refresh = source.indexOf('refreshSessionCompletionLexicon(sessionId);', apply);
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(invariant).toBeGreaterThan(apply);
    expect(invariant).toBeLessThan(refresh);
  });
});
