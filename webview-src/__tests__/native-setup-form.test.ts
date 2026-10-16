import { parse } from 'jsonc-parser';
import { mergeSupervisorConfig } from '../../src/supervisor/SupervisorSetup';
import { verifySupervisorReleaseProtocol } from '../../src/supervisor/SupervisorRelease';
import { renderNativeForm, visibleFormAnswers } from '../questions/native-form';
import { validateFormAnswer, type NativeForm } from '../../src/transport/protocol/V2InteractionAdapter';

const url = 'https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v0.1.5/opencode-task-supervisor-0.1.5.tgz';
const nativeUrl = 'git+https://github.com/Shiyong-Tan/opencode-task-supervisor.git#package-v0.1.5';
test('native setup migrates only Supervisor and preserves unrelated configuration and comments', () => {
    const before = `{// preserve me\n"plugin":[["${url}",{"allowDispatch":false}],"other"],"permission":{"shell":"ask"}}`;
    const after = mergeSupervisorConfig(before, url, 'v2'), config = parse(after);
    expect(after).toContain('// preserve me'); expect(config.plugin).toEqual(['other']);
    expect(config.plugins).toEqual([{ package: nativeUrl, options: { allowDispatch: false, allowNotifications: false, normalGui: { enabled: true } } }]);
    expect(config.permission).toEqual({ shell: 'ask' });
    expect(mergeSupervisorConfig(after, url, 'v2')).toBe(after);
});
test('duplicate declarations across protocol configuration keys are rejected', () => {
    expect(() => mergeSupervisorConfig(JSON.stringify({ plugin: [url], plugins: [{ package: url }] }), url, 'v2')).toThrow('Multiple');
});
test('native release advertisement must match protocol, package, version and published digest', () => {
    const manifest = { schemaVersion: 1, version: '0.1.5', packageUrl: url, protocols: ['v1', 'v2'], sha256: 'a'.repeat(64), nativePackage: nativeUrl, nativeCommit: 'b'.repeat(40) };
    expect(() => verifySupervisorReleaseProtocol(manifest, url, 'v2', `sha256:${'a'.repeat(64)}`)).not.toThrow();
    expect(() => verifySupervisorReleaseProtocol({ ...manifest, protocols: ['v1'] }, url, 'v2')).toThrow();
    expect(() => verifySupervisorReleaseProtocol(manifest, url, 'v2', `sha256:${'b'.repeat(64)}`)).toThrow();
    expect(() => verifySupervisorReleaseProtocol({ ...manifest, nativePackage: url }, url, 'v2')).toThrow();
});

test('native distribution configuration upgrades without losing ownership and migrates back to V1 archive format', () => {
    const native = mergeSupervisorConfig('{}', url, 'v2');
    const upgradedUrl = url.split('0.1.5').join('0.1.7');
    const upgraded = parse(mergeSupervisorConfig(native, upgradedUrl, 'v2'));
    expect(upgraded.plugins[0].package).toBe(nativeUrl.replace('0.1.5', '0.1.7'));
    const legacy = parse(mergeSupervisorConfig(JSON.stringify(upgraded), upgradedUrl, 'v1'));
    expect(legacy.plugins).toBeUndefined(); expect(legacy.plugin[0][0]).toBe(upgradedUrl);
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

test('native questions with custom answers retain clickable original options and a free text input', () => {
    type Element = { tag: string; textContent?: string; disabled?: boolean; type?: string;
        style: Record<string, string>; children: Element[]; listeners: Record<string, () => void>; appendChild(child: Element): void;
        addEventListener(name: string, fn: () => void): void; setAttribute(): void };
    const elements: Element[] = [];
    const document = { createElement(tag: string): Element {
        const element: Element = { tag, style: {}, children: [], listeners: {},
            appendChild(child) { this.children.push(child); },
            addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute() {} };
        elements.push(element); return element;
    } } as unknown as Document;
    const values: Record<string, string> = {}, changed = jest.fn();
    const form = { id: 'frm_A', sessionId: 'ses_A', title: 'Question', native: {}, fields: [
        { key: 'q0', type: 'string', custom: true, options: [{ value: 'wire', label: 'Readable option' }] },
    ] } as NativeForm;
    renderNativeForm({ document, form, values, changed, blocked: false, owner: 'Reviewer', submit: jest.fn() });
    const choice = elements.find(element => element.tag === 'button' && element.textContent === 'Readable option');
    expect(choice).toBeDefined(); expect(choice!.disabled).toBe(false);
    choice!.listeners.click(); expect(values.q0).toBe('wire'); expect(changed).toHaveBeenCalledTimes(1);
    expect(elements.some(element => element.tag === 'input' && element.type === 'text')).toBe(true);
});
