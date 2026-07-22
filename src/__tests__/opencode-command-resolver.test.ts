import {
    buildOpenCodeSpawn,
    mergePathEntries,
    resolveWindowsCommandPath,
} from '../transport/OpenCodeCommandResolver';

describe('OpenCode command resolver', () => {
    test('merges Windows paths case-insensitively while preserving first occurrence', () => {
        expect(mergePathEntries('C:\\Tools; C:\\Users\\me\\bin', 'c:\\tools;D:\\Apps'))
            .toBe('C:\\Tools;C:\\Users\\me\\bin;D:\\Apps');
    });

    test('resolves Windows shim extensions in the existing priority order', () => {
        const existing = new Set(['C:\\bin\\opencode.exe', 'C:\\bin\\opencode.bat']);
        expect(resolveWindowsCommandPath('C:\\bin\\opencode', (candidate) => existing.has(candidate)))
            .toBe('C:\\bin\\opencode.exe');
        expect(resolveWindowsCommandPath('C:\\bin\\opencode.cmd', () => false))
            .toBe('C:\\bin\\opencode.cmd');
    });

    test('uses cmd for ordinary Windows shim invocations', () => {
        expect(buildOpenCodeSpawn('C:\\bin\\opencode.cmd', ['models'], undefined, 'win32')).toEqual({
            command: 'cmd.exe',
            args: ['/c', 'C:\\bin\\opencode.cmd', 'models'],
        });
    });

    test('uses the existing PowerShell here-string path for multiline Windows arguments', () => {
        const spec = buildOpenCodeSpawn(
            'C:\\bin\\opencode.cmd',
            ['run', '--', "line one\nline 'two'"],
            undefined,
            'win32',
        );
        expect(spec.command).toBe('powershell.exe');
        expect(spec.args.slice(0, 2)).toEqual(['-NoProfile', '-Command']);
        expect(spec.args[2]).toContain("$msg = @'\nline one\nline 'two'\n'@");
        expect(spec.args[2]).toContain("& 'C:\\bin\\opencode.cmd' 'run' -- $msg");
    });

    test('does not wrap native or non-Windows executables', () => {
        expect(buildOpenCodeSpawn('/usr/local/bin/opencode', ['models'], undefined, 'linux')).toEqual({
            command: '/usr/local/bin/opencode',
            args: ['models'],
        });
    });
});
