import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('assistant file link production contract', () => {
  it('linkifies bare filenames only when rendered as inline code', () => {
    expect(source).toContain('const INLINE_FILE_NAME_RE =');
    expect(source).toContain('const shouldMatchInlineFileName = inCode');
    expect(source).toContain('&& !shouldMatchFileOnly');
    expect(source).toContain('INLINE_FILE_NAME_QUICK_RE.test(source)');
    expect(source).toContain('appendLinkifiedText(frag, source, INLINE_FILE_NAME_RE, linkFileOnly)');
  });

  it('continues to exclude fenced PRE blocks from file linkification', () => {
    const guardStart = source.indexOf('function isInsideNoLinkifyTags(');
    const guardEnd = source.indexOf('function isInsideCodeTag(', guardStart);
    const guard = source.slice(guardStart, guardEnd);
    expect(guard).toContain("if (tag === 'A' || tag === 'PRE') return true;");
  });
});
