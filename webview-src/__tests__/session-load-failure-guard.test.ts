import fs from 'fs';
import path from 'path';

const main = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

function sessionLoadFailedBlock(): string {
  const start = main.indexOf("case 'sessionLoadFailed': {");
  const end = main.indexOf("case 'sessionId':", start);
  if (start < 0 || end <= start) throw new Error('sessionLoadFailed block unavailable');
  return main.slice(start, end);
}

describe('session load failure presentation guard', () => {
  test('ignores a late failure after the session has already hydrated', () => {
    const block = sessionLoadFailedBlock();
    const hydratedGuard = block.indexOf('if (hydratedSessions.has(sessionId))');
    const diagnostic = block.indexOf('[WV][SESSION_LOAD_FAILED_IGNORED]');
    const notice = block.indexOf('Failed to load session from opencode and no snapshot exists.');

    expect(hydratedGuard).toBeGreaterThanOrEqual(0);
    expect(diagnostic).toBeGreaterThan(hydratedGuard);
    expect(notice).toBeGreaterThan(diagnostic);
  });
});
