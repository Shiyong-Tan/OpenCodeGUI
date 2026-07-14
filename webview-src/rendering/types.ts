export interface LegacyProjectedRenderUnit<T = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly value: T;
}

export interface RenderUnitCandidate<T = unknown> extends LegacyProjectedRenderUnit<T> {
  /** Canonical identity. Alias variants are normalized before duplicate checks. */
  readonly canonicalKey?: string;
  readonly hidden?: boolean;
  readonly appendChildHidden?: boolean;
  readonly appendAssistantHidden?: boolean;
  readonly dcpHidden?: boolean;
  readonly emptyUserText?: boolean;
}

export interface RenderUnit<T = unknown> extends LegacyProjectedRenderUnit<T> {
  readonly sourceKey: string;
}

export interface ReconcileItem {
  readonly key: string;
  readonly fingerprint: string;
}

export type ReconcileStep =
  | { readonly type: 'move'; readonly key: string; readonly from: number; readonly to: number }
  | { readonly type: 'reuse'; readonly key: string; readonly from: number; readonly to: number }
  | { readonly type: 'replace'; readonly key: string; readonly from: number; readonly to: number }
  | { readonly type: 'create'; readonly key: string; readonly to: number }
  | { readonly type: 'remove'; readonly key: string; readonly from: number };
