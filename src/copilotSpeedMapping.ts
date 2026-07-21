export type CopilotModelIdentity = {
    id?: string;
    providerId?: string;
    name?: string;
    fullId?: string;
};

export function isCopilotProviderId(providerId: string | undefined, fullId: string | undefined): boolean {
    return String(providerId || '').toLowerCase().includes('copilot')
        || String(fullId || '').toLowerCase().includes('copilot');
}

export function normalizeCopilotModelKey(value: string): string {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getCopilotSpeedMultiplierKeys(model: CopilotModelIdentity): string[] {
    const rawKeys = [model.name, model.fullId, model.id]
        .map((value) => normalizeCopilotModelKey(value || ''))
        .filter((value) => value.length > 0);
    const keys = new Set(rawKeys);
    for (const key of rawKeys) {
        const withoutPreview = key
            .replace(/\s*\(preview\)\s*$/i, '')
            .replace(/\s+preview\s*$/i, '')
            .trim();
        if (withoutPreview && withoutPreview !== key) keys.add(withoutPreview);
    }
    return [...keys];
}

export function inferCopilotSpeedMultiplier(model: CopilotModelIdentity): string | undefined {
    const haystack = `${model.name || ''} ${model.fullId || ''} ${model.id || ''}`.toLowerCase();
    if (haystack.includes('opus')) return '3x';
    if (haystack.includes('gpt')) return '1x';
    return undefined;
}

export function getLocalCopilotSpeedMultiplierMap(): Map<string, string> {
    const entries: Array<[string, string]> = [
        ['GPT-4.1', '0x'], ['GPT-4o', '0x'], ['Grok Code Fast 1', '0.25x'],
        ['Raptor mini', '0x'], ['Raptor mini (Preview)', '0x'], ['Claude Haiku 4.5', '0.33x'],
        ['Claude Opus 4.1', '3x'], ['Claude Opus 4.5', '3x'], ['Claude Opus 4.6', '3x'],
        ['Claude Opus 4.6 (fast mode) (preview)', '30x'], ['Claude Opus 4.7', '15x'],
        ['Claude Sonnet 4', '1x'], ['Claude Sonnet 4.5', '1x'], ['Claude Sonnet 4.6', '1x'],
        ['Gemini 2.5 Pro', '1x'], ['Gemini 3 Flash', '0.33x'], ['Gemini 3.1 Pro', '1x'],
        ['GPT-5 mini', '0x'], ['GPT-5.2', '1x'], ['GPT-5.2-Codex', '1x'], ['GPT-5.3-Codex', '1x'],
        ['GPT-5.4', '1x'], ['GPT-5.4 mini', '0.33x'], ['GPT-5.4 nano', '0.25x'],
        ['GPT-5.5', '7.5x'], ['Goldeneye', '1x'],
    ];
    return new Map(entries.map(([name, multiplier]) => [normalizeCopilotModelKey(name), multiplier]));
}

function decodeHtmlEntities(value: string): string {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

function stripHtmlTags(value: string): string {
    return decodeHtmlEntities(
        String(value || '')
            .replace(/<a\b[^>]*href="#[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
}

export function parseCopilotMultiplierHtml(html: string): Map<string, string> {
    const multipliers = new Map<string, string>();
    const sectionMatch = String(html || '').match(/<h2[^>]*>\s*Model multipliers\s*<\/h2>([\s\S]*?)(?:<h2[^>]*>|<\/main>|<\/article>|<\/body>|<\/html>)/i);
    const section = sectionMatch ? sectionMatch[1] : html;
    for (const rowMatch of String(section || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cellMatches = [...(rowMatch[1] || '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)];
        if (cellMatches.length < 2) continue;
        const rawName = stripHtmlTags(cellMatches[0]?.[1] || '').replace(/\s*\[\d+\]$/g, '').trim();
        const rawMultiplier = stripHtmlTags(cellMatches[1]?.[1] || '').toLowerCase();
        if (!rawName || !rawMultiplier || rawName.toLowerCase() === 'model' || rawMultiplier === 'not applicable') continue;
        const numeric = rawMultiplier.replace(/x$/i, '').trim();
        if (!Number.isFinite(Number(numeric))) continue;
        multipliers.set(normalizeCopilotModelKey(rawName), `${numeric}x`);
    }
    return multipliers;
}
