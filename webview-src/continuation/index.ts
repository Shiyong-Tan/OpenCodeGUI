import { createAppendSnapshotController } from './append-snapshot-controller';
import { createSessionState, createSessionStore } from './session-store';
import { createHydrationStateController } from './hydration-state-controller';
import { createSessionEventRouter } from './session-event-router';
import { createSessionRenderScheduler } from './session-render-scheduler';
import { createSessionSelectionController } from '../session-runtime/session-selection-controller';
import { createSessionViewStore } from '../session-runtime/session-view-store';
import { selectAssistantUpgradeCandidate } from '../session-runtime/assistant-binding';
import { createTurnLifecycleController } from '../session-runtime/turn-lifecycle';
import { createMessageIdentityStore } from '../session-runtime/message-identity';

export const CONTINUATION_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: CONTINUATION_FACADE_VERSION,
  createAppendSnapshotController,
  createSessionState,
  createSessionStore,
  createHydrationStateController,
  createSessionEventRouter,
  createSessionRenderScheduler,
  createSessionSelectionController,
  createSessionViewStore,
  selectAssistantUpgradeCandidate,
  createTurnLifecycleController,
  createMessageIdentityStore,
});

declare global {
  interface Window {
    __ocContinuation?: typeof facade;
  }
}

window.__ocContinuation = facade;
