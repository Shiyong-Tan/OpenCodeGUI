import { createAppendSnapshotController } from './append-snapshot-controller';

export const CONTINUATION_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: CONTINUATION_FACADE_VERSION,
  createAppendSnapshotController,
});

declare global {
  interface Window {
    __ocContinuation?: typeof facade;
  }
}

window.__ocContinuation = facade;
