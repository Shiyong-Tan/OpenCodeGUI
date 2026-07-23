import * as fs from 'fs';
import * as path from 'path';

describe('stable message identity production integration', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

  test('ensures every created and updated message has an entity identity', () => {
    expect(source).toContain(
      'const messageIdentityStore = window.__ocContinuation?.createMessageIdentityStore?.();',
    );
    expect(source.match(/messageIdentityStore\.ensure\(/g)).toHaveLength(2);
  });

  test('delegates compatibility storage rekey to the session-owned controller', () => {
    const replacement = source.slice(
      source.indexOf('function replaceKeyEverywhere('),
      source.indexOf('// Removed obsolete freezeSegments function'),
    );
    expect(source).toContain(
      'const messageRekeyController = window.__ocContinuation?.createMessageRekeyController?.({',
    );
    expect(replacement).toContain(
      'const result = messageRekeyController.rekey(session, oldId, newId, sessionId);',
    );
    expect(replacement).not.toContain('session.messagesById.delete');
    expect(replacement).not.toContain('session.timeline = session.timeline.map');
  });
});
