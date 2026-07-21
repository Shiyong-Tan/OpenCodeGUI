import { createAttachmentUiController, deriveAttachmentPresentation } from './composer/attachment-controller';
import { createAttachmentState, isImageAttachment } from './composer/attachment-state';
import { createComposerContextState } from './composer/context-state';
import { createContextTokenUiController, deriveContextTokenPresentation } from './composer/context-controller';
import { createFileMentionController, findActiveFileMention, normalizeFileRef } from './composer/file-mention-controller';
import { buildComposerSubmission } from './composer/submission';
import { createClipboardAttachmentController, getClipboardImageItems } from './composer/clipboard-controller';
import { createComposerInputController, decideComposerInputKeyAction } from './composer/input-controller';
import { createHeaderUiController } from './header/header-controller';
import { createHeaderState, recomputeSessionUsage } from './header/header-state';
import { createModelUiController } from './models/model-controller';
import { createModelState, isCopilotProvider, isFreeModel, normalizeResetText, parseSpeedMultiplier } from './models/model-state';
import { createSessionSearchState } from './search/search-state';
import { collectBoundedSmartSearchText, createLinearSearchMatcher } from './search/search-text';
import { createSessionSearchDomController, deriveSessionSearchControls } from './search/search-dom-controller';

export const FEATURE_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: FEATURE_FACADE_VERSION,
  createAttachmentState,
  isImageAttachment,
  createAttachmentUiController,
  deriveAttachmentPresentation,
  createComposerContextState,
  createContextTokenUiController,
  deriveContextTokenPresentation,
  createFileMentionController,
  findActiveFileMention,
  normalizeFileRef,
  buildComposerSubmission,
  createClipboardAttachmentController,
  getClipboardImageItems,
  createComposerInputController,
  decideComposerInputKeyAction,
  createHeaderState,
  recomputeSessionUsage,
  createHeaderUiController,
  createModelState,
  isCopilotProvider,
  isFreeModel,
  normalizeResetText,
  parseSpeedMultiplier,
  createModelUiController,
  createSessionSearchState,
  collectBoundedSmartSearchText,
  createLinearSearchMatcher,
  createSessionSearchDomController,
  deriveSessionSearchControls,
});

declare global {
  interface Window {
    __ocFeatures?: typeof facade;
  }
}

window.__ocFeatures = facade;
