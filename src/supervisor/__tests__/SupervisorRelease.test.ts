import { newerRelease, officialReleaseVersion, resolveLatestSupervisorRelease } from '../SupervisorRelease';

const url = (v: string) => `https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v${v}/opencode-task-supervisor-${v}.tgz`;
const metadata = () => ({ draft: false, prerelease: false, tag_name: 'v0.2.10', assets: [{
    name: 'opencode-task-supervisor-0.2.10.tgz', state: 'uploaded', size: 100, browser_download_url: url('0.2.10'),
}] });
const original = global.fetch;
afterEach(() => { global.fetch = original; });

test('discovers and checks a future stable package without a GUI version update', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => metadata() }).mockResolvedValueOnce({ ok: true });
    global.fetch = fetcher;
    await expect(resolveLatestSupervisorRelease()).resolves.toBe(url('0.2.10'));
    expect(fetcher.mock.calls[1][0]).toBe(url('0.2.10'));
    expect(fetcher.mock.calls[1][1].method).toBe('HEAD');
});

test.each(['draft', 'prerelease', 'missing', 'foreign', 'mismatch'])('rejects invalid release metadata: %s', async kind => {
    const data = metadata();
    if (kind === 'draft') data.draft = true;
    if (kind === 'prerelease') data.prerelease = true;
    if (kind === 'missing') data.assets = [];
    if (kind === 'foreign') data.assets[0].browser_download_url = 'https://example.com/plugin.tgz';
    if (kind === 'mismatch') data.tag_name = 'v0.2.11';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => data });
    await expect(resolveLatestSupervisorRelease()).rejects.toThrow('Configuration was not changed');
});

test('reports discovery and package download failures without a fallback pin', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(resolveLatestSupervisorRelease()).rejects.toThrow('timeout');
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => metadata() }).mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(resolveLatestSupervisorRelease()).rejects.toThrow('Package HTTP 404');
});

test('recognizes only canonical official packages and compares numeric versions without downgrading', () => {
    expect(officialReleaseVersion(url('0.2.10'))).toBe('0.2.10');
    expect(officialReleaseVersion(url('0.2.10') + '?redirect=other')).toBeUndefined();
    expect(newerRelease(url('0.2.9'), url('0.2.10'))).toBe(url('0.2.10'));
    expect(newerRelease(url('1.0.0'), url('0.2.10'))).toBe(url('1.0.0'));
});
