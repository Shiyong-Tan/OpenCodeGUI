import { createPermissionReview } from '../permissions/permission-review';
import type { PermissionCard } from '../../src/permissions/PermissionReviewService';

class Element {
    hidden = false; disabled = false; className = ''; textContent = ''; type = ''; parent?: Element;
    readonly children: Element[] = []; readonly attributes = new Map<string, string>(); readonly handlers = new Map<string, () => void>();
    get parentNode() { return this.parent; }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    append(...nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    insertBefore(node: Element, before: Element) { node.parent = this; this.children.splice(this.children.indexOf(before), 0, node); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    addEventListener(name: string, fn: () => void) { this.handlers.set(name, fn); }
    click() { this.handlers.get('click')?.(); }
}
const card = (sessionId = 'ses_child', requestId = 'per_a'): PermissionCard => ({
    scopeSessionId: 'ses_parent', sessionId, requestId, agent: 'reviewer', title: '<img src=x>', permission: 'read',
    patterns: ['fixture.txt'], tool: 'read', input: '{"filePath":"fixture.txt"}', state: 'pending', reason: '', reviewToken: requestId + '-review',
});
function setup() {
    const body = new Element(), composer = new Element(); body.append(composer);
    const send = jest.fn(), onPendingChanged = jest.fn();
    const panel = createPermissionReview({ document: { body, createElement: () => new Element(), querySelector: () => composer } as unknown as Document,
        postMessage: send, onPendingChanged });
    const root = body.children.find(e => e.className === 'permission-review')!, rows = root.children[3];
    const respond = (cards: PermissionCard[]) => panel.receive({ ...send.mock.calls.at(-1)![0], requests: cards, type: 'permissionSnapshot' });
    return { panel, root, rows, send, respond, onPendingChanged };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
afterEach(() => { jest.useRealTimers(); });

test('parent view displays all child requests, keeps original IDs for decisions, and never auto-approves', () => {
    const x = setup(); x.panel.select('ses_parent');
    expect(x.send).toHaveBeenLastCalledWith({ type: 'permissionRefresh', scopeSessionId: 'ses_parent', refreshId: '1' });
    x.respond([card(), card('ses_child', 'per_b'), card('ses_sibling', 'per_c')]);
    expect(x.rows.children).toHaveLength(3); expect(x.root.hidden).toBe(false);
    const row = x.rows.children[0]; expect(row.children[0].textContent).toContain('<img src=x>'); expect(row.children[0].children).toHaveLength(0);
    expect(x.send).toHaveBeenCalledTimes(1);
    row.children[4].click(); row.children[4].click();
    expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'permissionResult', scopeSessionId: 'ses_parent', sessionId: 'ses_child', requestId: 'per_a', response: 'once' }));
    expect(row.children[4].disabled).toBe(true);
    x.panel.receive({ type: 'permissionResultAck', sessionId: 'ses_child', permissionId: 'per_a' });
    expect(x.rows.children).toHaveLength(2); x.respond([card('ses_child', 'per_b'), card('ses_sibling', 'per_c')]);
    x.rows.children[1].children[5].click();
    expect(x.send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'ses_sibling', requestId: 'per_c', response: 'reject' }));
    x.panel.dispose();
});

test('switching, reconnect refresh and late snapshots cannot display or approve another scope', () => {
    const x = setup(); x.panel.select('ses_parent'); const old = x.send.mock.calls[0][0];
    x.panel.select('ses_other');
    x.panel.receive({ ...old, type: 'permissionSnapshot', requests: [card()] }); expect(x.rows.children).toHaveLength(0);
    x.respond([]); x.panel.select('ses_parent'); x.respond([card()]);
    const row = x.rows.children[0]; jest.advanceTimersByTime(3000); x.respond([card()]); expect(x.rows.children[0]).toBe(row);
    x.panel.receive({ type: 'permissionOverlay', sessionId: 'ses_child', permissionId: 'per_a' });
    expect(x.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'permissionRefresh', scopeSessionId: 'ses_parent' }));
    x.respond([]); expect(x.root.hidden).toBe(true); expect(x.rows.children).toHaveLength(0); x.panel.dispose();
});

test('expired and unknown requests have disabled actions; outages and failed decisions require fresh validation', () => {
    const x = setup(); x.panel.select('ses_parent'); x.respond([card()]);
    const row = x.rows.children[0]; row.children[4].click();
    x.panel.receive({ type: 'permissionResultFailed', sessionId: 'ses_child', permissionId: 'per_a', reason: 'Connection lost' });
    expect(row.children[4].disabled).toBe(true); expect(row.children[3].textContent).toBe('Connection lost');
    x.respond([{ ...card(), state: 'expired', reviewToken: '', reason: 'Tool aborted' }]);
    const calls = x.send.mock.calls.length; row.children[4].click(); expect(x.send).toHaveBeenCalledTimes(calls);
    expect(row.children[4].disabled).toBe(true);
    jest.advanceTimersByTime(3000); x.panel.receive({ ...x.send.mock.calls.at(-1)![0], type: 'permissionSnapshot', error: 'offline' });
    expect(row.children[5].disabled).toBe(true); x.panel.dispose();
});


test('panel appears only for pending asks and hides after the last decision', () => {
    const x = setup(); x.panel.select('ses_parent');
    expect(x.root.hidden).toBe(true);
    x.respond([{ ...card(), state: 'expired', reviewToken: '' }]);
    expect(x.root.hidden).toBe(true);
    jest.advanceTimersByTime(3000);
    x.panel.receive({ ...x.send.mock.calls.at(-1)![0], type: 'permissionSnapshot', error: 'offline' });
    expect(x.root.hidden).toBe(true);
    jest.advanceTimersByTime(3000); x.respond([card()]);
    expect(x.root.hidden).toBe(false);
    x.rows.children[0].children[4].click();
    x.panel.receive({ type: 'permissionResultAck', sessionId: 'ses_child', permissionId: 'per_a' });
    expect(x.root.hidden).toBe(true);
    x.panel.dispose();
});

test('late decisions from another scope leave the current permissions unchanged', () => {
    const x = setup(); x.panel.select('ses_parent'); x.respond([card()]);
    const row = x.rows.children[0], calls = x.send.mock.calls.length;
    x.panel.receive({ type: 'permissionResultAck', sessionId: 'ses_foreign', permissionId: 'per_foreign' });
    expect(x.send).toHaveBeenCalledTimes(calls); expect(row.children[4].disabled).toBe(false);
    x.panel.dispose();
});
