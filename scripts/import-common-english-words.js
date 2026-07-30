/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  throw new Error('Usage: node scripts/import-common-english-words.js <word-freq-top5000.csv>');
}

const lines = fs.readFileSync(path.resolve(source), 'utf8').split(/\r?\n/).slice(1);
const words = [];
const seen = new Set();
for (const line of lines) {
  const match = line.match(/^\d+,([A-Za-z]{3,48}),/);
  if (!match) continue;
  const word = match[1].toLowerCase();
  if (seen.has(word)) continue;
  seen.add(word);
  words.push(word);
}

const packed = [];
for (let index = 0; index < words.length; index += 16) {
  packed.push(words.slice(index, index + 16).join(' '));
}

const output = `/**
 * Generated from filiph/english_words data/word-freq-top5000.csv.
 * Source: https://github.com/filiph/english_words
 * License: MIT. See THIRD_PARTY_NOTICES.md.
 * Order is descending corpus frequency; entries shorter than three letters
 * and non-ASCII entries are omitted because the composer starts at 3 letters.
 */
export const COMMON_ENGLISH_WORDS = \`
${packed.join('\n')}
\`.trim().split(/\\s+/);
`;

const target = path.resolve(
  __dirname,
  '..',
  'webview-src',
  'features',
  'composer',
  'common-english-words.ts',
);
fs.writeFileSync(target, output, 'utf8');
console.log(JSON.stringify({ target, words: words.length }));
