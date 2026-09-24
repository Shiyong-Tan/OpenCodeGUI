import { open, realpath } from 'fs/promises';
import { dirname, join, isAbsolute } from 'path';
import { parseNotificationIdentity, type NotificationIdentity } from './notification-identity-protocol';

/** Read-only projection of plugin identities, durable before notification submission.
 * Positive entries are immutable. Misses are never cached: a notification may be
 * registered later. This catalog does not own tasks or decide turn transitions.
 */
export class SupervisorNotificationCatalog {
    private readonly known = new Map<string, Readonly<NotificationIdentity>>();
    private readonly directory: string;
    constructor(descriptorPath: string, private readonly isolationId: string,
        private readonly parse: (value: unknown) => NotificationIdentity = parseNotificationIdentity) {
        if (!isAbsolute(descriptorPath)) throw new Error('Absolute supervisor descriptor required');
        this.directory = join(dirname(descriptorPath), 'identities');
    }

    peek(sessionId: string, messageId: string): Readonly<NotificationIdentity> | undefined {
        const known = this.known.get(messageId);
        return known?.parentSessionId === sessionId ? known : undefined;
    }

    async lookup(sessionId: string, messageId: string): Promise<Readonly<NotificationIdentity> | undefined> {
        if (!/^ses_[A-Za-z0-9_-]{1,176}$/.test(sessionId) || !/^msg_[A-Za-z0-9_-]{1,176}$/.test(messageId)) return undefined;
        const cached = this.known.get(messageId);
        if (cached) return cached.parentSessionId === sessionId ? cached : undefined;
        const path = join(this.directory, `${messageId}.json`);
        try {
            // Redirected identity directories/files are not a trusted notification source.
            let directory: string;
            try { directory = await realpath(this.directory); }
            catch { throw new Error('Supervisor identity directory unavailable'); }
            if (directory !== this.directory || await realpath(path) !== path)
                throw new Error('Redirected supervisor identity');
            const file = await open(path, 'r');
            let value: unknown;
            try {
                if (!(await file.stat()).isFile()) throw new Error('Invalid supervisor identity file');
                const buffer = Buffer.alloc(4097);
                let size = 0;
                while (size < buffer.length) {
                    const result = await file.read(buffer, size, buffer.length - size, null);
                    if (!result.bytesRead) break;
                    size += result.bytesRead;
                }
                if (size > 4096) throw new Error('Supervisor identity too large');
                value = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
            } finally { await file.close(); }
            const identity = this.parse(value);
            if (identity.isolationId !== this.isolationId || identity.messageId !== messageId)
                throw new Error('Supervisor identity ownership mismatch');
            if (!this.known.has(messageId) && this.known.size >= 1024) throw new Error('Supervisor identity capacity exceeded');
            const result = Object.freeze(identity);
            this.known.set(messageId, result);
            return result.parentSessionId === sessionId ? result : undefined;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            // Paths, contents and credentials never escape in diagnostics.
            throw new Error('Trusted supervisor notification classification unavailable');
        }
    }
}
