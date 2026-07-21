import { buildChatPressureAttribution } from './chat-pressure-attribution';
import { decideChatWindowAdaptivePolicy } from './chat-window-adaptive-policy';
import { classifyChatWindowIntegrity, planChatWindowContainment } from './chat-window-budget-plan';
import { getSafeShellSpec } from './safe-shell-spec';
import { deriveRenderUnits } from './render-units';
import { presentationFingerprint } from './presentation-fingerprint';
import { planReconciliation } from './reconcile-planner';
import { restoreKeyedScrollAnchor, restoreScrollAnchor } from './scroll-anchor-model';
import { createTanStackVirtualAdapter } from './tanstack-virtual-adapter';
import { createLocalHistoryPresentationController, deriveLocalOlderPresentation, normalizeHydrationCoverage } from './local-history-window';
import { createMarkdownController } from './markdown-controller';
import { createModelState, isCopilotProvider, isFreeModel, normalizeResetText, parseSpeedMultiplier } from '../features/models/model-state';

export const RENDERING_FACADE_VERSION = 1 as const;

export function throwSourceMapTestError(): never {
  throw new Error('OC_RENDERING_SOURCE_MAP_TEST');
}

const facadeBase = {
  version: RENDERING_FACADE_VERSION,
  deriveRenderUnits,
  presentationFingerprint,
  planReconciliation,
  restoreScrollAnchor,
  restoreKeyedScrollAnchor,
  createTanStackVirtualAdapter,
  createLocalHistoryPresentationController,
  deriveLocalOlderPresentation,
  normalizeHydrationCoverage,
  throwSourceMapTestError,
  buildChatPressureAttribution,
};

const hiddenCapability = (value: unknown): PropertyDescriptor => ({
  value,
  enumerable: false,
  writable: false,
  configurable: false,
});

const facade = Object.freeze(Object.defineProperties(facadeBase, {
  getSafeShellSpec: hiddenCapability(getSafeShellSpec),
  planChatWindowContainment: hiddenCapability(planChatWindowContainment),
  classifyChatWindowIntegrity: hiddenCapability(classifyChatWindowIntegrity),
  decideChatWindowAdaptivePolicy: hiddenCapability(decideChatWindowAdaptivePolicy),
  createMarkdownController: hiddenCapability(createMarkdownController),
  createModelState: hiddenCapability(createModelState),
  isCopilotProvider: hiddenCapability(isCopilotProvider),
  isFreeModel: hiddenCapability(isFreeModel),
  normalizeResetText: hiddenCapability(normalizeResetText),
  parseSpeedMultiplier: hiddenCapability(parseSpeedMultiplier),
})) as typeof facadeBase
  & { readonly getSafeShellSpec: typeof getSafeShellSpec }
  & { readonly planChatWindowContainment: typeof planChatWindowContainment }
  & { readonly classifyChatWindowIntegrity: typeof classifyChatWindowIntegrity }
  & { readonly decideChatWindowAdaptivePolicy: typeof decideChatWindowAdaptivePolicy }
  & { readonly createMarkdownController: typeof createMarkdownController }
  & { readonly createModelState: typeof createModelState }
  & { readonly isCopilotProvider: typeof isCopilotProvider }
  & { readonly isFreeModel: typeof isFreeModel }
  & { readonly normalizeResetText: typeof normalizeResetText }
  & { readonly parseSpeedMultiplier: typeof parseSpeedMultiplier };

declare global {
  interface Window {
    __ocRendering?: typeof facade;
  }
}

window.__ocRendering = facade;
