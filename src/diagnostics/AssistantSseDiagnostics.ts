type UnknownRecord = Record<string, unknown>;

type DiagnosticState = {
    signature: string;
    suppressed: number;
};

const TEXT_BUCKET_SIZE = 4096;
const TOOL_OUTPUT_BUCKET_SIZE = 32768;
const MAX_TRACKED_STATES = 2048;

function asRecord(value: unknown): UnknownRecord | undefined {
    return value !== null && typeof value === 'object'
        ? value as UnknownRecord
        : undefined;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nestedRecord(owner: UnknownRecord | undefined, key: string): UnknownRecord | undefined {
    return asRecord(owner?.[key]);
}

function bucket(value: number, size: number): number {
    return Math.floor(Math.max(0, value) / size);
}

/**
 * Produces bounded, content-free SSE diagnostics. Repeated streaming updates are
 * coalesced until their lifecycle state or payload-size bucket changes.
 */
export class AssistantSseDiagnostics {
    private readonly states = new Map<string, DiagnosticState>();

    public summarize(type: string, properties: unknown, payloadChars: number): string | undefined {
        const props = asRecord(properties);
        if (type === 'message.updated') {
            return this.summarizeMessageUpdated(props, payloadChars);
        }
        if (type === 'message.part.updated') {
            return this.summarizePartUpdated(props, payloadChars);
        }
        return undefined;
    }

    private summarizeMessageUpdated(
        props: UnknownRecord | undefined,
        payloadChars: number
    ): string | undefined {
        const info = nestedRecord(props, 'info');
        if (stringValue(info?.role) !== 'assistant') return undefined;

        const sessionId = stringValue(info?.sessionID) || stringValue(props?.sessionID) || 'none';
        const messageId = stringValue(info?.id) || 'none';
        const time = nestedRecord(info, 'time');
        const finish = stringValue(info?.finish) || 'none';
        const completedAt = numberValue(time?.completed);
        const terminal = Boolean(completedAt) || finish !== 'none';
        const key = `message:${sessionId}:${messageId}`;
        const signature = `${finish}:${terminal}:${completedAt ? 'completed' : 'open'}`;
        const decision = this.accept(key, signature);
        if (!decision) return undefined;

        let suppressedParts = 0;
        if (terminal) {
            const partPrefix = `part:${sessionId}:${messageId}:`;
            for (const [stateKey, state] of this.states.entries()) {
                if (!stateKey.startsWith(partPrefix)) continue;
                suppressedParts += state.suppressed;
                this.states.delete(stateKey);
            }
        }

        return [
            '[SSE_ASSIST_SUMMARY]',
            `type=${typeLabel('message.updated')}`,
            `sessionId=${sessionId}`,
            `messageId=${messageId}`,
            `finish=${finish}`,
            `terminal=${String(terminal)}`,
            `payloadChars=${payloadChars}`,
            `suppressed=${decision.suppressed + suppressedParts}`,
        ].join(' ');
    }

    private summarizePartUpdated(
        props: UnknownRecord | undefined,
        payloadChars: number
    ): string | undefined {
        const part = nestedRecord(props, 'part');
        const partType = stringValue(part?.type);
        if (!['text', 'tool', 'diff', 'patch'].includes(partType)) return undefined;

        const sessionId = stringValue(part?.sessionID) || stringValue(props?.sessionID) || 'none';
        const messageId = stringValue(part?.messageID) || 'none';
        const partId = stringValue(part?.id) || stringValue(part?.callID) || 'none';
        const state = nestedRecord(part, 'state');
        const status = stringValue(state?.status) || 'none';
        const textChars = stringValue(part?.text).length;
        const outputChars = stringValue(state?.output).length;
        const partTime = nestedRecord(part, 'time');
        const metadata = nestedRecord(part, 'metadata');
        const openai = nestedRecord(metadata, 'openai');
        const phase = stringValue(openai?.phase) || 'none';
        const ended = numberValue(partTime?.end) !== undefined;
        const tool = stringValue(part?.tool) || 'none';

        const sizeBucket = partType === 'text'
            ? bucket(textChars, TEXT_BUCKET_SIZE)
            : bucket(outputChars, TOOL_OUTPUT_BUCKET_SIZE);
        const signature = `${partType}:${status}:${phase}:${ended}:${sizeBucket}`;
        const key = `part:${sessionId}:${messageId}:${partId}`;
        const decision = this.accept(key, signature);
        if (!decision) return undefined;

        return [
            '[SSE_ASSIST_SUMMARY]',
            `type=${typeLabel('message.part.updated')}`,
            `sessionId=${sessionId}`,
            `messageId=${messageId}`,
            `partId=${partId}`,
            `partType=${partType}`,
            `tool=${tool}`,
            `status=${status}`,
            `phase=${phase}`,
            `ended=${String(ended)}`,
            `textChars=${textChars}`,
            `outputChars=${outputChars}`,
            `payloadChars=${payloadChars}`,
            `suppressed=${decision.suppressed}`,
        ].join(' ');
    }

    private accept(key: string, signature: string): { suppressed: number } | undefined {
        const previous = this.states.get(key);
        if (previous?.signature === signature) {
            previous.suppressed += 1;
            return undefined;
        }

        const suppressed = previous?.suppressed || 0;
        this.states.delete(key);
        this.states.set(key, { signature, suppressed: 0 });
        while (this.states.size > MAX_TRACKED_STATES) {
            const oldestKey = this.states.keys().next().value as string | undefined;
            if (!oldestKey) break;
            this.states.delete(oldestKey);
        }
        return { suppressed };
    }
}

function typeLabel(type: 'message.updated' | 'message.part.updated'): string {
    return type;
}
