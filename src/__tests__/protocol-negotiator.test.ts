import { identifyProtocol, probeProtocol } from '../transport/protocol/ProtocolNegotiator';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const input = () => ({ baseUrl: 'http://127.0.0.1:42001', authorization: 'Basic fixture', isCurrent: () => true });
const info = { version: '2.0.24', pid: 42, urls: ['http://127.0.0.1:42001'], paths: { tmp: '/isolated/tmp' } };

test.each(['1.18.29', '1.18.31', '1.99.0', '3.0.0'])('release %s does not change a compatible v1 wire contract', async version => {
    const fetcher = jest.fn(async () => json({ healthy: true, version, future: {} }));
    expect(await probeProtocol(input(), fetcher)).toEqual({ family: 'v1', version });
    expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['2.0.24', '2.9.0', '3.0.0-beta.1'])('recognizes v2 wire shape for %s despite HTTP 200 HTML on the old route', async version => {
    const fetcher = jest.fn().mockResolvedValueOnce(new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }))
        .mockResolvedValueOnce(json({ ...info, version, futureCapability: true }));
    expect(await probeProtocol(input(), fetcher)).toEqual({ family: 'v2', version, pid: 42 });
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['http://127.0.0.1:42001/global/health', 'http://127.0.0.1:42001/api/info']);
    expect(fetcher.mock.calls.every(call => call[1].method === 'GET' && call[1].redirect === 'error')).toBe(true);
});

test.each([401, 403])('does not switch endpoints or credentials after HTTP %s', async status => {
    const fetcher = jest.fn(async () => json({}, status));
    await expect(probeProtocol(input(), fetcher)).rejects.toMatchObject({ reason: 'authentication' });
    expect(fetcher).toHaveBeenCalledTimes(1);
});

test('HTTP success and a version label do not prove protocol compatibility', async () => {
    const fetcher = jest.fn(async () => json({ version: '2.0.24' }));
    await expect(probeProtocol(input(), fetcher)).rejects.toMatchObject({ reason: 'unrecognized' });
    expect(identifyProtocol('/api/info', { ...info, pid: '42' })).toBeUndefined();
});

test('a stale service generation cannot publish the discovered identity', async () => {
    let valid = true;
    const fetcher = jest.fn(async () => { valid = false; return json(info); });
    await expect(probeProtocol({ ...input(), isCurrent: () => valid }, fetcher)).rejects.toMatchObject({ reason: 'superseded' });
});

test('bounds response bytes and does not treat an oversized document as another protocol', async () => {
    const fetcher = jest.fn(async () => json({ healthy: true, version: '1.99.0', data: 'x'.repeat(17000) }));
    await expect(probeProtocol(input(), fetcher)).rejects.toMatchObject({ reason: 'response_bound' });
    expect(fetcher).toHaveBeenCalledTimes(1);
});

test('an aborted operation cannot issue discovery reads', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const fetcher = jest.fn();
    await expect(probeProtocol({ ...input(), signal: controller.signal }, fetcher)).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
});

test('rejects foreign origins rather than scanning other services', async () => {
    const fetcher = jest.fn();
    await expect(probeProtocol({ ...input(), baseUrl: 'https://example.com' }, fetcher)).rejects.toThrow('loopback');
    expect(fetcher).not.toHaveBeenCalled();
});
