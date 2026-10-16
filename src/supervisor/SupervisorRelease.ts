import { requestRelease, releaseNetworkReason } from './ReleaseRequest';
import type { ProtocolFamily } from '../transport/protocol/ProtocolNegotiator';
const repository = 'https://github.com/Shiyong-Tan/opencode-task-supervisor';
const nativePrefix = 'git+https://github.com/Shiyong-Tan/opencode-task-supervisor.git#package-v';
const stableVersion = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';

export function officialReleaseVersion(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 512) return undefined;
    if (value.startsWith(nativePrefix)) {
        const version = value.slice(nativePrefix.length);
        return new RegExp(`^${stableVersion}$`).test(version) ? version : undefined;
    }
    const prefix = `${repository}/releases/download/v`;
    if (!value.startsWith(prefix)) return undefined;
    const version = value.slice(prefix.length).split('/')[0];
    return new RegExp(`^${stableVersion}$`).test(version)
        && value === `${prefix}${version}/opencode-task-supervisor-${version}.tgz` ? version : undefined;
}

/** The native package manager accepts Git/registry specs, not arbitrary archive URLs. */
export function supervisorPackageSource(source: string, family: ProtocolFamily): string {
    const version = officialReleaseVersion(source);
    if (!version) return source;
    return family === 'v2' ? `${nativePrefix}${version}`
        : `${repository}/releases/download/v${version}/opencode-task-supervisor-${version}.tgz`;
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

export function verifySupervisorReleaseProtocol(value: unknown, packageUrl: string, family: ProtocolFamily, assetDigest?: unknown): void {
    const manifest = value as Record<string, unknown> | null;
    const version = officialReleaseVersion(packageUrl);
    if (!manifest || manifest.schemaVersion !== 1 || manifest.version !== version || manifest.packageUrl !== packageUrl ||
        !Array.isArray(manifest.protocols) || !manifest.protocols.includes(family) ||
        typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
        assetDigest !== undefined && assetDigest !== `sha256:${manifest.sha256}`) {
        throw new Error('The published Supervisor package does not advertise a verified matching protocol. Configuration was not changed.');
    }
    if (family === 'v2' && (manifest.nativePackage !== `${nativePrefix}${version}` ||
        typeof manifest.nativeCommit !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.nativeCommit))) {
        throw new Error('The Supervisor release has no matching native Git distribution. Configuration was not changed.');
    }
}

export async function verifyNativeSupervisorRelease(source: string): Promise<void> {
    const url = supervisorPackageSource(source, 'v1');
    if (!officialReleaseVersion(url)) throw new Error('Invalid native Supervisor release');
    const response = await requestRelease(url.replace(/\.tgz$/, '.protocols.json'));
    if (!response.ok) throw new Error(`Native Supervisor manifest HTTP ${response.status}; configuration was not changed.`);
    verifySupervisorReleaseProtocol(await response.json(), url, 'v2');
}

export async function resolveLatestSupervisorRelease(family: ProtocolFamily = 'v1'): Promise<string> {
    let stage = 'release_metadata';
    try {
        const response = await requestRelease('https://api.github.com/repos/Shiyong-Tan/opencode-task-supervisor/releases/latest');
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
        if (family === 'v2') {
            stage = 'release_protocol_manifest';
            const manifestName = `opencode-task-supervisor-${version}.protocols.json`;
            const manifestUrl = `${repository}/releases/download/${data.tag_name}/${manifestName}`;
            const matching = data.assets.filter((asset: unknown) => {
                const item = asset as Record<string, unknown> | null;
                return item?.name === manifestName && item.state === 'uploaded' && item.browser_download_url === manifestUrl;
            });
            if (matching.length !== 1) throw new Error('Latest Supervisor release has no native V2 protocol manifest. Publish the dual-protocol package before enabling it.');
            const manifest = await requestRelease(manifestUrl);
            if (!manifest.ok) throw new Error(`Manifest HTTP ${manifest.status}`);
            verifySupervisorReleaseProtocol(await manifest.json(), url, family, (assets[0] as Record<string, unknown>).digest);
        }
        stage = 'release_asset';
        const asset = await requestRelease(url, true);
        if (!asset.ok) throw new Error(`Package HTTP ${asset.status}`);
        return url;
    } catch (error) {
        throw new Error(`Unable to resolve the latest Supervisor release at ${stage}. Configuration was not changed. ${releaseNetworkReason(error)}`);
    }
}
