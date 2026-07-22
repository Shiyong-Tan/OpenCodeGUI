import fs from 'fs';
import path from 'path';

describe('message renderer logging boundary', () => {
  test('uses only the explicit warning capability for duplicate logging', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'webview-src', 'rendering', 'message-renderer.ts'), 'utf8');
    expect(source).not.toMatch(/console\./);
    expect(source).toContain("host.logWarning('[Render] duplicate message skipped', message.id);");
  });
});
