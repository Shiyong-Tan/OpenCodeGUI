interface Request { readonly id: string; readonly sessionId: string }
interface Discovery<T extends Request> {
    global(): Promise<readonly T[]>;
    active(): Promise<readonly string[]>;
    session(id: string): Promise<{ readonly id: string; readonly parentId?: string }>;
    owned(id: string): Promise<readonly T[]>;
    known?: readonly string[];
}
const valid = (id: string) => /^ses_[A-Za-z0-9_-]{1,160}$/.test(id);

/** Location lists are discovery hints; original session endpoints own requests.
 * Active IDs restore child requests after reload without scanning old transcripts. */
export async function discoverNativeRequests<T extends Request>(scope: string, port: Discovery<T>): Promise<T[]> {
    if (!valid(scope)) throw new Error('Invalid interaction scope');
    const [hints, active] = await Promise.all([port.global(), port.active()]);
    const candidates = [...new Set([scope, ...hints.map(request => request.sessionId), ...active, ...(port.known ?? [])])];
    if (hints.length > 1024 || candidates.length > 2048 || candidates.some(id => !valid(id))) throw new Error('Interaction discovery bound/identity');
    const sessions = new Map<string, ReturnType<Discovery<T>['session']>>();
    const session = (id: string) => {
        let pending = sessions.get(id);
        if (!pending) { pending = port.session(id); sessions.set(id, pending); }
        return pending;
    };
    const belongs = async (id: string) => {
        const visited = new Set<string>();
        for (let depth = 0; depth < 32; depth++) {
            if (id === scope) return true;
            if (!valid(id) || visited.has(id)) throw new Error('Invalid interaction ancestry');
            visited.add(id);
            const owner = await session(id);
            if (owner.id !== id) throw new Error('Interaction owner mismatch');
            if (!owner.parentId) return false;
            id = owner.parentId;
        }
        throw new Error('Interaction ancestry bound');
    };
    const result: T[] = [], seen = new Set<string>();
    for (let start = 0; start < candidates.length; start += 8) {
        const groups = await Promise.all(candidates.slice(start, start + 8).map(async id => {
            if (!await belongs(id)) return [];
            const requests = await port.owned(id);
            if (requests.some(request => request.sessionId !== id)) throw new Error('Foreign interaction response');
            return requests;
        }));
        for (const request of groups.flat()) {
            if (seen.has(request.id) || result.length >= 1024) throw new Error('Duplicate/oversized interaction list');
            seen.add(request.id); result.push(request);
        }
    }
    return result;
}
