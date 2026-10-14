jest.mock('child_process', () => ({ execFile: jest.fn() }));
import { execFile } from 'child_process';
import { requestRelease } from '../ReleaseRequest';
const originalFetch = global.fetch;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { jest.clearAllMocks(); Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' }); });
afterEach(() => { global.fetch = originalFetch; Object.defineProperty(process, 'platform', originalPlatform); });
test('Linux curl fallback preserves HTTPS certificate checks, bounds and argument routing', async () => {
 global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } }));
 (execFile as unknown as jest.Mock).mockImplementation((_command, _args, _options, callback) => callback(null, '{"draft":false}'));
 const result = await requestRelease('https://api.github.com/repos/Shiyong-Tan/opencode-task-supervisor/releases/latest');
 expect(await result.json()).toEqual({draft:false});
 const [command,args,options] = (execFile as unknown as jest.Mock).mock.calls[0];
 expect(command).toBe('curl');expect(args).toContain('=https');expect(args).not.toContain('-k');expect(args).not.toContain('--insecure');
 expect(options).toMatchObject({timeout:22000,maxBuffer:131072});expect(options.shell).toBeUndefined();
});
test('asset HEAD follows redirects but does not download the package', async () => {
 global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));
 (execFile as unknown as jest.Mock).mockImplementation((_command, _args, _options, callback) => callback(null, '200'));
 await expect(requestRelease('https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v0.1.3/opencode-task-supervisor-0.1.3.tgz', true)).resolves.toMatchObject({ok:true});
 expect((execFile as unknown as jest.Mock).mock.calls[0][1]).toEqual(expect.arrayContaining(['--head','--location','--output','/dev/null']));
});
test('HTTP failures are returned without transport fallback', async () => {
 global.fetch = jest.fn().mockResolvedValue({ok:false,status:403});
 expect((await requestRelease('https://api.github.com')).status).toBe(403);expect(execFile).not.toHaveBeenCalled();
});
test('both transport failures retain cause codes without relaying curl stderr', async () => {
 global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), {cause:{code:'ENETUNREACH'}}));
 (execFile as unknown as jest.Mock).mockImplementation((_command,_args,_options,callback)=>callback({code:'ENOENT',stderr:'private proxy credentials'}));
 await expect(requestRelease('https://api.github.com')).rejects.toThrow('ENETUNREACH');
 await expect(requestRelease('https://api.github.com')).rejects.not.toThrow('private proxy credentials');
});
