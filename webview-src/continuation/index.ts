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
import { createMessageRekeyController } from '../session-runtime/message-rekey-controller';
import { createSessionOverlayStore } from '../session-runtime/session-overlay-store';
import { createSessionConflictStore } from '../session-runtime/session-conflict-store';
import { createSessionTransientStatusStore } from '../session-runtime/session-transient-status-store';
import { createSessionSearchRegistry } from '../session-runtime/session-search-registry';
import { createSessionComposerStore } from '../session-runtime/session-composer-store';
import { createQuestionReview } from '../questions/question-review';
import { createPermissionReview } from '../permissions/permission-review';

import { isEmptyFailedPlaceholder } from './failed-placeholder';

export const CONTINUATION_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  isEmptyFailedPlaceholder,
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
  createMessageRekeyController,
  createSessionOverlayStore,
  createSessionConflictStore,
  createSessionTransientStatusStore,
  createSessionSearchRegistry,
  createSessionComposerStore,
  createPermissionReview,
  createQuestionReview,
});

declare global {
  interface Window {
    __ocContinuation?: typeof facade;
  }
}

window.__ocContinuation = facade;
