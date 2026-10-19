import { fileUrlPath, installLocalFileUrls, LOCAL_FILE_FRAGMENT } from '../features/files/local-file-url';
import { decodeLocalReference } from '../features/images/assistant-image-controller';

const MarkdownIt = require('markdown-it');
function markdown() {
  const md = new MarkdownIt({ linkify: true, html: false });
  installLocalFileUrls(md);
  return md;
}

test.each(['html', 'md', 'pdf', 'png', 'jpg', 'svg'])('file URL %s links reach the existing local-file handler', ext => {
  const url = `file:///J:/Vortex_coalescence/中文%20results/report.${ext}`;
  const original = new MarkdownIt().render(`[报告](${url})`);
  expect(original).not.toContain('<a ');
  const rendered = markdown().render(`[报告](${url})`);
  const href = rendered.match(/href="([^"]+)"/)?.[1];
  expect(href).toBeDefined(); expect(href).toContain(LOCAL_FILE_FRAGMENT);
  expect(decodeLocalReference(href!)).toBe(`J:/Vortex_coalescence/中文 results/report.${ext}`);
  expect(rendered).toContain('>报告</a>');
});

test('local inline image sources survive parsing as inert fragments for the preview controller', () => {
  const rendered = markdown().render('![结果](file:///J:/Vortex_coalescence/plot%20one.png)');
  expect(rendered).toContain('<img ');
  expect(decodeLocalReference(rendered.match(/src="([^"]+)"/)![1])).toBe('J:/Vortex_coalescence/plot one.png');
  expect(rendered).not.toContain('src="file:');
});

test('normal URLs, relative files and code blocks retain their existing parsing', () => {
  const md = markdown();
  expect(md.render('[网站](https://example.com/page) https://example.com')).toContain('href="https://example.com/page"');
  expect(md.render('[文档](report.md) [PDF](results/report.pdf)')).toContain('href="report.md"');
  expect(md.render('`[示例](file:///J:/report.md)`')).not.toContain('<a ');
  expect(md.render('```text\n[示例](file:///J:/report.md)\n```')).not.toContain('<a ');
  expect(decodeLocalReference(md.render('[本地](J:/folder/report.pdf)').match(/href="([^"]+)"/)![1])).toBe('J:/folder/report.pdf');
});

test('unsafe protocols, remote file hosts and malformed/control-character file URLs remain rejected', () => {
  const md = markdown();
  for (const url of ['javascript:alert(1)', 'vbscript:evil', 'data:text/html,evil', 'file://server/share/report.md', 'file:///tmp/%00.pdf', 'file:///tmp/%GG.pdf']) {
    expect(md.render(`[bad](${url})`)).not.toContain('<a ');
  }
  expect(fileUrlPath('file:///tmp/report.pdf')).toBe('/tmp/report.pdf');
  expect(fileUrlPath('file://localhost/tmp/report.md')).toBe('/tmp/report.md');
  expect(decodeLocalReference(LOCAL_FILE_FRAGMENT + '%GG')).toBe('');
});
