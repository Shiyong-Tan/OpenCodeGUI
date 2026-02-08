import * as fs from 'fs';
import * as path from 'path';
import { SessionEntry, SessionMap } from './types';

type Logger = (message: string) => void;

const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // ignore
    }
    await fs.promises.rename(tmpPath, filePath);
};

export class GitSessionMapStore {
    private readonly baseDir: string;
    private readonly logger: Logger;

    constructor(workspaceRoot: string, logger: Logger) {
        this.baseDir = path.join(workspaceRoot, '.opencode', 'git', 'sessions');
        this.logger = logger;
    }

    private getSessionDir(sessionId: string): string {
        return path.join(this.baseDir, sessionId);
    }

    private getMapPath(sessionId: string): string {
        return path.join(this.getSessionDir(sessionId), 'map.json');
    }

    public async loadSessionMap(sessionId: string, repoId: string): Promise<SessionMap> {
        const mapPath = this.getMapPath(sessionId);
        if (!fs.existsSync(mapPath)) {
            return {
                schemaVersion: 1,
                sessionId,
                repoId,
                baselineCommit: undefined,
                currentBaseCommit: undefined,
                entries: [],
                tmpToCommit: {},
                msgToCommit: {}
            };
        }
        try {
            const raw = await fs.promises.readFile(mapPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.schemaVersion !== 1) {
                return {
                    schemaVersion: 1,
                    sessionId,
                    repoId,
                    baselineCommit: undefined,
                    currentBaseCommit: undefined,
                    entries: [],
                    tmpToCommit: {},
                    msgToCommit: {}
                };
            }
            return parsed as SessionMap;
        } catch {
            return {
                schemaVersion: 1,
                sessionId,
                repoId,
                baselineCommit: undefined,
                currentBaseCommit: undefined,
                entries: [],
                tmpToCommit: {},
                msgToCommit: {}
            };
        }
    }

    public async saveSessionMap(sessionId: string, map: SessionMap): Promise<void> {
        const mapPath = this.getMapPath(sessionId);
        await writeJsonAtomic(mapPath, map);
        this.logger(`mapWrite | sessionId=${sessionId} entries=${map.entries.length}`);
    }

    public appendEntry(map: SessionMap, entry: SessionEntry): SessionMap {
        return {
            ...map,
            entries: [...map.entries, entry]
        };
    }

    public bindFinalMsg(map: SessionMap, tmpKey: string, finalMsgId: string): SessionMap {
        const commitHash = map.tmpToCommit[tmpKey];
        if (!commitHash) return map;
        const updatedEntries = map.entries.map((entry) => {
            if (entry.tmpKey === tmpKey && entry.commitHash === commitHash) {
                return { ...entry, finalAssistantMsgId: finalMsgId };
            }
            return entry;
        });
        return {
            ...map,
            msgToCommit: {
                ...map.msgToCommit,
                [finalMsgId]: commitHash
            },
            entries: updatedEntries
        };
    }
}
