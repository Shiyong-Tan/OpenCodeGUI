import { deriveRenderUnits } from './render-units';
import { presentationFingerprint } from './presentation-fingerprint';
import { planReconciliation } from './reconcile-planner';
import { restoreKeyedScrollAnchor, restoreScrollAnchor } from './scroll-anchor-model';
import { createTanStackVirtualAdapter } from './tanstack-virtual-adapter';

export const RENDERING_FACADE_VERSION = 1 as const;

export function throwSourceMapTestError(): never {
  throw new Error('OC_RENDERING_SOURCE_MAP_TEST');
}

const facade = Object.freeze({
  version: RENDERING_FACADE_VERSION,
  deriveRenderUnits,
  presentationFingerprint,
  planReconciliation,
  restoreScrollAnchor,
  restoreKeyedScrollAnchor,
  createTanStackVirtualAdapter,
  throwSourceMapTestError,
});

declare global {
  interface Window {
    __ocRendering?: typeof facade;
  }
}

window.__ocRendering = facade;
