export interface ScrollAnchorSnapshot {
  readonly scrollTop: number;
  readonly anchorTopBefore: number;
  readonly anchorTopAfter: number;
}

export interface ScrollAnchorPlan {
  readonly scrollTop: number;
  readonly delta: number;
}

/** Computes a scroll restoration plan without reading or writing browser state. */
export function restoreScrollAnchor(snapshot: ScrollAnchorSnapshot): ScrollAnchorPlan {
  const delta = snapshot.anchorTopAfter - snapshot.anchorTopBefore;
  return { scrollTop: snapshot.scrollTop + delta, delta };
}

export interface KeyedScrollAnchorSnapshot {
  readonly anchorKey: string;
  readonly visualOffset: number;
  readonly anchorStartAfter: number;
  readonly currentScrollTop: number;
}

export interface KeyedScrollAnchorPlan {
  readonly anchorKey: string;
  readonly scrollTop: number;
  readonly correction: number;
  readonly programmatic: true;
}

/** Restores a domain key and visual offset without retaining a virtual index. */
export function restoreKeyedScrollAnchor(snapshot: KeyedScrollAnchorSnapshot): KeyedScrollAnchorPlan {
  const scrollTop = snapshot.anchorStartAfter - snapshot.visualOffset;
  return {
    anchorKey: snapshot.anchorKey,
    scrollTop,
    correction: scrollTop - snapshot.currentScrollTop,
    programmatic: true,
  };
}
