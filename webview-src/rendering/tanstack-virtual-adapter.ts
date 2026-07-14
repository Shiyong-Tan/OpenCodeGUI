import {
  Virtualizer,
  type VirtualItem,
  type VirtualizerOptions,
} from '@tanstack/virtual-core';

type CoreVirtualizer = {
  getVirtualItems(): VirtualItem[];
  getTotalSize(): number;
};

export type VirtualizerConstructor = new (
  options: VirtualizerOptions<Element, Element>,
) => CoreVirtualizer;

export interface VirtualRangeSnapshot {
  readonly items: readonly VirtualItem[];
  readonly totalSize: number;
}

export interface TanStackVirtualAdapter {
  getRange(): VirtualRangeSnapshot;
}

const DefaultVirtualizer = Virtualizer as unknown as VirtualizerConstructor;

/**
 * Explicit dormant factory. Wave 1 exposes it but never calls it from the runtime entry point.
 */
export function createTanStackVirtualAdapter(
  options: VirtualizerOptions<Element, Element>,
  VirtualizerClass: VirtualizerConstructor = DefaultVirtualizer,
): TanStackVirtualAdapter {
  const virtualizer = new VirtualizerClass(options);
  return {
    getRange: () => ({
      items: virtualizer.getVirtualItems(),
      totalSize: virtualizer.getTotalSize(),
    }),
  };
}
