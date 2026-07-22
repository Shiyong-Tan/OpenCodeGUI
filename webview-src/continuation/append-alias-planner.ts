type Item = any;
type Root = { id: string; role: string; items: readonly Item[] };
const rank: Record<string, number> = { sending: 1, queued: 2, seen: 3, applied: 4, failed: 10, rejected: 10 };
const freezeItems = (items: Item[]) => Object.freeze(items.map((item) => Object.freeze({ ...item })));

export function planAppendRoot(input: { messages: readonly Root[]; message: Item; appendRootUserKey?: string; lastTurnUserId?: string; aliases: readonly [string, string][] }) {
  const candidates = (seed: unknown) => {
    if (typeof seed !== 'string' || !seed) return [] as string[];
    const result = new Set([seed]);
    for (const [from, to] of input.aliases) if (from === seed || to === seed) { result.add(from); result.add(to); }
    return [...result];
  };
  const direct = input.messages.filter((root) => root.role === 'user' && root.items.some((item) => item?.clientMessageId === input.message?.clientMessageId));
  if (direct.length > 1) return Object.freeze({ rootId: null, reason: 'ambiguous-client-match' });
  if (direct.length === 1) return Object.freeze({ rootId: direct[0].id, reason: 'client-match' });
  for (const [reason, seed] of [['root-user-msg-id', input.message?.rootUserMsgId], ['append-root', input.appendRootUserKey], ['last-turn-user', input.lastTurnUserId]] as const) {
    const roots = input.messages.filter((root) => root.role === 'user' && candidates(seed).includes(root.id));
    if (roots.length > 1) return Object.freeze({ rootId: null, reason: `ambiguous-${reason}` });
    if (roots.length === 1) return Object.freeze({ rootId: roots[0].id, reason });
  }
  return Object.freeze({ rootId: null, reason: 'no-root' });
}

export function planAppendItemUpsert(current: readonly Item[], item: Item) {
  const items = current.map((entry) => ({ ...entry }));
  const appendUserMatch = item.appendUserMsgId ? items.findIndex((entry) => entry.appendUserMsgId === item.appendUserMsgId) : -1;
  const index = appendUserMatch >= 0 ? appendUserMatch : items.findIndex((entry) => item.clientMessageId && entry.clientMessageId === item.clientMessageId);
  const existing = index >= 0 ? items[index] : {};
  const status = existing.status && item.status && (rank[item.status] || 0) < (rank[existing.status] || 0) ? existing.status : (item.status || existing.status);
  const next = { ...existing, ...item, status }; const selected = index >= 0 ? index : items.length;
  if (index >= 0) items[index] = next; else items.push(next);
  const seen = new Set<string>();
  return Object.freeze({ next: Object.freeze(next), items: freezeItems(items.filter((entry, position) => {
    const key = entry?.clientMessageId;
    if (!key) return true;
    if (key === next.clientMessageId) return position === selected;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  })) });
}

export function planAssistantParentSeen(roots: readonly Root[], parentId: string) {
  const root = roots.find((candidate) => candidate.role === 'user' && candidate.items.some((item) => item?.appendUserMsgId === parentId));
  if (!root) return Object.freeze({ rootId: null, items: Object.freeze([]), changed: false });
  let items: readonly Item[] = root.items; let changed = false;
  const end = root.items.findIndex((item) => item?.appendUserMsgId === parentId);
  for (let index = 0; index <= end; index++) { const item = items[index]; if (item?.appendUserMsgId && !['seen','applied','failed','rejected'].includes(item.status)) { items = planAppendItemUpsert(items, { clientMessageId: item.clientMessageId, appendUserMsgId: item.appendUserMsgId, status: 'seen' }).items; changed = true; } }
  return Object.freeze({ rootId: root.id, items: freezeItems([...items]), changed });
}

export function planFinalizedItems(current: readonly Item[]) {
  let changed = false;
  const items = current.map((item) => { if (!item || typeof item !== 'object' || ['applied','failed','rejected'].includes(item.status)) return item; if (item.status === 'seen' || ((item.status === 'queued' || item.status === 'sending') && item.appendUserMsgId)) { changed = true; return { ...item, status: 'applied' }; } if (item.status === 'sending' || item.status === 'queued') { changed = true; return { ...item, status: 'failed', reason: item.reason || 'append-not-acknowledged' }; } return item; });
  return Object.freeze({ items: freezeItems(items), changed });
}
