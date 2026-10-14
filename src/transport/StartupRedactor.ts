/** Holds trailing text so split credentials cannot leak between output chunks. */
export class StartupRedactor {
    private pending = '';
    private readonly tail: number;
    constructor(private readonly secrets: string[]) { this.tail = Math.max(512, ...secrets.map(value => value.length)); }
    private redact(text: string): string {
        for (const secret of this.secrets) if (secret) text = text.split(secret).join('*'.repeat(secret.length));
        return text.replace(/(Bearer\s+)[\w.\-]+/gi, match => '*'.repeat(match.length));
    }
    push(text: string): string {
        this.pending += text;
        let count = Math.max(this.pending.lastIndexOf('\n') + 1, this.pending.length - this.tail, 0);
        for (const secret of this.secrets) {
            for (let length = 1; length < secret.length && length <= count; length++) {
                if (this.pending.slice(count - length, count) === secret.slice(0, length)) count -= length;
            }
        }
        const safe = this.redact(this.pending.slice(0, count)); this.pending = this.pending.slice(count); return safe;
    }
    flush(): string { const safe = this.redact(this.pending); this.pending = ''; return safe; }
}
