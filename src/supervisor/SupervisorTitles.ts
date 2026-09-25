import type { SupervisorView } from './protocol';

/** Session titles are display metadata; the verified supervisor identity stays authoritative. */
export async function fillSupervisorTitles(view: SupervisorView, read: (id: string) => Promise<unknown>): Promise<SupervisorView> {
    const tasks = view.tasks.map(t => ({ ...t }));
    const missing = tasks.filter(t => !t.title && t.childSessionId && t.phase !== 'terminal' && t.health !== 'cancel_unknown' && t.health !== 'ended');
    // Bound compatibility reads; title failures never change task health.
    for (let offset = 0; offset < Math.min(missing.length, 32); offset += 4) {
        await Promise.all(missing.slice(offset, offset + 4).map(async task => {
            try {
                const session = await read(task.childSessionId!) as { id?: unknown; parentID?: unknown; title?: unknown };
                if (session?.id !== task.childSessionId || session.parentID !== view.parentSessionId ||
                    typeof session.title !== 'string' || !/^[^\x00-\x1f\x7f]{1,500}$/u.test(session.title)) return;
                task.title = session.title;
            } catch { /* Missing metadata is not missing execution evidence. */ }
        }));
    }
    return { ...view, tasks };
}
