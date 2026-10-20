import type { V2Backend } from '../transport/protocol/V2Backend';
export interface ChildCardTerminal { sessionId: string; state: 'done' | 'failed' | 'cancelled'; finishedAt: number }
/** Review displayed identities, not a historical descendant scan or registration. */
export async function reviewChildCards(backend: V2Backend, parent: string, ids: readonly string[], current: () => boolean): Promise<ChildCardTerminal[]> {
    if (!/^ses_[\w-]+$/.test(parent) || ids.length > 128 || ids.some(id => !/^ses_[\w-]+$/.test(id))) throw new Error('Invalid child card scope');
    const root = await backend.sessions.getSession(parent);
    const key = (value: unknown) => typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([a-z]):/i, drive => drive.toUpperCase()) : '';
    const result: ChildCardTerminal[] = [];
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += 4) {
        if (!current()) return [];
        const rows = await Promise.all(unique.slice(start, start + 4).map(async id => {
            const child = await backend.sessions.getSession(id);
            if (!current() || child.parentId !== parent || !key(root.location.directory) || key(child.location.directory) !== key(root.location.directory)) return undefined;
            if (!['succeeded', 'failed', 'interrupted'].includes(String(child.native.outcome))) return undefined;
            const projection = await backend.projection(id);
            if (!current() || projection.active || projection.outcome !== child.native.outcome) return undefined;
            const finishedAt = Number((projection.messages.at(-1)?.info.time as { completed?: number } | undefined)?.completed);
            if (!Number.isFinite(finishedAt) || finishedAt <= 0) return undefined;
            return { sessionId: id, state: projection.outcome === 'succeeded' ? 'done' : projection.outcome === 'interrupted' ? 'cancelled' : 'failed', finishedAt } as ChildCardTerminal;
        }));
        result.push(...rows.filter((row): row is ChildCardTerminal => row !== undefined));
    }
    return current() ? result : [];
}
