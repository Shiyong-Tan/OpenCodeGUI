import { parse } from 'jsonc-parser';
import { mergeSupervisorConfig } from '../../src/supervisor/SupervisorSetup';
import { verifySupervisorReleaseProtocol } from '../../src/supervisor/SupervisorRelease';
import { visibleFormAnswers } from '../questions/native-form';
import { validateFormAnswer, type NativeForm } from '../../src/transport/protocol/V2InteractionAdapter';

const url = 'https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v0.1.5/opencode-task-supervisor-0.1.5.tgz';
test('native setup migrates only Supervisor and preserves unrelated configuration and comments', () => {
    const before = `{// preserve me\n"plugin":[["${url}",{"allowDispatch":false}],"other"],"permission":{"shell":"ask"}}`;
    const after = mergeSupervisorConfig(before, url, 'v2'), config = parse(after);
    expect(after).toContain('// preserve me'); expect(config.plugin).toEqual(['other']);
    expect(config.plugins).toEqual([{ package: url, options: { allowDispatch: false, allowNotifications: false, normalGui: { enabled: true } } }]);
    expect(config.permission).toEqual({ shell: 'ask' });
    expect(mergeSupervisorConfig(after, url, 'v2')).toBe(after);
});
test('duplicate declarations across protocol configuration keys are rejected', () => {
    expect(() => mergeSupervisorConfig(JSON.stringify({ plugin: [url], plugins: [{ package: url }] }), url, 'v2')).toThrow('Multiple');
});
test('native release advertisement must match protocol, package, version and published digest', () => {
    const manifest = { schemaVersion: 1, version: '0.1.5', packageUrl: url, protocols: ['v1', 'v2'], sha256: 'a'.repeat(64) };
    expect(() => verifySupervisorReleaseProtocol(manifest, url, 'v2', `sha256:${'a'.repeat(64)}`)).not.toThrow();
    expect(() => verifySupervisorReleaseProtocol({ ...manifest, protocols: ['v1'] }, url, 'v2')).toThrow();
    expect(() => verifySupervisorReleaseProtocol(manifest, url, 'v2', `sha256:${'b'.repeat(64)}`)).toThrow();
});
test('typed form conditions omit stale hidden values and use original option values and defaults', () => {
    const form = { id: 'frm_A', sessionId: 'ses_A', title: 'Fixture', native: {}, fields: [
        { key: 'enabled', type: 'boolean', default: false },
        { key: 'count', type: 'integer', when: [{ key: 'enabled', op: 'eq', value: true }] },
        { key: 'choice', type: 'string', options: [{ label: 'Readable', value: 'wire-value' }], default: 'wire-value' },
    ] } as NativeForm;
    const values = visibleFormAnswers(form, { count: 5 });
    expect(values).toEqual({ enabled: false, choice: 'wire-value' });
    expect(() => validateFormAnswer(form, values)).not.toThrow();
    expect(visibleFormAnswers(form, { enabled: true, count: 5 })).toEqual({ enabled: true, count: 5, choice: 'wire-value' });
});
