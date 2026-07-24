import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(process.cwd(), 'media', 'main.css'), 'utf8');

describe('streaming assistant border style', () => {
  test('clips the animated gradient to an independent ring', () => {
    expect(css).toContain('.message.streaming::before');
    expect(css).toContain('-webkit-mask-composite: xor;');
    expect(css).toMatch(/\.message\.streaming::before\s*\{[\s\S]*?padding:\s*1px;/);
    expect(css).not.toMatch(
      /\.message\.streaming\s*\{[\s\S]*?linear-gradient\(var\(--vscode-editor-inactiveSelectionBackground\)/,
    );
  });

  test('provides static fallbacks for unsupported masking and reduced motion', () => {
    expect(css).toMatch(/\.message\.streaming\s*\{\s*border-color:\s*var\(--vscode-focusBorder\);/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.message\.streaming::before\s*\{[\s\S]*?animation:\s*none;/,
    );
  });
});
