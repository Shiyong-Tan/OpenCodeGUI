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

  test('binds canonical identity before the compatibility storage rekey', () => {
    const replacement = source.slice(
      source.indexOf('function replaceKeyEverywhere('),
      source.indexOf('// Removed obsolete freezeSegments function'),
    );
    expect(replacement.match(/messageIdentityStore\.bindCanonical\(/g)).toHaveLength(2);
    expect(replacement.indexOf('messageIdentityStore.bindCanonical(message, newId);'))
      .toBeLessThan(replacement.indexOf('message.id = newId;'));
    expect(replacement.indexOf('messageIdentityStore.bindCanonical(selected, newId);'))
      .toBeLessThan(replacement.indexOf('selected.id = newId;'));
  });
});
