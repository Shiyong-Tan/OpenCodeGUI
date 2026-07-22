import { createSegmentTopology } from '../features/segments/segment-topology';
import { createUndoRequestController } from './undo-request-controller';

export const UNDO_FACADE_VERSION = 1 as const;

const facade = Object.freeze({
  version: UNDO_FACADE_VERSION,
  createSegmentTopology,
  createUndoRequestController,
});

declare global {
  interface Window {
    __ocUndo?: typeof facade;
  }
}

window.__ocUndo = facade;
