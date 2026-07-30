import {
  createWordCompletionController,
  extractCompletionWords,
  findCompletionPrefix,
} from '../features/composer/word-completion-controller';

export const WORD_COMPLETION_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: WORD_COMPLETION_FACADE_VERSION,
  createWordCompletionController,
  extractCompletionWords,
  findCompletionPrefix,
});

declare global {
  interface Window {
    __ocWordCompletion?: typeof facade;
  }
}

window.__ocWordCompletion = facade;
