export class SseDataLineBuffer {
    private buffer = '';

    public push(chunk: string): string[] {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        const payloads: string[] = [];
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload) payloads.push(payload);
        }
        return payloads;
    }
}

export class OpenCodeEventStream {
    private abort?: AbortController;
    private active = false;
    private backoffMs = 1000;
    private failureCount = 0;
    private generation = 0;
    private reconnectTimer?: NodeJS.Timeout;
    private reconnectResolve?: () => void;

    constructor(private readonly options: {
        open(signal: AbortSignal): Promise<Response>;
        onPayload(payload: string): void;
        onOpen(): void;
        onClosed(): void;
        onError(failureCount: number): void;
        onRepeatedFailure(): void;
    }) {}

    public isActive(): boolean {
        return this.active;
    }

    public connect(): void {
        if (this.active) return;
        this.active = true;
        this.abort?.abort();
        this.abort = new AbortController();
        const signal = this.abort.signal;
        const generation = ++this.generation;
        void this.run(signal, generation);
    }

    public stop(): void {
        this.generation += 1;
        this.abort?.abort();
        this.abort = undefined;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.reconnectResolve?.();
        this.reconnectResolve = undefined;
        this.active = false;
    }

    private async run(signal: AbortSignal, generation: number): Promise<void> {
        try {
            const response = await this.options.open(signal);
            if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
            this.failureCount = 0;
            this.backoffMs = 1000;
            this.options.onOpen();
            const reader = response.body.getReader();
            const frames = new SseDataLineBuffer();
            let streamClosed = false;
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    streamClosed = true;
                    break;
                }
                const chunk = new TextDecoder('utf-8').decode(value, { stream: true });
                for (const payload of frames.push(chunk)) this.options.onPayload(payload);
            }
            if (streamClosed) this.options.onClosed();
        } catch (error) {
            if ((error as Error).name === 'AbortError') return;
            this.failureCount += 1;
            this.options.onError(this.failureCount);
            if (this.failureCount >= 3) this.options.onRepeatedFailure();
        }
        if (generation !== this.generation) return;
        this.active = false;
        await this.scheduleReconnect(generation);
    }

    private async scheduleReconnect(generation: number): Promise<void> {
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        await new Promise<void>((resolve) => {
            this.reconnectResolve = resolve;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                this.reconnectResolve = undefined;
                resolve();
            }, delay);
        });
        if (generation === this.generation && !this.active) this.connect();
    }
}
