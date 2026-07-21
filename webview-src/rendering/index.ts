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

const facade = Object.freeze(Object.defineProperty(
  Object.defineProperty(
    Object.defineProperty(
      Object.defineProperty(facadeBase, 'getSafeShellSpec', {
        value: getSafeShellSpec,
        enumerable: false,
        writable: false,
        configurable: false,
      }),
      'planChatWindowContainment',
      {
        value: planChatWindowContainment,
        enumerable: false,
        writable: false,
        configurable: false,
      },
    ),
    'classifyChatWindowIntegrity',
    {
      value: classifyChatWindowIntegrity,
      enumerable: false,
      writable: false,
      configurable: false,
    },
  ),
  'decideChatWindowAdaptivePolicy',
  {
    value: decideChatWindowAdaptivePolicy,
    enumerable: false,
    writable: false,
    configurable: false,
  },
)) as typeof facadeBase
  & { readonly getSafeShellSpec: typeof getSafeShellSpec }
  & { readonly planChatWindowContainment: typeof planChatWindowContainment }
  & { readonly classifyChatWindowIntegrity: typeof classifyChatWindowIntegrity }
  & { readonly decideChatWindowAdaptivePolicy: typeof decideChatWindowAdaptivePolicy };

declare global {
  interface Window {
    __ocRendering?: typeof facade;
  }
}

window.__ocRendering = facade;
