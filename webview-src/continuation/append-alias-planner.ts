type Item = any;
type Root = { id: string; role: string; items: readonly Item[] };

const statusRank: Record<string, number> = { sending: 1, queued: 2, seen: 3, applied: 4, failed: 10, rejected: 10 };
const stable = (items: Item[]) => Object.freeze(items.map((item) => Object.freeze({ ...item })));

export function planAppendRoot(input: { messages: readonly Root[]; message: Item; appendRootUserKey?: string; lastTurnUserId?: string; aliases: readonly [string, string][] }) {
  const resolve = (seed: unknown) => {
    if (typeof seed !== 'string' || !seed) return [] as string[];
    const candidates = new Set([seed]);
    for (const [from, to] of input.aliases) if (from === seed || to === seed) { candidates.add(from); candidates.add(to); }
    return [...candidates];
  };
  const direct = input.messages.filter((root) => root.role === 'user' && root.items.some((item) => item?.clientMessageId === input.message?.clientMessageId));
  if (direct.length > 1) return Object.freeze({ rootId: null, reason: 'ambiguous-client-match' });
  if (direct.length === 1) return Object.freeze({ rootId: direct[0].id, reason: 'client-match' });
  for (const [reason, seed] of [['root-user-msg-id', input.message?.rootUserMsgId], ['append-root', input.appendRootUserKey], ['last-turn-user', input.lastTurnUserId]] as const) {
    const roots = input.messages.filter((root) => root.role === 'user' && resolve(seed).includes(root.id));
    if (roots.length > 1) return Object.freeze({ rootId: null, reason: `ambiguous-${reason}` });
    if (roots.length === 1) return Object.freeze({ rootId: roots[0].id, reason });
  }
  return Object.freeze({ rootId: null, reason: 'no-root' });
}

export function planAppendItemUpsert(current: readonly Item[], item: Item) {
  const items = current.map((entry) => ({ ...entry }));
  const index = items.findIndex((entry) => (item.clientMessageId && entry.clientMessageId === item.clientMessageId) || (item.appendUserMsgId && entry.appendUserMsgId === item.appendUserMsgId));
  const existing = index >= 0 ? items[index] : {};
  const requested = item.status || existing.status;
  const status = existing.status && item.status && (statusRank[item.status] || 0) < (statusRank[existing.status] || 0) ? existing.status : requested;
  const next = { ...existing, ...item, status };
  if (index >= 0) items[index] = next; else items.push(next);
  const seen = new Set<string>();
  return Object.freeze({ next: Object.freeze(next), items: stable(items.filter((entry) => {
    if (!entry?.clientMessageId) return true;
    if (seen.has(entry.clientMessageId)) return false;
    seen.add(entry.clientMessageId); return true;
  })) });
}

export function planAssistantParentSeen(roots: readonly Root[], parentId: string) {
  const root = roots.find((candidate) => candidate.role === 'user' && candidate.items.some((item) => item?.appendUserMsgId === parentId));
  if (!root) return Object.freeze({ rootId: null, items: Object.freeze([]), changed: false });
  const index = root.items.findIndex((item) => item?.appendUserMsgId === parentId);
  let changed = false;
  let items: readonly Item[] = root.items;
  for (let cursor = 0; cursor <= index; cursor++) {
    const item = items[cursor];
    if (!item?.appendUserMsgId || ['seen', 'applied', 'failed', 'rejected'].includes(item.status)) continue;
    items = planAppendItemUpsert(items, { clientMessageId: item.clientMessageId, appendUserMsgId: item.appendUserMsgId, status: 'seen' }).items;
    changed = true;
  }
  return Object.freeze({ rootId: root.id, items: stable([...items]), changed });
}

export function planFinalizedItems(current: readonly Item[]) {
  let changed = false;
  const items = current.map((item) => {
    if (!item || typeof item !== 'object' || ['applied', 'failed', 'rejected'].includes(item.status)) return item;
    if (item.status === 'seen' || ((item.status === 'queued' || item.status === 'sending') && item.appendUserMsgId)) { changed = true; return { ...item, status: 'applied' }; }
    if (item.status === 'sending' || item.status === 'queued') { changed = true; return { ...item, status: 'failed', reason: item.reason || 'append-not-acknowledged' }; }
    return item;
  });
  return Object.freeze({ items: stable(items), changed });
}
