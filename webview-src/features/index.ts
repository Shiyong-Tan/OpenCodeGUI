import { createAttachmentUiController, deriveAttachmentPresentation } from './composer/attachment-controller';
import { createAttachmentState, isImageAttachment } from './composer/attachment-state';
import { createComposerContextState } from './composer/context-state';
import { createHeaderUiController } from './header/header-controller';
import { createHeaderState, recomputeSessionUsage } from './header/header-state';
import { createModelUiController } from './models/model-controller';
import { createModelState, isCopilotProvider, isFreeModel, normalizeResetText, parseSpeedMultiplier } from './models/model-state';

export const FEATURE_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: FEATURE_FACADE_VERSION,
  createAttachmentState,
  isImageAttachment,
  createAttachmentUiController,
  deriveAttachmentPresentation,
  createComposerContextState,
  createHeaderState,
  recomputeSessionUsage,
  createHeaderUiController,
  createModelState,
  isCopilotProvider,
  isFreeModel,
  normalizeResetText,
  parseSpeedMultiplier,
  createModelUiController,
});

declare global {
  interface Window {
    __ocFeatures?: typeof facade;
  }
}

window.__ocFeatures = facade;
