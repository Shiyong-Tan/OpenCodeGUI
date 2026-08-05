import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

function loadProductionFormatter(): (text: string) => string {
  const main = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const source = ts.createSourceFile('main.js', main, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'formatQuoteMarkdown'
  ));
  if (!declaration) throw new Error('formatQuoteMarkdown must remain a top-level production function');
  return Function(`${declaration.getText(source)}; return formatQuoteMarkdown;`)();
}

describe('quote markdown formatting', () => {
  const formatQuoteMarkdown = loadProductionFormatter();

  test('keeps display math in an isolated block inside the quote', () => {
    expect(formatQuoteMarkdown('Before formula\n$$\\frac{x}{y}$$\nAfter formula')).toBe([
      '> Before formula',
      '>',
      '> $$\\frac{x}{y}$$',
      '>',
      '> After formula',
    ].join('\n'));
  });

  test('preserves multiline display math and quoted paragraph boundaries', () => {
    expect(formatQuoteMarkdown('Intro\n\n$$\na+b\n=c\n$$\n\nConclusion')).toBe([
      '> Intro',
      '>',
      '> $$a+b =c$$',
      '>',
      '> Conclusion',
    ].join('\n'));
  });

  test('retains the existing italic presentation for plain-text quotes', () => {
    expect(formatQuoteMarkdown('first line\nsecond * line')).toBe([
      '> *first line*',
      '> *second \\* line*',
    ].join('\n'));
  });
});
