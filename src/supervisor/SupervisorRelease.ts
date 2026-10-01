const repository = 'https://github.com/Shiyong-Tan/opencode-task-supervisor';
const stableVersion = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';

export function officialReleaseVersion(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 512) return undefined;
    const prefix = `${repository}/releases/download/v`;
    if (!value.startsWith(prefix)) return undefined;
    const version = value.slice(prefix.length).split('/')[0];
    return new RegExp(`^${stableVersion}$`).test(version)
        && value === `${prefix}${version}/opencode-task-supervisor-${version}.tgz` ? version : undefined;
}

export function newerRelease(existing: string, candidate: string): string {
    const before = officialReleaseVersion(existing), after = officialReleaseVersion(candidate);
    if (!before || !after) throw new Error('Invalid official Supervisor release.');
    const a = before.split('.').map(BigInt), b = after.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return b[i] > a[i] ? candidate : existing;
    }
    return existing;
}

export async function resolveLatestSupervisorRelease(): Promise<string> {
    try {
        const signal = AbortSignal.timeout(15000);
        const response = await fetch('https://api.github.com/repos/Shiyong-Tan/opencode-task-supervisor/releases/latest', {
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal,
        });
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
        const data = await response.json() as Record<string, unknown>;
        if (!data || data.draft !== false || data.prerelease !== false || typeof data.tag_name !== 'string'
            || !new RegExp(`^v${stableVersion}$`).test(data.tag_name) || !Array.isArray(data.assets)) {
            throw new Error('Invalid stable release metadata');
        }
        const version = data.tag_name.slice(1);
        const name = `opencode-task-supervisor-${version}.tgz`;
        const url = `${repository}/releases/download/${data.tag_name}/${name}`;
        const assets = data.assets.filter((asset: unknown) => {
            if (!asset || typeof asset !== 'object') return false;
            const item = asset as Record<string, unknown>;
            return item.name === name && item.state === 'uploaded' && item.browser_download_url === url
                && typeof item.size === 'number' && item.size > 0;
        });
        if (assets.length !== 1 || !officialReleaseVersion(url)) throw new Error('Stable release package is missing or invalid');
        const asset = await fetch(url, { method: 'HEAD', signal });
        if (!asset.ok) throw new Error(`Package HTTP ${asset.status}`);
        return url;
    } catch (error) {
        throw new Error(`Unable to resolve the latest Supervisor release. Configuration was not changed. Check GitHub connectivity and retry. ${error instanceof Error ? error.message : ''}`);
    }
}
