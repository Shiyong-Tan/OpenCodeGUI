export interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' }
export interface TodoState { sessionId: string; revision: number; items: TodoItem[] }
export function parseTodoState(value: unknown): TodoState {
  const fail = (): never => { throw new Error('Invalid Supervisor todo state'); };
  if (!value || typeof value !== 'object') return fail();
  const raw = value as Record<string, unknown>;
  if (typeof raw.sessionId !== 'string' || !/^ses_[A-Za-z0-9_-]{1,160}$/.test(raw.sessionId)
    || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !Array.isArray(raw.items) || raw.items.length > 64) return fail();
  const ids = new Set<string>();
  const items = raw.items.map((entry: unknown): TodoItem => {
    if (!entry || typeof entry !== 'object') return fail();
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 500 || /[\x00-\x08\x0b-\x1f\x7f]/.test(item.content)
      || !['pending', 'in_progress', 'completed'].includes(String(item.status)) || !['high', 'medium', 'low'].includes(String(item.priority))) return fail();
    ids.add(item.id);
    return { id: item.id, content: item.content, status: item.status as TodoItem['status'], priority: item.priority as TodoItem['priority'] };
  });
  return { sessionId: raw.sessionId, revision: raw.revision as number, items };
}
