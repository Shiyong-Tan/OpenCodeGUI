export type ModelInfo = {
    id: string;
    providerId: string;
    name: string;
    fullId: string;
    variants: string[];
    speedMultiplier?: string;
    contextLimit?: number;
};

export type ModelQuotaRow = {
    label: string;
    remainingPercent: number;
    resetText?: string;
};

export type ModelQuota = {
    providerId: string;
    modelId: string;
    summaryRemainingPercent: number;
    rows: ModelQuotaRow[];
    fetchedAt: number;
};
