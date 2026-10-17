import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { PermissionReviewService, type PermissionConnection } from '../../src/permissions/PermissionReviewService';
import { createQuestionReview } from '../questions/question-review';
import { createPermissionReview } from '../permissions/permission-review';
import { renderNativeForm } from '../questions/native-form';

class Element {
    children: Element[] = []; parentElement?: Element; className = ''; hidden = false; disabled = false;
    textContent = ''; type = ''; style = {}; listeners = new Map<string, () => void>();
    append(...nodes: Element[]) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node: Element) { node.remove(); node.parentElement = this; this.children.push(node); return node; }
    insertBefore(node: Element, before: Element) { node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(before), 0, node); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = undefined; }
    setAttribute() {}
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    click() { if (!this.disabled) this.listeners.get('click')?.(); }
    find(predicate: (element: Element) => boolean): Element | undefined {
        return predicate(this) ? this : this.children.map(child => child.find(predicate)).find(Boolean);
    }
}

function fixture(kind: 'question' | 'permission') {
    const body = new Element(), input = new Element(); input.className = 'input-container'; body.append(input);
    const document = { body, createElement: () => new Element(), querySelector: () => input } as unknown as Document;
    let pending = ['ses_child', 'ses_sibling'].map((sessionID, index) => ({
        id: `${kind === 'question' ? 'frm' : 'per'}_${index}`, sessionID,
        ...(kind === 'question' ? { nativeForm: { id: `frm_${index}`, sessionId: sessionID, title: `Question ${index}`,
            fields: [{ key: 'choice', type: 'string' }], native: {} } }
            : { permission: 'fixture', patterns: ['fixture.txt'], metadata: { reason: 'Test' }, nativePermission: true }),
    }));
    const respond = jest.fn(async (input: { sessionId: string; requestId: string }) => {
        pending = pending.filter(item => item.sessionID !== input.sessionId || item.id !== input.requestId);
    });
    const connect = async (): Promise<PermissionConnection> => ({ identity: 'server', directory: '/fixture', read: jest.fn(), reply: jest.fn(), native: {
        session: async id => ({ id, directory: '/fixture', parentID: id === 'ses_parent' ? undefined : 'ses_parent', title: id }),
        requests: async () => pending, message: jest.fn(), respond,
    } });
    return { body, input, document, respond, service: new PermissionReviewService(connect, kind), post: jest.fn() };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
afterEach(() => jest.useRealTimers());

test('a real parent review snapshot mounts child question cards through the production main renderer', async () => {
    const x = fixture('question');
    const source = fs.readFileSync(path.join(process.cwd(), 'media/main.js'), 'utf8');
    const render = source.slice(source.indexOf('function renderQuestionOverlayModal()'), source.indexOf('\nfunction clearQuestionOverlay('));
    let context: vm.Context;
    const review = createQuestionReview(x.post, () => vm.runInContext('renderQuestionOverlayModal()', context));
    context = vm.createContext({ document: x.document, questionReview: review, displayedQuestion: () => review.current(),
        activeSessionId: 'ses_parent', questionOverlayEl: null, window: { __ocFeatures: { renderNativeForm } } });
    vm.runInContext(render, context);
    const refresh = async () => review.receive({ ...x.post.mock.calls.at(-1)![0], type: 'questionSnapshot', ...await x.service.snapshot('ses_parent') });
    review.select('ses_parent'); await refresh();
    expect(x.body.children[0].className).toBe('question-panel');
    expect(x.body.children[1]).toBe(x.input);
    expect(x.body.find(node => node.textContent.includes('ses_child'))).toBeDefined();
    expect(x.respond).not.toHaveBeenCalled();
    x.body.find(node => node.textContent === 'Reject')!.click();
    const decision = x.post.mock.calls.at(-1)![0];
    expect(decision).toMatchObject({ scopeSessionId: 'ses_parent', sessionId: 'ses_child', requestId: 'frm_0', response: 'reject' });
    await x.service.respond(decision);
    review.receive({ type: 'questionDecisionAck', sessionId: 'ses_child', requestId: 'frm_0' }); await refresh();
    expect(x.body.find(node => node.textContent.includes('ses_sibling'))).toBeDefined();
    expect(x.body.children.filter(node => node.className === 'question-panel')).toHaveLength(1);
    review.dispose();
});

test('native child permission without a tool source mounts an actionable parent card and advances after reply', async () => {
    const x = fixture('permission');
    const review = createPermissionReview({ document: x.document, postMessage: x.post, onPendingChanged: () => {} });
    const refresh = async () => review.receive({ ...x.post.mock.calls.at(-1)![0], type: 'permissionSnapshot', ...await x.service.snapshot('ses_parent') });
    review.select('ses_parent'); await refresh();
    const root = x.body.find(node => node.className === 'permission-review question-overlay')!;
    expect(root.hidden).toBe(false); expect(x.respond).not.toHaveBeenCalled();
    const reject = root.find(node => node.textContent === 'Reject')!;
    expect(reject.disabled).toBe(false); reject.click();
    const decision = x.post.mock.calls.at(-1)![0];
    expect(decision).toMatchObject({ scopeSessionId: 'ses_parent', sessionId: 'ses_child', requestId: 'per_0', response: 'reject' });
    await x.service.respond(decision);
    review.receive({ type: 'permissionResultAck', sessionId: 'ses_child', permissionId: 'per_0' }); await refresh();
    expect(root.hidden).toBe(false);
    expect(root.find(node => node.textContent.includes('ses_sibling'))).toBeDefined(); review.dispose();
});
