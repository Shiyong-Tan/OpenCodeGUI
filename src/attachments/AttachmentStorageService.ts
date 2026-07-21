import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type AttachmentPayload = {
    filename?: string;
    mime?: string;
    dataBase64?: string;
    tempPath?: string;
};

export type SavedAttachment = {
    token: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    relPath: string;
};

type CleanupReason = 'activate' | 'timer' | 'manual';

export class AttachmentStorageService {
    private cleanupTimer?: NodeJS.Timeout;
    private cleanupInFlight = false;

    constructor(private readonly options: {
        globalStoragePath: string;
        getWorkspaceRootPath(): string;
        log(message: string): void;
    }) {}

    public async saveClipboardImage(dataUrl: string, mime: string): Promise<{ id: string; name: string; filePath: string }> {
        const attachmentsDir = path.join(this.options.globalStoragePath, 'attachments');
        await fs.promises.mkdir(attachmentsDir, { recursive: true });
        let ext = 'png';
        if (mime === 'image/jpeg') ext = 'jpg';
        if (mime === 'image/webp') ext = 'webp';
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const name = `${id}.${ext}`;
        const filePath = path.join(attachmentsDir, name);
        let base64 = dataUrl;
        if (dataUrl.startsWith('data:')) {
            const commaIndex = dataUrl.indexOf(',');
            if (commaIndex !== -1) base64 = dataUrl.slice(commaIndex + 1);
        }
        await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
        return { id, name, filePath };
    }

    public isImageFileName(name: string): boolean {
        const lower = String(name || '').toLowerCase();
        if (!lower) return false;
        const ext = path.extname(lower);
        return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff', '.ico', '.heic'].includes(ext)
            || lower.startsWith('img-')
            || lower.startsWith('image-');
    }

    public getImageMimeFromName(name: string): string | undefined {
        const ext = path.extname(String(name || '')).toLowerCase();
        switch (ext) {
            case '.png': return 'image/png';
            case '.jpg':
            case '.jpeg': return 'image/jpeg';
            case '.gif': return 'image/gif';
            case '.webp': return 'image/webp';
            case '.bmp': return 'image/bmp';
            case '.svg': return 'image/svg+xml';
            case '.tif':
            case '.tiff': return 'image/tiff';
            case '.ico': return 'image/x-icon';
            case '.heic': return 'image/heic';
            default: return undefined;
        }
    }

    public getMimeFromName(name: string): string {
        const ext = path.extname(String(name || '')).toLowerCase();
        if (ext) {
            const imageMime = this.getImageMimeFromName(name);
            if (imageMime) return imageMime;
        }
        switch (ext) {
            case '.txt':
            case '.md':
            case '.markdown':
            case '.ts':
            case '.tsx':
            case '.js':
            case '.jsx':
            case '.mjs':
            case '.cjs':
            case '.py':
            case '.java':
            case '.c':
            case '.h':
            case '.cpp':
            case '.cxx':
            case '.cc':
            case '.hpp':
            case '.cs':
            case '.go':
            case '.rs':
            case '.rb':
            case '.php':
            case '.swift':
            case '.kt':
            case '.kts':
            case '.scala':
            case '.sh':
            case '.bash':
            case '.zsh':
            case '.ps1':
            case '.bat':
            case '.cmd':
            case '.sql':
            case '.yaml':
            case '.yml':
            case '.toml':
            case '.ini':
            case '.env':
            case '.gitignore':
            case '.dockerignore':
            case '.css':
            case '.scss':
            case '.less':
            case '.html':
            case '.htm':
            case '.vue':
            case '.svelte':
            case '.xml': return 'text/plain';
            case '.json': return 'application/json';
            case '.pdf': return 'application/pdf';
            case '.csv': return 'text/csv';
            default: return 'application/octet-stream';
        }
    }

    public getExtFromMime(mime: string): string {
        switch (mime) {
            case 'image/png': return 'png';
            case 'image/jpeg': return 'jpg';
            case 'image/gif': return 'gif';
            case 'image/webp': return 'webp';
            case 'image/bmp': return 'bmp';
            case 'image/svg+xml': return 'svg';
            case 'image/tiff': return 'tiff';
            case 'image/x-icon': return 'ico';
            case 'image/heic': return 'heic';
            case 'text/plain': return 'txt';
            case 'text/markdown': return 'md';
            case 'application/json': return 'json';
            case 'application/pdf': return 'pdf';
            case 'text/csv': return 'csv';
            case 'application/xml': return 'xml';
            default: return 'bin';
        }
    }

    public sanitizeFilename(name: string): string {
        const base = path.basename(String(name || '').trim());
        const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
        return !sanitized || sanitized === '.' || sanitized === '..' ? 'attachment' : sanitized;
    }

    public getAttachmentsRootPath(): string | null {
        const workspaceRoot = this.options.getWorkspaceRootPath();
        return workspaceRoot ? path.join(workspaceRoot, '.opencode', 'attachments') : null;
    }

    public buildAttachmentManifest(saved: SavedAttachment[]): string {
        if (!saved.length) return '';
        const lines = ['---', 'Attachments (workspace files; read from disk; DO NOT use any URL):'];
        for (const item of saved) {
            lines.push(`- ${item.filename} | mime=${item.mime} | size=${item.sizeBytes} | path=${item.relPath}`);
        }
        lines.push('');
        lines.push('Authorization (IMPORTANT):');
        lines.push('- You are explicitly authorized to read ALL files listed above.');
        lines.push('- Access is READ-ONLY.');
        lines.push('- Access is strictly limited to the listed attachment paths.');
        lines.push('- Do NOT ask for confirmation before reading them.');
        lines.push('');
        lines.push('Instructions:');
        lines.push('- Read the listed attachments as needed to complete the task.');
        lines.push('- If an attachment is an image/screenshot, you may read it and extract information.');
        lines.push('- If OCR/parsing is needed, do so in read-only mode and report the extracted text/summary.');
        lines.push('---');
        return lines.join('\n');
    }

    public async saveAttachment(sessionId: string, attachment: AttachmentPayload, reqId: string): Promise<SavedAttachment | null> {
        const workspaceRoot = this.options.getWorkspaceRootPath();
        if (!workspaceRoot) {
            this.options.log(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=no-workspace`);
            return null;
        }
        const attachmentsRoot = this.getAttachmentsRootPath();
        if (!attachmentsRoot) {
            this.options.log(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=no-attachments-root`);
            return null;
        }
        const token = crypto.randomBytes(8).toString('hex');
        const inputName = typeof attachment?.filename === 'string' ? attachment.filename : '';
        const fallbackMime = inputName ? this.getMimeFromName(inputName) : 'application/octet-stream';
        const mime = typeof attachment?.mime === 'string' && attachment.mime ? attachment.mime : fallbackMime;
        let filename = inputName ? this.sanitizeFilename(inputName) : '';
        if (!filename) filename = `attachment-${Date.now()}.${this.getExtFromMime(mime)}`;
        const dataBase64 = typeof attachment?.dataBase64 === 'string' ? attachment.dataBase64 : '';
        const tempPath = typeof attachment?.tempPath === 'string' ? attachment.tempPath : '';
        if (!dataBase64 && !tempPath) {
            this.options.log(`EXT: attach.skip | reqId=${reqId} | reason=missing-data | filename=${filename} | mime=${mime}`);
            return null;
        }
        const targetDir = path.join(attachmentsRoot, sessionId, token);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const filePath = path.join(targetDir, filename);
        const tmpPath = `${filePath}.tmp`;
        let buffer: Buffer;
        try {
            if (dataBase64) {
                const normalized = dataBase64.startsWith('data:')
                    ? dataBase64.slice(dataBase64.indexOf(',') + 1)
                    : dataBase64;
                buffer = Buffer.from(normalized, 'base64');
            } else {
                buffer = await fs.promises.readFile(tempPath);
            }
            await fs.promises.writeFile(tmpPath, buffer);
            await fs.promises.rename(tmpPath, filePath);
        } catch (error) {
            try {
                if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
            } catch { /* ignore */ }
            this.options.log(`EXT: attach.save.fail | reqId=${reqId} | filename=${filename} | mime=${mime} | err=${String(error)}`);
            return null;
        }
        const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
        const sizeBytes = buffer.length;
        this.options.log(`EXT: attach.save.ok | reqId=${reqId} | token=${token} | filename=${filename} | mime=${mime} | bytes=${sizeBytes} | relPath=${relPath}`);
        return { token, filename, mime, sizeBytes, relPath };
    }

    public scheduleCleanup(reason: CleanupReason): void {
        setTimeout(() => { void this.runCleanup(reason); }, 0);
    }

    public startCleanupTimer(): void {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => { void this.runCleanup('timer'); }, 6 * 60 * 60 * 1000);
    }

    public async runCleanup(reason: CleanupReason): Promise<void> {
        if (this.cleanupInFlight) {
            this.options.log(`EXT: attach.cleanup.skip | reason=in-flight | trigger=${reason}`);
            return;
        }
        const attachmentsRoot = this.getAttachmentsRootPath();
        if (!attachmentsRoot || !fs.existsSync(attachmentsRoot)) {
            this.options.log(`EXT: attach.cleanup.skip | reason=missing-root | trigger=${reason}`);
            return;
        }
        this.cleanupInFlight = true;
        try {
            const ttlMs = 7 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const sizeCap = 2 * 1024 * 1024 * 1024;
            const sizeTarget = Math.floor(1.8 * 1024 * 1024 * 1024);
            const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
            const walk = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(fullPath);
                    } else if (entry.isFile()) {
                        try {
                            const stat = await fs.promises.stat(fullPath);
                            files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
                        } catch { /* ignore */ }
                    }
                }
            };
            await walk(attachmentsRoot);
            const beforeBytes = files.reduce((sum, file) => sum + file.size, 0);
            let deletedFiles = 0;
            for (const file of files) {
                if (now - file.mtimeMs < ttlMs) continue;
                try {
                    await fs.promises.unlink(file.path);
                    deletedFiles += 1;
                } catch { /* ignore */ }
            }
            let remainingFiles = files.filter((file) => fs.existsSync(file.path));
            let totalBytes = remainingFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalBytes > sizeCap) {
                remainingFiles = remainingFiles.sort((left, right) => left.mtimeMs - right.mtimeMs);
                for (const file of remainingFiles) {
                    if (totalBytes <= sizeTarget) break;
                    try {
                        await fs.promises.unlink(file.path);
                        deletedFiles += 1;
                        totalBytes -= file.size;
                    } catch { /* ignore */ }
                }
            }
            this.options.log(`EXT: attach.cleanup | reason=${reason} | ttlDays=7 | beforeBytes=${beforeBytes} | afterBytes=${totalBytes} | deletedFiles=${deletedFiles}`);
        } catch (error) {
            this.options.log(`EXT: attach.cleanup.error | reason=${reason} | err=${String(error)}`);
        } finally {
            this.cleanupInFlight = false;
        }
    }

    public dispose(): void {
        if (!this.cleanupTimer) return;
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
    }
}
