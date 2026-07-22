import * as fs from 'fs';
import * as path from 'path';
import type { ChangeListRecord } from './ChangeListInjection';

export class ChangeListStore {
    constructor(private readonly options: {
        getDataDir(): string;
        getLegacyDir(): string;
        ensureDir(dir: string): Promise<void>;
        log(line: string): void;
    }) {}

    private getPath(sessionId: string): string {
        return path.join(this.options.getDataDir(), `${sessionId}.json`);
    }

    private getLegacyPath(sessionId: string): string {
        return path.join(this.options.getLegacyDir(), `${sessionId}.json`);
    }

    async read(sessionId: string): Promise<ChangeListRecord[]> {
        const filePath = this.getPath(sessionId);
        if (!fs.existsSync(filePath)) {
            const legacyPath = this.getLegacyPath(sessionId);
            if (!fs.existsSync(legacyPath)) return [];
            try {
                const text = await fs.promises.readFile(legacyPath, 'utf-8');
                const parsed = JSON.parse(text);
                const records = Array.isArray(parsed) ? parsed as ChangeListRecord[] : [];
                if (records.length > 0) {
                    await this.write(sessionId, records);
                    this.options.log(
                        `[EXT][CHANGELIST_MIGRATED] sessionId=${sessionId} from=${legacyPath} to=${filePath} records=${records.length}`,
                    );
                }
                return records;
            } catch {
                return [];
            }
        }
        try {
            const text = await fs.promises.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed as ChangeListRecord[] : [];
        } catch {
            return [];
        }
    }

    async write(sessionId: string, records: ChangeListRecord[]): Promise<void> {
        const dir = this.options.getDataDir();
        await this.options.ensureDir(dir);
        const filePath = this.getPath(sessionId);
        const tmpPath = `${filePath}.tmp`;
        const text = JSON.stringify(records, null, 2);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await fs.promises.writeFile(tmpPath, text, 'utf-8');
                await fs.promises.rename(tmpPath, filePath);
                if (!fs.existsSync(filePath)) {
                    throw new Error(`change-list file missing after rename (attempt=${attempt})`);
                }
                this.options.log(
                    `[EXT][CHANGELIST_WRITE_OK] sessionId=${sessionId} file=${filePath} records=${records.length} bytes=${Buffer.byteLength(text, 'utf-8')} attempt=${attempt}`,
                );
                return;
            } catch (error) {
                lastError = error;
                this.options.log(
                    `[EXT][CHANGELIST_WRITE_FAIL] sessionId=${sessionId} file=${filePath} attempt=${attempt} err=${String(error)}`,
                );
                try {
                    if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
                } catch {
                    // Best effort tmp cleanup.
                }
            }
        }
        throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
    }
}
