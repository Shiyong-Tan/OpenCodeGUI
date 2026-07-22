import { createAppendSnapshotController } from './append-snapshot-controller';
import { createSessionState, createSessionStore } from './session-store';
import { createHydrationStateController } from './hydration-state-controller';

export const CONTINUATION_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: CONTINUATION_FACADE_VERSION,
  createAppendSnapshotController,
  createSessionState,
  createSessionStore,
  createHydrationStateController,
});

declare global {
  interface Window {
    __ocContinuation?: typeof facade;
  }
}

window.__ocContinuation = facade;
