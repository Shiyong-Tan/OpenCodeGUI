import * as fs from 'fs';
import * as path from 'path';

export class SnapshotStore {
    constructor(private readonly options: {
        getDirectory(): string;
        ensureDir(directory: string): Promise<void>;
    }) {}

    getFile(sessionId: string): string {
        return path.join(this.options.getDirectory(), `${sessionId}.json`);
    }

    async writeAtomic(sessionId: string, payload: unknown): Promise<number> {
        const directory = this.options.getDirectory();
        await this.options.ensureDir(directory);
        const filePath = this.getFile(sessionId);
        const temporaryPath = `${filePath}.tmp`;
        const text = JSON.stringify(payload, null, 2);
        await fs.promises.writeFile(temporaryPath, text, 'utf-8');
        await fs.promises.rename(temporaryPath, filePath);
        return Buffer.byteLength(text, 'utf-8');
    }

    async read(sessionId: string): Promise<{ obj: any; bytes: number } | null> {
        const filePath = this.getFile(sessionId);
        if (!fs.existsSync(filePath)) return null;
        const text = await fs.promises.readFile(filePath, 'utf-8');
        return { obj: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf-8') };
    }
}
