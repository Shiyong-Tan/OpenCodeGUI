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
