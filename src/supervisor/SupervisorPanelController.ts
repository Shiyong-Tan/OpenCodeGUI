import type { SupervisorReadResult } from './SupervisorReader';

export interface SupervisorPanelHost {
    selection(): { sessionId?: string; epoch: number };
    read(sessionId: string): Promise<SupervisorReadResult>;
    publish(message: unknown): void;
}
/** A throttled UI projection. It owns neither session selection nor task state. */
export class SupervisorPanelController {
    private disposed = false;
    private busy = false;
    private selectionKey = '';
    private awaitingSession: string | undefined;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(private readonly host: SupervisorPanelHost, intervalMs = 2000) {
        this.timer = setInterval(() => { void this.tick(); }, intervalMs);
        this.timer.unref?.();
    }
    selectionChanged(sessionId?: string): void {
        this.awaitingSession = sessionId;
        this.selectionKey = '';
        this.host.publish({ type: 'supervisorSelection', sessionId: sessionId ?? null });
    }
    async tick(): Promise<void> {
        if (this.disposed) return;
        const selection = this.host.selection();
        if (this.awaitingSession && selection.sessionId !== this.awaitingSession) return;
        this.awaitingSession = undefined;
        const key = `${selection.sessionId ?? ''}:${selection.epoch}`;
        if (key !== this.selectionKey) {
            this.selectionKey = key;
            this.host.publish({ type: 'supervisorSelection', sessionId: selection.sessionId ?? null });
        }
        if (!selection.sessionId || this.busy) return;
        this.busy = true;
        try {
            const result = await this.host.read(selection.sessionId);
            const current = this.host.selection();
            if (this.disposed || current.sessionId !== selection.sessionId || current.epoch !== selection.epoch) return;
            this.host.publish({ type: 'supervisorState', sessionId: selection.sessionId,
                status: result.status, ...(result.status === 'observed' ? { view: result.view } : {}) });
        } catch {
            const current = this.host.selection();
            if (!this.disposed && current.sessionId === selection.sessionId && current.epoch === selection.epoch)
                this.host.publish({ type: 'supervisorState', sessionId: selection.sessionId, status: 'unavailable' });
        } finally { this.busy = false; }
    }
    dispose(): void { this.disposed = true; clearInterval(this.timer); }
}
