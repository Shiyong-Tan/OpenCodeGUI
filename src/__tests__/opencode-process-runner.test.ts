import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { OpenCodeProcessRunner, OpenCodeLineBuffer, stripAnsi } from '../transport/OpenCodeProcessRunner';

function fakeChild(): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => true),
    });
    return child;
}

function createRunner(child: ChildProcess, logs: string[] = []) {
    const resolver = {
        resolve: async () => 'opencode',
        buildSpawn: (_bin: string, args: string[]) => ({ command: 'opencode', args }),
    } as any;
    return new OpenCodeProcessRunner({
        resolver,
        getCwd: () => 'C:\\workspace',
        log: (message) => logs.push(message),
        spawn: (() => child) as any,
    });
}

describe('OpenCode process runner', () => {
    test('buffers partial streaming lines and flushes the tail on close', async () => {
        const child = fakeChild();
        const lines: string[] = [];
        const pending = createRunner(child).executeStreaming(['run'], (line) => lines.push(line));
        await Promise.resolve();
        child.stdout!.emit('data', Buffer.from(' first\nsec'));
        child.stdout!.emit('data', Buffer.from('ond\n tail '));
        child.emit('close', 0);
        await pending;
        expect(lines).toEqual(['first', 'second', 'tail']);
    });

    test('returns stdout with ANSI sequences removed', async () => {
        const child = fakeChild();
        const pending = createRunner(child).execute(['--version']);
        await Promise.resolve();
        child.stdout!.emit('data', Buffer.from('\u001b[32m1.2.3\u001b[0m\n'));
        child.emit('close', 0);
        await expect(pending).resolves.toBe('1.2.3');
    });

    test('keeps line-buffer and ANSI behavior independently testable', () => {
        const buffer = new OpenCodeLineBuffer();
        expect(buffer.push('a\r\nb')).toEqual(['a']);
        expect(buffer.flush()).toEqual(['b']);
        expect(stripAnsi('\u001b[31merror\u001b[0m')).toBe('error');
    });
});
